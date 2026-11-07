// server-api/routes/adminUsers.js
const express = require("express");
const bcrypt = require("bcrypt");
const router = express.Router();

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

/**
 * Helpers (same style as adminDashboard.js)
 */
async function hasColumn(db, table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
  `;
  const r = await db.query(q, [table, column]);
  return r.rowCount > 0;
}

async function pickFirstExistingColumn(db, table, candidates) {
  for (const col of candidates) {
    // allow raw expressions
    if (col.includes("(") || col.includes(" ") || col.includes("::"))
      return col;
    // eslint-disable-next-line no-await-in-loop
    if (await hasColumn(db, table, col)) return col;
  }
  return null;
}

function isEmailLike(v) {
  const s = String(v || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function normalizeRole(role) {
  const r = String(role || "user")
    .trim()
    .toLowerCase();
  return r === "admin" || r === "super_admin" || r === "superadmin"
    ? "admin"
    : "user";
}

/**
 * DB-backed admin guard (matches auth-bridge.js)
 * - authBridge sets req.user = { id }
 * - we verify admin by reading users.role (or fallback columns if schema differs)
 */
async function isAdminUser(db, userId) {
  const usersTable = "users";

  const idCol = await pickFirstExistingColumn(db, usersTable, [
    "id",
    "user_id",
  ]);
  if (!idCol) return false;

  const roleCol = await pickFirstExistingColumn(db, usersTable, [
    "role",
    "user_role",
    "type",
  ]);

  const isAdminCol = await pickFirstExistingColumn(db, usersTable, [
    "is_admin",
    "isAdmin",
    "admin",
  ]);

  if (isAdminCol) {
    const sql = `
      SELECT (${isAdminCol} = true) AS ok
      FROM ${usersTable}
      WHERE ${idCol} = $1
      LIMIT 1
    `;
    const r = await db.query(sql, [userId]);
    return !!r.rows?.[0]?.ok;
  }

  if (roleCol) {
    const sql = `
      SELECT LOWER(COALESCE(${roleCol}::text,'')) AS role
      FROM ${usersTable}
      WHERE ${idCol} = $1
      LIMIT 1
    `;
    const r = await db.query(sql, [userId]);
    const role = r.rows?.[0]?.role || "";
    return ["admin", "super_admin", "superadmin"].includes(role);
  }

  return false;
}

async function requireAdmin(req, res, next) {
  try {
    const db = req.db;

    const userId = Number(req.user?.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const ok = await isAdminUser(db, userId);
    if (!ok) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    return next();
  } catch (e) {
    console.error("[adminUsers] requireAdmin error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}

/* -----------------------------
   Phase 8-1: Owner rules (as in Uscreen)
   - nobody changes their own role or deletes their own account here
   - the Owner cannot be demoted or deleted (transfer ownership first)
   - only the Owner adds or removes administrators
   Before the team-roles migration (no Owner yet) only the first rule applies.
----------------------------- */
async function loadRoleInfo(db, id) {
  const { rows } = await db.query(
    `SELECT id, role,
            COALESCE((to_jsonb(users) ->> 'is_owner')::boolean, FALSE) AS is_owner
       FROM users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

function ownerRules(action) {
  return async function (req, res, next) {
    try {
      const db = req.db;
      const actorId = Number(req.user?.id);
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId) || targetId <= 0) return next();
      const [actor, target] = await Promise.all([
        loadRoleInfo(db, actorId),
        loadRoleInfo(db, targetId),
      ]);
      if (!target) return next(); // the route answers "not found"
      const ownerExists =
        (
          await db.query(
            `SELECT 1 FROM users WHERE COALESCE((to_jsonb(users) ->> 'is_owner')::boolean, FALSE) LIMIT 1`,
          )
        ).rows.length > 0;
      const actorIsOwner = !!actor?.is_owner;
      const targetIsAdmin = normalizeRole(target.role) === "admin";
      const deny = (message) =>
        res.status(403).json({ ok: false, message, error: message });

      if (action === "delete") {
        if (targetId === actorId)
          return deny("You can't delete your own account here.");
        if (target.is_owner)
          return deny(
            "The Owner's account can't be deleted. Transfer ownership first.",
          );
        if (targetIsAdmin && ownerExists && !actorIsOwner)
          return deny("Only the Owner can remove administrators.");
        return next();
      }

      // Phase 8-2: Customer Support (not an administrator) edits member accounts
      // only: never staff accounts (that could take them over) and never roles.
      if (req.access && !req.access.isAdmin) {
        const staffTarget =
          targetIsAdmin ||
          (
            await db
              .query(
                "SELECT 1 FROM admin_team_roles WHERE user_id = $1 LIMIT 1",
                [targetId],
              )
              .catch(() => ({ rows: [] }))
          ).rows.length > 0;
        if (staffTarget)
          return deny(
            "Customer Support can edit member accounts only, not team or administrator accounts.",
          );
        if (
          req.body?.role !== undefined &&
          normalizeRole(req.body.role) !== normalizeRole(target.role)
        )
          return deny("Customer Support can't change roles.");
        return next();
      }

      // update: only role changes are restricted
      if (req.body?.role === undefined) return next();
      const newRole = normalizeRole(req.body.role);
      const oldRole = normalizeRole(target.role);
      if (newRole === oldRole) return next();
      if (targetId === actorId) return deny("You can't change your own role.");
      if (target.is_owner)
        return deny(
          "The Owner's role can't be changed. Transfer ownership first.",
        );
      if (
        (newRole === "admin" || oldRole === "admin") &&
        ownerExists &&
        !actorIsOwner
      )
        return deny("Only the Owner can add or remove administrators.");
      return next();
    } catch (e) {
      console.error("[adminUsers] owner rules error:", e);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  };
}

