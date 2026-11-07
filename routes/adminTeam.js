// server-api/routes/adminTeam.js
//
// Phase 8-1: team management (administrators only).
//   GET  /api/admin/team                       administrators and team members
//   POST /api/admin/team/members               add an existing account { email, roles }
//   PUT  /api/admin/team/:userId/roles         set roles { roles: [] } ([] removes)
//   POST /api/admin/team/transfer-ownership    Owner only { userId } (an administrator)

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireArea, STAGE_ROLES } = require("../lib/teamAccess");

router.use(requireArea()); // administrators only

function cleanRoles(input) {
  if (!Array.isArray(input)) return null;
  const set = [
    ...new Set(
      input.map((r) =>
        String(r || "")
          .trim()
          .toLowerCase(),
      ),
    ),
  ];
  return set.every((r) => STAGE_ROLES.includes(r)) ? set : null;
}

function missingTable(e, res) {
  if (String(e?.code) !== "42P01" && String(e?.code) !== "42703") return false;
  res.status(503).json({
    ok: false,
    error:
      "Team roles are not set up yet. Run the 20261105_07_team_roles.sql migration.",
  });
  return true;
}

async function setRoles(userId, roles, grantedBy) {
  await db.query(
    "DELETE FROM admin_team_roles WHERE user_id = $1 AND NOT (role = ANY($2::text[]))",
    [userId, roles],
  );
  for (const r of roles) {
    await db.query(
      `INSERT INTO admin_team_roles (user_id, role, granted_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, r, grantedBy],
    );
  }
}

async function teamList() {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role,
            COALESCE((to_jsonb(u) ->> 'is_owner')::boolean, FALSE) AS is_owner,
            COALESCE(array_agg(t.role ORDER BY t.role) FILTER (WHERE t.role IS NOT NULL), '{}') AS team_roles
       FROM users u
       LEFT JOIN admin_team_roles t ON t.user_id = u.id
      WHERE LOWER(COALESCE(u.role::text, '')) IN ('admin','superadmin','super_admin','staff_admin')
         OR t.user_id IS NOT NULL
      GROUP BY u.id
      ORDER BY COALESCE((to_jsonb(u) ->> 'is_owner')::boolean, FALSE) DESC,
               (LOWER(COALESCE(u.role::text,'')) IN ('admin','superadmin','super_admin','staff_admin')) DESC,
               LOWER(COALESCE(u.name, u.email, ''))`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    email: r.email,
    isAdmin: ["admin", "superadmin", "super_admin", "staff_admin"].includes(
      String(r.role || "").toLowerCase(),
    ),
    isOwner: !!r.is_owner,
    teamRoles: r.team_roles || [],
  }));
}

router.get("/", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, members: await teamList(), roles: STAGE_ROLES });
  } catch (e) {
    if (missingTable(e, res)) return;
    console.error("[adminTeam:list]", e);
    res.status(500).json({ ok: false, error: "Unable to load the team" });
  }
});

async function assignRoles(req, res, userRow) {
  const roles = cleanRoles(req.body?.roles);
  if (!roles)
    return res.status(400).json({ ok: false, error: "Unknown team role" });
  if (
    ["admin", "superadmin", "super_admin", "staff_admin"].includes(
      String(userRow.role || "").toLowerCase(),
    )
  )
    return res
      .status(400)
      .json({ ok: false, error: "Administrators already have every area." });
  await setRoles(Number(userRow.id), roles, req.user?.id ?? null);
  return res.json({ ok: true, members: await teamList() });
}

router.post("/members", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    if (!email)
      return res
        .status(400)
        .json({ ok: false, error: "Enter an email address" });
    const roles = cleanRoles(req.body?.roles);
    if (!roles || !roles.length)
      return res
        .status(400)
        .json({ ok: false, error: "Choose at least one role" });
    const { rows } = await db.query(
      "SELECT id, role FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [email],
    );
    if (!rows.length)
      return res.status(404).json({
        ok: false,
        error:
          "No account uses that email. Ask the person to register first, then add them.",
      });
    return await assignRoles(req, res, rows[0]);
  } catch (e) {
    if (missingTable(e, res)) return;
    console.error("[adminTeam:add]", e);
    res.status(500).json({ ok: false, error: "Unable to add the team member" });
  }
});

router.put("/:userId/roles", async (req, res) => {
  try {
    const id = Number(req.params.userId);
    if (!Number.isSafeInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "Invalid user ID" });
    const { rows } = await db.query(
      "SELECT id, role FROM users WHERE id = $1",
      [id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "User not found" });
    return await assignRoles(req, res, rows[0]);
  } catch (e) {
    if (missingTable(e, res)) return;
    console.error("[adminTeam:roles]", e);
    res.status(500).json({ ok: false, error: "Unable to update roles" });
  }
});

router.post("/transfer-ownership", async (req, res) => {
  try {
    if (!req.access?.isOwner)
      return res
        .status(403)
        .json({ ok: false, error: "Only the Owner can transfer ownership." });
    const to = Number(req.body?.userId);
    if (!Number.isSafeInteger(to) || to <= 0 || to === req.access.id)
      return res
        .status(400)
        .json({ ok: false, error: "Choose another administrator" });
    const { rows } = await db.query(
      "SELECT id, role FROM users WHERE id = $1",
      [to],
    );
    if (
      !rows.length ||
      !["admin", "superadmin", "super_admin", "staff_admin"].includes(
        String(rows[0].role || "").toLowerCase(),
      )
    )
      return res
        .status(400)
        .json({
          ok: false,
          error: "Ownership can only go to an administrator.",
        });
    // Two ordered steps (a single swap could briefly break the one-Owner rule).
    await db.query("UPDATE users SET is_owner = FALSE WHERE id = $1", [
      req.access.id,
    ]);
    const r = await db.query("UPDATE users SET is_owner = TRUE WHERE id = $1", [
      to,
    ]);
    if (!r.rowCount) {
      await db.query("UPDATE users SET is_owner = TRUE WHERE id = $1", [
        req.access.id,
      ]);
      return res
        .status(500)
        .json({ ok: false, error: "Ownership was not transferred." });
    }
    res.json({ ok: true, members: await teamList() });
  } catch (e) {
    if (missingTable(e, res)) return;
    console.error("[adminTeam:transfer]", e);
    res.status(500).json({ ok: false, error: "Unable to transfer ownership" });
  }
});

module.exports = router;
