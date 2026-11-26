// server-api/routes/adminEmail.js
const express = require("express");
const router = express.Router();

const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
// Phase 8-2: Email Center (send, job history) for Administrators and Marketing
// Managers; the connection settings (connect/disconnect/test) stay admin-only.
const { requireArea } = require("../lib/teamAccess");
const marketing = requireArea("marketing");
const { encryptJSON } = require("../utils/crypto");
const email = require("../services/emailTransport");

/**
 * Admin Email API
 * Mount: app.use("/api/admin/email", require("./routes/adminEmail"));
 *
 * Endpoints:
 * GET  /api/admin/email/connection   which account sends the site's emails
 * POST /api/admin/email/connect      save an account (any provider)
 * POST /api/admin/email/disconnect
 * POST /api/admin/email/test         really send a test email
 * POST /api/admin/email/send
 * GET  /api/admin/email/jobs
 * GET  /api/admin/email/jobs/:id/items
 */

/* -------------------------------
   Helpers
-------------------------------- */
function safeStr(v) {
  return (v ?? "").toString();
}

function encryptionReady() {
  try {
    encryptJSON({ t: 1 });
    return true;
  } catch {
    return false;
  }
}

const KEY_HELP =
  "The server is missing APP_ENCRYPTION_KEY, which keeps email passwords encrypted. Add it in Render › Environment (a 32-byte base64 value, e.g. from: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"), then save again.";

// What the admin page may see: never passwords or API keys.
function publicView(cfg) {
  if (!cfg) return null;
  const need = email.PROVIDERS[cfg.provider]?.secret;
  return {
    id: cfg.id || null,
    source: cfg.source, // "admin" | "server"
    provider: cfg.provider,
    provider_label: email.PROVIDERS[cfg.provider]?.label || cfg.provider,
    is_active: true,
    settings: cfg.settings || {},
    has_secret: need ? !!cfg.secrets?.[need] : false,
    status: cfg.status || {},
    warning: cfg.warning || null,
    updated_at: cfg.updated_at || null,
  };
}

