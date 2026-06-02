/**
 * Notification Manager Module
 * 
 * Handles browser Web Notifications API integration.
 * Only triggers notifications for downgrade events:
 *   - GREEN -> YELLOW (MVFR)
 *   - GREEN -> RED (IFR)
 *   - YELLOW -> RED (IFR)
 */

const NotificationManager = (function() {
  'use strict';

  let permission = 'default'; // 'default', 'granted', 'denied'

  /**
   * Request notification permission from the user
   */
  async function requestPermission() {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      permission = 'denied';
      return false;
    }

    try {
      permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch (e) {
      console.warn('Failed to request notification permission:', e);
      permission = 'denied';
      return false;
    }
  }

  /**
   * Check if notifications are supported and permitted
   */
  function isSupported() {
    return 'Notification' in window && permission === 'granted';
  }

  /**
   * Send a browser notification for an airport condition downgrade
   */
  function sendDowngradeNotification(airport, oldCondition, newCondition) {
    if (!isSupported()) return false;

    const conditionLabels = {
      'VFR': 'VFR (Good)',
      'MVFR': 'MVFR (Degrading)',
      'IFR': 'IFR / Severe'
    };

    const emoji = newCondition === 'IFR' ? '🔴' : '🟡';

    const title = `${emoji} ${airport.icao} - Weather Alert`;
    
    let body = '';
    if (oldCondition === 'VFR' && newCondition === 'MVFR') {
      body = `${airport.name}: Conditions degrading from VFR to MVFR`;
    } else if (oldCondition === 'VFR' && newCondition === 'IFR') {
      body = `${airport.name}: Conditions deteriorating from VFR to IFR/Severe!`;
    } else if (oldCondition === 'MVFR' && newCondition === 'IFR') {
      body = `${airport.name}: Conditions degrading from MVFR to IFR/Severe!`;
    }

    const options = {
      body: body,
      icon: '/icons/icon-192.png', // Optional: path to a notification icon
      badge: '/icons/icon-96.png', // Optional: badge for notification
      tag: `airport-${airport.icao}`, // Tag to group/replace notifications
      requireInteraction: newCondition === 'IFR' // Keep notification open for severe conditions
    };

    // Use standard Notification API directly (main thread context)
    try {
      const notif = new Notification(title, options);
      NotificationManager.lastNotification = notif;
      console.log(`Notification sent for ${airport.icao}: ${oldCondition} -> ${newCondition}`);
      
      // Record the notification
      StateManager.recordNotification(airport.icao, newCondition);
      
      return true;
    } catch (e) {
      console.warn('Failed to show notification:', e);
      return false;
    }
  }

  /**
   * Check if a state change qualifies as a downgrade for notifications
   */
  function isDowngradeNotification(oldCondition, newCondition) {
    // Only notify for downgrades (not improvements or same)
    const levels = { 'VFR': 1, 'MVFR': 2, 'IFR': 3 };
    
    return levels[newCondition] > levels[oldCondition];
  }

  /**
   * Determine if we should notify based on cooldown and state
   */
  function shouldNotify(icao, oldCondition, newCondition) {
    // Check if it's a downgrade
    if (!isDowngradeNotification(oldCondition, newCondition)) {
      return false;
    }

    // Check permission
    if (permission !== 'granted') {
      return false;
    }

    // Check state manager cooldown
    return StateManager.shouldNotify(icao, oldCondition, newCondition);
  }

  /**
   * Get current notification permission status
   */
  function getPermission() {
    return permission;
  }

  /**
   * Update the permission status (called after requestPermission)
   */
  function setPermission(newPermission) {
    permission = newPermission;
  }

  return {
    requestPermission: requestPermission,
    isSupported: isSupported,
    sendDowngradeNotification: sendDowngradeNotification,
    isDowngradeNotification: isDowngradeNotification,
    shouldNotify: shouldNotify,
    getPermission: getPermission,
    setPermission: setPermission
  };
})();