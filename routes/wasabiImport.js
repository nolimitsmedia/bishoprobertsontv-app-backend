// server-api/routes/wasabiImport.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

/* =========================================================
   Helpers
========================================================= */
function mustEnv(name) {
  const raw = process.env[name];
  const v = (raw ?? "").toString().trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normPrefix(p) {
  if (!p) return "";
  let x = String(p).trim();
  x = x.replace(/^\/+/, "");
  x = x.replace(/\/{2,}/g, "/");
  x = x.replace(/\/+$/, "");
  return x;
}

function resolveWasabiPrefix(uiPrefixRaw) {
  const ui = normPrefix(uiPrefixRaw);
  const env = normPrefix(process.env.WASABI_IMPORT_PREFIX || "");
  let finalPrefix = ui || env;

  // Auto-collapse: "x/x" -> "x"
  const m = finalPrefix.match(/^([^/]+)\/\1(?:\/|$)/);
  if (m && m[1]) {
    finalPrefix = finalPrefix.replace(new RegExp(`^${m[1]}/${m[1]}`), m[1]);
  }

  finalPrefix = normPrefix(finalPrefix);
  if (!finalPrefix) return "";
  return finalPrefix.endsWith("/") ? finalPrefix : `${finalPrefix}/`;
}

function isMp4(key = "") {
  return String(key).toLowerCase().endsWith(".mp4");
}
function isPng(key = "") {
  return String(key).toLowerCase().endsWith(".png");
}

function safeFilenameFromKey(key = "") {
  const filename = String(key).split("/").pop() || key;
  return filename.replace(/[^\w.\-() ]+/g, "_");
}

function titleFromKey(key = "") {
  const file = safeFilenameFromKey(key);
  const noExt = file.replace(/\.[^/.]+$/, "");
  return noExt.replace(/[_-]+/g, " ").trim();
}

function buildWasabiUrl({ endpoint, bucket, key }) {
  const base = String(endpoint).replace(/\/+$/, "");
  return `${base}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function getS3() {
  const endpoint = mustEnv("WASABI_ENDPOINT");
  const region = process.env.WASABI_REGION || "us-east-1";

  return new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId: mustEnv("WASABI_ACCESS_KEY_ID"),
      secretAccessKey: mustEnv("WASABI_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
}

/* =========================================================
   Bunny Stream helpers (Wasabi → Bunny Stream only)
   Replaces the old Bunny Storage copy flow.
========================================================= */
function bunnyStreamConfig() {
  const libraryId = mustEnv("BUNNY_STREAM_LIBRARY_ID");
  const apiKey = mustEnv("BUNNY_STREAM_API_KEY");

  // Optional. If not set, hlsUrl will be null and playback can use embedUrl.
  // Example: vz-xxxxxxx.b-cdn.net
  const cdnHost = (process.env.BUNNY_STREAM_CDN_HOST || "")
    .toString()
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  return {
    libraryId,
    apiKey,
    cdnHost,
    apiBase: `https://video.bunnycdn.com/library/${libraryId}`,
  };
}

function bunnyStreamUrls({ libraryId, videoId, cdnHost = "" }) {
  return {
    videoId,
    embedUrl: `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`,
    hlsUrl: cdnHost ? `https://${cdnHost}/${videoId}/playlist.m3u8` : null,
  };
}

/**
 * Bunny Stream fetch API:
 * Wasabi URL → Bunny Stream
 *
 * This does NOT upload to Bunny Storage.
 * It asks Bunny Stream to fetch the file directly from a remote URL.
 */
