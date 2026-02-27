// server-api/middleware/authenticateAdmin.js
/**
 * Admin-only guard compatible with your existing auth-bridge setup.
 *
 * Rules:
 * 1) If LOCAL_DEV=true, allow (keeps dev moving).
 * 2) If auth-bridge attached req.user/req.admin, allow if role looks admin.
 * 3) If user exists but role is unknown, return 403 (and log shape once).
 * 4) Only fallback to JWT verify if a secret is present (never 500 because secret missing).
 */

const jwt = require("jsonwebtoken");

function getToken(req) {
  const hdr =
    req.headers["x-access-token"] ||
    req.headers["authorization"] ||
    req.headers["Authorization"];
  if (!hdr) return null;
  const v = String(hdr);
  if (v.toLowerCase().startsWith("bearer ")) return v.slice(7).trim();
  return v.trim();
}

function isAdminUser(u) {
  if (!u) return false;

  if (u.is_admin === true) return true;
  if (u.isAdmin === true) return true;

  const role = String(
    u.role || u.user_role || u.type || u.account_type || "",
  ).toLowerCase();
  if (["admin", "superadmin", "super_admin", "staff_admin"].includes(role))
    return true;

  return false;
}

let warned = false;

module.exports = function authenticateAdmin(req, res, next) {
  try {
    // 1) Dev override (recommended for your local workflow)
    if (process.env.LOCAL_DEV === "true") return next();

    // 2) Trust auth-bridge attachment first
    const u = req.admin || req.user;
    if (isAdminUser(u)) return next();

    // If auth-bridge provided a user but we can't detect role,
    // do NOT fall back to JWT and cause confusion.
    if (u && !warned) {
      warned = true;
      console.log(
        "[authenticateAdmin] user attached but role not recognized. user keys:",
        Object.keys(u),
      );
    }
    if (u) {
      return res
        .status(403)
        .json({ ok: false, error: "Admin access required" });
    }

    // 3) Optional JWT fallback ONLY if secret exists
    const token = getToken(req);
    if (!token)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const secret =
      process.env.JWT_SECRET ||
      process.env.AUTH_SECRET ||
      process.env.TOKEN_SECRET;

    if (!secret) {
      // Never 500 here — just treat as unauthorized
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, secret);
    const user = decoded?.user || decoded?.admin || decoded;

    if (!isAdminUser(user)) {
      return res
        .status(403)
        .json({ ok: false, error: "Admin access required" });
    }

    req.user = req.user || user;
    return next();
  } catch (_e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
};
