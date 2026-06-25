// server-api/routes/adminWasabiImport.js
const express = require("express");
const router = express.Router();

const {
  getWasabiConfig,
  listObjects,
  headObject,
  signGetUrl,
  isProbablyVideoKey,
  filenameFromKey,
  titleFromFilename,
} = require("../services/wasabi");

// IMPORTANT: keep this separate from countdown/calendar logic. No shared code.

function safePrefixJoin(basePrefix, subPrefix) {
  const a = String(basePrefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const b = String(subPrefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!a && !b) return "";
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

/**
 * GET /api/admin/wasabi/preview?prefix=drm
 * Returns list of mp4-like objects under bucket/prefix (rough metadata).
 */
router.get("/preview", async (req, res) => {
  try {
    const { prefix: defaultPrefix } = getWasabiConfig();
    const prefix = safePrefixJoin(defaultPrefix, req.query.prefix || "");

    const objects = await listObjects({ prefix });

    const videos = objects
      .filter((o) => isProbablyVideoKey(o.key))
      .map((o) => ({
        key: o.key,
        filename: filenameFromKey(o.key),
        title_guess: titleFromFilename(filenameFromKey(o.key)),
        size: o.size,
        last_modified: o.last_modified,
      }))
      .sort((a, b) =>
        (a.last_modified || "").localeCompare(b.last_modified || ""),
      );

    return res.json({
      ok: true,
      bucket: getWasabiConfig().bucket,
      endpoint: getWasabiConfig().endpoint,
      region: getWasabiConfig().region,
      prefix,
      counts: {
        total_objects: objects.length,
        video_candidates: videos.length,
      },
      videos,
    });
  } catch (e) {
    console.error("[adminWasabiImport] preview error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * POST /api/admin/wasabi/import
 * Body:
 * {
 *   "prefix": "drm",                 // optional override (appends to default prefix)
 *   "limit": 200,                   // optional
 *   "category_id": 123,             // optional
 *   "visibility": "private"         // optional default
 * }
 *
 * Creates video rows that reference wasabi_key (not expiring URL).
 */
router.post("/import", async (req, res) => {
  const db = req.db;
  try {
    const { prefix: defaultPrefix } = getWasabiConfig();
    const prefix = safePrefixJoin(defaultPrefix, req.body?.prefix || "");

    const limit = Math.max(1, Math.min(5000, Number(req.body?.limit) || 5000));
    const categoryId = req.body?.category_id
      ? Number(req.body.category_id)
      : null;
    const visibility = String(req.body?.visibility || "private").toLowerCase();

    const objects = await listObjects({ prefix });
    const videoObjects = objects
      .filter((o) => isProbablyVideoKey(o.key))
      .slice(0, limit);

    // Dedup: don’t import keys already in DB
    // Assumes videos table has "wasabi_key" column (we’ll add in Step 5).
    const keys = videoObjects.map((o) => o.key);
    const existing = await db.query(
      `SELECT wasabi_key FROM videos WHERE wasabi_key = ANY($1::text[])`,
      [keys],
    );
    const existingSet = new Set((existing.rows || []).map((r) => r.wasabi_key));

    const toInsert = videoObjects.filter((o) => !existingSet.has(o.key));

    let inserted = 0;
    const created = [];

    for (const obj of toInsert) {
      const file = filenameFromKey(obj.key);
      const title = titleFromFilename(file);

      // Optional: get content-type / length (can skip if you want faster imports)
      let meta = { content_type: null, content_length: obj.size };
      try {
        meta = await headObject(obj.key);
      } catch {
        // non-fatal
      }

      const q = `
        INSERT INTO videos
          (title, visibility, category_id, wasabi_bucket, wasabi_key, wasabi_region, wasabi_endpoint, source_type, source_meta, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'wasabi', $8::jsonb, now(), now())
        RETURNING id, title, visibility, category_id, wasabi_key
      `;
      const params = [
        title || file,
        visibility,
        categoryId,
        getWasabiConfig().bucket,
        obj.key,
        getWasabiConfig().region,
        getWasabiConfig().endpoint,
        JSON.stringify({
          filename: file,
          size: Number(meta.content_length || obj.size || 0),
          content_type: meta.content_type || null,
          imported_from_prefix: prefix,
          last_modified: obj.last_modified || null,
        }),
      ];

      const r = await db.query(q, params);
      inserted += 1;
      created.push(r.rows[0]);
    }

    return res.json({
      ok: true,
      prefix,
      scanned: videoObjects.length,
      skipped_existing: videoObjects.length - toInsert.length,
      inserted,
      created,
    });
  } catch (e) {
    console.error("[adminWasabiImport] import error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * GET /api/admin/wasabi/sign?key=...
 * Useful for quick testing; in production you’ll sign during playback.
 */
router.get("/sign", async (req, res) => {
  try {
    const key = String(req.query.key || "").trim();
    if (!key)
      return res.status(400).json({ ok: false, message: "Missing key" });

    const url = await signGetUrl(key, 60 * 30);
    return res.json({ ok: true, url });
  } catch (e) {
    console.error("[adminWasabiImport] sign error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

module.exports = router;
