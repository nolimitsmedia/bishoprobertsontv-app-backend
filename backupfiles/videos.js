// server-api/routes/videos.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// --- helpers
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function ensureArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function buildMetadataFromBody(body) {
  // Accept anything; but we normalize common keys used in UI
  const {
    seo_title,
    seo_description,
    tags,
    resources, // [{title,url}]
    subtitles, // [{lang,url}]
    audio_track, // {url}
    trailer, // {url}
    pricing, // {rental:{currency,price,duration_days}, purchase:{currency,price}, upsell_text}
    authors, // [string]
    custom_filters, // [string] or [{key,value}]
  } = body;

  const md = {};
  if (seo_title !== undefined) md.seo_title = String(seo_title || "");
  if (seo_description !== undefined)
    md.seo_description = String(seo_description || "");
  if (tags !== undefined) md.tags = ensureArray(tags).map(String);

  if (resources !== undefined)
    md.resources = ensureArray(resources).map((r) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
    }));

  if (subtitles !== undefined)
    md.subtitles = ensureArray(subtitles).map((s) => ({
      lang: String(s.lang || ""),
      url: String(s.url || ""),
    }));

  if (audio_track !== undefined)
    md.audio_track = audio_track
      ? { url: String(audio_track.url || "") }
      : null;
  if (trailer !== undefined)
    md.trailer = trailer ? { url: String(trailer.url || "") } : null;

  if (pricing !== undefined) {
    md.pricing = {
      rental: pricing?.rental
        ? {
            currency: String(pricing.rental.currency || "USD"),
            price: Number(pricing.rental.price || 0),
            duration_days: Number(pricing.rental.duration_days || 0),
          }
        : null,
      purchase: pricing?.purchase
        ? {
            currency: String(pricing.purchase.currency || "USD"),
            price: Number(pricing.purchase.price || 0),
          }
        : null,
      upsell_text: String(pricing?.upsell_text || ""),
    };
  }

  if (authors !== undefined) md.authors = ensureArray(authors).map(String);
  if (custom_filters !== undefined)
    md.custom_filters = ensureArray(custom_filters);

  return md;
}

function mergeJson(a, b) {
  // simple shallow merge (jsonb || operator equivalent)
  return { ...(a || {}), ...(b || {}) };
}

// ----------------- ROUTES -----------------

// GET /api/videos?search=&category_id=&limit=
router.get("/", authenticate, async (req, res) => {
  try {
    const { search, category_id, limit = 50 } = req.query;

    const params = [];
    let where = "WHERE 1=1";

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`;
    }
    if (category_id) {
      params.push(category_id);
      where += ` AND v.category_id = $${params.length}`;
    }

    params.push(Number(limit));
    const sql = `
      SELECT v.*,
             c.name AS category_name
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY v.created_at DESC
      LIMIT $${params.length}
    `;
    const r = await db.query(sql, params);
    res.json({ items: r.rows });
  } catch (e) {
    console.error("[GET /videos] error:", e);
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

// GET /api/videos/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT v.*, c.name AS category_name
       FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id
       WHERE v.id = $1
       LIMIT 1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (e) {
    console.error("[GET /videos/:id] error:", e);
    res.status(500).json({ message: "Failed to fetch video" });
  }
});

// POST /api/videos
router.post("/", authenticate, async (req, res) => {
  try {
    const base = pick(req.body, [
      "title",
      "description",
      "short_description",
      "category_id",
      "thumbnail_url",
      "video_url",
      "visibility",
      "is_premium",
    ]);

    // defaults as requested
    if (base.visibility === undefined) base.visibility = "private";
    if (base.is_premium === undefined) base.is_premium = true;

    const md = buildMetadataFromBody(req.body);

    const r = await db.query(
      `INSERT INTO videos
       (title, description, short_description, category_id, thumbnail_url, video_url, visibility, is_premium, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        base.title || null,
        base.description || null,
        base.short_description || null,
        base.category_id || null,
        base.thumbnail_url || null,
        base.video_url || null,
        base.visibility,
        base.is_premium,
        JSON.stringify(md),
      ]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error("[POST /videos] error:", e);
    res.status(500).json({ message: "Failed to create video" });
  }
});

// PUT /api/videos/:id  (partial update)
router.put("/:id", authenticate, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1) fetch current row to merge metadata
    const cur = await client.query(
      "SELECT metadata FROM videos WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Not found" });
    }
    const currentMd = cur.rows[0].metadata || {};

    // 2) compute new metadata
    const mdPatch = buildMetadataFromBody(req.body);
    const mergedMd = mergeJson(currentMd, mdPatch);

    // 3) build SET parts for base scalar fields
    const base = pick(req.body, [
      "title",
      "description",
      "short_description",
      "category_id",
      "thumbnail_url",
      "video_url",
      "visibility",
      "is_premium",
    ]);

    const sets = [];
    const vals = [];
    let i = 1;

    for (const [k, v] of Object.entries(base)) {
      sets.push(`${k} = $${i++}`);
      vals.push(v === undefined ? null : v);
    }
    // metadata last
    sets.push(`metadata = $${i++}`);
    vals.push(JSON.stringify(mergedMd));

    vals.push(req.params.id);

    const sql = `UPDATE videos SET ${sets.join(
      ", "
    )} WHERE id = $${i} RETURNING *`;
    const r = await client.query(sql, vals);

    await client.query("COMMIT");
    res.json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PUT /videos/:id] error:", e);
    res.status(500).json({ message: "Failed to update video" });
  } finally {
    client.release();
  }
});

// DELETE /api/videos/:id
router.delete("/:id", authenticate, async (req, res) => {
  try {
    await db.query("DELETE FROM videos WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /videos/:id] error:", e);
    res.status(500).json({ message: "Failed to delete video" });
  }
});

module.exports = router;
