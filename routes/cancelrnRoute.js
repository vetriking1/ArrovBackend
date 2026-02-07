import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
dotenv.config();

const router = Router();
const supabase = createSupabaseServer();

router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `CAN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    const { invoice_no, irn, cancel_reason_code, cancel_reason } = req.body;

    console.log(`[${requestId}] Cancel IRN Request Started`);
    console.log(`[${requestId}] Invoice No: ${invoice_no}`);
    console.log(`[${requestId}] IRN: ${irn}`);
    console.log(`[${requestId}] Cancel Reason Code: ${cancel_reason_code}`);
    console.log(
      `[${requestId}] Cancel Reason: ${cancel_reason || "Not provided"}`
    );

    if (!invoice_no || !irn || !cancel_reason_code || !cancel_reason) {
      console.log(
        `[${requestId}] Validation Failed: invoice_no, irn, cancel_reason_code, and cancel_reason are required`
      );
      return res.status(400).json({
        status: 0,
        errorMessage:
          "invoice_no, irn, cancel_reason_code, and cancel_reason are required",
      });
    }

    console.log(`[${requestId}] Fetching invoice details for ${invoice_no}...`);
    const { data: invoice } = await supabase
      .from("invoices")
      .select("id, unit_id")
      .eq("invoice_no", invoice_no)
      .single();

    if (!invoice) {
      console.log(`[${requestId}] Invoice not found: ${invoice_no}`);
      return res.status(404).json({
        status: 0,
        errorMessage: "Invoice not found",
      });
    }

    console.log(
      `[${requestId}] Fetching unit details for unit_id: ${invoice.unit_id}...`
    );
    const { data: unit } = await supabase
      .from("units")
      .select("gstin")
      .eq("id", invoice.unit_id)
      .single();

    if (!unit) {
      console.log(
        `[${requestId}] Unit not found for unit_id: ${invoice.unit_id}`
      );
      return res.status(404).json({
        status: 0,
        errorMessage: "Unit not found",
      });
    }

    console.log(`[${requestId}] Step 1: Authenticating with e-invoice API...`);
    const response = await fetch("https://www.fynamics.co.in/api/authenticate", {
      method: "POST",
      headers: {
        accept: "application/json",
        clientId: process.env.EINVOICE_CLIENT_ID,
        clientSecret: process.env.EINVOICE_CLIENT_SECRET,
      },
    });

    const data = await response.json();
    console.log(
      `[${requestId}] Step 1 Response:`,
      JSON.stringify({
        status: data.status,
        hasAccessToken: !!data.data?.accessToken,
      })
    );

    if (data.status === 1) {
      console.log(`[${requestId}] Step 2: Enhanced authentication...`);
      const authResponse = await fetch(
        "https://www.fynamics.co.in/api/einvoice/enhanced/authentication",
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
        console.log(
          `[${requestId}] Step 3: Cancelling IRN ${irn} for invoice ${invoice_no}...`
        );
        const cancelResponse = await fetch(
          "https://www.fynamics.co.in/api/einvoice/enhanced/cancel-irn",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              gstin: process.env.GSTIN,
              user_name: process.env.EINVOICE_USERNAME,
              AuthToken: authData.Data.AuthToken,
              Authorization: `Bearer ${data.data.accessToken}`,
              sek: authData.Data.Sek,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              Irn: irn,
              CnlRsn: cancel_reason_code,
              CnlRem: cancel_reason || "",
            }),
          }
        );

        const cancelData = await cancelResponse.json();
        console.log(
          `[${requestId}] Step 3 Response:`,
          JSON.stringify({
            hasIrn: cancelData.Irn !== null,
            Irn: cancelData.Irn,
            CancelDate: cancelData.CancelDate,
          })
        );

        if (cancelData.Irn !== null) {
          console.log(
            `[${requestId}] Step 4: Recording cancellation in database...`
          );
          const { error: cancelError } = await supabase
            .from("canceled_invoices")
            .insert({
              invoice_no,
              irn,
              cancel_reason_code,
              cancel_reason,
            });

          if (cancelError) {
            console.error(
              `[${requestId}] Error inserting into canceled_invoices:`,
              cancelError
            );
            return res.status(500).json({
              status: 0,
              errorMessage: "Failed to record cancellation",
              details: cancelError,
            });
          }
          console.log(`[${requestId}] Cancellation recorded successfully`);

          console.log(
            `[${requestId}] Step 5: Updating invoice ${invoice_no} status to cancelled...`
          );
          const { error: updateError } = await supabase
            .from("invoices")
            .update({ is_cancelled: true })
            .eq("invoice_no", invoice_no);

          if (updateError) {
            console.error(
              `[${requestId}] Error updating invoice is_cancelled:`,
              updateError
            );
            return res.status(500).json({
              status: 0,
              errorMessage: "Failed to update invoice status",
              details: updateError,
            });
          }
          console.log(
            `[${requestId}] Invoice ${invoice_no} marked as cancelled successfully`
          );

          const duration = Date.now() - startTime;
          console.log(
            `[${requestId}] Cancel IRN Request Completed Successfully in ${duration}ms`
          );
          return res.json(cancelData);
        }

        console.log(`[${requestId}] IRN cancellation failed: Irn is null`);
        return res.json(cancelData);
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
