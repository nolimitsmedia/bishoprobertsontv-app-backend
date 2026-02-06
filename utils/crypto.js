// server-api/utils/crypto.js
const crypto = require("crypto");

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is missing");

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error("APP_ENCRYPTION_KEY must be 32 bytes base64");
  return key;
}

function encryptJSON(obj) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptJSON(packed) {
  if (!packed) return null;
  const key = getKey();

  const parts = String(packed).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload format");

  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { encryptJSON, decryptJSON };
