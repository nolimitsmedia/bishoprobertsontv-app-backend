// server-api/routes/forms.js
//
// Release 1.2 Part C — Form element (contact / prayer request).
//
//   POST   /api/forms/submit                  public: submit a form on a published page
//   GET    /api/forms/admin/submissions       inbox (list, filter by form, unread)
//   GET    /api/forms/admin/forms             forms that have submissions (for the filter)
//   PATCH  /api/forms/admin/submissions/:id   mark read / unread
//   DELETE /api/forms/admin/submissions/:id   delete
//   GET    /api/forms/admin/export.csv        CSV export (optionally one form)
//
// Security: the form's fields come from the PUBLISHED page content, never from
// the request, so only fields an editor defined are stored; required fields,
// lengths and email format are checked here. Spam: hidden honeypot field, a
// minimum fill time, and a per-visitor rate limit. Notification emails go only
// to the address set on the form in the page (not one sent by the visitor).

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../db");
const { requireArea } = require("../lib/teamAccess");

const inboxAccess = requireArea("website", "support", "community");
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const FIELD_TYPES = new Set([
  "text",
  "email",
  "phone",
  "textarea",
  "select",
  "checkbox",
]);
const MAX_LEN = {
  text: 200,
  email: 200,
  phone: 40,
  textarea: 5000,
  select: 200,
  checkbox: 5,
};

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// Find a Form element by id anywhere in a page (sections, containers, columns).
function findForm(contentJson, formId) {
  const walk = (blocks) => {
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!isObj(b)) continue;
      if (String(b.id) === formId && b.type === "form") return b;
      for (const c of Array.isArray(b.columns) ? b.columns : []) {
        const hit = walk(c?.blocks);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const sec of Array.isArray(contentJson?.extra_sections)
    ? contentJson.extra_sections
    : []) {
    const hit = walk(sec?.blocks);
    if (hit) return hit;
  }
  return null;
}

// Small in-memory limit: 5 submissions per visitor per 10 minutes.
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000)
    for (const [k, v] of hits)
      if (!v.some((t) => now - t < 10 * 60 * 1000)) hits.delete(k);
  return list.length > 5;
}

function clientIp(req) {
  return String(
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
  )
    .split(",")[0]
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

router.post("/submit", express.json({ limit: "64kb" }), async (req, res) => {
  try {
    const body = isObj(req.body) ? req.body : {};
    const ip = clientIp(req);
    const ipHash = crypto
      .createHash("sha256")
      .update(`${ip}|${process.env.JWT_SECRET || "brtv"}`)
      .digest("hex")
      .slice(0, 32);
    if (rateLimited(ipHash))
      return res
        .status(429)
        .json({
          ok: false,
          error: "Too many submissions. Please try again in a few minutes.",
        });

    // Spam traps: a filled hidden field, or a form sent in under 2 seconds.
    const started = Number(body.started_at);
    if (
      String(body.website || "").trim() ||
      (Number.isFinite(started) && Date.now() - started < 2000)
    ) {
      return res.json({ ok: true, message: "Thank you!" }); // looks fine to bots; nothing stored
    }

    const formId = String(body.form_id || "").slice(0, 80);
    const pageId = Number.parseInt(body.page_id, 10);
    const slug = String(body.page_slug || "")
      .trim()
      .toLowerCase()
      .slice(0, 120);
    if (!formId || (!Number.isFinite(pageId) && !slug))
      return res.status(400).json({ ok: false, error: "Unknown form" });
    const { rows } = await db.query(
      `SELECT id, slug, COALESCE(published_json, content_json) AS content_json
         FROM pages
        WHERE status = 'published' AND ${Number.isFinite(pageId) ? "id = $1" : "slug = $1"}
        LIMIT 1`,
      [Number.isFinite(pageId) ? pageId : slug],
    );
    const page = rows[0];
    const form = page ? findForm(page.content_json, formId) : null;
    if (!form)
      return res
        .status(404)
        .json({ ok: false, error: "This form is not available." });

    const values = isObj(body.values) ? body.values : {};
    const fields = (Array.isArray(form.fields) ? form.fields : []).filter(
      (f) => isObj(f) && f.id && FIELD_TYPES.has(f.type),
    );
    const data = {};
    const errors = {};
    for (const f of fields) {
      const key = String(f.id);
      const label = String(f.label || key).slice(0, 120);
      let v = values[key];
      if (f.type === "checkbox")
        v = v === true || v === "true" || v === "on" ? "Yes" : "";
      else
        v = String(v ?? "")
          .trim()
          .slice(0, MAX_LEN[f.type] || 200);
      if (
        f.type === "select" &&
        v &&
        !(Array.isArray(f.options) ? f.options.map(String) : []).includes(v)
      )
        v = "";
      if (f.required && !v) errors[key] = `${label} is required`;
      else if (v && f.type === "email" && !EMAIL_RE.test(v))
        errors[key] = "Enter a valid email address";
      else if (v && f.type === "phone" && !/^[0-9+().\-\s]{5,40}$/.test(v))
        errors[key] = "Enter a valid phone number";
      data[label] = v;
    }
    if (!fields.length)
      return res
        .status(400)
        .json({ ok: false, error: "This form has no fields." });
    if (Object.keys(errors).length)
      return res
        .status(400)
        .json({ ok: false, error: "Please check the form.", fields: errors });

    const title = String(form.title || "Form").slice(0, 120);
    await db.query(
      `INSERT INTO form_submissions (page_id, page_slug, form_id, form_title, data, ip_hash, user_agent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        page.id,
        page.slug,
        formId,
        title,
        JSON.stringify(data),
        ipHash,
        String(req.headers["user-agent"] || "").slice(0, 300),
      ],
    );

    // Optional notification to the address set on the form (never blocks the visitor).
    const to = String(form.notify_email || "").trim();
    if (EMAIL_RE.test(to)) {
      try {
        const { sendEmail } = require("../services/email");
        const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
        await sendEmail({
          to,
          subject: `New "${title}" submission`,
          text: `${lines.join("\n")}\n\nPage: /${page.slug}`,
          html: `<h2>${escapeHtml(title)}</h2><table>${Object.entries(data)
            .map(
              ([k, v]) =>
                `<tr><th align="left" style="padding:4px 12px 4px 0">${escapeHtml(k)}</th><td style="white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
            )
            .join("")}</table><p>Page: /${escapeHtml(page.slug)}</p>`,
        });
      } catch (e) {
        console.warn("[forms] notification email not sent:", e?.message || e);
      }
    }
    res.json({
      ok: true,
      message: String(
        form.success_message || "Thank you! Your message has been sent.",
      ).slice(0, 300),
    });
  } catch (e) {
    if (String(e?.code) === "42P01")
      return res
        .status(503)
        .json({
          ok: false,
          error: "Forms are not set up yet (run the 20261111_08 migration).",
        });
    console.error("[forms] submit failed:", e);
    res
      .status(500)
      .json({
        ok: false,
        error: "Your message could not be sent. Please try again.",
      });
  }
});

