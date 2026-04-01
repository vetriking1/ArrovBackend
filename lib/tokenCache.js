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
const SAFETY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes safety buffer

// Access Token Management
export function getAccessToken() {
  // Add safety buffer to prevent using tokens that are about to expire
  if (cache.accessToken && cache.accessTokenExpiry > Date.now() + SAFETY_BUFFER_MS) {
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
  // Add safety buffer to prevent using tokens that are about to expire
  if (
    cache.authToken &&
    cache.authTokenExpiry &&
    cache.authTokenExpiry > Date.now() + SAFETY_BUFFER_MS
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

// Clear only auth tokens (keep access token)
export function clearAuthTokens() {
  cache.authToken = null;
  cache.sek = null;
  cache.userName = null;
  cache.authTokenExpiry = null;
}

// Check if error indicates invalid/expired token
export function isTokenError(errorData) {
  if (!errorData) return false;
  
  const errorMessage = (
    errorData.ErrorMessage || 
    errorData.errorMessage || 
    errorData.message || 
    ''
  ).toLowerCase();
  
  const tokenErrorKeywords = [
    'invalid token',
    'token expired',
    'authentication failed',
    'unauthorized',
    'invalid authentication',
    'session expired'
  ];
  
  return tokenErrorKeywords.some(keyword => errorMessage.includes(keyword));
}
