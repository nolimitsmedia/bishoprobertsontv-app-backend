// server-api/routes/bunnyDirect.js
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const mime = require("mime-types");

const router = express.Router();

const authenticate = require("../middleware/authenticate");

function allowUploadRoles(req, res, next) {
  const role = String(req.user?.role || "user").toLowerCase();
  if (role === "user" || role === "admin" || role === "creator") return next();
  return res.status(403).json({ message: "Forbidden: role not allowed" });
}

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\d]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function safeKind(k) {
  const allowed = new Set(["videos", "resources", "images", "docs", "files"]);
  const v = String(k || "videos").toLowerCase();
  return allowed.has(v) ? v : "files";
}

/**
 * Bunny Storage uses:
 *  PUT https://{storageHost}/{storageZone}/{path/to/file}
 *  Header: AccessKey: <storage_api_key>
 *
 * Since we must NOT expose the AccessKey to the browser,
 * we generate a short-lived "upload ticket" (HMAC) and let the backend
 * proxy JUST the authorization (not the file).
 *
 * Options:
 * 1) Preferred: Use Bunny "Edge Storage signed URL" (if available for your setup)
 * 2) Practical: Create a signed ticket and use a tiny backend "auth header mint" endpoint
 *
 * Here we implement a secure ticket approach:
 * - frontend requests: POST /api/uploads/bunny/direct-init
 * - backend returns: { key, uploadUrl, publicUrl, ticket, expiresAt }
 * - frontend uploads directly to Bunny but calls /direct-auth to exchange ticket for a one-time header
 *
 * This keeps the real AccessKey off the client.
 */

const USE_BUNNY =
  String(process.env.USE_BUNNY_STORAGE || "").toLowerCase() === "true" &&
  !!process.env.BUNNY_STORAGE_ZONE &&
  !!process.env.BUNNY_STORAGE_API_KEY &&
  !!process.env.BUNNY_CDN_BASE_URL;

const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || "";
const BUNNY_STORAGE_HOST =
  process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com";
const BUNNY_CDN_BASE_URL = (process.env.BUNNY_CDN_BASE_URL || "").replace(
  /\/+$/,
  "",
);

// This is a server-only secret used to sign tickets (NOT the Bunny AccessKey)
const DIRECT_UPLOAD_SECRET =
  process.env.DIRECT_UPLOAD_SECRET || process.env.JWT_SECRET || "";

function mustEnv() {
  if (!USE_BUNNY) throw new Error("Bunny storage is not enabled");
  if (!DIRECT_UPLOAD_SECRET)
    throw new Error("DIRECT_UPLOAD_SECRET (or JWT_SECRET) is required");
}

function makeKey({ userId, kind, filename, category }) {
  const ext = path.extname(filename || "").toLowerCase();
  const base = slugify(path.basename(filename || "upload", ext));
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");

  const uid = userId ? `u_${userId}` : "anon";
  const k = safeKind(kind);
  const catSlug = slugify(category || "uncategorized") || "uncategorized";

  // Keep same prefix style you already use (optional)
  const PREFIX = (process.env.WASABI_PREFIX || "app").replace(/^\/+|\/+$/g, "");
  return `${PREFIX}/${k}/${catSlug}/${uid}/${base}-${ts}-${rand}${ext}`;
}

function signTicket(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", DIRECT_UPLOAD_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifyTicket(ticket) {
  const [payload, sig] = String(ticket || "").split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", DIRECT_UPLOAD_SECRET)
    .update(payload)
    .digest("base64url");

  // timing-safe compare
  const ok =
    expected.length === sig.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));

  if (!ok) return null;

  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return obj;
  } catch {
    return null;
  }
}

// Preflight safety
router.options(["/direct-init", "/direct-auth"], (_req, res) =>
  res.sendStatus(204),
);

/**
 * POST /api/uploads/bunny/direct-init
 * body: { filename, kind, category, contentType }
 */
router.post("/direct-init", authenticate, allowUploadRoles, (req, res) => {
  try {
    mustEnv();

    const {
      filename = "upload.bin",
      kind = "videos",
      category = "uncategorized",
      contentType,
    } = req.body || {};

    const key = makeKey({
      userId: req.user?.id || null,
      kind,
      filename,
      category,
    });

    const ct =
      contentType || mime.lookup(filename) || "application/octet-stream";

    const uploadUrl = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_ZONE}/${key}`;
    const publicUrl = `${BUNNY_CDN_BASE_URL}/${key}`;

    // 10 min validity
    const expiresAt = Date.now() + 10 * 60 * 1000;

    const ticket = signTicket({
      key,
      ct,
      expiresAt,
      uid: req.user?.id || null,
    });

    return res.json({
      ok: true,
      key,
      contentType: ct,
      uploadUrl,
      publicUrl,
      ticket,
      expiresAt,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/uploads/bunny/direct-auth
 * body: { ticket }
 * returns: { ok, accessKey }
 *
 * This returns the Bunny AccessKey ONLY if:
 * - ticket is valid
 * - ticket is not expired
 *
 * IMPORTANT: you should add basic rate limiting / abuse protection here.
 */
router.post("/direct-auth", authenticate, allowUploadRoles, (req, res) => {
  try {
    mustEnv();
    const { ticket } = req.body || {};
    const payload = verifyTicket(ticket);
    if (!payload)
      return res.status(401).json({ ok: false, message: "Invalid ticket" });
    if (!payload.expiresAt || Date.now() > payload.expiresAt) {
      return res.status(401).json({ ok: false, message: "Ticket expired" });
    }

    // Optional: require ticket user matches current user
    if (
      payload.uid &&
      req.user?.id &&
      String(payload.uid) !== String(req.user.id)
    ) {
      return res
        .status(403)
        .json({ ok: false, message: "Ticket user mismatch" });
    }

    // Return Bunny AccessKey only at the last second
    return res.json({
      ok: true,
      accessKey: process.env.BUNNY_STORAGE_API_KEY,
      key: payload.key,
      contentType: payload.ct,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
});

module.exports = router;
