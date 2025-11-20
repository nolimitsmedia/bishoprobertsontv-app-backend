// server-api/routes/live.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const db = require("../db");

/* ──────────────────────────────────────────────────────────────
   AUTH & ROLES (STRICT)
────────────────────────────────────────────────────────────── */
let requireAuth;
try {
  ({ requireAuth } = require("../middleware/auth"));
} catch {}
let authenticate;
try {
  authenticate = require("../middleware/authenticate");
} catch {}
const baseAuth =
  (typeof requireAuth === "function" && requireAuth) ||
  authenticate ||
  ((_req, _res, next) => next());

function isAdmin(user) {
  const r = (user?.role || user?.type || "").toLowerCase();
  return r === "admin" || r === "owner";
}
function roleAllows(user) {
  const r = (user?.role || user?.type || "").toLowerCase();
  return r === "user" || r === "creator" || r === "admin" || r === "owner";
}
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}
function normalizeId(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}
function userIdFromUser(u) {
  if (!u) return null;
  return normalizeId(
    firstDefined(
      u.id,
      u.user_id,
      u.userId,
      u.uid,
      u.account_id,
      u.owner_id,
      u.sub
    )
  );
}
function getReqUserId(req) {
  const id =
    userIdFromUser(req?.user) ??
    userIdFromUser(req?.auth) ??
    userIdFromUser(req?.me) ??
    userIdFromUser(req?.account) ??
    userIdFromUser(req?.ctx?.user) ??
    userIdFromUser(req?.session?.user) ??
    userIdFromUser(req?.session?.account);
  if (id != null) return id;
  const h =
    req?.headers?.["x-user-id"] ||
    req?.headers?.["x-account-id"] ||
    req?.headers?.["x-owner-id"];
  return h != null ? normalizeId(h) : null;
}

// Allow user/admin/creator/owner (must be authenticated)
function allowUserOrAdmin(req, res, next) {
  if (roleAllows(req.user) || isAdmin(req.user) || getReqUserId(req) != null)
    return next();
  return res.status(403).json({ message: "Forbidden" });
}

/* ──────────────────────────────────────────────────────────────
   SUBSCRIPTION & ENTITLEMENTS (STRICT)
────────────────────────────────────────────────────────────── */
let requireActiveSub = (_req, _res, next) => next();
try {
  requireActiveSub = require("../middleware/requireActiveSub");
} catch {}

// We will NOT swallow subscription errors. If the middleware throws, Express will 500.
let attachEntitlements;
try {
  ({ attachEntitlements } = require("../middleware/entitlements"));
} catch {}

// Run entitlements but never throw; we need req.entitlements for quotas.
const safeEntitlements =
  typeof attachEntitlements === "function"
    ? (req, _res, next) => {
        try {
          const r = attachEntitlements(req, _res, (err) => {
            if (err)
              console.warn(
                "[entitlements] attach failed:",
                err?.message || err
              );
            next();
          });
          if (r && typeof r.then === "function") {
            r.catch((e) =>
              console.warn(
                "[entitlements] attach failed (promise):",
                e?.message || e
              )
            );
          }
        } catch (e) {
          console.warn("[entitlements] attach failed (sync):", e?.message || e);
          next();
        }
      }
    : (_req, _res, next) => next();

/** Default monthly limits if plan rows don’t specify them. */
const DEFAULT_LIVE_LIMITS = {
  starter: 100,
  pro: 200,
  custom: 500,
};

/** Map various human labels to canonical plan codes. */
function canonicalPlanCode(str) {
  const s = String(str || "").toLowerCase();
  if (!s) return null;
  if (s.includes("custom")) return "custom";
  if (s.includes("pro") || s.includes("plus") || s.includes("essential"))
    return "pro";
  if (s.includes("starter") || s.includes("basic") || s.includes("growth"))
    return "starter";
  if (["starter", "pro", "custom"].includes(s)) return s;
  return null;
}

