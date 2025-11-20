// server-api/services/mailer.js
// Crash-proof Mailgun mailer.
//   npm i mailgun.js form-data
//
// .env
//   MAILGUN_API_KEY=key-xxxx
//   MAILGUN_DOMAIN=sandboxXXXX.mailgun.org  (or mg.yourdomain.com)
//   MAILGUN_FROM="Bishop Robertson <postmaster@YOUR_DOMAIN>"
//   MAILGUN_BASE_URL=https://api.mailgun.net   (optional; EU: https://api.eu.mailgun.net)
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
const baseUrl = process.env.MAILGUN_BASE_URL;

const mg =
  apiKey && domain
    ? new Mailgun(formData).client({
        username: "api",
        key: apiKey,
        url: baseUrl,
      })
    : null;

function okMailer() {
  if (!mg) {
    console.warn("[mailer] Mailgun not configured; skipping send.");
    return false;
  }
  return true;
}

function normalizeTo(to) {
  if (!to) return [];
  if (Array.isArray(to)) {
    return to.map((t) =>
      typeof t === "string"
        ? t
        : t?.Email
        ? t.Name
          ? `${t.Name} <${t.Email}>`
          : t.Email
        : String(t)
    );
  }
  if (typeof to === "object" && to.Email) {
    return [to.Name ? `${to.Name} <${to.Email}>` : to.Email];
  }
  return [String(to)];
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toMailgunAttachments(attachments) {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => {
    let data;
    if (Buffer.isBuffer(a.content)) data = a.content;
    else if (typeof a.content === "string") {
      const looksB64 = /^[A-Za-z0-9+/]+=*$/.test(a.content);
      data = looksB64
        ? Buffer.from(a.content, "base64")
        : Buffer.from(a.content);
    } else data = Buffer.from([]);
    return {
      data,
      filename: a.filename,
      contentType: a.type || "application/octet-stream",
    };
  });
}

/** Low-level: safe send (never throws up to callers). */
async function sendEmail({
  to,
  subject,
  text,
  html,
  attachments,
  fromOverride,
}) {
  try {
    if (!okMailer()) return { skipped: true };
    const payload = {
      from: fromOverride || defaultFrom,
      to: normalizeTo(to),
      subject: subject || "",
    };
    if (text) payload.text = text;
    if (html) payload.html = html;
    const atts = toMailgunAttachments(attachments);
    if (atts) payload.attachment = atts;

    return await mg.messages.create(domain, payload);
  } catch (e) {
    // Don’t break app flows on email issues (e.g., sandbox unauthorized recipient).
    console.warn("[mailer] sendEmail failed:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

/** Stored template send (safe). */
async function sendTemplateEmail({
  to,
  template,
  variables = {},
  subject,
  tags = [],
  fromOverride,
}) {
  try {
    if (!okMailer()) return { skipped: true };
    if (!template) throw new Error("template name is required");

    const payload = {
      from: fromOverride || defaultFrom,
      to: normalizeTo(to),
      template,
      "h:X-Mailgun-Variables": JSON.stringify(variables || {}),
    };
    if (subject) payload.subject = subject;
    if (tags?.length) payload["o:tag"] = tags;

    return await mg.messages.create(domain, payload);
  } catch (e) {
    console.warn("[mailer] sendTemplateEmail failed:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

/* ====== Convenience wrappers (safe) ====== */

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
  const text = `Hi ${name},\nUse this link to reset your password:\n${resetUrl}`;
  const html = `<div style="font-family:Arial,sans-serif">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Use this link to reset your password:</p>
    <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
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

async function sendNewUserAlert({ user }) {
  const to = process.env.NOTIFY_TO;
  if (!to) return { skipped: true };
  const subject = `New signup: ${user?.email || "-"}`;
  const text = `New user signed up.\nName: ${user?.name || "-"}\nEmail: ${
    user?.email || "-"
  }`;
  const html = `<div style="font-family:Arial,sans-serif">
    <h3>New user signup</h3>
    <ul>
      <li><b>Name:</b> ${escapeHtml(user?.name || "-")}</li>
      <li><b>Email:</b> ${escapeHtml(user?.email || "-")}</li>
    </ul>
  </div>`;
  return sendEmail({ to, subject, text, html });
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
  const to = process.env.NOTIFY_TO;
  if (!to) return { skipped: true };
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
  return sendEmail({ to, subject, text, html });
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
