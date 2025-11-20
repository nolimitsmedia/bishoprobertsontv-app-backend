const express = require("express");
const router = express.Router();
const db = require("../db");

let requireAuth;
try {
  ({ requireAuth } = require("../middleware/auth"));
} catch {}
let authenticate;
try {
  authenticate = require("../middleware/authenticate");
} catch {}
const baseAuth =
  (typeof requireAuth === "function" && requireAuth) ||
  authenticate ||
  ((_req, _res, next) => next());

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_video_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      position_seconds INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, video_id)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, video_id)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_progress_user ON user_video_progress (user_id, updated_at DESC)`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_watchlist_user ON user_watchlist (user_id, created_at DESC)`
  );
}
function uid(req) {
  return req?.user?.id || req?.user?.user_id || req?.user?.uid || null;
}

/* Save progress */
router.post("/progress", baseAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = uid(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { video_id, position, duration } = req.body || {};
    const vid = Number(video_id);
    if (!Number.isFinite(vid))
      return res.status(400).json({ message: "video_id required" });

    const pos = Math.max(0, Math.trunc(Number(position || 0)));
    const dur = Math.max(0, Math.trunc(Number(duration || 0)));

    await db.query(
      `INSERT INTO user_video_progress (user_id, video_id, position_seconds, duration_seconds, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id, video_id)
       DO UPDATE SET position_seconds=EXCLUDED.position_seconds, duration_seconds=EXCLUDED.duration_seconds, updated_at=NOW()`,
      [userId, vid, pos, dur]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /me/progress error:", e);
    res.status(500).json({ message: "Failed to save progress" });
  }
});

/* Continue watching rail */
router.get("/continue", baseAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = uid(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { rows } = await db.query(
      `SELECT p.video_id AS id, p.position_seconds, p.duration_seconds, v.title, v.thumbnail_url
         FROM user_video_progress p
         JOIN videos v ON v.id = p.video_id
        WHERE p.user_id = $1
        ORDER BY p.updated_at DESC
        LIMIT 50`,
      [userId]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error("GET /me/continue error:", e);
    res.status(500).json({ message: "Failed" });
  }
});

/* Watchlist add/remove/list */
router.post("/watchlist", baseAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = uid(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const vid = Number(req.body?.video_id);
    if (!Number.isFinite(vid))
      return res.status(400).json({ message: "video_id required" });

    await db.query(
      `INSERT INTO user_watchlist (user_id, video_id) VALUES ($1,$2)
       ON CONFLICT (user_id, video_id) DO NOTHING`,
      [userId, vid]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /me/watchlist error:", e);
    res.status(500).json({ message: "Failed to add" });
  }
});
router.delete("/watchlist/:id", baseAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = uid(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const vid = Number(req.params.id);
    await db.query(
      `DELETE FROM user_watchlist WHERE user_id=$1 AND video_id=$2`,
      [userId, vid]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /me/watchlist/:id error:", e);
    res.status(500).json({ message: "Failed to remove" });
  }
});
router.get("/watchlist", baseAuth, async (req, res) => {
  try {
    await ensureTables();
    const userId = uid(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { rows } = await db.query(
      `SELECT w.video_id AS id, v.title, v.thumbnail_url
         FROM user_watchlist w
         JOIN videos v ON v.id = w.video_id
        WHERE w.user_id = $1
        ORDER BY w.created_at DESC
        LIMIT 200`,
      [userId]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error("GET /me/watchlist error:", e);
    res.status(500).json({ message: "Failed" });
  }
});

module.exports = router;
