/**
 * Map Renderer Module
 * 
 * Creates and manages a Leaflet.js map with colored circle markers
 * for each airport. Clicking a marker displays a popup with the raw TAF text.
 */

const MapRenderer = (function() {
  'use strict';

  let map = null;
  let markers = {};        //icao -> circleMarker/LatLngPopup
  let airportsCache = [];  // Store airports reference for fitToMarkers
  let popupHtmlCache = {}; // Cache popup HTML keyed by airport ICAO to avoid rebuilding when raw TAF hasn't changed

  const AIRPORT_CIRCLE_RADIUS = 8;
  const AIRPORT_LABEL_OFFSET = 12;

  /**
   * Initialize the Leaflet map
   */
  function init(mapContainerId) {
    // Create or reuse existing map instance
    if (map) {
      return map;
    }

    // Initialize Leaflet map with CartoDB Voyager tiles (free, no API key)
    map = L.map(mapContainerId).setView([5, 107], 4);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
      minZoom: 2
    }).addTo(map);

    // Enable double-click zoom but handle single clicks for markers
    map.doubleClickZoom.disable();

    return map;
  }

  /**
   * Get the color hex code for a given condition.
   * Delegates to XMLElementTafParser.getConditionColor() to avoid duplication.
   */
  function getMarkerColor(condition) {
    return XMLElementTafParser.getConditionColor(condition);
  }

  /**
   * Update or add a marker for an airport.
   * Coordinates are extracted from tafData.lat/lng (from API) rather than hardcoded in airports.json.
   */
  function updateMarker(airport, condition, tafData) {
    if (!map) {
      init('map-container');
    }

    const color = getMarkerColor(condition);
    const latlng = [tafData?.lat ?? airport.lat, tafData?.lng ?? airport.lng];

    // If marker already exists with no coordinate change, update inline styles only
    const coordKey = `${tafData?.lat}:${tafData?.lng}`;
    if (markers[airport.icao] && markers[airport.icao]._coordKey === coordKey) {
      // Update circle marker color
      const circleEl = markers[airport.icao].getElement();
      if (circleEl) {
        const innerDiv = circleEl.querySelector('div');
        if (innerDiv) {
          innerDiv.style.backgroundColor = color;
          innerDiv.style.boxShadow = `0 0 8px ${color}80`;
        }
      }

      // Update label color
      if (markers[airport.icao].label) {
        const labelTextEl = markers[airport.icao].label.getElement();
        if (labelTextEl) {
          const innerLabelDiv = labelTextEl.querySelector('div');
          if (innerLabelDiv) {
            innerLabelDiv.style.color = color;
          }
        }
      }

      // Always update popup content since TAF data may have changed
      updatePopup(markers[airport.icao], airport, condition, tafData);
      return;
    }

    // Remove existing marker if it exists (coordinates changed or first create)
    if (markers[airport.icao]) {
      map.removeLayer(markers[airport.icao]);
      if (markers[airport.icao].label) {
        map.removeLayer(markers[airport.icao].label);
      }
      delete markers[airport.icao];
    }

    // Create circle marker with updated color
    const circleMarker = L.marker(latlng, {
      icon: L.divIcon({
        className: 'map-airport-glow-marker',
        html: `<div style="
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background-color: ${color};
          border: 1px solid rgba(255,255,255,0.2);
          box-shadow: 0 0 8px ${color}80;
          transform: translate(-1px, -1px);
        "></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      }),
      className: 'map-airport-marker'
    }).addTo(map);

    // Add airport name label
    const label = L.marker(latlng, {
      icon: L.divIcon({
        className: 'airport-label',
        html: `<div style="
          color: ${color};
          font-weight: bold;
          font-size: 13px;
          text-shadow: 0 0 3px rgba(0,0,0,1), 0 0 6px rgba(0,0,0,0.8);
          white-space: nowrap;
        ">${airport.icao}</div>`,
        iconSize: [80, 20],
        iconAnchor: [40, 24]
      }),
      interactive: false
    }).addTo(map);

    circleMarker.label = label;
    markers[airport.icao] = circleMarker;
    circleMarker._coordKey = coordKey;

    // Set popup content
    updatePopup(circleMarker, airport, condition, tafData);
  }

  /**
   * Remove all markers from the map
   */
  function clearMarkers() {
    if (!map) return;
    
    for (const icao in markers) {
      if (markers[icao].label) {
        map.removeLayer(markers[icao].label);
      }
      map.removeLayer(markers[icao]);
    }
    
    markers = {};
  }

  /**
   * Fit map to show all markers.
   * Uses cached coordinates from marker positions rather than relying on hardcoded airport lat/lng.
   */
  function fitToMarkers() {
    if (!map || Object.keys(markers).length === 0) return;

    const bounds = [];
    for (const icao in markers) {
      const marker = markers[icao];
      const latlng = marker.getLatLng();
      if (latlng) {
        bounds.push([latlng.lat, latlng.lng]);
      }
    }

    // Also include any airports that don't have markers yet but have cached coordinates
    for (const airport of airportsCache || []) {
      if (airport.lat != null && airport.lng != null && !markers[airport.icao]) {
        bounds.push([airport.lat, airport.lng]);
      }
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  function setAirports(airports) {
    airportsCache = airports;
  }

  // Build popup HTML with TAF data (cached to avoid rebuilding when raw TAF hasn't changed)
  function updatePopup(marker, airport, condition, tafData) {
    const cacheKey = airport.icao;

    if (popupHtmlCache[cacheKey] && popupHtmlCache[cacheKey].raw === tafData.raw) {
      marker.bindPopup(popupHtmlCache[cacheKey].content, {
        maxWidth: 300,
        minWidth: 200
      });
      return;
    }

    const color = MapRenderer.getMarkerColor(condition);

    // Extract the true parsed object properties if they are nested inside a .parsed wrapper
    const parsedData = tafData?.parsed ? tafData.parsed : tafData;

    // Format TAF data for display - show the parsed info nicely
    let tafHtml = '';
    
    if (parsedData && typeof parsedData === 'object') {
      // Read from either parsedData or the top-level tafData as a fallback
      const mainCond = parsedData.mainCondition || parsedData.condition || condition;
      const groups = parsedData.groups || [];
      const hasTemp = parsedData.hasTemporaryConditions || false;
      const tempSev = parsedData.tempSeverity || 'N/A';

      tafHtml = `
        <div style="margin-top: 8px; font-size: 12px;">
          <div><strong>Condition:</strong> <span style="color: ${color}; font-weight: bold;">${mainCond}</span></div>
          ${hasTemp ? `<div><strong>Temporary Conditions:</strong> Yes (Severity: ${tempSev})</div>` : ''}
          ${groups.length > 0 ? `
            <div style="margin-top: 6px;"><strong>Forecast Periods:</strong></div>
            <ul style="margin: 4px 0; padding-left: 16px;">
              ${groups.map(g => `<li>${g.type}: ${g.condition}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      `;
    }

    let formattedRawTAF = ''

    if(tafData && tafData.raw) {
      // --- Clean up and format the Raw TAF text into structural lines ---
      // Updated pattern handles standalone PROB30/40, PROB30/40 TEMPO, PROB30/40 INTER, BECMG, TEMPO, INTER, and FM groups
      const lineBreakPattern = /\b(PROB\d{2}(?:\s+(?:TEMPO|INTER))?|TEMPO|INTER|BECMG|FM\d{4,6})\b/gi;
      
      // Add newlines & clean up outer spaces
      formattedRawTAF = tafData.raw.replace(lineBreakPattern, '\n$1').trim();
    } else {
      formattedRawTAF = 'No TAF data available';
    }

    // Split the formatted TAF into an array of lines, then map each line to a distinct div block
    const tafLinesHtml = formattedRawTAF.split('\n').map(line => {
      // This regex finds any block of text starting with - or + (e.g., -SHRA)
      // and wraps it in a span that forbids line-breaking.
      const protectedLine = line.replace(/([+-][A-Z]+)/g, '<span style="white-space: nowrap;">$1</span>');

      return `
        <div style="
          padding-left: 12px; 
          text-indent: -12px; 
          white-space: pre-wrap; 
          word-break: keep-all;
          margin-bottom: 2px;
        ">${protectedLine}</div>
      `;
    }).join('');

    const popupContent = `
      <div style="min-width: 200px;">
        <h3 style="margin: 0 0 4px 0; font-size: 16px;">${airport.name}</h3>
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">ICAO: ${airport.icao}</div>
        
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <div style="
            width: 12px; 
            height: 12px; 
            border-radius: 50%; 
            background-color: ${color};
            border: 1px solid rgba(255,255,255,0.2);
            box-shadow: 0 0 8px ${color}80;
            display:inline-block;
          "></div>
          <span style="font-weight: bold; color: ${color}; font-size: 14px;">
            ${condition === 'IFR' ? 'IFR / Severe Weather' : condition === 'MVFR' ? 'MVFR' : 'VFR'}
          </span>
        </div>

        <div style="border-top: 1px solid #334155; padding-top: 8px;">
          <div style="font-weight: bold; font-size: 12px; margin-bottom: 6px;">Raw TAF:</div>
          <div style="
            font-size: 10px; 
            max-height: 150px; 
            overflow-y: auto;
            background: #1e293b;
            color: #f1f5f9;
            padding: 6px; 
            border-radius: 4px;
            margin: 0;
            font-family: monospace;
          ">
            ${tafLinesHtml}
          </div>
        </div>
      </div>
    `;

    marker.bindPopup(popupContent, {
      maxWidth: 300,
      minWidth: 200
    });

    popupHtmlCache[cacheKey] = { raw: tafData.raw, content: popupContent };
  }

  return {
    init: init,
    updateMarker: updateMarker,
    clearMarkers: clearMarkers,
    fitToMarkers: fitToMarkers,
    getMap: function() { return map; },
    setAirports: setAirports,
    getMarkerColor: getMarkerColor,
    updatePopup: updatePopup
  };
})();