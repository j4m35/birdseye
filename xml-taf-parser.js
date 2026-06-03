/**
 * XML TAF Parser Module
 * 
 * Processes pre-parsed TAF data from aviationweather.gov XML responses.
 * Produces the same output structure as taf-parser.js for compatibility.
 * 
 * Usage:
 *   const xmlData = await response.text(); // or DOMParser.parseFromString()
 *   const parsed = XMLElementTafParser.parse(xmlData);
 */

const XMLElementTafParser = (function() {
  'use strict';

  // Severe weather phenomena patterns (same as taf-parser.js)
  const SEVERE_WEATHER = [
    /TS/,    // Thunderstorm (TS, TSRA, +TSRA, -TSRA, TSGR, etc.)
    /SQ/,          // Squall
    /FZRA/,        // Freezing rain
    /TL(?=\s|$)/,  // Tornado
    /DS/,          // Dust storm
    /SS/,          // Sandstorm
  ];

  // Degrading condition patterns (same as taf-parser.js)
  const DEGRADING_WEATHER = [
    /RA/,          // Rain
    /DZ/,          // Drizzle
    /SN/,          // Snow
    /SG/,          // Snow grains
    /PL/,          // Ice pellets
    /GR/,          // Hail
    /GS/,          // Small hail
    /BR/,          // Mist
    /FG/,          // Fog
    /HZ/,          // Haze
    /PO/,          // Dust/sand whirls
    /FC/,          // Funnel cloud/tornado
  ];

  /**
   * Parse visibility string to meters
   * Handles "6+", "2.49", "10SM", etc.
   */
  function parseVisibility(statuteMi) {
    if (!statuteMi) return { value: 10000, unit: 'meters', raw: statuteMi };

    const str = String(statuteMi).trim();

    // P6SM or just "6+" means greater than 6 SM (unlimited)
    if (str.includes('+') || str.startsWith('P')) {
      return { value: 9999, unit: 'meters', raw: str };
    }

    // Try parsing as a number (already in statute miles from XML)
    const num = parseFloat(str);
    if (!isNaN(num)) {
      return { value: Math.round(num * 1609.34), unit: 'meters', raw: str };
    }

    // Fallback
    return { value: 10000, unit: 'meters', raw: str };
  }

  /**
   * Evaluate flight conditions from parsed components
   */
  function evaluateConditions(wind, visibility, clouds, weatherPhenomena) {
    let severity = 'VFR';
    const allWeather = weatherPhenomena || [];

    // 1. Severe Weather Check
    for (const wx of allWeather) {
      const isSevere = SEVERE_WEATHER.some(regex => regex.test(wx.phenomenon));
      if (isSevere) {
        return 'IFR';
      }
    }

    // 2. High wind check (> 25 knots)
    if (wind && (wind.speedKnots > 25 || (wind.gustKnots && wind.gustKnots > 25))) {
      return 'IFR';
    }

    // 3. Visibility check
    if (visibility) {
      if (visibility.value < 1500) {
        severity = 'IFR';
      } else if (visibility.value < 5000 && severity !== 'IFR') {
        severity = 'MVFR';
      }
    }

    // 4. Ceiling check
    if (clouds && clouds.length > 0) {
      let lowestCeiling = null;
      for (const layer of clouds) {
        if (layer.coverage === 'BKN' || layer.coverage === 'OVC') {
          if (!lowestCeiling || layer.altitude < lowestCeiling.altitude) {
            lowestCeiling = layer;
          }
        }
      }

      if (lowestCeiling) {
        if (lowestCeiling.altitude < 1000) {
          severity = 'IFR';
        } else if (lowestCeiling.altitude < 3000 && severity !== 'IFR') {
          severity = 'MVFR';
        }
      }
    }

    // 5. Degrading Weather Check
    if (severity === 'VFR') {
      for (const wx of allWeather) {
        const isDegrading = DEGRADING_WEATHER.some(regex => regex.test(wx.phenomenon));
        if (isDegrading) {
          severity = 'MVFR';
          break;
        }
      }
    }

    return severity;
  }

  /**
   * Parse weather phenomena from wx_string like "-SHRA BR"
   */
  function parseWeatherFromXml(wxString) {
    if (!wxString || typeof wxString !== 'string') return [];

    const weatherPatterns = [];
    const pattern = /([+-]?)(VC)?([A-Z]{2,4})/g;
    let match;

    while ((match = pattern.exec(wxString)) !== null) {
      const skipCodes = ['FEW', 'SCT', 'BKN', 'OVC', 'NSC', 'NCD', 'CAVOK', 'KL', 'NDP'];
      if (skipCodes.includes(match[3])) continue;

      weatherPatterns.push({
        intensity: match[1] || '',
        vicinity: !!match[2],
        phenomenon: match[3],
        raw: match[0]
      });
    }

    return weatherPatterns.length > 0 ? weatherPatterns : [];
  }

  /**
   * Compare two condition levels
   */
  function isWorseCondition(newCond, oldCond) {
    const levels = { 'IFR': 3, 'MVFR': 2, 'VFR': 1 };
    return (levels[newCond] || 0) > (levels[oldCond] || 0);
  }

  /**
   * Parse ISO 8601 timestamp to Date object
   */
  function parseTimestamp(timestampStr) {
    if (!timestampStr) return null;
    const date = new Date(timestampStr);
    return isNaN(date.getTime()) ? null : date;
  }

  /**
   * Format timestamp for display
   */
  function formatTimestamp(date) {
    if (!date) return '';
    return date.toISOString().replace('T', ' ').substring(0, 16);
  }

  /**
   * Parse complete XML TAF response or individual TAF element
   * @param {string|Document|Element} xmlInput - Raw XML string, parsed Document, or TAF Element
   * @param {string} [rawTaf] - Optional raw TAF text (for fallback or display)
   * @returns {object} Parsed TAF data matching taf-parser.js output structure
   */
  function parse(xmlInput, rawTaf) {
    let rootElement;

    if (typeof xmlInput === 'string') {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlInput, 'text/xml');
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        console.error('[XML TAF Parser] XML parsing error:', parseError.textContent);
        return null;
      }
      rootElement = xmlDoc.querySelector('TAF');
    } else if (xmlInput instanceof Document) {
      const parseError = xmlInput.querySelector('parsererror');
      if (parseError) {
        console.error('[XML TAF Parser] XML parsing error:', parseError.textContent);
        return null;
      }
      rootElement = xmlInput.querySelector('TAF');
    } else if (xmlInput instanceof Element && xmlInput.tagName === 'TAF') {
      // Direct TAF element passed in
      rootElement = xmlInput;
    } else {
      return null;
    }

    if (!rootElement) {
      console.error('[XML TAF Parser] No TAF element found');
      return null;
    }

    // Extract root-level metadata (from TAF element or its children)
    const stationId = rootElement.querySelector('station_id')?.textContent || '';
    const issueTime = parseTimestamp(rootElement.querySelector('issue_time')?.textContent);
    const bulletinTime = parseTimestamp(rootElement.querySelector('bulletin_time')?.textContent);
    const validFrom = parseTimestamp(rootElement.querySelector('valid_time_from')?.textContent);
    const validTo = parseTimestamp(rootElement.querySelector('valid_time_to')?.textContent);
    const latitude = parseFloat(rootElement.querySelector('latitude')?.textContent) || 0;
    const longitude = parseFloat(rootElement.querySelector('longitude')?.textContent) || 0;
    const elevationM = parseFloat(rootElement.querySelector('elevation_m')?.textContent) || 0;

    // Get raw text if not provided
    const rawText = rawTaf || rootElement.querySelector('raw_text')?.textContent?.replace(/<!\[CDATA\[/, '').replace(/\]\]>/, '') || '';

    // Extract all forecast blocks
    const forecastElements = rootElement.querySelectorAll('forecast');
    if (forecastElements.length === 0) {
      return null;
    }

    // Parse each forecast block
    const parsedGroups = [];
    let mainCondition = 'VFR';
    let tempSeverity = null;
    let hasTemporaryConditions = false;

    for (const forecast of forecastElements) {
      // Extract time range
      const fcstFrom = parseTimestamp(forecast.querySelector('fcst_time_from')?.textContent);
      const fcstTo = parseTimestamp(forecast.querySelector('fcst_time_to')?.textContent);

      // Extract change indicator (TEMPO, BECMG, FM, etc.)
      const changeIndicator = forecast.querySelector('change_indicator')?.textContent || '';

      // Determine group type
      let groupType = 'MAIN';
      if (changeIndicator === 'TEMPO' || changeIndicator === 'FM') {
        groupType = changeIndicator === 'FM' ? 'FROM' : 'TEMPORARY';
      } else if (changeIndicator) {
        groupType = changeIndicator.toUpperCase();
      }

      // Parse wind
      const windDir = parseFloat(forecast.querySelector('wind_dir_degrees')?.textContent);
      const windSpeed = parseFloat(forecast.querySelector('wind_speed_kt')?.textContent);
      const windGust = parseFloat(forecast.querySelector('wind_gust_kt')?.textContent);
      
      let wind = null;
      if (!isNaN(windDir) && !isNaN(windSpeed)) {
        wind = {
          direction: windDir,
          speedKnots: windSpeed,
          gustKnots: isNaN(windGust) ? null : windGust
        };
      }

      // Parse visibility
      const visStatuteMi = forecast.querySelector('visibility_statute_mi')?.textContent;
      const visibility = parseVisibility(visStatuteMi);

      // Parse cloud layers
      const skyConditions = forecast.querySelectorAll('sky_condition');
      const clouds = [];
      for (const sky of skyConditions) {
        const cover = sky.getAttribute('sky_cover');
        const baseFt = parseFloat(sky.getAttribute('cloud_base_ft_agl'));
        if (cover && !isNaN(baseFt)) {
          clouds.push({
            coverage: cover,
            altitude: baseFt,
            raw: `${cover}${baseFt}`
          });
        }
      }

      // Parse weather phenomena from wx_string
      const wxString = forecast.querySelector('wx_string')?.textContent || '';
      const weather = parseWeatherFromXml(wxString);

      // Evaluate conditions
      const condition = evaluateConditions(wind, visibility, clouds, weather);

      // Build group object matching taf-parser.js structure
      const group = {
        type: groupType,
        timestamp: fcstFrom,
        timestampTo: fcstTo,
        wind: wind,
        visibility: visibility,
        clouds: clouds.length > 0 ? clouds : null,
        weather: weather,
        condition: condition,
        changeIndicator: changeIndicator || undefined,
        raw: rawText.substring(0, 200) + (rawText.length > 200 ? '...' : '')
      };

      parsedGroups.push(group);

      // Track main condition and temporary conditions
      if (groupType === 'TEMPORARY') {
        hasTemporaryConditions = true;
        if (!tempSeverity || isWorseCondition(condition, tempSeverity)) {
          tempSeverity = condition;
        }
      }

      if (isWorseCondition(condition, mainCondition)) {
        mainCondition = condition;
      }
    }

    // If no explicit FROM/Main found but we have groups, use first as main
    if (!parsedGroups.find(g => g.type === 'MAIN' || g.type === 'FROM') && parsedGroups.length > 0) {
      parsedGroups[0].type = 'MAIN';
      mainCondition = parsedGroups[0].condition;
    }

    return {
      stationId: stationId,
      issueTime: issueTime,
      bulletinTime: bulletinTime,
      validFrom: validFrom,
      validTo: validTo,
      location: { latitude: latitude, longitude: longitude, elevationM: elevationM },
      raw: rawText,
      mainCondition: mainCondition,
      hasTemporaryConditions: hasTemporaryConditions,
      tempSeverity: tempSeverity,
      groups: parsedGroups
    };
  }

  /**
   * Get color hex code for a condition level
   */
  function getConditionColor(condition) {
    switch (condition) {
      case 'IFR':
        return '#EF4444';
      case 'MVFR':
        return '#F59E0B';
      case 'VFR':
      default:
        return '#22C55E';
    }
  }

  /**
   * Get condition label for display
   */
  function getConditionLabel(condition) {
    switch (condition) {
      case 'IFR':
        return 'IFR / Severe';
      case 'MVFR':
        return 'MVFR';
      case 'VFR':
      default:
        return 'VFR';
    }
  }

  return {
    parse: parse,
    getConditionColor: getConditionColor,
    getConditionLabel: getConditionLabel
  };
})();
