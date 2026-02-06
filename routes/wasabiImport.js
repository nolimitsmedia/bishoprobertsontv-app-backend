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
  const x = String(p).trim().replace(/^\/+/, "");
  return x.endsWith("/") ? x : `${x}/`;
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
  // encode each segment so spaces/special chars don't break the URL
  return String(path)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function bunnyConfig() {
  const zone = mustEnv("BUNNY_STORAGE_ZONE"); // Storage zone name (username)
  const apiKey = mustEnv("BUNNY_STORAGE_API_KEY"); // Storage zone password (API)
  const host = mustEnv("BUNNY_STORAGE_HOST"); // e.g. ny.storage.bunnycdn.com
  const cdnBase = mustEnv("BUNNY_CDN_BASE_URL"); // e.g. https://xxx.b-cdn.net
  const basePath = mustEnv("BUNNY_STORAGE_BASE_PATH"); // e.g. bishoprobertsontv/videos/archives/u_33

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

/**
 * Bunny "verify" via GET Range (more reliable than HEAD).
 * - If AccessKey is valid but file missing: usually 404
 * - If file exists: 206 (Partial Content) or 200
 * - If key invalid: 401
 */
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

/**
 * Verify Bunny stored the object (with retries).
 * We consider success if we get 200 or 206.
 * If we repeatedly get 404, we keep retrying briefly (propagation).
 * If we get 401, we fail immediately (invalid AccessKey).
 */
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
      // Optional size check (best-effort)
      // For 206, Bunny may send Content-Range like "bytes 0-0/12345"
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

    // 404 means not found (might be propagation) — retry a few times
    if (r.status === 404) {
      const wait = delaysMs[i] || 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    // Other statuses are unexpected; fail fast
    throw new Error(`Bunny verify failed (status ${r.status}) for ${destPath}`);
  }

  throw new Error(
    `Bunny verify failed (not found after retries) for ${destPath}`,
  );
}

/**
 * Stream-copy: Wasabi -> Bunny Storage
 * Returns: { destPath, cdnUrl, uploadedBytes }
 */
async function copyWasabiToBunny({ s3, bucket, key }) {
  const { apiKey, cdnBase, basePath, putBase } = bunnyConfig();

  const filename = safeFilenameFromKey(key);
  const destPath = `${basePath}/${filename}`;
  const cdnUrl = `${cdnBase}/${destPath}`;

  // Read metadata first (size/type)
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const contentType = head.ContentType || "video/mp4";
  const contentLength = Number(head.ContentLength || 0);

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const stream = obj.Body;
  if (!stream) throw new Error("Wasabi GetObject returned empty Body stream");

  const putUrl = `${putBase}/${encodePath(destPath)}`;

  // Upload stream to Bunny Storage
  const putResp = await axios.put(putUrl, stream, {
    headers: {
      AccessKey: apiKey,
      "Content-Type": contentType,
      ...(contentLength ? { "Content-Length": contentLength } : {}),
    },
    timeout: 2 * 60 * 60 * 1000, // 2 hours (prevents infinite hang)
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

  // Verify via GET Range (reliable)
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
/**
 * GET /api/admin/wasabi/bunny-health
 * We verify AccessKey validity by requesting a NON-EXISTENT file.
 * - Valid AccessKey: usually 404
 * - Invalid AccessKey: 401
 */
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

    const prefix = normPrefix(
      req.query.prefix || process.env.WASABI_IMPORT_PREFIX || "drm",
    );
    const type = String(req.query.type || "mp4").toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const cursor = String(req.query.cursor || "");

    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: limit,
      ...(cursor ? { ContinuationToken: cursor } : {}),
    });

    const r = await s3.send(cmd);
    const items = [];

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
    }

    return res.json({
      ok: true,
      bucket,
      prefix,
      items,
      next_cursor: r.IsTruncated ? r.NextContinuationToken : null,
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
    const prefix = normPrefix(req.query.prefix || "drm");

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

    bunnyConfig(); // fail fast if missing env

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

        // de-dupe by Bunny URL
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
