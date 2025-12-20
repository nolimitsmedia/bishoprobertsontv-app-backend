// server-api/routes/adminResources.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

const multer = require("multer");
const path = require("path");

function cleanStr(v) {
  return String(v ?? "").trim();
}

function isValidVisibility(v) {
  return ["public", "members", "admin"].includes(v);
}

function isValidType(v) {
  return ["link", "pdf", "doc", "zip", "image", "other", "zoom"].includes(v);
}

function normalizeVisibility(v) {
  const s = cleanStr(v).toLowerCase();
  if (!s) return "";
  if (isValidVisibility(s)) return s;
  return "";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayFolder() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function safeFileBaseName(name) {
  // Keep it simple: remove weird chars, keep dash/underscore/dot
  return (
    cleanStr(name)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 120) || "file"
  );
}

function typeFolder(type) {
  const t = String(type || "").toLowerCase();
  // You requested PDF folder, Docx folder, etc.
  if (t === "pdf") return "PDF";
  if (t === "doc") return "DOCX";
  if (t === "zip") return "ZIP";
  if (t === "image") return "Images";
  if (t === "zoom") return "Zoom";
  if (t === "other") return "Other";
  return "Other";
}

function guessExt(originalName, mime) {
  const extFromName = path.extname(originalName || "").toLowerCase();
  if (extFromName) return extFromName;

  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("word")) return ".docx";
  if (m.includes("zip")) return ".zip";
  if (m.includes("image/png")) return ".png";
  if (m.includes("image/jpeg")) return ".jpg";
  if (m.includes("image/webp")) return ".webp";
  return "";
}

