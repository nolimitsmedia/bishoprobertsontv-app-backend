// server-api/routes/adminPages.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAdmin = require("../middleware/authenticateAdmin");

function safeSlug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

router.use(authenticateAdmin);

/**
 * IMPORTANT:
 * Postgres will throw if you reference a column that doesn't exist,
 * even inside COALESCE().
 *
 * So we detect actual columns in the "pages" table at runtime and build queries
 * that only reference columns that exist.
 */

let schemaCache = null;
let schemaCacheAt = 0;

async function getPagesSchema() {
  const now = Date.now();
  if (schemaCache && now - schemaCacheAt < 30_000) return schemaCache; // 30s cache

  const { rows } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pages'
    `,
  );

  const cols = new Set(rows.map((r) => r.column_name));

  // Decide which columns to use
  const has = (c) => cols.has(c);

  const publishedCol = has("published_at")
    ? "published_at"
    : has("published")
      ? "published"
      : null;

  const htmlCol = has("content_html")
    ? "content_html"
    : has("published_html")
      ? "published_html"
      : null;

  const statusCol = has("status") ? "status" : null;
  const heroCol = has("hero_image_url") ? "hero_image_url" : null;
  const excerptCol = has("excerpt") ? "excerpt" : null;
  const jsonCol = has("content_json") ? "content_json" : null;

  const updatedAtCol = has("updated_at") ? "updated_at" : null;
  const createdAtCol = has("created_at") ? "created_at" : null;

  schemaCache = {
    cols,
    publishedCol,
    htmlCol,
    statusCol,
    heroCol,
    excerptCol,
    jsonCol,
    updatedAtCol,
    createdAtCol,
  };
  schemaCacheAt = now;
  return schemaCache;
}

function nowSql() {
  return "NOW()";
}

function defaultStatusExpr(schema) {
  // If status column doesn't exist, we'll treat everything as "draft" in API
  return schema.statusCol ? schema.statusCol : `'draft'`;
}

function publishedSelectExpr(schema) {
  // Provide a consistent alias for frontend: published_at
  return schema.publishedCol
    ? `${schema.publishedCol} AS published_at`
    : `NULL AS published_at`;
}

function htmlSelectExpr(schema) {
  // Provide consistent alias for frontend: content_html
  return schema.htmlCol
    ? `${schema.htmlCol} AS content_html`
    : `'' AS content_html`;
}

function updatedAtSelectExpr(schema) {
  return schema.updatedAtCol
    ? schema.updatedAtCol
    : `${nowSql()} AS updated_at`;
}

function createdAtSelectExpr(schema) {
  return schema.createdAtCol ? schema.createdAtCol : `NULL AS created_at`;
}

// List pages
router.get("/", async (req, res) => {
  try {
    const s = await getPagesSchema();

    const sql = `
      SELECT
        id,
        title,
        slug,
        ${defaultStatusExpr(s)} AS status,
        ${updatedAtSelectExpr(s)},
        ${publishedSelectExpr(s)}
      FROM pages
      ORDER BY ${s.updatedAtCol ? "updated_at" : "id"} DESC
    `;

    const { rows } = await db.query(sql);
    res.json({ ok: true, pages: rows });
  } catch (e) {
    console.error("[adminPages:list] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Create page
router.post("/", async (req, res) => {
  try {
    const s = await getPagesSchema();

    const title = String(req.body.title || "").trim();
    let slug = String(req.body.slug || "").trim();

    if (!title)
      return res.status(400).json({ ok: false, error: "Title is required" });

    slug = safeSlug(slug || title);
    if (!slug)
      return res.status(400).json({ ok: false, error: "Slug is required" });

    // Build INSERT columns based on schema
    const cols = ["title", "slug"];
    const vals = ["$1", "$2"];
    const params = [title, slug];

    if (s.statusCol) {
      cols.push("status");
      vals.push(`'draft'`);
    }

    if (s.htmlCol) {
      cols.push(s.htmlCol);
      vals.push(`''`);
    }

    if (s.updatedAtCol) {
      cols.push("updated_at");
      vals.push(nowSql());
    }

    const sql = `
      INSERT INTO pages (${cols.join(", ")})
      VALUES (${vals.join(", ")})
      RETURNING
        id, title, slug,
        ${defaultStatusExpr(s)} AS status,
        ${updatedAtSelectExpr(s)},
        ${publishedSelectExpr(s)}
    `;

    const { rows } = await db.query(sql, params);
    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    if (String(e?.code) === "23505") {
      return res.status(409).json({ ok: false, error: "Slug already exists" });
    }
    console.error("[adminPages:create] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Get details
router.get("/:id", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);

    const fields = [
      "id",
      "title",
      "slug",
      `${defaultStatusExpr(s)} AS status`,
      s.heroCol ? `${s.heroCol} AS hero_image_url` : `NULL AS hero_image_url`,
      s.excerptCol ? `${s.excerptCol} AS excerpt` : `NULL AS excerpt`,
      htmlSelectExpr(s),
      s.jsonCol ? `${s.jsonCol} AS content_json` : `NULL AS content_json`,
      updatedAtSelectExpr(s),
      publishedSelectExpr(s),
      createdAtSelectExpr(s),
    ];

    const sql = `
      SELECT ${fields.join(", ")}
      FROM pages
      WHERE id=$1
      LIMIT 1
    `;

    const { rows } = await db.query(sql, [id]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });

    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    console.error("[adminPages:get] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Update draft (save)
router.put("/:id", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);

    const title = String(req.body.title || "").trim();
    const slugRaw = String(req.body.slug || "").trim();
    const slug = safeSlug(slugRaw);

    const hero_image_url = req.body.hero_image_url
      ? String(req.body.hero_image_url)
      : null;
    const excerpt = req.body.excerpt ? String(req.body.excerpt) : null;
    const content_html = String(req.body.content_html || "");
    const content_json = req.body.content_json ?? null;

    if (!title)
      return res.status(400).json({ ok: false, error: "Title is required" });
    if (!slug)
      return res.status(400).json({ ok: false, error: "Slug is required" });

    // Build UPDATE dynamically
    const sets = ["title=$1", "slug=$2"];
    const params = [title, slug];

    let p = params.length;

    if (s.heroCol) {
      sets.push(`${s.heroCol}=$${++p}`);
      params.push(hero_image_url);
    }

    if (s.excerptCol) {
      sets.push(`${s.excerptCol}=$${++p}`);
      params.push(excerpt);
    }

    if (s.htmlCol) {
      sets.push(`${s.htmlCol}=$${++p}`);
      params.push(content_html);
    }

    if (s.jsonCol) {
      sets.push(`${s.jsonCol}=$${++p}`);
      params.push(content_json);
    }

    if (s.updatedAtCol) {
      sets.push(`updated_at=${nowSql()}`);
    }

    params.push(id);

    const returning = [
      "id",
      "title",
      "slug",
      `${defaultStatusExpr(s)} AS status`,
      s.heroCol ? `${s.heroCol} AS hero_image_url` : `NULL AS hero_image_url`,
      s.excerptCol ? `${s.excerptCol} AS excerpt` : `NULL AS excerpt`,
      htmlSelectExpr(s),
      s.jsonCol ? `${s.jsonCol} AS content_json` : `NULL AS content_json`,
      updatedAtSelectExpr(s),
      publishedSelectExpr(s),
    ];

    const sql = `
      UPDATE pages
      SET ${sets.join(", ")}
      WHERE id=$${params.length}
      RETURNING ${returning.join(", ")}
    `;

    const { rows } = await db.query(sql, params);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });

    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    if (String(e?.code) === "23505") {
      return res.status(409).json({ ok: false, error: "Slug already exists" });
    }
    console.error("[adminPages:update] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Publish
router.post("/:id/publish", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);

    const sets = [];
    if (s.statusCol) sets.push(`status='published'`);
    if (s.publishedCol)
      sets.push(`${s.publishedCol}=COALESCE(${s.publishedCol}, NOW())`);
    if (s.updatedAtCol) sets.push(`updated_at=${nowSql()}`);

    if (!sets.length) {
      // If table has none of these columns, just respond OK (rare legacy)
      return res.json({ ok: true, page: { id, status: "published" } });
    }

    const sql = `
      UPDATE pages
      SET ${sets.join(", ")}
      WHERE id=$1
      RETURNING
        id, title, slug,
        ${defaultStatusExpr(s)} AS status,
        ${updatedAtSelectExpr(s)},
        ${publishedSelectExpr(s)}
    `;

    const { rows } = await db.query(sql, [id]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });

    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    console.error("[adminPages:publish] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Unpublish
router.post("/:id/unpublish", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);

    const sets = [];
    if (s.statusCol) sets.push(`status='draft'`);
    if (s.updatedAtCol) sets.push(`updated_at=${nowSql()}`);

    const sql = `
      UPDATE pages
      SET ${sets.length ? sets.join(", ") : `id=id`}
      WHERE id=$1
      RETURNING
        id, title, slug,
        ${defaultStatusExpr(s)} AS status,
        ${updatedAtSelectExpr(s)},
        ${publishedSelectExpr(s)}
    `;

    const { rows } = await db.query(sql, [id]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });

    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    console.error("[adminPages:unpublish] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`DELETE FROM pages WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[adminPages:delete] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

module.exports = router;
