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
   Bunny Storage helpers
========================================================= */
function bunnyEnabled() {
  return String(process.env.USE_BUNNY_STORAGE || "false") === "true";
}

function encodePath(path = "") {
  return String(path)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function bunnyConfig() {
  const zone = mustEnv("BUNNY_STORAGE_ZONE");
  const apiKey = mustEnv("BUNNY_STORAGE_API_KEY");
  const host = mustEnv("BUNNY_STORAGE_HOST");
  const cdnBase = mustEnv("BUNNY_CDN_BASE_URL");
  const basePath = mustEnv("BUNNY_STORAGE_BASE_PATH");

  const cleanBasePath = String(basePath)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const cleanCdnBase = String(cdnBase).replace(/\/+$/, "");
  const putBase = `https://${host}/${zone}`;

  return {
    zone,
    apiKey,
    host,
    cdnBase: cleanCdnBase,
    basePath: cleanBasePath,
    putBase,
  };
}

async function bunnyGetRange({ destPath }) {
  const { apiKey, putBase } = bunnyConfig();
  const url = `${putBase}/${encodePath(destPath)}`;

  const r = await axios.request({
    method: "GET",
    url,
    headers: {
      AccessKey: apiKey,
      Range: "bytes=0-0",
    },
    responseType: "arraybuffer",
    validateStatus: () => true,
    timeout: 15000,
    maxRedirects: 0,
  });

  return r;
}

async function verifyBunnyStored({ destPath, expectedSize = 0 }) {
  const attempts = 8;
  const delaysMs = [250, 500, 900, 1300, 1800, 2500, 3200, 4000];

  for (let i = 0; i < attempts; i++) {
    const r = await bunnyGetRange({ destPath });

    if (r.status === 401) {
      throw new Error(
        `Bunny verify failed (401) – Bunny rejected AccessKey for ${destPath}`,
      );
    }

    if (r.status === 200 || r.status === 206) {
      const cr = r.headers?.["content-range"];
      let totalFromRange = 0;
      if (cr && typeof cr === "string" && cr.includes("/")) {
        const total = cr.split("/").pop();
        totalFromRange = Number(total) || 0;
      }
      const contentLen = Number(r.headers?.["content-length"] || 0);

      const totalSize =
        totalFromRange || (contentLen === 1 ? expectedSize : contentLen) || 0;

      if (expectedSize && totalFromRange && totalFromRange !== expectedSize) {
        throw new Error(
          `Bunny size mismatch (expected ${expectedSize}, got ${totalFromRange}) for ${destPath}`,
        );
      }

      return { ok: true, size: totalSize };
    }

    if (r.status === 404) {
      const wait = delaysMs[i] || 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    throw new Error(`Bunny verify failed (status ${r.status}) for ${destPath}`);
  }

  throw new Error(
    `Bunny verify failed (not found after retries) for ${destPath}`,
  );
}

async function copyWasabiToBunny({ s3, bucket, key }) {
  const { apiKey, cdnBase, basePath, putBase } = bunnyConfig();

  const filename = safeFilenameFromKey(key);
  const destPath = `${basePath}/${filename}`;
  const cdnUrl = `${cdnBase}/${destPath}`;

  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const contentType = head.ContentType || "video/mp4";
  const contentLength = Number(head.ContentLength || 0);

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const stream = obj.Body;
  if (!stream) throw new Error("Wasabi GetObject returned empty Body stream");

  const putUrl = `${putBase}/${encodePath(destPath)}`;

  const putResp = await axios.put(putUrl, stream, {
    headers: {
      AccessKey: apiKey,
      "Content-Type": contentType,
      ...(contentLength ? { "Content-Length": contentLength } : {}),
    },
    timeout: 2 * 60 * 60 * 1000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
    maxRedirects: 0,
  });

  const okCodes = new Set([200, 201, 204]);
  if (!okCodes.has(putResp.status)) {
    const body =
      typeof putResp.data === "string"
        ? putResp.data.slice(0, 500)
        : JSON.stringify(putResp.data || {}).slice(0, 500);

    throw new Error(
      `Bunny upload failed (status ${putResp.status}). Body=${body}`,
    );
  }

  const v = await verifyBunnyStored({ destPath, expectedSize: contentLength });

  return {
    destPath,
    cdnUrl,
    uploadedBytes: v.size || contentLength || 0,
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

    // Need Bunny config to compute cdnUrl used by videos.video_url
    // (used to detect already imported)
    const bunny = bunnyConfig();

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
      const destPath = `${bunny.basePath}/${filename}`;
      const cdnUrl = `${bunny.cdnBase}/${destPath}`;
      return {
        key: r.key,
        size: Number(r.size || 0),
        lastModified: r.last_modified,
        etag: r.etag || null,
        filename,
        cdnUrl,
        // url is optional for index view (open in Wasabi uses signed/endpoint URL),
        // we keep a usable "wasabi-http" style URL consistent with earlier UI:
        url: buildWasabiUrl({
          endpoint: mustEnv("WASABI_ENDPOINT"),
          bucket: mustEnv("WASABI_BUCKET"),
          key: r.key,
        }),
      };
    });

    // detect already imported by exact CDN URL match
    const cdnUrls = items.map((x) => x.cdnUrl).filter(Boolean);
    let importedSet = new Set();

    if (cdnUrls.length) {
      const r2 = await db.query(
        `SELECT video_url FROM videos WHERE video_url = ANY($1::text[])`,
        [cdnUrls],
      );
      importedSet = new Set((r2.rows || []).map((x) => x.video_url));
    }

    const out = items.map((x) => ({
      key: x.key,
      size: x.size,
      lastModified: x.lastModified,
      url: x.url,
      alreadyImported: importedSet.has(x.cdnUrl),
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
   Health Check
========================================================= */
router.get("/bunny-health", async (req, res) => {
  try {
    const cfg = bunnyConfig();
    const keyLen = cfg.apiKey.length;
    const keyPreview = `${cfg.apiKey.slice(0, 4)}...${cfg.apiKey.slice(-4)}`;

    const fake = `${cfg.basePath}/__healthcheck__does_not_exist__.txt`;
    const r = await bunnyGetRange({ destPath: fake });

    return res.json({
      ok: true,
      zone: cfg.zone,
      host: cfg.host,
      putBase: cfg.putBase,
      basePath: cfg.basePath,
      keyLen,
      keyPreview,
      testedPath: fake,
      testedUrl: `${cfg.putBase}/${encodePath(fake)}`,
      status: r.status,
      note:
        r.status === 401
          ? "401 = Bunny rejected AccessKey (wrong Storage password/API key)."
          : r.status === 404
            ? "404 = AccessKey accepted (file missing as expected). ✅"
            : `Status ${r.status} = AccessKey accepted, but response differs from expected.`,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
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
 */
router.post("/import", async (req, res) => {
  let didBegin = false;

  try {
    if (!bunnyEnabled()) {
      return res.status(400).json({
        ok: false,
        message:
          "USE_BUNNY_STORAGE is false. Set USE_BUNNY_STORAGE=true and restart server.",
      });
    }

    bunnyConfig();

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

        if (dryRun) {
          const { cdnBase, basePath } = bunnyConfig();
          const destPath = `${basePath}/${filename}`;
          const cdnUrl = `${cdnBase}/${destPath}`;
          results.details.push({
            key,
            status: "dryRun",
            title,
            bunny_path: destPath,
            video_url: cdnUrl,
          });
          continue;
        }

        // Upload to Bunny (PUT overwrites by path)
        const { cdnUrl, destPath, uploadedBytes } = await copyWasabiToBunny({
          s3,
          bucket,
          key,
        });

        // Duplicate detection is by video_url (since Bunny path is filename)
        const dup = await db.query(
          `SELECT id FROM videos WHERE video_url = $1 LIMIT 1`,
          [cdnUrl],
        );

        if (dup.rowCount > 0) {
          if (dupMode === "skip") {
            results.skipped++;
            results.details.push({
              key,
              status: "skipped",
              reason: "already_imported",
              video_url: cdnUrl,
              bunny_path: destPath,
            });
            continue;
          }

          // replace mode: update existing row
          await db.query(
            `
            UPDATE videos
            SET
              title = COALESCE($2, title),
              category_id = COALESCE($3, category_id),
              visibility = COALESCE($4, visibility),
              updated_at = now()
            WHERE id = $1
          `,
            [dup.rows[0].id, title, category_id, vis],
          );

          results.replaced++;
          results.details.push({
            key,
            status: "replaced",
            id: dup.rows[0].id,
            video_url: cdnUrl,
            bunny_path: destPath,
            bytes: uploadedBytes,
          });
          continue;
        }

        const ins = await db.query(
          `
          INSERT INTO videos
            (title, video_url, category_id, visibility, is_published, created_at, updated_at)
          VALUES
            ($1, $2, $3, $4, FALSE, now(), now())
          RETURNING id
        `,
          [title, cdnUrl, category_id, vis],
        );

        results.imported++;
        results.details.push({
          key,
          status: "imported",
          id: ins.rows?.[0]?.id || null,
          video_url: cdnUrl,
          bunny_path: destPath,
          bytes: uploadedBytes,
        });
      } catch (err) {
        results.errors++;
        results.details.push({
          key,
          status: "error",
          error:
            (err?.response?.data && JSON.stringify(err.response.data)) ||
            err?.message ||
            "copy/insert failed",
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
