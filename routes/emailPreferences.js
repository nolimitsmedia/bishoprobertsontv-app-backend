// server-api/routes/emailPreferences.js
// Email preferences + unsubscribe (no sign-in needed: the link in each email
// carries a private token). Mount: app.use("/api/email-preferences", …)
//
// GET  /?token=…                     the person's choices
// POST /            { token, lists?, unsubscribed_all? }
// GET  /me          (signed in) → { token } for "Email preferences" in the account
// GET  /unsubscribe?token=…&list=…   link click → unsubscribes, shows the preferences page
// POST /unsubscribe?token=…&list=…   one-click unsubscribe from the inbox (RFC 8058)

const express = require("express");
const router = express.Router();
const T = require("../services/emailTemplates");
const { requireAuth } = require("../middleware/auth");

function mask(email) {
  const [u, d] = String(email).split("@");
  if (!d) return "";
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
}

async function view(p) {
  const live = await T.liveSignedUp(p.email);
  return {
    ok: true,
    email: mask(p.email),
    unsubscribed_all: !!p.unsubscribed_all,
    lists: Object.entries(T.LISTS).map(([key, l]) => ({
      key,
      label: l.label,
      help: l.help,
      on: key === "live" && live === false ? false : p.lists?.[key] !== false,
    })),
  };
}

router.get("/", async (req, res) => {
  try {
    const p = await T.prefsByToken(req.query.token);
    if (!p)
      return res
        .status(404)
        .json({
          ok: false,
          error: "This link isn’t valid. Use the link from a recent email.",
        });
    res.json(await view(p));
  } catch (e) {
    console.error("[emailPreferences] GET error:", e);
    res
      .status(500)
      .json({ ok: false, error: "Could not load your email preferences." });
  }
});

router.post("/", async (req, res) => {
  try {
    const p = await T.updatePrefs(req.body?.token, {
      lists: req.body?.lists,
      unsubscribed_all: req.body?.unsubscribed_all,
    });
    if (!p)
      return res
        .status(404)
        .json({ ok: false, error: "This link isn’t valid." });
    res.json(await view(p));
  } catch (e) {
    console.error("[emailPreferences] POST error:", e);
    res.status(500).json({ ok: false, error: "Could not save your choices." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email)
      return res
        .status(400)
        .json({ ok: false, error: "No email on this account." });
    const p = await T.prefsFor(email);
    res.json({ ok: true, token: p.token });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "Could not open your email preferences." });
  }
});

async function unsubscribe(req) {
  const list = String(req.query.list || "");
  const token = req.query.token;
  if (T.LISTS[list]) return T.updatePrefs(token, { lists: { [list]: false } });
  return T.updatePrefs(token, { unsubscribed_all: true });
}

router.post("/unsubscribe", async (req, res) => {
  try {
    const p = await unsubscribe(req);
    res.status(p ? 200 : 404).json({ ok: !!p });
  } catch {
    res.status(500).json({ ok: false });
  }
});

router.get("/unsubscribe", async (req, res) => {
  let done = false;
  try {
    done = !!(await unsubscribe(req));
  } catch {
    /* show the page anyway */
  }
  const list = T.LISTS[String(req.query.list || "")]
    ? String(req.query.list)
    : "all";
  const token = /^[a-f0-9]{32,64}$/.test(String(req.query.token || ""))
    ? String(req.query.token)
    : "";
  res.redirect(
    302,
    T.sitePage(
      `email-preferences?token=${token}&unsubscribed=${done ? list : "invalid"}`,
    ),
  );
});

module.exports = router;
