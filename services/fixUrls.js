// server-api/services/fixUrls.js

/**
 * Build the absolute base URL depending on environment.
 * Works in localhost and production.
 */
function getBaseUrl(req) {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";

    const host = req.headers["x-forwarded-host"] || req.headers.host;

    return `${protocol}://${host}`;
  } catch {
    return "";
  }
}

/**
 * Turns a relative URL (e.g., /uploads/file.jpg)
 * into a fully-qualified absolute URL.
 */
function absoluteUrl(req, url) {
  if (!url) return url;

  // Already absolute -> leave it
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  const base = getBaseUrl(req);
  if (!base) return url;

  // Prevent accidental double slashes
  if (url.startsWith("/")) {
    return `${base}${url}`;
  }

  return `${base}/${url}`;
}

/**
 * Fix URLs for videos (thumbnail_url, file_url, etc.)
 */
function fixVideoUrls(req, video) {
  if (!video) return video;

  const v = { ...video };

  if (v.thumbnail_url) {
    v.thumbnail_url = absoluteUrl(req, v.thumbnail_url);
  }

  if (v.file_url) {
    v.file_url = absoluteUrl(req, v.file_url);
  }

  if (v.poster_url) {
    v.poster_url = absoluteUrl(req, v.poster_url);
  }

  if (v.hls_url) {
    v.hls_url = absoluteUrl(req, v.hls_url);
  }

  return v;
}

/**
 * Fix playlist thumbnails + other URLs if needed
 */
function fixPlaylistUrls(req, playlist) {
  if (!playlist) return playlist;

  const p = { ...playlist };

  if (p.thumbnail_url) {
    p.thumbnail_url = absoluteUrl(req, p.thumbnail_url);
  }

  return p;
}

module.exports = {
  absoluteUrl,
  fixVideoUrls,
  fixPlaylistUrls,
};
