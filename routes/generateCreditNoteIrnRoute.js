import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
dotenv.config();

import { generateCreditNoteJSONB, getStateCodeFromGSTIN } from "../lib/invoice.js";
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
  const requestId = `GEN-CN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    console.log(`[${requestId}] Generate Credit Note IRN Request Started`);

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
        error: "Credit Note IRN Generation Failed - Configuration Error",
        details: `Missing environment variables: ${missingEnvVars.join(", ")}`,
      });
    }

    const body = req.body;
    const supabase = createSupabaseServer();

    const unitId = Number(body.unit_id);
    const customerId = Number(body.customer_id);
    const invoiceNo = body.invoice_no;
    const relatedInvoices = body.related_invoices || [];

    console.log(`[${requestId}] Credit note creation request:`, {
      unitId,
      customerId,
      invoiceNo,
      relatedInvoices,
    });

    // Generate credit note number
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "generate_credit_note_number",
      { p_unit_id: unitId }
    );
    if (rpcError) {
      console.error(`[${requestId}] RPC Error:`, rpcError.message);
      return res.status(400).json({ error: rpcError.message });
    }
   
    const credit_note_no = rpcData;


    // Fetch original invoice data
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("invoice_date, invoice_data")
      .eq("invoice_no", invoiceNo)
      .single();

    if (invoiceError || !invoice) {
      console.error(`[${requestId}] Invoice not found:`, {
        invoiceNo,
        error: invoiceError,
      });
      return res.status(404).json({ error: "Original invoice not found" });
    }

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
    const unitStateCode = customer.gstin.substring(0, 2);
    const isInterState = customerStateCode !== unitStateCode;

    // Generate credit note JSONB
    const creditNoteData = generateCreditNoteJSONB({
      creditNoteNo: credit_note_no,
      creditNoteDate: new Date(body.credit_note_date),
      originalInvoiceNo: invoiceNo,
      originalInvoiceDate: new Date(invoice.invoice_date),
      reasonForCreditNote: body.reason_for_credit_note || "Price/Quantity Adjustment",
      poNumber: body.po_number || null,
      customerGstin: customer.gstin || "",
      customerName: customer.name,
      customerTradeName: customer.trade_name,
      customerType: customer.type || "B2B",
      billingAddress: body.billing_address,
      customerLoc: customer.loc,
      customerPin: customer.pin,
      customerStateCode: customerStateCode,
      deliveryAddress: body.delivery_address,
      deliveryLoc: body.delivery_loc,
      deliveryPin: body.delivery_pin,
      unitAddress: unit.address,
      unitLoc: unit.loc,
      unitPincode: unit.pincode,
      unitStateCode: unitStateCode,
      grade: body.grade,
      productDesc: productDesc,
      isServc: isServc,
      hsnCode: body.hsn_code,
      quantity: Number(body.adjusted_quantity),
      rate: Number(body.adjusted_rate),
      grossAmount: Number(body.adjusted_gross_amount),
      discount: Number(body.adjusted_discount || 0),
      taxableAmount: Number(body.adjusted_taxable_amount),
      cgst: Number(body.cgst),
      sgst: Number(body.sgst),
      igst: Number(body.igst || 0),
      roundOff: Number(body.round_off),
      total: Number(body.total),
      isInterState: isInterState,
      gstPercentage: Number(body.gst_percentage || 18),
    });

    // STEP 1: Generate IRN for credit note
    let irnData = null;
    let irnError = null;

    console.log(
      `[${requestId}] Starting IRN generation for credit note:`,
      credit_note_no
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

        console.error(
          `[${requestId}] Authentication API Error:`,
          errorMessage
        );
        return res.status(400).json({
          error: "Credit Note IRN Generation Failed - Authentication API Error",
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
          error: "Credit Note IRN Generation Failed - Authentication Error",
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
          error: "Credit Note IRN Generation Failed - Enhanced Authentication API Error",
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
          error: "Credit Note IRN Generation Failed - Enhanced Authentication Error",
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

    // Step 3: Generate IRN for credit note
    console.log(
      `[${requestId}] Step 3: Generating IRN for credit note ${credit_note_no}...`
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
        body: JSON.stringify(creditNoteData),
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
        error: "Credit Note IRN Generation Failed - API Error",
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
      console.error(`[${requestId}] IRN Generation Failed:`, {
        status: irnData.Status,
        errorDetails: irnData.ErrorDetails,
        errorMessage: irnData.ErrorMessage,
        errorCount: irnData.ErrorDetails ? irnData.ErrorDetails.length : 0,
      });

      console.log(
        `[${requestId}] IRN generation failed, but will continue to save credit note to database`
      );

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

      irnError = {
        error: "Credit Note IRN Generation Failed",
        details: errorDetails,
        errorCode: errorCode,
        apiResponse: {
          status: irnData.Status,
          errorCode: errorCode,
          timestamp: new Date().toISOString(),
        },
      };

      irnData = null;
    } else {
      console.log(`[${requestId}] IRN generated successfully:`, irnData.Irn);
    }

    // STEP 2: Create credit note (with IRN data if generated)
    const creditNoteInsertData = {
      unit_id: unitId,
      credit_note_no,
      credit_note_date: body.credit_note_date,
      invoice_no: invoiceNo,
      original_invoice_date: invoice.invoice_date,
      customer_id: customerId,
      billing_address: body.billing_address,
      delivery_address: body.delivery_address,
      po_number: body.po_number || null,
      grade: body.grade,
      hsn_code: body.hsn_code,
      original_quantity: Number(body.original_quantity),
      original_rate: Number(body.original_rate),
      original_gross_amount: Number(body.original_gross_amount),
      original_taxable_amount: Number(body.original_taxable_amount),
      adjusted_quantity: Number(body.adjusted_quantity),
      adjusted_rate: Number(body.adjusted_rate),
      adjusted_gross_amount: Number(body.adjusted_gross_amount),
      adjusted_discount: Number(body.adjusted_discount || 0),
      adjusted_taxable_amount: Number(body.adjusted_taxable_amount),
      cgst: Number(body.cgst),
      sgst: Number(body.sgst),
      igst: Number(body.igst || 0),
      gst_percentage: Number(body.gst_percentage || 18),
      round_off: Number(body.round_off),
      total: Number(body.total),
      difference_quantity: Number(body.difference_quantity),
      difference_amount: Number(body.difference_amount),
      vehicle_no: body.vehicle_no || null,
      dc_no: body.dc_no || null,
      mode_of_transport: body.mode_of_transport || "Road",
      reason_for_credit_note: body.reason_for_credit_note || "Price/Quantity Adjustment",
      remarks: body.remarks || null,
      credit_note_data: creditNoteData,
      related_invoices: relatedInvoices,
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

    const { data: creditNoteResult, error: creditNoteError } = await supabase
      .from("credit_notes")
      .insert(creditNoteInsertData)
      .select("*")
      .single();

    if (creditNoteError) {
      console.error(
        `[${requestId}] Failed to create credit note:`,
        creditNoteError
      );
      return res.status(500).json({
        error: "Credit note creation failed",
        details: creditNoteError.message,
      });
    }

    console.log(
      `[${requestId}] Credit note created successfully:`,
      irnData ? "with IRN" : "without IRN"
    );

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] Generate Credit Note IRN Request Completed Successfully in ${duration}ms`
    );

    return res.json({
      credit_note: creditNoteResult,
      ...(irnData && {
        irn: {
          irn: creditNoteResult.irn,
          qrcode: creditNoteResult.qrcode,
          ack_no: creditNoteResult.ack_no,
          status: "GENERATED",
        },
      }),
      ...(irnError && {
        irnError: irnError,
        warning: "Credit note saved successfully but IRN generation failed",
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
