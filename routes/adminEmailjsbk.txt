// server-api/routes/adminEmail.js
const express = require("express");
const router = express.Router();

const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { encryptJSON, decryptJSON } = require("../utils/crypto");

/**
 * Admin Email API
 * Mount: app.use("/api/admin/email", require("./routes/adminEmail"));
 *
 * Endpoints:
 * GET  /api/admin/email/connection
 * POST /api/admin/email/connect
 * POST /api/admin/email/disconnect
 * POST /api/admin/email/test
 * POST /api/admin/email/send
 * GET  /api/admin/email/jobs
 * GET  /api/admin/email/jobs/:id/items
 */

/* -------------------------------
   Helpers
-------------------------------- */
function cleanProvider(p) {
  return String(p || "")
    .trim()
    .toLowerCase();
}
function safeStr(v) {
  return (v ?? "").toString();
}
function cleanRegion(v) {
  const r = safeStr(v).trim().toLowerCase();
  if (r === "eu") return "eu";
  return "us";
}

/* -------------------------------
   GET active connection
-------------------------------- */
router.get("/connection", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, provider, is_active, created_at, updated_at
       FROM email_connections
       ORDER BY is_active DESC, updated_at DESC
       LIMIT 1`,
    );
    return res.json({ ok: true, connection: rows[0] || null });
  } catch (e) {
    console.error("[adminEmail] GET /connection error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to read connection" });
  }
});

/* -------------------------------
   CONNECT provider (store secrets encrypted)

   For Mailgun:
   body: {
     provider: "mailgun",
     secrets: {
       api_key, domain, region, from_email, from_name
       // (we also accept legacy keys: apiKey, fromEmail, fromName)
     }
   }
-------------------------------- */
router.post("/connect", requireAuth, requireAdmin, async (req, res) => {
  const provider = cleanProvider(req.body?.provider);
  const secrets = req.body?.secrets;

  if (!provider) {
    return res.status(400).json({ ok: false, error: "Missing provider" });
  }
  if (!secrets || typeof secrets !== "object") {
    return res.status(400).json({ ok: false, error: "Missing secrets" });
  }

  try {
    // Accept both new + legacy key names to avoid frontend breakage
    const apiKey =
      safeStr(secrets.api_key).trim() || safeStr(secrets.apiKey).trim();
    const domain = safeStr(secrets.domain).trim();
    const region = cleanRegion(secrets.region);
    const fromEmail =
      safeStr(secrets.from_email).trim() || safeStr(secrets.fromEmail).trim();
    const fromName =
      safeStr(secrets.from_name).trim() ||
      safeStr(secrets.fromName).trim() ||
      "Bishop Robertson TV";

    if (provider === "mailgun") {
      if (!apiKey) {
        return res.status(400).json({
          ok: false,
          error: "Missing secrets.api_key (Mailgun API key)",
        });
      }
      if (!domain) {
        return res.status(400).json({
          ok: false,
          error: "Missing secrets.domain (Mailgun domain)",
        });
      }
      if (!fromEmail) {
        return res
          .status(400)
          .json({ ok: false, error: "Missing secrets.from_email" });
      }
    }

    // Normalize the payload to EXACT names worker expects
    const payload = {
      api_key: apiKey,
      domain: domain || null,
      region,
      from_email: fromEmail,
      from_name: fromName,
    };

    const enc = encryptJSON(payload); // packed string: "iv:tag:ciphertext"

    // Enforce one active connection
    await db.query(
      `UPDATE email_connections SET is_active = FALSE, updated_at = NOW()`,
    );

    const ins = await db.query(
      `INSERT INTO email_connections (provider, secrets_enc, is_active, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       RETURNING id, provider, is_active, created_at, updated_at`,
      [provider, enc],
    );

    return res.json({ ok: true, connection: ins.rows[0] });
  } catch (e) {
    console.error("[adminEmail] POST /connect error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to connect provider" });
  }
});

/* -------------------------------
   DISCONNECT
-------------------------------- */
router.post("/disconnect", requireAuth, requireAdmin, async (_req, res) => {
  try {
    await db.query(
      `UPDATE email_connections
       SET is_active = FALSE, updated_at = NOW()
       WHERE is_active = TRUE`,
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[adminEmail] POST /disconnect error:", e);
    return res.status(500).json({ ok: false, error: "Failed to disconnect" });
  }
});

/* -------------------------------
   TEST (decrypt secrets; verify required fields)
-------------------------------- */
router.post("/test", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT provider, secrets_enc
       FROM email_connections
       WHERE is_active = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
    );

    if (!rows.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No active email provider" });
    }

    const provider = rows[0].provider;
    const secrets = decryptJSON(rows[0].secrets_enc);

    if (provider === "mailgun") {
      if (!secrets?.api_key) throw new Error("Mailgun api_key missing");
      if (!secrets?.domain) throw new Error("Mailgun domain missing");
      if (!secrets?.from_email) throw new Error("Mailgun from_email missing");
    }

    // Do NOT return secrets
    return res.json({ ok: true, provider });
  } catch (e) {
    console.error("[adminEmail] POST /test error:", e);
    return res.status(500).json({ ok: false, error: "Test failed" });
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
router.post("/send", requireAuth, requireAdmin, async (req, res) => {
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
    // Ensure provider exists + decryptable
    const conn = await db.query(
      `SELECT provider, secrets_enc
       FROM email_connections
       WHERE is_active = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
    );

    if (!conn.rows.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No active email provider" });
    }

    // Decrypt to fail early if key/format is wrong
    decryptJSON(conn.rows[0].secrets_enc);

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
    return res.json({ ok: true, jobId, queued: recipients.length });
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
router.get("/jobs", requireAuth, requireAdmin, async (req, res) => {
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
router.get("/jobs/:id/items", requireAuth, requireAdmin, async (req, res) => {
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

module.exports = router;
