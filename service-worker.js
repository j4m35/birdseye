/**
 * Service Worker for Birdseye Aviation Weather App
 * 
 * Provides offline support by caching static assets.
 * Handles push notifications and background sync (limited in browsers).
 */

const CACHE_NAME = 'birdseye-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './taf-parser.js',
  './state-manager.js',
  './map-renderer.js',
  './fetch-scheduler.js',
  './notification-manager.js',
  './airports.json'
];

// Leaflet CSS and JS from CDN (will be cached by browsers from previous visits)
const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/**
 * Install event - cache all static assets
 */
self.addEventListener('install', function(event) {
  console.log('[Service Worker] Install event');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('[Service Worker] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(function() {
        // Activate immediately without waiting for old clients to close
        return self.skipWaiting();
      })
      .catch(function(error) {
        console.error('[Service Worker] Install failed:', error);
      })
  );
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', function(event) {
  console.log('[Service Worker] Activate event');
  
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(cacheName) {
            return cacheName !== CACHE_NAME;
          })
          .map(function(cacheName) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    }).then(function() {
      // Claim control over all clients immediately
      return self.clients.claim();
    })
  );
});

/**
 * Fetch event - serve from cache, fallback to network
 */
self.addEventListener('fetch', function(event) {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        if (response) {
          // Return cached version
          return response;
        }

        // Not in cache - fetch from network
        return fetch(event.request)
          .then(function(networkResponse) {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse;
            }

            // Clone the response to cache it
            const responseToCache = networkResponse.clone();
            
            caches.open(CACHE_NAME)
              .then(function(cache) {
                cache.put(event.request, responseToCache);
              });

            return networkResponse;
          })
          .catch(function() {
            // Full offline fallback for HTML requests
            if (event.request.destination === 'document') {
              return caches.match('./index.html');
            }
          });
      })
  );
});

/**
 * Message event - handle messages from the main thread
 */
self.addEventListener('message', function(event) {
  console.log('[Service Worker] Message received:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Notification click event - focus the app window
 */
self.addEventListener('notificationclick', function(event) {
  console.log('[Service Worker] Notification clicked');
  
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        
        // Focus or navigate to an existing window
        if ('focus' in client) {
          return client.focus();
        }
      }
      
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});

/**
 * Notification close event - clean up
 */
self.addEventListener('notificationclose', function(event) {
  console.log('[Service Worker] Notification closed:', event.notification.tag);
});