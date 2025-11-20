#!/usr/bin/env node
require("dotenv").config();
const axios = require("axios");

const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    "..",
    process.env.NODE_ENV === "production" ? ".env.production" : ".env"
  ),
});

const {
  PAYPAL_ENV = "sandbox",
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  WEBHOOK_URL_PAYPAL = "http://localhost:5000/api/webhooks/paypal",
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
  process.exit(1);
}
const BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function oauthToken() {
  const res = await axios({
    method: "post",
    url: `${BASE}/v1/oauth2/token`,
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: "grant_type=client_credentials",
  });
  return res.data.access_token;
}

(async () => {
  const token = await oauthToken();
  console.log("Creating PayPal webhook for:", WEBHOOK_URL_PAYPAL);

  const res = await axios.post(
    `${BASE}/v1/notifications/webhooks`,
    {
      url: WEBHOOK_URL_PAYPAL,
      event_types: [
        { name: "BILLING.SUBSCRIPTION.ACTIVATED" },
        { name: "BILLING.SUBSCRIPTION.UPDATED" },
        { name: "BILLING.SUBSCRIPTION.CANCELLED" },
        { name: "BILLING.SUBSCRIPTION.SUSPENDED" },
        { name: "BILLING.SUBSCRIPTION.RE-ACTIVATED" },
        { name: "PAYMENT.SALE.COMPLETED" },
        { name: "PAYMENT.SALE.DENIED" },
        { name: "PAYMENT.CAPTURE.COMPLETED" },
      ],
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  console.log("\n✅ Created PayPal webhook:");
  console.log("  id:", res.data.id);
  console.log("\nAdd to .env:");
  console.log("PAYPAL_WEBHOOK_ID=" + res.data.id);
})().catch((e) => {
  if (e.response) console.error("PayPal API error:", e.response.data);
  else console.error(e);
  process.exit(1);
});
