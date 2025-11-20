require("dotenv").config();
const nodemailer = require("nodemailer");

(async () => {
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    Number(process.env.SMTP_PORT) === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.DEMO_TEAM_TO || process.env.SMTP_USER,
    subject: "SMTP test ✔",
    text: "Hello from BishopTV SMTP test.",
  });
  console.log("Sent:", info.messageId);
})();
