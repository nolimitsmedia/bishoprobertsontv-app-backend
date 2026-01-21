// server-api/routes/playlists.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

/* -------------------- helpers -------------------- */
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

function isAdmin(user) {
  const r = (user?.role || user?.type || "").toLowerCase();
  return r === "admin" || r === "owner";
}

async function ensureFavorites(userId) {
  const q = await db.query(
    `SELECT * FROM playlists
      WHERE created_by = $1 AND LOWER(title) = 'favorites'
      ORDER BY id ASC
      LIMIT 1`,
    [userId],
  );
  if (q.rowCount) return q.rows[0];

  const { rows } = await db.query(
    `INSERT INTO playlists (title, slug, visibility, created_by, description)
     VALUES ($1, $2, 'private', $3, $4)
     RETURNING *`,
    ["Favorites", slugify("Favorites"), userId, "Your saved videos"],
  );
  return rows[0];
}

function shortRand() {
  return Math.random().toString(36).slice(2, 6);
}

function isDigits(x) {
  return typeof x === "string" && /^\d+$/.test(x);
}

/* =====================================================================
   PUBLIC RULES (Option A):
   - Public endpoints MUST NEVER return unpublished/unlisted playlists.
   - We treat "published playlist" as: playlists.visibility = 'public'
   - Unlisted is fully unreachable publicly (even by direct link).
   - Playlist item counts are based on PUBLIC videos only:
       v.is_published = TRUE AND v.visibility <> 'unlisted'
===================================================================== */

const PUBLIC_VIDEO_WHERE = `
  v.is_published = TRUE
  AND COALESCE(v.visibility, 'public') <> 'unlisted'
`;

const PUBLIC_PLAYLIST_WHERE = `
  p.visibility = 'public'
`;