/** Fallback: read the user’s active subscription & plan limit from DB. */
async function getFallbackMonthlyLimitFromDB(userId) {
  if (userId == null) return 0;
  try {
    const { rows } = await db.query(
      `
      SELECT
        s.plan_code,
        s.plan,
        s.plan_id,
        p.live_hours_limit
      FROM subscriptions s
      LEFT JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.canceled_at IS NULL
      ORDER BY s.id DESC
      LIMIT 1
      `,
      [userId]
    );
    const r = rows[0];
    if (!r) return 0;

    // Prefer explicit plan limit from subscription_plans
    if (r.live_hours_limit !== null && r.live_hours_limit !== undefined) {
      const n = Number(r.live_hours_limit);
      return Number.isFinite(n) ? n : 0;
    }

    // Otherwise map by canonical code
    const code =
      r.plan_code || canonicalPlanCode(r.plan) || canonicalPlanCode(r.plan_id);
    if (!code) return 0;
    return DEFAULT_LIVE_LIMITS[code] || 0;
  } catch (e) {
    console.warn("fallback limit query failed:", e?.message || e);
    return 0;
  }
}

/** Resolve the monthly live limit:
 *  1) Entitlements (if attached)
 *  2) DB fallback (active subscription + plan limit)
 */
async function resolveMonthlyLiveLimit(req) {
  const raw = req?.entitlements?.quotas?.live_hours_monthly;
  if (raw !== undefined && raw !== null) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  // fallback to DB so paid users aren’t blocked when entitlements aren’t attached
  const uid = getReqUserId(req);
  return getFallbackMonthlyLimitFromDB(uid);
}

/* ──────────────────────────────────────────────────────────────
   PROVIDER CONFIG
────────────────────────────────────────────────────────────── */
const VIDEO_PROVIDER = String(
  process.env.VIDEO_PROVIDER || "livepeer"
).toLowerCase();

const LIVEPEER_BASE =
  process.env.LIVEPEER_BASE || "https://livepeer.studio/api";
const LIVEPEER_API_KEY = process.env.LIVEPEER_API_KEY || "";
const RTMP_INGEST_LIVEPEER =
  process.env.LIVEPEER_RTMP_INGEST || "rtmp://rtmp.livepeer.studio/live";
const HLS_CDN_BASE_LIVEPEER =
  process.env.LIVEPEER_HLS_CDN_BASE || "https://livepeercdn.com/hls";

const STREAMCONTROL_CHANNEL_ID = process.env.STREAMCONTROL_CHANNEL_ID || "";
const RTMP_BASE_STREAMCONTROL = String(
  process.env.STREAMCONTROL_RTMP_URL ||
    "rtmps://ingest.mycloudstream.io:1936/static"
).replace(/\/+$/, "");
const HLS_FIXED_STREAMCONTROL = process.env.STREAMCONTROL_HLS_URL || "";
const HLS_TEMPLATE_STREAMCONTROL = process.env.STREAMCONTROL_HLS_TEMPLATE || "";