/* -------------------------------------------------------
   Multer: memory storage (we upload to Bunny, not local disk)
------------------------------------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/* -------------------------------------------------------
   Bunny Storage uploader
------------------------------------------------------- */
async function uploadToBunny({ buffer, remotePath, contentType }) {
  const zone = cleanStr(process.env.BUNNY_STORAGE_ZONE);

  // ✅ Option B: support both env var names
  const key = cleanStr(
    process.env.BUNNY_STORAGE_KEY || process.env.BUNNY_STORAGE_API_KEY
  );

  const region = cleanStr(process.env.BUNNY_STORAGE_REGION); // optional

  if (!zone || !key) {
    const err = new Error(
      "Missing Bunny Storage env (BUNNY_STORAGE_ZONE / BUNNY_STORAGE_KEY)."
    );
    err.code = "BUNNY_ENV_MISSING";
    throw err;
  }

  // Allow overriding host, otherwise compute based on region/default
  const hostFromEnv = cleanStr(process.env.BUNNY_STORAGE_HOST);
  const host = hostFromEnv
    ? hostFromEnv.replace(/^https?:\/\//, "").replace(/\/+$/, "")
    : region
    ? `${region}.storage.bunnycdn.com`
    : "storage.bunnycdn.com";

  // IMPORTANT: remotePath should NOT start with a leading slash
  const storageUrl = `https://${host}/${encodeURIComponent(zone)}/${remotePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const res = await fetch(storageUrl, {
    method: "PUT",
    headers: {
      AccessKey: key,
      "Content-Type": contentType || "application/octet-stream",
    },
    body: buffer,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const e = new Error(
      `Bunny upload failed (${res.status}): ${txt || res.statusText}`
    );
    e.code = "BUNNY_UPLOAD_FAILED";
    throw e;
  }

  // ✅ Prefer CDN base URL if provided (public URL)
  const cdnBase = cleanStr(process.env.BUNNY_CDN_BASE_URL).replace(/\/+$/, "");
  const publicUrl = cdnBase ? `${cdnBase}/${remotePath}` : storageUrl;

  return publicUrl;
}

/* -------------------------------------------------------
   POST /api/admin/resources/upload
   multipart/form-data:
     - file: (required)
     - type: pdf|doc|zip|image|other  (required)
------------------------------------------------------- */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const type = cleanStr(req.body.type).toLowerCase();

    if (!type || !isValidType(type) || type === "link") {
      return res.status(400).json({
        ok: false,
        message: "Invalid type for upload. Use pdf/doc/zip/image/other.",
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "No file uploaded." });
    }

    const folderA = "Resources";
    const folderB = typeFolder(type); // PDF / DOCX / ZIP / Images / Other
    const folderC = todayFolder(); // YYYY-MM-DD

    const ext = guessExt(req.file.originalname, req.file.mimetype);
    const base = safeFileBaseName(
      path.basename(req.file.originalname || "file", ext)
    );
    const finalName = `${base}-${Date.now()}${ext}`;

    const remotePath = `${folderA}/${folderB}/${folderC}/${finalName}`;

    const url = await uploadToBunny({
      buffer: req.file.buffer,
      remotePath,
      contentType: req.file.mimetype,
    });

    return res.json({
      ok: true,
      url,
      path: remotePath,
      type,
      size: req.file.size,
    });
  } catch (e) {
    console.error("adminResources UPLOAD error:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "Failed to upload file.",
    });
  }
});

/* -------------------------------------------------------
   GET /api/admin/resources
------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const q = cleanStr(req.query.q);
    const visibility = normalizeVisibility(
      req.query.visibility || req.query.access
    );
    const type = cleanStr(req.query.type).toLowerCase();
    const active = cleanStr(req.query.active);

    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(r.title ILIKE $${params.length} OR COALESCE(r.description,'') ILIKE $${params.length})`
      );
    }

    if (visibility) {
      params.push(visibility);
      where.push(`r.visibility = $${params.length}`);
    }

    if (type && isValidType(type)) {
      params.push(type);
      where.push(`r.type = $${params.length}`);
    }

    if (active === "true" || active === "false") {
      params.push(active === "true");
      where.push(`r.is_active = $${params.length}`);
    }

    const sql = `
      SELECT
        r.*,
        v.title AS video_title,
        c.name AS category_name
      FROM resources r
      LEFT JOIN videos v ON v.id = r.video_id
      LEFT JOIN categories c ON c.id = r.collection_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.is_active DESC, r.sort_order ASC, r.created_at DESC
    `;

    const { rows } = await pool.query(sql, params);
    return res.json({ ok: true, resources: rows });
  } catch (e) {
    console.error("adminResources GET error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load resources." });
  }
});

