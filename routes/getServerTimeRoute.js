import express from "express";

const router = express.Router();

/**
 * GET /api/getServerTime
 * Returns server timestamp for time synchronization check
 * 
 * TIMEZONE HANDLING:
 * - Server typically runs in UTC
 * - This endpoint converts UTC to IST using Asia/Kolkata timezone
 * - Frontend compares IST times to check if client clock is accurate
 * - Invoice dates are stored in database as UTC (ISO format) but generated using IST
 */
router.get("/", (req, res) => {
  try {
    const now = new Date();
    
    // Get UTC time
    const serverTimeUTC = now.toISOString();
    const serverTimestamp = now.getTime();
    
    // Convert to IST using Asia/Kolkata timezone
    const istFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    // Get IST formatted parts
    const istParts = istFormatter.formatToParts(now);
    const istDate = {};
    istParts.forEach(part => {
      if (part.type !== 'literal') {
        istDate[part.type] = part.value;
      }
    });
    
    // Construct IST ISO string
    const serverTimeIST = `${istDate.year}-${istDate.month}-${istDate.day}T${istDate.hour}:${istDate.minute}:${istDate.second}.${now.getMilliseconds().toString().padStart(3, '0')}+05:30`;
    
    // Get IST date object for timestamp
    const istDateString = `${istDate.year}-${istDate.month}-${istDate.day}T${istDate.hour}:${istDate.minute}:${istDate.second}`;
    const istTimeObj = new Date(istDateString);
    const istTimestamp = istTimeObj.getTime();

    res.status(200).json({
      success: true,
      serverTimeUTC,
      serverTimeIST,
      serverTimestamp, // UTC timestamp
      istTimestamp, // IST timestamp (for comparison)
      timezone: 'Asia/Kolkata',
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
