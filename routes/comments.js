// server-api/routes/comments.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// 🔔 Centralized FCM sender (Admin SDK with legacy fallback)
const { sendPush } = require("../notifications/fcm");

// If you keep a placeholder "post" for cross-compat with older schemas,
// leave this; otherwise it's harmless to store alongside video_id.
const VIDEO_COMMENTS_POST_ID = "99999999-9999-9999-9999-999999999999";

/* -------------------- utils -------------------- */
function toInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function toDisplayName(row) {
  if (row.user_name && row.user_name.trim() !== "") return row.user_name;
  if (row.user_email && row.user_email.trim() !== "")
    return row.user_email.split("@")[0];
  if (row.user_id) return `Member ${row.user_id}`;
  if (row.author_id) return `Member ${row.author_id}`;
  return "Member";
}

/* ============================================================================
   GET /api/comments?video_id=31&limit=50&offset=0
   (Flat list; you can add parent_id threading later if desired)
============================================================================ */
router.get("/", async (req, res) => {
  try {
    const videoId = toInt(req.query.video_id, NaN);
    if (!Number.isFinite(videoId)) {
      return res.status(400).json({ message: "video_id is required" });
    }

    const limit = Math.min(Math.max(toInt(req.query.limit, 50), 1), 200);
    const offset = Math.max(toInt(req.query.offset, 0), 0);

    const { rows } = await db.query(
      `
      SELECT
        c.id,
        c.post_id,
        c.video_id,
        c.user_id,
        c.author_id,
        c.body,
        c.created_at,
        c.parent_id,
        u.name  AS user_name,
        u.email AS user_email
      FROM public.comments c
      LEFT JOIN public.users u
        ON u.id = c.user_id
      WHERE c.video_id = $1
      ORDER BY c.created_at ASC
      LIMIT $2 OFFSET $3
      `,
      [videoId, limit, offset]
    );

    return res.json({
      items: rows.map((r) => ({
        id: r.id,
        post_id: r.post_id,
        video_id: r.video_id,
        user_id: r.user_id,
        author_id: r.author_id,
        author_name: toDisplayName(r),
        body: r.body,
        created_at: r.created_at,
        parent_id: r.parent_id ?? null,
      })),
    });
  } catch (err) {
    console.error("[GET /comments] error:", err);
    return res.status(500).json({ message: "Failed to load comments" });
  }
});

/* ============================================================================
   BACKWARD: GET /api/comments/by-video/:videoId
============================================================================ */
router.get("/by-video/:videoId", async (req, res) => {
  try {
    const videoId = toInt(req.params.videoId, NaN);
    if (!Number.isFinite(videoId)) {
      return res.status(400).json({ message: "video_id is required" });
    }

    const { rows } = await db.query(
      `
      SELECT
        c.id,
        c.post_id,
        c.video_id,
        c.user_id,
        c.author_id,
        c.body,
        c.created_at,
        c.parent_id,
        u.name  AS user_name,
        u.email AS user_email
      FROM public.comments c
      LEFT JOIN public.users u
        ON u.id = c.user_id
      WHERE c.video_id = $1
      ORDER BY c.created_at ASC
      `,
      [videoId]
    );

    return res.json({
      items: rows.map((r) => ({
        id: r.id,
        post_id: r.post_id,
        video_id: r.video_id,
        user_id: r.user_id,
        author_id: r.author_id,
        author_name: toDisplayName(r),
        body: r.body,
        created_at: r.created_at,
        parent_id: r.parent_id ?? null,
      })),
    });
  } catch (err) {
    console.error("[GET /comments/by-video/:videoId] error:", err);
    return res.status(500).json({ message: "Failed to load comments" });
  }
});

