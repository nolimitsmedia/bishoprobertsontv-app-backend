// server-api/utils/transform.js
const { absUrl } = require("./url");

/** Normalize all video-related URLs */
function fixVideoUrls(req, v = {}) {
  if (!v) return v;

  // Top-level URLs
  v.thumbnail_url = absUrl(req, v.thumbnail_url || v.thumbnail);
  v.poster_url = absUrl(req, v.poster_url || v.poster);
  v.source_url = absUrl(req, v.source_url || v.video_url);
  v.hls_url = absUrl(req, v.hls_url || v.hls);

  // Metadata nested URLs
  if (v.metadata) {
    v.metadata = { ...v.metadata };
    v.metadata.thumbnail_url = absUrl(req, v.metadata.thumbnail_url);
    v.metadata.thumbnail_vertical_url = absUrl(
      req,
      v.metadata.thumbnail_vertical_url
    );
    v.metadata.poster_url = absUrl(req, v.metadata.poster_url);
    v.metadata.stream_url = absUrl(req, v.metadata.stream_url);
  }

  return v;
}

/** Normalize playlist image + nested videos */
function fixPlaylistUrls(req, p = {}) {
  if (!p) return p;

  p.thumbnail_url = absUrl(req, p.thumbnail_url);

  if (Array.isArray(p.items)) {
    p.items = p.items.map((v) => fixVideoUrls(req, v));
  }

  return p;
}

module.exports = {
  fixVideoUrls,
  fixPlaylistUrls,
};
