// server-api/routes/sites.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

/* ---------- defaults ---------- */
function defaultSettings() {
  return {
    branding: {
      brand_color: "#006aff",
      theme: "light",
      custom_theme: false,
      logo_url: null,
      favicon_url: null,
      name: "BishopTV",
    },
    navigation: {
      menu: [
        { id: "home", title: "Home", path: "/", visible: true },
        { id: "about", title: "About", path: "/about", visible: true },
      ],
    },
    catalog: { featured_category_id: null },
    advanced: { custom_css: "", maintenance: false },
  };
}

function slugify(s = "") {
  return (
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 80) || "page"
  );
}

/* ---------- schema helpers ---------- */
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id SERIAL PRIMARY KEY,
      brand_color TEXT,
      color_scheme TEXT,
      logo_url TEXT,
      favicon_url TEXT,
      site_name TEXT,
      maintenance BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(
    `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS favicon_url TEXT;`
  );
  await db.query(
    `ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS site_name TEXT;`
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS site_nav (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      sort INTEGER DEFAULT 0
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS site_pages (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'public',
      blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/* ---------- settings read/write with flat fallback ---------- */
async function readSettingsCompat() {
  await ensureTables();

  if (await hasColumn("site_settings", "settings")) {
    try {
      const { rows } = await db.query(
        "SELECT settings FROM site_settings ORDER BY id DESC LIMIT 1"
      );
      if (rows[0]?.settings) return rows[0].settings;
    } catch {}
  }

  const { rows } = await db.query(
    "SELECT * FROM site_settings ORDER BY id DESC LIMIT 1"
  );
  const r = rows[0];
  if (!r) return defaultSettings();

  const base = defaultSettings();
  return {
    ...base,
    branding: {
      ...base.branding,
      brand_color: r.brand_color ?? base.branding.brand_color,
      theme: r.color_scheme ?? base.branding.theme,
      logo_url: r.logo_url ?? null,
      favicon_url: r.favicon_url ?? null,
      name: r.site_name ?? base.branding.name,
    },
    advanced: {
      ...base.advanced,
      maintenance: !!r.maintenance,
    },
  };
}

async function saveSettingsCompat(incoming) {
  const s = incoming || defaultSettings();
  await ensureTables();

  if (await hasColumn("site_settings", "settings")) {
    await db.query("INSERT INTO site_settings (settings) VALUES ($1)", [s]);
    return { ok: true, mode: "json" };
  }

  // flat fallback
  const flat = {
    brand_color: s.branding?.brand_color ?? "#006aff",
    color_scheme: s.branding?.theme ?? "light",
    logo_url: s.branding?.logo_url ?? null,
    favicon_url: s.branding?.favicon_url ?? null,
    site_name: s.branding?.name ?? "BishopTV",
    maintenance: !!s.advanced?.maintenance,
  };

  const upd = await db.query(
    `
    UPDATE site_settings
       SET brand_color=$1,
           color_scheme=$2,
           logo_url=$3,
           favicon_url=$4,
           site_name=$5,
           maintenance=$6,
           updated_at=NOW()
     WHERE id = (SELECT id FROM site_settings ORDER BY id ASC LIMIT 1)
     RETURNING id
    `,
    [
      flat.brand_color,
      flat.color_scheme,
      flat.logo_url,
      flat.favicon_url,
      flat.site_name,
      flat.maintenance,
    ]
  );

  if (upd.rowCount === 0) {
    await db.query(
      `
      INSERT INTO site_settings (brand_color, color_scheme, logo_url, favicon_url, site_name, maintenance)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        flat.brand_color,
        flat.color_scheme,
        flat.logo_url,
        flat.favicon_url,
        flat.site_name,
        flat.maintenance,
      ]
    );
  }
  return { ok: true, mode: "flat" };
}

/* ---------- legacy compatibility endpoints ---------- */
router.get("/settings", async (_req, res) => {
  try {
    res.json(await readSettingsCompat());
  } catch (e) {
    console.error("GET /site/settings error:", e);
    res.status(500).json({ message: "Failed to load settings" });
  }
});

router.put("/settings", authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const mapped = {
      ...defaultSettings(),
      branding: {
        ...defaultSettings().branding,
        brand_color: b.brand_color ?? "#006aff",
        theme: b.color_scheme ?? "light",
        logo_url: b.logo_url ?? null,
        favicon_url: b.favicon_url ?? null,
        name: b.site_name ?? "BishopTV",
      },
      advanced: { ...defaultSettings().advanced, maintenance: !!b.maintenance },
    };
    res.json(await saveSettingsCompat(mapped));
  } catch (e) {
    console.error("PUT /site/settings error:", e);
    res.status(500).json({ message: "Failed to save settings" });
  }
});

/* ---------- modern JSON settings endpoints ---------- */
router.get("/", async (_req, res) => {
  try {
    res.json(await readSettingsCompat());
  } catch (e) {
    console.error("GET /api/site error:", e);
    res.json(defaultSettings());
  }
});

router.put("/", authenticate, async (req, res) => {
  try {
    res.json(await saveSettingsCompat(req.body));
  } catch (e) {
    console.error("PUT /api/site error:", e);
    res.status(500).json({ message: "Failed to save" });
  }
});

/* ---------- navigation ---------- */
router.get("/nav", async (_req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query(
      "SELECT * FROM site_nav ORDER BY sort ASC, id ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /site/nav error:", e);
    res.status(500).json({ message: "Failed to load navigation" });
  }
});

router.put("/nav", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    await db.query("DELETE FROM site_nav");
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        "INSERT INTO site_nav (label, url, sort) VALUES ($1,$2,$3)",
        [it.label, it.url, i]
      );
    }
    const { rows } = await db.query(
      "SELECT * FROM site_nav ORDER BY sort ASC, id ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("PUT /site/nav error:", e);
    res.status(500).json({ message: "Failed to save navigation" });
  }
});

/* ---------- pages (site_pages CRUD) ---------- */
router.get("/pages", async (req, res) => {
  try {
    await ensureTables();
    const q = (req.query.q || "").toLowerCase();
    const { rows } = await db.query(
      "SELECT * FROM site_pages ORDER BY updated_at DESC, id DESC"
    );
    res.json(
      q
        ? rows.filter(
            (r) =>
              r.title?.toLowerCase().includes(q) ||
              r.slug?.toLowerCase().includes(q)
          )
        : rows
    );
  } catch (e) {
    console.error("GET /site/pages error:", e);
    res.status(500).json({ message: "Failed to load pages" });
  }
});

router.post("/pages", authenticate, async (req, res) => {
  try {
    await ensureTables();
    let { title, slug, status, blocks } = req.body || {};
    title = title?.trim() || "Untitled";
    slug = slugify(slug || title);
    status = status || "public";
    blocks = Array.isArray(blocks) ? blocks : [];

    let candidate = slug,
      attempt = 1;
    while (true) {
      const { rows } = await db.query(
        "SELECT 1 FROM site_pages WHERE slug=$1",
        [candidate]
      );
      if (rows.length === 0) break;
      attempt++;
      candidate = `${slug}-${attempt}`;
    }

    const ins = await db.query(
      `INSERT INTO site_pages (title, slug, status, blocks)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [title, candidate, status, JSON.stringify(blocks)]
    );
    res.json(ins.rows[0]);
  } catch (e) {
    console.error("POST /site/pages error:", e);
    res.status(500).json({ message: "Failed to create page" });
  }
});

router.get("/pages/:id", async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query("SELECT * FROM site_pages WHERE id=$1", [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("GET /site/pages/:id error:", e);
    res.status(500).json({ message: "Failed to load page" });
  }
});

router.put("/pages/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { title, slug, status, blocks } = req.body || {};
    const { rows } = await db.query(
      `UPDATE site_pages
          SET title=COALESCE($1,title),
              slug=COALESCE($2,slug),
              status=COALESCE($3,status),
              blocks=COALESCE($4,blocks),
              updated_at=NOW()
        WHERE id=$5
        RETURNING *`,
      [
        title,
        slug,
        status,
        blocks ? JSON.stringify(blocks) : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("PUT /site/pages/:id error:", e);
    res.status(500).json({ message: "Failed to save page" });
  }
});

router.delete("/pages/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    await db.query("DELETE FROM site_pages WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /site/pages/:id error:", e);
    res.status(500).json({ message: "Failed to delete page" });
  }
});

