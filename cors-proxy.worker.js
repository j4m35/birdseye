/**
 * Cloudflare Worker - CORS Proxy for Aviation Weather API
 * 
 * Deploy this as a Cloudflare Worker to avoid CORS issues
 * when calling aviationweather.gov from a browser-based frontend.
 * 
 * Deployment:
 * 1. Go to Cloudflare Dashboard -> Workers & Pages
 * 2. Create a new Worker and paste this code
 * 3. Save and Deploy
 * 4. Note your worker URL (e.g., https://birdseye-proxy.yourname.workers.dev)
 * 
 * Usage:
 *   GET {WORKER_URL}/taf?ids=WSSS,WIII&format=xml&hoursBeforeNow=1
 *   GET {WORKER_URL}/metar?ids=WSSS,WIII&format=json
 *   GET {WORKER_URL}/bufr?ids=WSSS
 */

const AVIATION_WEATHER_API = 'https://aviationweather.gov/api';

// Map of endpoint aliases to full API paths
const ENDPOINT_MAP = {
  '/taf': '/data/taf',
  '/metar': '/data/metar',
  '/bufr': '/data/bufr',
  '/speci': '/data/speci',
};

async function handleFetch(request) {
  // Handle CORS preflight OPTIONS requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    const url = new URL(request.url);
    
    // Determine the target endpoint from the pathname
    // Expected patterns:
    //   /taf?ids=WSSS -> /data/taf?ids=WSSS
    //   /metar?ids=WIII -> /data/metar?ids=WIII
    let apiPath = '';
    for (const [alias, path] of Object.entries(ENDPOINT_MAP)) {
      if (url.pathname === alias || url.pathname.startsWith(alias + '/')) {
        apiPath = path;
        break;
      }
    }

    // Default to TAF if no recognized endpoint
    if (!apiPath) {
      apiPath = ENDPOINT_MAP['/taf']; // '/data/taf'
    }

    // Build the full target API URL with preserved query parameters
    const queryString = url.search; // Includes leading '?'
    const fullTargetUrl = `${AVIATION_WEATHER_API}${apiPath}${queryString}`;

    const response = await fetch(fullTargetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/xml, text/plain',
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.text();
    const contentType = response.headers.get('content-type') || 'text/plain';

    return new Response(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300', // 5 min cache
      },
    });

  } catch (error) {
    console.error('Proxy error:', error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

export default {
  async fetch(request) {
    return handleFetch(request);
  },
};