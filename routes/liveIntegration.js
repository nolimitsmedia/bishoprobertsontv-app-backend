// server-api/routes/liveIntegration.js
//
// Release 2.2 Part A — Live streaming integration (Integration › Live Streaming).
// One live status for the whole site, whatever platform streams it:
//
//   provider "nlm"      NLM Stream Control (default; channel status from its API)
//            "youtube"  YouTube Live (real detection with an API key)
//            "embed"    any platform's embed code (Restream, Boxcast, Facebook…)
//            "hls"      a direct .m3u8 stream from the customer's own server
//            "none"     live features hidden
//
// Schedule: the site's Calendar (live events), for every provider. A provider
// without live detection is "live" during a Calendar event's time window, or
// while the manual "We're live now" switch is on.
//
//   GET  /api/live-status                public: { state, next_live_at, title, player }
//   GET  /api/live-settings/admin        settings (secrets masked)
//   PUT  /api/live-settings/admin        save
//   POST /api/live-settings/admin/test   check a provider with the given settings
//
// API keys are encrypted at rest (AES-256-GCM) and never sent back in full.

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const db = require("../db");
const { requireArea } = require("../lib/teamAccess");
const sc = require("./streamcontrol").helpers || {};

const publicRouter = express.Router(); // mounted at /api/live-status
const adminRouter = express.Router(); // mounted at /api/live-settings

const KEY = "live_settings";
const PROVIDERS = new Set(["nlm", "youtube", "embed", "hls", "none"]);
const DEFAULTS = {
  provider: "nlm",
  title: "",
  on_air: false,
  chat_enabled: true,
  window_minutes: 120,
  nlm: { channel_id: "" },
  youtube: { channel_id: "", video_id: "" },
  embed: { code: "" },
  hls: { url: "" },
};

// ---------- secrets ----------
function cryptoKey() {
  return crypto
    .createHash("sha256")
    .update(`${process.env.JWT_SECRET || "brtv"}|live-settings`)
    .digest();
}
function encrypt(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}
function decrypt(blob) {
  try {
    const [v, iv, tag, data] = String(blob || "").split(":");
    if (v !== "v1") return "";
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      cryptoKey(),
      Buffer.from(iv, "base64"),
    );
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(data, "base64")),
      d.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