/* =========================================================
   PUBLIC LIST
   GET /api/playlists/public
   - Returns ONLY published playlists (visibility='public')
   - Counts ONLY published videos
   - nonempty defaults to true (hide playlists with 0 published videos)
========================================================= */
router.get("/public", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 24, 200));
    const nonempty = req.query.nonempty === "0" ? false : true;
    const search = (req.query.search || "").trim();

    const params = [];
    let p = 1;

    let where = `WHERE ${PUBLIC_PLAYLIST_WHERE}`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.title ILIKE $${p} OR p.description ILIKE $${p})`;
      p++;
    }

    const sql = `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        cat.name AS featured_category_name,
        cat.slug AS featured_category_slug,
        p.created_at,
        COUNT(v.id)::int AS item_count,
        COUNT(v.id)::int AS video_count
      FROM playlists p
      LEFT JOIN categories cat ON cat.id = p.featured_category_id
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      LEFT JOIN videos v
        ON v.id = pv.video_id
       AND ${PUBLIC_VIDEO_WHERE}
      ${where}
      GROUP BY p.id, cat.name, cat.slug
      ${nonempty ? "HAVING COUNT(v.id) > 0" : ""}
      ORDER BY p.created_at DESC
      LIMIT $${p}
    `;

    params.push(limit);

    const { rows } = await db.query(sql, params);
    res.json({ items: rows });
  } catch (e) {
    console.error("[GET /playlists/public] error:", e);
    res.status(500).json({ message: "Failed to fetch playlists" });
  }
});

/* =========================================================
   PUBLIC DETAIL
   GET /api/playlists/public/:idOrSlug
   - 404 if not published (must be visibility='public')
   - 404 if it has 0 published videos (keeps public clean)
========================================================= */
router.get("/public/:idOrSlug", async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId = isDigits(idOrSlug);

    const p = await db.query(
      `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        cat.name AS featured_category_name,
        cat.slug AS featured_category_slug,
        p.created_at,
        (
          SELECT COUNT(*)::int
          FROM playlist_videos pv2
          JOIN videos v2 ON v2.id = pv2.video_id
          WHERE pv2.playlist_id = p.id
            AND ${PUBLIC_VIDEO_WHERE.replace(/v\./g, "v2.")}
        ) AS video_count
      FROM playlists p
      LEFT JOIN categories cat ON cat.id = p.featured_category_id
      WHERE ${isId ? "p.id = $1" : "p.slug = $1"}
        AND ${PUBLIC_PLAYLIST_WHERE}
      LIMIT 1
      `,
      [idOrSlug],
    );

    if (!p.rowCount) return res.status(404).json({ message: "Not found" });

    const playlist = p.rows[0];

    // Keep direct links clean too (no empty "published" playlists)
    if (!(Number(playlist.video_count || 0) > 0)) {
      return res.status(404).json({ message: "Not found" });
    }

    const vids = await db.query(
      `
      SELECT v.*, c.name AS category_name
      FROM playlist_videos pv
      JOIN videos v ON v.id = pv.video_id
      LEFT JOIN categories c ON c.id = v.category_id
      WHERE pv.playlist_id = $1
        AND ${PUBLIC_VIDEO_WHERE}
      ORDER BY pv.sort_index ASC NULLS LAST, pv.added_at ASC NULLS LAST
      `,
      [playlist.id],
    );

    res.json({ ...playlist, videos: vids.rows });
  } catch (e) {
    console.error("[GET /playlists/public/:idOrSlug] error:", e);
    res.status(500).json({ message: "Failed to fetch playlist" });
  }
});

/* =========================================================
   AUTHENTICATED: FAVORITES CREATE
========================================================= */
router.post("/favorites/ensure", authenticate, async (req, res) => {
  try {
    const fav = await ensureFavorites(req.user.id);
    res.json(fav);
  } catch (e) {
    console.error("[POST /playlists/favorites/ensure] error:", e);
    res.status(500).json({ message: "Failed to ensure favorites" });
  }
});

/* =========================================================
   CREATE (must be BEFORE param routes)
========================================================= */
async function createPlaylist(req, res) {
  try {
    const {
      title,
      description,
      thumbnail_url,
      visibility = "private",
      slug,
      featured_category_id,
    } = req.body;

    if (!title) return res.status(400).json({ message: "title is required" });

    const finalSlug = slug || slugify(title);
    const { rows } = await db.query(
      `
      INSERT INTO playlists (title, slug, description, thumbnail_url, visibility, featured_category_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        title,
        finalSlug,
        description || null,
        thumbnail_url || null,
        visibility,
        featured_category_id ?? null,
        req.user?.id || null,
      ],
    );

    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /playlists(create)] error:", e);
    res.status(500).json({ message: "Failed to create playlist" });
  }
}

router.post("/create", authenticate, createPlaylist);
router.post("/", authenticate, createPlaylist);

/* =========================================================
   SPECIAL ROUTES MUST COME BEFORE /:idOrSlug (AUTH)
========================================================= */

// GET /api/playlists/me
router.get("/me", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const sql = `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        p.created_at,
        COUNT(pv.video_id)::int AS item_count,
        COUNT(pv.video_id)::int AS video_count
      FROM playlists p
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      WHERE p.created_by = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 200
    `;

    const { rows } = await db.query(sql, [userId]);
    res.json({ items: rows });
  } catch (e) {
    console.error("[GET /playlists/me] error:", e);
    res.status(500).json({ message: "Failed to fetch playlists" });
  }
});

// GET /api/playlists/my (alias)
router.get("/my", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const sql = `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        p.created_at,
        COUNT(pv.video_id)::int AS item_count,
        COUNT(pv.video_id)::int AS video_count
      FROM playlists p
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      WHERE p.created_by = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 200
    `;

    const { rows } = await db.query(sql, [userId]);
    res.json({ items: rows });
  } catch (e) {
    console.error("[GET /playlists/my] error:", e);
    res.status(500).json({ message: "Failed to fetch playlists" });
  }
});

// GET /api/playlists/by-video/:videoId (scoped to current user)
router.get("/by-video/:videoId", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.params;

    const vId = Number(videoId);
    if (!Number.isFinite(vId)) {
      return res.status(400).json({ message: "Invalid videoId" });
    }

    const r = await db.query(
      `
      SELECT pv.playlist_id AS id
      FROM playlist_videos pv
      JOIN playlists p ON p.id = pv.playlist_id
      WHERE p.created_by = $1
        AND pv.video_id = $2
      `,
      [userId, vId],
    );

    res.json({
      ok: true,
      video_id: vId,
      playlist_ids: r.rows.map((x) => String(x.id)),
    });
  } catch (e) {
    console.error("[GET /playlists/by-video/:videoId] error:", e);
    res.status(500).json({ message: "Failed to load video membership" });
  }
});

