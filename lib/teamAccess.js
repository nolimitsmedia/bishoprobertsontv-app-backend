// server-api/lib/teamAccess.js
//
// Phase 8-1: who may use which admin area.
//
// Administrators (and the Owner) may use every area. Other team members may use
// only the areas granted to them in admin_team_roles:
//   website  pages, templates and saved sections, Media Library, navigation,
//            design settings, SEO, publishing
//   content  videos, collections, categories, live streaming, calendar,
//            resources, organize, Wasabi import
//   video_upload  upload videos and see the library; edit/delete own uploads only
//   community     moderate community posts and video comments
//   marketing     Email Center (send emails, job history, recipient list)
//   support       Users: view and edit member accounts (not staff, not roles,
//                 not deleting)
// Everything is read from the database on each request, so a change of role
// takes effect immediately.

const jwt = require("jsonwebtoken");
const db = require("../db");

const ADMIN_ROLES = new Set([
  "admin",
  "superadmin",
  "super_admin",
  "staff_admin",
]);
const TEAM_ROLES = [
  "website",
  "content",
  "video_upload",
  "community",
  "marketing",
  "plans",
  "support",
];
// Assignable roles. "plans" stays reserved until a subscription-plans screen exists.
const STAGE_ROLES = [
  "website",
  "content",
  "video_upload",
  "community",
  "marketing",
  "support",
];

function readToken(req) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const access = req.get?.("x-access-token");
  if (access) return String(access).trim();
  return req.cookies?.token || null;
}

function userIdFromToken(req) {
  const token = readToken(req);
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    const id = Number(
      payload?.sub || payload?.id || payload?.userId || payload?.user?.id,
    );
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

// Current role, owner flag and team roles. Works before the migration runs
// (is_owner and team roles are then simply absent).
async function loadAccess(userId) {
  const { rows } = await db.query(
    `SELECT id, name, email, role,
            COALESCE((to_jsonb(users) ->> 'is_owner')::boolean, FALSE) AS is_owner
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const user = rows[0];
  if (!user) return null;
  let teamRoles = [];
  try {
    const r = await db.query(
      "SELECT role FROM admin_team_roles WHERE user_id = $1 ORDER BY role",
      [userId],
    );
    teamRoles = r.rows.map((x) => x.role);
  } catch (e) {
    if (String(e?.code) !== "42P01") throw e; // table not created yet
  }
  const isAdmin = ADMIN_ROLES.has(
    String(user.role || "")
      .toLowerCase()
      .trim(),
  );
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin,
    isOwner: !!user.is_owner && isAdmin,
    teamRoles,
    areas: isAdmin ? ["all"] : teamRoles,
    isStaff: isAdmin || teamRoles.length > 0,
  };
}

function hasArea(access, area) {
  if (!access) return false;
  if (access.isAdmin) return true;
  return access.teamRoles.includes(area);
}

function sendAuthError(res, status, error) {
  return res.status(status).json({ ok: false, error, message: error });
}

// Blocking guard: verifies the token itself and requires one of the areas.
// requireArea() with no areas = administrators only.
function requireArea(...areas) {
  return async function areaGuard(req, res, next) {
    try {
      if (!process.env.JWT_SECRET)
        return sendAuthError(res, 503, "Authentication unavailable");
      const id = userIdFromToken(req);
      if (!id) return sendAuthError(res, 401, "Unauthorized");
      const access = await loadAccess(id);
      if (!access) return sendAuthError(res, 401, "Unauthorized");
      const allowed = areas.length
        ? areas.some((a) => hasArea(access, a))
        : access.isAdmin;
      if (!allowed)
        return sendAuthError(res, 403, "You don't have access to this area");
      req.user = {
        ...(req.user || {}),
        id: access.id,
        name: access.name,
        email: access.email,
        role: access.role,
        teamRoles: access.teamRoles,
        isOwner: access.isOwner,
      };
      req.admin = req.user;
      req.access = access;
      return next();
    } catch (err) {
      console.error("[teamAccess] check failed:", err);
      return sendAuthError(res, 500, "Authentication check failed");
    }
  };
}

// Non-blocking: for routers that serve the public and the admin. When a valid
// token is present, attaches the person's current access (team roles) to
// req.user so the route's own checks can recognise team members.
async function attachTeamAccess(req, _res, next) {
  try {
    const id = userIdFromToken(req);
    if (id) {
      const access = await loadAccess(id);
      if (access) {
        req.access = access;
        req.user = {
          ...(req.user || {}),
          id: access.id,
          role: access.role,
          teamRoles: access.teamRoles,
          isOwner: access.isOwner,
        };
      }
    }
  } catch (err) {
    console.error("[teamAccess] attach failed:", err?.message || err);
  }
  next();
}

module.exports = {
  ADMIN_ROLES,
  TEAM_ROLES,
  STAGE_ROLES,
  loadAccess,
  hasArea,
  requireArea,
  attachTeamAccess,
  userIdFromToken,
};