async function fetchWasabiIntoBunnyStream({ fileUrl, title }) {
  const cfg = bunnyStreamConfig();

  const response = await axios.post(
    `${cfg.apiBase}/videos/fetch`,
    {
      url: fileUrl,
      title,
    },
    {
      headers: {
        AccessKey: cfg.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    },
  );

  if (response.status < 200 || response.status >= 300) {
    const body =
      typeof response.data === "string"
        ? response.data.slice(0, 500)
        : JSON.stringify(response.data || {}).slice(0, 500);

    throw new Error(
      `Bunny Stream fetch failed (status ${response.status}). Body=${body}`,
    );
  }

  const data = response.data || {};
  const videoId = data.id || data.videoId || data.guid;

  if (!videoId) {
    throw new Error(
      `Bunny Stream fetch did not return a video id. Body=${JSON.stringify(
        data,
      ).slice(0, 500)}`,
    );
  }

  return {
    ...bunnyStreamUrls({
      libraryId: cfg.libraryId,
      videoId,
      cdnHost: cfg.cdnHost,
    }),
    raw: data,
  };
}

async function getWasabiFetchUrl({ s3, bucket, key }) {
  const endpoint = mustEnv("WASABI_ENDPOINT");

  // Default: use a normal Wasabi HTTP URL. This works if the object/bucket
  // is public or Bunny can access it.
  //
  // If your Wasabi bucket is private, set:
  // WASABI_STREAM_FETCH_URL_MODE=signed
  //
  // This creates a temporary signed URL for Bunny Stream to fetch.
  const mode = String(process.env.WASABI_STREAM_FETCH_URL_MODE || "public")
    .trim()
    .toLowerCase();

  if (mode !== "signed") {
    return buildWasabiUrl({
      endpoint,
      bucket,
      key,
    });
  }

  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

  const expiresIn = Math.max(
    300,
    Math.min(604800, Number(process.env.WASABI_STREAM_SIGNED_URL_TTL || 86400)),
  );

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
}

async function findExistingVideoByWasabiKey(db, key) {
  try {
    const r = await db.query(
      `SELECT id FROM videos WHERE wasabi_key = $1 LIMIT 1`,
      [key],
    );
    return r.rows?.[0] || null;
  } catch (e) {
    // If a very old DB does not have wasabi_key yet, do not break the import.
    if (e.code === "42703") return null;
    throw e;
  }
}

async function findImportedWasabiKeys(db, keys = []) {
  if (!keys.length) return new Set();

  try {
    const r = await db.query(
      `SELECT wasabi_key FROM videos WHERE wasabi_key = ANY($1::text[])`,
      [keys],
    );
    return new Set((r.rows || []).map((x) => x.wasabi_key).filter(Boolean));
  } catch (e) {
    if (e.code === "42703") return new Set();
    throw e;
  }
}

async function insertVideoStreamRow({
  db,
  title,
  stream,
  category_id,
  visibility,
  actorUserId,
  bucket,
  key,
  sourceMeta,
}) {
  const videoUrl = stream.hlsUrl || stream.embedUrl || null;

  try {
    const ins = await db.query(
      `
      INSERT INTO videos
        (
          title,
          video_url,
          category_id,
          visibility,
          is_published,
          created_by,
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
      VALUES
        ($1, $2, $3, $4, FALSE, $5, $6, $7, 'bunny_stream', $8::jsonb, $9, $10, $11, now(), now())
      RETURNING id
      `,
      [
        title,
        videoUrl,
        category_id,
        visibility,
        actorUserId,
        bucket,
        key,
        JSON.stringify(sourceMeta || {}),
        stream.videoId,
        stream.embedUrl,
        stream.hlsUrl,
      ],
    );

    return ins.rows?.[0]?.id || null;
  } catch (e) {
    // Backward-compatible fallback for older videos table.
    if (e.code !== "42703") throw e;

    const ins = await db.query(
      `
      INSERT INTO videos
        (title, video_url, category_id, visibility, is_published, created_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, FALSE, $5, now(), now())
      RETURNING id
      `,
      [title, videoUrl, category_id, visibility, actorUserId],
    );

    return ins.rows?.[0]?.id || null;
  }
}

async function updateVideoStreamRow({
  db,
  id,
  title,
  stream,
  category_id,
  visibility,
  actorUserId,
  bucket,
  key,
  sourceMeta,
}) {
  const videoUrl = stream.hlsUrl || stream.embedUrl || null;

  try {
    await db.query(
      `
      UPDATE videos
      SET
        title = COALESCE($2, title),
        video_url = COALESCE($3, video_url),
        category_id = COALESCE($4, category_id),
        visibility = COALESCE($5, visibility),
        created_by = COALESCE(created_by, $6),
        wasabi_bucket = COALESCE($7, wasabi_bucket),
        wasabi_key = COALESCE($8, wasabi_key),
        source_type = 'bunny_stream',
        source_meta = $9::jsonb,
        bunny_stream_id = $10,
        bunny_embed_url = $11,
        bunny_hls_url = $12,
        updated_at = now()
      WHERE id = $1
      `,
      [
        id,
        title,
        videoUrl,
        category_id,
        visibility,
        actorUserId,
        bucket,
        key,
        JSON.stringify(sourceMeta || {}),
        stream.videoId,
        stream.embedUrl,
        stream.hlsUrl,
      ],
    );
  } catch (e) {
    if (e.code !== "42703") throw e;

    await db.query(
      `
      UPDATE videos
      SET
        title = COALESCE($2, title),
        video_url = COALESCE($3, video_url),
        category_id = COALESCE($4, category_id),
        visibility = COALESCE($5, visibility),
        created_by = COALESCE(created_by, $6),
        updated_at = now()
      WHERE id = $1
      `,
      [id, title, videoUrl, category_id, visibility, actorUserId],
    );
  }
}

/* =========================================================
   NEW: Wasabi → DB Indexing (real solution)
========================================================= */

function stripTrailingSlash(prefixWithSlash = "") {
  const p = String(prefixWithSlash || "");
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

async function ensureIndexTables(db) {
  // in case migration wasn't run yet, we fail with a readable error
  await db.query(`SELECT 1 FROM wasabi_object_index LIMIT 1;`);
  await db.query(`SELECT 1 FROM wasabi_index_state LIMIT 1;`);
}

async function syncWasabiIndex({ db, prefixWithSlash, full = false }) {
  await ensureIndexTables(db);

  const s3 = getS3();
  const bucket = mustEnv("WASABI_BUCKET");
  const endpoint = mustEnv("WASABI_ENDPOINT");

  const prefixForS3 = prefixWithSlash || ""; // include trailing slash when non-empty
  const prefixForDb = stripTrailingSlash(prefixForS3); // stored without trailing slash

  let token = undefined;
  let scanned = 0;

  // If incremental sync desired later, you could store continuation token;
  // for 5,000 objects, a full sync is cheap and simplest.
  // We'll full-scan the prefix every time.
  const startedAt = Date.now();

  try {
    let hasMore = true;
    while (hasMore) {
      const r = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefixForS3,
          MaxKeys: 1000,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );

      const rows = [];
      for (const it of r.Contents || []) {
        const key = it.Key || "";
        if (!key) continue;
        if (!isMp4(key)) continue; // index only mp4 for this UI

        rows.push({
          prefix: prefixForDb,
          key,
          size: Number(it.Size || 0),
          last_modified: it.LastModified ? new Date(it.LastModified) : null,
          etag: (it.ETag || "").toString().replace(/"/g, "") || null,
        });
      }

      // upsert in chunks
      if (rows.length) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of rows) {
          params.push(
            row.prefix,
            row.key,
            row.size,
            row.last_modified,
            row.etag,
          );
          values.push(
            `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now())`,
          );
        }

        await db.query(
          `
          INSERT INTO wasabi_object_index
            (prefix, key, size, last_modified, etag, updated_at)
          VALUES
            ${values.join(",")}
          ON CONFLICT (prefix, key) DO UPDATE SET
            size = EXCLUDED.size,
            last_modified = EXCLUDED.last_modified,
            etag = EXCLUDED.etag,
            updated_at = now()
        `,
          params,
        );

        scanned += rows.length;
      }

      token = r.IsTruncated ? r.NextContinuationToken : undefined;
      hasMore = !!token;
    }

    const now = new Date();

    await db.query(
      `
      INSERT INTO wasabi_index_state
        (prefix, last_sync_at, last_full_sync_at, synced_count, last_error, updated_at)
      VALUES
        ($1, $2, $3, $4, NULL, now())
      ON CONFLICT (prefix) DO UPDATE SET
        last_sync_at = EXCLUDED.last_sync_at,
        last_full_sync_at = EXCLUDED.last_full_sync_at,
        synced_count = EXCLUDED.synced_count,
        last_error = NULL,
        updated_at = now()
    `,
      [prefixForDb, now, now, scanned],
    );

    return {
      ok: true,
      prefix: prefixForDb,
      bucket,
      endpoint,
      indexed: scanned,
      ms: Date.now() - startedAt,
    };
  } catch (e) {
    await db.query(
      `
      INSERT INTO wasabi_index_state
        (prefix, last_sync_at, last_full_sync_at, synced_count, last_error, updated_at)
      VALUES
        ($1, NULL, NULL, 0, $2, now())
      ON CONFLICT (prefix) DO UPDATE SET
        last_error = $2,
        updated_at = now()
    `,
      [stripTrailingSlash(prefixForS3), e.message || "sync failed"],
    );

    throw e;
  }
}

