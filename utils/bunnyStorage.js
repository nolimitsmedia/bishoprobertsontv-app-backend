// server-api/utils/bunnyStorage.js
const https = require("https");
const path = require("path");

function cleanBaseUrl(url) {
  if (!url) return "";
  return url.endsWith("/") ? url : url + "/";
}

function safeFileName(originalName = "image") {
  const ext = path.extname(originalName).toLowerCase() || ".jpg";
  const base =
    path
      .basename(originalName, ext)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "image";

  return `${Date.now()}-${base}${ext}`;
}

/**
 * Uploads a buffer to Bunny Storage.
 * @param {Object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.storageHost e.g. storage.bunnycdn.com
 * @param {string} opts.storageZone e.g. bishop-robertson-tv-app
 * @param {string} opts.apiKey Bunny Storage API key
 * @param {string} opts.remotePath e.g. Community/123/169..-photo.jpg
 * @returns {Promise<void>}
 */
function uploadToBunny({
  buffer,
  storageHost,
  storageZone,
  apiKey,
  remotePath,
}) {
  return new Promise((resolve, reject) => {
    const fullPath = `/${storageZone}/${remotePath}`.replace(/\\/g, "/");

    const req = https.request(
      {
        method: "PUT",
        host: storageHost,
        path: fullPath,
        headers: {
          AccessKey: apiKey,
          "Content-Type": "application/octet-stream",
          "Content-Length": buffer.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          // Bunny typically returns 201/200
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(
            new Error(
              `Bunny upload failed (${res.statusCode}): ${body || "no body"}`
            )
          );
        });
      }
    );

    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

function buildCdnUrl(cdnBaseUrl, remotePath) {
  const base = cleanBaseUrl(cdnBaseUrl);
  const rel = String(remotePath || "").replace(/^\/+/, "");
  return base + rel;
}

module.exports = {
  safeFileName,
  uploadToBunny,
  buildCdnUrl,
};
