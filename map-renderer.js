/**
 * Map Renderer Module
 * 
 * Creates and manages a Leaflet.js map with colored circle markers
 * for each airport. Clicking a marker displays a popup with the raw TAF text.
 */

const MapRenderer = (function() {
  'use strict';

  let map = null;
  let markers = {}; //icao -> circleMarker/LatLngPopup
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
   * Get the color hex code for a given condition
   */
  function getMarkerColor(condition) {
    switch (condition) {
      case 'IFR':
        return '#EF4444'; // Red
      case 'MVFR':
        return '#F59E0B'; // Yellow/Amber
      case 'VFR':
      default:
        return '#22C55E'; // Green
    }
  }

  const AIRPORT_CIRCLE_OFFSET = 18;

  /**
   * Update or add a marker for an airport.
   * Coordinates are extracted from tafData.lat/lng (from API) rather than hardcoded in airports.json.
   */
  function updateMarker(airport, condition, tafData) {
    if (!map) {
      init('map-container');
    }

    const color = getMarkerColor(condition);
    // Use coordinates from API response; fall back to airport lat/lng if available (for cached/initial display)
    const latlng = [tafData?.lat ?? airport.lat, tafData?.lng ?? airport.lng];
    
    // Remove existing marker if it exists
    if (markers[airport.icao]) {
      map.removeLayer(markers[airport.icao]);
      if (markers[airport.icao].label) {
        map.removeLayer(markers[airport.icao].label);
      }
      delete markers[airport.icao];
    }

    // Create new circle marker with updated color
    const circleMarker = L.circleMarker(latlng, {
      radius: AIRPORT_CIRCLE_RADIUS,
      fillColor: color,
      fillOpacity: 1,
      color: color,
      weight: 2,
      opacity: 0.5,
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
        iconAnchor: [40, AIRPORT_CIRCLE_OFFSET + 10]
      }),
      interactive: false
    }).addTo(map);

    circleMarker.label = label;
    markers[airport.icao] = circleMarker;

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

  // Store airports reference for fitToMarkers
  let airportsCache = [];

  function setAirports(airports) {
    airportsCache = airports;
  }

  return {
    init: init,
    updateMarker: updateMarker,
    clearMarkers: clearMarkers,
    fitToMarkers: fitToMarkers,
    getMap: function() { return map; },
    setAirports: setAirports
  };
})();

// Build popup HTML with TAF data
function updatePopup(marker, airport, condition, tafData) {
  const color = MapRenderer.getMarkerColor ? 
    (condition === 'IFR' ? '#EF4444' : condition === 'MVFR' ? '#F59E0B' : '#22C55E') : '';

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
    // This regex looks for word boundaries matching your keywords.
    // The (?=...) ensures we find the position right BEFORE the word, so we don't delete it.
    const lineBreakPattern = /\b(?=PROB\d{2}\s+TEMPO|TEMPO|INTER|BECMG|FM\d{4,6})\b/gi;
    
    // Format the text by replacing those positions with a newline character
    formattedRawTAF = tafData.raw.replace(lineBreakPattern, '\n').trim();
  } else {
    formattedRawTAF = 'No TAF data available';
  }

  const popupContent = `
    <div style="min-width: 200px;">
      <h3 style="margin: 0 0 4px 0; font-size: 16px;">${airport.name}</h3>
      <div style="font-size: 12px; color: #666; margin-bottom: 8px;">ICAO: ${airport.icao}</div>
      
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <div style="
          width: 14px; 
          height: 14px; 
          border-radius: 50%; 
          background-color: ${color};
          border: 2px solid #fff;
          box-shadow: 0 0 4px rgba(0,0,0,0.3);
        "></div>
        <span style="font-weight: bold; color: ${color}; font-size: 14px;">
          ${condition === 'IFR' ? 'IFR / Severe Weather' : condition === 'MVFR' ? 'MVFR' : 'VFR'}
        </span>
      </div>

      ${tafHtml}

      <div style="border-top: 1px solid #334155; padding-top: 6px;">
        <div style="font-weight: bold; font-size: 12px; margin-bottom: 4px;">Raw TAF:</div>
        <pre style="
          font-size: 10px; 
          white-space: pre-wrap; 
          word-break: break-all; 
          max-height: 150px; 
          overflow-y: auto;
          background: #1e293b;
          color: #f1f5f9;
          padding: 6px;
          border-radius: 4px;
          margin: 0;
          font-family: monospace;
        ">${formattedRawTAF}</pre>
      </div>
    </div>
  `;

  marker.bindPopup(popupContent, {
    maxWidth: 300,
    minWidth: 200
  });
}

// Add a method to updatePopup to the module
MapRenderer.updatePopup = updatePopup;