/* -------------------------------------------------------
   POST /api/admin/resources
------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    const title = cleanStr(req.body.title);
    const url = cleanStr(req.body.url) || cleanStr(req.body.zoom_join_url);
    const description = cleanStr(req.body.description);

    const visibility =
      normalizeVisibility(req.body.visibility || req.body.access) || "public";
    const type = cleanStr(req.body.type || "link").toLowerCase();

    const video_id = req.body.video_id ? Number(req.body.video_id) : null;

    const collection_id =
      req.body.collection_id != null
        ? Number(req.body.collection_id)
        : req.body.category_id != null
        ? Number(req.body.category_id)
        : null;

    const sort_order = Number(req.body.sort_order || 0);
    const is_active = req.body.is_active === false ? false : true;

    if (!title)
      return res.status(400).json({ ok: false, message: "Title is required." });
    if (!url)
      return res.status(400).json({ ok: false, message: "URL is required." });
    if (!isValidVisibility(visibility))
      return res
        .status(400)
        .json({ ok: false, message: "Invalid visibility." });
    if (!isValidType(type))
      return res.status(400).json({ ok: false, message: "Invalid type." });

    const sql = `
      INSERT INTO resources
        (title, type, url, zoom_join_url, description, visibility, video_id, collection_id, sort_order, is_active)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `;

    const params = [
      title,
      type,
      url,
      cleanStr(req.body.zoom_join_url) || null,
      description || null,
      visibility,
      video_id,
      Number.isFinite(collection_id) ? collection_id : null,
      sort_order,
      is_active,
    ];

    const { rows } = await pool.query(sql, params);
    return res.json({ ok: true, resource: rows[0] });
  } catch (e) {
    console.error("adminResources POST error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to create resource." });
  }
});

/* -------------------------------------------------------
   PUT /api/admin/resources/:id
------------------------------------------------------- */
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid id." });

    // 1) Load existing row so we can support partial updates
    const existingRes = await pool.query(
      `SELECT * FROM resources WHERE id=$1`,
      [id]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      return res
        .status(404)
        .json({ ok: false, message: "Resource not found." });
    }

    // Small helper for booleans coming from forms ("true"/"false")
    const parseBool = (v, fallback) => {
      if (v === true || v === false) return v;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
      }
      return fallback;
    };

    // 2) Merge incoming values with existing values
    const title = cleanStr(req.body.title) || existing.title;

    // keep current URL if not sent (common when editing only visibility)
    const url =
      cleanStr(req.body.url) ||
      cleanStr(req.body.zoom_join_url) ||
      existing.url ||
      existing.zoom_join_url;

    const description =
      cleanStr(req.body.description) ?? existing.description ?? null;

    // Back-compat: accept access and map to visibility (and fallback to existing)
    const visibility =
      normalizeVisibility(req.body.visibility || req.body.access) ||
      existing.visibility ||
      "public";

    const type = cleanStr(
      req.body.type || existing.type || "link"
    ).toLowerCase();

    const video_id =
      req.body.video_id === "" || req.body.video_id == null
        ? existing.video_id
        : Number(req.body.video_id);

    // Back-compat: accept category_id and map to collection_id
    const collection_id =
      req.body.collection_id != null
        ? Number(req.body.collection_id)
        : req.body.category_id != null
        ? Number(req.body.category_id)
        : existing.collection_id;

    const sort_order =
      req.body.sort_order == null || req.body.sort_order === ""
        ? Number(existing.sort_order || 0)
        : Number(req.body.sort_order || 0);

    const is_active = parseBool(req.body.is_active, existing.is_active);

    // 3) Validate (now safe because url/title fallback)
    if (!title)
      return res.status(400).json({ ok: false, message: "Title is required." });
    if (!url)
      return res.status(400).json({ ok: false, message: "URL is required." });
    if (!isValidVisibility(visibility))
      return res
        .status(400)
        .json({ ok: false, message: "Invalid visibility." });
    if (!isValidType(type))
      return res.status(400).json({ ok: false, message: "Invalid type." });

    // 4) Update
    const sql = `
      UPDATE resources
      SET
        title=$1,
        type=$2,
        url=$3,
        zoom_join_url=$4,
        description=$5,
        visibility=$6,
        video_id=$7,
        collection_id=$8,
        sort_order=$9,
        is_active=$10,
        updated_at=NOW()
      WHERE id=$11
      RETURNING *
    `;

    const params = [
      title,
      type,
      url,
      cleanStr(req.body.zoom_join_url) || existing.zoom_join_url || null,
      description,
      visibility,
      Number.isFinite(video_id) ? video_id : null,
      Number.isFinite(collection_id) ? collection_id : null,
      sort_order,
      is_active,
      id,
    ];

    const { rows } = await pool.query(sql, params);
    return res.json({ ok: true, resource: rows[0] });
  } catch (e) {
    console.error("adminResources PUT error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to update resource." });
  }
});

/* -------------------------------------------------------
   DELETE /api/admin/resources/:id
   Soft delete: sets is_active=false
------------------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid id." });

    const { rows } = await pool.query(
      `UPDATE resources SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING id`,
      [id]
    );

    if (!rows[0]) {
      return res
        .status(404)
        .json({ ok: false, message: "Resource not found." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("adminResources DELETE error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to delete resource." });
  }
});

module.exports = router;
