import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
dotenv.config();

import { authenticateWithRetry } from "../lib/authHelper.js";
import { isTokenError, clearAuthTokens } from "../lib/tokenCache.js";

const router = Router();

// The frontend now handles: invoice number generation, JSONB creation, DB insert, order update.
// This route only receives an invoice_id, fetches invoice_data from DB, and generates the IRN.
router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `GEN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    console.log(`[${requestId}] Generate IRN Request Started`);

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
      return res.status(500).json({
        error: "IRN Generation Failed - Configuration Error",
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

    console.log(`[${requestId}] Generating IRN for invoice_id:`, invoice_id);

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
        details: "This invoice already has an IRN.",
        existingIrn: invoice.irn,
      });
    }

    if (!invoice.invoice_data) {
      return res.status(400).json({
        error: "Invalid Invoice",
        details: "invoice_data is missing. Cannot generate IRN.",
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
        const authResult = await authenticateWithRetry(
          requestId,
          MAX_RETRIES - retryCount
        );

        if (!authResult.success) {
          return res.status(400).json({
            error: "IRN Generation Failed - " + authResult.error.error,
            details: authResult.error.details,
            apiResponse: authResult.error.apiResponse,
          });
        }

        const { accessToken, authData } = authResult;

        console.log(
          `[${requestId}] Calling IRN API for invoice ${invoice.invoice_no}...`
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

            if (isTokenError(errorData) && retryCount < MAX_RETRIES) {
              clearAuthTokens();
              retryCount++;
              continue;
            }
          } else {
            errorMessage = (await irnResponse.text()) || errorMessage;
          }

          console.error(`[${requestId}] IRN API Error:`, errorMessage);
          return res.status(400).json({
            error: "IRN Generation Failed - API Error",
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
          `[${requestId}] IRN API response:`,
          irnData.Irn ? "Success" : "Failed"
        );

        if (!irnData.Irn && isTokenError(irnData) && retryCount < MAX_RETRIES) {
          clearAuthTokens();
          retryCount++;
          continue;
        }

        break;
      } catch (err) {
        console.error(`[${requestId}] Exception during IRN generation:`, err);
        if (retryCount < MAX_RETRIES) {
          clearAuthTokens();
          retryCount++;
          continue;
        }
        throw err;
      }
    }

    if (!irnData || !irnData.Irn) {
      console.error(`[${requestId}] IRN Generation Failed:`, irnData);

      let errorDetails = "IRN generation was unsuccessful";
      let errorCode = null;

      if (irnData?.ErrorMessage) {
        errorDetails = irnData.ErrorMessage;
        errorCode = irnData.ErrorCode;
      } else if (Array.isArray(irnData?.ErrorDetails) && irnData.ErrorDetails.length > 0) {
        const msgs = irnData.ErrorDetails.map((err) =>
          typeof err === "string" ? err : err.ErrorMessage || err.message || JSON.stringify(err)
        );
        errorDetails = [...new Set(msgs)].join(", ");
        errorCode = irnData.ErrorDetails[0]?.ErrorCode || null;
      } else if (irnData?.errorMessage) {
        errorDetails = irnData.errorMessage;
      } else if (Array.isArray(irnData?.ValidationErrors) && irnData.ValidationErrors.length > 0) {
        const msgs = irnData.ValidationErrors.map((err) =>
          typeof err === "string" ? err : err.ErrorMessage || err.message || JSON.stringify(err)
        );
        errorDetails = [...new Set(msgs)].join(", ");
      } else if (irnData?.message) {
        errorDetails = irnData.message;
      }

      return res.status(400).json({
        error: "IRN Generation Failed",
        details: errorDetails,
        errorCode,
        apiResponse: {
          status: irnData?.Status,
          errorCode,
          timestamp: new Date().toISOString(),
        },
      });
    }

    console.log(`[${requestId}] IRN generated successfully:`, irnData.Irn);

    // Update invoice record with IRN data
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
      console.error(`[${requestId}] Failed to update invoice with IRN:`, updateError);
      return res.status(500).json({
        error: "Database Update Failed",
        details: updateError.message,
        irnGenerated: irnData.Irn,
        warning: "IRN was generated but failed to save to database",
      });
    }

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] Generate IRN Completed Successfully in ${duration}ms`
    );

    return res.json({
      success: true,
      invoice: updatedInvoice,
      irn: {
        irn: updatedInvoice.irn,
        qrcode: updatedInvoice.qrcode,
        ack_no: updatedInvoice.ack_no,
        status: "GENERATED",
      },
      Irn: updatedInvoice.irn,
      SignedQRCode: updatedInvoice.qrcode,
      AckNo: updatedInvoice.ack_no,
      AckDt: updatedInvoice.ack_dt,
      SignedInvoice: updatedInvoice.signed_invoice,
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
