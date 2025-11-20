// server-api/middleware/auth.js
const jwt = require("jsonwebtoken");

function getToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const cookie = (req.headers.cookie || "")
    .split(/;\s*/)
    .find((c) => c.startsWith("token="));
  if (cookie) return decodeURIComponent(cookie.split("=")[1]);
  return null;
}

function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const id = payload.id || payload.userId || payload.sub;
    if (!id) return res.status(401).json({ error: "Unauthorized" });
    req.user = {
      id,
      email: payload.email,
      role: (payload.role || payload.user_role || "user").toLowerCase(),
      ...payload,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role === "admin" || req.user.is_admin === true) return next();
  return res.status(403).json({ error: "Admin only" });
}

module.exports = { requireAuth, requireAdmin };
