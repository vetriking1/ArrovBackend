import fs from "node:fs";
import path from "node:path";

const SESSION_FILE = path.resolve(process.cwd(), ".gst-session.json");
const REFRESH_WINDOW_MS = 10 * 60 * 1000; // Refresh if within 10 minutes of expiry

let store = loadFromDisk();

function loadFromDisk() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch (err) {
    console.warn("[gstSessionCache] Failed to load session file:", err.message);
  }
  return {};
}

function saveToDisk() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.error("[gstSessionCache] Failed to persist session file:", err.message);
  }
}

export function setPendingAppKey(gstin, appKey) {
  const existing = store[gstin] || {};
  store[gstin] = {
    ...existing,
    pendingAppKey: appKey,
    pendingCreatedAt: Date.now(),
  };
  saveToDisk();
}

export function getPendingAppKey(gstin) {
  return store[gstin]?.pendingAppKey || null;
}

export function setGstSession(gstin, session) {
  const prev = store[gstin] || {};
  store[gstin] = {
    appKey: session.appKey || prev.pendingAppKey || prev.appKey,
    authToken: session.authToken,
    sek: session.sek,
    decryptedSekBase64: session.decryptedSekBase64,
    username: session.username,
    issuedAt: Date.now(),
    expiresAt: session.expiresAt,
  };
  saveToDisk();
}

export function getGstSession(gstin) {
  const s = store[gstin];
  if (!s || !s.authToken || !s.sek || !s.appKey || !s.decryptedSekBase64) {
    return null;
  }
  return s;
}

export function isSessionExpired(session) {
  if (!session || !session.expiresAt) return true;
  return Date.now() >= session.expiresAt;
}

export function isSessionNearExpiry(session) {
  if (!session || !session.expiresAt) return true;
  return Date.now() >= session.expiresAt - REFRESH_WINDOW_MS;
}

export function clearGstSession(gstin) {
  delete store[gstin];
  saveToDisk();
}
