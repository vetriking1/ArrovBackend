import { Router } from "express";
import dotenv from "dotenv";
import { authenticateWithRetry } from "../lib/authHelper.js";
import { isTokenError, clearAuthTokens } from "../lib/tokenCache.js";
dotenv.config();

const router = Router();

router.get("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `GET-IRN-DOC-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    console.log(`[${requestId}] Get IRN by Doc Details Request Started`);

    const { doctype, docno, docdt } = req.query;

    if (!doctype || !docno || !docdt) {
      return res.status(400).json({
        error: "Validation Failed",
        details: "doctype, docno, and docdt are required query parameters",
      });
    }

    let retryCount = 0;
    const MAX_RETRIES = 1;

    while (retryCount <= MAX_RETRIES) {
      try {
        const authResult = await authenticateWithRetry(requestId, MAX_RETRIES - retryCount);

        if (!authResult.success) {
          return res.status(400).json({
            error: "Get IRN Failed - " + authResult.error.error,
            details: authResult.error.details,
            apiResponse: authResult.error.apiResponse,
          });
        }

        const { accessToken, authData } = authResult;

        const url = new URL(
          "https://www.fynamics.co.in/api/einvoice/enhanced/get-irn-by-doc"
        );
        url.searchParams.set("doctype", doctype);
        url.searchParams.set("docno", docno);
        url.searchParams.set("docdt", docdt);

        console.log(`[${requestId}] Fetching IRN for doc: ${doctype}/${docno}/${docdt}`);

        const irnResponse = await fetch(url.toString(), {
          method: "GET",
          headers: {
            accept: "application/json",
            gstin: process.env.GSTIN,
            AuthToken: authData.authToken,
            user_name: authData.userName,
            sek: authData.sek,
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!irnResponse.ok) {
          const contentType = irnResponse.headers.get("content-type");
          let errorMessage = `HTTP ${irnResponse.status}: ${irnResponse.statusText}`;

          if (contentType && contentType.includes("application/json")) {
            const errorData = await irnResponse.json();
            errorMessage = errorData.ErrorMessage || errorData.message || errorMessage;

            if (isTokenError(errorData) && retryCount < MAX_RETRIES) {
              console.log(`[${requestId}] Token error, clearing auth tokens and retrying...`);
              clearAuthTokens();
              retryCount++;
              continue;
            }
          } else {
            errorMessage = (await irnResponse.text()) || errorMessage;
          }

          console.error(`[${requestId}] Get IRN by Doc API Error:`, errorMessage);
          return res.status(400).json({
            error: "Get IRN Failed - API Error",
            details: errorMessage,
            apiResponse: {
              status: irnResponse.status,
              statusText: irnResponse.statusText,
              timestamp: new Date().toISOString(),
            },
          });
        }

        const data = await irnResponse.json();

        if (isTokenError(data) && retryCount < MAX_RETRIES) {
          console.log(`[${requestId}] Token error in response, retrying...`);
          clearAuthTokens();
          retryCount++;
          continue;
        }

        const duration = Date.now() - startTime;
        console.log(`[${requestId}] Get IRN by Doc Request Completed in ${duration}ms`);

        return res.json(data);
      } catch (error) {
        console.error(`[${requestId}] Exception during Get IRN by Doc:`, error);
        if (retryCount < MAX_RETRIES) {
          clearAuthTokens();
          retryCount++;
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${duration}ms:`, error);
    return res.status(500).json({
      error: error?.message || "Unknown error",
    });
  }
});

export default router;
