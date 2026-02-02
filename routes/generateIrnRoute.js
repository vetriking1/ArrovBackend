import { Router } from "express";
import { createSupabaseServer } from "../config.js";

import dotenv from "dotenv";
dotenv.config();

const router = Router();
const supabase = createSupabaseServer();

router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `GEN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    // Get invoice data and invoice_no from request body
    const { invoiceData, invoice_no } = req.body;

    console.log(`[${requestId}] Generate IRN Request Started`);
    console.log(`[${requestId}] Invoice No: ${invoice_no}`);
    console.log(
      `[${requestId}] Request Body:`,
      JSON.stringify({ invoice_no, hasInvoiceData: !!invoiceData })
    );

    if (!invoice_no) {
      console.log(`[${requestId}] Validation Failed: invoice_no is required`);
      return res.status(400).json({
        status: 0,
        errorMessage: "invoice_no is required",
      });
    }

    // Step 1: Get access token
    console.log(`[${requestId}] Step 1: Authenticating with e-invoice API...`);
    const response = await fetch(
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

    const data = await response.json();
    console.log(
      `[${requestId}] Step 1 Response:`,
      JSON.stringify({
        status: data.status,
        hasAccessToken: !!data.data?.accessToken,
      })
    );

    if (data.status === 1) {
      // Step 2: Enhanced authentication
      console.log(`[${requestId}] Step 2: Enhanced authentication...`);
      const authResponse = await fetch(
        "https://staging.fynamics.co.in/api/einvoice/enhanced/authentication",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            gstin: process.env.GSTIN,
            Authorization: `Bearer ${data.data.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            Username: process.env.EINVOICE_USERNAME,
            Password: process.env.EINVOICE_PASSWORD,
            ForceRefreshAccessToken: false,
          }),
        }
      );

      const authData = await authResponse.json();
      console.log(
        `[${requestId}] Step 2 Response:`,
        JSON.stringify({
          Status: authData.Status,
          hasAuthToken: !!authData.Data?.AuthToken,
        })
      );

      if (authData.Status === 1) {
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
              AuthToken: authData.Data.AuthToken,
              user_name: authData.Data.UserName,
              sek: authData.Data.Sek,
              Authorization: `Bearer ${data.data.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(invoiceData),
          }
        );

        const irnData = await irnResponse.json();
        console.log(
          `[${requestId}] Step 3 Response:`,
          JSON.stringify({
            hasIrn: !!irnData.Irn,
            Irn: irnData.Irn,
            AckNo: irnData.AckNo,
            hasSignedQRCode: !!irnData.SignedQRCode,
          })
        );

        // Step 4: Update invoice in database with IRN response
        if (irnData.Irn) {
          console.log(
            `[${requestId}] Step 4: Updating invoice ${invoice_no} with IRN data...`
          );
          const { error: updateError } = await supabase
            .from("invoices")
            .update({
              irn: irnData.Irn,
              qrcode: irnData.SignedQRCode,
              ack_no: irnData.AckNo,
            })
            .eq("invoice_no", invoice_no);

          if (updateError) {
            console.error(
              `[${requestId}] Error updating invoice with IRN:`,
              updateError
            );
            return res.status(500).json({
              status: 0,
              errorMessage: "Failed to update invoice with IRN data",
              details: updateError,
            });
          }
          console.log(
            `[${requestId}] Invoice ${invoice_no} updated successfully with IRN: ${irnData.Irn}`
          );
        }

        const duration = Date.now() - startTime;
        console.log(
          `[${requestId}] Generate IRN Request Completed Successfully in ${duration}ms`
        );
        return res.json(irnData);
      }

      console.log(`[${requestId}] Step 2 Failed: Status ${authData.Status}`);
      return res.json(authData);
    }

    console.log(`[${requestId}] Step 1 Failed: Status ${data.status}`);
    return res.json(data);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${duration}ms:`, error);
    return res.status(500).json({
      status: 0,
      errorMessage: "Internal server error",
    });
  }
});

export default router;
