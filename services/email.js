// server-api/services/email.js
// Email helpers that THROW on failure (callers catch). Same functions as
// services/mailer.js, which instead never throws.
//
// Every email goes through services/emailTransport.js, which uses the account
// connected in Admin › Integrations › Email (Mailgun, SendGrid, Postmark,
// Brevo, Resend, Gmail, Microsoft 365, Zoho or any SMTP host) and falls back
// to the server's MAILGUN_* / SMTP_* settings in .env.

const transport = require("./emailTransport");

/** Escape minimal HTML (for interpolated text in HTML emails). */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send a plain email.
 * @param {Object} opts
 *  - to: string | string[] | [{Email, Name?}] | [{email, name?}]
 *  - subject: string
 *  - text?: string
 *  - html?: string
 *  - attachments?: [{ filename, content (Buffer|base64|string), type? }]
 *  - fromOverride?: string ("Name <email>")
 *  - replyTo?: string
 * Throws an Error with a readable message when the email can't be sent.
 */
async function sendEmail({
  to,
  subject,
  text,
  html,
  attachments,
  fromOverride,
  replyTo,
  headers,
}) {
  return transport.sendMail({
    to,
    subject,
    text,
    html,
    attachments,
    fromOverride,
    replyTo,
    headers,
  });
}

/**
 * Send using a stored Mailgun template (Mailgun accounts only).
 *  - to, template, variables?, subject?, tags?, fromOverride?
 */
async function sendTemplateEmail({
  to,
  template,
  variables = {},
  subject,
  tags = [],
  fromOverride,
}) {
  if (!template)
    throw new Error("template name is required for sendTemplateEmail");
  return transport.sendMail({
    to,
    subject,
    template,
    variables,
    tags,
    fromOverride,
  });
}

/* ============================
 * Convenience wrappers/flows
 * ============================
 * Keep names close to your old Mailjet helpers for easy swap-in.
 */

/** Internal alerts / receipts used by auth + subscription flows */
// Named emails (branded, wording editable in Admin › Email › Automations).
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendLiveReminderEmail,
  sendNewUserAlert,
  sendPurchaseReceipt,
  sendNewSubscriberAlert,
} = require("./emailWrappers")({ throwOnError: true });

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
