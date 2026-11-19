// server-api/routes/cloudStorage.js — Cloud Storage page (replaces the old Wasabi importer)
//
//   GET    /providers                       catalog (alphabetical), which can connect now
//   GET    /bunny | PUT /bunny | DELETE /bunny    the customer's own Bunny Stream library
//   GET    /connections                     saved storage connections (secrets masked)
//   POST   /connections                     add (tested before saving)
//   PUT    /connections/:id                 edit (blank secret = keep); DELETE /connections/:id
//   POST   /connections/:id/test
//   GET    /connections/:id/files?prefix&q&cursor   video files, marked when imported
//   POST   /connections/:id/import          { keys[], category_id?, visibility?, replace_video_id? }
//   GET    /imports                         import history (statuses refreshed from Bunny)
//   POST   /imports/:id/retry
// Bunny Stream fetches each file straight from the storage (temporary signed
// link). New files become unpublished messages; a file imported into an
// existing message uses the safe Replace flow (routes/bunnyStream.js).
const express = require("express");
const fetch = require("node-fetch");
const db = require("../db");
const { seal, open, mask } = require("../lib/secretBox");
const bunnyConfig = require("../lib/bunnyConfig");
const { CATALOG, byId, connectorFor } = require("../lib/cloudProviders");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

let ready = null;
function ensureTables() {
  if (!ready)
    ready = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS cloud_storage_connections (
        id serial PRIMARY KEY, provider text NOT NULL, name text, public_json jsonb DEFAULT '{}'::jsonb, sealed text,
        status text DEFAULT 'connected', last_error text, last_tested_at timestamptz,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await db.query(`CREATE TABLE IF NOT EXISTS cloud_imports (
        id serial PRIMARY KEY, connection_id int, provider text, key text NOT NULL, video_id int, bunny_video_id text,
        mode text DEFAULT 'new', status text DEFAULT 'fetching', error text, created_by int,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await db.query(
        `CREATE INDEX IF NOT EXISTS cloud_imports_conn_key ON cloud_imports (connection_id, key)`,
      );
    })().catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}
router.use(async (_req, res, next) => {
  try {
    await ensureTables();
    next();
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, message: `Database not ready: ${e.message}` });
  }
});

const bunnyEnv = () => {
  const lib = String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim();
  return {
    lib,
    key: String(process.env.BUNNY_STREAM_API_KEY || "").trim(),
    cdn: String(process.env.BUNNY_STREAM_CDN_HOST || `vz-${lib}.b-cdn.net`)
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, ""),
  };
};
async function bunny(path, opts = {}) {
  const { lib, key } = bunnyEnv();
  if (!lib || !key)
    throw new Error("Connect a Bunny Stream library first (top of this page).");
  const r = await fetch(`https://video.bunnycdn.com/library/${lib}${path}`, {
    ...opts,
    headers: {
      AccessKey: key,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!r.ok)
    throw new Error(
      data?.message || data?.Message || `Bunny answered ${r.status}`,
    );
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleFromKey = (key) =>
  String(key)
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";

/* ---------------- Bunny connection ---------------- */
router.get("/bunny", (_req, res) =>
  res.json({ ok: true, ...bunnyConfig.status() }),
);
router.put("/bunny", async (req, res) => {
  const library_id = String(req.body?.library_id || "").trim();
  const api_key = String(req.body?.api_key || "").trim();
  if (!/^\d+$/.test(library_id))
    return res
      .status(400)
      .json({
        ok: false,
        message: "Enter the Bunny Stream library ID (a number).",
      });
  const keyToTest =
    api_key ||
    (bunnyConfig.status().source === "connected"
      ? process.env.BUNNY_STREAM_API_KEY
      : "");
  if (!keyToTest)
    return res
      .status(400)
      .json({ ok: false, message: "Enter the library's API key." });
  try {
    const r = await fetch(
      `https://video.bunnycdn.com/library/${library_id}/videos?page=1&itemsPerPage=1`,
      {
        headers: { AccessKey: keyToTest, Accept: "application/json" },
      },
    );
    if (!r.ok)
      return res
        .status(400)
        .json({
          ok: false,
          message: `Bunny refused these details (${r.status}). Check the library ID and its API key (Stream › your library › API).`,
        });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, message: `Could not reach Bunny: ${e.message}` });
  }
  const st = await bunnyConfig.save({
    library_id,
    api_key: keyToTest,
    cdn_host: req.body?.cdn_host,
  });
  res.json({ ok: true, ...st });
});
router.delete("/bunny", async (_req, res) =>
  res.json({ ok: true, ...(await bunnyConfig.remove()) }),
);

/* ---------------- providers & connections ---------------- */
router.get("/providers", (_req, res) =>
  res.json({
    ok: true,
    providers: CATALOG.map(
      ({ id, name, kind, available, help, fields, defaults }) => ({
        id,
        name,
        kind,
        available,
        help,
        fields: fields || [],
        defaults: defaults || {},
      }),
    ),
  }),
);

function splitFields(provider, input, previousSecrets = {}) {
  const p = byId(provider);
  const pub = {};
  const sec = { ...previousSecrets };
  for (const f of p.fields || []) {
    const v = String(input?.[f.name] ?? "").trim();
    if (f.secret) {
      if (v) sec[f.name] = v; // blank = keep the saved one
    } else pub[f.name] = v;
  }
  const missing = (p.fields || [])
    .filter((f) => f.required && !(f.secret ? sec[f.name] : pub[f.name]))
    .map((f) => f.label);
  return { pub, sec, missing };
}
function shape(row) {
  const p = byId(row.provider);
  const sec = open(row.sealed);
  const masked = {};
  for (const f of p?.fields || [])
    if (f.secret) masked[f.name] = mask(sec[f.name]);
  return {
    id: row.id,
    provider: row.provider,
    provider_name: p?.name || row.provider,
    name: row.name || p?.name || row.provider,
    fields: { ...(row.public_json || {}), ...masked },
    status: row.status,
    last_error: row.last_error,
    last_tested_at: row.last_tested_at,
  };
}
const configOf = (row) => ({ ...(row.public_json || {}), ...open(row.sealed) });
async function loadConn(id) {
  const { rows } = await db.query(
    "SELECT * FROM cloud_storage_connections WHERE id = $1",
    [Number(id)],
  );
  return rows[0] || null;
}

router.get("/connections", async (_req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM cloud_storage_connections ORDER BY created_at DESC",
  );
  res.json({ ok: true, connections: rows.map(shape) });
});

