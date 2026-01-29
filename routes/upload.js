// server-api/routes/upload.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const db = require("../db");

// ---------------------------------------------------------------------------
//  Preflight safety (belt + suspenders)
//  - Browser will send OPTIONS before POST (especially when Authorization header is used)
//  - We answer 204 fast so OPTIONS never accidentally hits auth/multer
// ---------------------------------------------------------------------------
router.options(["/", "/video", "/presign", "/__ping", "/__cors"], (_req, res) =>
  res.sendStatus(204),
);

// Optional debug endpoint: confirms what origin is hitting this router
router.get("/__cors", (req, res) => {
  res.json({
    ok: true,
    origin: req.headers.origin || null,
    method: req.method,
  });
});

// --- Auth: allow both user and admin to upload -----------------------------
const authenticate = require("../middleware/authenticate");
function allowUploadRoles(req, res, next) {
  const role = String(req.user?.role || "user").toLowerCase();
  if (role === "user" || role === "admin" || role === "creator") return next();
  return res
    .status(403)
    .json({ message: "Forbidden: role not allowed to upload" });
}

// --- Entitlements / quota (optional – safe fallbacks) ----------------------
let attachEntitlements, checkQuota;
try {
  ({ attachEntitlements, checkQuota } = require("../middleware/entitlements"));
} catch {
  attachEntitlements = (_req, _res, next) => next();
  checkQuota = () => (_req, _res, next) => next();
}

// --- Usage + metadata ------------------------------------------------------
const { addUsage } = require("../services/usage");
const { getDurationSeconds } = require("../services/mediaMeta");

// ---------------------------------------------------------------------------
//  Cloud config: Wasabi (legacy) + Bunny Storage (new)
// ---------------------------------------------------------------------------

// Wasabi (legacy) -----------------------------------------------------------
const hasWasabiCreds =
  !!process.env.WASABI_ENDPOINT &&
  !!process.env.WASABI_BUCKET &&
  !!process.env.WASABI_ACCESS_KEY &&
  !!process.env.WASABI_SECRET_KEY;

const FORCE_LOCAL =
  String(process.env.FORCE_LOCAL_UPLOAD || "").toLowerCase() === "true";

const useWasabi = hasWasabiCreds && !FORCE_LOCAL;

const WASABI_BUCKET = process.env.WASABI_BUCKET || "";
const WASABI_PUBLIC_BASE = (
  process.env.WASABI_PUBLIC_URL ||
  process.env.WASABI_ENDPOINT ||
  ""
).replace(/\/+$/, "");
const PREFIX = (process.env.WASABI_PREFIX || "app").replace(/^\/+|\/+$/g, "");

// Wasabi client (S3 compatible)
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

// Bunny Storage -------------------------------------------------------------
const useBunny =
  String(process.env.USE_BUNNY_STORAGE || "").toLowerCase() === "true" &&
  !!process.env.BUNNY_STORAGE_ZONE &&
  !!process.env.BUNNY_STORAGE_API_KEY;

const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || "";
const BUNNY_STORAGE_HOST =
  process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com";
const BUNNY_CDN_BASE_URL = (process.env.BUNNY_CDN_BASE_URL || "").replace(
  /\/+$/,
  "",
);

// ---------------------------------------------------------------------------
//  Local paths + Multer
// ---------------------------------------------------------------------------
const uploadsDir = path.join(__dirname, "..", "uploads"); // served statically by server.js
const tmpDir = path.join(__dirname, "..", "tmp_uploads"); // temp for streaming to cloud

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) =>
    cb(null, useWasabi || useBunny ? tmpDir : uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

/**
 * ✅ NO LIMIT uploads (application-side)
 * Multer has no file size limit unless `limits.fileSize` is set.
 * We keep an OPTIONAL env override:
 *   UPLOAD_MAX_BYTES=0  -> no limit (default)
 *   UPLOAD_MAX_BYTES=... -> set a cap if you ever want one
 */
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 0);

