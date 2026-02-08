import { Router } from "express";
import { createSupabaseServer } from "../config.js";

import dotenv from "dotenv";
dotenv.config();

import { generateInvoiceJSONB, getStateCodeFromGSTIN } from "../lib/invoice.js";
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
    const deliveryAddressId = body.delivery_address_id
      ? Number(body.delivery_address_id)
      : null;

    console.log(`[${requestId}] Invoice creation request:`, {
      unitId,
      customerId,
      deliveryAddressId,
      hasCustomerId: !!customerId,
      customerIdType: typeof customerId,
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

    // Fetch customer data with enhanced fields
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("name, gstin, trade_name, loc, pin, type")
      .eq("id", customerId)
      .single();

    console.log(`[${requestId}] Customer query result:`, {
      customerId,
      found: !!customer,
      error: customerError?.message,
      customer: customer
        ? { name: customer.name, gstin: customer.gstin }
        : null,
    });

    if (customerError || !customer) {
      console.error(`[${requestId}] Customer not found:`, {
        customerId,
        error: customerError,
      });
      return res.status(404).json({ error: "Customer not found" });
    }

    // Fetch delivery address if provided
    let deliveryAddress = body.delivery_address;
    let deliveryLoc = null;
    let deliveryPin = null;

    if (deliveryAddressId) {
      const { data: deliveryAddr, error: deliveryError } = await supabase
        .from("delivery_addresses")
        .select("address, loc, pin")
        .eq("id", deliveryAddressId)
        .single();

      if (!deliveryError && deliveryAddr) {
        deliveryAddress = deliveryAddr.address;
        deliveryLoc = deliveryAddr.loc;
        deliveryPin = deliveryAddr.pin;
      }
    }

    // Fetch unit data with enhanced fields
    const { data: unit, error: unitError } = await supabase
      .from("units")
      .select("address, loc, pincode")
      .eq("id", unitId)
      .single();

    if (unitError || !unit) {
      return res.status(404).json({ error: "Unit not found" });
    }

    // Fetch grade data with product description and service flag
    const { data: gradeData, error: gradeError } = await supabase
      .from("grades")
      .select("product_description, is_service")
      .eq("grade", body.grade)
      .maybeSingle();

    const productDesc =
      gradeData?.product_description || `Ready-Mix Concrete – ${body.grade}`;
    const isServc = gradeData?.is_service || "N";

    // Determine if this is an inter-state transaction using GSTIN
    const customerStateCode = getStateCodeFromGSTIN(customer.gstin || "");
    const unitStateCode = customer.gstin.substring(0, 2); // Default to Tamil Nadu (hardcoded for now)
    const isInterState = customerStateCode !== unitStateCode;

    // Generate invoice JSONB
    const invoiceData = generateInvoiceJSONB({
      invoiceNo: invoice_no,
      invoiceDate: new Date(body.invoice_date),
      customerGstin: customer.gstin || "",
      customerName: customer.name,
      customerTradeName: customer.trade_name,
      customerType: customer.type || "B2B",
      billingAddress: body.billing_address,
      customerLoc: customer.loc,
      customerPin: customer.pin,
      customerStateCode: customerStateCode,
      deliveryAddress: deliveryAddress,
      deliveryLoc: deliveryLoc,
      deliveryPin: deliveryPin,
      unitAddress: unit.address,
      unitLoc: unit.loc,
      unitPincode: unit.pincode,
      unitStateCode: unitStateCode,
      grade: body.grade,
      productDesc: productDesc,
      isServc: isServc,
      hsnCode: body.hsn_code,
      quantity: Number(body.quantity),
      rate: Number(body.rate),
      grossAmount: Number(body.gross_amount),
      discount: Number(body.discount || 0),
      taxableAmount: Number(body.taxable_amount),
      cgst: Number(body.cgst),
      sgst: Number(body.sgst),
      igst: Number(body.igst || 0),
      roundOff: Number(body.round_off),
      total: Number(body.total),
      isInterState: isInterState,
      gstPercentage: Number(body.gst_percentage || 18),
    });

    // STEP 1: Generate IRN first before creating invoice (skip for NON BILLING)
    let irnData = null;

    if (body.invoice_type !== "NON BILLING") {
      console.log(
        `[${requestId}] Starting IRN generation for invoice:`,
        invoice_no
      );

      // Step 1: Get access token (with caching)
      let accessToken = getAccessToken();
      
      if (!accessToken) {
        console.log(
          `[${requestId}] Step 1: Authenticating with e-invoice API (no cached token)...`
        );
        const authResponse = await fetch(
          "https://staging.fynamics.co.in/api/authenticate",
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
            errorMessage = errorData.errorMessage || errorData.message || errorMessage;
          } else {
            const textResponse = await authResponse.text();
            errorMessage = textResponse || errorMessage;
          }
          
          console.error(`[${requestId}] Authentication API Error:`, errorMessage);
          return res.status(400).json({
            error: "IRN Generation Failed - Authentication API Error",
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
            error: "IRN Generation Failed - Authentication Error",
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
        console.log(`[${requestId}] Step 2: Enhanced authentication (no cached auth)...`);
        const forceRefresh = shouldForceRefresh();
        
        const enhancedAuthResponse = await fetch(
          "https://staging.fynamics.co.in/api/einvoice/enhanced/authentication",
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
            errorMessage = errorData.ErrorMessage || errorData.Message || errorData.message || errorMessage;
          } else {
            const textResponse = await enhancedAuthResponse.text();
            errorMessage = textResponse || errorMessage;
          }
          
          console.error(`[${requestId}] Enhanced Authentication API Error:`, errorMessage);
          return res.status(400).json({
            error: "IRN Generation Failed - Enhanced Authentication API Error",
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
            error: "IRN Generation Failed - Enhanced Authentication Error",
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
        `[${requestId}] Step 3: Generating IRN for invoice ${invoice_no}...`
      );
      const irnResponse = await fetch(
        "https://staging.fynamics.co.in/api/einvoice/enhanced/generate-irn",
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
          errorMessage = errorData.ErrorMessage || errorData.message || errorMessage;
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

      if (!irnData.Irn) {
        // Log only essential error info, not the full response
        console.error(`[${requestId}] IRN Generation Failed:`, {
          status: irnData.Status,
          errorDetails: irnData.ErrorDetails,
          errorMessage: irnData.ErrorMessage,
          errorCount: irnData.ErrorDetails ? irnData.ErrorDetails.length : 0,
        });

        // Extract detailed error message
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

        return res.status(400).json({
          error: "IRN Generation Failed",
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
    } else {
      console.log(
        `[${requestId}] Skipping IRN generation for NON BILLING invoice:`,
        invoice_no
      );
    }

    // STEP 2: Create invoice (with IRN data if generated)
    const { delivery_address_id, ...invoiceBody } = body;

    const invoiceInsertData = {
      ...invoiceBody,
      unit_id: unitId,
      invoice_no,
      discount: Number(body.discount || 0),
      gst_percentage: Number(body.gst_percentage || 18),
      invoice_data: invoiceData,
      ...(irnData && {
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
    if (body.po_number) {
      console.log(
        `[${requestId}] Updating order delivered_quantity and status:`,
        {
          po_number: body.po_number,
          customer_id: customerId,
          quantity: Number(body.quantity),
        }
      );

      const { data: currentOrder, error: fetchError } = await supabase
        .from("orders")
        .select("delivered_quantity, order_quantity, status")
        .eq("po_number", body.po_number)
        .eq("customer_id", customerId)
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
          .eq("customer_id", customerId);

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