/* =========================================================
   VIDEO MEMBERSHIP HELPERS (back-compat)
   NOTE: These return ALL playlists containing a video (not scoped).
   IMPORTANT: Must be BEFORE /:idOrSlug
========================================================= */
router.get("/for-video/:videoId", authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const r = await db.query(
      `SELECT pv.playlist_id AS id
       FROM playlist_videos pv
       JOIN playlists p ON p.id = pv.playlist_id
       WHERE pv.video_id = $1`,
      [videoId],
    );
    res.json({ items: r.rows.map((x) => x.id) });
  } catch (e) {
    console.error("[GET /playlists/for-video/:videoId] error:", e);
    res.status(500).json({ message: "Failed to load video membership" });
  }
});

router.get("/videos/:videoId", authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const r = await db.query(
      `SELECT pv.playlist_id AS id
       FROM playlist_videos pv
       JOIN playlists p ON p.id = pv.playlist_id
       WHERE pv.video_id = $1`,
      [videoId],
    );
    res.json({ playlist_ids: r.rows.map((x) => String(x.id)) });
  } catch (e) {
    console.error("[GET /playlists/videos/:videoId] error:", e);
    res.status(500).json({ message: "Failed to fetch video playlists" });
  }
});

/* =========================================================
   LIST (admin all or scoped)
========================================================= */
router.get("/", authenticate, async (req, res) => {
  try {
    const params = [];
    let sqlWhere = "";
    let adminScopeAll = false;

    if (isAdmin(req.user)) {
      adminScopeAll = String(req.query.scope || "").toLowerCase() === "all";
      if (!adminScopeAll) {
        sqlWhere = `
          WHERE (
            p.created_by IS NULL
            OR EXISTS (
              SELECT 1 FROM users u
              WHERE u.id = p.created_by
                AND LOWER(COALESCE(u.role, '')) IN ('admin','owner')
            )
          )`;
      }
    } else {
      sqlWhere = "WHERE p.created_by = $1";
      params.push(req.user.id);
    }

    const sql = `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        p.created_at,
        COUNT(pv.video_id)::int AS item_count,
        COUNT(pv.video_id)::int AS video_count
      FROM playlists p
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      ${sqlWhere}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 200
    `;

    const { rows } = await db.query(sql, params);
    res.json({ playlists: rows, items: rows });
  } catch (e) {
    console.error("[GET /playlists] error:", e);
    res.status(500).json({ message: "Failed to fetch playlists" });
  }
});

/* =========================================================
   DETAIL (AUTH) — MUST BE AFTER special routes
========================================================= */
router.get("/:idOrSlug", authenticate, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId = isDigits(idOrSlug);

    const cur = await db.query(
      `SELECT * FROM playlists WHERE ${isId ? "id = $1" : "slug = $1"} LIMIT 1`,
      [idOrSlug],
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const playlist = cur.rows[0];

    if (
      !isAdmin(req.user) &&
      String(playlist.created_by) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const vids = await db.query(
      `
      SELECT v.*, c.name AS category_name
      FROM playlist_videos pv
      JOIN videos v ON v.id = pv.video_id
      LEFT JOIN categories c ON c.id = v.category_id
      WHERE pv.playlist_id = $1
      ORDER BY pv.sort_index ASC NULLS LAST, pv.added_at ASC NULLS LAST
      `,
      [playlist.id],
    );

    playlist.video_count = vids.rowCount || 0;

    res.json({ ...playlist, videos: vids.rows });
  } catch (e) {
    console.error("[GET /playlists/:idOrSlug] error:", e);
    res.status(500).json({ message: "Failed to fetch playlist" });
  }
});