const upload = multer({
  storage,
  limits: MAX_BYTES > 0 ? { fileSize: MAX_BYTES } : undefined,
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
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

// Category-aware key builder
function keyFor(user, kind, originalName, category) {
  const ext = path.extname(originalName || "").toLowerCase();
  const base = slugify(path.basename(originalName || "upload", ext));
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const uid = user?.id ? `u_${user.id}` : "anon";
  const k = safeKind(kind);
  const catSlug = slugify(category || "uncategorized") || "uncategorized";

  return `${PREFIX}/${k}/${catSlug}/${uid}/${base}-${ts}-${rand}${ext}`;
}

function shouldCreateVideo(req) {
  const v =
    req.body?.createVideo ??
    req.body?.create_video ??
    req.body?.create ??
    req.query?.createVideo;
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

async function insertVideoRow({
  req,
  url,
  durationSec,
  key,
  provider = useBunny ? "bunny" : useWasabi ? "wasabi" : "local",
}) {
  const title =
    (req.body?.title && String(req.body.title).trim()) ||
    (req.file?.originalname || "Untitled").replace(/\.[^.]+$/, "");
  const description = String(req.body?.description || "");
  const visibility = String(req.body?.visibility || "private").toLowerCase();
  const is_premium =
    req.body?.is_premium != null
      ? String(req.body.is_premium).toLowerCase() === "true"
      : true;
  const created_by = (req.user && req.user.id) || null;

  const ins = await db.query(
    `INSERT INTO videos
      (title, description, video_url, duration_seconds,
       thumbnail_url, category_id, is_premium, visibility, created_by, provider_key, provider)
     VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      title,
      description,
      url,
      durationSec || null,
      is_premium,
      visibility,
      created_by,
      key || null,
      provider,
    ],
  );
  return ins.rows[0] || null;
}

// ---------------------------------------------------------------------------
//  Cloud upload helpers
// ---------------------------------------------------------------------------

// Wasabi (legacy)
async function putToWasabi(localPath, key, contentType) {
  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: WASABI_BUCKET,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentType || "application/octet-stream",
      ACL: "public-read",
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await uploader.done();
  const url = `${WASABI_PUBLIC_BASE}/${WASABI_BUCKET}/${key}`;
  const stat = fs.statSync(localPath);
  return { key, url, size: stat.size || 0 };
}

// Bunny Storage via HTTP PUT (Node 18+/22 with duplex)
async function putToBunny(localPath, key, contentType) {
  if (!useBunny) {
    throw new Error("Bunny storage is not enabled");
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(`Local upload file not found: ${localPath}`);
  }

  const uploadUrl = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_ZONE}/${key}`;
  const stream = fs.createReadStream(localPath);

  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: process.env.BUNNY_STORAGE_API_KEY,
      "Content-Type": contentType || "application/octet-stream",
    },
    body: stream,
    duplex: "half",
  });

  if (!resp.ok) {
    let bodyText = "";
    try {
      bodyText = await resp.text();
    } catch (_) {}
    throw new Error(
      `Bunny upload failed: ${resp.status} ${resp.statusText} ${bodyText}`,
    );
  }

  const stat = fs.statSync(localPath);
  const publicUrl = `${BUNNY_CDN_BASE_URL}/${key}`;
  return { key, url: publicUrl, size: stat.size || 0 };
}

// ---------------------------------------------------------------------------
//  Core handler: duration → quota → store → usage (+optional create video)
// ---------------------------------------------------------------------------
async function handleUpload(req, res) {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    req.socket.setTimeout(0);
  } catch {}

  const localPath = req.file.path;
  const originalName = req.file.originalname;
  const size = req.file.size || 0;

  const kind = safeKind(req.body.kind || req.query.kind);

  // Category for folder structure (optional)
  const categoryRaw =
    req.body?.category ||
    req.body?.category_slug ||
    req.body?.folder ||
    req.query?.category ||
    req.query?.category_slug ||
    req.query?.folder;
  const category = categoryRaw || "uncategorized";

  // 1) Detect duration for videos (best-effort)
  let durationSec = null;
  if (kind === "videos") {
    try {
      durationSec = await getDurationSeconds(localPath);
    } catch {}
  }
  const durationHours = durationSec ? durationSec / 3600 : 0;

  // 2) Quota: only enforce storage-hours for videos
  if (kind === "videos") {
    const quotaMw = checkQuota("storage_hours_total", () => durationHours);
    let blocked = false;

    await new Promise((resolve) => {
      quotaMw(req, res, () => resolve());
      res.once("finish", () => {
        if (res.headersSent && res.statusCode >= 400) blocked = true;
        resolve();
      });
    });

    if (blocked) {
      try {
        fs.unlinkSync(localPath);
      } catch {}
      return;
    }
  }

  try {
    // 3) Save (Bunny, Wasabi, or local)
    if (useBunny) {
      const key = keyFor(req.user, kind, originalName, category);
      const ContentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";

      const out = await putToBunny(localPath, key, ContentType);

      try {
        fs.unlinkSync(localPath);
      } catch {}

      if (kind === "videos" && durationHours > 0 && req.user?.id) {
        await addUsage(req.user.id, "storage_hours_total", durationHours, {
          reason: "upload",
          provider: "bunny",
          key: out.key,
          size: out.size,
          kind,
          category,
        });
      }

      let createdVideo = null;
      if (kind === "videos" && shouldCreateVideo(req)) {
        createdVideo = await insertVideoRow({
          req,
          url: out.url,
          durationSec,
          key: out.key,
          provider: "bunny",
        });
      }

      return res.json({
        url: out.url,
        key: out.key,
        size: out.size,
        file_size_bytes: out.size,
        kind,
        category,
        duration_sec: durationSec,
        duration_seconds: durationSec,
        duration_hours: durationHours,
        video: createdVideo,
      });
    }

    // Wasabi (legacy path)
    if (useWasabi) {
      const key = keyFor(req.user, kind, originalName, category);
      const ContentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";

      const out = await putToWasabi(localPath, key, ContentType);

      try {
        fs.unlinkSync(localPath);
      } catch {}

      if (kind === "videos" && durationHours > 0 && req.user?.id) {
        await addUsage(req.user.id, "storage_hours_total", durationHours, {
          reason: "upload",
          provider: "wasabi",
          key: out.key,
          size: out.size,
          kind,
          category,
        });
      }

      let createdVideo = null;
      if (kind === "videos" && shouldCreateVideo(req)) {
        createdVideo = await insertVideoRow({
          req,
          url: out.url,
          durationSec,
          key: out.key,
          provider: "wasabi",
        });
      }

      return res.json({
        url: out.url,
        key: out.key,
        size: out.size,
        file_size_bytes: out.size,
        kind,
        category,
        duration_sec: durationSec,
        duration_seconds: durationSec,
        duration_hours: durationHours,
        video: createdVideo,
      });
    }

    // Local mode: already saved to /uploads by Multer
    const filename = path.basename(localPath);
    const url = `/uploads/${filename}`;

    if (kind === "videos" && durationHours > 0 && req.user?.id) {
      await addUsage(req.user.id, "storage_hours_total", durationHours, {
        reason: "upload",
        provider: "local",
        key: filename,
        size,
        kind,
        category,
      });
    }

    let createdVideo = null;
    if (kind === "videos" && shouldCreateVideo(req)) {
      createdVideo = await insertVideoRow({
        req,
        url,
        durationSec,
        key: filename,
        provider: "local",
      });
    }

    return res.json({
      url,
      key: filename,
      size,
      file_size_bytes: size,
      kind,
      category,
      duration_sec: durationSec,
      duration_seconds: durationSec,
      duration_hours: durationHours,
      video: createdVideo,
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
 * POST /api/uploads  and /api/uploads/video
 * field: "file"
 * optional multipart fields:
 *   kind=videos|resources|images|docs|files   (default: videos)
 *   category=sermons|conference|...           (used for folder structure)
 *   createVideo=true|1                        (only if kind=videos)
 *   title, description, visibility, is_premium
 */
router.post(
  ["/", "/video"],
  authenticate,
  allowUploadRoles,
  attachEntitlements,

  // Wrap multer to return clean JSON errors
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            message: "File too large",
            detail:
              "This upload exceeds the server limit. Set UPLOAD_MAX_BYTES=0 (or remove it) for no limit.",
            code: err.code,
          });
        }
        return res.status(400).json({
          message: "Upload error",
          detail: err.message,
          code: err.code,
        });
      }

      return res.status(500).json({
        message: "Upload error",
        detail: err?.message || "Unknown upload error",
      });
    });
  },

  handleUpload,
);

