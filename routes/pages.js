// server-api/routes/pages.js
const express = require("express");
const router = express.Router();

// Adjust to your project
const pool = require("../db");

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizeAccess(v) {
  const x = safeStr(v).toLowerCase();
  if (x === "members" || x === "member") return "members";
  if (x === "admin") return "admin";
  return "public";
}

async function detectColumns() {
  // Detect whether "pages" has columns we want to use
  const r = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pages'
      AND column_name IN ('status','draft_html','draft_json','published_json','content_html','access','published','updated_at','created_at');
    `
  );

  const set = new Set(r.rows.map((x) => x.column_name));
  return {
    hasStatus: set.has("status"),
    hasDraftHtml: set.has("draft_html"),
    hasDraftJson: set.has("draft_json"),
    hasPublishedJson: set.has("published_json"),
    hasContentHtml: set.has("content_html"),
    hasAccess: set.has("access"),
    hasPublished: set.has("published"),
    hasUpdatedAt: set.has("updated_at"),
    hasCreatedAt: set.has("created_at"),
  };
}

/* --------------------------
   GET /api/admin/pages
-------------------------- */
router.get("/admin/pages", async (req, res) => {
  try {
    const cols = await detectColumns();

    const q = safeStr(req.query.q).toLowerCase();
    const access = normalizeAccess(req.query.access || req.query.visibility);
    const published = safeStr(req.query.published); // "true"/"false"/""

    const where = [];
    const params = [];
    let i = 1;

    // If status exists, hide deleted by default
    if (cols.hasStatus && safeStr(req.query.include_deleted) !== "true") {
      where.push(`COALESCE(status,'') <> 'deleted'`);
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(LOWER(COALESCE(title,'')) LIKE $${i} OR LOWER(COALESCE(slug,'')) LIKE $${i})`
      );
      i++;
    }

    if (cols.hasAccess && access && access !== "all") {
      params.push(access);
      where.push(`LOWER(COALESCE(access,'public')) = $${i}`);
      i++;
    }

    if (cols.hasPublished && (published === "true" || published === "false")) {
      params.push(published === "true");
      where.push(`COALESCE(published,false) = $${i}`);
      i++;
    }

    const statusSelect = cols.hasStatus
      ? `COALESCE(status, CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END) AS status`
      : `CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END AS status`;

    const updatedAtCol = cols.hasUpdatedAt ? "updated_at" : "NULL";
    const createdAtCol = cols.hasCreatedAt ? "created_at" : "NULL";

    const sql = `
      SELECT
        id,
        slug,
        title,
        ${statusSelect},
        ${
          cols.hasAccess
            ? `COALESCE(access,'public') AS access,`
            : `'public' AS access,`
        }
        ${
          cols.hasPublished
            ? `COALESCE(published,false) AS published,`
            : `false AS published,`
        }
        ${updatedAtCol} AS updated_at,
        ${createdAtCol} AS created_at
      FROM pages
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(${updatedAtCol}, ${createdAtCol}) DESC NULLS LAST, id DESC
      LIMIT 500;
    `;

    const r = await pool.query(sql, params);
    return res.json({ ok: true, pages: r.rows });
  } catch (e) {
    console.error("GET /admin/pages error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load pages." });
  }
});