// Phase 8-2: Customer Support views and edits member accounts; Marketing
// Managers read the list (Email Center recipients). requireArea also admits
// administrators and verifies the person's current access from the database.
const { requireArea } = require("../lib/teamAccess");
const listReaders = requireArea("support", "marketing");
const supportStaff = requireArea("support");

/**
 * GET /api/admin/users
 * Query:
 *  - search
 *  - page (default 1)
 *  - limit (default 25, max 100)
 *  - sort (created_at|id|name|email|role)
 *  - order (asc|desc)
 */
router.get("/", listReaders, async (req, res) => {
  try {
    const db = req.db;
    const usersTable = "users";

    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const limitRaw = parseInt(req.query.limit || "25", 10) || 25;
    const limit = Math.max(1, Math.min(100, limitRaw));
    const offset = (page - 1) * limit;

    const search = String(req.query.search || "").trim();

    const idCol = await pickFirstExistingColumn(db, usersTable, [
      "id",
      "user_id",
    ]);
    if (!idCol) {
      return res
        .status(500)
        .json({ ok: false, message: "User id column not found" });
    }

    const createdCol = await pickFirstExistingColumn(db, usersTable, [
      "created_at",
      "createdAt",
      "date_created",
      "registered_at",
    ]);

    const nameCol = await pickFirstExistingColumn(db, usersTable, [
      "name",
      "full_name",
      "fullname",
      "display_name",
      "username",
    ]);

    const emailCol = await pickFirstExistingColumn(db, usersTable, [
      "email",
      "email_address",
      "user_email",
    ]);

    const roleCol = await pickFirstExistingColumn(db, usersTable, [
      "role",
      "user_role",
      "type",
    ]);

    const sortRequested = String(req.query.sort || "")
      .trim()
      .toLowerCase();
    const orderRequested = String(req.query.order || "desc")
      .trim()
      .toLowerCase();
    const order = orderRequested === "asc" ? "ASC" : "DESC";

    const sortMap = {
      created_at: createdCol || idCol,
      id: idCol,
      name: nameCol || createdCol || idCol,
      email: emailCol || createdCol || idCol,
      role: roleCol || createdCol || idCol,
    };

    const sortKey = sortMap[sortRequested] ? sortRequested : "created_at";
    const sortCol = sortMap[sortKey];

    const params = [];
    let where = "WHERE 1=1";

    if (search && (nameCol || emailCol)) {
      params.push(`%${search}%`);
      const parts = [];
      if (nameCol) parts.push(`${nameCol} ILIKE $${params.length}`);
      if (emailCol) parts.push(`${emailCol} ILIKE $${params.length}`);
      where += ` AND (${parts.join(" OR ")})`;
    }

    const countSql = `
      SELECT COUNT(*)::int AS n
      FROM ${usersTable}
      ${where}
    `;
    const total = (await db.query(countSql, params)).rows?.[0]?.n || 0;

    const selectCols = [
      `${idCol} AS id`,
      nameCol ? `${nameCol} AS name` : "NULL AS name",
      emailCol ? `${emailCol} AS email` : "NULL AS email",
      roleCol ? `${roleCol} AS role` : "NULL AS role",
      createdCol ? `${createdCol} AS created_at` : "NULL AS created_at",
    ].join(", ");

    params.push(limit);
    params.push(offset);

    const listSql = `
      SELECT ${selectCols}
      FROM ${usersTable}
      ${where}
      ORDER BY ${sortCol} ${order} NULLS LAST
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const users = (await db.query(listSql, params)).rows || [];

    return res.json({ ok: true, page, limit, total, users });
  } catch (e) {
    console.error("[adminUsers] list error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * GET /api/admin/users/:id
 * Returns a single user (safe fields only)
 */
router.get("/:id", supportStaff, async (req, res) => {
  try {
    const db = req.db;
    const usersTable = "users";
    const userId = req.params.id;

    const idCol = await pickFirstExistingColumn(db, usersTable, [
      "id",
      "user_id",
    ]);
    if (!idCol) {
      return res
        .status(500)
        .json({ ok: false, message: "User id column not found" });
    }

    const createdCol = await pickFirstExistingColumn(db, usersTable, [
      "created_at",
      "createdAt",
      "date_created",
      "registered_at",
    ]);

    const nameCol = await pickFirstExistingColumn(db, usersTable, [
      "name",
      "full_name",
      "fullname",
      "display_name",
      "username",
    ]);

    const emailCol = await pickFirstExistingColumn(db, usersTable, [
      "email",
      "email_address",
      "user_email",
    ]);

    const roleCol = await pickFirstExistingColumn(db, usersTable, [
      "role",
      "user_role",
      "type",
    ]);

    const selectCols = [
      `${idCol} AS id`,
      nameCol ? `${nameCol} AS name` : "NULL AS name",
      emailCol ? `${emailCol} AS email` : "NULL AS email",
      roleCol ? `${roleCol} AS role` : "NULL AS role",
      createdCol ? `${createdCol} AS created_at` : "NULL AS created_at",
    ].join(", ");

    const sql = `
      SELECT ${selectCols}
      FROM ${usersTable}
      WHERE ${idCol} = $1
      LIMIT 1
    `;

    const r = await db.query(sql, [userId]);
    const user = r.rows?.[0];

    if (!user)
      return res.status(404).json({ ok: false, message: "User not found" });

    return res.json({ ok: true, user });
  } catch (e) {
    console.error("[adminUsers] detail error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * PUT /api/admin/users/:id
 * Body: { name, email, role, password? }
 * - password optional; if provided, hashes and updates password_hash/password column
 */
router.put("/:id", supportStaff, ownerRules("update"), async (req, res) => {
  try {
    const db = req.db;
    const usersTable = "users";
    const userId = req.params.id;

    const idCol = await pickFirstExistingColumn(db, usersTable, [
      "id",
      "user_id",
    ]);
    if (!idCol)
      return res
        .status(500)
        .json({ ok: false, message: "User id column not found" });

    const nameCol = await pickFirstExistingColumn(db, usersTable, [
      "name",
      "full_name",
      "fullname",
      "display_name",
      "username",
    ]);

    const emailCol = await pickFirstExistingColumn(db, usersTable, [
      "email",
      "email_address",
      "user_email",
    ]);

    const roleCol = await pickFirstExistingColumn(db, usersTable, [
      "role",
      "user_role",
      "type",
    ]);

    // Common password columns across projects:
    const passCol = await pickFirstExistingColumn(db, usersTable, [
      "password_hash",
      "password",
      "passwordHash",
      "pass_hash",
      "hash",
    ]);

    const name = String(req.body?.name ?? "").trim();
    const email = String(req.body?.email ?? "").trim();
    const role = normalizeRole(req.body?.role);
    const password = String(req.body?.password ?? "").trim();

    if (!name)
      return res.status(400).json({ ok: false, message: "Name is required" });
    if (!email)
      return res.status(400).json({ ok: false, message: "Email is required" });
    if (!isEmailLike(email)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid email address" });
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (nameCol) {
      sets.push(`${nameCol} = $${idx++}`);
      params.push(name);
    }
    if (emailCol) {
      sets.push(`${emailCol} = $${idx++}`);
      params.push(email);
    }
    if (roleCol) {
      sets.push(`${roleCol} = $${idx++}`);
      params.push(role);
    }

    // Optional password update
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({
          ok: false,
          message: "Password must be at least 6 characters",
        });
      }
      if (!passCol) {
        return res.status(400).json({
          ok: false,
          message:
            "Password column not found in users table (expected password_hash/password)",
        });
      }

      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      sets.push(`${passCol} = $${idx++}`);
      params.push(hashed);
    }

    if (sets.length === 0) {
      return res
        .status(400)
        .json({ ok: false, message: "No valid fields to update" });
    }

    params.push(userId);
    const sql = `
      UPDATE ${usersTable}
      SET ${sets.join(", ")}
      WHERE ${idCol} = $${idx}
      RETURNING ${idCol} AS id
    `;

    const r = await db.query(sql, params);
    if (r.rowCount === 0)
      return res.status(404).json({ ok: false, message: "User not found" });

    return res.json({ ok: true, id: r.rows?.[0]?.id });
  } catch (e) {
    console.error("[adminUsers] update error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/:id", requireAdmin, ownerRules("delete"), async (req, res) => {
  const db = req.db;
  const usersTable = "users";
  const userId = Number(req.params.id);

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, message: "Invalid user id" });
  }

  try {
    await db.query("BEGIN");

    // 1) Delete child rows first (add more tables here as needed)
    await db.query("DELETE FROM notifications WHERE user_id = $1", [userId]);

    // 2) Then delete the user
    const del = await db.query(`DELETE FROM ${usersTable} WHERE id = $1`, [
      userId,
    ]);

    await db.query("COMMIT");
    // Phase 8-1: remove the deleted user's team roles (ignored before the migration).
    await db
      .query("DELETE FROM admin_team_roles WHERE user_id = $1", [userId])
      .catch(() => {});

    if (del.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true });
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    console.error("[adminUsers] delete error:", e);

    // If something else still references the user, return a friendly message
    if (e?.code === "23503") {
      return res.status(409).json({
        ok: false,
        message:
          "This user has related records (e.g., notifications) and can’t be deleted until those are removed. Consider disabling the account instead.",
      });
    }

    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