/* =========================================================
   UPDATE
========================================================= */
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const cur = await db.query("SELECT * FROM playlists WHERE id = $1", [id]);
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const row = cur.rows[0];

    if (!isAdmin(req.user) && String(row.created_by) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const fields = [];
    const params = [id];

    function push(col, val, transform = (v) => v) {
      fields.push(`${col} = $${params.length + 1}`);
      params.push(transform(val));
    }

    if ("title" in req.body && req.body.title != null)
      push("title", req.body.title);

    if ("slug" in req.body) {
      const finalSlug =
        req.body.slug ??
        row.slug ??
        slugify(req.body.title || row.title || "playlist");
      push("slug", finalSlug);
    }

    if ("description" in req.body)
      push("description", req.body.description ?? null);

    if ("thumbnail_url" in req.body)
      push("thumbnail_url", req.body.thumbnail_url ?? null);

    if ("visibility" in req.body)
      push("visibility", req.body.visibility ?? "public");

    if ("featured_category_id" in req.body) {
      push("featured_category_id", req.body.featured_category_id ?? null);
    }

    fields.push(`updated_at = NOW()`);

    if (fields.length === 1) return res.json(row);

    const sql = `
      UPDATE playlists
      SET ${fields.join(", ")}
      WHERE id = $1
      RETURNING *
    `;

    const r = await db.query(sql, params);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PUT /playlists/:id] error:", e);
    res.status(500).json({ message: "Failed to update playlist" });
  }
});

/* =========================================================
   DELETE
========================================================= */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const cur = await db.query(
      "SELECT created_by FROM playlists WHERE id = $1",
      [id],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Not found" });

    if (
      !isAdmin(req.user) &&
      String(cur.rows[0].created_by) !== String(req.user?.id)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await db.query("DELETE FROM playlist_videos WHERE playlist_id = $1", [id]);
    await db.query("DELETE FROM playlists WHERE id = $1", [id]);

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /playlists/:id] error:", e);
    res.status(500).json({ message: "Failed to delete playlist" });
  }
});

/* =========================================================
   MEMBERSHIP
========================================================= */
router.post("/:id/videos", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { video_id } = req.body;
    if (!video_id)
      return res.status(400).json({ message: "video_id required" });

    const cur = await db.query(
      "SELECT created_by FROM playlists WHERE id = $1",
      [id],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Not found" });

    if (
      !isAdmin(req.user) &&
      String(cur.rows[0].created_by) !== String(req.user?.id)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const max = await db.query(
      "SELECT COALESCE(MAX(sort_index), -1) AS m FROM playlist_videos WHERE playlist_id = $1",
      [id],
    );

    const next = (max.rows[0]?.m ?? -1) + 1;

    await db.query(
      `INSERT INTO playlist_videos (playlist_id, video_id, sort_index, added_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (playlist_id, video_id) DO NOTHING`,
      [id, video_id, next],
    );

    res.json({ ok: true, sort_index: next });
  } catch (e) {
    console.error("[POST /playlists/:id/videos] error:", e);
    res.status(500).json({ message: "Failed to add video" });
  }
});