/* --------------------------
   GET /api/admin/pages/:id
-------------------------- */
router.get("/admin/pages/:id", async (req, res) => {
  try {
    const cols = await detectColumns();
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid id" });

    const statusSelect = cols.hasStatus
      ? `COALESCE(status, CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END) AS status`
      : `CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END AS status`;

    const sql = `
      SELECT
        id, slug, title,
        ${
          cols.hasAccess
            ? `COALESCE(access,'public') AS access,`
            : `'public' AS access,`
        }
        ${statusSelect},
        ${
          cols.hasPublished
            ? `COALESCE(published,false) AS published,`
            : `false AS published,`
        }
        ${cols.hasContentHtml ? `content_html,` : `NULL::text AS content_html,`}
        ${cols.hasDraftHtml ? `draft_html,` : `NULL::text AS draft_html,`}
        ${cols.hasDraftJson ? `draft_json,` : `NULL::jsonb AS draft_json,`}
        ${
          cols.hasPublishedJson
            ? `published_json,`
            : `NULL::jsonb AS published_json,`
        }
        ${cols.hasCreatedAt ? `created_at,` : `NULL AS created_at,`}
        ${cols.hasUpdatedAt ? `updated_at` : `NULL AS updated_at`}
      FROM pages
      WHERE id = $1
      LIMIT 1;
    `;

    const r = await pool.query(sql, [id]);
    if (!r.rows[0])
      return res.status(404).json({ ok: false, message: "Not found" });
    return res.json({ ok: true, page: r.rows[0] });
  } catch (e) {
    console.error("GET /admin/pages/:id error:", e);
    return res.status(500).json({ ok: false, message: "Failed to load page." });
  }
});

