/**
 * Smart API client that detects environment and routes API calls correctly.
 * Handles both local dev (with proxy) and v0.app preview (direct to localhost:8080).
 */

let API_BASE_URL: string | null = null;

function detectAPIBase(): string {
  if (API_BASE_URL) return API_BASE_URL;

  // In development with vite proxy, use relative paths
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    // Check if we're in v0.app preview or local dev
    const host = window.location.hostname;
    const port = window.location.port;

    console.log('[api-client] Environment detected:', { host, port, isDev: import.meta.env.DEV });

    // v0.app preview URLs are typically *.v0.app
    if (host.includes('v0.app')) {
      // In v0.app preview, the API server is on a different port (8080)
      API_BASE_URL = `http://${host}:8080`;
      console.log('[api-client] v0.app preview detected, using:', API_BASE_URL);
    } else if (host === 'localhost' && port === '8080') {
      // Running API server directly
      API_BASE_URL = '';
      console.log('[api-client] Direct localhost:8080, using relative paths');
    } else {
      // Local dev with vite proxy
      API_BASE_URL = '';
      console.log('[api-client] Local dev with vite proxy, using relative paths');
    }
  } else {
    // Production: use relative paths (served from same origin)
    API_BASE_URL = '';
    console.log('[api-client] Production mode, using relative paths');
  }

  return API_BASE_URL;
}

/**
 * Make an API call with automatic URL construction.
 * @param endpoint - API endpoint path (e.g., "/api/render/check-file")
 * @param options - Fetch options
 */
export async function apiCall(
  endpoint: string,
  options?: RequestInit
): Promise<Response> {
  const baseUrl = detectAPIBase();
  const fullUrl = baseUrl + endpoint;
  
  console.log('[api-client] Calling:', fullUrl);
  
  const headers: Record<string, string> = {};
  if (!(options?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (options?.headers instanceof Headers) {
    options.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (options?.headers && typeof options.headers === 'object') {
    Object.assign(headers, options.headers);
  }
  
  return fetch(fullUrl, {
    ...options,
    headers,
  });
}

/**
 * Make a GET request to the API.
 */
export async function apiGet(endpoint: string): Promise<Response> {
  return apiCall(endpoint, { method: 'GET' });
}

/**
 * Make a POST request to the API.
 */
export async function apiPost(endpoint: string, body?: any): Promise<Response> {
  return apiCall(endpoint, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body),
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
  });
}

/**
 * Make a DELETE request to the API.
 */
export async function apiDelete(endpoint: string): Promise<Response> {
  return apiCall(endpoint, { method: 'DELETE' });
}

/**
 * For WebSocket connections, get the correct URL.
 */
export function getWebSocketURL(endpoint: string): string {
  if (typeof window === 'undefined') return endpoint;
  
  const host = window.location.hostname;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  if (host.includes('v0.app')) {
    // v0.app preview
    return `${proto}//${host}:8080${endpoint}`;
  }
  
  // Local dev or production
  return `${proto}//${window.location.host}${endpoint}`;
}
