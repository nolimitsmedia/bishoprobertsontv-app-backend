// server-api/routes/adminPages.js
const express = require("express");
const router = express.Router();
const db = require("../db");
// Phase 8-1: Administrators and Website Managers.
const { requireArea } = require("../lib/teamAccess");
const authenticateAdmin = requireArea("website");

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
  // Phase 6: SEO fields (present after the 20261104_04_page_seo migration).
  const seoTitleCol = has("seo_title") ? "seo_title" : null;
  const seoDescCol = has("seo_description") ? "seo_description" : null;
  const seoImageCol = has("seo_image_url") ? "seo_image_url" : null;
  const seoNoindexCol = has("seo_noindex") ? "seo_noindex" : null;
  // Phase 7-2: scheduled publishing (present after 20261105_06_page_schedule).
  const publishAtCol = has("publish_at") ? "publish_at" : null;
  const scheduledByCol = has("scheduled_by") ? "scheduled_by" : null;
  const jsonCol = has("content_json") ? "content_json" : null;
  const draftHtmlCol = has("draft_html") ? "draft_html" : null;
  const draftJsonCol = has("draft_json") ? "draft_json" : null;
  const publishedHtmlCol = has("published_html") ? "published_html" : null;
  const publishedJsonCol = has("published_json") ? "published_json" : null;

  const updatedAtCol = has("updated_at") ? "updated_at" : null;
  const createdAtCol = has("created_at") ? "created_at" : null;

  schemaCache = {
    cols,
    publishedCol,
    htmlCol,
    statusCol,
    heroCol,
    excerptCol,
    seoTitleCol,
    seoDescCol,
    seoImageCol,
    seoNoindexCol,
    publishAtCol,
    scheduledByCol,
    jsonCol,
    draftHtmlCol,
    draftJsonCol,
    publishedHtmlCol,
    publishedJsonCol,
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

    // Initialize the page builder draft without publishing it.
    const seed =
      req.body.content_json &&
      typeof req.body.content_json === "object" &&
      !Array.isArray(req.body.content_json)
        ? req.body.content_json
        : { extra_sections: [] };
    if (s.draftJsonCol) {
      cols.push(s.draftJsonCol);
      params.push(JSON.stringify(seed));
      vals.push(`$${params.length}::jsonb`);
    }
    if (s.draftHtmlCol) {
      cols.push(s.draftHtmlCol);
      vals.push(`''`);
    }

    if (s.statusCol) {
      cols.push("status");
      vals.push(`'draft'`);
    }

    if (s.htmlCol && s.htmlCol !== s.draftHtmlCol) {
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
      s.seoTitleCol ? `${s.seoTitleCol} AS seo_title` : `NULL AS seo_title`,
      s.seoDescCol
        ? `${s.seoDescCol} AS seo_description`
        : `NULL AS seo_description`,
      s.seoImageCol
        ? `${s.seoImageCol} AS seo_image_url`
        : `NULL AS seo_image_url`,
      s.seoNoindexCol
        ? `${s.seoNoindexCol} AS seo_noindex`
        : `FALSE AS seo_noindex`,
      s.publishAtCol ? `${s.publishAtCol} AS publish_at` : `NULL AS publish_at`,
      s.draftHtmlCol
        ? `COALESCE(${s.draftHtmlCol}, ${s.htmlCol || "NULL"}, '') AS content_html`
        : htmlSelectExpr(s),
      s.draftJsonCol
        ? `COALESCE(${s.draftJsonCol}, ${s.jsonCol || "NULL"}) AS content_json`
        : s.jsonCol
          ? `${s.jsonCol} AS content_json`
          : `NULL AS content_json`,
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

    // Phase 6: SEO fields. Only updated when the editor sends them, so older
    // clients can't blank them by accident.
    const seoText = (v, max) =>
      String(v ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max) || null;
    if (s.seoTitleCol && req.body.seo_title !== undefined) {
      sets.push(`${s.seoTitleCol}=$${++p}`);
      params.push(seoText(req.body.seo_title, 120));
    }
    if (s.seoDescCol && req.body.seo_description !== undefined) {
      sets.push(`${s.seoDescCol}=$${++p}`);
      params.push(seoText(req.body.seo_description, 320));
    }
    if (s.seoImageCol && req.body.seo_image_url !== undefined) {
      const img = seoText(req.body.seo_image_url, 2048);
      sets.push(`${s.seoImageCol}=$${++p}`);
      params.push(img && /^(https?:\/\/|\/uploads\/)/i.test(img) ? img : null);
    }
    if (s.seoNoindexCol && req.body.seo_noindex !== undefined) {
      sets.push(`${s.seoNoindexCol}=$${++p}`);
      params.push(
        req.body.seo_noindex === true || req.body.seo_noindex === "true",
      );
    }

    if (
      !s.draftHtmlCol ||
      !s.draftJsonCol ||
      !s.publishedHtmlCol ||
      !s.publishedJsonCol
    ) {
      return res.status(503).json({
        ok: false,
        error: "Draft/published columns are required for safe editing",
      });
    }

    sets.push(`${s.draftHtmlCol}=$${++p}`);
    params.push(content_html);
    sets.push(`${s.draftJsonCol}=$${++p}`);
    params.push(content_json);

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
      s.seoTitleCol ? `${s.seoTitleCol} AS seo_title` : `NULL AS seo_title`,
      s.seoDescCol
        ? `${s.seoDescCol} AS seo_description`
        : `NULL AS seo_description`,
      s.seoImageCol
        ? `${s.seoImageCol} AS seo_image_url`
        : `NULL AS seo_image_url`,
      s.seoNoindexCol
        ? `${s.seoNoindexCol} AS seo_noindex`
        : `FALSE AS seo_noindex`,
      s.publishAtCol ? `${s.publishAtCol} AS publish_at` : `NULL AS publish_at`,
      s.draftHtmlCol
        ? `COALESCE(${s.draftHtmlCol}, ${s.htmlCol || "NULL"}, '') AS content_html`
        : htmlSelectExpr(s),
      s.draftJsonCol
        ? `COALESCE(${s.draftJsonCol}, ${s.jsonCol || "NULL"}) AS content_json`
        : s.jsonCol
          ? `${s.jsonCol} AS content_json`
          : `NULL AS content_json`,
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

    await recordRevision(s, id, "draft", req.user?.id);
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
// Phase 7-2: one publish routine for the Publish button, the scheduler and the
// visitor check. Copies the draft to the published columns, clears any pending
// schedule, and records a "Published" revision. Returns the page row or null.
async function publishPageById(s, id, userId) {
  const draftHtml = `COALESCE(${s.draftHtmlCol}, ${s.htmlCol || "NULL"}, '')`;
  const draftJson = `COALESCE(${s.draftJsonCol}, ${s.jsonCol || "NULL"})`;
  const sets = [
    `${s.publishedHtmlCol}=${draftHtml}`,
    `${s.publishedJsonCol}=${draftJson}`,
  ];
  // Keep legacy columns synchronized on PUBLISH only for older frontend readers.
  if (s.htmlCol && s.htmlCol !== s.publishedHtmlCol)
    sets.push(`${s.htmlCol}=${draftHtml}`);
  if (s.jsonCol && s.jsonCol !== s.publishedJsonCol)
    sets.push(`${s.jsonCol}=${draftJson}`);
  if (s.statusCol) sets.push(`status='published'`);
  if (s.publishedCol === "published_at") sets.push(`published_at=NOW()`);
  if (s.updatedAtCol) sets.push(`updated_at=${nowSql()}`);
  if (s.publishAtCol) sets.push(`${s.publishAtCol}=NULL`);
  if (s.scheduledByCol) sets.push(`${s.scheduledByCol}=NULL`);
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
  if (!rows.length) return null;
  await recordRevision(s, id, "publish", userId);
  return rows[0];
}

function canPublishSafely(s) {
  return !!(
    s.draftHtmlCol &&
    s.draftJsonCol &&
    s.publishedHtmlCol &&
    s.publishedJsonCol
  );
}

router.post("/:id/publish", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);
    if (!canPublishSafely(s)) {
      return res.status(503).json({
        ok: false,
        error: "Draft/published columns are required for safe publishing",
      });
    }
    const page = await publishPageById(s, id, req.user?.id);
    if (!page) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, page });
  } catch (e) {
    console.error("[adminPages:publish] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

/* -----------------------------
   Phase 7-2: scheduled publishing
----------------------------- */
const SCHEDULE_MIN_LEAD_MS = 60 * 1000; // at least 1 minute ahead
const SCHEDULE_MAX_AHEAD_MS = 2 * 366 * 24 * 60 * 60 * 1000; // up to 2 years

// Schedule (or reschedule) the page's draft to publish at publish_at (ISO time).
router.post("/:id/schedule", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "Invalid page ID" });
    if (!s.publishAtCol)
      return res.status(503).json({
        ok: false,
        error:
          "Scheduling is not set up yet. Run the 20261105_06_page_schedule.sql migration.",
      });
    if (!canPublishSafely(s))
      return res
        .status(503)
        .json({
          ok: false,
          error: "Draft/published columns are required for safe publishing",
        });
    const when = new Date(String(req.body?.publish_at || ""));
    const now = Date.now();
    if (Number.isNaN(when.getTime()))
      return res
        .status(400)
        .json({ ok: false, error: "Choose a valid date and time" });
    if (when.getTime() < now + SCHEDULE_MIN_LEAD_MS)
      return res
        .status(400)
        .json({
          ok: false,
          error: "Choose a time at least one minute from now",
        });
    if (when.getTime() > now + SCHEDULE_MAX_AHEAD_MS)
      return res
        .status(400)
        .json({ ok: false, error: "Choose a time within the next two years" });
    const sets = [`${s.publishAtCol}=$2`];
    const params = [id, when.toISOString()];
    if (s.scheduledByCol) {
      sets.push(`${s.scheduledByCol}=$3`);
      params.push(
        Number.isSafeInteger(Number(req.user?.id)) ? Number(req.user.id) : null,
      );
    }
    const { rows } = await db.query(
      `UPDATE pages SET ${sets.join(", ")} WHERE id=$1 RETURNING id, ${s.publishAtCol} AS publish_at`,
      params,
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, page: rows[0] });
  } catch (e) {
    console.error("[adminPages:schedule] error:", e);
    res.status(500).json({ ok: false, error: "Unable to schedule this page" });
  }
});

