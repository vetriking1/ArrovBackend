// Authentication helper for e-invoice API
import {
  getAccessToken,
  setAccessToken,
  shouldForceRefresh,
  getAuthData,
  setAuthData,
  clearAuthTokens,
  clearTokenCache,
  isTokenError,
} from "./tokenCache.js";

/**
 * Get or refresh access token with automatic retry on token errors
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<{success: boolean, accessToken?: string, error?: object}>}
 */
export async function getOrRefreshAccessToken(requestId) {
  let accessToken = getAccessToken();

  if (!accessToken) {
    console.log(
      `[${requestId}] Authenticating with e-invoice API (no cached token)...`
    );
    
    const authResponse = await fetch(
      "https://www.fynamics.co.in/api/authenticate",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          clientId: process.env.EINVOICE_CLIENT_ID,
          clientSecret: process.env.EINVOICE_CLIENT_SECRET,
        },
      }
    );

    if (!authResponse.ok) {
      const contentType = authResponse.headers.get("content-type");
      let errorMessage = `HTTP ${authResponse.status}: ${authResponse.statusText}`;

      if (contentType && contentType.includes("application/json")) {
        const errorData = await authResponse.json();
        errorMessage =
          errorData.errorMessage || errorData.message || errorMessage;
      } else {
        const textResponse = await authResponse.text();
        errorMessage = textResponse || errorMessage;
      }

      console.error(`[${requestId}] Authentication API Error:`, errorMessage);
      return {
        success: false,
        error: {
          error: "Authentication API Error",
          details: errorMessage,
          apiResponse: {
            status: authResponse.status,
            statusText: authResponse.statusText,
            timestamp: new Date().toISOString(),
          },
        },
      };
    }

    const authApiData = await authResponse.json();
    console.log(
      `[${requestId}] Access token response:`,
      authApiData.status
    );

    if (authApiData.status !== 1) {
      console.error(
        `[${requestId}] Authentication Failed:`,
        authApiData.errorMessage || authApiData.message
      );
      return {
        success: false,
        error: {
          error: "Authentication Error",
          details:
            authApiData.errorMessage ||
            authApiData.message ||
            "Failed to get access token",
          apiResponse: {
            status: authApiData.status,
            errorCode: authApiData.errorCode,
            timestamp: new Date().toISOString(),
          },
        },
      };
    }

    accessToken = authApiData.data.accessToken;
    setAccessToken(accessToken);
    console.log(`[${requestId}] Access token cached successfully`);
  } else {
    console.log(`[${requestId}] Using cached access token`);
  }

  return { success: true, accessToken };
}

/**
 * Get or refresh enhanced authentication with automatic retry on token errors
 * @param {string} requestId - Request ID for logging
 * @param {string} accessToken - Access token
 * @returns {Promise<{success: boolean, authData?: object, error?: object, shouldRetry?: boolean}>}
 */
export async function getOrRefreshAuthData(requestId, accessToken) {
  let authData = getAuthData();

  if (!authData) {
    console.log(
      `[${requestId}] Enhanced authentication (no cached auth)...`
    );
    const forceRefresh = shouldForceRefresh();

    const enhancedAuthResponse = await fetch(
      "https://www.fynamics.co.in/api/einvoice/enhanced/authentication",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          gstin: process.env.GSTIN,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          Username: process.env.EINVOICE_USERNAME,
          Password: process.env.EINVOICE_PASSWORD,
          ForceRefreshAccessToken: forceRefresh,
        }),
      }
    );

    if (!enhancedAuthResponse.ok) {
      const contentType = enhancedAuthResponse.headers.get("content-type");
      let errorMessage = `HTTP ${enhancedAuthResponse.status}: ${enhancedAuthResponse.statusText}`;
      let shouldRetry = false;

      if (contentType && contentType.includes("application/json")) {
        const errorData = await enhancedAuthResponse.json();
        errorMessage =
          errorData.ErrorMessage ||
          errorData.Message ||
          errorData.message ||
          errorMessage;

        // Check if it's a token error
        if (isTokenError(errorData)) {
          shouldRetry = true;
        }
      } else {
        const textResponse = await enhancedAuthResponse.text();
        errorMessage = textResponse || errorMessage;
      }

      console.error(
        `[${requestId}] Enhanced Authentication API Error:`,
        errorMessage
      );
      return {
        success: false,
        shouldRetry,
        error: {
          error: "Enhanced Authentication API Error",
          details: errorMessage,
          apiResponse: {
            status: enhancedAuthResponse.status,
            statusText: enhancedAuthResponse.statusText,
            timestamp: new Date().toISOString(),
          },
        },
      };
    }

    const enhancedAuthData = await enhancedAuthResponse.json();
    console.log(
      `[${requestId}] Enhanced auth response:`,
      enhancedAuthData.Status
    );

    if (enhancedAuthData.Status !== 1) {
      const shouldRetry = isTokenError(enhancedAuthData);

      console.error(
        `[${requestId}] Enhanced Authentication Failed:`,
        enhancedAuthData.ErrorMessage || enhancedAuthData.Message
      );
      return {
        success: false,
        shouldRetry,
        error: {
          error: "Enhanced Authentication Error",
          details:
            enhancedAuthData.ErrorMessage ||
            enhancedAuthData.Message ||
            "Enhanced authentication failed",
          apiResponse: {
            status: enhancedAuthData.Status,
            errorCode: enhancedAuthData.ErrorCode,
            timestamp: new Date().toISOString(),
          },
        },
      };
    }

    authData = {
      authToken: enhancedAuthData.Data.AuthToken,
      sek: enhancedAuthData.Data.Sek,
      userName: enhancedAuthData.Data.UserName,
    };
    setAuthData(authData.authToken, authData.sek, authData.userName);
    console.log(`[${requestId}] Auth data cached successfully`);
  } else {
    console.log(`[${requestId}] Using cached auth data`);
  }

  return { success: true, authData };
}

/**
 * Authenticate with e-invoice API with automatic retry on token errors
 * @param {string} requestId - Request ID for logging
 * @param {number} maxRetries - Maximum number of retries (default: 1)
 * @returns {Promise<{success: boolean, accessToken?: string, authData?: object, error?: object}>}
 */
export async function authenticateWithRetry(requestId, maxRetries = 1) {
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      // Step 1: Get access token
      const accessTokenResult = await getOrRefreshAccessToken(requestId);
      if (!accessTokenResult.success) {
        return accessTokenResult;
      }

      const { accessToken } = accessTokenResult;

      // Step 2: Get enhanced authentication
      const authDataResult = await getOrRefreshAuthData(requestId, accessToken);
      if (!authDataResult.success) {
        if (authDataResult.shouldRetry && retryCount < maxRetries) {
          console.log(
            `[${requestId}] Token error detected, clearing cache and retrying (attempt ${retryCount + 1}/${maxRetries})...`
          );
          clearTokenCache();
          retryCount++;
          continue;
        }
        return authDataResult;
      }

      const { authData } = authDataResult;

      return { success: true, accessToken, authData };
    } catch (error) {
      console.error(
        `[${requestId}] Exception during authentication:`,
        error
      );
      if (retryCount < maxRetries) {
        console.log(
          `[${requestId}] Retrying after exception (attempt ${retryCount + 1}/${maxRetries})...`
        );
        clearTokenCache();
        retryCount++;
        continue;
      }
      return {
        success: false,
        error: {
          error: "Authentication Exception",
          details: error.message,
        },
      };
    }
  }

  return {
    success: false,
    error: {
      error: "Authentication Failed",
      details: "Max retries exceeded",
    },
  };
}