/**
 * GET /api/admin/wasabi/index/status?prefix=drm
 */
router.get("/index/status", async (req, res) => {
  try {
    const db = req.db;
    await ensureIndexTables(db);

    const prefix = stripTrailingSlash(
      resolveWasabiPrefix(req.query.prefix || ""),
    );
    const r = await db.query(
      `SELECT prefix, last_sync_at, last_full_sync_at, synced_count, last_error, updated_at
       FROM wasabi_index_state
       WHERE prefix = $1`,
      [prefix],
    );

    return res.json({
      ok: true,
      prefix,
      status: r.rows?.[0] || null,
    });
  } catch (e) {
    console.error("[wasabiIndex] status error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * POST /api/admin/wasabi/index/sync
 * Body: { prefix?: "drm" }
 * Full sync is cheap for 5k, so this runs synchronously.
 */
router.post("/index/sync", async (req, res) => {
  try {
    const db = req.db;
    const prefixWithSlash = resolveWasabiPrefix(
      (req.body || {}).prefix || req.query.prefix || "",
    );

    const out = await syncWasabiIndex({
      db,
      prefixWithSlash,
      full: true,
    });

    return res.json(out);
  } catch (e) {
    console.error("[wasabiIndex] sync error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Sync failed" });
  }
});

/**
 * GET /api/admin/wasabi/index?prefix=drm&q=...&limit=100&offset=0&sort=newest|oldest
 * Returns indexed objects with true newest/oldest ordering.
 * Also returns already_imported by matching Bunny CDN URL in videos table.
 */
router.get("/index", async (req, res) => {
  try {
    const db = req.db;
    await ensureIndexTables(db);

    const prefix = stripTrailingSlash(
      resolveWasabiPrefix(req.query.prefix || ""),
    );
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const sort = String(req.query.sort || "newest").toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [`prefix = $1`];
    const args = [prefix];
    let ai = 2;

    if (q) {
      // fast because of trigram index
      where.push(`key ILIKE $${ai++}`);
      args.push(`%${q}%`);
    }

    const orderBy =
      sort === "oldest"
        ? `last_modified ASC NULLS LAST, key ASC`
        : `last_modified DESC NULLS LAST, key ASC`;

    const rows = await db.query(
      `
      SELECT key, size, last_modified, etag
      FROM wasabi_object_index
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${ai++} OFFSET $${ai++}
    `,
      [...args, limit, offset],
    );

    const items = (rows.rows || []).map((r) => {
      const filename = safeFilenameFromKey(r.key);
      return {
        key: r.key,
        size: Number(r.size || 0),
        lastModified: r.last_modified,
        etag: r.etag || null,
        filename,
        // url is only for admin preview/open. Import uses Bunny Stream fetch.
        url: buildWasabiUrl({
          endpoint: mustEnv("WASABI_ENDPOINT"),
          bucket: mustEnv("WASABI_BUCKET"),
          key: r.key,
        }),
      };
    });

    // Detect already imported by Wasabi key, not Bunny Storage CDN URL.
    const keys = items.map((x) => x.key).filter(Boolean);
    const importedSet = await findImportedWasabiKeys(db, keys);

    const out = items.map((x) => ({
      key: x.key,
      size: x.size,
      lastModified: x.lastModified,
      url: x.url,
      alreadyImported: importedSet.has(x.key),
      filename: x.filename,
    }));

    // total count (for UI “showing X of Y”)
    const totalR = await db.query(
      `SELECT COUNT(*)::bigint AS c
       FROM wasabi_object_index
       WHERE ${where.join(" AND ")}`,
      args,
    );
    const total = Number(totalR.rows?.[0]?.c || 0);

    return res.json({
      ok: true,
      prefix,
      total,
      limit,
      offset,
      items: out,
    });
  } catch (e) {
    console.error("[wasabiIndex] query error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/* =========================================================
   Bunny Stream Health Check
========================================================= */
router.get("/bunny-health", async (_req, res) => {
  try {
    const cfg = bunnyStreamConfig();

    const r = await axios.get(`${cfg.apiBase}/videos?page=1&itemsPerPage=1`, {
      headers: {
        AccessKey: cfg.apiKey,
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (r.status < 200 || r.status >= 300) {
      return res.status(500).json({
        ok: false,
        mode: "bunny_stream",
        libraryId: cfg.libraryId,
        status: r.status,
        message:
          typeof r.data === "string"
            ? r.data.slice(0, 500)
            : JSON.stringify(r.data || {}).slice(0, 500),
      });
    }

    return res.json({
      ok: true,
      mode: "bunny_stream",
      libraryId: cfg.libraryId,
      cdnHost: cfg.cdnHost || null,
      note: "Bunny Stream API key accepted.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      mode: "bunny_stream",
      message: e.message || "health check failed",
    });
  }
});

/* =========================================================
   Existing Routes (kept for compatibility)
========================================================= */

/**
 * GET /api/admin/wasabi/objects?prefix=drm&type=mp4&limit=50&cursor=...&q=...
 * (legacy listing; UI should use /index now)
 */
router.get("/objects", async (req, res) => {
  try {
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");
    const endpoint = mustEnv("WASABI_ENDPOINT");

    const prefix = resolveWasabiPrefix(req.query.prefix);
    const type = String(req.query.type || "mp4").toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    let token = String(req.query.cursor || "") || undefined;

    const items = [];
    const MAX_PAGES = 30;
    const PAGE_SIZE = 1000;

    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: PAGE_SIZE,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );

      for (const it of r.Contents || []) {
        const key = it.Key || "";
        if (!key) continue;

        if (type === "mp4" && !isMp4(key)) continue;
        if (type === "png" && !isPng(key)) continue;

        if (q) {
          const file = (key.split("/").pop() || "").toLowerCase();
          if (!file.includes(q)) continue;
        }

        items.push({
          key,
          size: it.Size || 0,
          lastModified: it.LastModified || null,
          url: buildWasabiUrl({ endpoint, bucket, key }),
        });

        if (items.length >= limit) break;
      }

      if (items.length >= limit) {
        return res.json({
          ok: true,
          bucket,
          prefix,
          items,
          next_cursor: r.IsTruncated ? r.NextContinuationToken : null,
        });
      }

      if (!r.IsTruncated) {
        return res.json({
          ok: true,
          bucket,
          prefix,
          items,
          next_cursor: null,
        });
      }

      token = r.NextContinuationToken;
    }

    return res.json({
      ok: true,
      bucket,
      prefix,
      items,
      next_cursor: token || null,
      warning: "Reached scan limit while searching for matching files.",
    });
  } catch (e) {
    console.error("[wasabiImport] objects error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * GET /api/admin/wasabi/preview?prefix=drm
 */
router.get("/preview", async (req, res) => {
  try {
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");
    const endpoint = mustEnv("WASABI_ENDPOINT");
    const prefix = resolveWasabiPrefix(req.query.prefix);

    let token = undefined;
    let mp4Count = 0;
    let pngCount = 0;
    const sample = [];

    do {
      const r = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );

      for (const it of r.Contents || []) {
        const key = it.Key || "";
        if (!key) continue;

        if (isMp4(key)) mp4Count += 1;
        else if (isPng(key)) pngCount += 1;

        if (sample.length < 25 && (isMp4(key) || isPng(key))) {
          sample.push({
            key,
            size: it.Size || 0,
            lastModified: it.LastModified || null,
            url: buildWasabiUrl({ endpoint, bucket, key }),
          });
        }
      }

      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);

    return res.json({
      ok: true,
      bucket,
      prefix,
      counts: { mp4: mp4Count, png: pngCount },
      sample,
    });
  } catch (e) {
    console.error("[wasabiImport] preview error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * POST /api/admin/wasabi/import
 * Body supports: { keys:[], visibility, category_id?, default_title_mode?, mode: "skip"|"replace" }
 *
 * Option A:
 * Wasabi → Bunny Stream only.
 * No Bunny Storage upload/copy is performed.
 */
router.post("/import", async (req, res) => {
  let didBegin = false;

  try {
    // Keep long-running import requests alive.
    try {
      req.setTimeout?.(0);
      res.setTimeout?.(0);
      req.socket?.setTimeout?.(0);
    } catch (_) {}

    // Require Bunny Stream credentials for this import route.
    bunnyStreamConfig();

    const db = req.db;
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");

    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const dryRun = !!body.dryRun;

    const mode = String(body.mode || "replace").toLowerCase(); // replace | skip
    const dupMode = mode === "skip" ? "skip" : "replace";

    const category_id = String(body.category_id || "").trim()
      ? Number(body.category_id)
      : null;

    const visibility = String(body.visibility || "private").toLowerCase();
    const allowedVis = new Set(["private", "unlisted", "public"]);
    const vis = allowedVis.has(visibility) ? visibility : "private";

    const actorUserId = req.user?.id
      ? Number(req.user.id) || req.user.id
      : null;

    const titleMode = String(body.default_title_mode || "filename_no_ext");

    if (!keys.length) {
      return res.status(400).json({ ok: false, message: "No keys provided." });
    }

    const mp4Keys = keys.filter((k) => isMp4(k));
    if (!mp4Keys.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No MP4 files selected." });
    }

    const results = {
      ok: true,
      dryRun,
      mode: dupMode,
      destination: "bunny_stream",
      selected: mp4Keys.length,
      imported: 0,
      replaced: 0,
      skipped: 0,
      errors: 0,
      details: [],
    };

    await db.query("BEGIN");
    didBegin = true;

    for (const key of mp4Keys) {
      try {
        const filename = safeFilenameFromKey(key);
        const title = titleMode === "filename" ? filename : titleFromKey(key);

        const existing = await findExistingVideoByWasabiKey(db, key);

        if (existing && dupMode === "skip") {
          results.skipped++;
          results.details.push({
            key,
            status: "skipped",
            reason: "already_imported",
            id: existing.id,
          });
          continue;
        }

        const fetchUrl = await getWasabiFetchUrl({ s3, bucket, key });

        if (dryRun) {
          results.details.push({
            key,
            status: "dryRun",
            title,
            destination: "bunny_stream",
            fetch_url_mode: String(
              process.env.WASABI_STREAM_FETCH_URL_MODE || "public",
            ).toLowerCase(),
            existing_id: existing?.id || null,
            action: existing
              ? dupMode === "replace"
                ? "replace"
                : "skip"
              : "import",
          });
          continue;
        }

        const stream = await fetchWasabiIntoBunnyStream({
          fileUrl: fetchUrl,
          title,
        });

        const sourceMeta = {
          filename,
          size: null,
          imported_from: "wasabi",
          wasabi_key: key,
          bunny_stream_id: stream.videoId,
          bunny_fetch_response: stream.raw || null,
        };

        if (existing && dupMode === "replace") {
          await updateVideoStreamRow({
            db,
            id: existing.id,
            title,
            stream,
            category_id,
            visibility: vis,
            actorUserId,
            bucket,
            key,
            sourceMeta,
          });

          results.replaced++;
          results.details.push({
            key,
            status: "replaced",
            id: existing.id,
            destination: "bunny_stream",
            bunny_stream_id: stream.videoId,
            bunny_embed_url: stream.embedUrl,
            bunny_hls_url: stream.hlsUrl,
          });
          continue;
        }

        const id = await insertVideoStreamRow({
          db,
          title,
          stream,
          category_id,
          visibility: vis,
          actorUserId,
          bucket,
          key,
          sourceMeta,
        });

        results.imported++;
        results.details.push({
          key,
          status: "imported",
          id,
          destination: "bunny_stream",
          bunny_stream_id: stream.videoId,
          bunny_embed_url: stream.embedUrl,
          bunny_hls_url: stream.hlsUrl,
        });
      } catch (err) {
        results.errors++;
        results.details.push({
          key,
          status: "error",
          error:
            (err?.response?.data && JSON.stringify(err.response.data)) ||
            err?.message ||
            "Bunny Stream import failed",
        });
      }
    }

    await db.query("COMMIT");
    didBegin = false;

    return res.json(results);
  } catch (e) {
    try {
      if (didBegin && req.db) await req.db.query("ROLLBACK");
    } catch {}
    console.error("[wasabiImport] import error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

module.exports = router;
