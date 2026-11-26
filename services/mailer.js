// server-api/services/mailer.js
// Crash-proof mailer: never throws to callers (returns { ok:false, error }).
//
// Every email goes through services/emailTransport.js, which uses the account
// connected in Admin › Integrations › Email (Mailgun, SendGrid, Postmark,
// Brevo, Resend, Gmail, Microsoft 365, Zoho or any SMTP host) and falls back
// to the server's MAILGUN_* / SMTP_* settings in .env.

const transport = require("./emailTransport");

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Low-level: safe send (never throws up to callers). */
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
  try {
    return await transport.sendMail({
      to,
      subject,
      text,
      html,
      attachments,
      fromOverride,
      replyTo,
      headers,
    });
  } catch (e) {
    if (e?.code === "not_configured") {
      console.warn("[mailer] No email account connected; skipping send.");
      return { skipped: true };
    }
    // Don’t break app flows on email issues.
    console.warn("[mailer] sendEmail failed:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

/** Mailgun stored template send (safe; Mailgun accounts only). */
async function sendTemplateEmail({
  to,
  template,
  variables = {},
  subject,
  tags = [],
  fromOverride,
}) {
  try {
    if (!template) throw new Error("template name is required");
    return await transport.sendMail({
      to,
      subject,
      template,
      variables,
      tags,
      fromOverride,
    });
  } catch (e) {
    if (e?.code === "not_configured") return { skipped: true };
    console.warn("[mailer] sendTemplateEmail failed:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

/* ====== Convenience wrappers (safe) ====== */

// Named emails (branded, wording editable in Admin › Email › Automations).
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendLiveReminderEmail,
  sendNewUserAlert,
  sendPurchaseReceipt,
  sendNewSubscriberAlert,
  sendTrialEndingEmail,
  sendPaymentFailedEmail,
  sendRenewalReminderEmail,
  sendSubscriptionCancelledEmail,
  sendGiftReceivedEmail,
} = require("./emailWrappers")({ throwOnError: false });

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
  // billing (Release 2.1; each off until switched on in Email Automations)
  sendTrialEndingEmail,
  sendPaymentFailedEmail,
  sendRenewalReminderEmail,
  sendSubscriptionCancelledEmail,
  sendGiftReceivedEmail,
};
