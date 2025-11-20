// server-api/routes/community.js
const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const db = require("../db");

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                               */
/* -------------------------------------------------------------------------- */
function optionalAuth(req, _res, next) {
  return next();
}
function requireAuth(req, res, next) {
  if (req.user && req.user.id) return next();
  return res.status(401).json({ message: "Unauthorized" });
}
function isAdmin(user) {
  const role = (user?.role || "").toLowerCase();
  return role === "admin";
}

/* -------------------------------------------------------------------------- */
/* Name helper for comments                                                   */
/* -------------------------------------------------------------------------- */
function buildCommentAuthorName(profileName, userName, userEmail) {
  if (profileName) {
    const lower = profileName.trim().toLowerCase();
    if (!lower.startsWith("member")) {
      return profileName.trim();
    }
  }
  if (userName && userName.trim() !== "") {
    return userName.trim();
  }
  if (userEmail && userEmail.includes("@")) {
    return userEmail.split("@")[0];
  }
  return "Member";
}

/* -------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* -------------------------------------------------------------------------- */
const uploadDir = path.join(__dirname, "..", "uploads", "community");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${ts}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

function toPublicUrl(relPath) {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:5000";
  return `${base.replace(/\/$/, "")}/uploads/${relPath}`;
}

function normalizeVisibility(v) {
  const allowed = ["public", "members", "admins"];
  const val = (v || "").toLowerCase();
  return allowed.includes(val) ? val : "public";
}

/* A tiny helper to compute author_name for POSTS consistently */
const AUTHOR_NAME_SQL = `
  CASE
    WHEN lower(COALESCE(u.role,'')) = 'admin'
      THEN 'Bishop Robertson TV'
    ELSE COALESCE(pr.display_name, 'Member')
  END
`;

