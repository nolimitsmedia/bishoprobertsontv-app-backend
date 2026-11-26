// server-api/workers/emailWorker.js
const path = require("path");

// Only load dotenv when running this file directly
if (require.main === module) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
}

const fs = require("fs");

// Allow injected db when run from server.js
const defaultDb = require("../db");

// Sends through the account connected in Admin › Integrations › Email (any
// provider), or the server's .env settings.
const { getEmailConfig, sendMail } = require("../services/emailTransport");
const T = require("../services/emailTemplates");

// Every campaign email gets an unsubscribe link (footer + inbox button).
async function unsubscribeParts(to) {
  try {
    const p = await T.prefsFor(to);
    if (!p) return null;
    if (!T.wants(p, "news")) return { skip: true };
    const url = T.oneClickLink(p.token, "news");
    const prefs = T.preferencesLink(p.token);
    const headers = { "List-Unsubscribe": `<${url}>` };
    if (/\/api\/email-preferences\/unsubscribe/.test(url))
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    const esc = (v) =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    return {
      headers,
      html: `<p style="margin:24px 0 0;font:12px/1.6 Arial,sans-serif;color:#6b6475;text-align:center"><a href="${esc(prefs)}" style="color:#6b6475">Email preferences</a> &nbsp;·&nbsp; <a href="${esc(url)}" style="color:#6b6475">Unsubscribe</a></p>`,
      text: `\n\n—\nEmail preferences: ${prefs}\nUnsubscribe: ${url}`,
    };
  } catch {
    return null;
  }
}

