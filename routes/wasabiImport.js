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

/**
 * Normalizes a prefix/folder (NOT adding trailing slash).
 * - trims
 * - removes leading slashes
 * - collapses multiple slashes
 * - removes trailing slashes
 */
function normPrefix(p) {
  if (!p) return "";
  let x = String(p).trim();

  // Remove leading slashes
  x = x.replace(/^\/+/, "");

  // Collapse multiple slashes
  x = x.replace(/\/{2,}/g, "/");

  // Remove trailing slashes
  x = x.replace(/\/+$/, "");

  return x;
}

/**
 * Resolve the effective prefix.
 * Rules:
 * - Prefer UI prefix (req.query.prefix) if provided (non-empty after trim).
 * - Otherwise fall back to ENV WASABI_IMPORT_PREFIX.
 * - Auto-collapse duplicate top folder: "drm/drm" => "drm"
 * - Return "" to list whole bucket.
 * - If non-empty, ensure trailing slash for S3 Prefix matching.
 */
function resolveWasabiPrefix(uiPrefixRaw) {
  const ui = normPrefix(uiPrefixRaw);
  const env = normPrefix(process.env.WASABI_IMPORT_PREFIX || "");

  let finalPrefix = ui || env;

  // Auto-collapse: "x/x" -> "x" (fixes drm/drm confusion)
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
   Routes
========================================================= */

/**
 * GET /api/admin/wasabi/objects?prefix=drm&type=mp4&limit=50&cursor=...&q=...
 */
router.get("/objects", async (req, res) => {
  try {
    const s3 = getS3();
    const bucket = mustEnv("WASABI_BUCKET");
    const endpoint = mustEnv("WASABI_ENDPOINT");

    const prefix = resolveWasabiPrefix(req.query.prefix);
    const type = String(req.query.type || "mp4").toLowerCase();

    // "limit" is how many MATCHING items we want to return (mp4)
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    let token = String(req.query.cursor || "") || undefined;

    const items = [];

    // Safety: avoid scanning forever if bucket is huge and mp4s are rare
    // 30 pages * 1000 keys = up to 30k keys scanned worst-case
    const MAX_PAGES = 30;

    // We'll fetch in larger chunks to reduce round trips
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

        // type filter
        if (type === "mp4" && !isMp4(key)) continue;
        if (type === "png" && !isPng(key)) continue;

        // search filter
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

      // If we have enough matching items, return now,
      // and set next_cursor to continue from the current token (if any).
      if (items.length >= limit) {
        return res.json({
          ok: true,
          bucket,
          prefix,
          items,
          next_cursor: r.IsTruncated ? r.NextContinuationToken : null,
        });
      }

      // No more results in bucket
      if (!r.IsTruncated) {
        return res.json({
          ok: true,
          bucket,
          prefix,
          items,
          next_cursor: null,
        });
      }

      // Continue scanning
      token = r.NextContinuationToken;
    }

    // If we scanned many pages but still didn't hit limit, return what we found.
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

    // ✅ fixed: use same resolver as /objects
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
 * Copies MP4 from Wasabi -> Bunny Storage,
 * then inserts DB row using Bunny CDN URL.
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
      selected: mp4Keys.length,
      imported: 0,
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

        const { cdnUrl, destPath, uploadedBytes } = await copyWasabiToBunny({
          s3,
          bucket,
          key,
        });

        const dup = await db.query(
          `SELECT id FROM videos WHERE video_url = $1 LIMIT 1`,
          [cdnUrl],
        );
        if (dup.rowCount > 0) {
          results.skipped++;
          results.details.push({
            key,
            status: "skipped",
            reason: "duplicate",
            video_url: cdnUrl,
            bunny_path: destPath,
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