function testEmailContent({ provider, from, siteName }) {
  const label = email.PROVIDERS[provider]?.label || provider;
  const when = new Date().toUTCString();
  const subject = `Test email from ${siteName}`;
  const text = `This is a test email from ${siteName}.\n\nIf you can read this, the site's emails are working.\n\nSent with: ${label}\nFrom: ${from}\nTime: ${when}`;
  const esc = (v) =>
    String(v).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3f7;font-family:Arial,Helvetica,sans-serif;color:#1d1726">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td><h1 style="margin:0 0 12px;font-size:22px">Emails are working</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">This is a test email from <strong>${esc(siteName)}</strong>. If you can read this, the site's emails are being delivered.</p>
<p style="margin:0;font-size:13px;line-height:1.6;color:#5b5466">Sent with: ${esc(label)}<br>From: ${esc(from)}<br>Time: ${esc(when)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/* -------------------------------
   GET which account sends the site's emails
-------------------------------- */
router.get("/connection", marketing, async (_req, res) => {
  try {
    let current = null;
    let error = null;
    try {
      current = await email.getEmailConfig({ fresh: true });
    } catch (e) {
      error = e.message;
    }
    const server = email.envConfig();
    return res.json({
      ok: true,
      // Kept for older screens: the saved admin connection, if any.
      connection:
        current && current.source === "admin"
          ? { ...publicView(current), created_at: null }
          : null,
      current: publicView(current),
      server_fallback: server
        ? {
            provider: server.provider,
            provider_label: email.PROVIDERS[server.provider]?.label,
            from_email: server.settings.from_email,
          }
        : null,
      error,
      encryption_ready: encryptionReady(),
      // Render's free plan blocks mail-server (SMTP) connections.
      host: process.env.RENDER ? "render" : "",
    });
  } catch (e) {
    console.error("[adminEmail] GET /connection error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to read connection" });
  }
});

/* -------------------------------
   SAVE an account (passwords/keys stored encrypted)
   body: {
     provider: "mailgun"|"sendgrid"|"postmark"|"brevo"|"resend"|
               "gmail"|"microsoft365"|"zoho"|"smtp",
     settings: { from_name, from_email, reply_to?, notify_to?,
                 domain?, region?, username?, zoho_region?, host?, port?, security? },
     secrets:  { api_key? | password? }   // blank = keep the saved one
   }
   (Older body { provider:"mailgun", secrets:{ api_key, domain, region,
   from_email, from_name } } is still accepted.)
-------------------------------- */
router.post("/connect", requireAuth, requireAdmin, async (req, res) => {
  let input;
  try {
    input = email.normalizeInput(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    if (!encryptionReady())
      return res.status(500).json({ ok: false, error: KEY_HELP });

    // Blank password/key: keep the saved one (same service only).
    const need = email.PROVIDERS[input.provider].secret;
    if (!input.secrets[need]) {
      const saved = await email
        .getEmailConfig({ fresh: true })
        .catch(() => null);
      if (saved?.source === "admin" && saved.provider === input.provider)
        input.secrets[need] = saved.secrets[need];
    }

    const problems = email.validateConfig(input);
    if (problems.length)
      return res
        .status(400)
        .json({ ok: false, error: problems.join(" "), problems });

    const enc = encryptJSON({ [need]: input.secrets[need] });

    await email.ensureEmailSchema();
    const secretsValue = await email.secretsColumnValue(enc);
    await db.query(
      `UPDATE email_connections SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE`,
    );
    const ins = await db.query(
      `INSERT INTO email_connections (provider, secrets_enc, settings, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW())
       RETURNING id, provider, is_active, created_at, updated_at`,
      [input.provider, secretsValue, JSON.stringify(input.settings)],
    );
    email.clearEmailConfigCache();
    const current = await email.getEmailConfig({ fresh: true });
    return res.json({
      ok: true,
      connection: ins.rows[0],
      current: publicView(current),
    });
  } catch (e) {
    console.error("[adminEmail] POST /connect error:", e);
    if (/APP_ENCRYPTION_KEY/.test(e?.message || ""))
      return res.status(500).json({ ok: false, error: KEY_HELP });
    return res
      .status(500)
      .json({ ok: false, error: "Failed to save the email account" });
  }
});

/* -------------------------------
   DISCONNECT (the server's .env account, if any, takes over)
-------------------------------- */
router.post("/disconnect", requireAuth, requireAdmin, async (_req, res) => {
  try {
    await email.ensureEmailSchema();
    await db.query(
      `UPDATE email_connections
       SET is_active = FALSE, updated_at = NOW()
       WHERE is_active = TRUE`,
    );
    email.clearEmailConfigCache();
    const current = await email
      .getEmailConfig({ fresh: true })
      .catch(() => null);
    return res.json({ ok: true, current: publicView(current) });
  } catch (e) {
    console.error("[adminEmail] POST /disconnect error:", e);
    return res.status(500).json({ ok: false, error: "Failed to disconnect" });
  }
});

/* -------------------------------
   TEST: really sends an email.
   body: { to? }                       → the account in use now
   body: { to?, provider, settings, secrets } → the form's values, before
         saving (a blank password/key uses the saved one)
-------------------------------- */
router.post("/test", requireAuth, requireAdmin, async (req, res) => {
  const to = safeStr(req.body?.to || req.user?.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
    return res
      .status(400)
      .json({ ok: false, error: "Enter the address to send the test to." });

  let cfg;
  let fromForm = false;
  try {
    if (req.body?.provider) {
      fromForm = true;
      const input = email.normalizeInput(req.body);
      const need = email.PROVIDERS[input.provider].secret;
      if (!input.secrets[need]) {
        const saved = await email
          .getEmailConfig({ fresh: true })
          .catch(() => null);
        if (saved?.source === "admin" && saved.provider === input.provider)
          input.secrets[need] = saved.secrets[need];
      }
      const problems = email.validateConfig(input);
      if (problems.length)
        return res
          .status(400)
          .json({ ok: false, error: problems.join(" "), problems });
      cfg = { source: "test", id: null, ...input };
    } else {
      cfg = await email.getEmailConfig({ fresh: true });
      if (!cfg)
        return res.status(400).json({
          ok: false,
          error: "No email account is connected yet.",
        });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const siteName = process.env.SITE_NAME || "BishopRobertson.TV";
  const content = testEmailContent({
    provider: cfg.provider,
    from: cfg.settings.from_email,
    siteName,
  });
  let ok = false;
  try {
    await email.sendMail(
      { to, ...content },
      { config: cfg, record: !fromForm },
    );
    ok = true;
    return res.json({
      ok: true,
      message: `Test email sent to ${to} with ${email.PROVIDERS[cfg.provider]?.label || cfg.provider}. Check the inbox — and the Spam folder, the first time.`,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
      code: e.code || "send_failed",
      detail: e.detail || "",
    });
  } finally {
    if (!fromForm && cfg?.id) {
      db.query(
        "UPDATE email_connections SET last_test_at = NOW(), last_test_ok = $2 WHERE id = $1",
        [cfg.id, ok],
      ).catch(() => {});
      email.clearEmailConfigCache();
    }
  }
});

/* -------------------------------
   SEND (creates job + queued items only)
   body: {
     subject,
     html?,
     text?,
     audience: { type: "all"|"ids", ids?: number[] },
     attachments?: [{name,url,mime,size}]  // optional
   }
-------------------------------- */
router.post("/send", marketing, async (req, res) => {
  const subject = safeStr(req.body?.subject).trim();
  const html = safeStr(req.body?.html).trim();
  const text = safeStr(req.body?.text).trim();
  const audience = req.body?.audience || { type: "all" };
  const attachments = Array.isArray(req.body?.attachments)
    ? req.body.attachments
    : [];

  if (!subject) {
    return res.status(400).json({ ok: false, error: "Missing subject" });
  }
  if (!html && !text) {
    return res.status(400).json({ ok: false, error: "Provide html or text" });
  }

  try {
    // An email account must be connected (saved in Email Integration, or
    // the server's .env settings).
    let account = null;
    try {
      account = await email.getEmailConfig({ fresh: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (!account) {
      return res.status(400).json({
        ok: false,
        error:
          "No email account is connected. Connect one in Integrations › Email first.",
      });
    }

    // Recipients (v1 uses users table)
    const type = safeStr(audience?.type || "all")
      .trim()
      .toLowerCase();
    let recipients = [];

    if (type === "ids") {
      const ids = Array.isArray(audience?.ids)
        ? audience.ids.map((x) => Number(x)).filter(Number.isFinite)
        : [];
      if (!ids.length) {
        return res.status(400).json({ ok: false, error: "No ids provided" });
      }

      const r = await db.query(
        `SELECT id, email
         FROM users
         WHERE id = ANY($1::int[])
           AND email IS NOT NULL AND email <> ''`,
        [ids],
      );
      recipients = r.rows;
    } else {
      const r = await db.query(
        `SELECT id, email
         FROM users
         WHERE email IS NOT NULL AND email <> ''
         ORDER BY id DESC
         LIMIT 5000`,
      );
      recipients = r.rows;
    }

    // Leave out people who unsubscribed (preferences page / unsubscribe link).
    let skippedUnsubscribed = 0;
    try {
      const T = require("../services/emailTemplates");
      await T.ensureSchema();
      const { rows: offRows } = await db.query(
        `SELECT email FROM email_preferences
          WHERE unsubscribed_all = TRUE OR (lists->>'news') = 'false'`,
      );
      const off = new Set(offRows.map((r) => String(r.email).toLowerCase()));
      const before = recipients.length;
      recipients = recipients.filter(
        (u) => !off.has(String(u.email).toLowerCase()),
      );
      skippedUnsubscribed = before - recipients.length;
    } catch (e) {
      console.warn("[adminEmail] unsubscribe filter skipped:", e?.message || e);
    }
    if (!recipients.length) {
      return res.status(400).json({
        ok: false,
        error: skippedUnsubscribed
          ? "Everyone in this audience has unsubscribed from news emails."
          : "No recipients found.",
      });
    }

    // Create job (try to store attachments if column exists)
    let jobId;

    try {
      const job = await db.query(
        `INSERT INTO email_jobs
          (created_by, subject, body_html, body_text, audience, attachments, status, created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'queued', NOW(), NOW())
         RETURNING id`,
        [
          req.user?.id || null,
          subject,
          html || null,
          text || null,
          JSON.stringify({ type, count: recipients.length }),
          JSON.stringify(attachments),
        ],
      );
      jobId = job.rows[0].id;
    } catch (_e) {
      // attachments column probably doesn't exist yet
      const job = await db.query(
        `INSERT INTO email_jobs
          (created_by, subject, body_html, body_text, audience, status, created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5::jsonb, 'queued', NOW(), NOW())
         RETURNING id`,
        [
          req.user?.id || null,
          subject,
          html || null,
          text || null,
          JSON.stringify({ type, count: recipients.length }),
        ],
      );
      jobId = job.rows[0].id;
    }

    // Bulk insert items
    if (recipients.length) {
      const values = [];
      const params = [];
      let p = 1;

      for (const u of recipients) {
        values.push(`($${p++}, $${p++}, $${p++}, 'queued', NOW(), NOW())`);
        params.push(jobId, u.id, u.email);
      }

      await db.query(
        `INSERT INTO email_job_items
          (job_id, user_id, email, status, created_at, updated_at)
         VALUES ${values.join(",")}`,
        params,
      );
    }

    // Worker will send + update items -> sent/failed and job status
    return res.json({
      ok: true,
      jobId,
      queued: recipients.length,
      skipped_unsubscribed: skippedUnsubscribed,
    });
  } catch (e) {
    console.error("[adminEmail] POST /send error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to create send job" });
  }
});

/* -------------------------------
   LIST jobs
-------------------------------- */
router.get("/jobs", marketing, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const { rows } = await db.query(
      `SELECT id, created_by, subject, audience, status, created_at, updated_at
       FROM email_jobs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[adminEmail] GET /jobs error:", e);
    return res.status(500).json({ ok: false, error: "Failed to list jobs" });
  }
});

/* -------------------------------
   LIST job items
-------------------------------- */
router.get("/jobs/:id/items", marketing, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ ok: false, error: "Invalid job id" });
  }

  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const { rows } = await db.query(
      `SELECT id, user_id, email, status, error, sent_at, created_at, updated_at
       FROM email_job_items
       WHERE job_id = $1
       ORDER BY id ASC
       LIMIT $2 OFFSET $3`,
      [jobId, limit, offset],
    );
    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[adminEmail] GET /jobs/:id/items error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to list job items" });
  }
});

/* -------------------------------
   DELETE job + items
   DELETE /api/admin/email/jobs/:id
   Optional: ?force=1 to delete even if queued/sending
-------------------------------- */
router.delete("/jobs/:id", marketing, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ ok: false, error: "Invalid job id" });
  }

  const force = String(req.query.force || "").trim() === "1";

  try {
    // Ensure job exists + check status
    const jobRes = await db.query(
      `SELECT id, status
       FROM email_jobs
       WHERE id = $1
       LIMIT 1`,
      [jobId],
    );

    if (!jobRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    const status = safeStr(jobRes.rows[0].status).toLowerCase();

    // If job is still queued/sending, block unless force=1
    // (You may only use "queued/sent/failed" today, but this covers future statuses too.)
    const isInProgress = status === "queued" || status === "sending";
    if (isInProgress && !force) {
      return res.status(409).json({
        ok: false,
        error:
          "Job is still in progress. Wait until it finishes, or force delete.",
      });
    }

    // Transaction: delete children then parent
    await db.query("BEGIN");

    await db.query(`DELETE FROM email_job_items WHERE job_id = $1`, [jobId]);
    await db.query(`DELETE FROM email_jobs WHERE id = $1`, [jobId]);

    await db.query("COMMIT");

    return res.json({ ok: true, deleted: true, jobId });
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch (_e2) {}
    console.error("[adminEmail] DELETE /jobs/:id error:", e);
    return res.status(500).json({ ok: false, error: "Failed to delete job" });
  }
});

module.exports = router;
