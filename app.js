/**
 * Birdseye - Aviation Weather App
 * 
 * Main application orchestrator. Ties together:
 * - Airport data loading
 * - CORS proxy API calls
 * - TAF parsing
 * - State management
 * - Map rendering
 * - Fetch scheduling
 * - Notifications
 */

const APP = (function() {
  'use strict';

  // Configuration
  const CORS_PROXY_URL = 'https://birdseye-proxy.james05.workers.dev'; // Your Cloudflare Worker URL
  const TAF_API_BASE = `${CORS_PROXY_URL}/taf`;

  // State tracking
  let airports = [];
  let previousConditions = {}; // { icao: 'VFR' | 'MVFR' | 'IFR' }

  /**
   * Load airport definitions from JSON file
   */
  async function loadAirports() {
    try {
      const response = await fetch('./airports.json');
      if (!response.ok) throw new Error(`Failed to load airports: ${response.status}`);
      
      airports = await response.json();
      console.log(`Loaded ${airports.length} airports:`);
      airports.forEach(a => console.log(`  - ${a.icao}: ${a.name}`));
      
      return airports;
    } catch (error) {
      console.error('Error loading airports:', error);
      updateStatus('error', 'Failed to load airport data');
      return [];
    }
  }

  /**
   * Fetch TAF data for a list of ICAO airports via CORS proxy
   */
  async function fetchTafData(icaoCodes) {
    const ids = icaoCodes.join(',');
    const url = `${TAF_API_BASE}?ids=${ids}&format=xml&hoursBeforeNow=1`;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      
      const text = await response.text();
      return parseXmlToTafPairs(text, icaoCodes);
    } catch (error) {
      console.error(`Fetch error for ${ids}:`, error);
      return null;
    }
  }

  /**
   * Parse XML response from aviationweather.gov into TAF pairs by ICAO,
   * also extracting lat/lng from the XML to avoid hardcoding coordinates.
   * Returns: { [icao]: { raw: '...', lat: number, lng: number } }
   */
  function parseXmlToTafPairs(xmlText, icaoCodes) {
    const results = {};
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    // Check for parsing errors
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
      console.error('XML parse error:', parseError.textContent);
      return results;
    }

    // Find all TAF elements
    const tafElements = xmlDoc.getElementsByTagName('TAF');
    
    for (let i = 0; i < tafElements.length; i++) {
      const tafEl = tafElements[i];
      const stationId = tafEl.getAttribute('station_id') || '';
      
      if (!stationId) continue;

      // Extract raw TAF text
      const rawTafEl = tafEl.getElementsByTagName('taf')[0];
      let rawTaf = '';
      if (rawTafEl && rawTafEl.firstChild) {
        rawTaf = rawTafEl.firstChild.nodeValue.trim();
      }

      // Extract coordinates from XML (more reliable than hardcoded values)
      const latEl = tafEl.getElementsByTagName('latitude')[0];
      const lngEl = tafEl.getElementsByTagName('longitude')[0];
      const lat = latEl && latEl.firstChild ? parseFloat(latEl.firstChild.nodeValue) : null;
      const lng = lngEl && lngEl.firstChild ? parseFloat(lngEl.firstChild.nodeValue) : null;

      if (rawTaf) {
        results[stationId] = {
          raw: rawTaf,
          lat: lat,
          lng: lng
        };
      } else if (lat !== null && lng !== null) {
        // Store coordinates even without TAF data for marker placement
        results[stationId] = {
          raw: '',
          lat: lat,
          lng: lng
        };
      }
    }

    // Log any airports that didn't return data
    icaoCodes.forEach(icao => {
      if (!results[icao]) {
        console.warn(`No TAF data found for ${icao}`);
      } else if (results[icao].lat === null || results[icao].lng === null) {
        console.warn(`No coordinates found for ${icao} in API response`);
      }
    });

    return results;
  }

  /**
   * Compute checksum and evaluate conditions for each airport.
   * tafPairs is now: { [icao]: { raw: '...', lat: number, lng: number } }
   */
  async function processTafData(tafPairs) {
    const processed = {};
    let overallChecksum = '';

    // Combine all TAF data for checksum (only entries with actual TAF text)
    const sortedIcaos = Object.keys(tafPairs).sort();
    const combinedData = sortedIcaos
      .filter(icao => tafPairs[icao].raw)
      .map(icao => `${icao}:${tafPairs[icao].raw}`)
      .join('|');
    
    if (combinedData) {
      overallChecksum = await TafParser.sha256(combinedData);
    }

    for (const icao of sortedIcaos) {
      const tafData = tafPairs[icao];
      if (!tafData || !tafData.raw) continue;

      // Parse TAF
      const parsed = TafParser.parse(tafData.raw);
      if (!parsed) continue;

      const condition = parsed.mainCondition;
      const color = TafParser.getConditionColor(condition);

      processed[icao] = {
        condition: condition,
        color: color,
        parsed: parsed,
        raw: tafData.raw,
        lat: tafData.lat,
        lng: tafData.lng
      };

      console.log(`${icao}: ${condition} (${color}) at (${tafData.lat}, ${tafData.lng})`);
    }

    return { processed, checksum: overallChecksum };
  }

  /**
   * Compare new conditions with previous state and trigger notifications
   */
  function checkStateChanges(processed) {
    for (const icao in processed) {
      const newState = processed[icao].condition;
      const oldState = previousConditions[icao];

      // Only check if we have a previous state (not first fetch)
      if (oldState && oldState !== newState) {
        // Check if downgrade and should notify
        if (NotificationManager.shouldNotify(icao, oldState, newState)) {
          const airport = airports.find(a => a.icao === icao);
          if (airport) {
            NotificationManager.sendDowngradeNotification(airport, oldState, newState);
          }
        }
      }

      // Update previous condition
      previousConditions[icao] = newState;
    }
  }

  /**
   * Update map markers with new data
   */
  function updateMapMarkers(processed) {
    for (const icao in processed) {
      const airport = airports.find(a => a.icao === icao);
      if (!airport) continue;

      MapRenderer.updateMarker(airport, processed[icao].condition, processed[icao].parsed);
    }
  }

  /**
   * Save all state to localStorage.
   * Includes lat/lng coordinates extracted from the API response for each airport.
   */
  function saveState(checksum, processed) {
    StateManager.saveChecksum(checksum);
    
    const states = {};
    for (const icao in processed) {
      states[icao] = {
        condition: processed[icao].condition,
        lat: processed[icao].lat,
        lng: processed[icao].lng,
        checksum: null, // Individual checksums not stored per airport
        timestamp: new Date().toISOString(),
        rawData: processed[icao].raw
      };
    }
    StateManager.saveAirportStates(states);
  }

  /**
   * Load cached state from localStorage for initial display.
   * Also restores lat/lng coordinates so cached markers appear at correct positions.
   */
  function loadCachedState() {
    const lastFetchTime = StateManager.getLastFetchTime();
    const airportStates = StateManager.getAirportStates();
    
    // Display cached info
    if (lastFetchTime) {
      updateStatus('success', `Last update: ${lastFetchTime.toLocaleTimeString()}`);
    }

    // Restore previous conditions for comparison
    for (const icao in airportStates) {
      previousConditions[icao] = airportStates[icao].condition;
    }

    return airportStates;
  }

  /**
   * Update status bar UI
   */
  function updateStatus(status, message) {
    const statusText = document.getElementById('status-text');
    const countdownText = document.getElementById('countdown-text');
    
    if (!statusText) return;
    
    let html = '';
    
    switch (status) {
      case 'fetching':
        html = `<span class="status-indicator fetching"></span> Fetching TAF data...`;
        break;
      case 'success':
        html = `<span class="status-indicator success"></span>${message}`;
        break;
      case 'error':
        html = `<span class="status-indicator error"></span>Error: ${message}`;
        break;
      default:
        html = `<span class="status-indicator"></span>${message || 'Ready'}`;
    }
    
    statusText.innerHTML = html;
  }

  /**
   * Main fetch and update cycle (called by scheduler)
   */
  async function performFetch() {
    if (airports.length === 0) {
      await loadAirports();
    }

    const icaoCodes = airports.map(a => a.icao);
    
    // Fetch raw TAF data
    const tafPairs = await fetchTafData(icaoCodes);
    if (!tafPairs || Object.keys(tafPairs).length === 0) {
      return { success: false, error: 'No TAF data received' };
    }

    // Process and evaluate
    const { processed, checksum } = await processTafData(tafPairs);
    
    if (Object.keys(processed).length === 0) {
      return { success: false, error: 'Could not parse any TAF data' };
    }

    // Check for state changes and notify
    checkStateChanges(processed);

    // Update map
    updateMapMarkers(processed);

    // Save state
    saveState(checksum, processed);

    console.log(`Fetch complete at ${new Date().toLocaleTimeString()}`);
    
    return { success: true };
  }

  /**
   * Initialize the application
   */
  async function init() {
    console.log('Birdseye Aviation Weather App initializing...');

    // Load airports first
    await loadAirports();
    
    if (airports.length === 0) {
      updateStatus('error', 'No airports configured');
      return;
    }

    // Set up map
    MapRenderer.setAirports(airports);
    const map = MapRenderer.init('map-container');

    // Load cached state for initial display
    const cachedStates = loadCachedState();

    // Display cached markers with coordinates from localStorage
    for (const icao in cachedStates) {
      const airport = airports.find(a => a.icao === icao);
      if (airport && cachedStates[icao].condition) {
        // Build tafData-like object with lat/lng so map renderer can position the marker
        const cachedTafData = {
          lat: cachedStates[icao].lat,
          lng: cachedStates[icao].lng
        };
        MapRenderer.updateMarker(airport, cachedStates[icao].condition, cachedTafData);
      }
    }

    // Fit map to show all airports
    MapRenderer.fitToMarkers();

    // Set up fetch scheduler callback
    FetchScheduler.setOnStatusUpdate(function(statusData) {
      if (statusData.status === 'fetching') {
        updateStatus('fetching', 'Updating TAF data...');
      } else if (statusData.status === 'success') {
        updateStatus('success', `Last: ${statusData.lastFetch} | Next: ${statusData.nextFetch}`);
      } else if (statusData.status === 'error') {
        updateStatus('error', `${statusData.error} | Next: ${statusData.nextFetch}`);
      } else {
        updateStatus('', `Next fetch in ${statusData.countdown}`);
      }
    });

    // Set up notification button
    setupNotificationButton();

    // Set up refresh button
    document.getElementById('btn-refresh').addEventListener('click', function() {
      FetchScheduler.manualRefresh();
    });

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      // Don't auto-request, wait for user interaction with bell icon
      console.log('Notification permission not yet requested');
    } else if ('Notification' in window) {
      NotificationManager.setPermission(Notification.permission);
    }

    // Start the fetch scheduler
    FetchScheduler.startScheduler(performFetch);

    // Initial fetch immediately (don't wait for schedule)
    await performFetch();

    console.log('Birdseye app initialized successfully');
  }

  /**
   * Set up notification button behavior
   */
  function setupNotificationButton() {
    const btn = document.getElementById('btn-notifications');
    if (!btn) return;

    btn.addEventListener('click', async function() {
      const permission = NotificationManager.getPermission();
      
      if (permission === 'default') {
        // Request permission
        const granted = await NotificationManager.requestPermission();
        NotificationManager.setPermission(granted ? 'granted' : 'denied');
        updateNotificationButton();
      } else if (permission === 'granted') {
        // Toggle off
        StateManager.toggleNotifications(false);
        updateNotificationButton();
      } else {
        // Permission denied - show info
        alert('Notification permission was denied. Please enable it in your browser settings.');
      }
    });

    // Initialize button state from saved config
    updateNotificationButton();
  }

  /**
   * Update notification button appearance based on state
   */
  function updateNotificationButton() {
    const btn = document.getElementById('btn-notifications');
    if (!btn) return;

    const permission = NotificationManager.getPermission();
    const enabled = StateManager.areNotificationsEnabled();

    if (permission === 'granted' && enabled) {
      btn.classList.add('active');
      btn.title = 'Notifications Enabled (Click to disable)';
    } else {
      btn.classList.remove('active');
      btn.title = permission === 'granted' ? 'Notifications Disabled (Click to enable)' : 'Enable Notifications';
    }
  }

  return {
    init: init
  };
})();

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  APP.init();
});