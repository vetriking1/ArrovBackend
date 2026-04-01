import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
dotenv.config();

import { authenticateWithRetry } from "../lib/authHelper.js";
import { isTokenError, clearAuthTokens } from "../lib/tokenCache.js";

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

    // Retry logic for token errors
    let irnData = null;
    let retryCount = 0;
    const MAX_RETRIES = 1;

    while (retryCount <= MAX_RETRIES) {
      try {
        // Step 1 & 2: Authenticate with retry
        const authResult = await authenticateWithRetry(requestId, MAX_RETRIES - retryCount);
        
        if (!authResult.success) {
          return res.status(400).json({
            error: "IRN Regeneration Failed - " + authResult.error.error,
            details: authResult.error.details,
            apiResponse: authResult.error.apiResponse,
          });
        }

        const { accessToken, authData } = authResult;

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

            // Check if it's a token error and retry
            if (isTokenError(errorData) && retryCount < MAX_RETRIES) {
              console.log(
                `[${requestId}] Token error in IRN generation, clearing auth tokens and retrying (attempt ${retryCount + 1}/${MAX_RETRIES})...`
              );
              clearAuthTokens();
              retryCount++;
              continue;
            }
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

        irnData = await irnResponse.json();
        console.log(
          `[${requestId}] Step 3 - IRN generation response:`,
          irnData.Irn ? "Success" : "Failed"
        );

        // Check if IRN response indicates token error
        if (!irnData.Irn && isTokenError(irnData) && retryCount < MAX_RETRIES) {
          console.log(
            `[${requestId}] Token error in IRN response (ErrorCode: ${irnData.ErrorDetails?.[0]?.ErrorCode}), clearing auth tokens and retrying (attempt ${retryCount + 1}/${MAX_RETRIES})...`
          );
          clearAuthTokens();
          retryCount++;
          continue;
        }

        // Success or non-token error - break the retry loop
        break;
      } catch (error) {
        console.error(
          `[${requestId}] Exception during IRN generation:`,
          error
        );
        if (retryCount < MAX_RETRIES) {
          console.log(`[${requestId}] Retrying after exception (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
          clearAuthTokens();
          retryCount++;
          continue;
        }
        throw error;
      }
    }

    if (!irnData || !irnData.Irn) {
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
