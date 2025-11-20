// server-api/routes/notifications.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// Map DB row → JSON, parsing payload JSONB
function mapRow(row) {
  let payload = null;
  if (row.payload) {
    try {
      payload =
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    } catch (_) {
      payload = null;
    }
  }

  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    body: row.body,
    channel: row.channel,
    payload,
    is_read: row.is_read,
    created_at: row.created_at,
    read_at: row.read_at || null,
  };
}

/**
 * GET /api/notifications
 */
router.get("/", authenticate, async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const { rows } = await db.query(
      `
      SELECT
        id,
        user_id,
        title,
        body,
        channel,
        payload,
        is_read,
        created_at,
        read_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
      [userId, limit, offset]
    );

    res.json({ items: rows.map(mapRow) });
  } catch (err) {
    console.error("[notifications] list error", err);
    res.status(500).json({ message: "Failed to load notifications" });
  }
});

/**
 * GET /api/notifications/unread-count
 */
router.get("/unread-count", authenticate, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `
      SELECT COUNT(*)::int AS c
      FROM notifications
      WHERE user_id = $1 AND is_read = FALSE
    `,
      [userId]
    );
    res.json({ count: rows[0]?.c || 0 });
  } catch (err) {
    console.error("[notifications] unread-count error", err);
    res.status(500).json({ message: "Failed to count notifications" });
  }
});

/**
 * IMPORTANT: mark-all-read must be defined BEFORE :id/read
 * POST /api/notifications/mark-all-read
 */
router.post("/mark-all-read", authenticate, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rowCount } = await db.query(
      `
      UPDATE notifications
      SET is_read = TRUE,
          read_at = COALESCE(read_at, NOW())
      WHERE user_id = $1 AND is_read = FALSE
    `,
      [userId]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (err) {
    console.error("[notifications] mark-all-read error", err);
    res.status(500).json({ message: "Failed to mark notifications as read" });
  }
});

/**
 * POST /api/notifications/:id/read
 */
router.post("/:id/read", authenticate, async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  try {
    const { rows } = await db.query(
      `
      UPDATE notifications
      SET is_read = TRUE,
          read_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, is_read, read_at
    `,
      [id, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[notifications] mark-read error", err);
    res.status(500).json({ message: "Failed to mark notification as read" });
  }
});

module.exports = router;
