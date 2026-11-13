// server-api/routes/liveChat.js
//
// Release 2.2 Part B — chat on the site's live page.
// Anyone can read; only signed-in members can post (name from their account,
// never from the browser); staff can delete messages.
//
//   GET    /api/live-chat/messages        recent messages (last 6 hours)
//   DELETE /api/live-chat/messages/:id    staff: remove a message
//   socket: "sitechat:join"  → join the room (read)
//           "sitechat:send"  { message } (auth token in the socket handshake)
//           emits "sitechat:new" and "sitechat:deleted"

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { requireArea, loadAccess } = require("../lib/teamAccess");

const router = express.Router();
const ROOM = "sitechat";
const MAX_LEN = 500;

function tokenUserId(token) {
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const p = jwt.verify(String(token).replace(/^Bearer\s+/i, ""), secret);
    const id = Number(p?.sub || p?.id || p?.userId || p?.user?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

router.get("/messages", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, name, message, created_at FROM site_live_chat
        WHERE deleted_at IS NULL AND created_at > NOW() - interval '6 hours'
        ORDER BY created_at DESC LIMIT 150`,
    );
    // ids as numbers everywhere (BIGSERIAL comes back as text), so live
    // "deleted" events match the messages on screen.
    res.json({
      ok: true,
      messages: rows
        .reverse()
        .map((m) => ({ ...m, id: Number(m.id), user_id: Number(m.user_id) })),
    });
  } catch (e) {
    if (String(e?.code) === "42P01")
      return res.json({ ok: true, messages: [], setup: false });
    res.status(500).json({ ok: false, error: "Chat is unavailable" });
  }
});

router.delete(
  "/messages/:id",
  requireArea("website", "community"),
  async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id))
      return res.status(400).json({ ok: false, error: "Invalid message" });
    try {
      const { rowCount } = await db.query(
        "UPDATE site_live_chat SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL",
        [id, req.access?.id || null],
      );
      if (!rowCount)
        return res.status(404).json({ ok: false, error: "Not found" });
      req.app.get("io")?.to(ROOM).emit("sitechat:deleted", { id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Could not delete" });
    }
  },
);

// Per-user slow-down: one message every 2 s, at most 10 per minute.
const recent = new Map();
function tooFast(userId) {
  const now = Date.now();
  const list = (recent.get(userId) || []).filter((t) => now - t < 60000);
  if (list.length && now - list[list.length - 1] < 2000)
    return "Please wait a moment between messages.";
  if (list.length >= 10)
    return "You're sending messages too quickly. Try again in a minute.";
  list.push(now);
  recent.set(userId, list);
  return "";
}

// Socket handlers (called from server.js with the shared io).
function attach(io) {
  io.on("connection", (socket) => {
    socket.on("sitechat:join", () => socket.join(ROOM));
    socket.on("sitechat:send", async (payload = {}, ack) => {
      const reply = (x) => typeof ack === "function" && ack(x);
      try {
        const userId = tokenUserId(socket.handshake?.auth?.token);
        if (!userId) return reply({ ok: false, error: "Sign in to chat." });
        const message = String(payload?.message || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_LEN);
        if (!message)
          return reply({ ok: false, error: "Write a message first." });
        const slow = tooFast(userId);
        if (slow) return reply({ ok: false, error: slow });
        const { rows: u } = await db.query(
          "SELECT name, email FROM users WHERE id = $1",
          [userId],
        );
        if (!u.length) return reply({ ok: false, error: "Sign in to chat." });
        const name = String(
          u[0].name || String(u[0].email || "").split("@")[0] || "Member",
        ).slice(0, 60);
        const { rows } = await db.query(
          "INSERT INTO site_live_chat (user_id, name, message) VALUES ($1, $2, $3) RETURNING id, created_at",
          [userId, name, message],
        );
        const msg = {
          id: Number(rows[0].id),
          user_id: userId,
          name,
          message,
          created_at: rows[0].created_at,
        };
        io.to(ROOM).emit("sitechat:new", msg);
        reply({ ok: true, message: msg });
      } catch (e) {
        console.error("[live chat] send failed:", e?.message || e);
        reply({ ok: false, error: "Your message could not be sent." });
      }
    });
  });
}

// ---------- Event-page chat (/watch/live/:id), Release 2.3 ----------
// Same protections as the live page chat. Guests may still post (event pages
// let visitors take part), but their name is marked "(guest)" so nobody can pass
// as a member or staff; members always post under their account name.
const ipOf = (socket) =>
  String(
    socket.handshake?.headers?.["x-forwarded-for"] ||
      socket.handshake?.address ||
      "",
  )
    .split(",")[0]
    .trim();
function guestName(raw) {
  const n = String(raw || "")
    .replace(/[\u0000-\u001f<>"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${n || "Guest"} (guest)`;
}
const eventIdOf = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function attachEventChat(io) {
  io.on("connection", (socket) => {
    socket.on("chat:join", (payload = {}) => {
      const eventId = eventIdOf(payload?.eventId);
      if (eventId) socket.join(`live:${eventId}`);
    });
    socket.on("chat:message", async (payload = {}, ack) => {
      const reply = (x) => typeof ack === "function" && ack(x);
      try {
        const eventId = eventIdOf(payload?.eventId);
        const message = String(payload?.message || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_LEN);
        if (!eventId || !message)
          return reply({ ok: false, error: "Write a message first." });
        const userId = tokenUserId(socket.handshake?.auth?.token); // never from the payload
        // Server setting EVENT_CHAT_MEMBERS_ONLY=true: only signed-in members may post.
        if (
          !userId &&
          String(process.env.EVENT_CHAT_MEMBERS_ONLY || "").toLowerCase() ===
            "true"
        )
          return reply({ ok: false, error: "Sign in to chat." });
        const slow = tooFast(userId ? `u:${userId}` : `g:${ipOf(socket)}`);
        if (slow) return reply({ ok: false, error: slow });
        let name;
        if (userId) {
          const { rows: u } = await db.query(
            "SELECT name, email FROM users WHERE id = $1",
            [userId],
          );
          name = String(
            u[0]?.name || String(u[0]?.email || "").split("@")[0] || "Member",
          ).slice(0, 60);
        } else {
          name = guestName(payload?.name);
        }
        const { rows } = await db.query(
          "INSERT INTO live_chat_messages (event_id, user_id, name, message) VALUES ($1, $2, $3, $4) RETURNING id, created_at",
          [eventId, userId || null, name, message],
        );
        const msg = {
          id: Number(rows[0].id),
          event_id: eventId,
          user_id: userId || null,
          name,
          message,
          created_at: rows[0].created_at,
        };
        io.to(`live:${eventId}`).emit("chat:new", msg);
        reply({ ok: true, message: msg });
      } catch (e) {
        console.error("[event chat] send failed:", e?.message || e);
        reply({ ok: false, error: "Your message could not be sent." });
      }
    });
  });
}

router.get("/events/:eventId/messages", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const eventId = eventIdOf(req.params.eventId);
  if (!eventId)
    return res.status(400).json({ ok: false, error: "Invalid event" });
  const shape = (rows) =>
    rows.map((m) => ({
      ...m,
      id: Number(m.id),
      user_id: m.user_id == null ? null : Number(m.user_id),
    }));
  try {
    const { rows } = await db.query(
      `SELECT id, event_id, user_id, name, message, created_at FROM live_chat_messages
        WHERE event_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      [eventId],
    );
    res.json({ ok: true, items: shape(rows.reverse()) });
  } catch (e) {
    if (String(e?.code) === "42703") {
      // migration not run yet: no deleted_at column
      const { rows } = await db.query(
        "SELECT id, event_id, user_id, name, message, created_at FROM live_chat_messages WHERE event_id = $1 ORDER BY created_at DESC LIMIT 200",
        [eventId],
      );
      return res.json({ ok: true, items: shape(rows.reverse()) });
    }
    if (String(e?.code) === "42P01") return res.json({ ok: true, items: [] });
    res.status(500).json({ ok: false, error: "Chat is unavailable" });
  }
});

router.delete(
  "/events/:eventId/messages/:id",
  requireArea("website", "community"),
  async (req, res) => {
    const eventId = eventIdOf(req.params.eventId);
    const id = Number.parseInt(req.params.id, 10);
    if (!eventId || !Number.isSafeInteger(id))
      return res.status(400).json({ ok: false, error: "Invalid message" });
    try {
      const { rowCount } = await db.query(
        "UPDATE live_chat_messages SET deleted_at = NOW(), deleted_by = $3 WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL",
        [id, eventId, req.access?.id || null],
      );
      if (!rowCount)
        return res.status(404).json({ ok: false, error: "Not found" });
      req.app.get("io")?.to(`live:${eventId}`).emit("chat:deleted", { id });
      res.json({ ok: true });
    } catch (e) {
      if (String(e?.code) === "42703")
        return res
          .status(503)
          .json({
            ok: false,
            error: "Run the 20261113_11 migration to enable deleting.",
          });
      res.status(500).json({ ok: false, error: "Could not delete" });
    }
  },
);

// Can this signed-in user moderate? (shown as delete buttons in the chat)
router.get("/me", async (req, res) => {
  const userId = tokenUserId(req.headers.authorization || "");
  if (!userId)
    return res.json({ ok: true, signed_in: false, moderator: false });
  try {
    const a = await loadAccess(userId);
    const areas = a?.areas || [];
    res.json({
      ok: true,
      signed_in: true,
      user_id: userId,
      moderator:
        areas.includes("all") ||
        areas.includes("website") ||
        areas.includes("community"),
    });
  } catch {
    res.json({ ok: true, signed_in: true, user_id: userId, moderator: false });
  }
});

module.exports = { router, attach, attachEventChat, tokenUserId, guestName };
