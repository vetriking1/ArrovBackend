import crypto from "node:crypto";

/**
 * Resolves a 32-byte AES-256 key from either a 32-char UTF-8 string
 * (e.g. Fynamics app_key) or a Base64-encoded 32-byte key.
 * @param {string|Buffer} keyInput
 * @returns {Buffer}
 */
export function resolveAes256Key(keyInput) {
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length === 32) return keyInput;
    throw new Error(`Invalid AES-256 key buffer length: ${keyInput.length}`);
  }

  const utf8Buf = Buffer.from(keyInput, "utf8");
  if (utf8Buf.length === 32) return utf8Buf;

  const b64Buf = Buffer.from(keyInput, "base64");
  if (b64Buf.length === 32) return b64Buf;

  throw new Error(
    `Unable to derive 32-byte AES-256 key (utf8=${utf8Buf.length}, base64=${b64Buf.length})`
  );
}

/**
 * Decrypts GSTN/Fynamics encrypted SEK using app_key (AES-256-ECB / PKCS5Padding).
 * @param {string} encryptedSekBase64
 * @param {string} appKey
 * @returns {Buffer} 32-byte decrypted Session Encryption Key (EK)
 */
export function decryptSek(encryptedSekBase64, appKey) {
  const key = resolveAes256Key(appKey);
  const decipher = crypto.createDecipheriv("aes-256-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedSekBase64, "base64")),
    decipher.final(),
  ]);
  return decrypted;
}

/**
 * Decrypts GSTR-2B encrypted `data` string using the decrypted SEK (AES-256-ECB / PKCS5Padding).
 * Handles both direct UTF-8 JSON and Base64-encoded JSON payloads.
 * @param {string} encryptedDataBase64
 * @param {Buffer|string} decryptedSek - 32-byte Buffer or Base64 string
 * @returns {object} Parsed GSTR-2B JSON
 */
export function decryptGstr2bData(encryptedDataBase64, decryptedSek) {
  const key = Buffer.isBuffer(decryptedSek)
    ? decryptedSek
    : Buffer.from(decryptedSek, "base64");

  if (key.length !== 32) {
    throw new Error(`Invalid decrypted SEK length: ${key.length} bytes (expected 32)`);
  }

  const decipher = crypto.createDecipheriv("aes-256-ecb", key, null);
  decipher.setAutoPadding(true);
  const decryptedBuf = Buffer.concat([
    decipher.update(Buffer.from(encryptedDataBase64, "base64")),
    decipher.final(),
  ]);

  const rawText = decryptedBuf.toString("utf8").trim();

  // Direct JSON string
  if (rawText.startsWith("{") || rawText.startsWith("[")) {
    return JSON.parse(rawText);
  }

  // Standard GSTN double-Base64-encoded JSON
  const decodedJson = Buffer.from(rawText, "base64").toString("utf8").trim();
  return JSON.parse(decodedJson);
}
