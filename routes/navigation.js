const express = require("express");
const router = express.Router();
const db = require("../db");
// Phase 8-1: Administrators and Website Managers.
const { requireArea } = require("../lib/teamAccess");
const authenticateAdmin = requireArea("website");

const MAX_ITEMS = 60;
function validateItems(items) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS)
    throw new Error("Expected an array of up to 60 items");
  const ids = new Set();
  return items
    .map((item, index) => {
      if (!item || typeof item !== "object")
        throw new Error(`Invalid item ${index + 1}`);
      const id = String(item.id || "").trim();
      const label = String(item.label || "").trim();
      const href = String(item.href || "").trim();
      const parentId = item.parentId ? String(item.parentId).trim() : null;
      if (!id || id.length > 80 || ids.has(id))
        throw new Error("Each item needs a unique ID");
      if (!label || label.length > 80)
        throw new Error("Labels must be 1–80 characters");
      if (
        !href ||
        href.length > 500 ||
        !(
          (href.startsWith("/") && !href.startsWith("//")) ||
          /^https:\/\//i.test(href)
        )
      )
        throw new Error("Links must be an internal path or HTTPS URL");
      if (/[\\\r\n]/.test(href) || /[<>]/.test(href))
        throw new Error("Invalid link");
      ids.add(id);
      return { id, label, href, parentId, visible: item.visible !== false };
    })
    .map((item) => {
      if (
        item.parentId &&
        (!ids.has(item.parentId) || item.parentId === item.id)
      )
        throw new Error("Invalid parent menu item");
      return item;
    });
}
router.get("/header", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      "SELECT published_items FROM site_navigation WHERE menu_key=$1",
      ["header"],
    );
    res.json({
      ok: true,
      configured: !!rows.length && rows[0].published_items !== null,
      items: rows[0]?.published_items ?? null,
    });
  } catch (e) {
    console.error("[navigation:public]", e);
    res.status(500).json({ ok: false, error: "Navigation unavailable" });
  }
});
router.get("/admin/header", authenticateAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT draft_items,published_items,updated_at,published_at FROM site_navigation WHERE menu_key=$1",
      ["header"],
    );
    res.json({
      ok: true,
      draft: rows[0]?.draft_items ?? null,
      published: rows[0]?.published_items ?? null,
      updated_at: rows[0]?.updated_at ?? null,
    });
  } catch (e) {
    console.error("[navigation:admin:get]", e);
    res.status(500).json({ ok: false, error: "Unable to load navigation" });
  }
});
router.put("/admin/header", authenticateAdmin, async (req, res) => {
  try {
    const items = validateItems(req.body?.items);
    await db.query(
      `INSERT INTO site_navigation(menu_key,draft_items) VALUES ('header',$1::jsonb)
      ON CONFLICT(menu_key) DO UPDATE SET draft_items=EXCLUDED.draft_items,updated_at=NOW()`,
      [JSON.stringify(items)],
    );
    res.json({ ok: true, items });
  } catch (e) {
    const invalid =
      e.message &&
      !/relation .*does not exist/i.test(e.message) &&
      !/database/i.test(e.message);
    console.error("[navigation:save]", e);
    res.status(invalid ? 400 : 500).json({
      ok: false,
      error: invalid ? e.message : "Unable to save navigation",
    });
  }
});
router.post("/admin/header/publish", authenticateAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE site_navigation SET published_items=draft_items,published_at=NOW(),updated_at=NOW() WHERE menu_key='header' RETURNING published_items`,
    );
    if (!rows.length)
      return res
        .status(409)
        .json({ ok: false, error: "Save a draft before publishing" });
    res.json({ ok: true, items: rows[0].published_items });
  } catch (e) {
    console.error("[navigation:publish]", e);
    res.status(500).json({ ok: false, error: "Unable to publish navigation" });
  }
});
module.exports = router;
