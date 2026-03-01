import { Router } from "express";
import { createSupabaseServer } from "../config.js";
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

router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `REGEN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    console.log(`[${requestId}] Regenerate IRN Request Started`);

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
        error: "IRN Regeneration Failed - Configuration Error",
        details: `Missing environment variables: ${missingEnvVars.join(", ")}`,
      });
    }

    const { invoice_id } = req.body;

    if (!invoice_id) {
      return res.status(400).json({
        error: "Validation Error",
        details: "invoice_id is required",
      });
    }

    console.log(`[${requestId}] Regenerating IRN for invoice_id:`, invoice_id);

    const supabase = createSupabaseServer();

    // Fetch invoice from database
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoice_id)
      .single();

    if (invoiceError || !invoice) {
      console.error(`[${requestId}] Invoice not found:`, invoiceError);
      return res.status(404).json({
        error: "Invoice not found",
        details: invoiceError?.message || "No invoice with this ID",
      });
    }

    // Check if invoice already has IRN
    if (invoice.irn) {
      console.log(`[${requestId}] Invoice already has IRN:`, invoice.irn);
      return res.status(400).json({
        error: "IRN Already Exists",
        details:
          "This invoice already has an IRN. Use cancel IRN first if you need to regenerate.",
        existingIrn: invoice.irn,
      });
    }

    // Check if invoice_data exists
    if (!invoice.invoice_data) {
      console.error(`[${requestId}] Invoice data not found in database`);
      return res.status(400).json({
        error: "Invalid Invoice",
        details: "Invoice data is missing. Cannot regenerate IRN.",
      });
    }

    const invoiceData = invoice.invoice_data;

    console.log(
      `[${requestId}] Starting IRN generation for invoice:`,
      invoice.invoice_no
    );

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
          error: "IRN Regeneration Failed - Authentication API Error",
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
          error: "IRN Regeneration Failed - Authentication Error",
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
          error: "IRN Regeneration Failed - Enhanced Authentication API Error",
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
          error: "IRN Regeneration Failed - Enhanced Authentication Error",
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

    // Step 3: Generate IRN
    console.log(
      `[${requestId}] Step 3: Generating IRN for invoice ${invoice.invoice_no}...`
    );
    const irnResponse = await fetch(
      "https://www.fynamics.co.in/api/einvoice/enhanced/generate-irn",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          gstin: process.env.GSTIN,
          AuthToken: authData.authToken,
          user_name: authData.userName,
          sek: authData.sek,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invoiceData),
      }
    );

    if (!irnResponse.ok) {
      const contentType = irnResponse.headers.get("content-type");
      let errorMessage = `HTTP ${irnResponse.status}: ${irnResponse.statusText}`;

      if (contentType && contentType.includes("application/json")) {
        const errorData = await irnResponse.json();
        errorMessage =
          errorData.ErrorMessage || errorData.message || errorMessage;
      } else {
        const textResponse = await irnResponse.text();
        errorMessage = textResponse || errorMessage;
      }

      console.error(`[${requestId}] IRN API Error:`, errorMessage);
      return res.status(400).json({
        error: "IRN Regeneration Failed - API Error",
        details: errorMessage,
        apiResponse: {
          status: irnResponse.status,
          statusText: irnResponse.statusText,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const irnData = await irnResponse.json();
    console.log(
      `[${requestId}] Step 3 - IRN generation response:`,
      irnData.Irn ? "Success" : "Failed"
    );

    if (!irnData.Irn) {
      console.error(`[${requestId}] IRN Generation Failed:`, {
        status: irnData.Status,
        errorDetails: irnData.ErrorDetails,
        errorMessage: irnData.ErrorMessage,
      });

      // Extract detailed error message
      let errorDetails = "IRN generation was unsuccessful";
      let errorCode = null;

      if (irnData.ErrorMessage) {
        errorDetails = irnData.ErrorMessage;
        errorCode = irnData.ErrorCode;
      } else if (
        irnData.ErrorDetails &&
        Array.isArray(irnData.ErrorDetails) &&
        irnData.ErrorDetails.length > 0
      ) {
        const errorMessages = irnData.ErrorDetails.map((err) => {
          if (typeof err === "string") return err;
          if (err.ErrorMessage) return err.ErrorMessage;
          if (err.message) return err.message;
          return JSON.stringify(err);
        });

        const uniqueErrors = [...new Set(errorMessages)];
        errorDetails = uniqueErrors.join(", ");

        const firstError = irnData.ErrorDetails[0];
        if (firstError && firstError.ErrorCode) {
          errorCode = firstError.ErrorCode;
        }
      } else if (irnData.errorMessage) {
        errorDetails = irnData.errorMessage;
      } else if (
        irnData.ValidationErrors &&
        Array.isArray(irnData.ValidationErrors)
      ) {
        const validationMessages = irnData.ValidationErrors.map((err) => {
          if (typeof err === "string") return err;
          if (err.ErrorMessage) return err.ErrorMessage;
          if (err.message) return err.message;
          return JSON.stringify(err);
        });

        const uniqueValidationErrors = [...new Set(validationMessages)];
        errorDetails = uniqueValidationErrors.join(", ");
      } else if (irnData.message) {
        errorDetails = irnData.message;
      }

      return res.status(400).json({
        error: "IRN Regeneration Failed",
        details: errorDetails,
        errorCode: errorCode,
        apiResponse: {
          status: irnData.Status,
          errorCode: errorCode,
          timestamp: new Date().toISOString(),
        },
      });
    }

    console.log(`[${requestId}] IRN generated successfully:`, irnData.Irn);

    // Update invoice with IRN data
    const { data: updatedInvoice, error: updateError } = await supabase
      .from("invoices")
      .update({
        irn: irnData.Irn,
        qrcode: irnData.SignedQRCode,
        ack_no: irnData.AckNo,
        ack_dt: irnData.AckDt ? new Date(irnData.AckDt) : null,
        signed_invoice: irnData.SignedInvoice,
        einvoice_status: "GENERATED",
      })
      .eq("id", invoice_id)
      .select("*")
      .single();

    if (updateError) {
      console.error(`[${requestId}] Failed to update invoice:`, updateError);
      return res.status(500).json({
        error: "Database Update Failed",
        details: updateError.message,
        irnGenerated: irnData.Irn,
        warning: "IRN was generated but failed to save to database",
      });
    }

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] IRN Regeneration Completed Successfully in ${duration}ms`
    );

    return res.json({
      success: true,
      message: "IRN regenerated successfully",
      invoice: updatedInvoice,
      Irn: updatedInvoice.irn,
      SignedQRCode: updatedInvoice.qrcode,
      AckNo: updatedInvoice.ack_no,
      AckDt: updatedInvoice.ack_dt,
      SignedInvoice: updatedInvoice.signed_invoice,
      irn: {
        irn: updatedInvoice.irn,
        qrcode: updatedInvoice.qrcode,
        ack_no: updatedInvoice.ack_no,
        status: "GENERATED",
      },
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
