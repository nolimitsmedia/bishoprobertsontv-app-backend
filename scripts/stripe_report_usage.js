#!/usr/bin/env node
require("dotenv").config();
const Stripe = require("stripe");
const axios = require("axios");

const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    "..",
    process.env.NODE_ENV === "production" ? ".env.production" : ".env"
  ),
});

const key = process.env.STRIPE_SECRET_KEY;
const METERED_PRICE = process.env.STRIPE_PRICE_METERED_SUBSCRIBER; // from seed output
if (!key || !METERED_PRICE) {
  console.error("Missing STRIPE_SECRET_KEY or STRIPE_PRICE_METERED_SUBSCRIBER");
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: "2024-06-20" });

// OPTIONAL: Your internal API to compute counts, e.g. http://api.../internal/active-subscribers?customer=...
const USAGE_SOURCE_URL = process.env.USAGE_SOURCE_URL || ""; // leave blank to return 0

async function computeActiveSubscribers({ customer, subscription }) {
  // TODO: replace this with your DB logic. If you expose an internal endpoint, call it here:
  if (USAGE_SOURCE_URL) {
    try {
      const { data } = await axios.get(USAGE_SOURCE_URL, {
        params: { customer, subscription },
      });
      if (typeof data?.count === "number") return data.count;
    } catch (e) {
      console.warn("usage source failed:", e.message);
    }
  }
  // Fallback: 0
  return 0;
}

(async () => {
  console.log("Reporting usage for metered price:", METERED_PRICE);

  // Find all active subscription items that use the metered price
  const items = [];
  let starting_after;
  for (;;) {
    const page = await stripe.subscriptionItems.list({
      price: METERED_PRICE,
      limit: 100,
      starting_after,
      expand: ["data.subscription", "data.subscription.customer"],
    });
    items.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }

  console.log(`Found ${items.length} metered subscription items`);
  const now = Math.floor(Date.now() / 1000);

  for (const it of items) {
    const sub =
      typeof it.subscription === "string"
        ? { id: it.subscription }
        : it.subscription;
    const customer =
      typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

    const qty = await computeActiveSubscribers({
      customer,
      subscription: sub.id,
    });
    console.log(
      ` - ${it.id}  subscription=${sub.id}  customer=${customer}  active_subs=${qty}`
    );

    // We use "set" with aggregate_usage = last_during_period
    await stripe.subscriptionItems.createUsageRecord(it.id, {
      quantity: Math.max(0, Math.floor(qty)),
      timestamp: now,
      action: "set",
    });
  }

  console.log("Done.");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
