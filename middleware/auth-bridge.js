// server-api/middleware/auth-bridge.js
const jwt = require("jsonwebtoken");

/**
 * Populates req.user from:
 *  1) Authorization: Bearer <jwt>  (preferred)
 *  2) httpOnly cookie "token"      (if you set one on login)
 *  3) X-Dev-User-Id header         (handy for local dev)
 */
module.exports = function authBridge(req, _res, next) {
  // 1) Bearer token
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || "devsecret");
      if (payload?.sub || payload?.id) {
        req.user = { id: Number(payload.sub || payload.id) };
        return next();
      }
    } catch {}
  }

  // 2) Cookie named "token"
  try {
    const cookieHeader = req.headers.cookie || "";
    const token = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("token="))
      ?.split("=")[1];

    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET || "devsecret");
      if (payload?.sub || payload?.id) {
        req.user = { id: Number(payload.sub || payload.id) };
        return next();
      }
    }
  } catch {}

  // 3) Dev escape hatch
  if (req.headers["x-dev-user-id"]) {
    req.user = { id: Number(req.headers["x-dev-user-id"]) };
  }

  return next();
};
