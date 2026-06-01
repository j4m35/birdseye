/**
 * Fetch Scheduler Module
 * 
 * Manages periodic data fetching at :10 and :40 minutes past the hour.
 * Provides countdown display and status updates.
 */

const FetchScheduler = (function() {
  'use strict';

  let fetchInterval = null;
  let countdownInterval = null;
  let nextFetchTime = null;
  let onStatusUpdate = null; // Callback for UI updates
  let onFetchComplete = null; // Callback when fetch completes
  let isFetching = false;

  /**
   * Calculate the next scheduled fetch time (:10 or :40 past the hour)
   */
  function getNextFetchTime() {
    const now = new Date();
    const currentMinutes = now.getMinutes();
    
    if (currentMinutes < 10) {
      // Next fetch is at :10 this hour
      const next = new Date(now);
      next.setMinutes(10, 0, 0);
      return next;
    } else if (currentMinutes < 40) {
      // Next fetch is at :40 this hour
      const next = new Date(now);
      next.setMinutes(40, 0, 0);
      return next;
    } else {
      // Next fetch is at :10 next hour
      const next = new Date(now);
      next.setHours(next.getHours() + 1);
      next.setMinutes(10, 0, 0);
      return next;
    }
  }

  /**
   * Format a countdown duration to a human-readable string
   */
  function formatCountdown(ms) {
    if (ms <= 0) return '0m';
    
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    
    if (minutes > 60) {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }
    
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  /**
   * Update the countdown display
   */
  function updateCountdown() {
    if (!nextFetchTime || !onStatusUpdate) return;
    
    const now = new Date();
    const remaining = nextFetchTime - now;
    
    if (remaining <= 0) {
      onStatusUpdate({
        status: 'fetching',
        countdown: '0m',
        nextFetch: nextFetchTime.toLocaleTimeString()
      });
      return;
    }
    
    onStatusUpdate({
      status: 'waiting',
      countdown: formatCountdown(remaining),
      nextFetch: nextFetchTime.toLocaleTimeString()
    });
  }

  /**
   * Set up the fetch interval - triggers at :10 and :40
   */
  function startScheduler(fetchCallback) {
    // Clear any existing scheduler
    stopScheduler();

    onFetchComplete = fetchCallback;
    nextFetchTime = getNextFetchTime();
    
    // Start countdown update (every second)
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
    
    // Set up the main fetch interval
    scheduleNextFetch();
    
    console.log(`Next TAF fetch scheduled at: ${nextFetchTime.toLocaleTimeString()}`);
  }

  /**
   * Schedule the next fetch timer
   */
  function scheduleNextFetch() {
    if (fetchInterval) clearTimeout(fetchInterval);
    
    const now = new Date();
    const delay = nextFetchTime - now;
    
    if (delay <= 0) {
      // Time to fetch now
      performFetch();
      return;
    }
    
    fetchInterval = setTimeout(async () => {
      await performFetch();
      
      // Schedule the next one
      nextFetchTime = getNextFetchTime();
      scheduleNextFetch();
    }, delay);
  }

  /**
   * Perform the actual fetch (calls the callback)
   */
  async function performFetch() {
    isFetching = true;
    
    if (onStatusUpdate) {
      onStatusUpdate({ status: 'fetching', countdown: '--', nextFetch: '--' });
    }
    
    try {
      const result = await onFetchComplete();
      
      if (result && result.success) {
        if (onStatusUpdate) {
          onStatusUpdate({
            status: 'success',
            lastFetch: new Date().toLocaleTimeString(),
            countdown: formatCountdown(nextFetchTime - new Date()),
            nextFetch: nextFetchTime.toLocaleTimeString()
          });
        }
      } else if (onStatusUpdate) {
        onStatusUpdate({
          status: 'error',
          error: result?.error || 'Unknown error',
          countdown: formatCountdown(nextFetchTime - new Date()),
          nextFetch: nextFetchTime.toLocaleTimeString()
        });
      }
    } catch (error) {
      console.error('Fetch error:', error);
      if (onStatusUpdate) {
        onStatusUpdate({
          status: 'error',
          error: error.message,
          countdown: formatCountdown(nextFetchTime - new Date()),
          nextFetch: nextFetchTime.toLocaleTimeString()
        });
      }
    } finally {
      isFetching = false;
    }
  }

  /**
   * Immediately trigger a fetch (manual refresh)
   */
  async function manualRefresh() {
    if (isFetching) return;
    
    // Reset the schedule for after this fetch
    nextFetchTime = getNextFetchTime();
    await performFetch();
    
    // Reschedule normally
    scheduleNextFetch();
  }

  /**
   * Stop the scheduler
   */
  function stopScheduler() {
    if (fetchInterval) {
      clearTimeout(fetchInterval);
      fetchInterval = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    isFetching = false;
  }

  /**
   * Check if the scheduler is currently running
   */
  function isRunning() {
    return fetchInterval !== null || countdownInterval !== null;
  }

  /**
   * Get the next scheduled fetch time
   */
  function getNextFetch() {
    return nextFetchTime;
  }

  /**
   * Set the status update callback
   */
  function setOnStatusUpdate(callback) {
    onStatusUpdate = callback;
  }

  return {
    startScheduler: startScheduler,
    stopScheduler: stopScheduler,
    manualRefresh: manualRefresh,
    isRunning: isRunning,
    getNextFetch: getNextFetch,
    setOnStatusUpdate: setOnStatusUpdate,
    formatCountdown: formatCountdown
  };
})();