// Cancel a pending schedule.
router.delete("/:id/schedule", async (req, res) => {
  try {
    const s = await getPagesSchema();
    const id = Number(req.params.id);
    if (!s.publishAtCol)
      return res.json({ ok: true, page: { id, publish_at: null } });
    const extra = s.scheduledByCol ? `, ${s.scheduledByCol}=NULL` : "";
    const { rows } = await db.query(
      `UPDATE pages SET ${s.publishAtCol}=NULL${extra} WHERE id=$1 RETURNING id`,
      [id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, page: { id, publish_at: null } });
  } catch (e) {
    console.error("[adminPages:unschedule] error:", e);
    res.status(500).json({ ok: false, error: "Unable to cancel the schedule" });
  }
});

// Publishes every page whose scheduled time has passed. Each page is claimed
// (publish_at cleared) in one statement with SKIP LOCKED, so two server
// instances, or the timer and a visitor check, never publish the same page twice.
let schedulerRunning = false;
async function runDueSchedules() {
  if (schedulerRunning) return [];
  schedulerRunning = true;
  const published = [];
  try {
    const s = await getPagesSchema();
    if (!s.publishAtCol || !canPublishSafely(s)) return [];
    const by = s.scheduledByCol
      ? `, p.${s.scheduledByCol} AS scheduled_by`
      : ", NULL AS scheduled_by";
    const { rows } = await db.query(
      `WITH due AS (
         SELECT id FROM pages
          WHERE ${s.publishAtCol} IS NOT NULL AND ${s.publishAtCol} <= NOW()
          ORDER BY ${s.publishAtCol}
          LIMIT 25
          FOR UPDATE SKIP LOCKED
       ), before AS (
         SELECT p.id, p.${s.publishAtCol} AS was_due${by}
           FROM pages p JOIN due ON due.id = p.id
       )
       UPDATE pages SET ${s.publishAtCol}=NULL
         FROM before WHERE pages.id = before.id
       RETURNING pages.id, before.was_due, before.scheduled_by`,
    );
    for (const r of rows) {
      try {
        const page = await publishPageById(s, Number(r.id), r.scheduled_by);
        if (page) published.push(Number(r.id));
        console.log(
          `[scheduler] published page ${r.id} (scheduled for ${new Date(r.was_due).toISOString()})`,
        );
      } catch (e) {
        // Put the schedule back so the next run retries.
        console.error(
          `[scheduler] publishing page ${r.id} failed; will retry:`,
          e?.message || e,
        );
        await db
          .query(
            `UPDATE pages SET ${s.publishAtCol}=$2 WHERE id=$1 AND ${s.publishAtCol} IS NULL`,
            [r.id, r.was_due],
          )
          .catch(() => {});
      }
    }
  } catch (e) {
    console.error("[scheduler] run failed:", e?.message || e);
  } finally {
    schedulerRunning = false;
  }
  return published;
}

