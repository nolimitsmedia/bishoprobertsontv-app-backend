// server-api/services/mailer.js
// Mailgun mailer (CommonJS). Requires:
//   npm i mailgun.js form-data
//
// .env
//   MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxxxxxx
//   MAILGUN_DOMAIN=sandboxXXXX.mailgun.org  (or mg.yourdomain.com in prod)
//   MAILGUN_FROM="Bishop Robertson <postmaster@sandboxXXXX.mailgun.org>"
//   MAILGUN_BASE_URL=https://api.mailgun.net  (optional; use EU endpoint if needed)
//   NOTIFY_TO=websupport@nolimitsmedia.com

const Mailgun = require("mailgun.js");
const formData = require("form-data");

const apiKey = process.env.MAILGUN_API_KEY;
const domain = process.env.MAILGUN_DOMAIN;
const defaultFrom =
  process.env.MAILGUN_FROM ||
  (domain
    ? `Bishop Robertson <postmaster@${domain}>`
    : "No Reply <no-reply@example.com>");
const baseUrl = process.env.MAILGUN_BASE_URL; // optional (e.g., https://api.eu.mailgun.net)

const mg =
  apiKey && domain
    ? new Mailgun(formData).client({
        username: "api",
        key: apiKey,
        url: baseUrl,
      })
    : null;

function assertMailer() {
  if (!mg) {
    throw new Error(
      "Mailer not initialized. Check MAILGUN_API_KEY and MAILGUN_DOMAIN in .env"
    );
  }
}

/** Normalize "to" into an array of strings Mailgun accepts. */
function normalizeTo(to) {
  if (!to) return [];
  if (Array.isArray(to)) {
    return to.map((t) => {
      if (typeof t === "string") return t;
      if (t && t.Email) {
        return t.Name ? `${t.Name} <${t.Email}>` : t.Email;
      }
      return String(t);
    });
  }
  if (typeof to === "object" && to.Email) {
    return [to.Name ? `${to.Name} <${to.Email}>` : to.Email];
  }
  return [String(to)];
}

/** Escape minimal HTML (for interpolated text in HTML emails). */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert legacy attachments [{ filename, content, type }] to Mailgun format. */
function toMailgunAttachments(attachments) {
  if (!attachments || !attachments.length) return undefined;
  return attachments.map((a) => {
    let data;
    if (Buffer.isBuffer(a.content)) data = a.content;
    else if (typeof a.content === "string") {
      // If it's base64-looking, decode; otherwise, treat as raw string
      const looksB64 = /^[A-Za-z0-9+/]+=*$/.test(a.content);
      data = looksB64
        ? Buffer.from(a.content, "base64")
        : Buffer.from(a.content);
    } else {
      data = Buffer.from([]);
    }
    return {
      data,
      filename: a.filename,
      contentType: a.type || "application/octet-stream",
    };
  });
}

/**
 * Low-level sender: send simple email (html/text) with optional attachments.
 * @param {Object} opts
 *  - to: string | string[] | [{Email, Name?}]
 *  - subject: string
 *  - text?: string
 *  - html?: string
 *  - attachments?: [{ filename, content (Buffer|base64|string), type? }]
 *  - fromOverride?: string
 */
async function sendEmail({
  to,
  subject,
  text,
  html,
  attachments,
  fromOverride,
}) {
  assertMailer();
  const payload = {
    from: fromOverride || defaultFrom,
    to: normalizeTo(to),
    subject: subject || "",
  };
  if (text) payload.text = text;
  if (html) payload.html = html;

  const atts = toMailgunAttachments(attachments);
  if (atts) payload.attachment = atts;

  return mg.messages.create(domain, payload);
}

/**
 * Send using a stored Mailgun template.
 * @param {Object} opts
 *  - to: string | string[] | [{Email, Name?}]
 *  - template: string  (Mailgun template name)
 *  - variables?: object (passed as X-Mailgun-Variables)
 *  - subject?: string (optional override)
 *  - tags?: string[]   (optional o:tag(s))
 *  - fromOverride?: string
 */
async function sendTemplateEmail({
  to,
  template,
  variables = {},
  subject,
  tags = [],
  fromOverride,
}) {
  assertMailer();
  if (!template)
    throw new Error("template name is required for sendTemplateEmail");

  const payload = {
    from: fromOverride || defaultFrom,
    to: normalizeTo(to),
    template, // Mailgun stored template name
    "h:X-Mailgun-Variables": JSON.stringify(variables || {}),
  };
  if (subject) payload.subject = subject;
  if (tags && tags.length) {
    // Mailgun supports multiple tags by repeating the parameter
    // mailgun.js: provide as array under "o:tag"
    payload["o:tag"] = tags;
  }

  return mg.messages.create(domain, payload);
}

/* ============================
 * Convenience wrappers/flows
 * ============================
 * Keep names close to your old Mailjet helpers for easy swap-in.
 */

