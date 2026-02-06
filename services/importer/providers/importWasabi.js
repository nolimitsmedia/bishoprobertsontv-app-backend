// server-api/services/importer/providers/importWasabi.js
const db = require("../../../db");
const { decryptJSON } = require("../../../utils/crypto");

const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function normPrefix(p) {
  if (!p) return "";
  const x = String(p).trim().replace(/^\/+/, "");
  return x.endsWith("/") ? x : `${x}/`;
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
}

function buildWasabiUrl({ endpoint, bucket, key }) {
  const base = normalizeEndpoint(endpoint);
  return `${base}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function safeFilenameFromKey(key = "") {
  const filename = String(key).split("/").pop() || key;
  return filename.replace(/[^\w.\-() ]+/g, "_");
}

function titleFromKey({ key = "", mode = "filename_no_ext" } = {}) {
  const file = safeFilenameFromKey(key);
  const dot = file.lastIndexOf(".");
  const noExt = dot > 0 ? file.slice(0, dot) : file;

  if (String(mode).toLowerCase() === "filename") return file;

  // filename_no_ext (default)
  return String(noExt).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

async function getActiveWasabi() {
  // ✅ table uses "config" (NOT meta)
  const r = await db.query(
    `SELECT config, secrets_enc
     FROM storage_connections
     WHERE provider='wasabi' AND is_active=TRUE
     LIMIT 1`,
  );

  if (!r.rows[0]) throw new Error("Wasabi not connected");

  const meta = r.rows[0].config || {};
  const secrets = decryptJSON(r.rows[0].secrets_enc);

  if (!meta.endpoint || !meta.bucket || !meta.region) {
    throw new Error(
      "Wasabi config incomplete (need meta.endpoint/meta.bucket/meta.region)",
    );
  }
  if (!secrets?.accessKeyId || !secrets?.secretAccessKey) {
    throw new Error(
      "Wasabi secrets incomplete (need secrets.accessKeyId/secrets.secretAccessKey)",
    );
  }

  const endpoint = normalizeEndpoint(meta.endpoint);

  const s3 = new S3Client({
    region: meta.region || "us-east-1",
    endpoint,
    credentials: {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
    },
    forcePathStyle: true,
  });

  return {
    s3,
    bucket: String(meta.bucket).trim(),
    endpoint,
    import_prefix: meta.import_prefix || "",
    region: meta.region || "us-east-1",
    access_mode: String(meta.access_mode || "auto").toLowerCase(), // auto|public|signed
    signed_url_ttl_seconds: Number(meta.signed_url_ttl_seconds || 3600),
  };
}

// Optional: body override for testing (not saved)
function fromBody(body) {
  const meta = body?.meta || {};
  const secrets = body?.secrets || {};

  if (!meta.endpoint || !meta.bucket || !meta.region) {
    throw new Error("Missing meta.endpoint/meta.bucket/meta.region");
  }
  if (!secrets.accessKeyId || !secrets.secretAccessKey) {
    throw new Error("Missing secrets.accessKeyId/secrets.secretAccessKey");
  }

  const endpoint = normalizeEndpoint(meta.endpoint);

  const s3 = new S3Client({
    region: meta.region,
    endpoint,
    credentials: {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
    },
    forcePathStyle: true,
  });

  return {
    s3,
    bucket: String(meta.bucket).trim(),
    endpoint,
    import_prefix: meta.import_prefix || "",
    region: meta.region,
    access_mode: String(meta.access_mode || "auto").toLowerCase(),
    signed_url_ttl_seconds: Number(meta.signed_url_ttl_seconds || 3600),
  };
}

async function testConnection(bodyOrNull) {
  const cfg = bodyOrNull?.meta ? fromBody(bodyOrNull) : await getActiveWasabi();

  const prefix = normPrefix(cfg.import_prefix || "");
  const cmd = new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: prefix || undefined,
    MaxKeys: 1,
  });

  const r = await cfg.s3.send(cmd);

  return {
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    prefix,
    access_mode: cfg.access_mode,
    signed_url_ttl_seconds: cfg.signed_url_ttl_seconds,
    sample_key: r.Contents?.[0]?.Key || null,
  };
}

async function listObjects({ prefix, limit = 200, cursor = "" }) {
  const cfg = await getActiveWasabi();
  const p = normPrefix(prefix || cfg.import_prefix || "");

  const cmd = new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: p || undefined,
    MaxKeys: Math.max(1, Math.min(1000, Number(limit) || 200)),
    ...(cursor ? { ContinuationToken: cursor } : {}),
  });

  const r = await cfg.s3.send(cmd);

  const items = (r.Contents || [])
    .filter((x) => x?.Key)
    .map((x) => ({
      key: x.Key,
      size: Number(x.Size || 0),
      etag: x.ETag || null,
      lastModified: x.LastModified || null,
      url: buildWasabiUrl({
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        key: x.Key,
      }),
    }));

  return {
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    prefix: p,
    items,
    next_cursor: r.IsTruncated ? r.NextContinuationToken : null,
  };
}

/**
 * ✅ Head object (accepts key string OR {key})
 * Returns both naming styles for compatibility
 */
async function headObject(arg) {
  const key = typeof arg === "string" ? arg : arg?.key;
  if (!key) throw new Error("headObject missing key");

  const cfg = await getActiveWasabi();
  const r = await cfg.s3.send(
    new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
  );

  const contentType = r.ContentType || null;
  const contentLength = Number(r.ContentLength || 0);

  return {
    // preferred keys
    contentType,
    contentLength,

    // compatibility keys (some callers check these)
    ContentType: contentType,
    ContentLength: contentLength,

    etag: r.ETag || null,
    lastModified: r.LastModified || null,
  };
}

/**
 * ✅ Get readable stream (accepts key string OR {key})
 * Returns { stream, bucket }
 */
async function getStream(arg) {
  const key = typeof arg === "string" ? arg : arg?.key;
  if (!key) throw new Error("getStream missing key");

  const cfg = await getActiveWasabi();
  const obj = await cfg.s3.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
  );

  if (!obj?.Body) {
    throw new Error("Wasabi GetObject returned empty Body stream");
  }

  return { stream: obj.Body, bucket: cfg.bucket };
}

async function makeRemoteUrl(arg) {
  const key = typeof arg === "string" ? arg : arg?.key;
  if (!key) throw new Error("makeRemoteUrl missing key");

  const cfg = await getActiveWasabi();
  return buildWasabiUrl({ endpoint: cfg.endpoint, bucket: cfg.bucket, key });
}

/**
 * Extract object key from a stored direct URL:
 *   endpoint/bucket/<key>
 * Returns key string or null if not matching the active configured endpoint+bucket.
 */
function extractKeyFromUrl({ endpoint, bucket, url }) {
  const base = normalizeEndpoint(endpoint);
  const b = String(bucket || "").trim();
  const u = String(url || "");

  if (!base || !b || !u) return null;

  const prefix = `${base}/${b}/`;
  if (!u.startsWith(prefix)) return null;

  const raw = u.slice(prefix.length);

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Generate a signed GET URL for a key (do NOT store in DB).
 */
async function signKey(key, { expiresInSeconds = 3600 } = {}) {
  const cfg = await getActiveWasabi();
  const cmd = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });

  const ttl = Math.max(
    60,
    Math.min(
      24 * 3600,
      Number(expiresInSeconds || cfg.signed_url_ttl_seconds || 3600),
    ),
  );

  return await getSignedUrl(cfg.s3, cmd, { expiresIn: ttl });
}

/* =======================================================
   ✅ COMPATIBILITY HELPERS FOR ENGINE
======================================================= */

/**
 * Some code expects getObjectStream({key}) or getObject({key})
 */
async function getObjectStream({ key }) {
  return await getStream({ key });
}
async function getObject({ key }) {
  // return same shape { stream }
  return await getStream({ key });
}

/**
 * Engine expects buildRemoteUrl({ key, access_mode, signed_url_ttl_seconds })
 * access_mode: auto|public|signed
 */
async function buildRemoteUrl({
  key,
  access_mode = "auto",
  signed_url_ttl_seconds = 3600,
} = {}) {
  if (!key) throw new Error("buildRemoteUrl missing key");

  const cfg = await getActiveWasabi();

  const mode = String(access_mode || cfg.access_mode || "auto").toLowerCase();

  if (mode === "signed") {
    return await signKey(key, { expiresInSeconds: signed_url_ttl_seconds });
  }

  if (mode === "public") {
    return buildWasabiUrl({ endpoint: cfg.endpoint, bucket: cfg.bucket, key });
  }

  // auto: default to public URL (you can change this later if you want auto=>signed)
  return buildWasabiUrl({ endpoint: cfg.endpoint, bucket: cfg.bucket, key });
}

module.exports = {
  testConnection,
  listObjects,
  headObject,
  getStream,
  makeRemoteUrl,
  buildWasabiUrl,
  extractKeyFromUrl,
  signKey,

  // ✅ added helpers
  titleFromKey,
  getObjectStream,
  getObject,
  buildRemoteUrl,
};