router.post("/pages/:id/duplicate", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query("SELECT * FROM site_pages WHERE id=$1", [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    const src = rows[0];
    const newSlug = slugify(`${src.slug}-copy`);
    const ins = await db.query(
      `INSERT INTO site_pages (title, slug, status, blocks)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [`${src.title} (Copy)`, newSlug, src.status, src.blocks]
    );
    res.json(ins.rows[0]);
  } catch (e) {
    console.error("POST /site/pages/:id/duplicate error:", e);
    res.status(500).json({ message: "Failed to duplicate page" });
  }
});

/* ---------- PUBLIC: homepage helpers (legacy) ---------- */
async function getHomepage(client) {
  // Try explicit homepage in legacy `pages` table
  const q1 = `
    SELECT id, slug, title, content_html AS content
    FROM pages
    WHERE published = true AND is_homepage = true
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const r1 = await client.query(q1);
  if (r1.rows.length) return r1.rows[0];

  const q2 = `
    SELECT id, slug, title, content_html AS content
    FROM pages
    WHERE published = true
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const r2 = await client.query(q2);
  if (r2.rows.length) return r2.rows[0];

  return null;
}

/* ---------- PUBLIC: homepage ---------- */
router.get(["/public", "/public/homepage"], async (_req, res) => {
  try {
    const page = await getHomepage(db);
    if (!page)
      return res.status(404).json({ message: "No homepage configured." });
    return res.json({ page });
  } catch (err) {
    console.error("[site.public.homepage] Error:", err);
    return res.status(500).json({ message: "Failed to load homepage." });
  }
});

/* ---------- PUBLIC: resolve page by slug ----------
   1) site_pages (status != 'archived')
   2) channel_pages (is_published = TRUE; match slug or page_slug)
   Returns: { ok:true, page:{ id,title,slug,blocks,published_html,channel_slug? } }
--------------------------------------------------- */
router.get("/public/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) return res.status(400).json({ ok: false, error: "bad_request" });

  try {
    await ensureTables();

    // 1) Prefer published channel_pages (Studio pages)
    const ch = await db.query(
      `
      SELECT p.id, p.title, COALESCE(p.slug, p.page_slug) AS slug,
             p.content_published, p.published_html, p.published_at,
             c.slug AS channel_slug
        FROM channel_pages p
        JOIN channels c ON c.id = p.channel_id
       WHERE p.is_published = TRUE
         AND (lower(p.slug) = lower($1) OR lower(p.page_slug) = lower($1))
       ORDER BY p.published_at DESC NULLS LAST, p.updated_at DESC
       LIMIT 1
      `,
      [slug]
    );

    if (ch.rows[0]) {
      const row = ch.rows[0];
      // Normalize published blocks
      let blocks = [];
      const pub = row.content_published;
      if (pub) {
        if (pub.version === 2 && Array.isArray(pub.root)) blocks = pub.root;
        else if (Array.isArray(pub.blocks)) blocks = pub.blocks;
        else if (Array.isArray(pub)) blocks = pub;
      }

      return res.json({
        ok: true,
        page: {
          id: row.id,
          title: row.title,
          slug: row.slug,
          channel_slug: row.channel_slug,
          blocks,
          published_html: row.published_html || null,
          published_at: row.published_at,
        },
      });
    }

    // 2) Fallback: site_pages (headless CMS style)
    const site = await db.query(
      `SELECT id, title, slug, status, blocks
         FROM site_pages
        WHERE slug = $1 AND status <> 'archived'
        LIMIT 1`,
      [slug]
    );

    if (site.rows[0]) {
      const r = site.rows[0];
      return res.json({
        ok: true,
        page: {
          id: r.id,
          title: r.title,
          slug: r.slug,
          blocks: Array.isArray(r.blocks) ? r.blocks : [],
          published_html: null,
        },
      });
    }

    // Nothing found
    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (e) {
    console.error("GET /site/public/:slug error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
