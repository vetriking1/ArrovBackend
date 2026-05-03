import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
dotenv.config();

import { authenticateWithRetry } from "../lib/authHelper.js";
import { isTokenError, clearAuthTokens } from "../lib/tokenCache.js";

const router = Router();

router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `GEN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    console.log(`[${requestId}] Generate IRN Request Started`);

    // Validate required environment variables for IRN generation
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
        error: "IRN Generation Failed - Configuration Error",
        details: `Missing environment variables: ${missingEnvVars.join(", ")}`,
      });
    }

    const body = req.body;
    const supabase = createSupabaseServer();

    const unitId = Number(body.unit_id);
    const customerId = Number(body.customer_id);

    // Validate that invoice_data was provided by the frontend
    if (!body.invoice_data) {
      return res.status(400).json({
        error: "Validation Error",
        details: "invoice_data is required — must be generated on the frontend",
      });
    }

    console.log(`[${requestId}] Invoice creation request:`, {
      unitId,
      customerId,
      hasInvoiceData: true,
    });

    // Generate invoice number
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "generate_invoice_number",
      { p_unit_id: unitId }
    );
    if (rpcError) {
      console.error(`[${requestId}] RPC Error:`, rpcError.message);
      return res.status(400).json({ error: rpcError.message });
    }
    const invoice_no = rpcData;

    // Patch the invoice number into the frontend-provided invoice_data
    // Frontend sends "PENDING" as placeholder; we replace it with the real invoice number
    const invoiceData = {
      ...body.invoice_data,
      DocDtls: {
        ...body.invoice_data.DocDtls,
        No: invoice_no,
      },
    };

    console.log(`[${requestId}] Invoice number generated:`, invoice_no);

    // Fetch grade ID for order update (only field still needed from DB)
    let gradeId = null;
    if (body.po_number && body.grade) {
      const { data: gradeRows } = await supabase
        .from("grades")
        .select("id, customer_id")
        .eq("grade", body.grade)
        .or(`customer_id.eq.${customerId},customer_id.is.null`);

      const gradeData =
        gradeRows?.find((g) => g.customer_id === customerId) ||
        gradeRows?.find((g) => g.customer_id === null) ||
        null;

      gradeId = gradeData?.id || null;
    }

    // STEP 1: Generate IRN first before creating invoice (skip for NON BILLING)
    let irnData = null;
    let irnError = null;

    if (body.invoice_type !== "NON BILLING") {
      console.log(
        `[${requestId}] Starting IRN generation for invoice:`,
        invoice_no
      );

      // Retry logic for token errors
      let retryCount = 0;
      const MAX_RETRIES = 1;

      while (retryCount <= MAX_RETRIES) {
        try {
          // Step 1 & 2: Authenticate with retry
          const authResult = await authenticateWithRetry(requestId, MAX_RETRIES - retryCount);

          if (!authResult.success) {
            return res.status(400).json({
              error: "IRN Generation Failed - " + authResult.error.error,
              details: authResult.error.details,
              apiResponse: authResult.error.apiResponse,
            });
          }

          const { accessToken, authData } = authResult;

          // Step 3: Generate IRN using the frontend-built (and invoice-number-patched) invoice data
          console.log(
            `[${requestId}] Step 3: Generating IRN for invoice ${invoice_no}...`
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

          // Check if response is OK and content-type is JSON
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
                  `[${requestId}] Token error in IRN generation, clearing auth tokens and retrying...`
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
            `[${requestId}] Step 3 - IRN generation response:`,
            irnData.Irn ? "Success" : "Failed"
          );

          // Check if IRN response indicates token error
          if (!irnData.Irn && isTokenError(irnData) && retryCount < MAX_RETRIES) {
            console.log(
              `[${requestId}] Token error in IRN response, clearing auth tokens and retrying...`
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
            console.log(`[${requestId}] Retrying after exception...`);
            clearAuthTokens();
            retryCount++;
            continue;
          }
          throw error;
        }
      }

      if (!irnData.Irn) {
        // Log full error response
        console.error(`[${requestId}] IRN Generation Failed:`, irnData);

        console.log(
          `[${requestId}] IRN generation failed, but will continue to save invoice to database`
        );

        // Extract detailed error message for response
        let errorDetails = "IRN generation was unsuccessful";
        let errorCode = null;

        // First check if ErrorMessage exists at root level
        if (irnData.ErrorMessage) {
          errorDetails = irnData.ErrorMessage;
          errorCode = irnData.ErrorCode;
        }
        // Then check ErrorDetails array (most common case)
        else if (
          irnData.ErrorDetails &&
          Array.isArray(irnData.ErrorDetails) &&
          irnData.ErrorDetails.length > 0
        ) {
          // Extract and deduplicate error messages
          const errorMessages = irnData.ErrorDetails.map((err) => {
            if (typeof err === "string") return err;
            if (err.ErrorMessage) return err.ErrorMessage;
            if (err.message) return err.message;
            return JSON.stringify(err);
          });

          // Remove duplicates using Set
          const uniqueErrors = [...new Set(errorMessages)];
          errorDetails = uniqueErrors.join(", ");

          // Get error code from first error
          const firstError = irnData.ErrorDetails[0];
          if (firstError && firstError.ErrorCode) {
            errorCode = firstError.ErrorCode;
          }
        }
        // Check other possible error message fields
        else if (irnData.errorMessage) {
          errorDetails = irnData.errorMessage;
        } else if (
          irnData.ValidationErrors &&
          Array.isArray(irnData.ValidationErrors)
        ) {
          // Extract and deduplicate validation errors
          const validationMessages = irnData.ValidationErrors.map((err) => {
            if (typeof err === "string") return err;
            if (err.ErrorMessage) return err.ErrorMessage;
            if (err.message) return err.message;
            return JSON.stringify(err);
          });

          // Remove duplicates using Set
          const uniqueValidationErrors = [...new Set(validationMessages)];
          errorDetails = uniqueValidationErrors.join(", ");
        } else if (irnData.message) {
          errorDetails = irnData.message;
        }

        // Store error for response
        irnError = {
          error: "IRN Generation Failed",
          details: errorDetails,
          errorCode: errorCode,
          apiResponse: {
            status: irnData.Status,
            errorCode: errorCode,
            timestamp: new Date().toISOString(),
          },
        };

        // Set irnData to null so invoice is saved without IRN
        irnData = null;
      } else {
        console.log(`[${requestId}] IRN generated successfully:`, irnData.Irn);
      }
    } else {
      console.log(
        `[${requestId}] Skipping IRN generation for NON BILLING invoice:`,
        invoice_no
      );
    }

    // STEP 2: Create invoice (with IRN data if generated)
    // Strip address IDs and invoice_data from body — we handle them explicitly
    const { delivery_address_id, billing_address_id, invoice_data: _invoiceDataFromBody, ...invoiceBody } = body;

    const invoiceInsertData = {
      ...invoiceBody,
      unit_id: unitId,
      invoice_no,
      billing_address: body.billing_address,
      discount: Number(body.discount || 0),
      gst_percentage: Number(body.gst_percentage || 18),
      invoice_data: invoiceData, // Use the patched invoice data (with real invoice number)
      ...(irnData &&
        irnData.Irn && {
          irn: irnData.Irn,
          qrcode: irnData.SignedQRCode,
          ack_no: irnData.AckNo,
          ack_dt: irnData.AckDt ? new Date(irnData.AckDt) : null,
          signed_invoice: irnData.SignedInvoice,
          einvoice_status: "GENERATED",
        }),
    };

    const { data: invoiceResult, error: invoiceError } = await supabase
      .from("invoices")
      .insert(invoiceInsertData)
      .select("*")
      .single();

    if (invoiceError) {
      console.error(`[${requestId}] Failed to create invoice:`, invoiceError);
      return res.status(500).json({
        error: "Invoice creation failed",
        details: invoiceError.message,
      });
    }

    console.log(
      `[${requestId}] Invoice created successfully:`,
      irnData ? "with IRN" : "without IRN (NON BILLING)"
    );

    // Update order delivered_quantity and status if PO number is provided
    if (body.po_number && gradeId) {
      console.log(
        `[${requestId}] Updating order delivered_quantity and status:`,
        {
          po_number: body.po_number,
          customer_id: customerId,
          grade_id: gradeId,
          quantity: Number(body.quantity),
        }
      );

      const { data: currentOrder, error: fetchError } = await supabase
        .from("orders")
        .select("delivered_quantity, order_quantity, status")
        .eq("po_number", body.po_number)
        .eq("customer_id", customerId)
        .eq("grade_id", gradeId)
        .single();

      if (!fetchError && currentOrder) {
        const newDeliveredQty =
          (currentOrder.delivered_quantity || 0) + Number(body.quantity);

        let newStatus = currentOrder.status;
        if (currentOrder.status === "pending") {
          newStatus = "in_progress";
        }
        if (newDeliveredQty >= currentOrder.order_quantity) {
          newStatus = "delivered";
        }

        const { error: orderUpdateError } = await supabase
          .from("orders")
          .update({
            delivered_quantity: newDeliveredQty,
            status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("po_number", body.po_number)
          .eq("customer_id", customerId)
          .eq("grade_id", gradeId);

        if (orderUpdateError) {
          console.error(
            `[${requestId}] Failed to update order:`,
            orderUpdateError
          );
        } else {
          console.log(`[${requestId}] Order updated successfully:`, {
            po_number: body.po_number,
            old_qty: currentOrder.delivered_quantity,
            added_qty: Number(body.quantity),
            new_qty: newDeliveredQty,
            old_status: currentOrder.status,
            new_status: newStatus,
          });
        }
      } else if (fetchError) {
        console.error(
          `[${requestId}] Failed to fetch order for update:`,
          fetchError
        );
      }
    } else if (body.po_number && !gradeId) {
      console.warn(
        `[${requestId}] Skipping order update: gradeId not found for grade "${body.grade}" and customer ${customerId}`
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] Generate IRN Request Completed Successfully in ${duration}ms`
    );

    return res.json({
      invoice: invoiceResult,
      ...(irnData && {
        irn: {
          irn: invoiceResult.irn,
          qrcode: invoiceResult.qrcode,
          ack_no: invoiceResult.ack_no,
          status: "GENERATED",
        },
      }),
      ...(irnError && {
        irnError: irnError,
        warning: "Invoice saved successfully but IRN generation failed",
      }),
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
