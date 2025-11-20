// server-api/routes/uploads.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const authenticate = require("../middleware/authenticate");

// SAFE fallback imports for entitlements middleware
let attachEntitlements, checkQuota;
try {
  ({ attachEntitlements, checkQuota } = require("../middleware/entitlements"));
} catch (_) {
  attachEntitlements = (_req, _res, next) => next();
  checkQuota = () => (_req, _res, next) => next();
}

const { addUsage } = require("../services/usage");
const { getDurationSeconds } = require("../services/mediaMeta");

// ---------------------------
// Config / toggles
// ---------------------------
const hasWasabiCreds =
  !!process.env.WASABI_ENDPOINT &&
  !!process.env.WASABI_BUCKET &&
  !!process.env.WASABI_ACCESS_KEY &&
  !!process.env.WASABI_SECRET_KEY;

// set FORCE_LOCAL_UPLOAD=true in .env to bypass Wasabi for testing
const FORCE_LOCAL =
  String(process.env.FORCE_LOCAL_UPLOAD || "").toLowerCase() === "true";

const useWasabi = hasWasabiCreds && !FORCE_LOCAL;

// ---------------------------
// Paths
// ---------------------------
const uploadsDir = path.join(__dirname, "..", "uploads"); // served statically by server.js
const tmpDir = path.join(__dirname, "..", "tmp_uploads"); // temp when streaming to Wasabi
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// ---------------------------
// Multer storage
// ---------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, useWasabi ? tmpDir : uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
});

// ---------------------------
// Wasabi client (S3 compatible)
// ---------------------------
let s3 = null;
if (useWasabi) {
  s3 = new S3Client({
    region: "us-east-1",
    endpoint: process.env.WASABI_ENDPOINT,
    credentials: {
      accessKeyId: process.env.WASABI_ACCESS_KEY,
      secretAccessKey: process.env.WASABI_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

// ---------------------------
// Core handler w/ duration + quota
// ---------------------------
async function handleUpload(req, res) {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  try {
    req.socket.setTimeout(0);
  } catch (_) {}

  const localPath = req.file.path;
  const originalName = req.file.originalname;
  const size = req.file.size || 0;

  // 1) Try to detect duration using ffprobe
  let durationSec = null;
  try {
    durationSec = await getDurationSeconds(localPath);
  } catch (_) {}
  const durationHours = durationSec ? durationSec / 3600 : 0;

  // 2) Quota enforcement: storage_hours_total
  //    If user has a numeric limit, consume "durationHours"
  const quotaMw = checkQuota("storage_hours_total", () => durationHours);
  let blocked = false;
  await new Promise((resolve) => {
    quotaMw(req, res, () => resolve());
    // If quotaMw ends the response, we mark blocked
    res.once("finish", () => {
      if (!res.headersSent) return;
      if (res.statusCode >= 400) blocked = true;
      resolve();
    });
  });
  if (blocked) {
    try {
      fs.unlinkSync(localPath);
    } catch {}
    return; // response already sent by checkQuota
  }

  // 3) Proceed to save (Wasabi or local)
  try {
    if (useWasabi) {
      const ext = path.extname(originalName);
      const key = `videos/${Date.now()}-${Math.random().toString(36).slice(2)}${
        ext || ""
      }`;
      const ContentType =
        mime.lookup(originalName) || "application/octet-stream";

      const uploader = new Upload({
        client: s3,
        params: {
          Bucket: process.env.WASABI_BUCKET,
          Key: key,
          Body: fs.createReadStream(localPath),
          ContentType,
          ACL: "public-read",
        },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });

      await uploader.done();
      try {
        fs.unlinkSync(localPath);
      } catch {}

      const base = (
        process.env.WASABI_PUBLIC_URL ||
        process.env.WASABI_ENDPOINT ||
        ""
      ).replace(/\/+$/, "");
      const url = `${base}/${process.env.WASABI_BUCKET}/${key}`;

      // 4) Record usage after a successful upload
      if (durationHours > 0 && req.user?.id) {
        await addUsage(req.user.id, "storage_hours_total", durationHours, {
          reason: "upload",
          provider: "wasabi",
          key,
          size,
        });
      }

      return res.json({
        url,
        key,
        size,
        duration_sec: durationSec,
        duration_hours: durationHours,
      });
    }

    // Local mode: already in /uploads
    const filename = path.basename(localPath);
    const url = `/uploads/${filename}`;

    if (durationHours > 0 && req.user?.id) {
      await addUsage(req.user.id, "storage_hours_total", durationHours, {
        reason: "upload",
        provider: "local",
        key: filename,
        size,
      });
    }

    return res.json({
      url,
      key: filename,
      size,
      duration_sec: durationSec,
      duration_hours: durationHours,
    });
  } catch (err) {
    console.error("[POST /uploads] error:", err?.message || err);
    try {
      fs.unlinkSync(localPath);
    } catch {}
    return res.status(500).json({
      message: "Upload failed",
      detail: err?.message || "Unknown error",
    });
  }
}

/**
 * POST /api/uploads  or  /api/uploads/video
 * field name: "file"
 */
router.post(
  ["/", "/video"],
  authenticate,
  attachEntitlements,
  upload.single("file"),
  handleUpload
);

// Health
router.get("/__ping", (_req, res) =>
  res.json({ ok: true, useWasabi, FORCE_LOCAL })
);

module.exports = router;
