// server-api/routes/pricing.js
const express = require("express");
const router = express.Router();

// Public prices (dev placeholders; swap to live if desired)
router.get("/public/plans", (_req, res) => {
  res.json({
    monthly: { growth: 199, essentials: 599, custom: null },
    yearly: { growth: 149, essentials: 449, custom: null },
    titles: {
      growth: "Growth plan",
      essentials: "App Essentials plan",
      custom: "Custom-made plan",
    },
  });
});

module.exports = router;
