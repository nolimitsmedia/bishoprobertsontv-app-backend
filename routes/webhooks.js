// server-api/routes/webhooks.js
const { stripeHandleWebhook } = require("../billing/stripe");
const { paypalVerifyWebhook, paypalHandleEvent } = require("../billing/paypal");

// Handlers to be mounted with correct body parsers in index.js
async function stripeWebhookHandler(req, res) {
  try {
    const result = await stripeHandleWebhook(req);
    res.json(result);
  } catch (e) {
    console.error("Stripe webhook error:", e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

async function paypalWebhookHandler(req, res) {
  try {
    const ok = await paypalVerifyWebhook({
      body: req.body,
      headers: req.headers,
    });
    if (!ok) return res.status(400).send("Invalid PayPal signature");

    await paypalHandleEvent(req.body);
    res.json({ received: true });
  } catch (e) {
    console.error("PayPal webhook error:", e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

module.exports = { stripeWebhookHandler, paypalWebhookHandler };
