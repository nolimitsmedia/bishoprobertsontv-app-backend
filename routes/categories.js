// server-api/routes/categories.js
const express = require("express");
const router = express.Router();
const db = require("../db");

let authenticate;
try {
  authenticate = require("../middleware/authenticate");
} catch (_) {
  authenticate = (_req, _res, next) => next();
}

function cleanStr(s) {
  return String(s || "").trim();
}

async function ensureTables() {
  // base table (works even if it already exists)
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // defensive alters for existing deployments
  await db.query(`
    ALTER TABLE categories
      ADD COLUMN IF NOT EXISTS created_by INTEGER,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // unique per-user (same title allowed across different users)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_categories_owner_name
      ON categories (created_by, lower(name));
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_categories_owner
      ON categories (created_by);
  `);
}

function isAdmin(user) {
  const r = (user?.role || user?.type || "").toLowerCase();
  return r === "admin" || r === "owner";
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */
// GET /api/categories?mine=1&q=term
router.get("/", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const mine =
      String(req.query.mine || "").toLowerCase() === "1" ||
      String(req.query.mine || "").toLowerCase() === "true";
    const q = cleanStr(req.query.q);
    const params = [];
    const where = [];

    if (mine) {
      if (!req.user?.id)
        return res.status(401).json({ message: "Unauthorized" });
      params.push(req.user.id);
      where.push(`created_by = $${params.length}`);
    }

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`lower(name) LIKE $${params.length}`);
    }

    const sql = `
      SELECT id, name, created_by, created_at, updated_at
      FROM categories
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, id DESC
      LIMIT 500
    `;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /categories error:", e);
    res.status(500).json({ message: "Failed to load categories" });
  }
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */
// POST /api/categories  { name }
router.post("/", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const name = cleanStr(req.body?.name);
    if (!name) return res.status(400).json({ message: "Name is required" });

    // upsert-like behavior per user (avoid dup names)
    const { rows: existing } = await db.query(
      `SELECT id, name, created_by FROM categories
       WHERE created_by=$1 AND lower(name)=lower($2)
       LIMIT 1`,
      [userId, name]
    );
    if (existing[0]) return res.json(existing[0]);

    const { rows } = await db.query(
      `INSERT INTO categories (name, created_by, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       RETURNING id, name, created_by, created_at, updated_at`,
      [name, userId]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("POST /categories error:", e);
    const msg =
      e?.code === "23505"
        ? "You already have a category with this name"
        : "Failed to create category";
    res.status(400).json({ message: msg });
  }
});

/* ------------------------------------------------------------------ */
/* Update (owner or admin)                                            */
/* ------------------------------------------------------------------ */
// PUT /api/categories/:id  { name }
router.put("/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id))
      return res.status(400).json({ message: "Invalid id" });

    // fetch + perms
    const { rows: found } = await db.query(
      `SELECT id, name, created_by FROM categories WHERE id=$1`,
      [id]
    );
    const row = found[0];
    if (!row) return res.status(404).json({ message: "Not found" });
    if (!isAdmin(req.user) && String(row.created_by) !== String(userId))
      return res.status(403).json({ message: "Forbidden" });

    const name = cleanStr(req.body?.name);
    if (!name) return res.status(400).json({ message: "Name is required" });

    // prevent per-user duplicates
    await db.query(
      `UPDATE categories
         SET name=$1, updated_at=NOW()
       WHERE id=$2`,
      [name, id]
    );

    const { rows } = await db.query(
      `SELECT id, name, created_by, created_at, updated_at FROM categories WHERE id=$1`,
      [id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("PUT /categories/:id error:", e);
    const msg =
      e?.code === "23505"
        ? "You already have a category with this name"
        : "Failed to update category";
    res.status(400).json({ message: msg });
  }
});

/* ------------------------------------------------------------------ */
/* Delete (owner or admin)                                            */
/* ------------------------------------------------------------------ */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id))
      return res.status(400).json({ message: "Invalid id" });

    const { rows: found } = await db.query(
      `SELECT id, created_by FROM categories WHERE id=$1`,
      [id]
    );
    const row = found[0];
    if (!row) return res.status(404).json({ message: "Not found" });
    if (!isAdmin(req.user) && String(row.created_by) !== String(userId))
      return res.status(403).json({ message: "Forbidden" });

    await db.query(`DELETE FROM categories WHERE id=$1`, [id]);
    res.status(204).send();
  } catch (e) {
    console.error("DELETE /categories/:id error:", e);
    res.status(500).json({ message: "Failed to delete category" });
  }
});

module.exports = router;
