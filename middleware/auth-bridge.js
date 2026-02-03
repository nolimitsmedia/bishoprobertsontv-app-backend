// server-api/middleware/auth-bridge.js
const jwt = require("jsonwebtoken");

/**
 * authBridge middleware
 *
 * Populates req.user from:
 *  1) Authorization: Bearer <JWT>
 *  2) Cookie: token=<JWT>
 *  3) Dev header: X-Dev-User-Id
 *
 * This middleware NEVER blocks requests.
 * Authorization decisions happen elsewhere.
 */
module.exports = function authBridge(req, _res, next) {
  // --------------------------------------------------
  // 1) Authorization: Bearer <token>
  // --------------------------------------------------
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || "devsecret");

      const id = Number(payload?.sub || payload?.id);
      if (Number.isFinite(id) && id > 0) {
        req.user = { id };
        return next();
      }
    } catch {
      // ignore invalid token
    }
  }

  // --------------------------------------------------
  // 2) Cookie token
  // --------------------------------------------------
  try {
    const cookieHeader = req.headers.cookie || "";
    const token = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("token="))
      ?.split("=")[1];

    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET || "devsecret");

      const id = Number(payload?.sub || payload?.id);
      if (Number.isFinite(id) && id > 0) {
        req.user = { id };
        return next();
      }
    }
  } catch {
    // ignore cookie parse / verify errors
  }

  // --------------------------------------------------
  // 3) Dev escape hatch
  // --------------------------------------------------
  if (req.headers["x-dev-user-id"]) {
    const id = Number(req.headers["x-dev-user-id"]);
    if (Number.isFinite(id) && id > 0) {
      req.user = { id };
    }
  }

  return next();
};
