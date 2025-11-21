// server-api/utils/url.js
function absMediaUrl(relativePath) {
  if (!relativePath) return null;

  const base = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL;

  if (!base) return relativePath;

  if (
    relativePath.startsWith("http://") ||
    relativePath.startsWith("https://")
  ) {
    return relativePath;
  }

  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = relativePath.replace(/^\/+/, "");

  return `${cleanBase}/${cleanPath}`;
}

module.exports = { absMediaUrl };
