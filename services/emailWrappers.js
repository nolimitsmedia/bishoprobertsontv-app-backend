// server-api/services/emailWrappers.js
// The site's named emails (welcome, password reset, receipts, alerts...), sent
// with the branded design and the wording edited in Admin › Email › Automations.
// Shared by services/mailer.js (never throws) and services/email.js (throws).

const db = require("../db");
const transport = require("./emailTransport");
const T = require("./emailTemplates");

function money(amountCents, currency = "USD") {
  if (amountCents == null || amountCents === "") return "";
  const n = Number(amountCents) / 100;
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function intervalLabel(interval) {
  const i = String(interval || "").toLowerCase();
  if (/^month/.test(i)) return "per month";
  if (/^year|^annual/.test(i)) return "per year";
  if (/^week/.test(i)) return "per week";
  if (/^day/.test(i)) return "per day";
  return i ? `(${i})` : "";
}

async function userById(id) {
  if (!id) return null;
  try {
    const { rows } = await db.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [id],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

module.exports = function makeEmailWrappers({ throwOnError = false } = {}) {
  const send = async (key, opts) => {
    const r = await T.sendTemplated(key, { ...opts, throwOnError });
    if (
      r.status === "off" ||
      r.status === "unsubscribed" ||
      r.status === "duplicate"
    )
      return { skipped: true, reason: r.status };
    return r;
  };

  async function sendWelcomeEmail({ to, name } = {}) {
    return send("welcome", {
      to,
      vars: { name: name && name !== "there" ? name : "" },
      dedupe: `welcome:${String(to || "").toLowerCase()}`,
    });
  }

  // Accepts resetUrl (old name), link or url.
  async function sendPasswordResetEmail({
    to,
    resetUrl,
    link,
    url,
    name,
  } = {}) {
    const reset = resetUrl || link || url;
    if (!reset) {
      const e = new Error("Password reset email needs a link");
      if (throwOnError) throw e;
      return { ok: false, error: e.message };
    }
    return send("password_reset", {
      to,
      vars: {
        name: name && !String(name).includes("@") ? name : "",
        reset_url: reset,
      },
    });
  }

  async function sendLiveReminderEmail({ to, title, startAt, watchUrl } = {}) {
    return send("live_reminder", {
      to,
      vars: {
        event_title: title || "Live service",
        start_time: startAt || "",
        watch_url: watchUrl || T.sitePage("live-streaming"),
      },
    });
  }

  async function sendNewUserAlert({ user } = {}) {
    const to = await transport.getNotifyAddress();
    if (!to) return { skipped: true };
    return send("office_new_signup", {
      to,
      vars: {
        member_name: user?.name || user?.email || "Someone",
        member_email: user?.email || "-",
      },
    });
  }

  async function sendPurchaseReceipt({
    to,
    name,
    planName,
    amount,
    currency = "USD",
    interval,
    invoiceUrl,
  } = {}) {
    return send("subscription_receipt", {
      to,
      vars: {
        name: name && name !== "there" ? name : "",
        plan_name: planName || "your",
        amount: money(amount, currency),
        interval_label: intervalLabel(interval),
        invoice_url: invoiceUrl || "",
      },
    });
  }

  // subscription.js passes userId (not user): look the member up.
  async function sendNewSubscriberAlert({
    user,
    userId,
    planName,
    amount,
    currency = "USD",
    interval,
  } = {}) {
    const to = await transport.getNotifyAddress();
    if (!to) return { skipped: true };
    const u = user || (await userById(userId)) || {};
    return send("office_new_subscriber", {
      to,
      vars: {
        member_name: u.name || u.email || "A member",
        member_email: u.email || "-",
        plan_name: planName || "a plan",
        amount: money(amount, currency),
        interval_label: intervalLabel(interval),
      },
    });
  }

  return {
    sendWelcomeEmail,
    sendPasswordResetEmail,
    sendLiveReminderEmail,
    sendNewUserAlert,
    sendPurchaseReceipt,
    sendNewSubscriberAlert,
  };
};
