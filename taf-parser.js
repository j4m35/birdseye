/**
 * TAF Parser Module
 * 
 * Parses raw TAF (Terminal Aerodrome Forecast) text and extracts
 * meteorological conditions including wind, visibility, clouds,
 * and weather phenomena. Returns structured data with color coding.
 */

const TafParser = (function() {
  'use strict';

  // Severe weather phenomena patterns
  const SEVERE_WEATHER = [
    /TSU?/g,       // Thunderstorm
    /SQ/g,          // Squall
    /FZRA/g,        // Freezing rain
    /TL(?=\s|$)/g,  // Tornado (less common in TAF but included)
    /DS/g,          // Dust storm
    /SS/g,          // Sandstorm
  ];

  // Degrading condition patterns
  const DEGRADING_WEATHER = [
    /RA/g,          // Rain
    /DZ/g,          // Drizzle
    /SN/g,          // Snow
    /SG/g,          // Snow grains
    /PL/g,          // Ice pellets
    /GR/g,          // Hail
    /GS/g,          // Small hail
    /BR/g,          // Mist
    /FG[g]?/g,      // Fog
    /HZ/g,          // Haze
    /PO/g,          // Dust/sand whirls
    /FC/g,          // Funnel cloud/tornado
  ];

  /**
   * Calculate SHA-256 checksum of a string
   */
  async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Parse wind component from TAF string
   */
  function parseWind(tafSection) {
    const windMatch = tafSection.match(/(\d{3,5})([AG]?)?(\d{3})?([G]?\d{2,3})?(KT|MPS|KM\/H)/g);
    if (!windMatch) return null;

    // Get the first (current) wind group from the main forecast
    const match = windMatch[0].match(/(\d{3,5})([AG]?)?(\d{3})?(G\d{2,3})?(KT|MPS|KM\/H)/);
    if (!match) return null;

    const windDir = parseInt(match[1]);
    const windVariation = match[2]; // A (about) or G (variable)
    const windSpeed = parseInt(match[3]) || 0;
    const gustSpeed = match[4] ? parseInt(match[4].replace('G', '')) : null;
    const unit = match[5];

    // Convert to knots if needed
    let speedKnots = windSpeed;
    if (unit === 'MPS') speedKnots = Math.round(windSpeed * 1.94384);
    else if (unit === 'KM/H') speedKnots = Math.round(windSpeed * 0.539957);

    let gustKnots = null;
    if (gustSpeed) {
      gustKnots = unit === 'MPS' ? Math.round(gustSpeed * 1.94384) :
                  unit === 'KM/H' ? Math.round(gustSpeed * 0.539957) : gustSpeed;
    }

    return {
      direction: windDir,
      speedKnots: speedKnots,
      gustKnots: gustKnots
    };
  }

  /**
   * Parse visibility from TAF string
   */
  function parseVisibility(tafSection) {
    // Match P6SM (greater than 6 SM), 5SM, 1/2SM, etc. or metric values
    const visMatch = tafSection.match(/(P?\d+(?:\/\d+)?)(SM|KM|MT)/g);
    
    if (!visMatch) {
      // Default to unlimited if no visibility specified in section
      return { value: 10000, unit: 'meters', raw: 'P6SM' };
    }

    const match = visMatch[0].match(/(P?)(\d+(?:\/\d+)?)(SM|KM|MT)/);
    if (!match) return null;

    let value;
    const num = match[2];
    
    if (num.includes('/')) {
      const parts = num.split('/');
      value = Math.round(parseInt(parts[0]) / parseInt(parts[1]));
    } else {
      value = parseInt(num);
    }

    // P6SM means greater than 6 statute miles
    if (match[1] === 'P' && match[3] === 'SM') {
      value = 9999; // Effectively unlimited
    }

    let unit = 'meters';
    if (match[3] === 'SM') {
      value = Math.round(value * 1609.34); // Convert statute miles to meters
      unit = 'meters';
    } else if (match[3] === 'KM') {
      value *= 1000;
      unit = 'meters';
    }

    return { value, unit, raw: match[0] };
  }

  /**
   * Parse cloud layer from TAF string
   */
  function parseClouds(tafSection) {
    const cloudPatterns = /(?:FEW|SCT|BKN|OVC|NSC|CAVOK)(\d{3})/g;
    const layers = [];
    let match;

    while ((match = cloudPatterns.exec(tafSection)) !== null) {
      const coverage = match[1] ? match[0].substring(0, 3) : match[0].substring(0, 3);
      const altitude = parseInt(match[1]) * 100; // Altitude in hundreds of feet

      layers.push({
        coverage: coverage,
        altitude: altitude,
        raw: match[0]
      });
    }

    return layers.length > 0 ? layers : null;
  }

  /**
   * Parse weather phenomena from TAF string
   */
  function parseWeather(tafSection) {
    const weatherPatterns = [];
    
    // Match intensity and description codes + phenomenon
    // Intensity: - (light), + (heavy), VC (vicinity)
    // Phenomenon: RA, DZ, SN, FG, TS, SQ, etc.
    
    const pattern = /([+-]?)(VC)?([A-Z]{2,4})/g;
    let match;
    
    while ((match = pattern.exec(tafSection)) !== null) {
      // Skip cloud and wind codes
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
   * Split TAF into main forecast + RMG section
   */
  function splitTafSections(rawTaf) {
    // Check for TEMPO and GROUP (FM/BECGRP/TEMPO/FM) sections
    const tempoMatches = rawTaf.match(/(TEMPO\b[\s\S]*?)(?=BECGRP|FM\d{4}|RMK|$)/gi);
    const tempoGroups = tempoMatches ? tempoMatches.map(m => m.trim()) : [];

    // Check for PROB (probability groups)
    const probPattern = /(PROB\d{2})\s+([\s\S]*?)(?=(?:TEMPO|PROB|FM|BECGRP|BECMG|RMK)|$)/gi;
    const probGroups = [];
    let probMatch;
    while ((probMatch = probPattern.exec(rawTaf)) !== null) {
      probGroups.push({
        probability: parseInt(probMatch[1].replace('PROB', '')),
        conditions: probMatch[2].trim()
      });
    }

    return { tempoGroups, probGroups };
  }

  /**
   * Determine condition severity level from weather phenomena
   */
  function assessWeatherSeverity(weatherPhenomena) {
    if (!weatherPhenomena || weatherPhenomena.length === 0) {
      return 'VFR';
    }

    let hasSevere = false;
    let hasDegrading = false;

    for (const wx of weatherPhenomena) {
      const isSevere = SEVERE_WEATHER.some(p => p.test(wx.phenomenon));
      const isDegrading = DEGRADING_WEATHER.some(p => p.test(wx.phenomenon));

      if (isSevere && !['TS', 'SQ'].includes(wx.phenomenon)) hasSevere = true;
      if (wx.phenomenon === 'TS' || wx.phenomenon === 'SQ') hasSevere = true;
      if (isDegrading) hasDegrading = true;
      
      // VC phenomena are in vicinity, less severe
      if (wx.vicinity && isDegrading) hasDegrading = true;
    }

    if (hasSevere) return 'IFR';
    if (hasDegrading) return 'MVFR';
    return 'VFR';
  }

  /**
   * Determine the overall condition of a TAF section
   */
  function evaluateConditions(wind, visibility, clouds, weatherPhenomena) {
    let severity = 'VFR'; // Default: Visual Flight Rules

    // Check for severe weather phenomena (THREAT LEVEL - overrides everything)
    const allWeather = weatherPhenomena || [];
    const hasThunderstorm = allWeather.some(w => w.phenomenon === 'TS');
    const hasSquall = allWeather.some(w => w.phenomenon === 'SQ');
    
    if (hasThunderstorm || hasSquall) {
      severity = 'IFR'; // RED
      return severity;
    }

    // Check for high wind speeds (> 25 knots)
    if (wind && (wind.speedKnots > 25 || (wind.gustKnots && wind.gustKnots > 35))) {
      severity = 'IFR'; // RED
      return severity;
    }

    // Check visibility (< 5000m = MVFR, < 1500m = IFR)
    if (visibility) {
      if (visibility.value < 1500) {
        severity = 'IFR'; // RED - very low visibility
      } else if (visibility.value < 5000) {
        severity = 'MVFR'; // YELLOW - moderate visibility
      }
    }

    // Check ceiling (< 1000ft = IFR, < 3000ft = MVFR)
    if (clouds && clouds.length > 0) {
      const lowestCeiling = clouds.reduce((min, layer) => {
        const coverages = ['OVC', 'BKN', 'SCT', 'FEW'];
        const idx = coverages.indexOf(layer.coverage);
        return idx >= 0 ? layer : null;
      }, null);

      if (lowestCeiling) {
        if (lowestCeiling.altitude < 1000) {
          severity = 'IFR'; // RED - very low ceiling
        } else if (lowestCeiling.altitude < 3000 && 
                   (lowestCeiling.coverage === 'BKN' || lowestCeiling.coverage === 'OVC')) {
          if (severity !== 'IFR') {
            severity = 'MVFR'; // YELLOW - broken/overcast low ceiling
          }
        }
      }
    }

    // Check for significant non-weather phenomena (e.g., FZRA, GR)
    const severePhenomena = ['FZRA', 'GR', 'GS', 'PL'];
    if (allWeather.some(w => severePhenomena.includes(w.phenomenon))) {
      severity = 'IFR'; // RED
    }

    return severity;
  }

  /**
   * Check if a condition represents degrading/fluctuating weather (TEMPO/PROB)
   */
  function assessTemporaryConditions(tafSection) {
    if (!tafSection) return null;

    // Look for TEMPO or PROB groups in the section
    const hasTempo = /TEMPO/i.test(tafSection);
    const hasProb = /PROB\d{2}/i.test(tafSection);

    if (!hasTempo && !hasProb) return null;

    // Extract conditions from TEMPO/PROB block
    let tempConditions = '';
    
    const tempoMatch = tafSection.match(/TEMPO\b([\s\S]*?)(?=BECGRP|FM\d{4}|TEMPO|RMK|$)/i);
    if (tempoMatch) {
      tempConditions = tempoMatch[1];
    }

    const probMatch = tafSection.match(/PROB\d{2}\s+([\s\S]*?)(?=(?:TEMPO|PROB|FM|BECGRP|RMK)|$)/i);
    if (probMatch) {
      tempConditions = probMatch[1];
    }

    // Evaluate the temporary conditions
    const wind = parseWind(tempConditions);
    const visibility = parseVisibility(tempConditions);
    const clouds = parseClouds(tempConditions);
    const weather = parseWeather(tempConditions);

    return {
      isTemporary: true,
      severity: evaluateConditions(wind, visibility, clouds, weather),
      wind: wind,
      visibility: visibility,
      clouds: clouds,
      weather: weather
    };
  }

  /**
   * Parse a complete TAF string into structured data
   * @param {string} rawTaf - Raw TAF text from aviationweather.gov API
   * @returns {object} Parsed TAF data with conditions for each group
   */
  function parse(rawTaf) {
    if (!rawTaf || typeof rawTaf !== 'string') {
      return null;
    }

    // Clean up the raw TAF text (handle multi-line formats)
    const cleanText = rawTaf.replace(/\r\n/g, '\n').trim();

    // Split into groups: main forecast + FM/BECGRP/TEMPO sections
    const sectionPattern = /(?:FM|BECMG|TEMPO|PROB)\d{4}/g;
    const sections = [];
    
    // Find all group boundaries
    const groups = [];
    let lastIndex = 0;
    let match;
    
    // Add pattern to find group start markers
    const markerPattern = /(?:^|\n)(?:(?:FM|BECMG|TEMPO|PROB)\d{4})/gm;
    while ((match = markerPattern.exec(cleanText)) !== null) {
      if (lastIndex > 0 && lastIndex < match.index) {
        groups.push({
          type: 'MAIN',
          start: lastIndex,
          end: match.index,
          text: cleanText.substring(lastIndex, match.index).trim()
        });
      }
      // Determine group type
      let groupType = 'MAIN';
      if (match[0].includes('TEMPO') || match[0].includes('PROB')) {
        groupType = 'TEMPORARY';
      } else if (match[0].includes('FM')) {
        groupType = 'FROM';
      } else if (match[0].includes('BECMG')) {
        groupType = 'BECOMING';
      }
      
      groups.push({
        type: groupType,
        start: match.index,
        end: null, // Will be calculated later
        text: null  // Will be extracted later
      });

      lastIndex = match.index;
    }

    // Add the last section
    if (lastIndex < cleanText.length) {
      groups.push({
        type: groups.length === 0 ? 'MAIN' : 'TEMPORARY',
        start: lastIndex,
        end: null,
        text: null
      });
    }

    // If no explicit groups found, the whole thing is one section
    if (groups.length === 0) {
      groups.push({ type: 'MAIN', start: 0, end: cleanText.length, text: cleanText });
    } else {
      // Link sections and extract text
      for (let i = 0; i < groups.length; i++) {
        if (i < groups.length - 1) {
          groups[i].end = groups[i + 1].start;
          groups[i].text = cleanText.substring(groups[i].start, groups[i].end).trim();
        } else {
          groups[i].end = cleanText.length;
          groups[i].text = cleanText.substring(groups[i].start).trim();
        }
      }
    }

    // Parse each section
    const parsedGroups = [];
    let mainCondition = 'VFR';
    let hasTemporaryConditions = false;

    for (const group of groups) {
      if (group.type === 'TEMPORARY') continue; // Handle below

      const wind = parseWind(group.text);
      const visibility = parseVisibility(group.text);
      const clouds = parseClouds(group.text);
      const weather = parseWeather(group.text);
      
      const condition = evaluateConditions(wind, visibility, clouds, weather);
      
      parsedGroups.push({
        type: group.type,
        timestamp: null, // Could extract from FMxxxxxx if present
        wind: wind,
        visibility: visibility,
        clouds: clouds,
        weather: weather,
        condition: condition,
        raw: group.text.substring(0, 200) + (group.text.length > 200 ? '...' : '')
      });

      // Main condition is from the first valid group
      if (!parsedGroups.find(g => g.type === 'FROM' || g.type === 'MAIN') || 
          parsedGroups[parsedGroups.length - 1].type === group.type) {
        mainCondition = condition;
      }
    }

    // Evaluate TEMPO/PROB sections
    const tempoResult = assessTemporaryConditions(cleanText);
    if (tempoResult) {
      hasTemporaryConditions = true;
      // If temp conditions are worse than main, flag it
      const tempWorse = isWorseCondition(tempoResult.severity, mainCondition);
      
      // Use the worst of main or tempo for overall assessment
      if (tempWorse && mainCondition !== 'IFR') {
        mainCondition = tempoResult.severity;
      }
    }

    return {
      raw: cleanText,
      mainCondition: mainCondition,
      hasTemporaryConditions: hasTemporaryConditions,
      tempSeverity: tempoResult ? tempoResult.severity : null,
      groups: parsedGroups
    };
  }

  /**
   * Compare two condition levels, returns true if new is worse than old
   */
  function isWorseCondition(newCond, oldCond) {
    const levels = { 'IFR': 3, 'MVFR': 2, 'VFR': 1 };
    return levels[newCond] > levels[oldCond];
  }

  /**
   * Get color hex code for a condition level
   */
  function getConditionColor(condition) {
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

  /**
   * Check if a state change is a downgrade (triggers notification)
   */
  function isDowngrade(oldState, newState) {
    const levels = { 'IFR': 3, 'MVFR': 2, 'VFR': 1 };
    return levels[newState] > levels[oldState];
  }

  return {
    parse: parse,
    getConditionColor: getConditionColor,
    getConditionLabel: getConditionLabel,
    isDowngrade: isDowngrade,
    sha256: sha256
  };
})();