/* --------------------------
   POST /api/admin/pages
-------------------------- */
router.post("/admin/pages", async (req, res) => {
  try {
    const cols = await detectColumns();

    const title = safeStr(req.body.title);
    const slug = safeStr(req.body.slug);
    const access = normalizeAccess(req.body.access || req.body.visibility);
    const published = !!req.body.published;

    if (!title)
      return res.status(400).json({ ok: false, message: "Title is required." });
    if (!slug)
      return res.status(400).json({ ok: false, message: "Slug is required." });

    const fields = ["title", "slug"];
    const values = [title, slug];
    const placeholders = ["$1", "$2"];
    let i = 3;

    if (cols.hasAccess) {
      fields.push("access");
      values.push(access);
      placeholders.push(`$${i++}`);
    }

    if (cols.hasStatus) {
      fields.push("status");
      values.push(published ? "published" : "draft");
      placeholders.push(`$${i++}`);
    }

    if (cols.hasPublished) {
      fields.push("published");
      values.push(published);
      placeholders.push(`$${i++}`);
    }

    // optional timestamps if you have them
    if (cols.hasCreatedAt) {
      fields.push("created_at");
      placeholders.push("NOW()");
    }
    if (cols.hasUpdatedAt) {
      fields.push("updated_at");
      placeholders.push("NOW()");
    }

    const sql = `
      INSERT INTO pages (${fields.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING id, title, slug
      ${
        cols.hasAccess
          ? `, COALESCE(access,'public') AS access`
          : `, 'public' AS access`
      }
      ${
        cols.hasPublished
          ? `, COALESCE(published,false) AS published`
          : `, false AS published`
      }
      ${
        cols.hasStatus
          ? `, COALESCE(status,'draft') AS status`
          : `, CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END AS status`
      };
    `;

    const r = await pool.query(sql, values);
    return res.json({ ok: true, page: r.rows[0] });
  } catch (e) {
    console.error("POST /admin/pages error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "Failed to create page." });
  }
});

/* --------------------------
   PUT /api/admin/pages/:id
-------------------------- */
router.put("/admin/pages/:id", async (req, res) => {
  try {
    const cols = await detectColumns();
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid id" });

    const sets = [];
    const params = [];
    let i = 1;

    const title = safeStr(req.body.title);
    const slug = safeStr(req.body.slug);

    if (title) {
      params.push(title);
      sets.push(`title = $${i++}`);
    }
    if (slug) {
      params.push(slug);
      sets.push(`slug = $${i++}`);
    }

    if (cols.hasAccess && (req.body.access || req.body.visibility)) {
      params.push(normalizeAccess(req.body.access || req.body.visibility));
      sets.push(`access = $${i++}`);
    }

    if (cols.hasPublished && typeof req.body.published === "boolean") {
      params.push(req.body.published);
      sets.push(`published = $${i++}`);
    }

    if (cols.hasStatus && req.body.status) {
      params.push(String(req.body.status));
      sets.push(`status = $${i++}`);
    }

    if (cols.hasDraftHtml && req.body.draft_html !== undefined) {
      params.push(req.body.draft_html ?? null);
      sets.push(`draft_html = $${i++}`);
    }
    if (cols.hasDraftJson && req.body.draft_json !== undefined) {
      params.push(req.body.draft_json ?? null);
      sets.push(`draft_json = $${i++}::jsonb`);
    }
    if (cols.hasContentHtml && req.body.content_html !== undefined) {
      params.push(req.body.content_html ?? null);
      sets.push(`content_html = $${i++}`);
    }
    if (cols.hasPublishedJson && req.body.published_json !== undefined) {
      params.push(req.body.published_json ?? null);
      sets.push(`published_json = $${i++}::jsonb`);
    }

    if (cols.hasUpdatedAt) sets.push(`updated_at = NOW()`);

    if (!sets.length) return res.json({ ok: true });

    params.push(id);

    const sql = `
      UPDATE pages
      SET ${sets.join(", ")}
      WHERE id = $${i}
      RETURNING id, title, slug
      ${
        cols.hasAccess
          ? `, COALESCE(access,'public') AS access`
          : `, 'public' AS access`
      }
      ${
        cols.hasPublished
          ? `, COALESCE(published,false) AS published`
          : `, false AS published`
      }
      ${
        cols.hasStatus
          ? `, COALESCE(status,'draft') AS status`
          : `, CASE WHEN COALESCE(published,false) THEN 'published' ELSE 'draft' END AS status`
      };
    `;

    const r = await pool.query(sql, params);
    if (!r.rows[0])
      return res.status(404).json({ ok: false, message: "Not found" });
    return res.json({ ok: true, page: r.rows[0] });
  } catch (e) {
    console.error("PUT /admin/pages/:id error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "Failed to update page." });
  }
});

/* --------------------------
   DELETE /api/admin/pages/:id
   - soft delete if status exists
   - hard delete if not
-------------------------- */
router.delete("/admin/pages/:id", async (req, res) => {
  try {
    const cols = await detectColumns();
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid id" });

    if (cols.hasStatus) {
      await pool.query(
        `UPDATE pages SET status='deleted' ${
          cols.hasPublished ? ", published=false" : ""
        } ${cols.hasUpdatedAt ? ", updated_at=NOW()" : ""} WHERE id=$1`,
        [id]
      );
      return res.json({ ok: true });
    }

    // hard delete fallback
    await pool.query(`DELETE FROM pages WHERE id=$1`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /admin/pages/:id error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to delete page." });
  }
});

/* --------------------------
   PUBLIC: GET /api/pages/:slug
-------------------------- */
router.get("/pages/:slug", async (req, res) => {
  try {
    const cols = await detectColumns();
    const slug = safeStr(req.params.slug);
    if (!slug)
      return res.status(400).json({ ok: false, message: "Missing slug" });

    const sql = `
      SELECT id, slug, title
        ${
          cols.hasContentHtml
            ? `, content_html`
            : `, NULL::text AS content_html`
        }
        ${
          cols.hasAccess
            ? `, COALESCE(access,'public') AS access`
            : `, 'public' AS access`
        }
        ${
          cols.hasPublished
            ? `, COALESCE(published,false) AS published`
            : `, false AS published`
        }
      FROM pages
      WHERE slug = $1
      LIMIT 1;
    `;

    const r = await pool.query(sql, [slug]);
    const page = r.rows[0];
    if (!page) return res.status(404).json({ ok: false, message: "Not found" });

    // only show published pages publicly if column exists
    if (cols.hasPublished && !page.published) {
      return res.status(404).json({ ok: false, message: "Not found" });
    }

    return res.json({ ok: true, page });
  } catch (e) {
    console.error("GET /pages/:slug error:", e);
    return res.status(500).json({ ok: false, message: "Failed to load page." });
  }
});

module.exports = router;
