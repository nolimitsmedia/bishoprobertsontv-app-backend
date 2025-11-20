// server-api/routes/dev-email.js
const express = require("express");
const router = express.Router();
const { sendEmail, sendWelcomeEmail } = require("../services/mailer"); // <- Mailgun

router.post("/emails/test", async (req, res) => {
  try {
    const { to, template, name } = req.body || {};
    if (!to) return res.status(400).json({ message: "`to` is required" });

    let out;
    if (template === "welcome") {
      out = await sendWelcomeEmail({ to, name: name || "there" });
    } else {
      out = await sendEmail({
        to,
        subject: "Mailgun test",
        text: "Hello from Bishop via Mailgun.",
        html: "<p>Hello from <b>Bishop</b> via Mailgun.</p>",
      });
    }

    res.json({ ok: true, id: out?.id || null });
  } catch (e) {
    console.error("[/emails/test] error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
