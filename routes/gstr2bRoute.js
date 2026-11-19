import { Router } from "express";
import dotenv from "dotenv";
dotenv.config();

import { getOrRefreshAccessToken } from "../lib/authHelper.js";
import { clearTokenCache } from "../lib/tokenCache.js";
import { decryptSek, decryptGstr2bData } from "../lib/gstCrypto.js";
import {
  setPendingAppKey,
  getPendingAppKey,
  setGstSession,
  getGstSession,
  isSessionExpired,
  isSessionNearExpiry,
  clearGstSession,
} from "../lib/gstSessionCache.js";

const router = Router();

const FYNAMICS_BASE = "https://www.fynamics.co.in/api";

function getGstConfig(req) {
  const gstin = process.env.GSTIN;
  const username = process.env.GST_USERNAME;
  const stateCd = process.env.GST_STATE_CD || (gstin ? gstin.slice(0, 2) : "");
  const clientId = process.env.GST_CLIENT_ID || process.env.EINVOICE_CLIENT_ID;
  const clientSecret =
    process.env.GST_CLIENT_SECRET || process.env.EINVOICE_CLIENT_SECRET;
  const ipUsr =
    process.env.GST_IP_USR ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "127.0.0.1";

  const missing = [];
  if (!gstin) missing.push("GSTIN");
  if (!username) missing.push("GST_USERNAME");
  if (!stateCd) missing.push("GST_STATE_CD");
  if (!clientId) missing.push("GST_CLIENT_ID or EINVOICE_CLIENT_ID");
  if (!clientSecret) missing.push("GST_CLIENT_SECRET or EINVOICE_CLIENT_SECRET");

  return { gstin, username, stateCd, ipUsr, clientId, clientSecret, missing };
}

