import express from "express";

const router = express.Router();

/**
 * GET /api/getServerTime
 * Returns server timestamp for time synchronization check
 * 
 * TIMEZONE HANDLING:
 * - Server typically runs in UTC
 * - This endpoint converts UTC to IST (UTC+5:30) for the frontend
 * - Frontend compares IST times to check if client clock is accurate
 * - Invoice dates are stored in database as UTC (ISO format) but generated using IST
 */
router.get("/", (req, res) => {
  try {
    const now = new Date();
    
    // Get UTC time
    const serverTimeUTC = now.toISOString();
    const serverTimestamp = now.getTime();
    
    // Convert to IST (UTC + 5:30)
    const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
    const istTime = new Date(now.getTime() + istOffset);
    const serverTimeIST = istTime.toISOString();
    
    // Get IST timestamp for comparison
    const istTimestamp = istTime.getTime();

    res.status(200).json({
      success: true,
      serverTimeUTC,
      serverTimeIST,
      serverTimestamp, // UTC timestamp
      istTimestamp, // IST timestamp
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: "+05:30",
    });
  } catch (error) {
    console.error("Error getting server time:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get server time",
      message: error.message,
    });
  }
});

export default router;
