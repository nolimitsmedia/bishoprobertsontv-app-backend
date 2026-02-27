const express = require("express");
const router = express.Router();
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const https = require("https");

const authenticateAdmin = require("../middleware/authenticateAdmin"); // your admin middleware

// In-memory upload (NO DISK)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function extFromMimetype(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("gif")) return ".gif";
  return ".jpg";
}

function httpsPutBuffer(url, { headers = {}, buffer }) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const opts = {
        method: "PUT",
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        headers: {
          "Content-Length": buffer?.length || 0,
          ...headers,
        },
      };

      const req = https.request(opts, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            body,
          });
        });
      });

      req.on("error", reject);
      req.write(buffer);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function safeBaseName(originalName) {
  const base = (originalName ? path.parse(originalName).name : "image")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || "image";
}

function makeFileName(originalName, mime) {
  const id = crypto.randomBytes(8).toString("hex");
  const ext = path.extname(originalName || "") || extFromMimetype(mime);
  return `${safeBaseName(originalName)}-${Date.now()}-${id}${ext.toLowerCase()}`;
}

function cleanBaseUrl(u = "") {
  const s = String(u || "")
    .trim()
    .replace(/\s+/g, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  return `https://${s}`.replace(/\/+$/, "");
}

function joinUrl(base, ...parts) {
  const b = cleanBaseUrl(base);
  const clean = (p) => String(p || "").replace(/^\/+|\/+$/g, "");
  const tail = parts.map(clean).filter(Boolean).join("/");
  return tail ? `${b}/${tail}` : b;
}

async function bunnyPut({ folder, filename, buffer, contentType }) {
  const zone = mustEnv("BUNNY_STORAGE_ZONE");
  const key = mustEnv("BUNNY_STORAGE_API_KEY");
  const host = mustEnv("BUNNY_STORAGE_HOST").replace(/^https?:\/\//i, "");
  const cdnBaseRaw =
    process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_CDN_BASE || "";
  const cdnBase = cleanBaseUrl(cdnBaseRaw);
  if (!cdnBase)
    throw new Error("Missing env: BUNNY_CDN_BASE_URL (or BUNNY_CDN_BASE)");

  const remotePath = `${zone}/${folder}/${filename}`.replace(/\/+/g, "/");
  const putUrl = `https://${host}/${remotePath}`;

  const r = await fetch(putUrl, {
    method: "PUT",
    headers: {
      AccessKey: key,
      "Content-Type": contentType || "application/octet-stream",
    },
    body: buffer,
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(
      `Bunny upload failed (${r.status}): ${text || r.statusText}`,
    );
  }

  // Public CDN URL
  const publicUrl = joinUrl(cdnBase, folder, filename);
  return publicUrl;
}

router.use(authenticateAdmin);

// POST /api/uploads/pages?type=hero|inline
router.post("/pages", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ ok: false, error: "No file uploaded" });

    // Allow flag to disable Bunny quickly
    if (String(process.env.USE_BUNNY_STORAGE || "").toLowerCase() !== "true") {
      return res
        .status(400)
        .json({ ok: false, error: "Bunny storage is disabled" });
    }

    const type = String(
      req.query.type || req.query.kind || "inline",
    ).toLowerCase();

    // Base folder for page assets (supports your env convention)
    const basePages = String(
      process.env.BUNNY_PAGES_BASE_PATH || "app/pages",
    ).replace(/^\/+|\/+$/g, "");

    // Allow: hero | inline | gallery | background
    const safe = new Set(["hero", "inline", "gallery", "background"]);
    const t = safe.has(type) ? type : "inline";

    const uid = req.user?.id
      ? `u_${req.user.id}`
      : req.admin?.id
        ? `a_${req.admin.id}`
        : "admin";

    const folder = `${basePages}/${t}/${uid}`.replace(/\/+/, "/");

    const filename = makeFileName(req.file.originalname, req.file.mimetype);

    const url = await bunnyPut({
      folder,
      filename,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });

    return res.json({ ok: true, url });
  } catch (e) {
    console.error("[uploadsPagesBunny] error:", e);
    return res
      .status(500)
      .json({ ok: false, error: e.message || "Upload failed" });
  }
});

module.exports = router;
