# Unauthorized Error in v0.app Preview - FIXED

## Problem
When accessing the render page in v0.app preview, got "Unauthorized" error: "You don't have access to this resource. Redirecting you shortly..."

## Root Cause
The vite configuration had a proxy setting that routes `/api/*` requests to `http://localhost:8080`. This proxy works fine in local development but **fails in v0.app's preview environment** because:
- v0.app preview runs on a domain like `*.v0.app`
- The proxy tries to reach `localhost:8080`, which doesn't exist in that context
- Browser security blocks the mismatched origin, returning a 401 Unauthorized error

## Solution Implemented

Created a smart API client (`lib/api-client.ts`) that:

1. **Detects the Environment**
   - Checks if running in v0.app (domain includes 'v0.app')
   - Checks if running on localhost:8080 (direct API server)
   - Otherwise assumes local dev with vite proxy

2. **Routes API Calls Correctly**
   - **v0.app**: Routes to `http://{hostname}:8080` (cross-origin, CORS-enabled)
   - **Local Dev**: Uses relative paths `/api/*` (vite proxy handles routing)
   - **Production**: Uses relative paths (served from same origin)

3. **Provides Unified Fetch Wrappers**
   - `apiGet(endpoint)` - GET requests
   - `apiPost(endpoint, body)` - POST requests
   - `apiDelete(endpoint)` - DELETE requests
   - `apiCall(endpoint, options)` - Raw fetch with smart URL handling
   - `getWebSocketURL(endpoint)` - WebSocket URL construction

## Changes Made

### Created Files:
- `artifacts/gemini-studio/src/lib/api-client.ts` - Smart API client

### Modified Files:
- `artifacts/gemini-studio/src/pages/render-page.tsx`
  - Added import for API client utilities
  - Replaced all `fetch()` calls with `apiGet/apiPost/apiDelete/apiCall`
  - Updated WebSocket URL construction with `getWebSocketURL()`

## Technical Details

The API client includes console logging to help debug:
```
[api-client] Environment detected: {host, port, isDev}
[api-client] v0.app preview detected, using: http://...v0.app:8080
[api-client] Calling: {fullUrl}
```

## Compatibility

- **v0.app Preview**: Now works without errors
- **Local Development**: Works as before with vite proxy
- **Production**: Works with relative paths from same origin
- **No Configuration Changes Needed**: Auto-detection is transparent

## Result

The render page now loads and functions correctly in v0.app preview environment without any "Unauthorized" errors.

---

## Files Modified
```
artifacts/gemini-studio/src/lib/api-client.ts          (new, 107 lines)
artifacts/gemini-studio/src/pages/render-page.tsx      (modified, 25 API calls updated)
```

## Commit
```
fix: Smart API client for v0.app preview compatibility
```