function withFooter(html, footer) {
  if (!html) return html;
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${footer}</body>`)
    : html + footer;
}

const WORKER_NAME = "emailWorker";

// Logging controls
const VERBOSE =
  String(process.env.EMAIL_WORKER_VERBOSE || "").toLowerCase() === "1" ||
  String(process.env.EMAIL_WORKER_VERBOSE || "").toLowerCase() === "true";

function log(...args) {
  if (VERBOSE) console.log(`[${WORKER_NAME}]`, ...args);
}
function info(...args) {
  console.log(`[${WORKER_NAME}]`, ...args);
}
function errlog(...args) {
  console.error(`[${WORKER_NAME}]`, ...args);
}

function safeStr(v) {
  return (v ?? "").toString();
}

function parseUploadsPathFromUrl(url) {
  if (!url) return null;

  let pathname = url;
  try {
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      pathname = u.pathname;
    }
  } catch {}

  if (!pathname.startsWith("/uploads/")) return null;

  const rel = pathname.replace(/^\/+/, "");
  const abs = path.join(__dirname, "..", rel);

  const uploadsRoot = path.join(__dirname, "..", "uploads") + path.sep;
  const absNorm = path.normalize(abs);
  if (!absNorm.startsWith(uploadsRoot)) return null;

  return absNorm;
}

async function updateJobStatus(db, jobId) {
  const r = await db.query(
    `SELECT
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending,
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM email_job_items
     WHERE job_id = $1`,
    [jobId],
  );

  const s = r.rows?.[0] || {};
  const queued = Number(s.queued || 0);
  const sending = Number(s.sending || 0);
  const sent = Number(s.sent || 0);
  const failed = Number(s.failed || 0);

  let status = "queued";
  if (queued > 0 || sending > 0) status = "queued";
  else if (failed > 0) status = "failed";
  else if (sent > 0 && failed === 0) status = "sent";

  await db.query(
    `UPDATE email_jobs
     SET status = $2, updated_at = NOW()
     WHERE id = $1`,
    [jobId, status],
  );
}

async function claimQueuedItems(client, batchSize) {
  const r = await client.query(
    `WITH picked AS (
        SELECT id
        FROM email_job_items
        WHERE status = 'queued'
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE email_job_items it
     SET status = 'sending', updated_at = NOW()
     FROM picked
     WHERE it.id = picked.id
     RETURNING it.id, it.job_id, it.user_id, it.email`,
    [batchSize],
  );
  return r.rows || [];
}

async function getJobPayload(db, jobId) {
  try {
    const r = await db.query(
      `SELECT id, subject, body_html, body_text, audience, attachments
       FROM email_jobs
       WHERE id = $1
       LIMIT 1`,
      [jobId],
    );
    return r.rows?.[0] || null;
  } catch {
    const r = await db.query(
      `SELECT id, subject, body_html, body_text, audience
       FROM email_jobs
       WHERE id = $1
       LIMIT 1`,
      [jobId],
    );
    return r.rows?.[0] || null;
  }
}

function normalizeAttachments(job) {
  const a1 = job?.attachments;
  if (Array.isArray(a1)) return a1;
  const a2 = job?.audience?.attachments;
  if (Array.isArray(a2)) return a2;
  return [];
}

let lastConnFingerprint = "";
let pausedUntil = 0;

// Problems with the email ACCOUNT (wrong password, blocked server, unverified
// sender...) would fail every remaining email the same way. Instead of marking
// a whole campaign failed, those emails go back in the queue and sending
// pauses for a minute, so the campaign continues once the account is fixed.
const ACCOUNT_PROBLEMS = new Set([
  "auth",
  "unreachable",
  "config",
  "sender",
  "decrypt_failed",
  "not_configured",
  "rate_limit",
]);
const PAUSE_MS = 60 * 1000;

function fingerprintConn(conn) {
  if (!conn) return "";
  return `${conn.source}|${conn.provider}|${conn.settings?.from_email || ""}`;
}

// Read the job's files once per job (not once per recipient).
function loadAttachments(job) {
  const out = [];
  for (const a of normalizeAttachments(job).slice(0, 8)) {
    const filePath = parseUploadsPathFromUrl(a?.url);
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      out.push({
        filename: a?.name || path.basename(filePath),
        content: fs.readFileSync(filePath),
        contentType: a?.mime || undefined,
      });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

async function requeue(db, ids) {
  if (!ids.length) return;
  await db.query(
    `UPDATE email_job_items
     SET status='queued', updated_at=NOW()
     WHERE id = ANY($1::bigint[]) AND status='sending'`,
    [ids],
  );
}

async function processOnce(db, batchSize) {
  if (Date.now() < pausedUntil) return;

  let conn = null;
  try {
    conn = await getEmailConfig();
  } catch (e) {
    log("Email account can't be used:", e?.message || e);
    return;
  }
  if (!conn) {
    log(
      "No email account connected (Admin › Integrations › Email) and no MAILGUN_/SMTP_ settings in .env.",
    );
    return;
  }

  const fp = fingerprintConn(conn);
  if (VERBOSE || fp !== lastConnFingerprint) {
    info(
      `Sending with ${conn.provider} from="${conn.settings?.from_email || ""}" (${conn.source === "admin" ? "Email Integration" : "server .env"})`,
    );
    lastConnFingerprint = fp;
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const items = await claimQueuedItems(client, batchSize);
    await client.query("COMMIT");

    if (!items.length) return;
    info(`Claimed ${items.length} item(s)`);

    const byJob = new Map();
    for (const it of items) {
      const jobId = Number(it.job_id);
      if (!byJob.has(jobId)) byJob.set(jobId, []);
      byJob.get(jobId).push(it);
    }

    const pending = new Set(items.map((it) => it.id));
    let accountProblem = null;

    for (const [jobId, jobItems] of byJob.entries()) {
      if (accountProblem) break;
      const job = await getJobPayload(db, jobId);
      if (!job) {
        for (const it of jobItems) {
          await db.query(
            `UPDATE email_job_items
             SET status='failed', error=$2, updated_at=NOW()
             WHERE id=$1`,
            [it.id, "Job not found"],
          );
          pending.delete(it.id);
        }
        await updateJobStatus(db, jobId);
        continue;
      }

      const attachments = loadAttachments(job);

      for (const it of jobItems) {
        if (accountProblem) break;
        const to = safeStr(it.email).trim();
        if (!to) {
          await db.query(
            `UPDATE email_job_items
             SET status='failed', error=$2, updated_at=NOW()
             WHERE id=$1`,
            [it.id, "Recipient email missing"],
          );
          pending.delete(it.id);
          continue;
        }

        const unsub = await unsubscribeParts(to);
        if (unsub?.skip) {
          // Unsubscribed after the campaign was created.
          await db.query(
            `UPDATE email_job_items
             SET status='failed', error='Not sent: unsubscribed', updated_at=NOW()
             WHERE id=$1`,
            [it.id],
          );
          pending.delete(it.id);
          continue;
        }
        try {
          const bodyText = safeStr(job.body_text);
          const bodyHtml = safeStr(job.body_html);
          await sendMail({
            to,
            subject: safeStr(job.subject),
            text: bodyText ? bodyText + (unsub ? unsub.text : "") : bodyText,
            html:
              bodyHtml && unsub ? withFooter(bodyHtml, unsub.html) : bodyHtml,
            attachments,
            headers: unsub?.headers,
          });

          await db.query(
            `UPDATE email_job_items
             SET status='sent', error=NULL, sent_at=NOW(), updated_at=NOW()
             WHERE id=$1`,
            [it.id],
          );
          pending.delete(it.id);
        } catch (e) {
          const msg = safeStr(e?.message || "Send failed");
          if (ACCOUNT_PROBLEMS.has(e?.code)) {
            accountProblem = msg;
            break;
          }
          errlog("Send failed:", msg);
          await db.query(
            `UPDATE email_job_items
             SET status='failed', error=$2, updated_at=NOW()
             WHERE id=$1`,
            [it.id, msg.slice(0, 1000)],
          );
          pending.delete(it.id);
        }
      }

      await updateJobStatus(db, jobId);
    }

    if (accountProblem) {
      await requeue(db, [...pending]);
      for (const jobId of byJob.keys()) await updateJobStatus(db, jobId);
      pausedUntil = Date.now() + PAUSE_MS;
      errlog(
        `Paused 60s — email account problem, ${pending.size} email(s) put back in the queue: ${accountProblem}`,
      );
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    errlog("processOnce error:", e?.message || e);
  } finally {
    client.release();
  }
}

async function startEmailWorker(dbInjected, opts = {}) {
  const db = dbInjected || defaultDb;

  const pollMs = Number(
    opts.intervalMs || process.env.EMAIL_WORKER_POLL_MS || 2500,
  );
  const batchSize = Math.min(
    Number(opts.batchSize || process.env.EMAIL_WORKER_BATCH_SIZE || 25),
    100,
  );

  info(
    `Starting worker (poll=${pollMs}ms batch=${batchSize} verbose=${VERBOSE ? "on" : "off"})`,
  );

  if (!db?.pool?.connect) {
    errlog("DB pool missing. Check server-api/db.js exports.");
    process.exit(1);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processOnce(db, batchSize);
    } catch (e) {
      errlog("loop error:", e?.message || e);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

module.exports = { startEmailWorker, processOnce };

if (require.main === module) {
  startEmailWorker(defaultDb, {});
}
