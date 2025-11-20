// server-api/routes/channels.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Built-in slugify (no dependency)
const slugify = (s = "") =>
  String(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80) || "page";

// Require user for owner endpoints (authBridge puts req.user)
function requireUser(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ ok: false, error: "auth_required" });
  }
  next();
}

/* ------------------------------- helpers ------------------------------- */

const isIntLike = (v) =>
  typeof v === "string" && /^\d+$/.test((v || "").trim());

async function getChannelByKey(client, keyRaw) {
  const key = String(keyRaw || "").trim();
  if (!key) return null;

  // case-insensitive slug
  {
    const { rows } = await client.query(
      `SELECT * FROM channels WHERE lower(slug) = lower($1) LIMIT 1`,
      [key]
    );
    if (rows[0]) return rows[0];
  }

  if (isIntLike(key)) {
    const { rows } = await client.query(
      `SELECT * FROM channels WHERE id = $1 LIMIT 1`,
      [Number(key)]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

// Convert whatever is stored into a V2 document shape
function normalizeBlocks(input) {
  // already V2?
  if (input && typeof input === "object" && input.version === 2) return input;

  // builder saves { blocks: [...] }
  const arr =
    (input && Array.isArray(input.blocks) && input.blocks) ||
    (Array.isArray(input) ? input : null);

  if (arr) return { version: 2, root: arr };
  return null; // nothing published/draft
}

function pagePublicFields(row) {
  return {
    id: row.id,
    channel_id: row.channel_id,
    slug: row.slug || row.page_slug,
    title: row.title,
    kind: row.kind,
    nav_order: row.nav_order,
    sort_order: row.sort_order,
    is_visible: row.is_visible,
    is_home: row.is_home,
    is_published: row.is_published,
  };
}

async function getChannelPages(client, channelId) {
  const q = `
    SELECT id, channel_id, slug, page_slug, title, kind,
           nav_order, sort_order, is_visible, is_home, is_published,
           blocks,
           content_draft,
           content_published,
           meta,
           published_html,
           created_at, updated_at, published_at
      FROM channel_pages
     WHERE channel_id = $1
  ORDER BY COALESCE(nav_order, sort_order, 0), id
  `;
  const { rows } = await client.query(q, [channelId]);
  return rows;
}

/* ----------------------------- PUBLIC API ------------------------------ */

/**
 * Aggregated: /api/channels/p/:key
 * { ok, channel, pages: [{...minimal, blocks: {version:2, root:[...]}}] }
 */
router.get("/p/:key", async (req, res) => {
  const client = await pool.connect();
  try {
    const ch = await getChannelByKey(client, req.params.key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });

    const rows = await getChannelPages(client, ch.id);

    const pages = rows.map((r) => {
      // Prefer published; fall back to legacy/draft
      const doc =
        normalizeBlocks(r.content_published) ||
        normalizeBlocks(r.blocks) ||
        normalizeBlocks(r.content_draft) ||
        null;

      return { ...pagePublicFields(r), blocks: doc };
    });

    res.json({ ok: true, channel: ch, pages });
  } catch (e) {
    console.error("[channels] GET /p/:key error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

/**
 * Public: /api/channels/public/:key
 * { ok, channel }
 */
router.get("/public/:key", async (req, res) => {
  const client = await pool.connect();
  try {
    const ch = await getChannelByKey(client, req.params.key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, channel: ch });
  } catch (e) {
    console.error("[channels] GET /public/:key error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

/**
 * Public list: /api/channels/public/:key/pages
 * { ok, pages: [...] }  (no blocks here to keep it light)
 */
router.get("/public/:key/pages", async (req, res) => {
  const client = await pool.connect();
  try {
    const ch = await getChannelByKey(client, req.params.key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });

    const rows = await getChannelPages(client, ch.id);
    res.json({ ok: true, pages: rows.map(pagePublicFields) });
  } catch (e) {
    console.error("[channels] GET /public/:key/pages error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

/**
 * Public page detail:
 * /api/channels/public/:key/pages/:pageSlug
 * { ok, page: {...minimal, blocks: {version:2, root:[...]}} }
 */
router.get("/public/:key/pages/:pageSlug", async (req, res) => {
  const client = await pool.connect();
  try {
    const { key, pageSlug } = req.params;
    const ch = await getChannelByKey(client, key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });

    const { rows } = await client.query(
      `SELECT *
         FROM channel_pages
        WHERE channel_id = $1
          AND (lower(slug) = lower($2) OR lower(page_slug) = lower($2))
        LIMIT 1`,
      [ch.id, pageSlug]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "not_found" });

    const doc =
      normalizeBlocks(r.content_published) ||
      normalizeBlocks(r.blocks) ||
      normalizeBlocks(r.content_draft) ||
      null;

    res.json({
      ok: true,
      page: {
        ...pagePublicFields(r),
        blocks: doc,
        published_html: r.published_html || null,
      },
    });
  } catch (e) {
    console.error("[channels] GET /public/:key/pages/:pageSlug error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

/* ------------------------------- OWNER (ME) ------------------------------ */

// Minimal owner channels (used by Studio)
router.get("/me", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, slug, title, about, theme_color, text_color,
              hero_url, avatar_url, created_at, updated_at
         FROM channels
        WHERE owner_user_id = $1
        ORDER BY id`,
      [req.user.id]
    );
    res.json({ ok: true, channels: rows });
  } catch (e) {
    console.error("[channels] GET /me error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: list pages
router.get("/me/pages", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const q = `
      SELECT p.id, p.channel_id, p.slug, p.page_slug, p.title, p.kind,
             p.nav_order, p.sort_order, p.is_visible, p.is_home,
             p.is_published, p.updated_at, p.created_at
        FROM channel_pages p
        JOIN channels c ON c.id = p.channel_id
       WHERE c.owner_user_id = $1
    ORDER BY c.id, COALESCE(p.nav_order, p.sort_order, 0), p.id
    `;
    const { rows } = await client.query(q, [req.user.id]);
    res.json({ ok: true, pages: rows });
  } catch (e) {
    console.error("[channels] GET /me/pages error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: get one page (for editor)
router.get("/me/pages/:id", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT p.*, c.owner_user_id
         FROM channel_pages p
         JOIN channels c ON c.id = p.channel_id
        WHERE p.id = $1 AND c.owner_user_id = $2
        LIMIT 1`,
      [Number(req.params.id), req.user.id]
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({
      ok: true,
      id: p.id,
      channel_id: p.channel_id,
      slug: p.slug || p.page_slug,
      title: p.title,
      kind: p.kind,
      draft_json:
        p.content_draft ?? (p.blocks ? { blocks: p.blocks } : { blocks: [] }),
      meta: p.meta || {},
    });
  } catch (e) {
    console.error("[channels] GET /me/pages/:id error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: create a page
router.post("/me/pages", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { channel_id, title } = req.body || {};
    const reqSlug = req.body.slug
      ? String(req.body.slug)
      : slugify(title || "");
    await client.query("BEGIN");

    // find or create a channel for the owner if channel_id not supplied
    let chId = Number(channel_id) || null;
    if (!chId) {
      const { rows } = await client.query(
        `SELECT id FROM channels WHERE owner_user_id = $1 ORDER BY id LIMIT 1`,
        [req.user.id]
      );
      if (rows[0]) chId = rows[0].id;
      else {
        const ins = await client.query(
          `INSERT INTO channels (owner_user_id, slug, title)
           VALUES ($1,$2,$3)
           RETURNING id`,
          [req.user.id, slugify("my-channel"), "My Channel"]
        );
        chId = ins.rows[0].id;
      }
    }

    const ins = await client.query(
      `INSERT INTO channel_pages
         (channel_id, slug, page_slug, title, kind,
          blocks, content_draft, nav_order, is_visible, is_published,
          created_at, updated_at)
       VALUES
         ($1, $2, $2, $3, 'custom',
          $4::jsonb, $5::jsonb, 0, TRUE, FALSE,
          NOW(), NOW())
       RETURNING *`,
      [
        chId,
        reqSlug || "page",
        title || "Untitled",
        JSON.stringify([]),
        JSON.stringify({ blocks: [] }),
      ]
    );

    await client.query("COMMIT");
    const p = ins.rows[0];
    res.json({
      ok: true,
      page: {
        id: p.id,
        title: p.title,
        slug: p.slug || p.page_slug,
        is_home: p.is_home,
        sort_order: p.sort_order,
        is_published: p.is_published,
        content_draft: p.content_draft,
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[channels] POST /me/pages error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: save page meta/draft (also handles title/slug/is_home/sort_order)
router.put("/me/pages/:id", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const {
      title,
      slug,
      is_home,
      sort_order,
      content_draft, // expects {blocks:[...]} from the builder (or omit)
      meta, // may contain builder_html
    } = req.body || {};

    await client.query("BEGIN");

    // Make sure they own it
    const own = await client.query(
      `SELECT p.id
         FROM channel_pages p
         JOIN channels c ON c.id = p.channel_id
        WHERE p.id = $1 AND c.owner_user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    // if is_home true, unset others in the same channel
    if (is_home === true) {
      await client.query(
        `UPDATE channel_pages
            SET is_home = FALSE
          WHERE channel_id = (SELECT channel_id FROM channel_pages WHERE id = $1)`,
        [id]
      );
    }

    const upd = await client.query(
      `UPDATE channel_pages
          SET title = COALESCE($2, title),
              slug = COALESCE($3, slug),
              page_slug = COALESCE($3, page_slug),
              is_home = COALESCE($4, is_home),
              sort_order = COALESCE($5, sort_order),
              content_draft = COALESCE($6::jsonb, content_draft),
              meta = COALESCE($7::jsonb, meta),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        title ?? null,
        slug ?? null,
        typeof is_home === "boolean" ? is_home : null,
        typeof sort_order === "number" ? sort_order : null,
        content_draft ? JSON.stringify(content_draft) : null,
        meta ? JSON.stringify(meta) : null,
      ]
    );

    await client.query("COMMIT");
    const r = upd.rows[0];
    res.json({
      ok: true,
      page: {
        id: r.id,
        title: r.title,
        slug: r.slug || r.page_slug,
        is_home: r.is_home,
        sort_order: r.sort_order,
        is_published: r.is_published,
        content_draft: r.content_draft,
      },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[channels] PUT /me/pages/:id error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: publish (copy draft -> published)
router.post("/me/pages/:id/publish", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);

    await client.query("BEGIN");

    const row = await client.query(
      `SELECT p.*, c.owner_user_id
         FROM channel_pages p
         JOIN channels c ON c.id = p.channel_id
        WHERE p.id = $1 AND c.owner_user_id = $2
        LIMIT 1`,
      [id, req.user.id]
    );
    const p = row.rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const draft = p.content_draft || { blocks: [] };
    const html =
      (p.meta && p.meta.builder_html ? String(p.meta.builder_html) : "") || "";

    await client.query(
      `UPDATE channel_pages
          SET content_published = $2::jsonb,
              published_html = $3::text,
              is_published = TRUE,
              published_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(draft), html]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[channels] POST /me/pages/:id/publish error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// Owner: delete page
router.delete("/me/pages/:id", requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid page id" });
    }

    // Ensure ownership & get is_home
    const { rows } = await client.query(
      `SELECT p.id, p.is_home
         FROM channel_pages p
         JOIN channels c ON c.id = p.channel_id
        WHERE p.id = $1 AND c.owner_user_id = $2
        LIMIT 1`,
      [id, req.user.id]
    );
    const row = rows[0];
    if (!row)
      return res.status(404).json({ ok: false, message: "Page not found" });
    if (row.is_home)
      return res.status(409).json({
        ok: false,
        message: "Cannot delete the Home page. Unset it first.",
      });

    const del = await client.query(
      `DELETE FROM channel_pages WHERE id = $1 RETURNING id`,
      [id]
    );
    return res.json({ ok: true, deleted: del.rows[0].id });
  } catch (e) {
    console.error("[channels] DELETE /me/pages/:id error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  } finally {
    client.release();
  }
});

/* -------------------------- PRIVATE (fallback) API ------------------------- */

router.get("/:key", async (req, res) => {
  const client = await pool.connect();
  try {
    const ch = await getChannelByKey(client, req.params.key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, channel: ch });
  } catch (e) {
    console.error("[channels] GET /:key error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

router.get("/:key/pages", async (req, res) => {
  const client = await pool.connect();
  try {
    const ch = await getChannelByKey(client, req.params.key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });
    const rows = await getChannelPages(client, ch.id);
    res.json({ ok: true, pages: rows.map(pagePublicFields) });
  } catch (e) {
    console.error("[channels] GET /:key/pages error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

router.get("/:key/pages/:pageSlug", async (req, res) => {
  const client = await pool.connect();
  try {
    const { key, pageSlug } = req.params;
    const ch = await getChannelByKey(client, key);
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });

    const { rows } = await client.query(
      `SELECT *
         FROM channel_pages
        WHERE channel_id = $1
          AND (lower(slug) = lower($2) OR lower(page_slug) = lower($2))
        LIMIT 1`,
      [ch.id, pageSlug]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "not_found" });

    const doc =
      normalizeBlocks(r.content_published) ||
      normalizeBlocks(r.blocks) ||
      normalizeBlocks(r.content_draft) ||
      null;

    res.json({
      ok: true,
      page: {
        ...pagePublicFields(r),
        blocks: doc,
        published_html: r.published_html || null,
      },
    });
  } catch (e) {
    console.error("[channels] GET /:key/pages/:pageSlug error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// GET /api/channels/p/:slug/pages/:pageKey  -> full page (by slug or id)
router.get("/p/:key/pages/:pageKey", async (req, res) => {
  const client = await pool.connect();
  try {
    const channelKey = req.params.key; // slug or id for the channel
    const pageKey = req.params.pageKey; // page slug or numeric id

    // Find channel first
    const chRes = await client.query(
      `SELECT id, slug, title FROM channels WHERE lower(slug)=lower($1) OR id::text=$1 LIMIT 1`,
      [String(channelKey)]
    );
    const ch = chRes.rows[0];
    if (!ch) return res.status(404).json({ ok: false, error: "not_found" });

    // Then find page by slug or id, scoped to this channel
    let pageRes;
    if (/^\d+$/.test(String(pageKey))) {
      pageRes = await client.query(
        `SELECT *
           FROM channel_pages
          WHERE channel_id=$1 AND id=$2
          LIMIT 1`,
        [ch.id, Number(pageKey)]
      );
    } else {
      pageRes = await client.query(
        `SELECT *
           FROM channel_pages
          WHERE channel_id=$1 AND (lower(slug)=lower($2) OR lower(page_slug)=lower($2))
          LIMIT 1`,
        [ch.id, String(pageKey)]
      );
    }

    const page = pageRes.rows[0];
    if (!page) return res.status(404).json({ ok: false, error: "not_found" });

    // Return the page with published fields (published_html/content_published)
    return res.json({ ok: true, page });
  } catch (e) {
    console.error("[channels] GET /p/:key/pages/:pageKey error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// GET /api/site/public/:slug  -> { ok, page: { id, title, slug, blocks, published_html } }
router.get("/site/public/:slug", async (req, res) => {
  const client = await pool.connect();
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "bad_request" });

    // Pick the most recently published page that matches the slug (case-insensitive)
    const { rows } = await client.query(
      `
      SELECT p.*, c.slug AS channel_slug
        FROM channel_pages p
        JOIN channels c ON c.id = p.channel_id
       WHERE p.is_published = TRUE
         AND (lower(p.slug) = lower($1) OR lower(p.page_slug) = lower($1))
       ORDER BY p.published_at DESC NULLS LAST, p.updated_at DESC
       LIMIT 1
      `,
      [slug]
    );

    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "not_found" });

    // Prefer published JSON; fall back defensively if needed
    const blocks =
      (r.content_published &&
        (r.content_published.version === 2
          ? r.content_published.root
          : Array.isArray(r.content_published.blocks)
          ? r.content_published.blocks
          : Array.isArray(r.content_published)
          ? r.content_published
          : [])) ||
      [];

    return res.json({
      ok: true,
      page: {
        id: r.id,
        title: r.title,
        slug: r.slug || r.page_slug,
        channel_slug: r.channel_slug,
        blocks,
        published_html: r.published_html || null,
        published_at: r.published_at,
      },
    });
  } catch (e) {
    console.error("[channels] GET /site/public/:slug error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

module.exports = router;
