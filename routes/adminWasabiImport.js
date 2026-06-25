// server-api/routes/adminWasabiImport.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

const {
  getWasabiConfig,
  listObjects,
  headObject,
  signGetUrl,
  isProbablyVideoKey,
  filenameFromKey,
  titleFromFilename,
} = require("../services/wasabi");

const USE_BUNNY_STREAM = !!process.env.BUNNY_STREAM_LIBRARY_ID;
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY;

/* =========================================================
   Bunny Stream uploader (CLEAN + NO STORAGE)
========================================================= */
async function pushToBunnyStream(fileUrl, title) {
  if (!USE_BUNNY_STREAM) return null;

  try {
    // 1. Create video entry
    const create = await axios.post(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
      { title },
      {
        headers: {
          AccessKey: BUNNY_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    const videoId = create.data.guid;

    // 2. Ingest from Wasabi URL (IMPORTANT: NOT uploading bytes)
    await axios.put(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`,
      fileUrl,
      {
        headers: {
          AccessKey: BUNNY_API_KEY,
          "Content-Type": "text/plain",
        },
        maxBodyLength: Infinity,
      },
    );

    return {
      videoId,
      embedUrl: `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoId}`,
      hlsUrl: `https://vz-${BUNNY_LIBRARY_ID}.b-cdn.net/${videoId}/playlist.m3u8`,
    };
  } catch (err) {
    console.warn("[Bunny Stream] upload failed:", err.message);
    return null;
  }
}

/* =========================================================
   POST /api/admin/wasabi/import
========================================================= */
router.post("/import", async (req, res) => {
  const db = req.db;

  try {
    const config = getWasabiConfig();
    const basePrefix = config.prefix || "";

    const prefix = `${basePrefix}/${req.body?.prefix || ""}`.replace(
      /\/+/g,
      "/",
    );

    const limit = Math.min(5000, Number(req.body?.limit || 5000));
    const visibility = req.body?.visibility || "private";
    const categoryId = req.body?.category_id
      ? Number(req.body.category_id)
      : null;

    /* =====================================================
       1. Get Wasabi objects
    ===================================================== */
    const objects = await listObjects({ prefix });

    const videos = objects
      .filter((o) => isProbablyVideoKey(o.key))
      .slice(0, limit);

    const keys = videos.map((v) => v.key);

    /* =====================================================
       2. Dedup check
    ===================================================== */
    const existing = await db.query(
      `SELECT wasabi_key FROM videos WHERE wasabi_key = ANY($1::text[])`,
      [keys],
    );

    const existingSet = new Set((existing.rows || []).map((r) => r.wasabi_key));

    const toInsert = videos.filter((v) => !existingSet.has(v.key));

    let inserted = 0;
    const created = [];

    /* =====================================================
       3. Process each file
    ===================================================== */
    for (const obj of toInsert) {
      const file = filenameFromKey(obj.key);
      const title = titleFromFilename(file);

      // optional metadata
      let meta = {};
      try {
        meta = await headObject(obj.key);
      } catch {}

      // signed Wasabi URL (source)
      const fileUrl = await signGetUrl(obj.key, 60 * 60);

      /* =================================================
         4. Send ONLY to Bunny Stream (NO STORAGE)
      ================================================= */
      let bunny = null;

      if (USE_BUNNY_STREAM) {
        bunny = await pushToBunnyStream(fileUrl, title);
      }

      /* =================================================
         5. Insert into DB
      ================================================= */
      const result = await db.query(
        `
        INSERT INTO videos (
          title,
          visibility,
          category_id,
          wasabi_bucket,
          wasabi_key,
          source_type,
          source_meta,
          bunny_stream_id,
          bunny_embed_url,
          bunny_hls_url,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
        RETURNING *
        `,
        [
          title,
          visibility,
          categoryId,
          config.bucket,
          obj.key,
          bunny ? "bunny_stream" : "wasabi",
          JSON.stringify({
            filename: file,
            size: obj.size,
            original_url: fileUrl,
            uploaded_to: bunny ? "bunny_stream" : "wasabi_only",
          }),
          bunny?.videoId || null,
          bunny?.embedUrl || null,
          bunny?.hlsUrl || null,
        ],
      );

      created.push(result.rows[0]);
      inserted++;
    }

    return res.json({
      ok: true,
      scanned: videos.length,
      inserted,
      skipped: videos.length - inserted,
      created,
    });
  } catch (e) {
    console.error("[wasabi import error]", e);
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
});

module.exports = router;
