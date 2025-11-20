// server-api/billing/paypal.js
const axios = require("axios");

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function oauthToken() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  const res = await axios({
    method: "post",
    url: `${BASE}/v1/oauth2/token`,
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: "grant_type=client_credentials",
  });
  return res.data.access_token;
}

const planMap = () => ({
  growth: {
    monthly: process.env.PAYPAL_PLAN_ID_GROWTH_MONTHLY,
    yearly: process.env.PAYPAL_PLAN_ID_GROWTH_YEARLY,
  },
  essentials: {
    monthly: process.env.PAYPAL_PLAN_ID_ESSENTIALS_MONTHLY,
    yearly: process.env.PAYPAL_PLAN_ID_ESSENTIALS_YEARLY,
  },
});

async function paypalCreateSubscription({ plan, cycle }) {
  const token = await oauthToken();
  const plan_id = (planMap()[plan] || {})[cycle];
  if (!plan_id) throw new Error("Unknown PayPal plan/cycle");

  const body = {
    plan_id,
    application_context: {
      brand_name: "BishopTV",
      user_action: "SUBSCRIBE_NOW",
      return_url: `${process.env.PUBLIC_URL}/subscribe/thanks?provider=paypal`,
      cancel_url: `${process.env.PUBLIC_URL}/pricing?canceled=1`,
    },
  };

  const res = await axios.post(`${BASE}/v1/billing/subscriptions`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const approve = (res.data.links || []).find((l) => l.rel === "approve")?.href;
  return { url: approve };
}

// Verify PayPal webhook signature
async function paypalVerifyWebhook({ body, headers }) {
  const token = await oauthToken();
  const verifyBody = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID, // set after creating webhook
    webhook_event: body,
  };
  const { data } = await axios.post(
    `${BASE}/v1/notifications/verify-webhook-signature`,
    verifyBody,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.verification_status === "SUCCESS";
}

async function paypalHandleEvent(ev) {
  // TODO: upsert subscription state in your DB here
  switch (ev.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "PAYMENT.SALE.COMPLETED":
      // console.log("PayPal event:", ev.event_type, ev.resource?.id);
      break;
  }
}

module.exports = {
  paypalCreateSubscription,
  paypalVerifyWebhook,
  paypalHandleEvent,
};