router.delete("/:id/videos/:videoId", authenticate, async (req, res) => {
  try {
    const { id, videoId } = req.params;

    const cur = await db.query(
      "SELECT created_by FROM playlists WHERE id = $1",
      [id],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Not found" });

    if (
      !isAdmin(req.user) &&
      String(cur.rows[0].created_by) !== String(req.user?.id)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await db.query(
      "DELETE FROM playlist_videos WHERE playlist_id = $1 AND video_id = $2",
      [id, videoId],
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /playlists/:id/videos/:videoId] error:", e);
    res.status(500).json({ message: "Failed to remove video" });
  }
});

/* =========================================================
   SHARE / UNSHARE / CASCADE
   NOTE: Your public endpoints now require visibility='public' ONLY.
   So "share" still sets public, but "unlisted" should not be used
   for anything public-facing anymore.
========================================================= */

router.post("/:id/share", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const cur = await db.query(
      "SELECT * FROM playlists WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const row = cur.rows[0];

    if (!isAdmin(req.user) && String(row.created_by) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const base = slugify(row.title || "playlist") || "playlist";
    const minted = `${base}-${shortRand()}`;

    const { rows } = await db.query(
      `UPDATE playlists
         SET slug=$1, visibility='public', updated_at=NOW()
       WHERE id=$2
       RETURNING *`,
      [minted, id],
    );

    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /playlists/:id/share] error:", e);
    res.status(500).json({ message: "Failed to share playlist" });
  }
});

router.post("/:id/unshare", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const cur = await db.query(
      "SELECT * FROM playlists WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Not found" });

    const row = cur.rows[0];

    if (!isAdmin(req.user) && String(row.created_by) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { rows } = await db.query(
      `UPDATE playlists
         SET slug=NULL, visibility='private', updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [id],
    );

    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /playlists/:id/unshare] error:", e);
    res.status(500).json({ message: "Failed to unshare playlist" });
  }
});

// cascade publish videos
router.post("/:id/share-cascade", authenticate, async (req, res) => {
  const VIDEO_VISIBILITY = "public";
  const client = await db.connect();

  try {
    const { id } = req.params;

    const cur = await client.query(
      "SELECT * FROM playlists WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!cur.rowCount) {
      client.release();
      return res.status(404).json({ message: "Not found" });
    }

    const row = cur.rows[0];

    if (!isAdmin(req.user) && String(row.created_by) !== String(req.user.id)) {
      client.release();
      return res.status(403).json({ message: "Forbidden" });
    }

    await client.query("BEGIN");

    const slugBase = slugify(row.title || "playlist") || "playlist";
    const minted =
      row.slug && row.slug.trim() ? row.slug : `${slugBase}-${shortRand()}`;

    const pRes = await client.query(
      `UPDATE playlists
         SET slug=$1, visibility='public', updated_at=NOW()
       WHERE id=$2
       RETURNING *`,
      [minted, id],
    );

    const updatedPlaylist = pRes.rows[0];

    const vids = await client.query(
      `SELECT pv.video_id FROM playlist_videos pv WHERE pv.playlist_id = $1`,
      [id],
    );

    const videoIds = vids.rows.map((r) => r.video_id);

    if (videoIds.length > 0) {
      await client.query(
        `UPDATE videos
            SET is_published = TRUE,
                published_at = COALESCE(published_at, NOW()),
                visibility = $1
          WHERE id = ANY($2::int[])`,
        [VIDEO_VISIBILITY, videoIds],
      );
    }

    await client.query("COMMIT");
    res.json(updatedPlaylist);
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[POST /playlists/:id/share-cascade] error:", e);
    res.status(500).json({
      message: "Failed to share playlist and publish videos",
    });
  } finally {
    try {
      client.release();
    } catch {}
  }
});

/* =========================================================
   REORDER VIDEOS IN A PLAYLIST
   PUT /api/playlists/:id/reorder
========================================================= */
router.put("/:id/reorder", authenticate, async (req, res) => {
  const playlistId = req.params.id;
  const videoIds = req.body.video_ids;

  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    return res
      .status(400)
      .json({ message: "video_ids array is required for reorder" });
  }

  try {
    const cur = await db.query(
      "SELECT created_by FROM playlists WHERE id = $1",
      [playlistId],
    );

    if (!cur.rowCount) {
      return res.status(404).json({ message: "Playlist not found" });
    }

    const createdBy = cur.rows[0].created_by;
    if (!isAdmin(req.user) && String(createdBy) !== String(req.user?.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await db.query("BEGIN");

    for (let index = 0; index < videoIds.length; index++) {
      const videoId = videoIds[index];

      await db.query(
        `
        UPDATE playlist_videos
           SET sort_index = $1
         WHERE playlist_id = $2
           AND video_id = $3
        `,
        [index, playlistId, videoId],
      );
    }

    await db.query("COMMIT");

    return res.json({
      ok: true,
      playlist_id: Number(playlistId),
      video_ids: videoIds,
    });
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch {}

    console.error("[PUT /playlists/:id/reorder] error:", e);
    return res.status(500).json({ message: "Failed to reorder playlist" });
  }
});

module.exports = router;
