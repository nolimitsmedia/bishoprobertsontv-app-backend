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
   Bunny Stream helpers (Option A)
   - Wasabi import goes directly to Bunny Stream
   - No Bunny Storage copy/write is used
========================================================= */
function bunnyStreamEnabled() {
  return !!(
    String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim() &&
    String(process.env.BUNNY_STREAM_API_KEY || "").trim()
  );
}

function bunnyStreamConfig() {
  const libraryId = mustEnv("BUNNY_STREAM_LIBRARY_ID");
  const apiKey = mustEnv("BUNNY_STREAM_API_KEY");

  // Optional. If you know the Stream CDN host, set this in env:
  // BUNNY_STREAM_CDN_HOST=vz-xxxxxx.b-cdn.net
  const cdnHost = String(process.env.BUNNY_STREAM_CDN_HOST || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  return { libraryId, apiKey, cdnHost };
}

function bunnyStreamEmbedUrl({ libraryId, videoId }) {
  return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
}

function bunnyStreamHlsUrl({ cdnHost, videoId }) {
  if (!cdnHost || !videoId) return null;
  return `https://${cdnHost}/${videoId}/playlist.m3u8`;
}

async function signWasabiGetUrl({ s3, bucket, key, expiresIn = 24 * 60 * 60 }) {
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
}

function pickBunnyVideoId(data = {}) {
  return (
    data.id ||
    data.guid ||
    data.videoId ||
    data.video_id ||
    data?.video?.id ||
    data?.video?.guid ||
    null
  );
}

async function fetchWasabiToBunnyStream({ s3, bucket, key, title }) {
  if (!bunnyStreamEnabled()) {
    throw new Error(
      "Bunny Stream is not configured. Missing BUNNY_STREAM_LIBRARY_ID or BUNNY_STREAM_API_KEY.",
    );
  }

  const cfg = bunnyStreamConfig();

  // Bunny Stream fetches the file directly from this signed Wasabi URL.
  // No Bunny Storage upload/copy happens here.
  const sourceUrl = await signWasabiGetUrl({
    s3,
    bucket,
    key,
    expiresIn: 24 * 60 * 60,
  });

  const fetchResp = await axios.post(
    `https://video.bunnycdn.com/library/${cfg.libraryId}/videos/fetch`,
    {
      url: sourceUrl,
      title,
    },
    {
      headers: {
        AccessKey: cfg.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    },
  );

  if (fetchResp.status < 200 || fetchResp.status >= 300) {
    const body =
      typeof fetchResp.data === "string"
        ? fetchResp.data.slice(0, 800)
        : JSON.stringify(fetchResp.data || {}).slice(0, 800);

    throw new Error(
      `Bunny Stream fetch failed (status ${fetchResp.status}). Body=${body}`,
    );
  }

  const videoId = pickBunnyVideoId(fetchResp.data);
  if (!videoId) {
    throw new Error(
      `Bunny Stream fetch did not return a video id. Body=${JSON.stringify(
        fetchResp.data || {},
      ).slice(0, 800)}`,
    );
  }

  return {
    videoId,
    libraryId: cfg.libraryId,
    embedUrl: bunnyStreamEmbedUrl({
      libraryId: cfg.libraryId,
      videoId,
    }),
    hlsUrl: bunnyStreamHlsUrl({
      cdnHost: cfg.cdnHost,
      videoId,
    }),
    sourceUrl,
    raw: fetchResp.data || {},
  };
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
    const importedFilter = String(req.query.imported || "all").toLowerCase(); // all | imported | not_imported
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [`w.prefix = $1`];
    const args = [prefix];
    let ai = 2;

    if (q) {
      // fast because of trigram index
      where.push(`w.key ILIKE $${ai++}`);
      args.push(`%${q}%`);
    }

    // Detect imported items by Wasabi key. This works for Bunny Stream imports
    // and does not depend on old Bunny Storage CDN URLs.
    if (importedFilter === "imported") {
      where.push(`EXISTS (SELECT 1 FROM videos v WHERE v.wasabi_key = w.key)`);
    } else if (importedFilter === "not_imported") {
      where.push(
        `NOT EXISTS (SELECT 1 FROM videos v WHERE v.wasabi_key = w.key)`,
      );
    }

    const orderBy =
      sort === "oldest"
        ? `w.last_modified ASC NULLS LAST, w.key ASC`
        : `w.last_modified DESC NULLS LAST, w.key ASC`;

    const rows = await db.query(
      `
      SELECT w.key, w.size, w.last_modified, w.etag
      FROM wasabi_object_index w
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
        // url is optional for index view. This is the Wasabi object URL,
        // not a Bunny Storage URL.
        url: buildWasabiUrl({
          endpoint: mustEnv("WASABI_ENDPOINT"),
          bucket: mustEnv("WASABI_BUCKET"),
          key: r.key,
        }),
      };
    });

    // detect already imported by Wasabi key, not Bunny Storage CDN URL
    const itemKeys = items.map((x) => x.key).filter(Boolean);
    let importedSet = new Set();

    if (itemKeys.length) {
      const r2 = await db.query(
        `SELECT wasabi_key FROM videos WHERE wasabi_key = ANY($1::text[])`,
        [itemKeys],
      );
      importedSet = new Set((r2.rows || []).map((x) => x.wasabi_key));
    }

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
       FROM wasabi_object_index w
       WHERE ${where.join(" AND ")}`,
      args,
    );
    const total = Number(totalR.rows?.[0]?.c || 0);

    // Optional summary counts for this prefix/search, independent from pagination.
    const summaryWhere = [`w.prefix = $1`];
    const summaryArgs = [prefix];
    let si = 2;
    if (q) {
      summaryWhere.push(`w.key ILIKE $${si++}`);
      summaryArgs.push(`%${q}%`);
    }

    const summaryR = await db.query(
      `
      SELECT
        COUNT(*)::bigint AS total_all,
        COUNT(v.id)::bigint AS imported_count,
        (COUNT(*) - COUNT(v.id))::bigint AS not_imported_count
      FROM wasabi_object_index w
      LEFT JOIN videos v ON v.wasabi_key = w.key
      WHERE ${summaryWhere.join(" AND ")}
      `,
      summaryArgs,
    );

    const summary = summaryR.rows?.[0] || {};

    return res.json({
      ok: true,
      prefix,
      total,
      total_all: Number(summary.total_all || 0),
      imported_count: Number(summary.imported_count || 0),
      not_imported_count: Number(summary.not_imported_count || 0),
      imported_filter: importedFilter,
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
   Health Check
========================================================= */
router.get("/bunny-health", async (req, res) => {
  try {
    const cfg = bunnyStreamConfig();
    const keyLen = cfg.apiKey.length;
    const keyPreview = `${cfg.apiKey.slice(0, 4)}...${cfg.apiKey.slice(-4)}`;

    return res.json({
      ok: true,
      provider: "bunny_stream",
      libraryId: cfg.libraryId,
      cdnHost: cfg.cdnHost || null,
      keyLen,
      keyPreview,
      note: "Bunny Stream is configured. Wasabi imports will be fetched directly into Bunny Stream, not Bunny Storage.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      provider: "bunny_stream",
      message: e.message || "Bunny Stream health check failed",
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
 */
router.post("/import", async (req, res) => {
  let didBegin = false;

  try {
    // Keep long-running Wasabi -> Bunny Stream import requests alive.
    try {
      req.setTimeout?.(0);
      res.setTimeout?.(0);
      req.socket?.setTimeout?.(0);
    } catch (_) {}

    if (!bunnyStreamEnabled()) {
      return res.status(400).json({
        ok: false,
        message:
          "Bunny Stream is not configured. Set BUNNY_STREAM_LIBRARY_ID and BUNNY_STREAM_API_KEY, then restart the server.",
      });
    }

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

    if (!keys.length)
      return res.status(400).json({ ok: false, message: "No keys provided." });

    const mp4Keys = keys.filter((k) => isMp4(k));
    if (!mp4Keys.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No MP4 files selected." });
    }

    const results = {
      ok: true,
      provider: "bunny_stream",
      dryRun,
      mode: dupMode,
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

        let head = null;
        try {
          head = await s3.send(
            new HeadObjectCommand({
              Bucket: bucket,
              Key: key,
            }),
          );
        } catch (_) {
          // non-fatal; Bunny fetch can still proceed if the signed URL works
        }

        const existing = await db.query(
          `SELECT id, bunny_stream_id FROM videos WHERE wasabi_key = $1 LIMIT 1`,
          [key],
        );

        if (existing.rowCount > 0 && dupMode === "skip") {
          results.skipped++;
          results.details.push({
            key,
            status: "skipped",
            reason: "already_imported",
            id: existing.rows[0].id,
            bunny_stream_id: existing.rows[0].bunny_stream_id || null,
          });
          continue;
        }

        if (dryRun) {
          results.details.push({
            key,
            status: "dryRun",
            provider: "bunny_stream",
            title,
            wouldReplace: existing.rowCount > 0,
          });
          continue;
        }

        // Wasabi -> Bunny Stream fetch. No Bunny Storage copy/write.
        const bunny = await fetchWasabiToBunnyStream({
          s3,
          bucket,
          key,
          title,
        });

        const sourceMeta = {
          provider: "bunny_stream",
          filename,
          wasabi_bucket: bucket,
          wasabi_key: key,
          content_type: head?.ContentType || "video/mp4",
          size: Number(head?.ContentLength || 0),
          bunny_stream_id: bunny.videoId,
          bunny_library_id: bunny.libraryId,
          bunny_embed_url: bunny.embedUrl,
          bunny_hls_url: bunny.hlsUrl || null,
          bunny_fetch_response: bunny.raw || null,
          imported_from: "wasabi",
        };

        if (existing.rowCount > 0) {
          const id = existing.rows[0].id;

          await db.query(
            `
            UPDATE videos
            SET
              title = COALESCE($2, title),
              video_url = COALESCE($3, video_url),
              category_id = COALESCE($4, category_id),
              visibility = COALESCE($5, visibility),
              created_by = COALESCE(created_by, $6),
              wasabi_bucket = $7,
              wasabi_key = $8,
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
              bunny.hlsUrl || bunny.embedUrl,
              category_id,
              vis,
              actorUserId,
              bucket,
              key,
              JSON.stringify(sourceMeta),
              bunny.videoId,
              bunny.embedUrl,
              bunny.hlsUrl || null,
            ],
          );

          results.replaced++;
          results.details.push({
            key,
            status: "replaced",
            id,
            provider: "bunny_stream",
            bunny_stream_id: bunny.videoId,
            bunny_embed_url: bunny.embedUrl,
            bunny_hls_url: bunny.hlsUrl || null,
          });
          continue;
        }

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
            bunny.hlsUrl || bunny.embedUrl,
            category_id,
            vis,
            actorUserId,
            bucket,
            key,
            JSON.stringify(sourceMeta),
            bunny.videoId,
            bunny.embedUrl,
            bunny.hlsUrl || null,
          ],
        );

        results.imported++;
        results.details.push({
          key,
          status: "imported",
          id: ins.rows?.[0]?.id || null,
          provider: "bunny_stream",
          bunny_stream_id: bunny.videoId,
          bunny_embed_url: bunny.embedUrl,
          bunny_hls_url: bunny.hlsUrl || null,
        });
      } catch (err) {
        results.errors++;
        results.details.push({
          key,
          status: "error",
          error:
            (err?.response?.data && JSON.stringify(err.response.data)) ||
            err?.message ||
            "Bunny Stream fetch/insert failed",
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
