// server/billing/config.js
export const PLAN_META = {
  growth: {
    title: "Growth plan",
    featuresCore: [
      "Unlimited bandwidth",
      "100 hours of video storage",
      "1 free hour of live streaming",
      "Chat + e-mail support",
    ],
    featuresAccess: [
      "Netflix-style catalog",
      "Monetize your way",
      "Analytics on steroids",
      "Marketing tools & automations",
      "Build your own website",
      "Gated Zoom links",
    ],
  },
  essentials: {
    title: "App Essentials plan",
    featuresCore: [
      "Unlimited bandwidth",
      "100 hours of video storage",
      "1 free hour of live streaming",
      "Chat + e-mail support",
      "Onboarding support",
      "Migration support (users, payments, content)",
    ],
    featuresAccess: [
      "Everything in Growth, plus",
      "2 Mobile Apps",
      "Video storage packs (100 hours per pack)",
      "Live streaming packs (10 hours per pack)",
      "Advanced analytics",
    ],
  },
  custom: {
    title: "Custom-made plan",
    featuresCore: [
      "Unlimited bandwidth",
      "Custom video storage",
      "Custom live streaming hours",
      "Dedicated success manager",
      "Migration support (users, payments, content)",
      "White labeling",
      "VIP support with SLA",
    ],
    featuresAccess: [
      "2 Mobile Apps",
      "5 TV apps",
      "API access",
      "Advanced analytics",
      "Sell B2B with Group Subscriptions",
    ],
  },
};

export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

// Copy of Uscreen-style rules
export const BILLING_POLICY = {
  trial: { days: TRIAL_DAYS }, // 14-day free trial
  upgrade: { when: "immediate", proration: true }, // immediate + prorated
  downgrade: { when: "period_end", proration: false },
  cancel: { access_until_period_end: true },
  refund: { policy: "no_proration_refunds_after_trial" }, // mirror typical SaaS
};
