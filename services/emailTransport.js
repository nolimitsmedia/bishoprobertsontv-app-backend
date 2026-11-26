// server-api/services/emailTransport.js
//
// ONE place that sends every email the site sends (welcome, password reset,
// receipts, live reminders, form notifications, Email Center campaigns...).
//
// Which account sends them:
//   1. The connection saved in Admin › Email Integration (email_connections),
//   2. otherwise the server's own settings (MAILGUN_* or SMTP_* in .env),
//   3. otherwise nothing: callers get a clear "no email account" error.
//
// Providers
//   Send over the web (HTTPS) — work on every host, including Render's free plan:
//     mailgun, sendgrid, postmark, brevo, resend
//   Send through a mail server (SMTP ports 465/587) — Render's FREE plan blocks
//   these ports; paid Render plans allow them:
//     gmail, microsoft365, zoho, smtp (any other host)
//
// Passwords and API keys are stored encrypted (utils/crypto, APP_ENCRYPTION_KEY)
// and never returned to the browser.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const nodemailer = require("nodemailer");
const db = require("../db");
const { decryptJSON } = require("../utils/crypto");

/* ───────────────────────── providers ───────────────────────── */

const PROVIDERS = {
  mailgun: { label: "Mailgun", kind: "api", secret: "api_key" },
  sendgrid: { label: "SendGrid", kind: "api", secret: "api_key" },
  postmark: { label: "Postmark", kind: "api", secret: "api_key" },
  brevo: { label: "Brevo", kind: "api", secret: "api_key" },
  resend: { label: "Resend", kind: "api", secret: "api_key" },
  gmail: {
    label: "Gmail / Google Workspace",
    kind: "smtp",
    secret: "password",
  },
  microsoft365: { label: "Microsoft 365", kind: "smtp", secret: "password" },
  zoho: { label: "Zoho Mail", kind: "smtp", secret: "password" },
  smtp: { label: "Other email host (SMTP)", kind: "smtp", secret: "password" },
};

const ZOHO_HOSTS = {
  com: "smtp.zoho.com",
  eu: "smtp.zoho.eu",
  in: "smtp.zoho.in",
  au: "smtp.zoho.com.au",
  jp: "smtp.zoho.jp",
  ca: "smtp.zohocloud.ca",
};

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const s = (v) => (v == null ? "" : String(v)).trim();

function providerLabel(p) {
  return PROVIDERS[p]?.label || p || "Email";
}

class EmailError extends Error {
  constructor(
    message,
    { code = "send_failed", provider = "", detail = "" } = {},
  ) {
    super(message);
    this.name = "EmailError";
    this.code = code;
    this.provider = provider;
    this.detail = String(detail || "").slice(0, 600);
  }
}

/* ───────────────────────── schema ───────────────────────── */

let schemaReady = null;
let secretsIsJson = true;