/* -------------------------------------------------------------------------- */
/* GET /api/community/posts                                                   */
/* -------------------------------------------------------------------------- */
router.get("/posts", optionalAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(+req.query.limit || 10, 50));
    const cursor = req.query.cursor ? new Date(req.query.cursor) : null;

    const channelId =
      typeof req.query.channel_id !== "undefined"
        ? parseInt(req.query.channel_id, 10)
        : null;

    const channelSlugRaw = req.query.channel_slug ?? req.query.channel ?? null;
    const channelSlug =
      typeof channelSlugRaw === "string" && channelSlugRaw.trim().length
        ? channelSlugRaw.trim()
        : null;

    let resolvedChannelId = channelId;
    if (!resolvedChannelId && channelSlug) {
      const r = await db.query(
        `SELECT id FROM public.community_channels WHERE slug=$1 LIMIT 1`,
        [channelSlug]
      );
      resolvedChannelId = r.rowCount ? r.rows[0].id : -1;
    }

    const viewer = req.user || null;
    const viewerIsAdmin = !!(viewer && isAdmin(viewer));
    const viewerId = viewer?.id || null;

    let visSQL = `p.visibility = 'public'`;
    if (viewerIsAdmin) visSQL = "TRUE";
    else if (viewerId) visSQL = `p.visibility IN ('public','members')`;

    const params = [viewerIsAdmin, viewerId];

    let where = `WHERE ${visSQL}`;
    if (resolvedChannelId) {
      params.push(resolvedChannelId);
      where += ` AND p.channel_id = $${params.length}`;
    }
    if (cursor && !isNaN(cursor)) {
      params.push(cursor.toISOString());
      where += ` AND p.created_at < $${params.length}`;
    }
    params.push(limit);

    const q = `
      SELECT
        p.id, p.user_id,
        p.title, p.body, p.media_url, p.created_at,
        p.is_pinned, p.visibility, p.channel_id,
        (CASE WHEN $1::boolean IS TRUE OR p.user_id = $2 THEN TRUE ELSE FALSE END) AS can_edit,
        (CASE WHEN $1::boolean IS TRUE OR p.user_id = $2 THEN TRUE ELSE FALSE END) AS can_delete,
        COALESCE(c.cnt, 0)::int AS comments_count,
        COALESCE(l.cnt, 0)::int AS likes_count,
        ${AUTHOR_NAME_SQL} AS author_name
      FROM public.community_posts p
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt
        FROM public.community_comments cc
        WHERE cc.post_id = p.id
      ) c ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt
        FROM public.community_post_likes pl
        WHERE pl.post_id = p.id
      ) l ON TRUE
      LEFT JOIN public.profiles pr ON pr.user_id = p.user_id
      LEFT JOIN public.users u ON u.id = p.user_id
      ${where}
      ORDER BY p.is_pinned DESC, p.created_at DESC
      LIMIT $${params.length};
    `;
    const { rows } = await db.query(q, params);

    const nextCursor =
      rows.length > 0 ? rows[rows.length - 1].created_at : null;

    res.json({ items: rows, nextCursor });
  } catch (err) {
    console.error("[community] GET /posts error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/community/posts/:id                                               */
/* -------------------------------------------------------------------------- */
router.get("/posts/:id", optionalAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ message: "Bad post id" });

    const viewer = req.user || null;
    const viewerIsAdmin = !!(viewer && isAdmin(viewer));
    const viewerId = viewer?.id || null;

    let visSQL = `p.visibility = 'public'`;
    if (viewerIsAdmin) visSQL = "TRUE";
    else if (viewerId) visSQL = `p.visibility IN ('public','members')`;

    const params = [viewerIsAdmin, viewerId, postId];

    const { rows } = await db.query(
      `
      SELECT
        p.id, p.user_id,
        p.title, p.body, p.media_url, p.created_at,
        p.is_pinned, p.visibility, p.channel_id,
        (CASE WHEN $1::boolean IS TRUE OR p.user_id = $2 THEN TRUE ELSE FALSE END) AS can_edit,
        (CASE WHEN $1::boolean IS TRUE OR p.user_id = $2 THEN TRUE ELSE FALSE END) AS can_delete,
        COALESCE(c.cnt, 0)::int AS comments_count,
        COALESCE(l.cnt, 0)::int AS likes_count,
        ${AUTHOR_NAME_SQL} AS author_name
      FROM public.community_posts p
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt
        FROM public.community_comments cc
        WHERE cc.post_id = p.id
      ) c ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt
        FROM public.community_post_likes pl
        WHERE pl.post_id = p.id
      ) l ON TRUE
      LEFT JOIN public.profiles pr ON pr.user_id = p.user_id
      LEFT JOIN public.users u ON u.id = p.user_id
      WHERE p.id = $3 AND (${visSQL})
      LIMIT 1
      `,
      params
    );

    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json({ post: rows[0] });
  } catch (err) {
    console.error("[community] GET /posts/:id error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/community/posts                                                  */
/* -------------------------------------------------------------------------- */
router.post("/posts", requireAuth, upload.any(), async (req, res) => {
  try {
    const userId = req.user.id;

    const title = (req.body?.title || "").trim() || null;
    const raw = req.body?.content ?? req.body?.text ?? req.body?.body ?? "";
    const body = (raw || "").trim();

    const channel_id = req.body?.channel_id
      ? parseInt(req.body.channel_id, 10)
      : null;

    const file =
      (req.files || []).find((f) => f.fieldname === "media") ||
      (req.files || []).find((f) => f.fieldname === "file") ||
      null;

    let mediaUrl = null;
    if (file) {
      const rel = path.join("community", path.basename(file.path));
      mediaUrl = toPublicUrl(rel.replace(/\\/g, "/"));
    }

    // ✅ anyone creating a post can request to pin it
    const rawPinned = req.body?.is_pinned;
    const is_pinned =
      rawPinned === true ||
      rawPinned === "true" ||
      rawPinned === "1" ||
      rawPinned === 1;

    // visibility stays admin-only
    let visibility = "public";
    if (isAdmin(req.user)) {
      visibility = normalizeVisibility(req.body?.visibility);
    }

    if (!title && !body && !mediaUrl) {
      return res.status(400).json({ message: "Nothing to post" });
    }

    const ins = await db.query(
      `INSERT INTO public.community_posts
       (user_id, title, body, media_url, is_pinned, visibility, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, title, body, media_url, created_at, is_pinned, visibility, channel_id`,
      [userId, title, body || null, mediaUrl, is_pinned, visibility, channel_id]
    );

    const post = ins.rows[0];

    const { rows: arows } = await db.query(
      `SELECT ${AUTHOR_NAME_SQL} AS author_name
         FROM public.users u
         LEFT JOIN public.profiles pr ON pr.user_id = u.id
        WHERE u.id = $1`,
      [post.user_id]
    );
    post.author_name = arows[0]?.author_name || "Member";
    post.comments_count = 0;
    post.likes_count = 0;
    post.can_edit = true;
    post.can_delete = true;

    res.status(201).json({ post });
  } catch (err) {
    console.error("[community] POST /posts error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/community/posts/:id                                             */
/* -------------------------------------------------------------------------- */
router.patch("/posts/:id", requireAuth, upload.any(), async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ message: "Bad post id" });

    const cur = await db.query(
      `SELECT user_id FROM public.community_posts WHERE id = $1`,
      [postId]
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const owns = cur.rows[0].user_id === req.user.id;
    const admin = isAdmin(req.user);
    if (!admin && !owns) return res.status(403).json({ message: "Forbidden" });

    const titleRaw = req.body?.title;
    const title =
      typeof titleRaw !== "undefined" ? String(titleRaw).trim() || null : null;

    const bodyRaw = req.body?.content ?? req.body?.text ?? req.body?.body;
    const body =
      typeof bodyRaw !== "undefined" ? String(bodyRaw).trim() || null : null;

    let sets = [];
    let params = [];

    if (title !== null) {
      params.push(title);
      sets.push(`title = $${params.length}`);
    }
    if (body !== null) {
      params.push(body);
      sets.push(`body = $${params.length}`);
    }

    // ✅ allow owner OR admin to update is_pinned
    if (typeof req.body?.is_pinned !== "undefined") {
      if (admin || owns) {
        const rawPinned = req.body.is_pinned;
        const is_pinned =
          rawPinned === true ||
          rawPinned === "true" ||
          rawPinned === "1" ||
          rawPinned === 1;
        params.push(is_pinned);
        sets.push(`is_pinned = $${params.length}`);
      }
    }

    // admin-only updates
    if (admin) {
      if (typeof req.body?.visibility !== "undefined") {
        params.push(normalizeVisibility(req.body.visibility));
        sets.push(`visibility = $${params.length}`);
      }
      if (typeof req.body?.channel_id !== "undefined") {
        const channel_id = req.body.channel_id
          ? parseInt(req.body.channel_id, 10)
          : null;
        params.push(channel_id);
        sets.push(`channel_id = $${params.length}`);
      }
    }

    const file =
      (req.files || []).find((f) => f.fieldname === "media") ||
      (req.files || []).find((f) => f.fieldname === "file") ||
      null;
    if (file) {
      const rel = path.join("community", path.basename(file.path));
      const mediaUrl = toPublicUrl(rel.replace(/\\/g, "/"));
      params.push(mediaUrl);
      sets.push(`media_url = $${params.length}`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    params.push(postId);
    const q = `
      UPDATE public.community_posts
      SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING id, user_id, title, body, media_url, created_at, is_pinned, visibility, channel_id
    `;
    const up = await db.query(q, params);
    const post = up.rows[0];

    const { rows: arows } = await db.query(
      `SELECT ${AUTHOR_NAME_SQL} AS author_name
         FROM public.users u
         LEFT JOIN public.profiles pr ON pr.user_id = u.id
        WHERE u.id = $1`,
      [post.user_id]
    );
    post.author_name = arows[0]?.author_name || "Member";

    const [{ rows: cr }, { rows: lr }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM public.community_comments WHERE post_id = $1`,
        [post.id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM public.community_post_likes WHERE post_id = $1`,
        [post.id]
      ),
    ]);
    post.comments_count = cr[0].cnt || 0;
    post.likes_count = lr[0].cnt || 0;
    post.can_edit = true;
    post.can_delete = true;

    res.json({ post });
  } catch (err) {
    console.error("[community] PATCH /posts/:id error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/community/posts/:id                                            */
/* -------------------------------------------------------------------------- */
router.delete("/posts/:id", requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ message: "Bad post id" });

    const cur = await db.query(
      `SELECT user_id FROM public.community_posts WHERE id = $1`,
      [postId]
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const owns = cur.rows[0].user_id === req.user.id;
    if (!isAdmin(req.user) && !owns)
      return res.status(403).json({ message: "Forbidden" });

    await db.query(`DELETE FROM public.community_posts WHERE id = $1`, [
      postId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[community] DELETE /posts/:id error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* Like toggle                                                                */
/* -------------------------------------------------------------------------- */
router.post("/posts/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ message: "Bad post id" });

    const exists = await db.query(
      `SELECT 1 FROM public.community_post_likes
       WHERE post_id = $1 AND user_id = $2 LIMIT 1`,
      [postId, userId]
    );

    if (exists.rowCount) {
      await db.query(
        `DELETE FROM public.community_post_likes
         WHERE post_id = $1 AND user_id = $2`,
        [postId, userId]
      );
      return res.json({ liked: false });
    } else {
      await db.query(
        `INSERT INTO public.community_post_likes (post_id, user_id)
         VALUES ($1, $2)`,
        [postId, userId]
      );
      return res.json({ liked: true });
    }
  } catch (err) {
    console.error("[community] POST /posts/:id/like error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* Comments  (same as working version)                                        */
/* -------------------------------------------------------------------------- */
router.get("/posts/:id/comments", optionalAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ message: "Bad post id" });

    const { rows } = await db.query(
      `
       SELECT
         c.id,
         c.post_id,
         c.user_id,
         c.body,
         c.created_at,
         p.display_name AS profile_name,
         u.name AS user_name,
         u.email AS user_email
       FROM public.community_comments c
       LEFT JOIN public.profiles p ON p.user_id = c.user_id
       LEFT JOIN public.users u ON u.id = c.user_id
       WHERE c.post_id = $1
       ORDER BY c.created_at ASC
      `,
      [postId]
    );

    const items = rows.map((r) => ({
      id: r.id,
      post_id: r.post_id,
      user_id: r.user_id,
      body: r.body,
      created_at: r.created_at,
      author_name: buildCommentAuthorName(
        r.profile_name,
        r.user_name,
        r.user_email
      ),
    }));

    res.json({ items });
  } catch (err) {
    console.error("[community] GET comments error", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/posts/:id/comments", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.id, 10);

    const raw = req.body?.body ?? req.body?.text ?? req.body?.content ?? "";
    const body = (raw || "").trim();
    if (!postId || !body)
      return res.status(400).json({ message: "Bad request" });

    const ins = await db.query(
      `INSERT INTO public.community_comments (post_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, post_id, user_id, body, created_at`,
      [postId, userId, body]
    );

    const comment = ins.rows[0];

    const { rows } = await db.query(
      `
        SELECT
          p.display_name AS profile_name,
          u.name AS user_name,
          u.email AS user_email
        FROM public.users u
        LEFT JOIN public.profiles p ON p.user_id = u.id
        WHERE u.id = $1
      `,
      [userId]
    );

    const nameRow = rows[0] || {};
    comment.author_name = buildCommentAuthorName(
      nameRow.profile_name,
      nameRow.user_name,
      nameRow.user_email
    );

    res.status(201).json({ comment });
  } catch (err) {
    console.error("[community] POST comment error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */
router.get("/channels", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, is_public, sort_order
         FROM public.community_channels
        WHERE slug IN ('bishoprobertsontv','techsupport')
        ORDER BY sort_order, name`
    );
    res.json({ items: rows });
  } catch (e) {
    console.error("[community] GET /channels", e);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