// ---- Admin inbox ----
router.get("/admin/submissions", inboxAccess, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const params = [];
    let where = "WHERE TRUE";
    if (req.query.form_id) {
      params.push(String(req.query.form_id));
      where += ` AND form_id = $${params.length}`;
    }
    if (req.query.unread === "1") where += " AND read_at IS NULL";
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT id, page_id, page_slug, form_id, form_title, data, created_at, read_at
         FROM form_submissions ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const { rows: c } = await db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread FROM form_submissions ${where}`,
      params.slice(0, -2),
    );
    res.json({
      ok: true,
      submissions: rows,
      total: c[0].total,
      unread: c[0].unread,
    });
  } catch (e) {
    if (String(e?.code) === "42P01")
      return res
        .status(503)
        .json({
          ok: false,
          error: "Forms are not set up yet (run the 20261111_08 migration).",
        });
    console.error("[forms] list failed:", e);
    res.status(500).json({ ok: false, error: "Unable to load submissions" });
  }
});

router.get("/admin/forms", inboxAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT form_id, MAX(form_title) AS form_title, MAX(page_slug) AS page_slug, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM form_submissions GROUP BY form_id ORDER BY MAX(created_at) DESC`,
    );
    res.json({ ok: true, forms: rows });
  } catch (e) {
    if (String(e?.code) === "42P01") return res.json({ ok: true, forms: [] });
    res.status(500).json({ ok: false, error: "Unable to load forms" });
  }
});

router.patch(
  "/admin/submissions/:id",
  inboxAccess,
  express.json(),
  async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, error: "Invalid id" });
    try {
      const { rows } = await db.query(
        `UPDATE form_submissions SET read_at = ${req.body?.read === false ? "NULL" : "COALESCE(read_at, NOW())"}
        WHERE id = $1 RETURNING id, read_at`,
        [id],
      );
      if (!rows.length)
        return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, submission: rows[0] });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Unable to update" });
    }
  },
);

router.delete("/admin/submissions/:id", inboxAccess, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id))
    return res.status(400).json({ ok: false, error: "Invalid id" });
  try {
    const { rowCount } = await db.query(
      "DELETE FROM form_submissions WHERE id = $1",
      [id],
    );
    if (!rowCount)
      return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to delete" });
  }
});

router.get("/admin/export.csv", inboxAccess, async (req, res) => {
  try {
    const params = [];
    let where = "";
    if (req.query.form_id) {
      params.push(String(req.query.form_id));
      where = "WHERE form_id = $1";
    }
    const { rows } = await db.query(
      `SELECT created_at, form_title, page_slug, data FROM form_submissions ${where} ORDER BY created_at DESC LIMIT 10000`,
      params,
    );
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.data || {})))];
    // Quote every cell; neutralize spreadsheet formulas (=, +, -, @).
    const cell = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [["Submitted", "Form", "Page", ...keys].map(cell).join(",")];
    for (const r of rows)
      lines.push(
        [
          new Date(r.created_at).toISOString(),
          r.form_title,
          `/${r.page_slug || ""}`,
          ...keys.map((k) => r.data?.[k] ?? ""),
        ]
          .map(cell)
          .join(","),
      );
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set(
      "Content-Disposition",
      'attachment; filename="form-submissions.csv"',
    );
    res.send(`\ufeff${lines.join("\r\n")}`);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to export" });
  }
});

router.findForm = findForm; // for tests
module.exports = router;
