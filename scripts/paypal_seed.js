#!/usr/bin/env node
// --- ONE set of imports (no duplicates) ---
const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    "..",
    process.env.NODE_ENV === "production" ? ".env.production" : ".env"
  ),
});
const fs = require("fs");
const axios = require("axios");

// --- ENV + constants ---
const {
  PAYPAL_ENV = "sandbox",
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_PRODUCT_ID, // optional: reuse an existing product
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in env");
  process.exit(1);
}

const BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "plans.json"), "utf8")
);
const out = { product_id: null, plans: {} };

// --- helpers ---
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

async function createProduct(token) {
  if (PAYPAL_PRODUCT_ID) {
    console.log("Using existing PayPal product:", PAYPAL_PRODUCT_ID);
    return PAYPAL_PRODUCT_ID;
  }
  const body = {
    name: data.product.name,
    description: data.product.description || "BishopTV subscription product",
    type: "SERVICE",
    category: "SOFTWARE",
  };
  const res = await axios.post(`${BASE}/v1/catalogs/products`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  console.log("Created PayPal product:", res.data.id);
  return res.data.id;
}

/**
 * Create a plan with optional trial
 * @param {string} token
 * @param {object} opt { name, product_id, currency, trial_days, interval_unit, interval_count, price_value }
 */
async function createPlan(token, opt) {
  const {
    name,
    product_id,
    currency,
    trial_days = 0,
    interval_unit,
    interval_count,
    price_value,
  } = opt;

  const billing_cycles = [];
  if (trial_days > 0) {
    billing_cycles.push({
      frequency: { interval_unit: "DAY", interval_count: trial_days },
      tenure_type: "TRIAL",
      sequence: 1,
      total_cycles: 1,
    });
  }
  billing_cycles.push({
    frequency: { interval_unit, interval_count },
    tenure_type: "REGULAR",
    sequence: 2,
    total_cycles: 0, // 0 = infinite
    pricing_scheme: {
      fixed_price: { value: String(price_value), currency_code: currency },
    },
  });

  const body = {
    product_id,
    name,
    status: "ACTIVE",
    billing_cycles,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: "0", currency_code: currency },
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 3,
    },
    taxes: { percentage: "0", inclusive: false },
  };

  const res = await axios.post(`${BASE}/v1/billing/plans`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

// --- main ---
(async () => {
  console.log("Seeding PayPal product & plans...");
  const token = await oauthToken();

  // Create or reuse product
  const product_id = await createProduct(token);
  out.product_id = product_id;

  // Create plans from plans.json
  for (const p of data.plans) {
    const trial_days = Number(data.trial_days || 0);
    const currency = data.currency || "USD";

    // Monthly
    const monthlyPrice = Number(p.monthly);
    const monthly = await createPlan(token, {
      name: `${p.name} (Monthly)`,
      product_id,
      currency,
      trial_days,
      interval_unit: "MONTH",
      interval_count: 1,
      price_value: monthlyPrice,
    });
    out.plans[`${p.id}_monthly`] = monthly.id;
    console.log(`  + plan monthly: ${monthly.id}  $${monthlyPrice}/mo`);

    // Yearly (12 × yearly monthly equivalent)
    const yearlyMonthlyEq = Number(p.yearly_monthly_equivalent || p.monthly);
    const yearlyPrice = yearlyMonthlyEq * 12;
    const yearly = await createPlan(token, {
      name: `${p.name} (Yearly)`,
      product_id,
      currency,
      trial_days,
      interval_unit: "YEAR",
      interval_count: 1,
      price_value: yearlyPrice,
    });
    out.plans[`${p.id}_yearly`] = yearly.id;
    console.log(`  + plan yearly: ${yearly.id}  $${yearlyPrice}/yr`);
  }

  const outFile = path.join(__dirname, "paypal-created.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outFile}`);

  console.log("\nUpdate your .env with:");
  for (const k of Object.keys(out.plans)) {
    const [plan, cycle] = k.split("_");
    const envKey = `PAYPAL_PLAN_ID_${plan.toUpperCase()}_${cycle.toUpperCase()}`;
    console.log(`${envKey}=${out.plans[k]}`);
  }
  process.exit(0);
})().catch((e) => {
  if (e.response) {
    console.error(
      "PayPal API error:",
      JSON.stringify(e.response.data, null, 2)
    );
  } else {
    console.error(e);
  }
  process.exit(1);
});