/* ============================================================================
   POST /api/comments  (auth required)
   Accepts: { video_id, text|body|content, parent_id? }
============================================================================ */
router.post("/", authenticate, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Login required" });

    const videoIdRaw = req.body?.video_id ?? req.body?.videoId ?? null;
    const videoId =
      videoIdRaw !== null && videoIdRaw !== undefined
        ? Number(videoIdRaw)
        : null;
    if (!Number.isFinite(videoId)) {
      return res.status(400).json({ message: "video_id is required" });
    }

    const rawText = req.body?.text ?? req.body?.body ?? req.body?.content ?? "";
    const text = String(rawText).trim();
    if (!text) {
      return res.status(400).json({ message: "text/body is required" });
    }

    // Optional parent (threading). If your DB has parent_id as INTEGER FK, this will work.
    // If you created parent_id as UUID by mistake, either drop/change it to INTEGER,
    // or cast appropriately here.
    let parentId = req.body?.parent_id ?? null;
    if (parentId !== null && parentId !== undefined) {
      const n = Number(parentId);
      parentId = Number.isFinite(n) ? Math.trunc(n) : null;
    }

    // Insert
    const insert = await db.query(
      `
      INSERT INTO public.comments (post_id, video_id, user_id, author_id, body, parent_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [VIDEO_COMMENTS_POST_ID, videoId, userId, userId, text, parentId]
    );
    const newId = insert.rows[0].id;

    // Read back (joined with user)
    const { rows } = await db.query(
      `
      SELECT
        c.id, c.post_id, c.video_id, c.user_id, c.author_id, c.body, c.created_at, c.parent_id,
        u.name  AS user_name, u.email AS user_email
      FROM public.comments c
      LEFT JOIN public.users u ON u.id = c.user_id
      WHERE c.id = $1
      LIMIT 1
      `,
      [newId]
    );
    const row = rows[0];

    // Fire & forget notifications (video owner + prior commenters, excluding author)
    (async () => {
      try {
        const meta = await db.query(
          `SELECT created_by, title FROM videos WHERE id = $1 LIMIT 1`,
          [videoId]
        );
        const videoOwnerId = meta.rows?.[0]?.created_by || null;
        const videoTitle = meta.rows?.[0]?.title || "New comment";

        const prior = await db.query(
          `SELECT DISTINCT user_id
             FROM comments
            WHERE video_id = $1
              AND user_id IS NOT NULL
              AND user_id <> $2
            LIMIT 500`,
          [videoId, userId]
        );

        const userSet = new Set();
        if (videoOwnerId && String(videoOwnerId) !== String(userId)) {
          userSet.add(String(videoOwnerId));
        }
        for (const r of prior.rows) {
          if (String(r.user_id) !== String(userId)) {
            userSet.add(String(r.user_id));
          }
        }
        const ids = Array.from(userSet);
        if (ids.length === 0) return;

        // If your users.id is INTEGER (recommended), this works:
        const t = await db.query(
          `SELECT token
             FROM user_push_tokens
            WHERE token IS NOT NULL AND token <> ''
              AND user_id = ANY($1::int[])`,
          [ids.map((x) => Number(x))]
        );
        const tokens = t.rows.map((r) => r.token).filter(Boolean);

        await sendPush(tokens, {
          title: "New comment",
          body: `${toDisplayName(row)}: ${text.slice(0, 90)}`,
          data: {
            type: "comment_created",
            video_id: String(videoId),
            comment_id: String(newId),
            parent_id: parentId != null ? String(parentId) : "",
            title: videoTitle,
          },
        });
      } catch (e) {
        console.warn("[FCM] comment notification skipped:", e?.message || e);
      }
    })();

    return res.status(201).json({
      comment: {
        id: row.id,
        post_id: row.post_id,
        video_id: row.video_id,
        user_id: row.user_id,
        author_id: row.author_id,
        author_name: toDisplayName(row),
        body: row.body,
        created_at: row.created_at,
        parent_id: row.parent_id ?? null,
      },
    });
  } catch (err) {
    console.error("[POST /comments] error:", err);
    return res.status(500).json({ message: "Failed to post comment" });
  }
});

/* ============================================================================
   DELETE /api/comments/:id  (author or admin/owner)
============================================================================ */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const cur = await db.query(
      "SELECT id, user_id FROM public.comments WHERE id = $1 LIMIT 1",
      [id]
    );
    if (!cur.rowCount) {
      return res.status(404).json({ message: "Not found" });
    }

    const comment = cur.rows[0];
    const isOwner = String(comment.user_id) === String(req.user.id);
    const role = (req.user?.role || req.user?.type || "").toLowerCase();
    const isAdmin = role === "admin" || role === "owner";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await db.query("DELETE FROM public.comments WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /comments/:id] error:", err);
    return res.status(500).json({ message: "Failed to delete comment" });
  }
});

module.exports = router;
