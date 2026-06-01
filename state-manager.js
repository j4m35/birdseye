/**
 * State Manager Module
 * 
 * Handles localStorage persistence of fetched TAF data and airport states.
 * Uses SHA-256 checksums to efficiently detect changes between fetches.
 */

const StateManager = (function() {
  'use strict';

  const STORAGE_KEY_PREFIX = 'birdseye_';
  const CHECKSUM_KEY = STORAGE_KEY_PREFIX + 'checksum';
  const TIMESTAMP_KEY = STORAGE_KEY_PREFIX + 'lastFetch';
  const AIRPORT_STATES_KEY = STORAGE_KEY_PREFIX + 'airportStates';
  const NOTIFICATION_STATE_KEY = STORAGE_KEY_PREFIX + 'notificationState';

  /**
   * Save the checksum and raw TAF data for all airports
   */
  function saveChecksum(checksum) {
    try {
      localStorage.setItem(CHECKSUM_KEY, checksum);
      localStorage.setItem(TIMESTAMP_KEY, new Date().toISOString());
    } catch (e) {
      console.warn('Failed to save checksum:', e);
    }
  }

  /**
   * Get the previously stored checksum
   */
  function getChecksum() {
    try {
      return localStorage.getItem(CHECKSUM_KEY);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the timestamp of the last fetch
   */
  function getLastFetchTime() {
    try {
      const ts = localStorage.getItem(TIMESTAMP_KEY);
      return ts ? new Date(ts) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save the state of all airports.
   * Each state entry includes condition, coordinates (lat/lng from API), and optional raw data.
   * @param {Object} states - { [icao]: { condition: string, lat?: number, lng?: number, timestamp?: string, rawData?: string } }
   */
  function saveAirportStates(states) {
    try {
      localStorage.setItem(AIRPORT_STATES_KEY, JSON.stringify(states));
    } catch (e) {
      console.warn('Failed to save airport states:', e);
    }
  }

  /**
   * Get the previously saved airport states
   */
  function getAirportStates() {
    try {
      const data = localStorage.getItem(AIRPORT_STATES_KEY);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Save the state of a single airport.
   * @param {string} icao - ICAO code
   * @param {Object} state - { condition: string, lat?: number, lng?: number, checksum?: string, timestamp?: string, rawData?: string }
   */
  function saveAirportState(icao, state) {
    const states = getAirportStates();
    try {
      states[icao] = {
        condition: state.condition,
        lat: state.lat ?? null,
        lng: state.lng ?? null,
        checksum: state.checksum || null,
        timestamp: new Date().toISOString(),
        rawData: state.rawData || null
      };
      localStorage.setItem(AIRPORT_STATES_KEY, JSON.stringify(states));
    } catch (e) {
      console.warn('Failed to save airport state:', e);
    }
  }

  /**
   * Get the state of a single airport
   */
  function getAirportState(icao) {
    try {
      const states = getAirportStates();
      return states[icao] || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save notification configuration and tracking state
   */
  function saveNotificationState(config) {
    try {
      localStorage.setItem(NOTIFICATION_STATE_KEY, JSON.stringify(config));
    } catch (e) {
      console.warn('Failed to save notification state:', e);
    }
  }

  /**
   * Get notification configuration and tracking state
   */
  function getNotificationState() {
    try {
      const data = localStorage.getItem(NOTIFICATION_STATE_KEY);
      if (!data) {
        return { enabled: true, lastNotified: {} };
      }
      return JSON.parse(data);
    } catch (e) {
      return { enabled: true, lastNotified: {} };
    }
  }

  /**
   * Record that a notification was sent for an airport at a given time
   */
  function recordNotification(icao, condition) {
    const state = getNotificationState();
    state.lastNotified[icao] = {
      condition: condition,
      timestamp: new Date().toISOString()
    };
    saveNotificationState(state);
  }

  /**
   * Check if we've already notified for a downgrade to this condition recently
   * (cooldown period in milliseconds)
   */
  function shouldNotify(icao, oldCondition, newCondition, cooldownMs = 1800000) { // 30 min default
    const state = getNotificationState();
    
    if (!state.enabled) return false;
    
    // Check cooldown - don't notify for the same downgrade too quickly
    const lastNotified = state.lastNotified[icao];
    if (lastNotified) {
      const lastTime = new Date(lastNotified.timestamp).getTime();
      const now = Date.now();
      if (now - lastTime < cooldownMs) {
        return false;
      }
      // Don't re-notify for the same downgrade (e.g., don't notify Green->Red again 
      // if we already notified it for this session's data)
      if (lastNotified.condition === newCondition) {
        return false;
      }
    }

    return true;
  }

  /**
   * Toggle notification enable/disable
   */
  function toggleNotifications(enabled) {
    const state = getNotificationState();
    state.enabled = enabled;
    saveNotificationState(state);
    return enabled;
  }

  /**
   * Check if notifications are enabled in config
   */
  function areNotificationsEnabled() {
    return getNotificationState().enabled;
  }

  /**
   * Clear all stored state (for debugging/reset)
   */
  function clearAll() {
    try {
      localStorage.removeItem(CHECKSUM_KEY);
      localStorage.removeItem(TIMESTAMP_KEY);
      localStorage.removeItem(AIRPORT_STATES_KEY);
      localStorage.removeItem(NOTIFICATION_STATE_KEY);
    } catch (e) {
      console.warn('Failed to clear state:', e);
    }
  }

  /**
   * Get full state dump for debugging
   */
  function getFullState() {
    return {
      checksum: getChecksum(),
      lastFetchTime: getLastFetchTime(),
      airportStates: getAirportStates(),
      notificationState: getNotificationState()
    };
  }

  return {
    saveChecksum: saveChecksum,
    getChecksum: getChecksum,
    getLastFetchTime: getLastFetchTime,
    saveAirportStates: saveAirportStates,
    getAirportStates: getAirportStates,
    saveAirportState: saveAirportState,
    getAirportState: getAirportState,
    saveNotificationState: saveNotificationState,
    getNotificationState: getNotificationState,
    recordNotification: recordNotification,
    shouldNotify: shouldNotify,
    toggleNotifications: toggleNotifications,
    areNotificationsEnabled: areNotificationsEnabled,
    clearAll: clearAll,
    getFullState: getFullState
  };
})();