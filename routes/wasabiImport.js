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

function normalizeComparableText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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

  // Match the rest of the app's Bunny Stream URL format.
  // If you have a custom Stream CDN host, set:
  // BUNNY_STREAM_CDN_HOST=your-stream-host.b-cdn.net
  const cdnHost = String(
    process.env.BUNNY_STREAM_CDN_HOST ||
      process.env.BUNNY_STREAM_PULL_ZONE_URL ||
      `vz-${libraryId}.b-cdn.net`,
  )
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
    data.guid ||
    data.videoId ||
    data.video_id ||
    data.id ||
    data?.video?.guid ||
    data?.video?.videoId ||
    data?.video?.id ||
    null
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bunnyStreamRequest(url, options = {}) {
  const cfg = bunnyStreamConfig();

  const resp = await axios.request({
    url,
    method: options.method || "GET",
    data: options.data,
    headers: {
      AccessKey: cfg.apiKey,
      Accept: "application/json",
      ...(options.data ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    timeout: options.timeout || 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const body =
      typeof resp.data === "string"
        ? resp.data.slice(0, 800)
        : JSON.stringify(resp.data || {}).slice(0, 800);

    throw new Error(`Bunny Stream error ${resp.status}. Body=${body}`);
  }

  return resp.data || {};
}

async function findBunnyVideoByExactTitle(title) {
  const cfg = bunnyStreamConfig();
  const search = encodeURIComponent(title);
  const data = await bunnyStreamRequest(
    `https://video.bunnycdn.com/library/${cfg.libraryId}/videos?page=1&itemsPerPage=100&search=${search}&orderBy=date`,
    { method: "GET" },
  );

  const items = Array.isArray(data?.items) ? data.items : [];
  return (
    items.find((v) => String(v?.title || "") === String(title)) ||
    items.find((v) => String(v?.title || "").includes(String(title))) ||
    null
  );
}

async function updateBunnyVideoTitle(videoId, title) {
  const cfg = bunnyStreamConfig();

  try {
    await bunnyStreamRequest(
      `https://video.bunnycdn.com/library/${cfg.libraryId}/videos/${videoId}`,
      {
        method: "POST",
        data: { title: title || "Untitled" },
      },
    );
  } catch (e) {
    console.warn(
      "[wasabiImport] Could not update Bunny Stream title:",
      e.message,
    );
  }
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

  // Use a temporary unique title so we can reliably find the new Bunny video,
  // then restore the clean title afterward.
  const cleanTitle = String(title || "Untitled").trim() || "Untitled";
  const uniqueTitle = `${cleanTitle} [WASABI-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}]`;

  const fetchData = await bunnyStreamRequest(
    `https://video.bunnycdn.com/library/${cfg.libraryId}/videos/fetch`,
    {
      method: "POST",
      data: {
        url: sourceUrl,
        title: uniqueTitle,
        headers: {},
      },
      timeout: 120000,
    },
  );

  let videoId = pickBunnyVideoId(fetchData);
  let bunnyVideo = videoId ? { guid: videoId, ...fetchData } : null;

  // Some Bunny Stream /fetch responses do not immediately include the GUID.
  // Search for the unique title for up to ~12 seconds.
  if (!videoId) {
    for (let i = 0; i < 12; i += 1) {
      bunnyVideo = await findBunnyVideoByExactTitle(uniqueTitle);
      videoId = pickBunnyVideoId(bunnyVideo || {});
      if (videoId) break;
      await sleep(1000);
    }
  }

  if (!videoId) {
    throw new Error(
      `Bunny Stream fetch started, but the new video id was not found yet. Try again in a minute. Body=${JSON.stringify(
        fetchData || {},
      ).slice(0, 800)}`,
    );
  }

  await updateBunnyVideoTitle(videoId, cleanTitle);

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
    raw: fetchData || bunnyVideo || {},
  };
}

/* =========================================================
   Imported detection helpers
   Detects both new Bunny Stream imports and old Bunny Storage/CDN imports.
========================================================= */
function importedMatchSql(alias = "w") {
  return `
    EXISTS (
      SELECT 1
      FROM videos v
      WHERE
        v.wasabi_key = ${alias}.key
        OR v.source_meta->>'wasabi_key' = ${alias}.key
        OR v.source_meta->>'key' = ${alias}.key
        OR v.source_meta->>'original_key' = ${alias}.key
        OR v.metadata->>'wasabi_key' = ${alias}.key
        OR v.metadata->>'source_key' = ${alias}.key
        OR v.metadata->>'original_key' = ${alias}.key
        OR LOWER(regexp_replace(split_part(COALESCE(v.video_url, ''), '?', 1), '^.*/', '')) =
           LOWER(regexp_replace(${alias}.key, '^.*/', ''))
        OR LOWER(regexp_replace(split_part(COALESCE(v.playback_url, ''), '?', 1), '^.*/', '')) =
           LOWER(regexp_replace(${alias}.key, '^.*/', ''))
        OR regexp_replace(LOWER(COALESCE(v.title, '')), '[^a-z0-9]+', '', 'g') =
           regexp_replace(
             LOWER(regexp_replace(regexp_replace(${alias}.key, '^.*/', ''), '\\.[^.]+$', '')),
             '[^a-z0-9]+',
             '',
             'g'
           )
    )
  `;
}

function importedJoinConditionSql() {
  return `
    (
      v.wasabi_key = w.key
      OR v.source_meta->>'wasabi_key' = w.key
      OR v.source_meta->>'key' = w.key
      OR v.source_meta->>'original_key' = w.key
      OR v.metadata->>'wasabi_key' = w.key
      OR v.metadata->>'source_key' = w.key
      OR v.metadata->>'original_key' = w.key
      OR LOWER(regexp_replace(split_part(COALESCE(v.video_url, ''), '?', 1), '^.*/', '')) =
         LOWER(regexp_replace(w.key, '^.*/', ''))
      OR LOWER(regexp_replace(split_part(COALESCE(v.playback_url, ''), '?', 1), '^.*/', '')) =
         LOWER(regexp_replace(w.key, '^.*/', ''))
      OR regexp_replace(LOWER(COALESCE(v.title, '')), '[^a-z0-9]+', '', 'g') =
         regexp_replace(
           LOWER(regexp_replace(regexp_replace(w.key, '^.*/', ''), '\\.[^.]+$', '')),
           '[^a-z0-9]+',
           '',
           'g'
         )
    )
  `;
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

    const importedExistsSql = importedMatchSql("w");

    const where = [`w.prefix = $1`];
    const args = [prefix];
    let ai = 2;

    if (q) {
      // fast because of trigram index
      where.push(`w.key ILIKE $${ai++}`);
      args.push(`%${q}%`);
    }

    // Multi-method imported detection:
    // - new imports: videos.wasabi_key / source_meta
    // - old imports: video_url/playback_url filename match
    // - fallback: normalized title match
    if (importedFilter === "imported") {
      where.push(importedExistsSql);
    } else if (importedFilter === "not_imported") {
      where.push(`NOT ${importedExistsSql}`);
    }

    const orderBy =
      sort === "oldest"
        ? `w.last_modified ASC NULLS LAST, w.key ASC`
        : `w.last_modified DESC NULLS LAST, w.key ASC`;

    const rows = await db.query(
      `
      SELECT
        w.key,
        w.size,
        w.last_modified,
        w.etag,
        ${importedExistsSql} AS already_imported
      FROM wasabi_object_index w
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${ai++} OFFSET $${ai++}
    `,
      [...args, limit, offset],
    );

    const out = (rows.rows || []).map((r) => {
      const filename = safeFilenameFromKey(r.key);
      return {
        key: r.key,
        size: Number(r.size || 0),
        lastModified: r.last_modified,
        etag: r.etag || null,
        filename,
        alreadyImported: r.already_imported === true,
        // url is optional for index view. This is the Wasabi object URL,
        // not a Bunny Storage URL.
        url: buildWasabiUrl({
          endpoint: mustEnv("WASABI_ENDPOINT"),
          bucket: mustEnv("WASABI_BUCKET"),
          key: r.key,
        }),
      };
    });

    // total count for the active filter
    const totalR = await db.query(
      `SELECT COUNT(*)::bigint AS c
       FROM wasabi_object_index w
       WHERE ${where.join(" AND ")}`,
      args,
    );
    const total = Number(totalR.rows?.[0]?.c || 0);

    // Summary counts for this prefix/search, independent from pagination/filter.
    const summaryWhere = [`w.prefix = $1`];
    const summaryArgs = [prefix];
    let si = 2;
    if (q) {
      summaryWhere.push(`w.key ILIKE $${si++}`);
      summaryArgs.push(`%${q}%`);
    }

    const summaryR = await db.query(
      `
      WITH matched AS (
        SELECT
          w.key,
          ${importedExistsSql} AS already_imported
        FROM wasabi_object_index w
        WHERE ${summaryWhere.join(" AND ")}
      )
      SELECT
        COUNT(*)::bigint AS total_all,
        COUNT(*) FILTER (WHERE already_imported)::bigint AS imported_count,
        COUNT(*) FILTER (WHERE NOT already_imported)::bigint AS not_imported_count
      FROM matched
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

function parsePositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max || n);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const out = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      out[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return out;
}

async function findExistingWasabiVideo(db, key) {
  const filename = safeFilenameFromKey(key);
  const comparableTitle = normalizeComparableText(titleFromKey(key));

  const existing = await db.query(
    `
    SELECT id, bunny_video_id, provider_key
    FROM videos v
    WHERE
      v.wasabi_key = $1
      OR v.source_meta->>'wasabi_key' = $1
      OR v.source_meta->>'key' = $1
      OR v.source_meta->>'original_key' = $1
      OR v.metadata->>'wasabi_key' = $1
      OR v.metadata->>'source_key' = $1
      OR v.metadata->>'original_key' = $1
      OR LOWER(regexp_replace(split_part(COALESCE(v.video_url, ''), '?', 1), '^.*/', '')) = LOWER($2)
      OR LOWER(regexp_replace(split_part(COALESCE(v.playback_url, ''), '?', 1), '^.*/', '')) = LOWER($2)
      OR regexp_replace(LOWER(COALESCE(v.title, '')), '[^a-z0-9]+', '', 'g') = $3
    ORDER BY
      CASE
        WHEN v.wasabi_key = $1 THEN 0
        WHEN LOWER(regexp_replace(split_part(COALESCE(v.video_url, ''), '?', 1), '^.*/', '')) = LOWER($2) THEN 1
        WHEN LOWER(regexp_replace(split_part(COALESCE(v.playback_url, ''), '?', 1), '^.*/', '')) = LOWER($2) THEN 2
        ELSE 3
      END,
      v.id DESC
    LIMIT 1
    `,
    [key, filename, comparableTitle],
  );

  return existing.rows?.[0] || null;
}

/**
 * POST /api/admin/wasabi/import
 * Body supports: { keys:[], visibility, category_id?, default_title_mode?, mode: "skip"|"replace" }
 *
 * Optimized:
 * - no long transaction while Bunny Stream imports run
 * - limited parallel imports via WASABI_IMPORT_CONCURRENCY (default 2, max 5)
 * - still returns the same response shape the admin panel expects
 */
router.post("/import", async (req, res) => {
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

    if (!keys.length) {
      return res.status(400).json({ ok: false, message: "No keys provided." });
    }

    const mp4Keys = keys.filter((k) => isMp4(k));
    if (!mp4Keys.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No MP4 files selected." });
    }

    const concurrency = parsePositiveInt(
      process.env.WASABI_IMPORT_CONCURRENCY || body.concurrency,
      2,
      5,
    );

    const details = await mapWithConcurrency(
      mp4Keys,
      concurrency,
      async (key) => {
        try {
          const filename = safeFilenameFromKey(key);
          const title = titleMode === "filename" ? filename : titleFromKey(key);

          const existing = await findExistingWasabiVideo(db, key);

          if (existing && dupMode === "skip") {
            return {
              key,
              status: "skipped",
              reason: "already_imported",
              id: existing.id,
              bunny_video_id: existing.bunny_video_id || null,
            };
          }

          if (dryRun) {
            return {
              key,
              status: "dryRun",
              provider: "bunny_stream",
              title,
              wouldReplace: !!existing,
              matchedExistingId: existing?.id || null,
            };
          }

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

          // Wasabi -> Bunny Stream fetch. No Bunny Storage copy/write.
          const bunny = await fetchWasabiToBunnyStream({
            s3,
            bucket,
            key,
            title,
          });

          const playbackUrl = bunny.hlsUrl || bunny.embedUrl;
          const importedAt = new Date().toISOString();

          const sourceMeta = {
            provider: "bunny_stream",
            filename,
            wasabi_bucket: bucket,
            wasabi_key: key,
            content_type: head?.ContentType || "video/mp4",
            size: Number(head?.ContentLength || 0),
            bunny_video_id: bunny.videoId,
            bunny_library_id: bunny.libraryId,
            embed_url: bunny.embedUrl,
            playback_url: playbackUrl,
            hls_url: bunny.hlsUrl || null,
            bunny_fetch_response: bunny.raw || null,
            imported_from: "wasabi",
            imported_at: importedAt,
          };

          const metadataPatch = {
            wasabi_import: {
              bucket,
              key,
              filename,
              source: "wasabi",
              imported_at: importedAt,
            },
            bunny_stream_import: {
              bunny_video_id: bunny.videoId,
              bunny_library_id: bunny.libraryId,
              embed_url: bunny.embedUrl,
              playback_url: playbackUrl,
            },
          };

          if (existing) {
            const id = existing.id;

            await db.query(
              `
            UPDATE videos
            SET
              title = COALESCE($2, title),
              video_url = COALESCE($3, video_url),
              playback_url = COALESCE($3, playback_url),
              embed_url = COALESCE($4, embed_url),
              category_id = COALESCE($5, category_id),
              visibility = COALESCE($6, visibility),
              created_by = COALESCE(created_by, $7),
              wasabi_bucket = $8,
              wasabi_key = $9,
              source_type = 'bunny_stream',
              source_meta = $10::jsonb,
              bunny_video_id = $11,
              bunny_library_id = $12,
              provider = 'bunny_stream',
              provider_key = $11,
              processing_status = 'processing',
              metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $13::jsonb,
              updated_at = now()
            WHERE id = $1
          `,
              [
                id,
                title,
                playbackUrl,
                bunny.embedUrl,
                category_id,
                vis,
                actorUserId,
                bucket,
                key,
                JSON.stringify(sourceMeta),
                bunny.videoId,
                bunny.libraryId,
                JSON.stringify(metadataPatch),
              ],
            );

            return {
              key,
              status: "replaced",
              id,
              provider: "bunny_stream",
              bunny_video_id: bunny.videoId,
              embed_url: bunny.embedUrl,
              playback_url: playbackUrl,
            };
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
              bunny_video_id,
              bunny_library_id,
              provider,
              provider_key,
              embed_url,
              playback_url,
              processing_status,
              metadata,
              created_at,
              updated_at
            )
          VALUES
            ($1, $2, $3, $4, FALSE, $5, $6, $7, 'bunny_stream', $8::jsonb, $9, $10, 'bunny_stream', $9, $11, $2, 'processing', $12::jsonb, now(), now())
          RETURNING id
        `,
            [
              title,
              playbackUrl,
              category_id,
              vis,
              actorUserId,
              bucket,
              key,
              JSON.stringify(sourceMeta),
              bunny.videoId,
              bunny.libraryId,
              bunny.embedUrl,
              JSON.stringify(metadataPatch),
            ],
          );

          return {
            key,
            status: "imported",
            id: ins.rows?.[0]?.id || null,
            provider: "bunny_stream",
            bunny_video_id: bunny.videoId,
            embed_url: bunny.embedUrl,
            playback_url: playbackUrl,
          };
        } catch (err) {
          return {
            key,
            status: "error",
            error:
              (err?.response?.data && JSON.stringify(err.response.data)) ||
              err?.message ||
              "Bunny Stream fetch/insert failed",
          };
        }
      },
    );

    const results = {
      ok: true,
      provider: "bunny_stream",
      dryRun,
      mode: dupMode,
      concurrency,
      selected: mp4Keys.length,
      imported: details.filter((d) => d.status === "imported").length,
      replaced: details.filter((d) => d.status === "replaced").length,
      skipped: details.filter((d) => d.status === "skipped").length,
      errors: details.filter((d) => d.status === "error").length,
      details,
    };

    return res.json(results);
  } catch (e) {
    console.error("[wasabiImport] import error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

module.exports = router;