/* -----------------------------
   Phase 7: revision history
   Snapshots are recorded after a draft save (only when content changed since
   the last snapshot), after every publish, and before a restore. Restoring
   copies a snapshot back into the DRAFT; publishing stays a separate step.
   Recording never blocks saving: if the table is missing it is skipped.
----------------------------- */
const DRAFT_REVISIONS_KEPT = 50;
const REVISIONS_KEPT = 200;
let revisionsMissingLogged = false;

function revisionSourceSql(s, kind) {
  const html =
    kind === "publish" && s.publishedHtmlCol
      ? `COALESCE(${s.publishedHtmlCol}, '')`
      : s.draftHtmlCol
        ? `COALESCE(${s.draftHtmlCol}, ${s.htmlCol || "NULL"}, '')`
        : `COALESCE(${s.htmlCol || "NULL"}, '')`;
  const json =
    kind === "publish" && s.publishedJsonCol
      ? `${s.publishedJsonCol}`
      : s.draftJsonCol
        ? `COALESCE(${s.draftJsonCol}, ${s.jsonCol || "NULL"})`
        : `${s.jsonCol || "NULL"}`;
  return `
    SELECT
      p.id AS page_id,
      p.title,
      to_jsonb(p) ->> 'excerpt' AS excerpt,
      to_jsonb(p) ->> 'hero_image_url' AS hero_image_url,
      ${html} AS content_html,
      (${json})::jsonb AS content_json,
      jsonb_build_object(
        'seo_title', to_jsonb(p) ->> 'seo_title',
        'seo_description', to_jsonb(p) ->> 'seo_description',
        'seo_image_url', to_jsonb(p) ->> 'seo_image_url',
        'seo_noindex', COALESCE((to_jsonb(p) ->> 'seo_noindex')::boolean, FALSE)
      ) AS seo
    FROM pages p
    WHERE p.id = $1`;
}

