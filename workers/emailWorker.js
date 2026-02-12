// server-api/workers/emailWorker.js

const path = require("path");

// 🔑 IMPORTANT: load ROOT .env (not workers/.env)
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

// ✅ FIXED PATHS (workers → root)
const db = require("../db");
const { decryptJSON } = require("../utils/crypto");

const WORKER_NAME = "emailWorker";
const POLL_MS = Number(process.env.EMAIL_WORKER_POLL_MS || 2500);
const BATCH_SIZE = Math.min(
  Number(process.env.EMAIL_WORKER_BATCH_SIZE || 25),
  100,
);

/* -------------------------------------------------- */
/* logging helpers                                    */
/* -------------------------------------------------- */
function log(...args) {
  console.log(`[${WORKER_NAME}]`, ...args);
}
function errlog(...args) {
  console.error(`[${WORKER_NAME}]`, ...args);
}
function safeStr(v) {
  return (v ?? "").toString();
}
function normalizeProvider(p) {
  return safeStr(p).trim().toLowerCase();
}

/* -------------------------------------------------- */
/* secrets helpers                                    */
/* -------------------------------------------------- */
function getSecret(secrets, camelKey, snakeKey) {
  if (!secrets || typeof secrets !== "object") return "";
  return safeStr(secrets[camelKey] || secrets[snakeKey]).trim();
}

/* -------------------------------------------------- */
/* uploads helper (workers → root/uploads)            */
/* -------------------------------------------------- */
function parseUploadsPathFromUrl(url) {
  if (!url) return null;

  let pathname = url;
  try {
    if (/^https?:\/\//i.test(url)) {
      pathname = new URL(url).pathname;
    }
  } catch {}

  if (!pathname.startsWith("/uploads/")) return null;

  // workers → ../uploads
  const abs = path.join(__dirname, "..", pathname);
  const uploadsRoot = path.join(__dirname, "..", "uploads") + path.sep;

  const norm = path.normalize(abs);
  if (!norm.startsWith(uploadsRoot)) return null;

  return norm;
}

/* -------------------------------------------------- */
/* active provider                                    */
/* -------------------------------------------------- */
async function getActiveEmailConnection() {
  try {
    const r = await db.query(
      `SELECT provider, secrets_enc
       FROM email_connections
       WHERE is_active = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
    );

    if (r.rows.length) {
      return {
        provider: normalizeProvider(r.rows[0].provider),
        secrets: decryptJSON(r.rows[0].secrets_enc),
        source: "db",
      };
    }
  } catch (e) {
    errlog("getActiveEmailConnection:", e.message);
  }

  // ENV fallback (Mailgun only)
  if (
    process.env.MAILGUN_API_KEY &&
    process.env.MAILGUN_DOMAIN &&
    process.env.MAILGUN_FROM_EMAIL
  ) {
    return {
      provider: "mailgun",
      source: "env",
      secrets: {
        apiKey: process.env.MAILGUN_API_KEY,
        domain: process.env.MAILGUN_DOMAIN,
        fromEmail: process.env.MAILGUN_FROM_EMAIL,
        fromName: process.env.MAILGUN_FROM_NAME || "Bishop Robertson TV",
        region: process.env.MAILGUN_REGION || "us",
      },
    };
  }

  return null;
}

/* -------------------------------------------------- */
/* Mailgun sender                                     */
/* -------------------------------------------------- */
function mailgunBaseUrl(region = "us") {
  return region === "eu"
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";
}

async function sendViaMailgun({
  secrets,
  to,
  subject,
  text,
  html,
  attachments,
}) {
  const apiKey = getSecret(secrets, "apiKey", "api_key");
  const domain = getSecret(secrets, "domain", "domain");
  const fromEmail = getSecret(secrets, "fromEmail", "from_email");
  const fromName =
    getSecret(secrets, "fromName", "from_name") || "Bishop Robertson TV";
  const region = getSecret(secrets, "region", "region") || "us";

  if (!apiKey || !domain || !fromEmail) {
    throw new Error("Mailgun config incomplete");
  }

  const form = new FormData();
  form.append("from", `${fromName} <${fromEmail}>`);
  form.append("to", to);
  form.append("subject", subject || "");
  if (text) form.append("text", text);
  if (html) form.append("html", html);

  for (const a of attachments || []) {
    const filePath = parseUploadsPathFromUrl(a?.url);
    if (filePath && fs.existsSync(filePath)) {
      form.append(
        "attachment",
        fs.createReadStream(filePath),
        a?.name || path.basename(filePath),
      );
    }
  }

  const url = `${mailgunBaseUrl(region)}/v3/${domain}/messages`;

  await axios.post(url, form, {
    auth: { username: "api", password: apiKey },
    headers: form.getHeaders(),
    timeout: 30000,
  });
}

/* -------------------------------------------------- */
/* DB helpers                                         */
/* -------------------------------------------------- */
async function claimQueuedItems(client) {
  const r = await client.query(
    `WITH picked AS (
        SELECT id
        FROM email_job_items
        WHERE status = 'queued'
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE email_job_items it
     SET status='sending', updated_at=NOW()
     FROM picked
     WHERE it.id = picked.id
     RETURNING it.*`,
    [BATCH_SIZE],
  );

  return r.rows;
}

async function updateJobStatus(jobId) {
  await db.query(
    `UPDATE email_jobs
     SET status = (
       SELECT CASE
         WHEN COUNT(*) FILTER (WHERE status='sending') > 0 THEN 'sending'
         WHEN COUNT(*) FILTER (WHERE status='queued')  > 0 THEN 'queued'
         WHEN COUNT(*) FILTER (WHERE status='failed')  > 0 THEN 'failed'
         ELSE 'sent'
       END
       FROM email_job_items
       WHERE job_id=$1
     ),
     updated_at=NOW()
     WHERE id=$1`,
    [jobId],
  );
}

/* -------------------------------------------------- */
/* worker loop                                        */
/* -------------------------------------------------- */
async function processOnce() {
  const conn = await getActiveEmailConnection();
  if (!conn) {
    log("No active email provider");
    return;
  }

  if (conn.provider !== "mailgun") {
    log(`Provider ${conn.provider} not supported yet`);
    return;
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const items = await claimQueuedItems(client);
    await client.query("COMMIT");

    log(`Claimed ${items.length} item(s)`);

    for (const it of items) {
      try {
        await sendViaMailgun({
          secrets: conn.secrets,
          to: it.email,
          subject: it.subject,
          text: it.body_text,
          html: it.body_html,
          attachments: [],
        });

        await db.query(
          `UPDATE email_job_items
           SET status='sent', sent_at=NOW()
           WHERE id=$1`,
          [it.id],
        );
      } catch (e) {
        await db.query(
          `UPDATE email_job_items
           SET status='failed', error=$2
           WHERE id=$1`,
          [it.id, e.message],
        );
      }

      await updateJobStatus(it.job_id);
    }
  } catch (e) {
    await client.query("ROLLBACK");
    errlog("processOnce:", e.message);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------- */
/* boot                                               */
/* -------------------------------------------------- */
(async function main() {
  log(`Starting worker (poll=${POLL_MS}ms)`);

  while (true) {
    await processOnce();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
