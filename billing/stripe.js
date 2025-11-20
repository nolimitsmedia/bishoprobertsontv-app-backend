// server-api/billing/stripe.js
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

const priceIds = () => ({
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    yearly: process.env.STRIPE_PRICE_GROWTH_YEARLY,
  },
  essentials: {
    monthly: process.env.STRIPE_PRICE_ESSENTIALS_MONTHLY,
    yearly: process.env.STRIPE_PRICE_ESSENTIALS_YEARLY,
  },
});

async function stripeCreateCheckout({ plan, cycle, customerEmail }) {
  if (!stripe) throw new Error("Stripe not configured");
  const price = (priceIds()[plan] || {})[cycle];
  if (!price) throw new Error("Unknown Stripe price for plan/cycle");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    allow_promotion_codes: true,
    customer_email: customerEmail || undefined,
    line_items: [{ price, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS || undefined,
    },
    success_url: `${process.env.PUBLIC_URL}/subscribe/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.PUBLIC_URL}/pricing?canceled=1`,
  });

  return { url: session.url };
}

async function stripeHandleWebhook(req) {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);

  switch (event.type) {
    case "customer.subscription.created": {
      const sub = event.data.object;
      const meterPrice = process.env.STRIPE_PRICE_METERED_SUBSCRIBER;
      if (meterPrice) {
        const has = (sub.items?.data || []).some(
          (it) => it.price?.id === meterPrice
        );
        if (!has) {
          await stripe.subscriptionItems.create({
            subscription: sub.id,
            price: meterPrice,
          });
        }
      }
      // TODO: upsert subscription in DB
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "checkout.session.completed":
    case "customer.subscription.trial_will_end":
      // TODO: sync to DB
      break;
  }
  return { received: true };
}

module.exports = {
  stripeCreateCheckout,
  stripeHandleWebhook,
};
