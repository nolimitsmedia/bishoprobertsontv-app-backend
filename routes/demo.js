// server-api/routes/demo.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const nodemailer = require("nodemailer");

/* -------------------------------
   Email transport (lazy, cached)
-------------------------------- */
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn("[demo] SMTP not configured; skipping email sends.");
    return null;
  }

  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    Number(SMTP_PORT) === 465;

  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure, // true for 465, false for 587/25
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return _transporter;
}

function renderEmail({
  plan_card,
  first_name,
  last_name,
  email,
  company,
  phone,
  heard_about,
  primary_product,
  industry,
  notes,
}) {
  const planNice =
    plan_card === "custom"
      ? "Custom-made"
      : plan_card === "growth"
      ? "Growth"
      : "App Essentials";

  const subject = `New Demo Request — ${planNice} — ${first_name} ${last_name}`;
  const text = `
New demo request

Plan: ${planNice}
Name: ${first_name} ${last_name}
Email: ${email}
Company: ${company || "-"}
Phone: ${phone || "-"}

Heard about us: ${heard_about || "-"}
Primary product: ${primary_product || "-"}
Industry: ${industry || "-"}
Notes:
${notes || "-"}

Sent ${new Date().toISOString()}
  `.trim();

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4">
    <h2 style="margin:0 0 8px">New Demo Request</h2>
    <p style="margin:0 0 12px;color:#374151">Plan: <strong>${planNice}</strong></p>

    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb">
      <tbody>
        <tr><td><strong>Name</strong></td><td>${first_name} ${last_name}</td></tr>
        <tr><td><strong>Email</strong></td><td>${email}</td></tr>
        <tr><td><strong>Company</strong></td><td>${company || "-"}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${phone || "-"}</td></tr>
        <tr><td><strong>Heard about us</strong></td><td>${
          heard_about || "-"
        }</td></tr>
        <tr><td><strong>Primary product</strong></td><td>${
          primary_product || "-"
        }</td></tr>
        <tr><td><strong>Industry</strong></td><td>${industry || "-"}</td></tr>
      </tbody>
    </table>

    <p style="margin:12px 0 6px"><strong>Notes</strong></p>
    <pre style="margin:0;padding:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;white-space:pre-wrap">${(
      notes || "-"
    )
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>

    <p style="color:#6b7280;margin-top:12px">Sent ${new Date().toLocaleString()}</p>
  </div>`.trim();

  return { subject, text, html };
}

async function sendTeamEmail(payload) {
  const transporter = getTransporter();
  const to = process.env.DEMO_TEAM_TO;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transporter || !to) {
    console.warn("[demo] Email skipped — transporter or DEMO_TEAM_TO not set.");
    return;
  }

  const { subject, text, html } = renderEmail(payload);
  await transporter.sendMail({ from, to, subject, text, html });
}

/* ---------------------------------
   POST /api/demo
---------------------------------- */
router.post("/", async (req, res) => {
  try {
    const {
      plan_card,
      first_name,
      last_name,
      email,
      company,
      phone,
      heard_about,
      primary_product,
      industry,
      notes,
    } = req.body || {};

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Store in DB (optional; no-op if table missing)
    const q = `
      INSERT INTO demo_requests
        (plan_card, first_name, last_name, email, company, phone,
         heard_about, primary_product, industry, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, created_at
    `;
    const values = [
      (plan_card || "").toLowerCase(),
      first_name,
      last_name,
      email,
      company || null,
      phone || null,
      heard_about || null,
      primary_product || null,
      industry || null,
      notes || null,
    ];

    let row = null;
    try {
      const ins = await db.query(q, values);
      row = ins.rows[0];
    } catch (e) {
      console.warn("[demo] insert failed (table missing?):", e.message);
    }

    // Send the email (do not block the response on failures)
    sendTeamEmail({
      plan_card,
      first_name,
      last_name,
      email,
      company,
      phone,
      heard_about,
      primary_product,
      industry,
      notes,
    }).catch((e) => console.warn("[demo] email failed:", e.message));

    return res.json({
      ok: true,
      id: row?.id || null,
      created_at: row?.created_at || new Date(),
    });
  } catch (e) {
    console.error("demo submit error:", e);
    res.status(500).json({ error: "Unable to submit demo request." });
  }
});

module.exports = router;
