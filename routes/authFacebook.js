const router = require("express").Router();

// TODO: replace with DB lookup later
let connected = false;

router.get("/status", (req, res) => {
  res.json({ ok: true, connected });
});

module.exports = router;
