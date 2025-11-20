// server-api/routes/checkout.js
const express = require("express");
const { stripeCreateCheckout } = require("../billing/stripe");
const { paypalCreateSubscription } = require("../billing/paypal");

const router = express.Router();

// GET /api/checkout/start?plan=growth&cycle=monthly&email=foo@bar.com
router.get("/checkout/start", async (req, res) => {
  try {
    const plan = String(req.query.plan || "");
    const cycle = String(req.query.cycle || "monthly").toLowerCase();
    const email = req.query.email ? String(req.query.email) : undefined;

    if (!["growth", "essentials", "custom"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }
    if (!["monthly", "yearly"].includes(cycle)) {
      return res.status(400).json({ error: "Invalid cycle" });
    }
    if (plan === "custom") {
      return res.json({ url: `${process.env.PUBLIC_URL}/contact?plan=custom` });
    }

    if (process.env.BILLING_PROVIDER === "stripe") {
      const out = await stripeCreateCheckout({
        plan,
        cycle,
        customerEmail: email,
      });
      return res.json({ ...out, provider: "stripe" });
    } else {
      const out = await paypalCreateSubscription({ plan, cycle });
      return res.json({ ...out, provider: "paypal" });
    }
  } catch (e) {
    console.error("checkout/start error:", e.message);
    res.status(500).json({ error: "Checkout failed" });
  }
});

module.exports = router;
