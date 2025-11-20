#!/usr/bin/env node
require("dotenv").config();
const Stripe = require("stripe");

const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    "..",
    process.env.NODE_ENV === "production" ? ".env.production" : ".env"
  ),
});

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Missing STRIPE_SECRET_KEY");
  process.exit(1);
}
const url =
  process.env.WEBHOOK_URL_STRIPE ||
  `${process.env.API_BASE || "http://localhost:5000"}/api/webhooks/stripe`;

const stripe = new Stripe(key, { apiVersion: "2024-06-20" });

(async () => {
  console.log("Creating Stripe webhook endpoint for:", url);
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    description: "BishopTV API Webhook",
    enabled_events: [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
      "customer.subscription.trial_will_end",
    ],
  });

  // The secret is ONLY returned on creation — copy it now.
  console.log("\n✅ Created webhook endpoint:");
  console.log("  id:", endpoint.id);
  console.log("  status:", endpoint.status);
  console.log("\n🔑 STRIPE_WEBHOOK_SECRET (save in env):");
  console.log(endpoint.secret);
  console.log("\nAdd to .env(.production):");
  console.log("STRIPE_WEBHOOK_SECRET=" + endpoint.secret);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
