// server-api/lib/cloudProviders.js
//
// Cloud storage catalog (alphabetical) + connectors. A connector can:
//   test(cfg)                      → throws if it cannot read the storage
//   list(cfg, { prefix, q, cursor }) → { items:[{ key, name, size, last_modified }], cursor }
//   downloadUrl(cfg, key)          → a temporary link Bunny Stream can fetch
// Available now: every S3-compatible service (one connector) and Azure Blob
// Storage. Sign-in services (Dropbox, Google Drive, OneDrive, Box…) need an app
// registered by the platform owner first: listed as "Coming soon".
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fetch = require("node-fetch");

const VIDEO_EXT =
  /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|mts|m2ts|flv|3gp)$/i;

// fields asked for each kind of connection (secret: stored encrypted, never shown again)
const S3_FIELDS = [
  {
    name: "endpoint",
    label: "Endpoint",
    placeholder: "https://…",
    required: true,
  },
  { name: "region", label: "Region", placeholder: "us-east-1" },
  { name: "bucket", label: "Bucket", required: true },
  { name: "prefix", label: "Folder (optional)", placeholder: "videos/" },
  {
    name: "access_key_id",
    label: "Access key ID",
    required: true,
    secret: true,
  },
  {
    name: "secret_access_key",
    label: "Secret access key",
    required: true,
    secret: true,
  },
];
const s3 = (id, name, endpoint, region, help) => ({
  id,
  name,
  kind: "s3",
  available: true,
  defaults: { endpoint, region },
  help,
  fields: S3_FIELDS,
});
const soon = (id, name, how) => ({
  id,
  name,
  kind: "oauth",
  available: false,
  help: how,
});

const CATALOG = [
  s3(
    "akamai",
    "Akamai (Linode) Object Storage",
    "https://us-east-1.linodeobjects.com",
    "us-east-1",
    "Cloud Manager › Object Storage › Access Keys.",
  ),
  s3(
    "alibaba",
    "Alibaba Cloud OSS",
    "https://oss-us-east-1.aliyuncs.com",
    "us-east-1",
    "Uses OSS’s S3-compatible access with an AccessKey pair.",
  ),
  s3(
    "aws-s3",
    "Amazon S3",
    "https://s3.us-east-1.amazonaws.com",
    "us-east-1",
    "IAM user with s3:ListBucket and s3:GetObject on the bucket.",
  ),
  {
    id: "azure-blob",
    name: "Azure Blob Storage",
    kind: "azure",
    available: true,
    help: "Storage account › Containers › your container › Shared access tokens: permissions Read + List, then copy the “Blob SAS URL”.",
    fields: [
      {
        name: "container_sas_url",
        label: "Container SAS URL",
        placeholder: "https://account.blob.core.windows.net/container?sv=…",
        required: true,
        secret: true,
      },
      { name: "prefix", label: "Folder (optional)", placeholder: "videos/" },
    ],
  },
  s3(
    "backblaze-b2",
    "Backblaze B2",
    "https://s3.us-west-004.backblazeb2.com",
    "us-west-004",
    "App Keys › Add a New Application Key (read access); the endpoint is on the bucket page.",
  ),
  soon("box", "Box", "Connect with Box (sign-in) — coming soon."),
  s3(
    "cloudflare-r2",
    "Cloudflare R2",
    "https://<account-id>.r2.cloudflarestorage.com",
    "auto",
    "R2 › Manage R2 API Tokens (Object Read). Replace <account-id> in the endpoint.",
  ),
  s3(
    "digitalocean-spaces",
    "DigitalOcean Spaces",
    "https://nyc3.digitaloceanspaces.com",
    "us-east-1",
    "API › Spaces Keys.",
  ),
  soon("dropbox", "Dropbox", "Connect with Dropbox (sign-in) — coming soon."),
  soon("ftp", "FTP / SFTP server", "Needs a transfer relay — coming soon."),
  soon(
    "google-drive",
    "Google Drive",
    "Connect with Google (sign-in + file picker) — coming soon.",
  ),
  s3(
    "google-cloud-storage",
    "Google Cloud Storage",
    "https://storage.googleapis.com",
    "auto",
    "Cloud Storage › Settings › Interoperability › create an HMAC key for a service account with Storage Object Viewer.",
  ),
  s3(
    "ibm-cos",
    "IBM Cloud Object Storage",
    "https://s3.us-south.cloud-object-storage.appdomain.cloud",
    "us-south",
    "Service credentials with HMAC keys enabled.",
  ),
  s3(
    "idrive-e2",
    "IDrive e2",
    "https://<your-endpoint>.idrivee2.com",
    "us-east-1",
    "Access Keys › Create Access Key; the endpoint is shown on the region page.",
  ),
  soon(
    "onedrive",
    "Microsoft OneDrive / SharePoint",
    "Connect with Microsoft (sign-in) — coming soon.",
  ),
  s3(
    "minio",
    "MinIO (self-hosted)",
    "https://minio.example.com",
    "us-east-1",
    "An access key with read access to the bucket.",
  ),
  s3(
    "oracle",
    "Oracle Cloud Object Storage",
    "https://<namespace>.compat.objectstorage.us-ashburn-1.oraclecloud.com",
    "us-ashburn-1",
    "User › Customer Secret Keys (S3 compatibility).",
  ),
  s3(
    "other-s3",
    "Other S3-compatible storage",
    "",
    "us-east-1",
    "Any storage with an S3-compatible API: endpoint, bucket and an access key.",
  ),
  soon("pcloud", "pCloud", "Connect with pCloud (sign-in) — coming soon."),
  s3(
    "scaleway",
    "Scaleway Object Storage",
    "https://s3.fr-par.scw.cloud",
    "fr-par",
    "IAM › API keys.",
  ),
  s3(
    "storj",
    "Storj",
    "https://gateway.storjshare.io",
    "us-east-1",
    "Access › Create S3 Credentials (read-only).",
  ),
  s3(
    "tencent-cos",
    "Tencent Cloud COS",
    "https://cos.ap-guangzhou.myqcloud.com",
    "ap-guangzhou",
    "API keys (SecretId / SecretKey); bucket name includes the APPID.",
  ),
  s3(
    "vultr",
    "Vultr Object Storage",
    "https://ewr1.vultrobjects.com",
    "us-east-1",
    "Object Storage › your storage › Overview (S3 credentials).",
  ),
  s3(
    "wasabi",
    "Wasabi",
    "https://s3.us-east-1.wasabisys.com",
    "us-east-1",
    "Access Keys › Create new access key (a read-only policy is enough).",
  ),
].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