// --------- OPTIONAL: presign (Wasabi only; Bunny not supported) ------------
router.post("/presign", authenticate, allowUploadRoles, async (req, res) => {
  if (useBunny) {
    return res.status(400).json({
      error:
        "Presigned uploads are not enabled for Bunny Storage. Please upload via /api/uploads.",
    });
  }
  if (!useWasabi) return res.status(400).json({ error: "Wasabi disabled" });

  const {
    filename = "upload.bin",
    contentType = "application/octet-stream",
    kind = "videos",
    category,
  } = req.body || {};

  const key = keyFor(req.user, kind, filename, category);
  const cmd = new PutObjectCommand({
    Bucket: WASABI_BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: "public-read",
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 10 });
  const publicUrl = `${WASABI_PUBLIC_BASE}/${WASABI_BUCKET}/${key}`;
  res.json({ url, key, publicUrl, kind });
});

// Simple health/ping
router.get("/__ping", (_req, res) =>
  res.json({
    ok: true,
    useWasabi,
    useBunny,
    FORCE_LOCAL,
    prefix: PREFIX,
    bunnyCdnBase: BUNNY_CDN_BASE_URL || null,
    uploadMaxBytes: MAX_BYTES > 0 ? MAX_BYTES : null,
  }),
);

module.exports = router;
