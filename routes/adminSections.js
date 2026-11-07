// server-api/routes/adminSections.js
//
// Phase 4G-C3 — Reusable Section Library (admin only).
//
//   GET  /api/admin/sections        List saved sections (summary, no JSON body)
//   GET  /api/admin/sections/:id    One saved section, including section_json
//   POST /api/admin/sections        Save a section { name, category?, section }
//   PATCH /api/admin/sections/:id   Rename / recategorize { name?, category? }  (4G-C4)
//   DELETE /api/admin/sections/:id  Delete a saved section                       (4G-C4)
//
// Saved sections are snapshots. The editor copies section_json into a page's
// content_json.extra_sections with fresh IDs, so no page ever references this
// table: renaming or deleting a saved section never changes any page.

const express = require("express");
const router = express.Router();
const db = require("../db");
// Phase 8-1: Administrators and Website Managers.
const { requireArea } = require("../lib/teamAccess");
const authenticateAdmin = requireArea("website");

router.use(authenticateAdmin);

const MAX_NAME = 120;
const MAX_CATEGORY = 60;
const MAX_BLOCKS = 200;
const MAX_SECTION_BYTES = 1024 * 1024; // 1 MB of JSON per saved section

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validateSection(section) {
  if (!isObj(section)) throw new Error("Section must be an object");
  if (section.blocks !== undefined && !Array.isArray(section.blocks))
    throw new Error("Section blocks must be a list");
  const blocks = Array.isArray(section.blocks) ? section.blocks : [];
  if (blocks.length > MAX_BLOCKS)
    throw new Error(`A saved section can hold up to ${MAX_BLOCKS} blocks`);
  if (blocks.some((b) => !isObj(b)))
    throw new Error("Every block in the section must be an object");

  const json = JSON.stringify(section);
  if (Buffer.byteLength(json, "utf8") > MAX_SECTION_BYTES)
    throw new Error("This section is too large to save (1 MB limit)");

  // Collapsed state is an editor preference, not content.
  const copy = JSON.parse(json);
  delete copy.collapsed;
  return copy;
}

function summarize(row) {
  const sec = isObj(row.section_json) ? row.section_json : {};
  const blocks = Array.isArray(sec.blocks) ? sec.blocks : [];
  return {
    id: Number(row.id),
    name: row.name,
    category: row.category || null,
    title: String(sec.title || ""),
    layout: String(sec.layout || "card"),
    block_count: blocks.length,
    block_types: [...new Set(blocks.map((b) => String(b?.type || "richtext")))],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// List — summaries only, so the library stays light with many saved sections.
router.get("/", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      `SELECT id, name, category, section_json, created_at, updated_at
         FROM cms_reusable_sections
        ORDER BY updated_at DESC, id DESC
        LIMIT 500`,
    );
    res.json({ ok: true, sections: rows.map(summarize) });
  } catch (err) {
    if (String(err?.code) === "42P01") {
      return res.status(503).json({
        ok: false,
        error:
          "Saved sections are not set up yet. Run the 20261103_02_cms_reusable_sections.sql migration.",
      });
    }
    console.error("[adminSections:list]", err);
    res.status(500).json({ ok: false, error: "Unable to load saved sections" });
  }
});

// One — full JSON, fetched only when the admin inserts it.
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return res.status(400).json({ ok: false, error: "Invalid section ID" });
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      `SELECT id, name, category, section_json, created_at, updated_at
         FROM cms_reusable_sections WHERE id = $1`,
      [id],
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ ok: false, error: "Saved section not found" });
    res.json({
      ok: true,
      section: { ...summarize(rows[0]), section_json: rows[0].section_json },
    });
  } catch (err) {
    console.error("[adminSections:get]", err);
    res.status(500).json({ ok: false, error: "Unable to load saved section" });
  }
});

// Create.
router.post("/", async (req, res) => {
  const name = cleanText(req.body?.name, MAX_NAME + 1);
  const category = cleanText(req.body?.category, MAX_CATEGORY + 1) || null;
  if (!name) return res.status(400).json({ ok: false, error: "Enter a name" });
  if (name.length > MAX_NAME)
    return res
      .status(400)
      .json({ ok: false, error: `Names can be up to ${MAX_NAME} characters` });
  if (category && category.length > MAX_CATEGORY)
    return res.status(400).json({
      ok: false,
      error: `Categories can be up to ${MAX_CATEGORY} characters`,
    });

  let section;
  try {
    section = validateSection(req.body?.section);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  try {
    const createdBy = Number.isSafeInteger(Number(req.user?.id))
      ? Number(req.user.id)
      : null;
    const { rows } = await db.query(
      `INSERT INTO cms_reusable_sections (name, category, section_json, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, category, section_json, created_at, updated_at`,
      [name, category, JSON.stringify(section), createdBy],
    );
    res.status(201).json({ ok: true, section: summarize(rows[0]) });
  } catch (err) {
    if (String(err?.code) === "23505") {
      return res.status(409).json({
        ok: false,
        error: `A saved section named "${name}" already exists. Choose another name.`,
      });
    }
    if (String(err?.code) === "42P01") {
      return res.status(503).json({
        ok: false,
        error:
          "Saved sections are not set up yet. Run the 20261103_02_cms_reusable_sections.sql migration.",
      });
    }
    console.error("[adminSections:create]", err);
    res.status(500).json({ ok: false, error: "Unable to save section" });
  }
});

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "Invalid section ID" });
    return null;
  }
  return id;
}

// Rename and/or change category (Phase 4G-C4). Content is not editable here:
// a saved section is changed by saving a new one from the page builder.
router.patch("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const body = isObj(req.body) ? req.body : {};
  const sets = [];
  const params = [];

  if (body.name !== undefined) {
    const name = cleanText(body.name, MAX_NAME + 1);
    if (!name)
      return res.status(400).json({ ok: false, error: "Enter a name" });
    if (name.length > MAX_NAME)
      return res.status(400).json({
        ok: false,
        error: `Names can be up to ${MAX_NAME} characters`,
      });
    params.push(name);
    sets.push(`name = $${params.length}`);
  }

  if (body.category !== undefined) {
    const category = cleanText(body.category, MAX_CATEGORY + 1) || null;
    if (category && category.length > MAX_CATEGORY)
      return res.status(400).json({
        ok: false,
        error: `Categories can be up to ${MAX_CATEGORY} characters`,
      });
    params.push(category);
    sets.push(`category = $${params.length}`);
  }

  if (!sets.length)
    return res.status(400).json({ ok: false, error: "Nothing to update" });

  try {
    params.push(id);
    const { rows } = await db.query(
      `UPDATE cms_reusable_sections
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING id, name, category, section_json, created_at, updated_at`,
      params,
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ ok: false, error: "Saved section not found" });
    res.json({ ok: true, section: summarize(rows[0]) });
  } catch (err) {
    if (String(err?.code) === "23505") {
      return res.status(409).json({
        ok: false,
        error:
          "Another saved section already has that name. Choose another name.",
      });
    }
    console.error("[adminSections:update]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to update saved section" });
  }
});

// Delete (Phase 4G-C4). Pages that already contain a copy keep it.
router.delete("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const { rowCount } = await db.query(
      "DELETE FROM cms_reusable_sections WHERE id = $1",
      [id],
    );
    if (!rowCount)
      return res
        .status(404)
        .json({ ok: false, error: "Saved section not found" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("[adminSections:delete]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to delete saved section" });
  }
});

module.exports = router;
