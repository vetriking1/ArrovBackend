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
    const response = await fetch(
      "https://www.fynamics.co.in/api/authenticate",
      {
        method: "POST", // Using POST as required by the API
        headers: {
          accept: "application/json",
          clientId: process.env.EINVOICE_CLIENT_ID,
          clientSecret: process.env.EINVOICE_CLIENT_SECRET,
        },
        // No body - credentials are passed via headers
      }
    );

    // Check if response is OK before parsing JSON
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[${requestId}] API Error (${response.status}):`,
        errorText
      );
      return res.status(response.status).json({
        status: 0,
        errorMessage: `API Error: ${errorText}`,
      });
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[${requestId}] Non-JSON response:`, text);
      return res.status(500).json({
        status: 0,
        errorMessage: "Invalid response format from e-invoice API",
      });
    }

    const data = await response.json();
    console.log(data);
    console.log(
      `[${requestId}] Step 1 Response:`,
      JSON.stringify({
        status: data.status,
        hasAccessToken: !!data.data?.accessToken,
      })
    );
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