// Value to write into email_connections.secrets_enc for an encrypted string.
async function secretsColumnValue(encString) {
  await ensureEmailSchema();
  return secretsIsJson ? JSON.stringify(encString) : encString;
}
function ensureEmailSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS email_connections (
          id BIGSERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          secrets_enc JSONB NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`
        ALTER TABLE email_connections
          ADD COLUMN IF NOT EXISTS settings JSONB,
          ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_error TEXT,
          ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN`);
      // secrets_enc was created as JSONB by the setup script, but may be TEXT
      // on some databases: store the encrypted string the way the column needs.
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'email_connections' AND column_name = 'secrets_enc'
          LIMIT 1`,
      );
      secretsIsJson = /json/i.test(rows[0]?.data_type || "jsonb");
    })().catch((e) => {
      schemaReady = null; // try again next time
      throw e;
    });
  }
  return schemaReady;
}

/* ───────────────────────── config ───────────────────────── */

// Split a "Name <email@x>" string.
function parseAddress(v) {
  const str = s(v);
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: s(m[1]), email: s(m[2]) };
  return { name: "", email: str };
}

function formatFrom(name, email) {
  const n = s(name).replace(/["<>\r\n]/g, "");
  return n ? `"${n}" <${email}>` : email;
}

// Saved row (new or older format) -> { provider, settings, secrets }.
function fromRow(row) {
  const provider = s(row.provider).toLowerCase();
  let dec = {};
  try {
    let packed = row.secrets_enc;
    // A JSON string column can come back still quoted.
    if (typeof packed === "string" && packed.startsWith('"')) {
      try {
        packed = JSON.parse(packed);
      } catch {
        /* keep as is */
      }
    }
    dec = decryptJSON(packed) || {};
  } catch (e) {
    throw new EmailError(
      "The saved email password/key can't be read. The server's APP_ENCRYPTION_KEY changed or is missing — reconnect the email account in Email Integration.",
      { code: "decrypt_failed", provider, detail: e?.message },
    );
  }
  // Older (Mailgun-only) rows kept everything in the encrypted part.
  const legacy = {
    from_email: dec.from_email || dec.fromEmail,
    from_name: dec.from_name || dec.fromName,
    domain: dec.domain,
    region: dec.region,
  };
  const settings = { ...stripEmpty(legacy), ...(row.settings || {}) };
  const secrets = {
    api_key: s(dec.api_key || dec.apiKey),
    password: s(dec.password),
  };
  return {
    source: "admin",
    id: row.id,
    provider,
    settings,
    secrets,
    status: {
      last_sent_at: row.last_sent_at || null,
      last_error: row.last_error || null,
      last_error_at: row.last_error_at || null,
      last_test_at: row.last_test_at || null,
      last_test_ok: row.last_test_ok ?? null,
    },
    updated_at: row.updated_at || null,
  };
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (s(v)) out[k] = s(v);
  return out;
}

// The server's own .env settings (used when nothing is saved in the admin).
function envConfig() {
  const e = process.env;
  if (e.MAILGUN_API_KEY && e.MAILGUN_DOMAIN) {
    const from = parseAddress(e.MAILGUN_FROM || "");
    const region =
      s(e.MAILGUN_REGION).toLowerCase() === "eu" ||
      /\.eu\./i.test(e.MAILGUN_BASE_URL || "")
        ? "eu"
        : "us";
    return {
      source: "server",
      id: null,
      provider: "mailgun",
      settings: {
        domain: s(e.MAILGUN_DOMAIN),
        region,
        from_email:
          s(e.MAILGUN_FROM_EMAIL) ||
          (EMAIL_RE.test(from.email) ? from.email : "") ||
          `postmaster@${s(e.MAILGUN_DOMAIN)}`,
        from_name: s(e.MAILGUN_FROM_NAME) || from.name || "Bishop Robertson TV",
        notify_to: s(e.NOTIFY_TO),
      },
      secrets: { api_key: s(e.MAILGUN_API_KEY) },
      status: envStatus,
    };
  }
  if (e.SMTP_HOST && e.SMTP_PORT && e.SMTP_USER && e.SMTP_PASS) {
    const port = Number(e.SMTP_PORT);
    const from = parseAddress(e.SMTP_FROM || "");
    return {
      source: "server",
      id: null,
      provider: "smtp",
      settings: {
        host: s(e.SMTP_HOST),
        port,
        security:
          String(e.SMTP_SECURE).toLowerCase() === "true" || port === 465
            ? "ssl"
            : "starttls",
        username: s(e.SMTP_USER),
        from_email: from.email || s(e.SMTP_USER),
        from_name: from.name || "Bishop Robertson TV",
        notify_to: s(e.NOTIFY_TO),
      },
      secrets: { password: s(e.SMTP_PASS) },
      status: envStatus,
    };
  }
  return null;
}

const envStatus = {
  last_sent_at: null,
  last_error: null,
  last_error_at: null,
  last_test_at: null,
  last_test_ok: null,
};

let cache = { at: 0, value: undefined };
const CACHE_MS = 30 * 1000;

function clearEmailConfigCache() {
  cache = { at: 0, value: undefined };
  smtpTransports.clear();
}

// The account that sends right now: { source, id, provider, settings, secrets }
// or null. Saved admin connection first, then the server's .env.
async function getEmailConfig({ fresh = false } = {}) {
  if (!fresh && cache.value !== undefined && Date.now() - cache.at < CACHE_MS)
    return cache.value;
  let value = null;
  try {
    await ensureEmailSchema();
    const { rows } = await db.query(
      `SELECT * FROM email_connections
        WHERE is_active = TRUE
        ORDER BY updated_at DESC
        LIMIT 1`,
    );
    if (rows.length) value = fromRow(rows[0]);
  } catch (e) {
    if (e instanceof EmailError) {
      // Saved but unreadable: report it, then fall back to .env if possible.
      console.warn("[email]", e.message);
      value = envConfig();
      if (value) value.warning = e.message;
      else throw e;
    } else {
      console.warn(
        "[email] could not read email_connections:",
        e?.message || e,
      );
      value = envConfig();
    }
  }
  if (!value) value = envConfig();
  cache = { at: Date.now(), value };
  return value;
}

/* ───────────────────────── validation ───────────────────────── */

// Clean admin input. Returns { provider, settings, secrets } or throws EmailError.
function normalizeInput(body = {}) {
  const provider = s(body.provider).toLowerCase();
  if (!PROVIDERS[provider])
    throw new EmailError("Choose an email service.", { code: "invalid" });
  const raw = { ...(body.secrets || {}), ...(body.settings || {}) };
  const settings = {
    from_name: s(raw.from_name || raw.fromName).slice(0, 100),
    from_email: s(raw.from_email || raw.fromEmail).toLowerCase(),
    reply_to: s(raw.reply_to).toLowerCase(),
    notify_to: s(raw.notify_to).toLowerCase(),
  };
  if (provider === "mailgun") {
    settings.domain = s(raw.domain).toLowerCase();
    settings.region = s(raw.region).toLowerCase() === "eu" ? "eu" : "us";
  }
  if (
    provider === "gmail" ||
    provider === "microsoft365" ||
    provider === "zoho"
  ) {
    settings.username = s(raw.username || raw.from_email).toLowerCase();
  }
  if (provider === "zoho") {
    settings.zoho_region = ZOHO_HOSTS[s(raw.zoho_region)]
      ? s(raw.zoho_region)
      : "com";
  }
  if (provider === "smtp") {
    settings.host = s(raw.host).toLowerCase();
    settings.port = Number(raw.port) || 587;
    settings.security = ["ssl", "starttls", "none"].includes(s(raw.security))
      ? s(raw.security)
      : settings.port === 465
        ? "ssl"
        : "starttls";
    settings.username = s(raw.username);
  }
  const secrets = {
    api_key: s(body.secrets?.api_key || body.secrets?.apiKey),
    // Google shows app passwords in groups of 4 with spaces.
    password:
      provider === "gmail"
        ? s(body.secrets?.password).replace(/\s+/g, "")
        : s(body.secrets?.password),
  };
  return { provider, settings: stripEmpty(settings), secrets };
}

// Field problems in plain words; [] when complete.
function validateConfig({ provider, settings, secrets }) {
  const errs = [];
  const need = PROVIDERS[provider]?.secret;
  if (!EMAIL_RE.test(settings.from_email || ""))
    errs.push("Enter the address emails are sent from.");
  if (settings.reply_to && !EMAIL_RE.test(settings.reply_to))
    errs.push("The reply-to address isn't a valid email.");
  if (settings.notify_to && !EMAIL_RE.test(settings.notify_to))
    errs.push("The office notifications address isn't a valid email.");
  if (provider === "mailgun" && !settings.domain)
    errs.push("Enter the Mailgun sending domain (e.g. mg.yourdomain.com).");
  if (provider === "smtp" && !settings.host)
    errs.push("Enter the mail server name.");
  if (
    ["gmail", "microsoft365", "zoho"].includes(provider) &&
    !settings.username
  )
    errs.push("Enter the email account to sign in with.");
  if (need === "api_key" && !secrets.api_key) errs.push("Enter the API key.");
  if (need === "password" && !secrets.password)
    errs.push(
      provider === "gmail"
        ? "Enter the Gmail app password."
        : "Enter the account password.",
    );
  return errs;
}

/* ───────────────────────── message helpers ───────────────────────── */

function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : [to];
  const out = [];
  for (const t of list) {
    if (!t) continue;
    if (typeof t === "string") {
      for (const part of t.split(",")) {
        const a = parseAddress(part);
        if (a.email) out.push(a);
      }
    } else if (typeof t === "object") {
      const email = s(t.email || t.Email);
      if (email) out.push({ email, name: s(t.name || t.Name) });
    }
  }
  return out;
}

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

// Accepts { filename, content (Buffer|base64|text), type|contentType } or
// { path, filename, contentType }. Returns [{ filename, content: Buffer, contentType }].
function normalizeAttachments(list) {
  const out = [];
  let total = 0;
  for (const a of Array.isArray(list) ? list.slice(0, 10) : []) {
    if (!a) continue;
    let content = null;
    if (a.path) {
      try {
        content = fs.readFileSync(a.path);
      } catch {
        continue;
      }
    } else if (Buffer.isBuffer(a.content)) content = a.content;
    else if (typeof a.content === "string") {
      content =
        /^[A-Za-z0-9+/\r\n]+=*$/.test(a.content) && a.content.length % 4 === 0
          ? Buffer.from(a.content, "base64")
          : Buffer.from(a.content);
    }
    if (!content) continue;
    total += content.length;
    if (total > MAX_ATTACH_BYTES) break;
    out.push({
      filename:
        s(a.filename || a.name) ||
        (a.path ? path.basename(a.path) : "attachment"),
      content,
      contentType:
        s(a.contentType || a.type || a.mime) || "application/octet-stream",
    });
  }
  return out;
}

/* ───────────────────────── provider senders ───────────────────────── */

const HTTP_TIMEOUT = 30000;
const httpOk = (st) => st >= 200 && st < 300;

async function sendMailgun(cfg, m) {
  const st = cfg.settings;
  const base =
    process.env.EMAIL_TEST_MAILGUN_URL ||
    (cfg.source === "server" && process.env.MAILGUN_BASE_URL) ||
    (st.region === "eu"
      ? "https://api.eu.mailgun.net"
      : "https://api.mailgun.net");
  const form = new FormData();
  form.append("from", m.from);
  for (const r of m.to) form.append("to", formatFrom(r.name, r.email));
  form.append("subject", m.subject);
  if (m.text) form.append("text", m.text);
  if (m.html) form.append("html", m.html);
  if (m.replyTo) form.append("h:Reply-To", m.replyTo);
  for (const [k, v] of Object.entries(m.headers)) form.append(`h:${k}`, v);
  if (m.template) {
    form.append("template", m.template);
    form.append("h:X-Mailgun-Variables", JSON.stringify(m.variables || {}));
  }
  for (const t of m.tags || []) form.append("o:tag", t);
  for (const a of m.attachments)
    form.append("attachment", a.content, {
      filename: a.filename,
      contentType: a.contentType,
    });
  const res = await axios.post(
    `${base.replace(/\/+$/, "")}/v3/${encodeURIComponent(st.domain)}/messages`,
    form,
    {
      auth: { username: "api", password: cfg.secrets.api_key },
      headers: form.getHeaders(),
      timeout: HTTP_TIMEOUT,
      maxBodyLength: Infinity,
      validateStatus: httpOk,
    },
  );
  return s(res.data?.id);
}

async function sendSendgrid(cfg, m) {
  const content = [];
  if (m.text) content.push({ type: "text/plain", value: m.text });
  if (m.html) content.push({ type: "text/html", value: m.html });
  const body = {
    personalizations: [
      { to: m.to.map((r) => (r.name ? r : { email: r.email })) },
    ],
    from: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) },
    subject: m.subject,
    content,
  };
  if (m.replyTo) body.reply_to = { email: m.replyTo };
  if (Object.keys(m.headers).length) body.headers = m.headers;
  if (m.attachments.length)
    body.attachments = m.attachments.map((a) => ({
      content: a.content.toString("base64"),
      filename: a.filename,
      type: a.contentType,
      disposition: "attachment",
    }));
  const res = await axios.post(
    process.env.EMAIL_TEST_SENDGRID_URL ||
      "https://api.sendgrid.com/v3/mail/send",
    body,
    {
      headers: { Authorization: `Bearer ${cfg.secrets.api_key}` },
      timeout: HTTP_TIMEOUT,
      validateStatus: httpOk,
    },
  );
  return s(res.headers?.["x-message-id"]);
}

async function sendPostmark(cfg, m) {
  const body = {
    From: m.from,
    To: m.to.map((r) => formatFrom(r.name, r.email)).join(", "),
    Subject: m.subject,
    MessageStream: "outbound",
  };
  if (m.html) body.HtmlBody = m.html;
  if (m.text) body.TextBody = m.text;
  if (m.replyTo) body.ReplyTo = m.replyTo;
  if (Object.keys(m.headers).length)
    body.Headers = Object.entries(m.headers).map(([Name, Value]) => ({
      Name,
      Value,
    }));
  if (m.attachments.length)
    body.Attachments = m.attachments.map((a) => ({
      Name: a.filename,
      Content: a.content.toString("base64"),
      ContentType: a.contentType,
    }));
  const res = await axios.post(
    process.env.EMAIL_TEST_POSTMARK_URL || "https://api.postmarkapp.com/email",
    body,
    {
      headers: {
        "X-Postmark-Server-Token": cfg.secrets.api_key,
        Accept: "application/json",
      },
      timeout: HTTP_TIMEOUT,
      validateStatus: httpOk,
    },
  );
  return s(res.data?.MessageID);
}

async function sendBrevo(cfg, m) {
  const body = {
    sender: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) },
    to: m.to.map((r) => (r.name ? r : { email: r.email })),
    subject: m.subject,
  };
  if (m.html) body.htmlContent = m.html;
  if (m.text) body.textContent = m.text;
  if (m.replyTo) body.replyTo = { email: m.replyTo };
  if (Object.keys(m.headers).length) body.headers = m.headers;
  if (m.attachments.length)
    body.attachment = m.attachments.map((a) => ({
      name: a.filename,
      content: a.content.toString("base64"),
    }));
  const res = await axios.post(
    process.env.EMAIL_TEST_BREVO_URL || "https://api.brevo.com/v3/smtp/email",
    body,
    {
      headers: { "api-key": cfg.secrets.api_key, Accept: "application/json" },
      timeout: HTTP_TIMEOUT,
      validateStatus: httpOk,
    },
  );
  return s(res.data?.messageId);
}

async function sendResend(cfg, m) {
  const body = {
    from: m.from,
    to: m.to.map((r) => r.email),
    subject: m.subject,
  };
  if (m.html) body.html = m.html;
  if (m.text) body.text = m.text;
  if (m.replyTo) body.reply_to = m.replyTo;
  if (Object.keys(m.headers).length) body.headers = m.headers;
  if (m.attachments.length)
    body.attachments = m.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
    }));
  const res = await axios.post(
    process.env.EMAIL_TEST_RESEND_URL || "https://api.resend.com/emails",
    body,
    {
      headers: { Authorization: `Bearer ${cfg.secrets.api_key}` },
      timeout: HTTP_TIMEOUT,
      validateStatus: httpOk,
    },
  );
  return s(res.data?.id);
}

// Mail-server settings for each SMTP provider.
function smtpOptions(cfg) {
  const st = cfg.settings;
  const user = st.username || st.from_email;
  const auth = { user, pass: cfg.secrets.password };
  const common = {
    auth,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  switch (cfg.provider) {
    case "gmail":
      return { host: "smtp.gmail.com", port: 465, secure: true, ...common };
    case "microsoft365":
      return {
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        requireTLS: true,
        ...common,
      };
    case "zoho":
      return {
        host: ZOHO_HOSTS[st.zoho_region] || ZOHO_HOSTS.com,
        port: 465,
        secure: true,
        ...common,
      };
    default: {
      const port = Number(st.port) || 587;
      const security = st.security || (port === 465 ? "ssl" : "starttls");
      return {
        host: st.host,
        port,
        secure: security === "ssl",
        requireTLS: security === "starttls",
        ignoreTLS: security === "none",
        ...common,
        auth: st.username || cfg.secrets.password ? auth : undefined,
      };
    }
  }
}

const smtpTransports = new Map();
function smtpTransport(cfg) {
  const opts = smtpOptions(cfg);
  const key = JSON.stringify([
    opts.host,
    opts.port,
    opts.secure,
    opts.auth?.user,
    cfg.secrets.password,
  ]);
  if (!smtpTransports.has(key)) {
    smtpTransports.clear(); // one account at a time
    smtpTransports.set(key, nodemailer.createTransport(opts));
  }
  return smtpTransports.get(key);
}

async function sendSmtp(cfg, m) {
  const info = await smtpTransport(cfg).sendMail({
    from: m.from,
    to: m.to.map((r) => formatFrom(r.name, r.email)),
    replyTo: m.replyTo || undefined,
    headers: m.headers,
    subject: m.subject,
    text: m.text || undefined,
    html: m.html || undefined,
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  return s(info?.messageId);
}

const SENDERS = {
  mailgun: sendMailgun,
  sendgrid: sendSendgrid,
  postmark: sendPostmark,
  brevo: sendBrevo,
  resend: sendResend,
  gmail: sendSmtp,
  microsoft365: sendSmtp,
  zoho: sendSmtp,
  smtp: sendSmtp,
};

/* ───────────────────────── friendly errors ───────────────────────── */

function rawDetail(err) {
  const d = err?.response?.data;
  if (d) {
    if (typeof d === "string") return d;
    return (
      d.message ||
      d.Message ||
      d.errors?.[0]?.message ||
      d.error?.message ||
      d.error ||
      JSON.stringify(d)
    );
  }
  return err?.response?.status
    ? `HTTP ${err.response.status}`
    : err?.response || err?.message || String(err);
}

function friendlyError(err, provider) {
  if (err instanceof EmailError) return err;
  const label = providerLabel(provider);
  const kind = PROVIDERS[provider]?.kind;
  const status = err?.response?.status;
  const code = s(err?.code);
  const detail = s(rawDetail(err));
  const low = detail.toLowerCase();
  const mk = (msg, c) => new EmailError(msg, { code: c, provider, detail });

  // Mail-server connection problems (blocked port, wrong host...).
  if (
    kind === "smtp" &&
    [
      "ETIMEDOUT",
      "ECONNECTION",
      "ESOCKET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code)
  ) {
    return mk(
      `Couldn't reach ${label}'s mail server. If the website's server runs on Render's free plan, Render blocks mail-server connections — use Mailgun, SendGrid, Postmark, Brevo or Resend instead, or move the server to a paid Render plan. Otherwise check the server name and port.`,
      "unreachable",
    );
  }
  if (["ENOTFOUND", "EDNS"].includes(code))
    return mk(
      "The mail server name wasn't found. Check the spelling.",
      "unreachable",
    );
  if (
    code === "EAUTH" ||
    /^535|5\.7\.8|authentication|username and password/i.test(detail)
  ) {
    if (provider === "gmail")
      return mk(
        "Google didn't accept the sign-in. Use an App Password (16 letters from myaccount.google.com › Security › App passwords), not the normal Gmail password. 2-Step Verification must be on.",
        "auth",
      );
    if (provider === "microsoft365")
      return mk(
        /5\.7\.139|basic authentication|smtpclientauthentication/i.test(detail)
          ? "Microsoft 365 blocked password sign-in for sending (SMTP AUTH is turned off for this mailbox or organization). Your Microsoft 365 administrator can turn on “Authenticated SMTP” for the mailbox, or use Mailgun, SendGrid, Postmark, Brevo or Resend instead."
          : "Microsoft 365 didn't accept the email or password. Check them, and ask your Microsoft 365 administrator to turn on “Authenticated SMTP” for this mailbox.",
        "auth",
      );
    if (provider === "zoho")
      return mk(
        "Zoho didn't accept the sign-in. If two-factor sign-in is on, create an Application-Specific Password in Zoho and use that.",
        "auth",
      );
    return mk(
      "The mail server didn't accept the username or password.",
      "auth",
    );
  }
  if (status === 401 || status === 403) {
    if (
      provider === "mailgun" &&
      status === 403 &&
      /sandbox|authorized recipients/i.test(detail)
    )
      return mk(
        "This is a Mailgun sandbox domain: it only sends to addresses added as “Authorized Recipients” in Mailgun. Add the address there, or connect your own verified domain.",
        "sender",
      );
    if (
      provider === "sendgrid" &&
      /from address|sender identity|verified sender/i.test(detail)
    )
      return mk(
        "SendGrid hasn't verified this “from” address. Verify it under Settings › Sender Authentication in SendGrid.",
        "sender",
      );
    return mk(
      `${label} didn't accept the API key. Copy it again from your ${label} account (check for missing characters).`,
      "auth",
    );
  }
  if (provider === "mailgun" && status === 404)
    return mk(
      "Mailgun doesn't know this sending domain in this region. Check the domain name and the US/EU region.",
      "config",
    );
  if (
    /not.*verif|unverified|sender.*(not|isn)|domain.*not|signature/i.test(
      low,
    ) ||
    (provider === "postmark" &&
      /400/.test(String(err?.response?.data?.ErrorCode)))
  )
    return mk(
      `${label} hasn't approved the “from” address or its domain yet. Verify the sender address (or domain) in your ${label} account, then try again.`,
      "sender",
    );
  if (status === 429)
    return mk(
      `${label} is limiting how fast emails can be sent. Wait a minute and try again.`,
      "rate_limit",
    );
  if (/daily (user )?sending limit|quota|limit exceeded/i.test(low))
    return mk(
      `The ${label} account reached its sending limit for today.`,
      "rate_limit",
    );
  if (status === 400 || status === 422)
    return mk(
      `${label} refused the email: ${detail.slice(0, 200)}`,
      "rejected",
    );
  if (code === "ECONNABORTED" || /timeout/i.test(low))
    return mk(
      `${label} didn't answer in time. Try again in a minute.`,
      "unreachable",
    );
  return mk(
    `${label} couldn't send the email: ${detail.slice(0, 200)}`,
    "send_failed",
  );
}