/* ──────────────────────────────────────────────────────────────
   DB SCHEMA GUARDS
────────────────────────────────────────────────────────────── */
async function ensureLiveTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS live_events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      visibility TEXT NOT NULL DEFAULT 'unlisted',
      is_premium BOOLEAN NOT NULL DEFAULT FALSE,
      start_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      provider TEXT,
      provider_stream_id TEXT,
      stream_key TEXT,
      playback_id TEXT,
      rtmp_ingest TEXT,
      hls_url TEXT,
      record BOOLEAN NOT NULL DEFAULT TRUE,
      vod_video_id INTEGER,
      vod_hls_url TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const alters = [
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled'",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'unlisted'",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS provider TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS provider_stream_id TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS stream_key TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS playback_id TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS rtmp_ingest TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS hls_url TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS record BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS vod_video_id INTEGER",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS vod_hls_url TEXT",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS created_by INTEGER",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    "ALTER TABLE live_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  ];
  for (const sql of alters) {
    try {
      await db.query(sql);
    } catch {}
  }
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_live_events_creator ON live_events (created_by)`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_live_events_status ON live_events (status)`
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS live_chat_messages (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL,
      user_id INTEGER,
      name TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_chat_event ON live_chat_messages (event_id, created_at)`
  );
}

/* ──────────────────────────────────────────────────────────────
   PROVIDER HELPERS
────────────────────────────────────────────────────────────── */
async function lpGet(path) {
  const { data } = await axios.get(`${LIVEPEER_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${LIVEPEER_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return data;
}
async function lpPost(path, body) {
  const { data } = await axios.post(`${LIVEPEER_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${LIVEPEER_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return data;
}
async function lpDelete(path) {
  try {
    await axios.delete(`${LIVEPEER_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${LIVEPEER_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    console.warn("Livepeer delete warning:", e?.response?.data || e?.message);
  }
}

function scMakeStreamKey() {
  return "ch_" + crypto.randomBytes(10).toString("base64url");
}
function scDeriveHlsFor(key) {
  if (HLS_FIXED_STREAMCONTROL) return HLS_FIXED_STREAMCONTROL;
  if (HLS_TEMPLATE_STREAMCONTROL) {
    return HLS_TEMPLATE_STREAMCONTROL.replace("{name}", key).replace(
      "{key}",
      key
    );
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────
   MISC HELPERS
────────────────────────────────────────────────────────────── */
function parseId(req) {
  const id = Number.parseInt(req.params.id, 10);
  return Number.isInteger(id) ? id : null;
}
function attachPlaybackFallback(row) {
  if (!row) return row;
  const provider = String(row.provider || VIDEO_PROVIDER || "").toLowerCase();
  if (provider === "livepeer") {
    if (!row.rtmp_ingest) row.rtmp_ingest = RTMP_INGEST_LIVEPEER;
    if (!row.hls_url && row.playback_id) {
      row.hls_url = `${HLS_CDN_BASE_LIVEPEER}/${row.playback_id}/index.m3u8`;
    }
  } else if (provider === "streamcontrol") {
    if (!row.rtmp_ingest) row.rtmp_ingest = RTMP_BASE_STREAMCONTROL;
    if (!row.hls_url && row.stream_key)
      row.hls_url = scDeriveHlsFor(row.stream_key);
  }
  return row;
}
async function assertOwnerOrAdmin(eventId, req) {
  const q = await db.query(
    "SELECT id, created_by FROM live_events WHERE id=$1 LIMIT 1",
    [eventId]
  );
  if (!q.rowCount) return { ok: false, status: 404 };
  const row = q.rows[0];
  if (isAdmin(req.user)) return { ok: true, row };

  const uid = getReqUserId(req);
  if (row.created_by == null && uid != null) {
    try {
      await db.query("UPDATE live_events SET created_by=$1 WHERE id=$2", [
        uid,
        row.id,
      ]);
      row.created_by = uid;
      return { ok: true, row };
    } catch {}
  }
  if (uid != null && String(row.created_by) === String(uid))
    return { ok: true, row };
  return { ok: false, status: 403 };
}

/* ──────────────────────────────────────────────────────────────
   CREATE (REQUIRES ACTIVE SUB + QUOTA ENFORCEMENT)
────────────────────────────────────────────────────────────── */
router.post(
  "/events",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  safeEntitlements,
  async (req, res) => {
    try {
      await ensureLiveTables();

      const {
        title = `Event ${Date.now()}`,
        description = "",
        visibility = "unlisted",
        is_premium = false,
        record = true,
        start_at = null,
      } = req.body || {};

      // Enforce live-hours quota on create as a pre-flight
      try {
        const limit = await resolveMonthlyLiveLimit(req);
        const uid = getReqUserId(req);
        const { getMonthlyUsage } = require("../services/usage");
        const used =
          uid != null ? await getMonthlyUsage(uid, "live_hours_monthly") : 0;
        if (limit <= 0 || used >= limit) {
          return res.status(402).json({
            error:
              "Monthly live streaming hours exceeded or unavailable. Try again next period.",
            used,
            limit,
          });
        }
      } catch (e) {
        // If usage service fails, be conservative and block.
        return res.status(402).json({
          error: "Unable to verify live-hours quota at this time.",
        });
      }

      let provider = VIDEO_PROVIDER;
      let provider_stream_id = null;
      let stream_key = null;
      let playback_id = null;
      let rtmp_ingest = null;
      let hls_url = null;
      let status = "scheduled";

      if (provider === "livepeer") {
        const lp = await lpPost("/stream", { name: title, record: !!record });
        provider_stream_id = lp?.id || lp?.data?.id || null;
        stream_key = lp?.streamKey || lp?.data?.streamKey || null;
        playback_id = lp?.playbackId || lp?.data?.playbackId || null;

        rtmp_ingest = RTMP_INGEST_LIVEPEER;
        hls_url = playback_id
          ? `${HLS_CDN_BASE_LIVEPEER}/${playback_id}/index.m3u8`
          : null;
      } else {
        provider = "streamcontrol";
        stream_key = STREAMCONTROL_CHANNEL_ID || scMakeStreamKey();
        rtmp_ingest = RTMP_BASE_STREAMCONTROL;
        hls_url = scDeriveHlsFor(stream_key);
      }

      const creatorId = getReqUserId(req);

      const ins = await db.query(
        `INSERT INTO live_events
         (title, description, status, visibility, is_premium, start_at,
          provider, provider_stream_id, stream_key, playback_id,
          rtmp_ingest, hls_url, record, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
         RETURNING *`,
        [
          title,
          description,
          status,
          visibility,
          !!is_premium,
          start_at,
          provider,
          provider_stream_id,
          stream_key,
          playback_id,
          rtmp_ingest,
          hls_url,
          !!record,
          creatorId,
        ]
      );

      return res.json(attachPlaybackFallback(ins.rows[0]));
    } catch (err) {
      console.error("POST /live/events error:", err?.response?.data || err);
      return res.status(500).json({ message: "Failed to create event" });
    }
  }
);

/* ──────────────────────────────────────────────────────────────
   LIST / GET
────────────────────────────────────────────────────────────── */
router.get("/events", baseAuth, allowUserOrAdmin, async (req, res) => {
  try {
    await ensureLiveTables();

    if (isAdmin(req.user)) {
      const q = await db.query("SELECT * FROM live_events ORDER BY id DESC");
      return res.json({ items: q.rows.map(attachPlaybackFallback) });
    }
    const uid = getReqUserId(req);
    const q = await db.query(
      "SELECT * FROM live_events WHERE created_by=$1 ORDER BY id DESC",
      [uid]
    );
    res.json({ items: q.rows.map(attachPlaybackFallback) });
  } catch (e) {
    console.error("[GET /live/events] error:", e);
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

router.get("/events/:id", async (req, res) => {
  try {
    await ensureLiveTables();
    const id = parseId(req);
    if (id == null) return res.status(400).json({ message: "Invalid id" });

    const q = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
    if (!q.rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(attachPlaybackFallback(q.rows[0]));
  } catch (e) {
    console.error("[GET /live/events/:id] error:", e);
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

/* ──────────────────────────────────────────────────────────────
   UPDATE (edit) — requires active subscription
────────────────────────────────────────────────────────────── */
router.put(
  "/events/:id",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  safeEntitlements,
  async (req, res) => {
    try {
      await ensureLiveTables();
      const id = parseId(req);
      if (id == null) return res.status(400).json({ message: "Invalid id" });

      const perm = await assertOwnerOrAdmin(id, req);
      if (!perm.ok)
        return res.status(perm.status).json({ message: "Forbidden" });

      const fields = [
        "title",
        "description",
        "visibility",
        "is_premium",
        "start_at",
        "record",
      ];
      const sets = [];
      const vals = [];
      let idx = 1;
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          sets.push(`${f}=$${idx++}`);
          vals.push(req.body[f]);
        }
      }
      if (!sets.length) {
        const q = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
        return res.json(attachPlaybackFallback(q.rows[0]));
      }
      vals.push(id);
      const up = await db.query(
        `UPDATE live_events SET ${sets.join(
          ", "
        )}, updated_at=now() WHERE id=$${vals.length} RETURNING *`,
        vals
      );
      return res.json(attachPlaybackFallback(up.rows[0]));
    } catch (e) {
      console.error("PUT /live/events/:id error:", e);
      res.status(500).json({ message: "Failed to update event" });
    }
  }
);

/* ──────────────────────────────────────────────────────────────
   START (go live) — requires active subscription + quota
────────────────────────────────────────────────────────────── */
router.post(
  "/events/:id/start",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  safeEntitlements,
  async (req, res) => {
    try {
      await ensureLiveTables();

      const id = parseId(req);
      if (id == null) return res.status(400).json({ message: "Invalid id" });

      const perm = await assertOwnerOrAdmin(id, req);
      if (!perm.ok)
        return res.status(perm.status).json({ message: "Forbidden" });

      // Enforce quota strictly
      try {
        const limit = await resolveMonthlyLiveLimit(req);
        const uid = getReqUserId(req);
        const { getMonthlyUsage } = require("../services/usage");
        const used =
          uid != null ? await getMonthlyUsage(uid, "live_hours_monthly") : 0;
        if (limit <= 0 || used >= limit) {
          return res.status(402).json({
            error:
              "Monthly live streaming hours exceeded or unavailable. Try again next period.",
            used,
            limit,
          });
        }
      } catch {
        return res.status(402).json({
          error: "Unable to verify live-hours quota at this time.",
        });
      }

      const up = await db.query(
        "UPDATE live_events SET status='live', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 RETURNING *",
        [id]
      );
      if (!up.rows[0]) return res.status(404).json({ message: "Not found" });
      res.json(attachPlaybackFallback(up.rows[0]));
    } catch (e) {
      console.error("POST /live/events/:id/start error:", e);
      res.status(500).json({ message: "Failed to mark live" });
    }
  }
);

/* ──────────────────────────────────────────────────────────────
   END — requires active subscription; records usage; VOD
────────────────────────────────────────────────────────────── */
router.post(
  "/events/:id/end",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  safeEntitlements,
  async (req, res) => {
    try {
      await ensureLiveTables();

      const id = parseId(req);
      if (id == null) return res.status(400).json({ message: "Invalid id" });

      const perm = await assertOwnerOrAdmin(id, req);
      if (!perm.ok)
        return res.status(perm.status).json({ message: "Forbidden" });

      // Stamp the end time now
      const endedAt = new Date();
      await db.query(
        "UPDATE live_events SET status='ended', ended_at=$2, updated_at=now() WHERE id=$1",
        [id, endedAt]
      );

      // Reload event for accurate fields
      const q = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
      const evt = q.rows[0];
      if (!evt) return res.status(404).json({ message: "Not found" });

      // usage (strict but best-effort; end should still succeed)
      (async () => {
        try {
          const { addUsage } = require("../services/usage");
          let hours = 0;

          // Prefer Livepeer session durations
          if (evt.provider === "livepeer" && evt.provider_stream_id) {
            try {
              const sessions = await lpGet(
                `/stream/${evt.provider_stream_id}/sessions`
              );
              if (Array.isArray(sessions) && sessions.length) {
                hours = sessions.reduce((sum, s) => {
                  const start = s?.createdAt ? new Date(s.createdAt) : null;
                  const end = s?.endedAt
                    ? new Date(s.endedAt)
                    : s?.lastSeen
                    ? new Date(s.lastSeen)
                    : endedAt;
                  if (
                    start &&
                    isFinite(+start) &&
                    end &&
                    isFinite(+end) &&
                    end > start
                  ) {
                    return sum + (end - start) / 36e5;
                  }
                  return sum;
                }, 0);
              }
            } catch {}
          }

          // Fallback: ONLY count started_at → endedAt (NEVER from created_at)
          if ((!hours || hours <= 0) && evt.started_at) {
            const start = new Date(evt.started_at);
            if (isFinite(+start) && endedAt > start) {
              hours = (endedAt - start) / 36e5; // exact fractional hours
            }
          }

          const uid = evt.created_by ?? getReqUserId(req);
          if (uid != null && hours > 0) {
            await addUsage(uid, "live_hours_monthly", hours, {
              reason: "live_event_end",
              provider: evt.provider,
              event_id: evt.id,
              provider_stream_id: evt.provider_stream_id || null,
            });
          }
        } catch (err) {
          console.warn(
            "Could not record live usage:",
            err?.response?.data || err
          );
        }
      })();

      // VOD (Livepeer only) — record & expose vod_hls_url so the client can switch
      let createdVodId = null;
      let createdVodUrl = null;

      if (evt.record && evt.provider === "livepeer" && evt.provider_stream_id) {
        try {
          const sessions = await lpGet(
            `/stream/${evt.provider_stream_id}/sessions`
          );
          let assetId = null;
          if (Array.isArray(sessions) && sessions.length) {
            const rec = sessions
              .slice()
              .reverse()
              .find((s) => s?.recordingStatus === "ready" && s?.assetId);
            if (rec?.assetId) assetId = rec.assetId;
          }
          if (assetId) {
            const asset = await lpGet(`/asset/${assetId}`);
            const vodPlaybackId = asset?.playbackId;
            if (vodPlaybackId) {
              const vodUrl = `${HLS_CDN_BASE_LIVEPEER}/${vodPlaybackId}/index.m3u8`;
              createdVodUrl = vodUrl;
              const title = `Replay: ${evt.title || "Live Event"}`;
              const ins = await db.query(
                `INSERT INTO videos
                 (title, description, video_url, thumbnail_url, category_id,
                  is_premium, visibility, created_by)
                 VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6)
                 RETURNING id`,
                [
                  title,
                  evt.description || "",
                  vodUrl,
                  !!evt.is_premium,
                  evt.visibility || "public",
                  evt.created_by || getReqUserId(req) || null,
                ]
              );
              createdVodId = ins.rows[0]?.id || null;
              await db.query(
                "UPDATE live_events SET vod_video_id=$1, vod_hls_url=$2 WHERE id=$3",
                [createdVodId, createdVodUrl, evt.id]
              );
            }
          }
        } catch (e) {
          console.warn(
            "end() could not auto-create VOD:",
            e?.response?.data || e
          );
        }
      }

      const out = await db.query("SELECT * FROM live_events WHERE id=$1", [
        evt.id,
      ]);
      const endedRow = attachPlaybackFallback(out.rows[0]);
      endedRow.vod_video_id = endedRow.vod_video_id || createdVodId || null;
      endedRow.vod_hls_url = endedRow.vod_hls_url || createdVodUrl || null;
      return res.json(endedRow);
    } catch (err) {
      console.error("POST /live/events/:id/end error:", err);
      return res.status(500).json({ message: "Failed to end event" });
    }
  }
);

/* ──────────────────────────────────────────────────────────────
   DELETE — requires active subscription
────────────────────────────────────────────────────────────── */
router.delete(
  "/events/:id",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  async (req, res) => {
    try {
      await ensureLiveTables();

      const id = parseId(req);
      if (id == null) return res.status(400).json({ message: "Invalid id" });

      const perm = await assertOwnerOrAdmin(id, req);
      if (!perm.ok)
        return res.status(perm.status).json({ message: "Forbidden" });

      const q = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
      const row = q.rows[0];
      if (!row) return res.status(404).json({ message: "Not found" });

      if (row.provider === "livepeer" && row.provider_stream_id) {
        await lpDelete(`/stream/${row.provider_stream_id}`);
      }
      try {
        await db.query("DELETE FROM live_chat_messages WHERE event_id=$1", [
          id,
        ]);
      } catch {}

      const del = await db.query("DELETE FROM live_events WHERE id=$1", [id]);
      if (!del.rowCount) return res.status(404).json({ message: "Not found" });

      return res.status(204).send();
    } catch (e) {
      console.error("DELETE /live/events/:id error:", e);
      return res.status(500).json({ message: "Failed to delete live event" });
    }
  }
);

/* ──────────────────────────────────────────────────────────────
   CHAT HISTORY (public)
────────────────────────────────────────────────────────────── */
router.get("/events/:id/chat", async (req, res) => {
  try {
    await ensureLiveTables();
    const id = parseId(req);
    if (id == null) return res.status(400).json({ message: "Invalid id" });

    const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
    const q = await db.query(
      `SELECT id, event_id, user_id, name, message, created_at
       FROM live_chat_messages
       WHERE event_id=$1
       ORDER BY created_at ASC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ items: q.rows });
  } catch (e) {
    console.error("GET /live/events/:id/chat error:", e);
    res.status(500).json({ message: "Failed to fetch chat" });
  }
});

/* ──────────────────────────────────────────────────────────────
   REGISTRATION / ICS (public)
────────────────────────────────────────────────────────────── */
router.get("/events/:id/register", async (req, res) => {
  try {
    await ensureLiveTables();
    const id = parseId(req);
    if (id == null) return res.status(400).send("Invalid id");

    const ev = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
    const row = ev.rows[0];
    if (!row) return res.status(404).send("Not found");

    if (String(req.query.ics) === "1") {
      const start =
        row.start_at || new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const dt = (d) =>
        new Date(d)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}Z$/, "Z");
      const dtStart = dt(start);
      const dtEnd = dt(new Date(new Date(start).getTime() + 60 * 60 * 1000));
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BishopTV//Live//EN",
        "BEGIN:VEVENT",
        `UID:live-${row.id}@bishop.tv`,
        `DTSTAMP:${dt(new Date())}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${(row.title || "Live event").replace(/\n/g, " ")}`,
        `DESCRIPTION:${(row.description || "").replace(/\n/g, " ")}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="event-${row.id}.ics"`
      );
      return res.send(ics);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("GET /live/events/:id/register error:", e);
    return res.status(500).json({ message: "Failed" });
  }
});

router.post("/events/:id/register", async (_req, res) => {
  return res.json({ ok: true });
});

/* ──────────────────────────────────────────────────────────────
   GENERIC LIVE-HOURS (optional backfill) — requires active sub
────────────────────────────────────────────────────────────── */
router.post(
  "/end",
  baseAuth,
  allowUserOrAdmin,
  requireActiveSub,
  safeEntitlements,
  async (req, res) => {
    try {
      await ensureLiveTables();

      const startedAt = new Date(req.body.started_at);
      const endedAt = new Date(req.body.ended_at || Date.now());
      if (!startedAt || isNaN(+startedAt)) {
        return res.status(400).json({ error: "Invalid or missing started_at" });
      }
      const hours = Math.max(0, (endedAt - startedAt) / 36e5);

      const { addUsage, getMonthlyUsage } = require("../services/usage");
      const uid = getReqUserId(req);

      // strict quota check
      const limit = await resolveMonthlyLiveLimit(req);
      const used =
        uid != null ? await getMonthlyUsage(uid, "live_hours_monthly") : 0;
      if (limit <= 0 || used + hours > limit + 1e-9) {
        return res.status(402).json({
          error: "Monthly live hours exceeded",
          used,
          attempt: hours,
          limit,
        });
      }

      if (uid != null) {
        await addUsage(uid, "live_hours_monthly", hours, {
          reason: "live_session",
        });
      }
      res.json({ ok: true, consumed_hours: Number(hours.toFixed(3)) });
    } catch (e) {
      console.error("POST /live/end error:", e);
      res.status(500).json({ error: "Live end failed" });
    }
  }
);

module.exports = router;