router.post("/connections", async (req, res) => {
  const provider = String(req.body?.provider || "");
  const p = byId(provider);
  if (!p)
    return res
      .status(400)
      .json({ ok: false, message: "Unknown storage provider." });
  if (!p.available)
    return res
      .status(400)
      .json({ ok: false, message: `${p.name} is coming soon.` });
  const { pub, sec, missing } = splitFields(provider, req.body?.fields || {});
  if (missing.length)
    return res
      .status(400)
      .json({ ok: false, message: `Fill in: ${missing.join(", ")}.` });
  try {
    await connectorFor(provider).test({ ...pub, ...sec });
  } catch (e) {
    return res
      .status(400)
      .json({
        ok: false,
        message: `Could not read the storage with these details: ${e.message || e.name}. Nothing was saved.`,
      });
  }
  const { rows } = await db.query(
    `INSERT INTO cloud_storage_connections (provider, name, public_json, sealed, status, last_tested_at) VALUES ($1, $2, $3::jsonb, $4, 'connected', now()) RETURNING *`,
    [
      provider,
      String(req.body?.name || "").trim() || p.name,
      JSON.stringify(pub),
      seal(sec),
    ],
  );
  res.json({ ok: true, connection: shape(rows[0]) });
});

router.put("/connections/:id", async (req, res) => {
  const row = await loadConn(req.params.id);
  if (!row)
    return res.status(404).json({ ok: false, message: "Connection not found" });
  const { pub, sec, missing } = splitFields(
    row.provider,
    req.body?.fields || {},
    open(row.sealed),
  );
  if (missing.length)
    return res
      .status(400)
      .json({ ok: false, message: `Fill in: ${missing.join(", ")}.` });
  try {
    await connectorFor(row.provider).test({ ...pub, ...sec });
  } catch (e) {
    return res
      .status(400)
      .json({
        ok: false,
        message: `Could not read the storage with these details: ${e.message || e.name}. Nothing was changed.`,
      });
  }
  const { rows } = await db.query(
    `UPDATE cloud_storage_connections SET name = $2, public_json = $3::jsonb, sealed = $4, status = 'connected', last_error = NULL, last_tested_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [
      row.id,
      String(req.body?.name || "").trim() || row.name,
      JSON.stringify(pub),
      seal(sec),
    ],
  );
  res.json({ ok: true, connection: shape(rows[0]) });
});

router.delete("/connections/:id", async (req, res) => {
  await db.query("DELETE FROM cloud_storage_connections WHERE id = $1", [
    Number(req.params.id),
  ]);
  res.json({ ok: true });
});

router.post("/connections/:id/test", async (req, res) => {
  const row = await loadConn(req.params.id);
  if (!row)
    return res.status(404).json({ ok: false, message: "Connection not found" });
  try {
    await connectorFor(row.provider).test(configOf(row));
    await db.query(
      "UPDATE cloud_storage_connections SET status = 'connected', last_error = NULL, last_tested_at = now() WHERE id = $1",
      [row.id],
    );
    res.json({ ok: true, status: "connected" });
  } catch (e) {
    const msg = e.message || e.name || "failed";
    await db.query(
      "UPDATE cloud_storage_connections SET status = 'error', last_error = $2, last_tested_at = now() WHERE id = $1",
      [row.id, msg],
    );
    res.status(400).json({ ok: false, status: "error", message: msg });
  }
});

router.get("/connections/:id/files", async (req, res) => {
  const row = await loadConn(req.params.id);
  if (!row)
    return res.status(404).json({ ok: false, message: "Connection not found" });
  try {
    const out = await connectorFor(row.provider).list(configOf(row), {
      prefix: req.query.prefix,
      q: req.query.q,
      cursor: req.query.cursor || undefined,
    });
    const keys = out.items.map((i) => i.key);
    const done = keys.length
      ? (
          await db.query(
            `SELECT DISTINCT ON (key) key, status, video_id FROM cloud_imports WHERE connection_id = $1 AND key = ANY($2::text[]) ORDER BY key, created_at DESC`,
            [row.id, keys],
          )
        ).rows
      : [];
    const byKey = new Map(done.map((d) => [d.key, d]));
    res.json({
      ok: true,
      items: out.items.map((i) => ({
        ...i,
        imported:
          byKey.get(i.key)?.status && byKey.get(i.key).status !== "failed",
        import_status: byKey.get(i.key)?.status || null,
        video_id: byKey.get(i.key)?.video_id || null,
      })),
      cursor: out.cursor,
    });
  } catch (e) {
    res
      .status(400)
      .json({
        ok: false,
        message: `Could not list the files: ${e.message || e.name}`,
      });
  }
});

/* ---------------- import ---------------- */
async function probe(url) {
  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      timeout: 15000,
    });
    try {
      r.body?.destroy?.();
    } catch {
      /* ignore */
    }
    return r.status;
  } catch (e) {
    return e.code || "network error";
  }
}

async function importOne(
  conn,
  key,
  {
    categoryId = null,
    visibility = "private",
    replaceVideoId = null,
    userId = null,
    importId = null,
  },
) {
  const cfg = configOf(conn);
  const record = async (patch) => {
    const cols = Object.keys(patch);
    await db.query(
      `UPDATE cloud_imports SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
      [importId, ...cols.map((c) => patch[c])],
    );
  };
  try {
    const url = await connectorFor(conn.provider).downloadUrl(cfg, key);
    const st = await probe(url);
    if (st !== 200 && st !== 206)
      throw new Error(
        `The storage refused the download link (${st}). Check the connection's read permission.`,
      );
    const finalTitle = replaceVideoId
      ? (
          await db.query("SELECT title FROM videos WHERE id = $1", [
            replaceVideoId,
          ])
        ).rows[0]?.title || titleFromKey(key)
      : titleFromKey(key);
    const unique = `${finalTitle} [NLM-CLOUD-${importId}-${Date.now()}]`;
    await bunny(`/videos/fetch`, {
      method: "POST",
      body: JSON.stringify({ url, title: unique, headers: {} }),
    });
    let guid = "";
    for (let i = 0; i < 10 && !guid; i += 1) {
      const list = await bunny(
        `/videos?page=1&itemsPerPage=10&search=${encodeURIComponent(unique)}`,
      );
      guid = (list?.items || []).find((v) => v.title === unique)?.guid || "";
      if (!guid) await sleep(800);
    }
    if (!guid)
      throw new Error(
        "Bunny started fetching, but the new video was not found yet. Retry in a minute.",
      );
    await bunny(`/videos/${guid}`, {
      method: "POST",
      body: JSON.stringify({ title: finalTitle }),
    });
    const { lib, cdn } = bunnyEnv();
    const hls = `https://${cdn}/${guid}/playlist.m3u8`;
    const embed = `https://iframe.mediadelivery.net/embed/${lib}/${guid}`;
    const source = {
      provider: conn.provider,
      connection_id: conn.id,
      key,
      imported_at: new Date().toISOString(),
    };
    let videoId = replaceVideoId;
    if (replaceVideoId) {
      await db.query(
        `UPDATE videos SET metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
        [
          replaceVideoId,
          JSON.stringify({
            cloud_import: source,
            replace_pending: {
              bunny_video_id: guid,
              status: "processing",
              started_at: source.imported_at,
              source: "cloud",
              key,
            },
          }),
        ],
      );
    } else {
      const ins = await db.query(
        `INSERT INTO videos (title, video_url, playback_url, embed_url, provider, provider_key, bunny_video_id, bunny_library_id,
                             processing_status, is_published, visibility, category_id, created_by, metadata, created_at, updated_at)
         VALUES ($1, $2, $2, $3, 'bunny_stream', $4, $4, $5, 'processing', FALSE, $6, $7, $8, $9::jsonb, now(), now()) RETURNING id`,
        [
          finalTitle,
          hls,
          embed,
          guid,
          lib,
          visibility,
          categoryId,
          userId,
          JSON.stringify({ cloud_import: source }),
        ],
      );
      videoId = ins.rows[0].id;
    }
    await record({
      status: "processing",
      bunny_video_id: guid,
      video_id: videoId,
      error: null,
    });
    return {
      key,
      status: "processing",
      video_id: videoId,
      bunny_video_id: guid,
      mode: replaceVideoId ? "replace" : "new",
    };
  } catch (e) {
    await record({ status: "failed", error: e.message || "Import failed" });
    return { key, status: "failed", error: e.message || "Import failed" };
  }
}

router.post("/connections/:id/import", async (req, res) => {
  const conn = await loadConn(req.params.id);
  if (!conn)
    return res.status(404).json({ ok: false, message: "Connection not found" });
  const keys = (Array.isArray(req.body?.keys) ? req.body.keys : [])
    .map((k) => String(k || "").trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!keys.length)
    return res
      .status(400)
      .json({ ok: false, message: "Choose at least one file." });
  const replaceVideoId = req.body?.replace_video_id
    ? Number(req.body.replace_video_id)
    : null;
  if (replaceVideoId && keys.length !== 1)
    return res
      .status(400)
      .json({
        ok: false,
        message: "Choose exactly one file to put into an existing message.",
      });
  const vis = ["public", "private", "unlisted"].includes(
    String(req.body?.visibility),
  )
    ? String(req.body.visibility)
    : "private";
  const categoryId = req.body?.category_id
    ? Number(req.body.category_id)
    : null;
  const userId = req.user?.id || null;
  const results = [];
  for (const key of keys) {
    const { rows } = await db.query(
      `INSERT INTO cloud_imports (connection_id, provider, key, mode, status, created_by, video_id) VALUES ($1, $2, $3, $4, 'fetching', $5, $6) RETURNING id`,
      [
        conn.id,
        conn.provider,
        key,
        replaceVideoId ? "replace" : "new",
        userId,
        replaceVideoId,
      ],
    );
    results.push({
      import_id: rows[0].id,
      ...(await importOne(conn, key, {
        categoryId,
        visibility: vis,
        replaceVideoId,
        userId,
        importId: rows[0].id,
      })),
    });
  }
  res.json({
    ok: true,
    started: results.filter((r) => r.status === "processing").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
});

// refresh the statuses of unfinished imports from Bunny
async function refreshImports(rows) {
  for (const r of rows) {
    if (r.status !== "processing" || !r.bunny_video_id) continue;
    try {
      const v = await bunny(`/videos/${r.bunny_video_id}`);
      const s = Number(v?.status);
      if (
        [4, 7, 8].includes(s) ||
        (Number(v?.encodeProgress) >= 100 && s !== 5 && s !== 6)
      ) {
        if (r.mode === "new" && r.video_id) {
          await db.query(
            `UPDATE videos SET processing_status = 'ready', duration_seconds = CASE WHEN $2::int > 0 THEN $2::int ELSE duration_seconds END, updated_at = now() WHERE id = $1 AND bunny_video_id = $3`,
            [r.video_id, Math.round(Number(v.length) || 0), r.bunny_video_id],
          );
        }
        // replace mode: routes/bunnyStream.js switches the message over
        r.status = "ready";
      } else if (s === 5 || s === 6) {
        r.status = "failed";
        r.error = `Bunny could not encode this file (status ${s}).`;
      } else continue;
      await db.query(
        "UPDATE cloud_imports SET status = $2, error = $3, updated_at = now() WHERE id = $1",
        [r.id, r.status, r.error || null],
      );
    } catch {
      /* try again next time */
    }
  }
  return rows;
}

router.get("/imports", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const { rows } = await db.query(
    `SELECT i.*, c.name AS connection_name, v.title AS video_title
       FROM cloud_imports i LEFT JOIN cloud_storage_connections c ON c.id = i.connection_id LEFT JOIN videos v ON v.id = i.video_id
      ORDER BY i.created_at DESC LIMIT $1`,
    [limit],
  );
  res.json({ ok: true, imports: await refreshImports(rows) });
});

router.post("/imports/:id/retry", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM cloud_imports WHERE id = $1", [
    Number(req.params.id),
  ]);
  const imp = rows[0];
  if (!imp)
    return res.status(404).json({ ok: false, message: "Import not found" });
  const conn = await loadConn(imp.connection_id);
  if (!conn)
    return res
      .status(400)
      .json({ ok: false, message: "That storage connection was removed." });
  await db.query(
    "UPDATE cloud_imports SET status = 'fetching', error = NULL, updated_at = now() WHERE id = $1",
    [imp.id],
  );
  const r = await importOne(conn, imp.key, {
    replaceVideoId: imp.mode === "replace" ? imp.video_id : null,
    userId: req.user?.id || null,
    importId: imp.id,
  });
  res.json({ ok: r.status !== "failed", ...r });
});

module.exports = router;