/* ───────────────────────── status ───────────────────────── */

let lastSentWrite = 0;
async function recordResult(cfg, ok, message) {
  try {
    if (ok) {
      // Busy campaigns: write the "last sent" time at most once a minute.
      if (cfg.source === "server") envStatus.last_sent_at = new Date();
      if (Date.now() - lastSentWrite < 60000) return;
      lastSentWrite = Date.now();
      if (cfg.id)
        await db.query(
          "UPDATE email_connections SET last_sent_at = NOW() WHERE id = $1",
          [cfg.id],
        );
    } else {
      if (cfg.source === "server") {
        envStatus.last_error = message;
        envStatus.last_error_at = new Date();
      }
      if (cfg.id)
        await db.query(
          "UPDATE email_connections SET last_error = $2, last_error_at = NOW() WHERE id = $1",
          [cfg.id, String(message).slice(0, 500)],
        );
    }
  } catch {
    /* status is a nice-to-have */
  }
}

/* ───────────────────────── send ───────────────────────── */

// Extra headers (e.g. List-Unsubscribe). Only safe, single-line values.
function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (
      /^[A-Za-z0-9-]{1,60}$/.test(k) &&
      v != null &&
      !/[\r\n]/.test(String(v))
    )
      out[k] = String(v).slice(0, 900);
  }
  return out;
}

