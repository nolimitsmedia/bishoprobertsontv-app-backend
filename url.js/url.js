// server-api/utils/url.js
function absUrl(req, url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url; // already absolute

  const base = `${req.protocol}://${req.get("host")}`;

  if (url.startsWith("/")) return base + url;

  return `${base}/${url}`;
}

module.exports = { absUrl };