async function recordRevision(s, pageId, kind, userId) {
  try {
    const { rows } = await db.query(
      `
      WITH src AS (${revisionSourceSql(s, kind)}),
      h AS (
        SELECT src.*, md5(
          COALESCE(title, '') || '|' || COALESCE(excerpt, '') || '|' ||
          COALESCE(hero_image_url, '') || '|' || COALESCE(content_html, '') || '|' ||
          COALESCE(content_json::text, '') || '|' || COALESCE(seo::text, '')
        ) AS content_hash
        FROM src
      )
      INSERT INTO cms_page_revisions
        (page_id, kind, title, excerpt, hero_image_url, content_html,
         content_json, seo, content_hash, created_by)
      SELECT page_id, $2, title, excerpt, hero_image_url, content_html,
             content_json, seo, content_hash, $3
      FROM h
      WHERE $2 <> 'draft' OR NOT EXISTS (
        SELECT 1 FROM (
          SELECT content_hash FROM cms_page_revisions
          WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
        ) last
        WHERE last.content_hash = h.content_hash
      )
      RETURNING id`,
      [
        pageId,
        kind,
        Number.isSafeInteger(Number(userId)) ? Number(userId) : null,
      ],
    );
    if (rows.length) {
      // Keep the newest draft snapshots and an overall cap per page.
      await db.query(
        `DELETE FROM cms_page_revisions WHERE id IN (
           SELECT id FROM cms_page_revisions WHERE page_id = $1 AND kind = 'draft'
           ORDER BY created_at DESC, id DESC OFFSET ${DRAFT_REVISIONS_KEPT})`,
        [pageId],
      );
      await db.query(
        `DELETE FROM cms_page_revisions WHERE id IN (
           SELECT id FROM cms_page_revisions WHERE page_id = $1
           ORDER BY created_at DESC, id DESC OFFSET ${REVISIONS_KEPT})`,
        [pageId],
      );
    }
    return rows[0]?.id || null;
  } catch (e) {
    if (String(e?.code) === "42P01") {
      if (!revisionsMissingLogged) {
        revisionsMissingLogged = true;
        console.warn(
          "[adminPages] revision history is off: run 20261104_05_page_revisions.sql",
        );
      }
      return null;
    }
    console.error("[adminPages:recordRevision] error:", e);
    return null;
  }
}

function revisionAuthorSql() {
  return `(SELECT COALESCE(to_jsonb(u) ->> 'name', to_jsonb(u) ->> 'email')
             FROM users u WHERE u.id = r.created_by)`;
}