function makeRequestId(prefix = "GSTR2B") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function getBearerToken(requestId, cfg) {
  // If separate GST_CLIENT_ID/SECRET are provided, authenticate directly with them
  if (process.env.GST_CLIENT_ID && process.env.GST_CLIENT_SECRET) {
    const resp = await fetch(`${FYNAMICS_BASE}/authenticate`, {
      method: "POST",
      headers: {
        accept: "application/json",
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.status !== 1 || !data.data?.accessToken) {
      return {
        ok: false,
        error: {
          error: "GST Authentication Failed",
          details: data.errorMessage || data.message || `HTTP ${resp.status}`,
        },
      };
    }
    return { ok: true, accessToken: data.data.accessToken };
  }

  const res = await getOrRefreshAccessToken(requestId);
  if (!res.success) {
    return { ok: false, error: res.error };
  }
  return { ok: true, accessToken: res.accessToken };
}

function isGstAuthFailure(payload) {
  if (!payload || typeof payload !== "object") return false;
  const msg = String(
    payload.error?.message || payload.message || payload.ErrorMessage || ""
  ).toLowerCase();
  const code = String(payload.error?.error_cd || payload.errorCode || "");
  return (
    code === "AUTH4033" ||
    code === "AUTH4034" ||
    msg.includes("invalid token") ||
    msg.includes("expired") ||
    msg.includes("auth_token") ||
    msg.includes("authtoken")
  );
}

async function triggerOtpRequest(requestId, cfg) {
  const tokenRes = await getBearerToken(requestId, cfg);
  if (!tokenRes.ok) {
    return { ok: false, status: 502, error: tokenRes.error };
  }

  console.log(`[${requestId}] Triggering GST OTP request for ${cfg.username}...`);
  const resp = await fetch(`${FYNAMICS_BASE}/gst/requestOTP`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenRes.accessToken}`,
      clientid: cfg.clientId,
      gstin: cfg.gstin,
      "ip-usr": cfg.ipUsr,
      "state-cd": cfg.stateCd,
    },
    body: JSON.stringify({
      action: "OTPREQUEST",
      username: cfg.username,
    }),
  });

  if (resp.status === 401) {
    clearTokenCache();
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.status_cd !== 1 && !data.app_key)) {
    console.error(`[${requestId}] requestOTP failed:`, data);
    return {
      ok: false,
      status: resp.ok ? 400 : resp.status,
      error: {
        error: "GST OTP Request Failed",
        details: data.error?.message || data.message || data.errorMessage || `HTTP ${resp.status}`,
        apiResponse: data,
      },
    };
  }

  setPendingAppKey(cfg.gstin, data.app_key);
  console.log(`[${requestId}] OTP requested; pending app_key cached.`);
  return { ok: true };
}

async function refreshGstSession(requestId, cfg, session) {
  const tokenRes = await getBearerToken(requestId, cfg);
  if (!tokenRes.ok) return { ok: false };

  console.log(`[${requestId}] Lazy-refreshing GST auth_token for ${cfg.username}...`);
  const resp = await fetch(`${FYNAMICS_BASE}/gst/refreshtoken`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenRes.accessToken}`,
      clientid: cfg.clientId,
      gstin: cfg.gstin,
      "ip-usr": cfg.ipUsr,
      "state-cd": cfg.stateCd,
      sek: session.sek,
    },
    body: JSON.stringify({
      action: "REFRESHTOKEN",
      username: cfg.username,
      auth_token: session.authToken,
      app_key: session.appKey,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.status_cd !== 1 || !data.auth_token || !data.sek) {
    console.warn(`[${requestId}] Refresh token failed:`, data);
    return { ok: false };
  }

  const decryptedSek = decryptSek(data.sek, session.appKey);
  const expiryMinutes = Number(data.expiry) > 0 ? Number(data.expiry) : 120;
  const updated = {
    appKey: session.appKey,
    authToken: data.auth_token,
    sek: data.sek,
    decryptedSekBase64: decryptedSek.toString("base64"),
    username: cfg.username,
    expiresAt: Date.now() + expiryMinutes * 60 * 1000,
  };
  setGstSession(cfg.gstin, updated);
  console.log(`[${requestId}] GST session refreshed (expiry: ${expiryMinutes}m).`);
  return { ok: true, session: updated };
}

async function ensureValidGstSession(requestId, cfg) {
  let session = getGstSession(cfg.gstin);

  if (!session || isSessionExpired(session)) {
    clearGstSession(cfg.gstin);
    const otpRes = await triggerOtpRequest(requestId, cfg);
    if (!otpRes.ok) return { ok: false, ...otpRes };
    return { ok: false, otpRequired: true };
  }

  if (isSessionNearExpiry(session)) {
    const refreshed = await refreshGstSession(requestId, cfg, session);
    if (refreshed.ok) {
      return { ok: true, session: refreshed.session };
    }
    clearGstSession(cfg.gstin);
    const otpRes = await triggerOtpRequest(requestId, cfg);
    if (!otpRes.ok) return { ok: false, ...otpRes };
    return { ok: false, otpRequired: true };
  }

  return { ok: true, session };
}

async function fetchAndDecryptGstr2b(requestId, cfg, session, rtnprd, fileNum) {
  const tokenRes = await getBearerToken(requestId, cfg);
  if (!tokenRes.ok) {
    return { ok: false, status: 502, body: tokenRes.error };
  }

  const url = fileNum
    ? `${FYNAMICS_BASE}/gst/returns/gstr2b/${cfg.gstin}/${rtnprd}/${fileNum}`
    : `${FYNAMICS_BASE}/gst/returns/gstr2b/${cfg.gstin}/${rtnprd}`;

  console.log(`[${requestId}] Fetching GSTR-2B: ${url}`);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${tokenRes.accessToken}`,
      clientid: cfg.clientId,
      "ip-usr": cfg.ipUsr,
      "state-cd": cfg.stateCd,
      username: cfg.username,
      authtoken: session.authToken,
      app_key: session.appKey,
      sek: session.sek,
    },
  });

  if (resp.status === 401) {
    clearTokenCache();
  }

  const payload = await resp.json().catch(() => ({}));

  if (!resp.ok || payload.status_cd === 0) {
    if (isGstAuthFailure(payload)) {
      clearGstSession(cfg.gstin);
      const otpRes = await triggerOtpRequest(requestId, cfg);
      if (!otpRes.ok) {
        return { ok: false, status: otpRes.status, body: otpRes.error };
      }
      return {
        ok: false,
        status: 401,
        body: {
          success: false,
          otpRequired: true,
          message: "GST session expired. A new OTP has been sent to the registered mobile/email.",
        },
      };
    }

    return {
      ok: false,
      status: resp.ok ? 400 : resp.status,
      body: {
        success: false,
        error: "GSTR-2B Fetch Failed",
        details: payload.error?.message || payload.message || payload.errorMessage || `HTTP ${resp.status}`,
        apiResponse: payload,
      },
    };
  }

  if (!payload.data) {
    return {
      ok: false,
      status: 502,
      body: {
        success: false,
        error: "GSTR-2B Fetch Failed",
        details: "Missing encrypted data field in Fynamics response",
        apiResponse: payload,
      },
    };
  }

  const decrypted = decryptGstr2bData(payload.data, session.decryptedSekBase64);
  const totalFiles = Number(decrypted?.fc ?? decrypted?.data?.fc ?? 1) || 1;
  const currentFile = fileNum ? Number(fileNum) : 1;

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      status_cd: payload.status_cd,
      chksum: payload.chksum || null,
      pagination: {
        currentFile,
        totalFiles,
        hasNext: currentFile < totalFiles,
        nextFile: currentFile < totalFiles ? currentFile + 1 : null,
      },
      data: decrypted,
    },
  };
}

/**
 * POST /api/gstr2b/auth/request-otp
 * Explicitly triggers an OTP request (optional — GET /:rtnprd also triggers automatically when needed).
 */
router.post("/auth/request-otp", async (req, res) => {
  const requestId = makeRequestId("GSTR2B-OTP");
  const cfg = getGstConfig(req);
  if (cfg.missing.length > 0) {
    return res.status(500).json({
      success: false,
      error: "Configuration Error",
      details: `Missing environment variables: ${cfg.missing.join(", ")}`,
    });
  }

  try {
    const result = await triggerOtpRequest(requestId, cfg);
    if (!result.ok) {
      return res.status(result.status).json(result.error);
    }
    return res.json({
      success: true,
      otpRequired: true,
      message: "OTP sent to registered mobile/email.",
    });
  } catch (err) {
    console.error(`[${requestId}] request-otp error:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/gstr2b/auth/verify-otp
 * Body: { otp, rtnprd?, file_num? }
 * Verifies OTP, caches app_key + auth_token + sek, and optionally fetches GSTR-2B immediately.
 */
router.post("/auth/verify-otp", async (req, res) => {
  const requestId = makeRequestId("GSTR2B-VERIFY");
  const cfg = getGstConfig(req);
  if (cfg.missing.length > 0) {
    return res.status(500).json({
      success: false,
      error: "Configuration Error",
      details: `Missing environment variables: ${cfg.missing.join(", ")}`,
    });
  }

  const { otp, rtnprd, file_num } = req.body || {};
  if (!otp || String(otp).trim().length < 4) {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      details: "otp is required",
    });
  }

  const appKey = getPendingAppKey(cfg.gstin) || getGstSession(cfg.gstin)?.appKey;
  if (!appKey) {
    return res.status(400).json({
      success: false,
      error: "No Pending OTP",
      details: "No pending app_key found. Trigger OTP request first.",
    });
  }

  try {
    const tokenRes = await getBearerToken(requestId, cfg);
    if (!tokenRes.ok) {
      return res.status(502).json(tokenRes.error);
    }

    const resp = await fetch(`${FYNAMICS_BASE}/gst/authtoken`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenRes.accessToken}`,
        clientid: cfg.clientId,
        gstin: cfg.gstin,
        "ip-usr": cfg.ipUsr,
        "state-cd": cfg.stateCd,
        app_key: appKey,
      },
      body: JSON.stringify({
        action: "AUTHTOKEN",
        username: cfg.username,
        otp: String(otp).trim(),
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.status_cd !== 1 || !data.auth_token || !data.sek) {
      console.error(`[${requestId}] authtoken failed:`, data);
      return res.status(resp.ok ? 400 : resp.status).json({
        success: false,
        error: "OTP Verification Failed",
        details: data.error?.message || data.message || data.errorMessage || "Invalid OTP",
        apiResponse: data,
      });
    }

    const decryptedSek = decryptSek(data.sek, appKey);
    const expiryMinutes = Number(data.expiry) > 0 ? Number(data.expiry) : 120;
    const session = {
      appKey,
      authToken: data.auth_token,
      sek: data.sek,
      decryptedSekBase64: decryptedSek.toString("base64"),
      username: cfg.username,
      expiresAt: Date.now() + expiryMinutes * 60 * 1000,
    };
    setGstSession(cfg.gstin, session);
    console.log(`[${requestId}] GST session verified & cached (expiry: ${expiryMinutes}m).`);

    if (rtnprd) {
      if (!/^(0[1-9]|1[0-2])\d{4}$/.test(String(rtnprd))) {
        return res.status(400).json({
          success: false,
          error: "Validation Error",
          details: "rtnprd must be in MMYYYY format (e.g. 102021)",
        });
      }
      const result = await fetchAndDecryptGstr2b(requestId, cfg, session, rtnprd, file_num);
      return res.status(result.status).json(result.body);
    }

    return res.json({
      success: true,
      message: "OTP verified and GST session cached.",
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error(`[${requestId}] verify-otp error:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function handleGetGstr2b(req, res) {
  const requestId = makeRequestId("GSTR2B");
  const cfg = getGstConfig(req);
  if (cfg.missing.length > 0) {
    return res.status(500).json({
      success: false,
      error: "Configuration Error",
      details: `Missing environment variables: ${cfg.missing.join(", ")}`,
    });
  }

  const { rtnprd, file_num } = req.params;
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(rtnprd)) {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      details: "rtnprd must be in MMYYYY format (e.g. 102021)",
    });
  }

  if (file_num !== undefined && !/^[1-9]\d*$/.test(file_num)) {
    return res.status(400).json({
      success: false,
      error: "Validation Error",
      details: "file_num must be a positive integer",
    });
  }

  try {
    const sessionCheck = await ensureValidGstSession(requestId, cfg);
    if (!sessionCheck.ok) {
      if (sessionCheck.otpRequired) {
        return res.status(401).json({
          success: false,
          otpRequired: true,
          message: "OTP sent to registered mobile/email. Submit OTP to /api/gstr2b/auth/verify-otp.",
        });
      }
      return res.status(sessionCheck.status || 502).json(sessionCheck.error);
    }

    const result = await fetchAndDecryptGstr2b(
      requestId,
      cfg,
      sessionCheck.session,
      rtnprd,
      file_num
    );
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`[${requestId}] GSTR-2B route error:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

router.get("/:rtnprd", handleGetGstr2b);
router.get("/:rtnprd/:file_num", handleGetGstr2b);

export default router;
