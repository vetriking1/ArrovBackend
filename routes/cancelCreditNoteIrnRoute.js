import { Router } from "express";
import { createSupabaseServer } from "../config.js";
import dotenv from "dotenv";
import {
  getAccessToken,
  setAccessToken,
  shouldForceRefresh,
  getAuthData,
  setAuthData,
} from "../lib/tokenCache.js";
dotenv.config();

const router = Router();
const supabase = createSupabaseServer();

router.post("/", async (req, res) => {
  const startTime = Date.now();
  const requestId = `CAN-CN-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  try {
    const { credit_note_no, irn, cancel_reason_code, cancel_reason } = req.body;

    console.log(`[${requestId}] Cancel Credit Note IRN Request Started`);
    console.log(`[${requestId}] Credit Note No: ${credit_note_no}`);
    console.log(`[${requestId}] IRN: ${irn}`);
    console.log(`[${requestId}] Cancel Reason Code: ${cancel_reason_code}`);
    console.log(
      `[${requestId}] Cancel Reason: ${cancel_reason || "Not provided"}`
    );

    if (!credit_note_no || !irn || !cancel_reason_code || !cancel_reason) {
      console.log(
        `[${requestId}] Validation Failed: credit_note_no, irn, cancel_reason_code, and cancel_reason are required`
      );
      return res.status(400).json({
        status: 0,
        errorMessage:
          "credit_note_no, irn, cancel_reason_code, and cancel_reason are required",
      });
    }

    console.log(`[${requestId}] Fetching credit note details for ${credit_note_no}...`);
    const { data: creditNote } = await supabase
      .from("credit_notes")
      .select("id, unit_id")
      .eq("credit_note_no", credit_note_no)
      .single();

    if (!creditNote) {
      console.log(`[${requestId}] Credit note not found: ${credit_note_no}`);
      return res.status(404).json({
        status: 0,
        errorMessage: "Credit note not found",
      });
    }

    console.log(
      `[${requestId}] Fetching unit details for unit_id: ${creditNote.unit_id}...`
    );
    const { data: unit } = await supabase
      .from("units")
      .select("gstin")
      .eq("id", creditNote.unit_id)
      .single();

    if (!unit) {
      console.log(
        `[${requestId}] Unit not found for unit_id: ${creditNote.unit_id}`
      );
      return res.status(404).json({
        status: 0,
        errorMessage: "Unit not found",
      });
    }

    console.log(`[${requestId}] Step 1: Authenticating with e-invoice API...`);

    // Step 1: Get access token (with caching)
    let accessToken = getAccessToken();

    if (!accessToken) {
      console.log(`[${requestId}] No cached access token, fetching new one...`);
      const response = await fetch(
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

      const data = await response.json();
      console.log(
        `[${requestId}] Step 1 Response:`,
        JSON.stringify({
          status: data.status,
          hasAccessToken: !!data.data?.accessToken,
        })
      );

      if (data.status !== 1) {
        console.log(`[${requestId}] Step 1 Failed: Status ${data.status}`);
        return res.json(data);
      }

      accessToken = data.data.accessToken;
      setAccessToken(accessToken);
      console.log(`[${requestId}] Access token cached successfully`);
    } else {
      console.log(`[${requestId}] Using cached access token`);
    }

    // Step 2: Enhanced authentication (with caching)
    let authData = getAuthData();

    if (!authData) {
      console.log(
        `[${requestId}] Step 2: Enhanced authentication (no cached auth)...`
      );
      const forceRefresh = shouldForceRefresh();

      const authResponse = await fetch(
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

      const authResponseData = await authResponse.json();
      console.log(
        `[${requestId}] Step 2 Response:`,
        JSON.stringify({
          Status: authResponseData.Status,
          hasAuthToken: !!authResponseData.Data?.AuthToken,
        })
      );

      if (authResponseData.Status !== 1) {
        console.log(
          `[${requestId}] Step 2 Failed: Status ${authResponseData.Status}`
        );
        return res.json(authResponseData);
      }

      authData = {
        authToken: authResponseData.Data.AuthToken,
        sek: authResponseData.Data.Sek,
        userName: authResponseData.Data.UserName,
      };
      setAuthData(authData.authToken, authData.sek, authData.userName);
      console.log(`[${requestId}] Auth data cached successfully`);
    } else {
      console.log(`[${requestId}] Step 2: Using cached auth data`);
    }

    // Step 3: Cancel IRN
    console.log(
      `[${requestId}] Step 3: Cancelling IRN ${irn} for credit note ${credit_note_no}...`
    );
    const cancelResponse = await fetch(
      "https://www.fynamics.co.in/api/einvoice/enhanced/cancel-irn",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          gstin: process.env.GSTIN,
          user_name: authData.userName,
          AuthToken: authData.authToken,
          Authorization: `Bearer ${accessToken}`,
          sek: authData.sek,
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
        .from("canceled_credit_notes")
        .insert({
          credit_note_no,
          irn,
          cancel_reason_code,
          cancel_reason,
        });

      if (cancelError) {
        console.error(
          `[${requestId}] Error inserting into canceled_credit_notes:`,
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
        `[${requestId}] Step 5: Updating credit note ${credit_note_no} status to cancelled...`
      );
      const { error: updateError } = await supabase
        .from("credit_notes")
        .update({ is_cancelled: true })
        .eq("credit_note_no", credit_note_no);

      if (updateError) {
        console.error(
          `[${requestId}] Error updating credit note is_cancelled:`,
          updateError
        );
        return res.status(500).json({
          status: 0,
          errorMessage: "Failed to update credit note status",
          details: updateError,
        });
      }
      console.log(
        `[${requestId}] Credit note ${credit_note_no} marked as cancelled successfully`
      );

      const duration = Date.now() - startTime;
      console.log(
        `[${requestId}] Cancel Credit Note IRN Request Completed Successfully in ${duration}ms`
      );
      return res.json(cancelData);
    }

    console.log(`[${requestId}] IRN cancellation failed: Irn is null`);
    return res.json(cancelData);
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