// List (no content, newest first)
router.get("/:id/revisions", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return res.status(400).json({ ok: false, error: "Invalid page ID" });
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      `SELECT r.id, r.kind, r.title, r.created_at, r.created_by,
              ${revisionAuthorSql()} AS author,
              jsonb_array_length(COALESCE(r.content_json -> 'extra_sections', '[]'::jsonb)) AS section_count
         FROM cms_page_revisions r
        WHERE r.page_id = $1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 200`,
      [id],
    );
    res.json({
      ok: true,
      revisions: rows.map((r) => ({ ...r, id: Number(r.id) })),
    });
  } catch (e) {
    if (String(e?.code) === "42P01")
      return res.status(503).json({
        ok: false,
        error:
          "Revision history is not set up yet. Run the 20261104_05_page_revisions.sql migration.",
      });
    console.error("[adminPages:revisions] error:", e);
    res
      .status(500)
      .json({ ok: false, error: "Unable to load revision history" });
  }
});

// One revision, with content (for previewing)
router.get("/:id/revisions/:revId", async (req, res) => {
  const id = Number(req.params.id);
  const revId = Number(req.params.revId);
  if (![id, revId].every((n) => Number.isSafeInteger(n) && n > 0))
    return res.status(400).json({ ok: false, error: "Invalid ID" });
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      `SELECT r.*, ${revisionAuthorSql()} AS author
         FROM cms_page_revisions r WHERE r.page_id = $1 AND r.id = $2`,
      [id, revId],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Revision not found" });
    res.json({ ok: true, revision: { ...rows[0], id: Number(rows[0].id) } });
  } catch (e) {
    console.error("[adminPages:revision] error:", e);
    res.status(500).json({ ok: false, error: "Unable to load revision" });
  }
});

// Restore into the DRAFT (never publishes). The current draft is kept as a
// "before restore" revision first, so a restore can be undone.
router.post("/:id/revisions/:revId/restore", async (req, res) => {
  const id = Number(req.params.id);
  const revId = Number(req.params.revId);
  if (![id, revId].every((n) => Number.isSafeInteger(n) && n > 0))
    return res.status(400).json({ ok: false, error: "Invalid ID" });
  try {
    const s = await getPagesSchema();
    if (!s.draftHtmlCol || !s.draftJsonCol)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Draft columns are required to restore safely",
        });
    const { rows: revs } = await db.query(
      `SELECT * FROM cms_page_revisions WHERE page_id = $1 AND id = $2`,
      [id, revId],
    );
    if (!revs.length)
      return res.status(404).json({ ok: false, error: "Revision not found" });
    const rev = revs[0];

    await recordRevision(s, id, "before_restore", req.user?.id);

    const seo = rev.seo && typeof rev.seo === "object" ? rev.seo : {};
    const sets = [
      "title=$2",
      `${s.draftHtmlCol}=$3`,
      `${s.draftJsonCol}=$4::jsonb`,
    ];
    const params = [
      id,
      rev.title || "Untitled",
      rev.content_html || "",
      rev.content_json == null ? null : JSON.stringify(rev.content_json),
    ];
    let p = params.length;
    if (s.excerptCol) {
      sets.push(`${s.excerptCol}=$${++p}`);
      params.push(rev.excerpt ?? null);
    }
    if (s.heroCol) {
      sets.push(`${s.heroCol}=$${++p}`);
      params.push(rev.hero_image_url ?? null);
    }
    if (s.seoTitleCol) {
      sets.push(`${s.seoTitleCol}=$${++p}`);
      params.push(seo.seo_title ?? null);
    }
    if (s.seoDescCol) {
      sets.push(`${s.seoDescCol}=$${++p}`);
      params.push(seo.seo_description ?? null);
    }
    if (s.seoImageCol) {
      sets.push(`${s.seoImageCol}=$${++p}`);
      params.push(seo.seo_image_url ?? null);
    }
    if (s.seoNoindexCol) {
      sets.push(`${s.seoNoindexCol}=$${++p}`);
      params.push(seo.seo_noindex === true);
    }
    if (s.updatedAtCol) sets.push(`updated_at=${nowSql()}`);
    const { rowCount } = await db.query(
      `UPDATE pages SET ${sets.join(", ")} WHERE id=$1`,
      params,
    );
    if (!rowCount)
      return res.status(404).json({ ok: false, error: "Page not found" });
    res.json({ ok: true, restored: revId });
  } catch (e) {
    console.error("[adminPages:restore] error:", e);
    res
      .status(500)
      .json({ ok: false, error: "Unable to restore this revision" });
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
    // Phase 7: remove the deleted page's history too (ignored if not set up).
    await db
      .query(`DELETE FROM cms_page_revisions WHERE page_id=$1`, [id])
      .catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error("[adminPages:delete] error:", e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

module.exports = router;
// Phase 7-2: used by server.js (timer) and pagesPublic.js (visitor check).
module.exports.runDueSchedules = runDueSchedules;
