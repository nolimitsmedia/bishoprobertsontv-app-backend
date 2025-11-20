const crypto = require("crypto");

const SECRET =
  process.env.PLAYBACK_TOKEN_SECRET || process.env.JWT_SECRET || "dev-secret";

/** base64url (no padding) */
function b64u(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Create HMAC-SHA256 signature for data string */
function hmac(data) {
  return b64u(crypto.createHmac("sha256", SECRET).update(data).digest());
}

/** Build a signed query for playbackId with expiry seconds from now */
function signHls(playbackId, ttlSec = 3600, userId = null) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec);
  const data = `${playbackId}:${exp}:${userId || "anon"}`;
  const sig = hmac(data);
  return { exp, sig };
}

/** Verify signature for incoming request */
function verifyHls(playbackId, exp, sig, userId = null) {
  if (!exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) return false;
  const data = `${playbackId}:${exp}:${userId || "anon"}`;
  return sig === hmac(data);
}

module.exports = { signHls, verifyHls };
