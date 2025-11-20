// server-api/billing/entitlements.js
/**
 * Centralized plan features & quotas.
 * Units:
 *  - storage_hours: total hosted video hours allowed (base + add-ons)
 *  - live_hours_monthly: free live streaming hours per calendar month
 *  - support: "basic" | "onboarding" | "vip"
 */

const PLAN_DEFS = {
  growth: {
    label: "Growth",
    features: {
      catalog: true,
      monetization: true,
      analytics_basic: true,
      analytics_advanced: false,
      marketing_tools: true,
      website_builder: true,
      gated_zoom: true,
      mobile_apps: 0, // 0 = not included
      tv_apps: 0,
      api_access: false,
      group_subscriptions: false,
      white_label: false,
    },
    quotas: {
      storage_hours: 100,
      live_hours_monthly: 1,
    },
    support: "basic", // chat + email
  },

  essentials: {
    label: "App Essentials",
    features: {
      catalog: true,
      monetization: true,
      analytics_basic: true,
      analytics_advanced: true,
      marketing_tools: true,
      website_builder: true,
      gated_zoom: true,
      mobile_apps: 2, // "2 Mobile Apps"
      tv_apps: 0,
      api_access: false,
      group_subscriptions: false,
      white_label: false,
    },
    quotas: {
      storage_hours: 100,
      live_hours_monthly: 1,
    },
    support: "onboarding", // + onboarding + migration support
  },

  custom: {
    label: "Custom",
    features: {
      catalog: true,
      monetization: true,
      analytics_basic: true,
      analytics_advanced: true,
      marketing_tools: true,
      website_builder: true,
      gated_zoom: true,
      mobile_apps: 2,
      tv_apps: 5,
      api_access: true,
      group_subscriptions: true,
      white_label: true,
    },
    quotas: {
      storage_hours: null, // null = negotiated / unlimited
      live_hours_monthly: null, // null = negotiated / unlimited
    },
    support: "vip", // dedicated manager + SLA
  },
};

/**
 * Add-on SKUs you can attach in DB (admin tool or webhooks):
 *  - STORAGE_PACK_100H increments storage_hours by 100
 *  - LIVE_PACK_10H increments live_hours_monthly by 10
 */
const ADD_ON_DEFS = {
  STORAGE_PACK_100H: { storage_hours: 100 },
  LIVE_PACK_10H: { live_hours_monthly: 10 },
};

module.exports = { PLAN_DEFS, ADD_ON_DEFS };