const byId = (id) => CATALOG.find((p) => p.id === id);
const cleanPrefix = (p) =>
  String(p || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
const nameOf = (key) => String(key).split("/").pop();

/* ---------------- S3-compatible ---------------- */
function s3Client(cfg) {
  return new S3Client({
    region: cfg.region || "us-east-1",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
    },
    forcePathStyle: true,
  });
}
const S3 = {
  async test(cfg) {
    const c = s3Client(cfg);
    try {
      await c.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    } catch {
      await c.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          MaxKeys: 1,
          Prefix: cleanPrefix(cfg.prefix) || undefined,
        }),
      );
    }
  },
  // S3 has no search: list under the folder and filter by name (up to 5 000 files per request)
  async list(cfg, { prefix = "", q = "", cursor } = {}) {
    const c = s3Client(cfg);
    const base = cleanPrefix(
      `${cleanPrefix(cfg.prefix)}${cleanPrefix(prefix)}`,
    );
    const needle = String(q || "")
      .trim()
      .toLowerCase();
    const items = [];
    let token = cursor || undefined;
    let scanned = 0;
    do {
      const r = await c.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: base || undefined,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const o of r.Contents || []) {
        scanned += 1;
        if (!VIDEO_EXT.test(o.Key)) continue;
        if (needle && !o.Key.toLowerCase().includes(needle)) continue;
        items.push({
          key: o.Key,
          name: nameOf(o.Key),
          size: Number(o.Size || 0),
          last_modified: o.LastModified || null,
        });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token && items.length < 200 && scanned < 5000);
    items.sort(
      (a, b) => new Date(b.last_modified || 0) - new Date(a.last_modified || 0),
    );
    return { items, cursor: token || null };
  },
  async downloadUrl(cfg, key) {
    return getSignedUrl(
      s3Client(cfg),
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      { expiresIn: 24 * 60 * 60 },
    );
  },
};

/* ---------------- Azure Blob Storage (container SAS URL) ---------------- */
function sasParts(cfg) {
  const u = new URL(String(cfg.container_sas_url || "").trim());
  const sas = u.search.replace(/^\?/, "");
  u.search = "";
  return { container: u.toString().replace(/\/+$/, ""), sas };
}
const xmlAll = (xml, tag) =>
  [
    ...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
  ].map((m) => m[1]);
const xmlOne = (xml, tag) =>
  (String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] ||
  "";
const unxml = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const AZURE = {
  async test(cfg) {
    const { container, sas } = sasParts(cfg);
    const r = await fetch(
      `${container}?restype=container&comp=list&maxresults=1&${sas}`,
    );
    if (!r.ok)
      throw new Error(
        `Azure answered ${r.status}. The SAS URL needs Read and List permission and must not be expired.`,
      );
  },
  async list(cfg, { prefix = "", q = "", cursor } = {}) {
    const { container, sas } = sasParts(cfg);
    const base = cleanPrefix(
      `${cleanPrefix(cfg.prefix)}${cleanPrefix(prefix)}`,
    );
    const needle = String(q || "")
      .trim()
      .toLowerCase();
    const items = [];
    let marker = cursor || "";
    let scanned = 0;
    do {
      const url = `${container}?restype=container&comp=list&maxresults=1000${base ? `&prefix=${encodeURIComponent(base)}` : ""}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}&${sas}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Azure answered ${r.status}`);
      const xml = await r.text();
      for (const b of xmlAll(xml, "Blob")) {
        scanned += 1;
        const key = unxml(xmlOne(b, "Name"));
        if (!VIDEO_EXT.test(key)) continue;
        if (needle && !key.toLowerCase().includes(needle)) continue;
        items.push({
          key,
          name: nameOf(key),
          size: Number(xmlOne(b, "Content-Length") || 0),
          last_modified: xmlOne(b, "Last-Modified") || null,
        });
      }
      marker = unxml(xmlOne(xml, "NextMarker"));
    } while (marker && items.length < 200 && scanned < 5000);
    return { items, cursor: marker || null };
  },
  async downloadUrl(cfg, key) {
    const { container, sas } = sasParts(cfg);
    return `${container}/${String(key).split("/").map(encodeURIComponent).join("/")}?${sas}`;
  },
};

function connectorFor(provider) {
  const p = byId(provider);
  if (!p || !p.available) return null;
  return p.kind === "azure" ? AZURE : S3;
}

module.exports = { CATALOG, byId, connectorFor, VIDEO_EXT };
