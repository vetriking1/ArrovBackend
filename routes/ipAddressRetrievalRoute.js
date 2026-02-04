import { Router } from "express";
import dotenv from "dotenv";
dotenv.config();

const router = Router();

router.post("/", async (req, res) => {
  const requestId = Date.now();
  const startTime = Date.now();
  try {
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
      console.log(`[${requestId}] Step 2: IP Address retrieval endpoint`);
      const authResponse = await fetch(
        "https://staging.fynamics.co.in/gst/ipaddress",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${data.data.accessToken}`,
          },
        }
      );

      const authData = await authResponse.json();
      console.log(
        `[${requestId}] Step 2 Response:`,
        JSON.stringify({
          Status: authData.Status,
        })
      );

      return res.json({
        status: 1,
        data: authData,
      });
    } else {
      return res.status(401).json({
        status: 0,
        errorMessage: "Authentication failed",
      });
    }
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
