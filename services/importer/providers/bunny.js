// server-api/services/importer/providers/bunny.js
const axios = require("axios");
const db = require("../../../db");
const { decryptJSON } = require("../../../utils/crypto");

// encode each segment
function encodePath(path = "") {
  return String(path)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function safeFilenameFromKey(key = "") {
  const filename = String(key).split("/").pop() || key;
  return filename.replace(/[^\w.\-() ]+/g, "_");
}

function titleFromKey({ key = "", mode = "filename_no_ext" } = {}) {
  const file = safeFilenameFromKey(key);
  const hasDot = file.lastIndexOf(".");
  const noExt = hasDot > 0 ? file.slice(0, hasDot) : file;

  if (String(mode).toLowerCase() === "filename") return file;

  // filename_no_ext
  return String(noExt).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

async function getActiveBunny() {
  // ✅ table uses "config" (NOT meta)
  const r = await db.query(
    `SELECT config, secrets_enc
     FROM storage_connections
     WHERE provider='bunny' AND is_active=TRUE
     LIMIT 1`,
  );
  if (!r.rows[0]) throw new Error("Bunny not connected");

  const meta = r.rows[0].config || {};
  const secrets = decryptJSON(r.rows[0].secrets_enc);

  const zone = meta.storage_zone; // username
  const host = meta.host; // ny.storage.bunnycdn.com
  const basePath = String(meta.base_path || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const cdnBase = meta.cdn_base_url
    ? String(meta.cdn_base_url).replace(/\/+$/, "")
    : "";

  const apiKey = secrets?.api_key; // AccessKey

  if (!zone || !host || !basePath || !apiKey) {
    throw new Error(
      "Bunny config incomplete (need config.storage_zone/config.host/config.base_path + secrets.api_key)",
    );
  }

  return {
    zone,
    host,
    basePath,
    cdnBase,
    apiKey,
    putBase: `https://${host}/${zone}`,
  };
}

// Allow test with body override (not saved)
function fromBody(body) {
  const meta = body?.meta || {};
  const secrets = body?.secrets || {};

  const zone = meta.storage_zone;
  const host = meta.host;
  const basePath = String(meta.base_path || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const cdnBase = meta.cdn_base_url
    ? String(meta.cdn_base_url).replace(/\/+$/, "")
    : "";
  const apiKey = secrets.api_key;

  if (!zone || !host || !basePath || !apiKey) {
    throw new Error("Missing Bunny test fields");
  }

  return {
    zone,
    host,
    basePath,
    cdnBase,
    apiKey,
    putBase: `https://${host}/${zone}`,
  };
}

/**
 * Bunny "verify" via GET Range
 * Valid key but missing file: 404
 * Invalid key: 401
 */
async function bunnyGetRange(cfg, { destPath }) {
  const url = `${cfg.putBase}/${encodePath(destPath)}`;

  const r = await axios.request({
    method: "GET",
    url,
    headers: { AccessKey: cfg.apiKey, Range: "bytes=0-0" },
    responseType: "arraybuffer",
    validateStatus: () => true,
    timeout: 15000,
    maxRedirects: 0,
  });

  return r;
}

async function verifyBunnyStored(cfg, { destPath, expectedSize = 0 }) {
  const attempts = 8;
  const delaysMs = [250, 500, 900, 1300, 1800, 2500, 3200, 4000];

  for (let i = 0; i < attempts; i++) {
    const r = await bunnyGetRange(cfg, { destPath });

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

      if (expectedSize && totalFromRange && totalFromRange !== expectedSize) {
        throw new Error(
          `Bunny size mismatch (expected ${expectedSize}, got ${totalFromRange}) for ${destPath}`,
        );
      }

      return { ok: true, size: totalFromRange || expectedSize || 0 };
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

async function testConnection(bodyOrNull) {
  const cfg = bodyOrNull?.meta ? fromBody(bodyOrNull) : await getActiveBunny();

  // request non-existent file: 404 => key accepted, 401 => rejected
  const fake = `${cfg.basePath}/__healthcheck__does_not_exist__.txt`;
  const r = await bunnyGetRange(cfg, { destPath: fake });

  if (r.status === 401) {
    throw new Error(
      "Bunny rejected AccessKey (401). Wrong storage password/API key.",
    );
  }

  return {
    zone: cfg.zone,
    host: cfg.host,
    putBase: cfg.putBase,
    basePath: cfg.basePath,
    testedPath: fake,
    status: r.status,
  };
}

/**
 * Compute a destination path/key inside Bunny Storage.
 * (Compatibility helper — useful if other code expects it.)
 */
async function computeDestKey({ sourceKey }) {
  const cfg = await getActiveBunny();
  const filename = safeFilenameFromKey(sourceKey);
  return `${cfg.basePath}/${filename}`;
}

/**
 * Build a public URL (prefer CDN base when available).
 * (Compatibility helper — useful if other code expects it.)
 */
async function buildPublicUrl({ destKey }) {
  const cfg = await getActiveBunny();
  if (!destKey) return "";
  return cfg.cdnBase
    ? `${cfg.cdnBase}/${destKey}`
    : `${cfg.putBase}/${encodePath(destKey)}`;
}

/**
 * Stream-copy: Wasabi -> Bunny Storage
 * Returns: { destPath, cdnUrl, uploadedBytes }
 *
 * NOTE: This function expects the caller to provide the readable stream.
 * engine.js now supplies: { sourceKey, contentType, contentLength, stream }
 */
async function copyFromWasabiStream({
  sourceKey,
  contentType,
  contentLength,
  stream,
}) {
  const cfg = await getActiveBunny();

  const filename = safeFilenameFromKey(sourceKey);
  const destPath = `${cfg.basePath}/${filename}`;

  // prefer CDN url if provided, else storage path url
  const cdnUrl = cfg.cdnBase
    ? `${cfg.cdnBase}/${destPath}`
    : `${cfg.putBase}/${encodePath(destPath)}`;

  const putUrl = `${cfg.putBase}/${encodePath(destPath)}`;

  const putResp = await axios.put(putUrl, stream, {
    headers: {
      AccessKey: cfg.apiKey,
      "Content-Type": contentType || "video/mp4",
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

  const v = await verifyBunnyStored(cfg, {
    destPath,
    expectedSize: contentLength || 0,
  });

  return { destPath, cdnUrl, uploadedBytes: v.size || contentLength || 0 };
}

module.exports = {
  testConnection,
  copyFromWasabiStream,

  // Compatibility exports (prevents “is not a function” issues)
  computeDestKey,
  buildPublicUrl,
  titleFromKey,
};
