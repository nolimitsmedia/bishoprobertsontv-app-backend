// server-api/routes/wasabiImport.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  getWasabiConfig,
  listObjects,
  headObject,
  signGetUrl,
  isProbablyVideoKey,
  filenameFromKey,
  titleFromFilename,
} = require("../services/wasabi");

/* =========================================================
   ENV
========================================================= */
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY;

/* =========================================================
   WASABI CLIENT
========================================================= */
function getS3() {
  const cfg = getWasabiConfig();

  return new S3Client({
    region: cfg.region || "us-east-1",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
      secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

/* =========================================================
   BUNNY STREAM ONLY (NO STORAGE)
========================================================= */
async function pushToBunnyStream(fileUrl, title) {
  if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) return null;

  try {
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
    console.warn("[Bunny Stream] ingest failed:", err.message);
    return null;
  }
}

/* =========================================================
   IMPORT ROUTE (OPTION A CLEAN)
========================================================= */
router.post("/import", async (req, res) => {
  const db = req.db;

  try {
    const config = getWasabiConfig();
    const prefix = `${config.prefix || ""}/${req.body?.prefix || ""}`.replace(
      /\/+/g,
      "/",
    );

    const limit = Math.min(5000, Number(req.body?.limit || 5000));
    const visibility = req.body?.visibility || "private";
    const categoryId = req.body?.category_id
      ? Number(req.body.category_id)
      : null;

    const objects = await listObjects({ prefix });

    const videos = objects
      .filter((o) => isProbablyVideoKey(o.key))
      .slice(0, limit);

    const keys = videos.map((v) => v.key);

    /* =====================================================
       DEDUP CHECK
    ===================================================== */
    const existing = await db.query(
      `SELECT wasabi_key FROM videos WHERE wasabi_key = ANY($1::text[])`,
      [keys],
    );

    const existingSet = new Set(existing.rows.map((r) => r.wasabi_key));
    const toImport = videos.filter((v) => !existingSet.has(v.key));

    let inserted = 0;
    const created = [];

    /* =====================================================
       PROCESS FILES
    ===================================================== */
    for (const obj of toImport) {
      const file = filenameFromKey(obj.key);
      const title = titleFromFilename(file);

      let meta = {};
      try {
        meta = await headObject(obj.key);
      } catch {}

      // signed Wasabi URL (NO COPY, NO STORAGE)
      const fileUrl = await signGetUrl(obj.key, 60 * 60);

      /* =================================================
         BUNNY STREAM ONLY
      ================================================= */
      const bunny = await pushToBunnyStream(fileUrl, title);

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
    console.error("[wasabiImport error]", e);
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
});

module.exports = router;
