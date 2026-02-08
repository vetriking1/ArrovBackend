// Token cache for e-invoice API authentication
// Tokens are valid for 360 minutes (6 hours)

const tokenCache = {
  accessToken: null,
  expiresAt: null,
  authToken: null,
  sek: null,
  userName: null,
  authExpiresAt: null,
};

const TOKEN_VALIDITY_MS = 60 * 60 * 1000; // 360 minutes in milliseconds
const FORCE_REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // Last 10 minutes before expiry

export function getAccessToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  return null;
}

export function setAccessToken(token) {
  tokenCache.accessToken = token;
  tokenCache.expiresAt = Date.now() + TOKEN_VALIDITY_MS;
}

export function shouldForceRefresh() {
  if (!tokenCache.expiresAt) return false;
  const timeUntilExpiry = tokenCache.expiresAt - Date.now();
  return timeUntilExpiry > 0 && timeUntilExpiry <= FORCE_REFRESH_THRESHOLD_MS;
}

export function getAuthData() {
  if (
    tokenCache.authToken &&
    tokenCache.authExpiresAt &&
    tokenCache.authExpiresAt > Date.now()
  ) {
    return {
      authToken: tokenCache.authToken,
      sek: tokenCache.sek,
      userName: tokenCache.userName,
    };
  }
  return null;
}

export function setAuthData(authToken, sek, userName) {
  tokenCache.authToken = authToken;
  tokenCache.sek = sek;
  tokenCache.userName = userName;
  tokenCache.authExpiresAt = Date.now() + TOKEN_VALIDITY_MS;
}

export function clearCache() {
  tokenCache.accessToken = null;
  tokenCache.expiresAt = null;
  tokenCache.authToken = null;
  tokenCache.sek = null;
  tokenCache.userName = null;
  tokenCache.authExpiresAt = null;
}
