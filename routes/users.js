const express = require("express");
const router = express.Router();
const db = require("../db");

router.post("/push-token", async (req, res) => {
  const { token, user_id } = req.body;
  if (!token || !user_id)
    return res.status(400).json({ error: "Missing token or user_id" });

  try {
    await db.query(
      `INSERT INTO user_push_tokens (user_id, token, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (token) DO NOTHING`,
      [user_id, token]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error saving token:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
