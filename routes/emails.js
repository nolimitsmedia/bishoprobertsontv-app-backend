const express = require("express");
const router = express.Router();
// If you want this protected, uncomment the next line:
// const authenticate = require("../middleware/authenticate");
const { sendEmail, sendWelcomeEmail } = require("../services/mailer");

// POST /api/emails/test
router.post(
  "/test",
  /*authenticate,*/ async (req, res) => {
    try {
      const { to, subject, text, html, template, name } = req.body || {};

      if (!to) {
        return res.status(400).json({ message: "`to` is required" });
      }

      let result;
      if (template === "welcome") {
        result = await sendWelcomeEmail({ to, name });
      } else {
        result = await sendEmail({
          to,
          subject: subject || "Test Email from Bishop Robertson App",
          text: text || "This is a test email sent via Mailgun.",
          html:
            html ||
            `<p>This is a <strong>test email</strong> sent via Mailgun.</p>`,
        });
      }

      res.json({
        ok: true,
        id: result?.id,
        message: result?.message || "Queued",
      });
    } catch (err) {
      console.error("[/emails/test] Error:", err);
      const code = err.status || 500;
      res.status(code).json({
        ok: false,
        error: err.message || "Email send failed",
      });
    }
  }
);

module.exports = router;
