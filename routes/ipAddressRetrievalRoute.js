import { Router } from "express";
import dotenv from "dotenv";
// Specify the path to your desired file
dotenv.config();
const router = Router();

router.get("/", async (req, res) => {
  const requestId = Date.now();
  const startTime = Date.now();
  try {
    console.log(`[${requestId}] Step 1: Authenticating with e-invoice API...`);
    const response = await fetch("https://fynamics.co.in/api/authenticate", {
      method: "POST",
      headers: {
        accept: "application/json",
        clientId: process.env.EINVOICE_CLIENT_ID,
        clientSecret: process.env.EINVOICE_CLIENT_SECRET,
      },
    });

    const data = await response.json();
    console.log(data);
    console.log(
      `[${requestId}] Step 1 Response:`,
      JSON.stringify({
        status: data.status,
        hasAccessToken: !!data.data?.accessToken,
      }),
    );
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
