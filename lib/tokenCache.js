// Token cache for e-invoice API authentication
// Access tokens are valid for 360 minutes (6 hours)

const cache = {
  accessToken: null,
  accessTokenExpiry: null,
  authToken: null,
  sek: null,
  userName: null,
  authTokenExpiry: null,
};

const TOKEN_VALIDITY_MS = 360 * 60 * 1000; // 360 minutes
const FORCE_REFRESH_WINDOW_MS = 10 * 60 * 1000; // Last 10 minutes

// Access Token Management
export function getAccessToken() {
  if (cache.accessToken && cache.accessTokenExpiry > Date.now()) {
    return cache.accessToken;
  }
  return null;
}

export function setAccessToken(token) {
  cache.accessToken = token;
  cache.accessTokenExpiry = Date.now() + TOKEN_VALIDITY_MS;
}

export function shouldForceRefresh() {
  if (!cache.accessTokenExpiry) return false;
  const timeRemaining = cache.accessTokenExpiry - Date.now();
  return timeRemaining > 0 && timeRemaining <= FORCE_REFRESH_WINDOW_MS;
}

// Auth Token Management
export function getAuthData() {
  if (
    cache.authToken &&
    cache.authTokenExpiry &&
    cache.authTokenExpiry > Date.now()
  ) {
    return {
      authToken: cache.authToken,
      sek: cache.sek,
      userName: cache.userName,
    };
  }
  return null;
}

export function setAuthData(authToken, sek, userName) {
  cache.authToken = authToken;
  cache.sek = sek;
  cache.userName = userName;
  cache.authTokenExpiry = Date.now() + TOKEN_VALIDITY_MS;
}

// Clear all cached tokens
export function clearTokenCache() {
  cache.accessToken = null;
  cache.accessTokenExpiry = null;
  cache.authToken = null;
  cache.sek = null;
  cache.userName = null;
  cache.authTokenExpiry = null;
}
