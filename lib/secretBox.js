// server-api/lib/secretBox.js — encrypt secrets stored in the database
// (AES-256-GCM, key derived from JWT_SECRET; a separate purpose label from the
// live-streaming settings). Secrets are never sent back to the browser.
const crypto = require("crypto");

function key(purpose) {
  return crypto
    .createHash("sha256")
    .update(`${process.env.JWT_SECRET || "brtv"}|${purpose}`)
    .digest();
}

function seal(obj, purpose = "cloud-storage") {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([
    c.update(JSON.stringify(obj || {}), "utf8"),
    c.final(),
  ]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

function open(blob, purpose = "cloud-storage") {
  try {
    const [v, iv, tag, data] = String(blob || "").split(".");
    if (v !== "v1") return {};
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      key(purpose),
      Buffer.from(iv, "base64"),
    );
    d.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(data, "base64")),
        d.final(),
      ]).toString("utf8"),
    );
  } catch {
    return {};
  }
}

// "••••1234" — enough to recognise a saved key without revealing it
function mask(value) {
  const s = String(value || "");
  return s ? `••••${s.slice(-4)}` : "";
}

module.exports = { seal, open, mask };