async function sendWelcomeEmail({ to, name = "there" }) {
  const subject = "Welcome to Bishop Robertson";
  const text = `Welcome, ${name}! Your account is ready.`;
  const html = `<div style="font-family:Arial,sans-serif">
    <h2>Welcome, ${escapeHtml(name)}!</h2>
    <p>Your account is ready. Enjoy the latest sermons and content.</p>
    <p>— Bishop Robertson Team</p>
  </div>`;
  return sendEmail({ to, subject, text, html });
}

async function sendPasswordResetEmail({ to, resetUrl, name = "there" }) {
  const subject = "Reset your Bishop Robertson password";
  const text = `Hi ${name},\nUse this link to reset your password:\n${resetUrl}\nIf you didn’t request this, you can ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Use this link to reset your password:</p>
    <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
    <p>If you didn’t request this, you can ignore this email.</p>
  </div>`;
  return sendEmail({ to, subject, text, html });
}

async function sendLiveReminderEmail({ to, title, startAt, watchUrl }) {
  const subject = `Reminder: ${title}`;
  const text = `Your live event "${title}" starts at ${startAt}.\nWatch: ${watchUrl}`;
  const html = `<div style="font-family:Arial,sans-serif">
    <p>Your live event <b>${escapeHtml(title)}</b> starts at <b>${escapeHtml(
    startAt
  )}</b>.</p>
    <p>Watch here: <a href="${escapeHtml(watchUrl)}">${escapeHtml(
    watchUrl
  )}</a></p>
  </div>`;
  return sendEmail({ to, subject, text, html });
}

/** Internal alerts / receipts used by auth + subscription flows */
async function sendNewUserAlert({ user }) {
  const notify = process.env.NOTIFY_TO;
  if (!notify) return;
  const subject = `New signup: ${user?.email || "-"}`;
  const text = `New user signed up.
Name: ${user?.name || "-"}
Email: ${user?.email || "-"}`;
  const html = `<div style="font-family:Arial,sans-serif">
    <h3>New user signup</h3>
    <ul>
      <li><b>Name:</b> ${escapeHtml(user?.name || "-")}</li>
      <li><b>Email:</b> ${escapeHtml(user?.email || "-")}</li>
    </ul>
  </div>`;
  return sendEmail({ to: notify, subject, text, html });
}

async function sendPurchaseReceipt({
  to,
  name = "there",
  planName,
  amount,
  currency = "USD",
  interval,
  invoiceUrl,
}) {
  const money =
    amount != null ? `${(Number(amount) / 100).toFixed(2)} ${currency}` : "";
  const subject = `Your ${planName} subscription is active`;
  const text = `Hi ${name},
Thanks for subscribing to ${planName}.
Amount: ${money}
Billing: ${interval || "-"}
${invoiceUrl ? "Invoice: " + invoiceUrl : ""}

— Bishop Robertson Team`;
  const html = `<div style="font-family:Arial,sans-serif">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Thanks for subscribing to <b>${escapeHtml(planName || "")}</b>.</p>
    <ul>
      <li><b>Amount:</b> ${escapeHtml(money)}</li>
      <li><b>Billing:</b> ${escapeHtml(interval || "-")}</li>
      ${
        invoiceUrl
          ? `<li><b>Invoice:</b> <a href="${escapeHtml(
              invoiceUrl
            )}">View</a></li>`
          : ""
      }
    </ul>
    <p>— Bishop Robertson Team</p>
  </div>`;
  return sendEmail({ to, subject, text, html });
}

async function sendNewSubscriberAlert({
  user,
  planName,
  amount,
  currency = "USD",
  interval,
}) {
  const notify = process.env.NOTIFY_TO;
  if (!notify) return;
  const money =
    amount != null ? `${(Number(amount) / 100).toFixed(2)} ${currency}` : "";
  const subject = `New subscription: ${user?.email || "-"} → ${planName}`;
  const text = `User: ${user?.name || "-"} (${user?.email || "-"})
Plan: ${planName}
Amount: ${money}
Interval: ${interval || "-"}`;
  const html = `<div style="font-family:Arial,sans-serif">
    <h3>New subscription purchase</h3>
    <ul>
      <li><b>User:</b> ${escapeHtml(user?.name || "-")} (${escapeHtml(
    user?.email || "-"
  )})</li>
      <li><b>Plan:</b> ${escapeHtml(planName || "")}</li>
      <li><b>Amount:</b> ${escapeHtml(money)}</li>
      <li><b>Interval:</b> ${escapeHtml(interval || "-")}</li>
    </ul>
  </div>`;
  return sendEmail({ to: notify, subject, text, html });
}

module.exports = {
  // low-level
  sendEmail,
  sendTemplateEmail,
  // auth-related
  sendWelcomeEmail,
  sendPasswordResetEmail,
  // content reminders
  sendLiveReminderEmail,
  // commerce
  sendPurchaseReceipt,
  sendNewSubscriberAlert,
  // internal alert
  sendNewUserAlert,
};
