// server-api/routes/adminWasabi.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");

// AWS SDK v3 for S3-compatible storage (Wasabi)
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

/**
 * ENV needed (server-side only):
 *  WASABI_REGION=us-east-1
 *  WASABI_ACCESS_KEY_ID=xxxx
 *  WASABI_SECRET_ACCESS_KEY=xxxx
 *  WASABI_BUCKET=drm
 *
 * Optional:
 *  WASABI_ENDPOINT=https://s3.us-east-1.wasabisys.com
 */

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getS3() {
  const region = mustEnv("WASABI_REGION");
  const accessKeyId = mustEnv("WASABI_ACCESS_KEY_ID");
  const secretAccessKey = mustEnv("WASABI_SECRET_ACCESS_KEY");
  const endpoint =
    process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;

  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function cleanPrefix(p) {
  if (!p) return "";
  let x = String(p).trim();
  x = x.replace(/^\/+/, "");
  if (x && !x.endsWith("/")) x += "/";
  return x;
}

function extOf(key = "") {
  const i = key.lastIndexOf(".");
  return i >= 0 ? key.slice(i + 1).toLowerCase() : "";
}

function isMp4Key(key = "") {
  return extOf(key) === "mp4";
}

function wasabiPublicUrl(bucket, region, key) {
  return `https://s3.${region}.wasabisys.com/${bucket}/${encodeURIComponent(
    key,
  ).replace(/%2F/g, "/")}`;
}

function guessTitleFromKey(key, mode = "filename_no_ext") {
  const filename = String(key).split("/").pop() || key;
  const noExt = filename.replace(/\.[^/.]+$/, "");
  if (mode === "filename") return filename;
  return noExt.replace(/[_-]+/g, " ").trim();
}

/* -------------------------------------------------------
   DB helper: detect videos table columns safely
-------------------------------------------------------- */
let _videosColsCache = null;

async function getVideosColumns(db) {
  if (_videosColsCache) return _videosColsCache;

  const q = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'videos'
  `;
  const r = await db.query(q);
  const cols = new Set((r.rows || []).map((x) => x.column_name));
  _videosColsCache = cols;
  return cols;
}

function firstExisting(cols, candidates) {
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
}

async function findDuplicateVideo(db, cols, url) {
  const urlCol = firstExisting(cols, [
    "video_url",
    "source_url",
    "file_url",
    "url",
  ]);
  if (!urlCol) return null;

  const r = await db.query(
    `SELECT id FROM videos WHERE ${urlCol} = $1 LIMIT 1`,
    [url],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

async function insertVideo(db, cols, payload) {
  // required-ish fields
  const titleCol = firstExisting(cols, ["title", "name"]);
  const urlCol = firstExisting(cols, [
    "video_url",
    "source_url",
    "file_url",
    "url",
  ]);

  if (!titleCol) throw new Error(`videos table missing a title/name column`);
  if (!urlCol) throw new Error(`videos table missing a video url column`);

  const createdCol = cols.has("created_at") ? "created_at" : null;
  const updatedCol = cols.has("updated_at") ? "updated_at" : null;

  const categoryCol = cols.has("category_id") ? "category_id" : null;

  // visibility columns vary
  const visibilityCol = firstExisting(cols, ["visibility", "privacy"]);
  const publishedCol = firstExisting(cols, ["is_published", "published"]);

  // optional storage metadata columns (only used if they exist)
  const providerCol = firstExisting(cols, [
    "storage_provider",
    "provider",
    "video_provider",
    "media_provider",
  ]);
  const storageKeyCol = firstExisting(cols, [
    "storage_key",
    "provider_key",
    "object_key",
    "s3_key",
    "file_key",
  ]);
  const bucketCol = firstExisting(cols, ["storage_bucket", "bucket"]);
  const regionCol = firstExisting(cols, ["storage_region", "region"]);

  // Build dynamic INSERT
  const insertCols = [];
  const values = [];
  const params = [];

  function push(col, val) {
    if (!col) return;
    insertCols.push(col);
    values.push(val);
    params.push(`$${values.length}`);
  }

  push(titleCol, payload.title);
  push(urlCol, payload.url);

  push(categoryCol, payload.category_id);

  if (visibilityCol) {
    // normalize visibility
    const allowed = new Set(["private", "unlisted", "public"]);
    const v = allowed.has(payload.visibility) ? payload.visibility : "private";
    push(visibilityCol, v);
  }

  if (publishedCol) {
    // Import as draft/unpublished by default
    push(publishedCol, false);
  }

  // only store wasabi metadata if columns exist
  push(providerCol, providerCol ? "wasabi" : undefined);
  push(storageKeyCol, payload.key);
  push(bucketCol, payload.bucket);
  push(regionCol, payload.region);

  if (createdCol) push(createdCol, new Date().toISOString());
  if (updatedCol) push(updatedCol, new Date().toISOString());

  const sql = `
    INSERT INTO videos (${insertCols.join(", ")})
    VALUES (${params.join(", ")})
    RETURNING id
  `;
  const r = await db.query(sql, values);
  return r.rows?.[0] || null;
}

/* -------------------------------------------------------
   ROUTES
-------------------------------------------------------- */

/**
 * GET /api/admin/wasabi/preview?prefix=drm
 */
router.get("/preview", async (req, res) => {
  try {
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");
    const region = mustEnv("WASABI_REGION");

    const prefix = cleanPrefix(req.query.prefix || "");
    const maxKeys = Math.min(200, Math.max(10, Number(req.query.max || 80)));

    let ContinuationToken = undefined;
    let mp4 = 0;
    let png = 0;
    const sample = [];

    for (let pages = 0; pages < 5; pages++) {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
          ContinuationToken,
        }),
      );

      const items = out.Contents || [];
      for (const it of items) {
        const key = it.Key || "";
        const e = extOf(key);
        if (e === "mp4") mp4++;
        if (e === "png") png++;

        if (sample.length < 24) {
          sample.push({
            key,
            size: Number(it.Size || 0),
            lastModified: it.LastModified
              ? new Date(it.LastModified).toISOString()
              : null,
            url: wasabiPublicUrl(bucket, region, key),
          });
        }
      }

      if (!out.IsTruncated || !out.NextContinuationToken) break;
      ContinuationToken = out.NextContinuationToken;
    }

    return res.json({ ok: true, bucket, prefix, counts: { mp4, png }, sample });
  } catch (e) {
    console.error("[adminWasabi] GET /preview error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * GET /api/admin/wasabi/objects?prefix=drm&type=mp4&limit=50&cursor=<token>&q=<search>
 */
router.get("/objects", async (req, res) => {
  try {
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");
    const region = mustEnv("WASABI_REGION");

    const prefix = cleanPrefix(req.query.prefix || "");
    const type = String(req.query.type || "mp4").toLowerCase(); // mp4|png|all
    const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();

    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: limit,
        ContinuationToken: cursor,
      }),
    );

    let items = (out.Contents || []).map((it) => ({
      key: it.Key || "",
      size: Number(it.Size || 0),
      lastModified: it.LastModified
        ? new Date(it.LastModified).toISOString()
        : null,
      url: wasabiPublicUrl(bucket, region, it.Key || ""),
      ext: extOf(it.Key || ""),
    }));

    if (type === "mp4") items = items.filter((x) => x.ext === "mp4");
    if (type === "png") items = items.filter((x) => x.ext === "png");
    if (q) items = items.filter((x) => (x.key || "").toLowerCase().includes(q));

    return res.json({
      ok: true,
      bucket,
      prefix,
      items,
      next_cursor: out.IsTruncated ? out.NextContinuationToken || null : null,
    });
  } catch (e) {
    console.error("[adminWasabi] GET /objects error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * POST /api/admin/wasabi/import
 * Body:
 * {
 *   keys: ["drm/drm/010222....mp4", ...],
 *   category_id: 1 (optional),
 *   visibility: "private" | "unlisted" | "public" (optional, default private),
 *   default_title_mode: "filename" | "filename_no_ext" (optional)
 * }
 */
router.post("/import", async (req, res) => {
  const db = req.db;

  try {
    const bucket = mustEnv("WASABI_BUCKET");
    const region = mustEnv("WASABI_REGION");

    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const category_id = body.category_id ? Number(body.category_id) : null;
    const visibility = String(body.visibility || "private").toLowerCase();
    const titleMode = String(body.default_title_mode || "filename_no_ext");

    if (!keys.length) {
      return res.status(400).json({ ok: false, message: "No keys provided." });
    }

    const mp4Keys = keys.filter((k) => isMp4Key(k));
    if (!mp4Keys.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No MP4 files selected." });
    }

    const cols = await getVideosColumns(db);

    const results = {
      imported: 0,
      skipped: 0,
      errors: 0,
      details: [],
    };

    await db.query("BEGIN");

    for (const key of mp4Keys) {
      try {
        const url = wasabiPublicUrl(bucket, region, key);
        const dup = await findDuplicateVideo(db, cols, url);

        if (dup) {
          results.skipped++;
          results.details.push({
            key,
            status: "skipped",
            reason: "duplicate",
            id: dup.id,
          });
          continue;
        }

        const title = guessTitleFromKey(key, titleMode);

        // Stable hash is nice for logging/debug (not stored unless you add a column yourself)
        crypto.createHash("sha1").update(url).digest("hex");

        const inserted = await insertVideo(db, cols, {
          key,
          url,
          title,
          category_id,
          visibility,
          bucket,
          region,
        });

        results.imported++;
        results.details.push({
          key,
          status: "imported",
          id: inserted?.id || null,
        });
      } catch (err) {
        results.errors++;
        results.details.push({
          key,
          status: "error",
          error: err?.message || "insert failed",
        });
      }
    }

    await db.query("COMMIT");
    return res.json({ ok: true, ...results });
  } catch (e) {
    try {
      if (db) await db.query("ROLLBACK");
    } catch {}
    console.error("[adminWasabi] POST /import error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

module.exports = router;
