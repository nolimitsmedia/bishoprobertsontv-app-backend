// server-api/services/wasabi.js
const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function createWasabiClient() {
  const region = requiredEnv("WASABI_REGION");
  const endpoint = requiredEnv("WASABI_ENDPOINT");
  const accessKeyId = requiredEnv("WASABI_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("WASABI_SECRET_ACCESS_KEY");

  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // important for S3-compatible endpoints like Wasabi
  });
}

function getWasabiConfig() {
  return {
    bucket: requiredEnv("WASABI_BUCKET"),
    prefix: (process.env.WASABI_IMPORT_PREFIX || "").trim(),
    region: requiredEnv("WASABI_REGION"),
    endpoint: requiredEnv("WASABI_ENDPOINT"),
  };
}

function isProbablyVideoKey(key) {
  const k = String(key || "").toLowerCase();
  return k.endsWith(".mp4") || k.endsWith(".mov") || k.endsWith(".m4v");
}

function filenameFromKey(key) {
  const parts = String(key || "").split("/");
  return parts[parts.length - 1] || key;
}

function titleFromFilename(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  return base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

// Lists objects under prefix (paginated)
async function listObjects({ prefix, maxKeys = 1000 }) {
  const s3 = createWasabiClient();
  const { bucket } = getWasabiConfig();

  let token = undefined;
  const items = [];

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: Math.min(1000, Math.max(1, Number(maxKeys) || 1000)),
      ContinuationToken: token,
    });

    const resp = await s3.send(cmd);

    const contents = resp.Contents || [];
    for (const o of contents) {
      if (!o || !o.Key) continue;
      items.push({
        key: o.Key,
        size: Number(o.Size || 0),
        last_modified: o.LastModified
          ? new Date(o.LastModified).toISOString()
          : null,
      });
    }

    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  return items;
}

// Fetch metadata (content-type, etc.)
async function headObject(key) {
  const s3 = createWasabiClient();
  const { bucket } = getWasabiConfig();
  const resp = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  return {
    content_type: resp.ContentType || null,
    content_length: Number(resp.ContentLength || 0),
  };
}

// Signed URL for playback (don’t store this in DB; generate on demand)
async function signGetUrl(key, expiresInSeconds = 60 * 30) {
  const s3 = createWasabiClient();
  const { bucket } = getWasabiConfig();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });

  // Wasabi supports presigned GET like AWS S3
  return await getSignedUrl(s3, cmd, {
    expiresIn: Math.max(60, Number(expiresInSeconds) || 1800),
  });
}

module.exports = {
  getWasabiConfig,
  listObjects,
  headObject,
  signGetUrl,
  isProbablyVideoKey,
  filenameFromKey,
  titleFromFilename,
};