// Send one email. Throws EmailError (with a message fit to show an admin).
//   to: "a@x" | "Name <a@x>" | ["a@x", {email,name}, {Email,Name}]
//   subject, text, html, replyTo, attachments, fromOverride ("Name <a@x>")
//   config: use this account instead of the saved one (for "Send test")
//   template, variables, tags: Mailgun stored templates (Mailgun only)
async function sendMail(msg = {}, { config, record = true } = {}) {
  const cfg = config || (await getEmailConfig());
  if (!cfg)
    throw new EmailError(
      "No email account is connected. Connect one in Admin › Integrations › Email.",
      { code: "not_configured" },
    );
  const send = SENDERS[cfg.provider];
  if (!send)
    throw new EmailError(`Unknown email service “${cfg.provider}”.`, {
      code: "config",
      provider: cfg.provider,
    });
  const to = normalizeRecipients(msg.to);
  if (!to.length)
    throw new EmailError("No recipient address.", {
      code: "invalid",
      provider: cfg.provider,
    });
  if (msg.template && cfg.provider !== "mailgun")
    throw new EmailError("Stored email templates only work with Mailgun.", {
      code: "config",
      provider: cfg.provider,
    });

  const override = msg.fromOverride ? parseAddress(msg.fromOverride) : null;
  const fromEmail =
    (override && EMAIL_RE.test(override.email) && override.email) ||
    cfg.settings.from_email;
  const fromName = (override && override.name) || cfg.settings.from_name || "";
  const m = {
    to,
    fromEmail,
    fromName,
    from: formatFrom(fromName, fromEmail),
    replyTo: s(msg.replyTo) || cfg.settings.reply_to || "",
    subject: s(msg.subject).replace(/[\r\n]+/g, " ") || "(no subject)",
    text: msg.text ? String(msg.text) : "",
    html: msg.html ? String(msg.html) : "",
    attachments: normalizeAttachments(msg.attachments),
    template: msg.template,
    variables: msg.variables,
    tags: msg.tags,
    headers: cleanHeaders(msg.headers),
  };
  if (!m.text && !m.html && !m.template) m.text = " ";

  try {
    const id = await send(cfg, m);
    if (record) recordResult(cfg, true);
    return {
      ok: true,
      provider: cfg.provider,
      id: id || null,
      source: cfg.source,
    };
  } catch (err) {
    const fe = friendlyError(err, cfg.provider);
    if (record) recordResult(cfg, false, fe.message);
    throw fe;
  }
}

// Who gets office alerts (new sign-ups, new subscribers): the address saved in
// Email Integration, else NOTIFY_TO in .env.
async function getNotifyAddress() {
  try {
    const cfg = await getEmailConfig();
    if (cfg?.settings?.notify_to) return cfg.settings.notify_to;
  } catch {
    /* fall through */
  }
  return s(process.env.NOTIFY_TO);
}

module.exports = {
  PROVIDERS,
  ZOHO_HOSTS,
  EmailError,
  ensureEmailSchema,
  secretsColumnValue,
  getEmailConfig,
  clearEmailConfigCache,
  normalizeInput,
  validateConfig,
  sendMail,
  getNotifyAddress,
  friendlyError,
  smtpOptions,
  parseAddress,
  envConfig,
};
