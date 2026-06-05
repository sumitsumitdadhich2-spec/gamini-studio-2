/**
 * Smart API client that uses relative paths for all API calls.
 * Works with vite proxy in dev, and direct routing in production.
 * The vite proxy configuration forwards /api/* to localhost:8080.
 */

function detectAPIBase(): string {
  // ALWAYS use relative paths. The vite proxy (in dev) and the app (in prod)
  // both handle /api/* routing correctly. Never try to access localhost:8080 directly
  // as it breaks CORS on v0.app and other deployment environments.
  console.log('[api-client] Using relative paths for all API calls');
  return '';
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
 * Uses the same host as the current page (vite proxy will forward in dev).
 */
export function getWebSocketURL(endpoint: string): string {
  if (typeof window === 'undefined') return endpoint;
  
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host; // Include port if present
  
  // Use the same host as the current page (vite proxy will forward to localhost:8080 in dev)
  return `${proto}//${host}${endpoint}`;
}
