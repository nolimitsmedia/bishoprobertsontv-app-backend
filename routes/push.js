// server-api/routes/push.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// POST /api/push/register  { token, platform? }
router.post("/register", authenticate, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { token, platform } = req.body || {};
    if (!userId) return res.status(401).json({ message: "Login required" });
    if (!token || String(token).trim() === "")
      return res.status(400).json({ message: "token is required" });

    // Upsert by token; keep last user_id that registered it
    await db.query(
      `
      INSERT INTO user_push_tokens (user_id, token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (token)
      DO UPDATE SET user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    created_at = NOW()
      `,
      [userId, String(token).trim(), platform || null]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("[push/register] error:", e);
    return res.status(500).json({ message: "Failed to register token" });
  }
});

// Optional: delete
router.post("/unregister", authenticate, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ message: "token is required" });
    await db.query(`DELETE FROM user_push_tokens WHERE token=$1`, [token]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Failed to unregister token" });
  }
});

module.exports = router;
