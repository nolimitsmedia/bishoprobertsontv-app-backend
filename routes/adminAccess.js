// server-api/routes/adminAccess.js
//
// Phase 8-1: GET /api/admin/access/me — what the signed-in person may use in
// the admin panel (role, Owner flag, team roles, areas). Read from the database.

const express = require("express");
const router = express.Router();
const { loadAccess, userIdFromToken } = require("../lib/teamAccess");

router.get("/me", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    if (!process.env.JWT_SECRET)
      return res
        .status(503)
        .json({ ok: false, error: "Authentication unavailable" });
    const id = userIdFromToken(req);
    if (!id) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const access = await loadAccess(id);
    if (!access)
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    res.json({
      ok: true,
      access: {
        id: access.id,
        name: access.name,
        email: access.email,
        isAdmin: access.isAdmin,
        isOwner: access.isOwner,
        isStaff: access.isStaff,
        teamRoles: access.teamRoles,
        areas: access.areas,
      },
    });
  } catch (e) {
    console.error("[adminAccess] error:", e);
    res.status(500).json({ ok: false, error: "Unable to check access" });
  }
});

module.exports = router;
