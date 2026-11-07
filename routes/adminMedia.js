// server-api/routes/adminMedia.js
//
// Phase 4H-1 — CMS Media Library (admin only).
//
//   GET    /api/admin/media                  List / search (?q=&limit=&offset=)
//   GET    /api/admin/media/:id              One item, including the pages that use it
//   POST   /api/admin/media                  Register an uploaded file
//   PATCH  /api/admin/media/:id              Update title, alt text, caption, description
//   DELETE /api/admin/media/:id              Remove from the library (file is kept)
//   POST   /api/admin/media/import-from-pages  Add images already used on pages
//
// Files are uploaded with the existing POST /api/uploads route (Bunny, Wasabi or
// local storage, unchanged). The admin panel then registers the returned URL
// here. Pages keep storing plain URLs, so removing an item from the library
// never breaks a page: the file stays in storage.

const express = require("express");
const path = require("path");
const router = express.Router();
const db = require("../db");
// Phase 8-1: Administrators and Website Managers.
const { requireArea } = require("../lib/teamAccess");
const authenticateAdmin = requireArea("website");

router.use(authenticateAdmin);

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};
const LIMITS = { title: 200, alt_text: 300, caption: 500, description: 2000 };
const MAX_IMPORT = 2000;

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cleanLine(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanBlock(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

// Only web URLs and this server's /uploads paths can enter the library.
function validUrl(value) {
  const url = String(value ?? "").trim();
  if (!url || url.length > 2048) return "";
  if (/^\/uploads\/[^\s"'<>]+$/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function filenameFromUrl(url) {
  try {
    const p = url.startsWith("/") ? url : new URL(url).pathname;
    return decodeURIComponent(path.posix.basename(p)) || "image";
  } catch {
    return "image";
  }
}

function titleFromFilename(name) {
  const base = String(name || "image").replace(/\.[a-z0-9]+$/i, "");
  // Strip the "-<timestamp>-<random>" suffix added by the upload route.
  const tidy = base
    .replace(/-\d{10,}-[a-z0-9]{4,}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return cleanLine(tidy || base, LIMITS.title) || "Image";
}

function toInt(v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

function serialize(row) {
  return {
    id: Number(row.id),
    url: row.url,
    filename: row.filename || filenameFromUrl(row.url),
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    width: row.width,
    height: row.height,
    title: row.title || "",
    alt_text: row.alt_text || "",
    caption: row.caption || "",
    description: row.description || "",
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "Invalid media ID" });
    return null;
  }
  return id;
}

function missingTable(err, res) {
  if (String(err?.code) !== "42P01") return false;
  res.status(503).json({
    ok: false,
    error:
      "The media library is not set up yet. Run the 20261103_03_cms_media.sql migration.",
  });
  return true;
}

// Pages (draft or published, any content column) that contain this URL.
async function pagesUsing(url) {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.title, p.slug
         FROM pages p
        WHERE strpos(row_to_json(p)::text, $1) > 0
        ORDER BY p.title NULLS LAST, p.id
        LIMIT 50`,
      [url],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      title: r.title || r.slug || `Page ${r.id}`,
      slug: r.slug || "",
    }));
  } catch (err) {
    if (String(err?.code) === "42P01") return []; // no pages table
    throw err;
  }
}

// --- List / search ---------------------------------------------------------
router.get("/", async (req, res) => {
  const q = cleanLine(req.query.q, 100);
  const limit = toInt(req.query.limit, { min: 1, max: 100 }) || 48;
  const offset = toInt(req.query.offset, { min: 0 }) || 0;
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${params.length}`;
    where.push(
      `(title ILIKE ${p} OR alt_text ILIKE ${p} OR caption ILIKE ${p} OR filename ILIKE ${p})`,
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    res.set("Cache-Control", "no-store");
    const total = await db.query(
      `SELECT COUNT(*)::int AS n FROM cms_media ${whereSql}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT * FROM cms_media ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      ok: true,
      items: rows.map(serialize),
      total: total.rows[0].n,
      limit,
      offset,
    });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:list]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to load the media library" });
  }
});

// --- Import images already used on pages (registered before /:id) -----------
router.post("/import-from-pages", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT row_to_json(p)::text AS doc FROM pages p",
    );
    const re =
      /(?:https?:\/\/[^\s"'<>\\()]+?|\/uploads\/[^\s"'<>\\()]+?)\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s"'<>\\()]*)?(?=[\s"'<>\\()]|$)/gi;
    const found = new Set();
    for (const r of rows) {
      for (const m of String(r.doc || "").matchAll(re)) {
        const url = validUrl(m[0]);
        if (url) found.add(url);
        if (found.size >= MAX_IMPORT) break;
      }
      if (found.size >= MAX_IMPORT) break;
    }

    let added = 0;
    const createdBy = toInt(req.user?.id, { min: 1 });
    for (const url of found) {
      const filename = filenameFromUrl(url);
      const ext = path.extname(filename.split("?")[0]).toLowerCase();
      const r = await db.query(
        `INSERT INTO cms_media (url, filename, mime_type, title, source, created_by)
         VALUES ($1, $2, $3, $4, 'import', $5)
         ON CONFLICT (url) DO NOTHING`,
        [
          url,
          filename,
          EXT_MIME[ext] || null,
          titleFromFilename(filename),
          createdBy,
        ],
      );
      added += r.rowCount;
    }
    res.json({ ok: true, found: found.size, added });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:import]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to import images from pages" });
  }
});

// --- One item with usage -------------------------------------------------------
router.get("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query("SELECT * FROM cms_media WHERE id = $1", [
      id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Media item not found" });
    const used_on = await pagesUsing(rows[0].url);
    res.json({ ok: true, item: { ...serialize(rows[0]), used_on } });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:get]", err);
    res.status(500).json({ ok: false, error: "Unable to load media item" });
  }
});

// --- Register an uploaded file ---------------------------------------------------
router.post("/", async (req, res) => {
  const b = isObj(req.body) ? req.body : {};
  const url = validUrl(b.url);
  if (!url)
    return res
      .status(400)
      .json({ ok: false, error: "A valid image URL is required" });
  const mime = String(b.mime_type || "")
    .toLowerCase()
    .trim();
  if (!ALLOWED_MIME.has(mime))
    return res.status(400).json({
      ok: false,
      error: "Only JPG, PNG, GIF, WebP and AVIF images can be added",
    });
  const filename = cleanLine(b.filename, 255) || filenameFromUrl(url);
  const title = cleanLine(b.title, LIMITS.title) || titleFromFilename(filename);
  try {
    const { rows } = await db.query(
      `INSERT INTO cms_media
         (url, storage_key, filename, mime_type, size_bytes, width, height,
          title, alt_text, caption, description, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'upload',$12)
       ON CONFLICT (url) DO NOTHING
       RETURNING *`,
      [
        url,
        cleanLine(b.storage_key, 1024) || null,
        filename,
        mime,
        toInt(b.size_bytes, { min: 0 }),
        toInt(b.width, { min: 1, max: 100000 }),
        toInt(b.height, { min: 1, max: 100000 }),
        title,
        cleanLine(b.alt_text, LIMITS.alt_text),
        cleanBlock(b.caption, LIMITS.caption),
        cleanBlock(b.description, LIMITS.description),
        toInt(req.user?.id, { min: 1 }),
      ],
    );
    if (!rows.length) {
      const existing = await db.query(
        "SELECT * FROM cms_media WHERE url = $1",
        [url],
      );
      return res.status(200).json({
        ok: true,
        existing: true,
        item: serialize(existing.rows[0]),
      });
    }
    res.status(201).json({ ok: true, item: serialize(rows[0]) });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:create]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to add the image to the library" });
  }
});

// --- Update details -------------------------------------------------------------
router.patch("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  const b = isObj(req.body) ? req.body : {};
  const sets = [];
  const params = [];
  for (const field of Object.keys(LIMITS)) {
    if (b[field] === undefined) continue;
    const value =
      field === "caption" || field === "description"
        ? cleanBlock(b[field], LIMITS[field])
        : cleanLine(b[field], LIMITS[field]);
    if (field === "title" && !value)
      return res.status(400).json({ ok: false, error: "Enter a title" });
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length)
    return res.status(400).json({ ok: false, error: "Nothing to update" });
  try {
    params.push(id);
    const { rows } = await db.query(
      `UPDATE cms_media SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Media item not found" });
    res.json({ ok: true, item: serialize(rows[0]) });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:update]", err);
    res.status(500).json({ ok: false, error: "Unable to save the details" });
  }
});

// --- Remove from library (the file stays in storage) ---------------------------
router.delete("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const { rows } = await db.query(
      "DELETE FROM cms_media WHERE id = $1 RETURNING url",
      [id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Media item not found" });
    res.json({ ok: true, id });
  } catch (err) {
    if (missingTable(err, res)) return;
    console.error("[adminMedia:delete]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to remove the media item" });
  }
});

module.exports = router;
