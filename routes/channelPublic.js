// server-api/routes/channelPublic.js
const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/:slug", async (req, res) => {
  const { rows } = await db.query(
    "SELECT id, title, subtitle, theme FROM channels WHERE LOWER(slug)=LOWER($1) AND visibility='public' LIMIT 1",
    [req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ message: "Channel not found" });
  res.json(rows[0]);
});

router.get("/:slug/pages", async (req, res) => {
  const c = await db.query(
    "SELECT id FROM channels WHERE LOWER(slug)=LOWER($1) AND visibility='public' LIMIT 1",
    [req.params.slug]
  );
  if (!c.rows[0]) return res.status(404).json({ message: "Channel not found" });

  const { rows } = await db.query(
    `SELECT slug, title, kind, nav_order
     FROM channel_pages
     WHERE channel_id=$1 AND is_visible=TRUE
     ORDER BY nav_order, id`,
    [c.rows[0].id]
  );
  res.json(rows);
});

router.get("/:slug/pages/:page", async (req, res) => {
  const c = await db.query(
    "SELECT id FROM channels WHERE LOWER(slug)=LOWER($1) AND visibility='public' LIMIT 1",
    [req.params.slug]
  );
  if (!c.rows[0]) return res.status(404).json({ message: "Channel not found" });

  const { rows } = await db.query(
    `SELECT slug, title, kind, blocks, seo
     FROM channel_pages
     WHERE channel_id=$1 AND LOWER(slug)=LOWER($2) AND is_visible=TRUE
     LIMIT 1`,
    [c.rows[0].id, req.params.page]
  );
  if (!rows[0]) return res.status(404).json({ message: "Page not found" });
  res.json(rows[0]);
});

router.get("/:slug/videos", async (req, res) => {
  const c = await db.query(
    "SELECT id, owner_user_id FROM channels WHERE LOWER(slug)=LOWER($1) AND visibility='public' LIMIT 1",
    [req.params.slug]
  );
  if (!c.rows[0]) return res.status(404).json({ message: "Channel not found" });

  const limit = Math.min(Number(req.query.limit || 24), 100);
  const { rows } = await db.query(
    `SELECT id, title, thumbnail_url, duration_seconds, created_at, visibility
     FROM videos
     WHERE created_by=$1 AND visibility='public'
     ORDER BY created_at DESC
     LIMIT $2`,
    [c.rows[0].owner_user_id, limit]
  );
  res.json(rows);
});

router.get("/:slug/stream", async (req, res) => {
  const c = await db.query(
    "SELECT id FROM channels WHERE LOWER(slug)=LOWER($1) AND visibility='public' LIMIT 1",
    [req.params.slug]
  );
  if (!c.rows[0]) return res.status(404).json({ message: "Channel not found" });

  const { rows } = await db.query(
    `SELECT status, playback_url, starts_at, ends_at, metadata
     FROM streams
     WHERE channel_id=$1
     ORDER BY (status='live') DESC, starts_at DESC NULLS LAST
     LIMIT 1`,
    [c.rows[0].id]
  );
  res.json(rows[0] || { status: "offline" });
});

module.exports = router;
