// server-api/middleware/authenticateAdmin.js
// Protects /api/admin/pages and other routes using this guard.
// Independently verifies the JWT and looks up the CURRENT role in PostgreSQL.
// Do not trust req.user from auth-bridge alone: that bridge attaches only an id
// and supports a development-only identity header.
const jwt = require("jsonwebtoken");
const db = require("../db");

const ADMIN_ROLES = new Set([
  "admin",
  "superadmin",
  "super_admin",
  "staff_admin",
]);

function readToken(req) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const access = req.get("x-access-token");
  if (access) return String(access).trim();
  return req.cookies?.token || null;
}

module.exports = async function authenticateAdmin(req, res, next) {
  try {
    const token = readToken(req);
    if (!token)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    // Match the auth-bridge's JWT secret selection; require an explicit
    // production secret to avoid accepting tokens signed with a default.
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("[authenticateAdmin] JWT_SECRET is not configured");
      return res
        .status(503)
        .json({ ok: false, error: "Authentication unavailable" });
    }

    const payload = jwt.verify(token, secret);
    const id = Number(payload?.sub || payload?.id || payload?.user?.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { rows } = await db.query(
      "SELECT id, name, email, role FROM users WHERE id = $1 LIMIT 1",
      [id],
    );
    const user = rows[0];
    if (!user)
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (
      !ADMIN_ROLES.has(
        String(user.role || "")
          .toLowerCase()
          .trim(),
      )
    ) {
      return res
        .status(403)
        .json({ ok: false, error: "Admin access required" });
    }

    req.user = user;
    req.admin = user;
    return next();
  } catch (err) {
    if (
      err?.name === "JsonWebTokenError" ||
      err?.name === "TokenExpiredError" ||
      err?.name === "NotBeforeError"
    ) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    console.error("[authenticateAdmin] verification failed:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Authentication check failed" });
  }
};
