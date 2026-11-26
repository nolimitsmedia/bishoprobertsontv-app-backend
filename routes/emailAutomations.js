// server-api/routes/emailAutomations.js
// Admin › Email › Automations. Mount: app.use("/api/admin/email/automations", …)
//
// GET  /                 every automated email: on/off, wording, fill-ins, 30-day counts
// PUT  /settings         footer (mailing address, note)
// GET  /log              sent-emails log (?key= &status= &q= &limit= &offset=)
// PUT  /:key             { enabled?, subject?, heading?, body?, button?, reset? }
// POST /:key/preview     { subject?, heading?, body?, button? } → { subject, html, text }
// POST /:key/test        { to?, …draft } → sends the preview to you
// For Administrators and Marketing Managers (same as the Email Center).

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireArea } = require("../lib/teamAccess");
const T = require("../services/emailTemplates");
const transport = require("../services/emailTransport");

router.use(requireArea("marketing"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get("/", async (_req, res) => {
  try {
    await T.ensureSchema();
    const [templates, settings, brand] = await Promise.all([
      T.listTemplates(),
      T.getSettings(),
      T.getBrand(),
    ]);
    const { rows } = await db.query(
      `SELECT template_key, status, COUNT(*)::int AS n
         FROM email_send_log
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY template_key, status`,
    );
    const stats = {};
    for (const r of rows) {
      stats[r.template_key] = stats[r.template_key] || {
        sent: 0,
        failed: 0,
        skipped: 0,
      };
      stats[r.template_key][r.status] = r.n;
    }
    res.json({
      ok: true,
      templates: templates.map((t) => ({
        key: t.key,
        name: t.name,
        category: t.category,
        list: t.list || null,
        when: t.when,
        enabled: t.enabled,
        can_turn_off: t.category !== "essential",
        subject: t.subject,
        heading: t.heading,
        body: t.body,
        button: t.button,
        has_button: !!t.action,
        customized: t.customized,
        fields: t.fields.map((f) => ({
          key: f,
          label: T.FIELD_LABELS[f] || f,
        })),
        defaults: (() => {
          const d = T.CATALOG.find((c) => c.key === t.key);
          return {
            subject: d.subject,
            heading: d.heading,
            body: d.body,
            button: d.button,
          };
        })(),
        stats: stats[t.key] || { sent: 0, failed: 0, skipped: 0 },
      })),
      settings,
      brand,
      site_url: T.siteUrl(),
    });
  } catch (e) {
    console.error("[emailAutomations] GET error:", e);
    res
      .status(500)
      .json({ ok: false, error: "Could not load the automated emails." });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const settings = await T.saveSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (e) {
    console.error("[emailAutomations] settings error:", e);
    res.status(500).json({ ok: false, error: "Could not save." });
  }
});

router.get("/log", async (req, res) => {
  try {
    await T.ensureSchema();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = [];
    const args = [];
    if (req.query.key) {
      args.push(String(req.query.key));
      where.push(`template_key = $${args.length}`);
    }
    if (["sent", "failed", "skipped"].includes(String(req.query.status))) {
      args.push(String(req.query.status));
      where.push(`status = $${args.length}`);
    }
    if (req.query.q) {
      args.push(`%${String(req.query.q).toLowerCase().slice(0, 100)}%`);
      where.push(`email LIKE $${args.length}`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      await db.query(`SELECT COUNT(*)::int AS n FROM email_send_log ${w}`, args)
    ).rows[0].n;
    args.push(limit, offset);
    const { rows } = await db.query(
      `SELECT id, template_key, email, subject, status, detail, provider, created_at
         FROM email_send_log ${w}
        ORDER BY created_at DESC, id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    res.json({ ok: true, total, items: rows });
  } catch (e) {
    console.error("[emailAutomations] log error:", e);
    res.status(500).json({ ok: false, error: "Could not load the log." });
  }
});

function knownKey(req, res) {
  if (!T.CATALOG.some((t) => t.key === req.params.key)) {
    res.status(404).json({ ok: false, error: "Unknown email." });
    return false;
  }
  return true;
}

router.put("/:key", async (req, res) => {
  if (!knownKey(req, res)) return;
  try {
    const t = await T.saveTemplate(
      req.params.key,
      req.body || {},
      req.user?.id,
    );
    res.json({
      ok: true,
      template: {
        key: t.key,
        enabled: t.enabled,
        subject: t.subject,
        heading: t.heading,
        body: t.body,
        button: t.button,
        customized: t.customized,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Could not save." });
  }
});

router.post("/:key/preview", async (req, res) => {
  if (!knownKey(req, res)) return;
  try {
    const out = await T.previewTemplate(req.params.key, req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: e.message || "Could not preview." });
  }
});

router.post("/:key/test", async (req, res) => {
  if (!knownKey(req, res)) return;
  const to = String(req.body?.to || req.user?.email || "").trim();
  if (!EMAIL_RE.test(to))
    return res
      .status(400)
      .json({ ok: false, error: "Enter the address to send the test to." });
  try {
    const out = await T.previewTemplate(req.params.key, req.body || {});
    await transport.sendMail({
      to,
      subject: `[Test] ${out.subject}`,
      html: out.html,
      text: out.text,
    });
    res.json({
      ok: true,
      message: `Test sent to ${to}, with sample details filled in.`,
    });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: e.message || "The test could not be sent." });
  }
});

module.exports = router;
