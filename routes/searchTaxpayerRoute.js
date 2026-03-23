import { Router } from "express";
import dotenv from "dotenv";
dotenv.config();

import {
  getAccessToken,
  setAccessToken,
  shouldForceRefresh,
  getAuthData,
  setAuthData,
} from "../lib/tokenCache.js";

const router = Router();

router.get("/:gstin", async (req, res) => {
  const startTime = Date.now();
  const requestId = `GST-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;
  const gstin = req.params.gstin;

  try {
    console.log(
      `[${requestId}] Search Taxpayer Request Started for GSTIN: ${gstin}`
    );

    // Validate required environment variables
    const requiredEnvVars = [
      "EINVOICE_CLIENT_ID",
      "EINVOICE_CLIENT_SECRET",
      "EINVOICE_USERNAME",
      "EINVOICE_PASSWORD",
      "GSTIN",
    ];

    const missingEnvVars = requiredEnvVars.filter(
      (envVar) => !process.env[envVar]
    );
    if (missingEnvVars.length > 0) {
      console.log(
        `[${requestId}] Validation Failed: Missing environment variables: ${missingEnvVars.join(
          ", "
        )}`
      );
      return res.status(500).json({
        error: "GST Search Failed - Configuration Error",
        details: `Missing environment variables: ${missingEnvVars.join(", ")}`,
      });
    }

    // Step 1: Get access token (with caching)
    let accessToken = getAccessToken();

    if (!accessToken) {
      console.log(
        `[${requestId}] Step 1: Authenticating with e-invoice API (no cached token)...`
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

      // Check if response is OK and content-type is JSON
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
        return res.status(400).json({
          error: "GST Search Failed - Authentication API Error",
          details: errorMessage,
          apiResponse: {
            status: authResponse.status,
            statusText: authResponse.statusText,
            timestamp: new Date().toISOString(),
          },
        });
      }

      const authApiData = await authResponse.json();
      console.log(
        `[${requestId}] Step 1 - Access token response:`,
        authApiData.status
      );

      if (authApiData.status !== 1) {
        console.error(
          `[${requestId}] Authentication Failed:`,
          authApiData.errorMessage || authApiData.message
        );
        return res.status(400).json({
          error: "GST Search Failed - Authentication Error",
          details:
            authApiData.errorMessage ||
            authApiData.message ||
            "Failed to get access token",
          apiResponse: {
            status: authApiData.status,
            errorCode: authApiData.errorCode,
            timestamp: new Date().toISOString(),
          },
        });
      }

      accessToken = authApiData.data.accessToken;
      setAccessToken(accessToken);
      console.log(`[${requestId}] Access token cached successfully`);
    } else {
      console.log(`[${requestId}] Step 1: Using cached access token`);
    }

    // Step 2: Enhanced authentication (with caching)
    let authData = getAuthData();

    if (!authData) {
      console.log(
        `[${requestId}] Step 2: Enhanced authentication (no cached auth)...`
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

      // Check if response is OK and content-type is JSON
      if (!enhancedAuthResponse.ok) {
        const contentType = enhancedAuthResponse.headers.get("content-type");
        let errorMessage = `HTTP ${enhancedAuthResponse.status}: ${enhancedAuthResponse.statusText}`;

        if (contentType && contentType.includes("application/json")) {
          const errorData = await enhancedAuthResponse.json();
          errorMessage =
            errorData.ErrorMessage ||
            errorData.Message ||
            errorData.message ||
            errorMessage;
        } else {
          const textResponse = await enhancedAuthResponse.text();
          errorMessage = textResponse || errorMessage;
        }

        console.error(
          `[${requestId}] Enhanced Authentication API Error:`,
          errorMessage
        );
        return res.status(400).json({
          error: "GST Search Failed - Enhanced Authentication API Error",
          details: errorMessage,
          apiResponse: {
            status: enhancedAuthResponse.status,
            statusText: enhancedAuthResponse.statusText,
            timestamp: new Date().toISOString(),
          },
        });
      }

      const enhancedAuthData = await enhancedAuthResponse.json();
      console.log(
        `[${requestId}] Step 2 - Enhanced auth response:`,
        enhancedAuthData.Status
      );

      if (enhancedAuthData.Status !== 1) {
        console.error(
          `[${requestId}] Enhanced Authentication Failed:`,
          enhancedAuthData.ErrorMessage || enhancedAuthData.Message
        );
        return res.status(400).json({
          error: "GST Search Failed - Enhanced Authentication Error",
          details:
            enhancedAuthData.ErrorMessage ||
            enhancedAuthData.Message ||
            "Enhanced authentication failed",
          apiResponse: {
            status: enhancedAuthData.Status,
            errorCode: enhancedAuthData.ErrorCode,
            timestamp: new Date().toISOString(),
          },
        });
      }

      authData = {
        authToken: enhancedAuthData.Data.AuthToken,
        sek: enhancedAuthData.Data.Sek,
        userName: enhancedAuthData.Data.UserName,
      };
      setAuthData(authData.authToken, authData.sek, authData.userName);
      console.log(`[${requestId}] Auth data cached successfully`);
    } else {
      console.log(`[${requestId}] Step 2: Using cached auth data`);
    }

    // Step 3: Search taxpayer by GSTIN
    console.log(
      `[${requestId}] Step 3: Searching taxpayer for GSTIN: ${gstin}...`
    );

    const searchTaxpayerResponse = await fetch(
      `https://www.fynamics.co.in/api/gst/search-taxpayer/${gstin}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          gstin: process.env.GSTIN,
          AuthToken: authData.authToken,
          user_name: authData.userName,
          sek: authData.sek,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    // Check if response is OK and content-type is JSON
    if (!searchTaxpayerResponse.ok) {
      const contentType = searchTaxpayerResponse.headers.get("content-type");
      let errorMessage = `HTTP ${searchTaxpayerResponse.status}: ${searchTaxpayerResponse.statusText}`;

      if (contentType && contentType.includes("application/json")) {
        const errorData = await searchTaxpayerResponse.json();
        errorMessage =
          errorData.ErrorMessage || errorData.message || errorMessage;
      } else {
        const textResponse = await searchTaxpayerResponse.text();
        errorMessage = textResponse || errorMessage;
      }

      console.error(`[${requestId}] Search Taxpayer API Error:`, errorMessage);
      return res.status(400).json({
        error: "GST Search Failed - API Error",
        details: errorMessage,
        apiResponse: {
          status: searchTaxpayerResponse.status,
          statusText: searchTaxpayerResponse.statusText,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const taxpayerData = await searchTaxpayerResponse.json();
    console.log(
      `[${requestId}] Step 3 - Search taxpayer response:`,
      taxpayerData ? "Success" : "Failed"
    );

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] Search Taxpayer Request Completed Successfully in ${duration}ms`
    );

    return res.json({
      success: true,
      data: taxpayerData,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${duration}ms:`, error);
    return res.status(500).json({
      error: error?.message || "Unknown error",
    });
  }
});

export default router;
