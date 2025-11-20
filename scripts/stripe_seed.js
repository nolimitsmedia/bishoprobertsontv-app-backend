#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    "..",
    process.env.NODE_ENV === "production" ? ".env.production" : ".env"
  ),
});

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY in env");
  process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "plans.json"), "utf8")
);
const out = { products: {}, prices: {}, addons: {} };
const toCents = (n) => Math.round(Number(n) * 100);

async function findExistingProductByCode(code) {
  const list = await stripe.products.list({ limit: 100, active: true });
  return list.data.find((p) => p.metadata?.plan_id === code) || null;
}

(async () => {
  console.log("Seeding Stripe products & prices...");
  for (const p of data.plans) {
    const code = p.id;
    const name = p.name;

    let product = await findExistingProductByCode(code);
    if (!product) {
      product = await stripe.products.create({
        name,
        description: p.description || data.product.description || undefined,
        metadata: { plan_id: code },
      });
      console.log("Created product:", product.id, name);
    } else {
      console.log("Using existing product:", product.id, name);
    }
    out.products[code] = product.id;

    const monthlyCents = toCents(p.monthly);
    const yearlyCents = toCents(
      (p.yearly_monthly_equivalent || p.monthly) * 12
    );

    const monthlyPrice = await stripe.prices.create({
      unit_amount: monthlyCents,
      currency: data.currency.toLowerCase(),
      recurring: { interval: "month" },
      product: product.id,
      metadata: { plan_id: code, cycle: "monthly" },
    });
    out.prices[`${code}_monthly`] = monthlyPrice.id;
    console.log(`  + price (monthly): ${monthlyPrice.id}  $${p.monthly}/mo`);

    const yearlyPrice = await stripe.prices.create({
      unit_amount: yearlyCents,
      currency: data.currency.toLowerCase(),
      recurring: { interval: "year" },
      product: product.id,
      metadata: { plan_id: code, cycle: "yearly" },
    });
    out.prices[`${code}_yearly`] = yearlyPrice.id;
    console.log(
      `  + price (yearly): ${yearlyPrice.id}  $${yearlyCents / 100}/yr`
    );
  }

  // Metered per-subscriber add-on (billed monthly as the "last_during_period" value)
  const add = (data.addons || []).find((a) => a.id === "per_subscriber_fee");
  if (add) {
    const meteredProduct = await stripe.products.create({
      name: add.name,
      description: add.description || "Metered fee",
      metadata: { addon_id: add.id },
    });

    const meteredPrice = await stripe.prices.create({
      unit_amount: toCents(add.amount),
      currency: data.currency.toLowerCase(),
      product: meteredProduct.id,
      recurring: {
        interval: add.interval || "month",
        usage_type: "metered",
        aggregate_usage: "last_during_period",
      },
      billing_scheme: "per_unit",
      metadata: { addon_id: add.id, metered: "true" },
    });

    out.addons.per_subscriber_fee = meteredPrice.id;
    console.log(
      `Created metered add-on price: ${meteredPrice.id} ($${add.amount}/${
        add.interval || "month"
      })`
    );
  }

  const outFile = path.join(__dirname, "stripe-created.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outFile}`);

  console.log("\nUpdate your .env.production with:");
  for (const k of Object.keys(out.prices)) {
    const [plan, cycle] = k.split("_");
    const envKey = `STRIPE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`;
    console.log(`${envKey}=${out.prices[k]}`);
  }
  if (out.addons.per_subscriber_fee) {
    console.log(
      `STRIPE_PRICE_METERED_SUBSCRIBER=${out.addons.per_subscriber_fee}`
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