// ---------- settings ----------
async function readSettings() {
  try {
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key = $1",
      [KEY],
    );
    const s = rows[0]?.published_json || {};
    return {
      ...DEFAULTS,
      ...s,
      nlm: { ...DEFAULTS.nlm, ...(s.nlm || {}) },
      youtube: { ...DEFAULTS.youtube, ...(s.youtube || {}) },
      embed: { ...DEFAULTS.embed, ...(s.embed || {}) },
      hls: { ...DEFAULTS.hls, ...(s.hls || {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// The settings with secrets replaced by "set / last 4" (for the admin screen).
function masked(s) {
  const key = decrypt(s.youtube?.api_key_enc);
  const { api_key_enc, ...yt } = s.youtube || {};
  return {
    ...s,
    youtube: {
      ...yt,
      has_api_key: !!key,
      api_key_last4: key ? key.slice(-4) : "",
    },
  };
}

const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
// Only an https address is used from an embed code (never scripts).
function embedSrc(code) {
  const s = String(code || "").trim();
  const m = s.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  const url = (m ? m[1] : s).replace(/&amp;/g, "&").trim();
  return /^https:\/\/[^\s<>"']+$/i.test(url) ? url : "";
}

function cleanInput(body, current) {
  const b = body && typeof body === "object" ? body : {};
  const provider = PROVIDERS.has(b.provider) ? b.provider : current.provider;
  const next = {
    provider,
    title: str(b.title, 120),
    on_air: b.on_air === true,
    chat_enabled: b.chat_enabled !== false,
    window_minutes: Math.min(
      600,
      Math.max(15, Number.parseInt(b.window_minutes, 10) || 120),
    ),
    nlm: {
      channel_id: str(b.nlm?.channel_id, 80).replace(/[^A-Za-z0-9_-]/g, ""),
    },
    youtube: {
      channel_id: str(b.youtube?.channel_id, 64).replace(/[^A-Za-z0-9_-]/g, ""),
      video_id: str(b.youtube?.video_id, 32).replace(/[^A-Za-z0-9_-]/g, ""),
      api_key_enc: current.youtube?.api_key_enc || "",
    },
    embed: { code: str(b.embed?.code, 4000) },
    hls: { url: str(b.hls?.url, 800) },
  };
  // API key: a new value replaces it; "" keeps it; remove_api_key clears it.
  if (b.youtube?.remove_api_key === true) next.youtube.api_key_enc = "";
  else if (str(b.youtube?.api_key, 200))
    next.youtube.api_key_enc = encrypt(str(b.youtube.api_key, 200));
  const errors = [];
  if (provider === "embed" && next.embed.code && !embedSrc(next.embed.code))
    errors.push("The embed code must contain an https address.");
  if (
    provider === "hls" &&
    next.hls.url &&
    !/^https:\/\/[^\s<>"']+\.m3u8(\?[^\s<>"']*)?$/i.test(next.hls.url)
  )
    errors.push("The stream address must be an https link ending in .m3u8.");
  if (
    provider === "youtube" &&
    !next.youtube.channel_id &&
    !next.youtube.video_id
  )
    errors.push("Enter the YouTube channel ID (or a live video ID).");
  return { next, errors };
}

// ---------- schedule (Calendar) ----------
// Content › Calendar: one-off and repeating "live" events (lib/liveSchedule.js).
async function calendar(windowMinutes) {
  const schedule = require("../lib/liveSchedule");
  const iso = (e) =>
    e && {
      id: e.key,
      title: e.title,
      start_at: e.start_at.toISOString(),
      end_at: e.end_at ? e.end_at.toISOString() : null,
    };
  const [next, current] = await Promise.all([
    schedule.nextLive().catch(() => null),
    schedule.currentLive(new Date(), windowMinutes).catch(() => null),
  ]);
  return { next: iso(next), current: iso(current) };
}

// ---------- providers ----------
async function providerStatus(s) {
  const p = s.provider;
  if (p === "none") return { detected: null, player: null };
  if (p === "nlm") {
    const id = s.nlm.channel_id || process.env.STREAMCONTROL_CHANNEL_ID || "";
    if (!id || !sc.normalizeChannel) return { detected: null, player: null };
    let ch;
    try {
      ch = sc.normalizeChannel(
        await sc.scRequestAnyVersion("get", `/channels/${id}`),
      );
    } catch {
      ch = sc.fallbackChannel ? sc.fallbackChannel(id) : null;
      if (ch) ch.online = null; // unknown
    }
    if (!ch) return { detected: null, player: null };
    return {
      detected: typeof ch.online === "boolean" ? ch.online : null,
      player: ch.player_iframe_src
        ? { type: "iframe", src: ch.player_iframe_src }
        : ch.hls_url
          ? { type: "hls", src: ch.hls_url }
          : null,
    };
  }
  if (p === "youtube") {
    const key = decrypt(s.youtube.api_key_enc);
    let videoId = s.youtube.video_id;
    let detected = null;
    if (key && s.youtube.channel_id) {
      try {
        const { data } = await axios.get(
          "https://www.googleapis.com/youtube/v3/search",
          {
            params: {
              part: "id",
              channelId: s.youtube.channel_id,
              eventType: "live",
              type: "video",
              key,
            },
            timeout: 5000,
          },
        );
        const live = (data?.items || [])[0]?.id?.videoId;
        detected = !!live;
        if (live) videoId = live;
      } catch {
        detected = null; // quota or network: fall back to the Calendar / switch
      }
    }
    const src = videoId
      ? `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`
      : s.youtube.channel_id
        ? `https://www.youtube.com/embed/live_stream?channel=${s.youtube.channel_id}&autoplay=1`
        : "";
    return { detected, player: src ? { type: "iframe", src } : null };
  }
  if (p === "embed") {
    const src = embedSrc(s.embed.code);
    return { detected: null, player: src ? { type: "iframe", src } : null };
  }
  if (p === "hls") {
    const url = s.hls.url;
    if (!url) return { detected: null, player: null };
    let detected = null;
    try {
      const { data, status } = await axios.get(url, {
        timeout: 4000,
        responseType: "text",
        maxContentLength: 200000,
      });
      detected = status === 200 && String(data).includes("#EXTM3U");
    } catch {
      detected = false;
    }
    return { detected, player: { type: "hls", src: url } };
  }
  return { detected: null, player: null };
}

async function computeStatus(s) {
  if (s.provider === "none")
    return { ok: true, provider: "none", state: "disabled" };
  const [{ next, current }, prov] = await Promise.all([
    calendar(s.window_minutes),
    providerStatus(s),
  ]);
  // Live: the manual switch, else the provider's real status when it has one,
  // else a Calendar live event happening now.
  const live =
    s.on_air || prov.detected === true || (prov.detected === null && !!current);
  const state = live ? "live" : next?.start_at ? "upcoming" : "offline";
  return {
    ok: true,
    provider: s.provider,
    state,
    title: s.title || (live ? current?.title : next?.title) || "",
    next_live_at: next?.start_at || null,
    player: prov.player,
    chat: s.chat_enabled !== false,
  };
}

let cache = { at: 0, value: null };
publicRouter.get("/", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!cache.value || Date.now() - cache.at > 15000) {
      cache = {
        at: Date.now(),
        value: await computeStatus(await readSettings()),
      };
    }
    res.json(cache.value);
  } catch (e) {
    console.error("[live] status failed:", e?.message || e);
    res.json({
      ok: true,
      provider: "unknown",
      state: "offline",
      next_live_at: null,
      player: null,
    });
  }
});

// ---------- admin ----------
const access = requireArea("website");

adminRouter.get("/admin", access, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    settings: masked(await readSettings()),
    env_channel_id: process.env.STREAMCONTROL_CHANNEL_ID || "",
  });
});

adminRouter.put("/admin", access, express.json(), async (req, res) => {
  try {
    const current = await readSettings();
    const { next, errors } = cleanInput(req.body, current);
    if (errors.length)
      return res.status(400).json({ ok: false, error: errors.join(" ") });
    await db.query(
      `INSERT INTO site_design_settings (setting_key, draft_json, published_json, published_at)
       VALUES ($1, $2::jsonb, $2::jsonb, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET draft_json = EXCLUDED.draft_json,
         published_json = EXCLUDED.published_json, published_at = NOW(), updated_at = NOW()`,
      [KEY, JSON.stringify(next)],
    );
    cache = { at: 0, value: null }; // show the change right away
    res.json({ ok: true, settings: masked(next) });
  } catch (e) {
    console.error("[live] save failed:", e);
    res.status(500).json({ ok: false, error: "Unable to save live settings" });
  }
});

adminRouter.post("/admin/test", access, express.json(), async (req, res) => {
  try {
    const current = await readSettings();
    const { next, errors } = cleanInput(req.body, current);
    if (errors.length)
      return res.status(400).json({ ok: false, error: errors.join(" ") });
    const status = await computeStatus(next);
    const prov = await providerStatus(next);
    let message;
    if (next.provider === "none") message = "Live features are turned off.";
    else if (!prov.player)
      message = "No player could be set up. Check the settings above.";
    else if (prov.detected === true)
      message = "Connected: the stream is LIVE right now.";
    else if (prov.detected === false)
      message = "Connected: the stream is offline right now.";
    else
      message =
        "Player ready. Live status follows your Calendar and the “We’re live now” switch.";
    res.json({ ok: true, message, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: "The test could not run." });
  }
});

module.exports = { publicRouter, adminRouter, embedSrc, encrypt, decrypt };
