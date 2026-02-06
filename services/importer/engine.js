// server-api/services/importer/engine.js
const db = require("../../db");
const { PassThrough } = require("stream");
const wasabi = require("./providers/importWasabi");
const bunny = require("./providers/bunny");

function safeStr(v) {
  return (v ?? "").toString();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function asBigIntOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

async function getJob(jobId) {
  const r = await db.query(`SELECT * FROM import_jobs WHERE id=$1`, [jobId]);
  return r.rows[0] || null;
}

async function setJobStatus(jobId, status, extra = {}) {
  const fields = [];
  const vals = [jobId];
  let idx = 2;

  fields.push(`status=$${idx++}`);
  vals.push(status);

  if (extra.last_error !== undefined) {
    fields.push(`last_error=$${idx++}`);
    vals.push(extra.last_error);
  }

  if (extra.started) {
    fields.push(`started_at=COALESCE(started_at, NOW())`);
    fields.push(`finished_at=NULL`);
  }

  if (extra.finished) {
    fields.push(`finished_at=NOW()`);
  }

  await db.query(
    `UPDATE import_jobs SET ${fields.join(", ")} WHERE id=$1`,
    vals,
  );
}

async function updateItem(jobId, itemId, patch = {}) {
  const sets = [];
  const vals = [jobId, itemId];
  let idx = 3;

  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k}=$${idx++}`);
    vals.push(v);
  }

  if (!sets.length) return;

  await db.query(
    `UPDATE import_job_items
     SET ${sets.join(", ")}, updated_at=NOW()
     WHERE job_id=$1 AND id=$2`,
    vals,
  );
}

/**
 * ✅ Increment totals JSONB in ONE assignment
 * Prevents: "multiple assignments to same column totals"
 */
async function incTotals(jobId, inc = {}) {
  const keys = Object.keys(inc || {}).filter((k) => {
    const v = Number(inc[k] || 0);
    return Number.isFinite(v) && v !== 0;
  });

  if (!keys.length) return;

  const base = `COALESCE(totals, '{}'::jsonb)`;
  let expr = base;

  const vals = [jobId];
  let idx = 2;

  for (const k of keys) {
    const add = asBigIntOr0(inc[k]);
    if (!add) continue;

    vals.push(add);

    expr = `jsonb_set(
      ${expr},
      '{${k}}',
      to_jsonb(
        (COALESCE((${base}->>'${k}')::bigint, 0) + $${idx})::bigint
      ),
      true
    )`;
    idx++;
  }

  await db.query(
    `UPDATE import_jobs
     SET totals = ${expr}
     WHERE id = $1`,
    vals,
  );
}

/**
 * ✅ DB-write throttling to avoid pool starvation.
 */
function makeTotalsBuffer(jobId) {
  let buf = {
    bytes_total: 0,
    bytes_copied: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    scanned: 0,
  };
  let timer = null;
  let inFlight = false;
  let pending = false;

  async function flushNow() {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;

    const snap = { ...buf };
    buf = {
      bytes_total: 0,
      bytes_copied: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      scanned: 0,
    };

    try {
      await incTotals(jobId, snap);
    } catch (e) {
      // restore buffer on failure
      buf.bytes_total += snap.bytes_total;
      buf.bytes_copied += snap.bytes_copied;
      buf.completed += snap.completed;
      buf.failed += snap.failed;
      buf.skipped += snap.skipped;
      buf.scanned += snap.scanned;
      console.error("[engine] totals flush failed:", e.message);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        await flushNow();
      }
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await flushNow();
    }, 1000);
  }

  return {
    add(delta) {
      for (const k of Object.keys(buf)) {
        if (delta[k]) buf[k] += asBigIntOr0(delta[k]);
      }
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flushNow();
    },
  };
}

async function listNextQueued(jobId, limit = 5) {
  const r = await db.query(
    `SELECT *
     FROM import_job_items
     WHERE job_id=$1
       AND status IN ('queued','retrying')
     ORDER BY id ASC
     LIMIT $2`,
    [jobId, clamp(limit, 1, 25)],
  );
  return r.rows || [];
}

/**
 * ✅ Precompute bytes_total once so frontend Selected bytes doesn’t “jump”
 */
async function ensureJobBytesTotal(jobId) {
  const r = await db.query(
    `SELECT id, source_key, source_size_bytes
     FROM import_job_items
     WHERE job_id=$1
       AND status IN ('queued','retrying')
     ORDER BY id ASC
     LIMIT 500`,
    [jobId],
  );

  let total = 0;

  for (const row of r.rows || []) {
    let sz = asBigIntOr0(row.source_size_bytes);
    if (!sz) {
      try {
        const head = await wasabi.headObject({ key: row.source_key });
        const size = asBigIntOr0(
          head?.contentLength || head?.ContentLength || head?.size || 0,
        );
        if (size > 0) {
          await updateItem(jobId, row.id, { source_size_bytes: size });
          sz = size;
        }
      } catch {
        // ignore
      }
    }
    total += sz;
  }

  const job = await getJob(jobId);
  const current = asBigIntOr0(job?.totals?.bytes_total || 0);

  if (current <= 0 && total > 0) {
    await db.query(
      `UPDATE import_jobs
       SET totals = jsonb_set(
         COALESCE(totals,'{}'::jsonb),
         '{bytes_total}',
         to_jsonb(($2)::bigint),
         true
       )
       WHERE id=$1`,
      [jobId, total],
    );
  }
}

async function finalizeJob(jobId) {
  const agg = await db.query(
    `SELECT
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued','retrying','validating','copying','importing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped
     FROM import_job_items
     WHERE job_id=$1`,
    [jobId],
  );

  const pending = Number(agg.rows[0].pending || 0);
  const failedCount = Number(agg.rows[0].failed || 0);

  const finalStatus =
    pending === 0 ? (failedCount > 0 ? "failed" : "completed") : "running";

  await db.query(
    `UPDATE import_jobs
     SET status=$2,
         finished_at=CASE WHEN $2 IN ('completed','failed','canceled') THEN NOW() ELSE finished_at END,
         totals = jsonb_set(
           jsonb_set(
             jsonb_set(coalesce(totals,'{}'::jsonb), '{completed}', to_jsonb(($3)::int), true),
             '{skipped}', to_jsonb(($4)::int), true
           ),
           '{failed}', to_jsonb(($5)::int), true
         )
     WHERE id=$1`,
    [
      jobId,
      finalStatus,
      Number(agg.rows[0].completed || 0),
      Number(agg.rows[0].skipped || 0),
      failedCount,
    ],
  );

  return { ok: true, job_id: jobId, status: finalStatus };
}

/**
 * Best-effort: get a readable stream for a Wasabi object.
 */
async function getWasabiReadable(key) {
  if (typeof wasabi.getObjectStream === "function") {
    const r = await wasabi.getObjectStream({ key });
    if (r && typeof r.pipe === "function") return { stream: r };
    if (r?.stream && typeof r.stream.pipe === "function") return r;
    if (r?.Body && typeof r.Body.pipe === "function") return { stream: r.Body };
  }

  if (typeof wasabi.getObject === "function") {
    const r = await wasabi.getObject({ key });
    if (r && typeof r.pipe === "function") return { stream: r };
    if (r?.stream && typeof r.stream.pipe === "function") return r;
    if (r?.Body && typeof r.Body.pipe === "function") return { stream: r.Body };
  }

  if (typeof wasabi.getStream === "function") {
    const r = await wasabi.getStream({ key });
    if (r && typeof r.pipe === "function") return { stream: r };
    if (r?.stream && typeof r.stream.pipe === "function") return r;
    if (r?.Body && typeof r.Body.pipe === "function") return { stream: r.Body };
  }

  throw new Error(
    "Wasabi provider missing getObjectStream/getObject/getStream that returns a readable stream.",
  );
}

/* =======================================================
   ✅ Videos table insert plan (auto-detect columns)
======================================================= */
let _videosInsertPlan = null;

async function getVideosInsertPlan() {
  if (_videosInsertPlan) return _videosInsertPlan;

  const r = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='videos'`,
  );

  const cols = new Set((r.rows || []).map((x) => x.column_name));

  // choose the first URL-ish column that exists
  const urlCandidates = [
    "url",
    "video_url",
    "stream_url",
    "source_url",
    "play_url",
    "media_url",
    "bunny_url",
    "file_url",
  ];
  const urlCol = urlCandidates.find((c) => cols.has(c)) || null;

  const titleCol = cols.has("title") ? "title" : null;

  // optional columns
  const visibilityCol = cols.has("visibility") ? "visibility" : null;
  const categoryCol = cols.has("category_id") ? "category_id" : null;
  const createdAtCol = cols.has("created_at") ? "created_at" : null;

  if (!titleCol) {
    throw new Error(
      `videos table is missing required column "title". Found columns: ${Array.from(
        cols,
      )
        .sort()
        .join(", ")}`,
    );
  }
  if (!urlCol) {
    throw new Error(
      `videos table has no recognized URL column. Add one (e.g. video_url) or update urlCandidates. Found columns: ${Array.from(
        cols,
      )
        .sort()
        .join(", ")}`,
    );
  }

  _videosInsertPlan = {
    cols,
    titleCol,
    urlCol,
    visibilityCol,
    categoryCol,
    createdAtCol,
  };
  return _videosInsertPlan;
}

async function insertVideoRecord({ title, url, visibility, category_id }) {
  const plan = await getVideosInsertPlan();

  const columns = [];
  const values = [];
  const params = [];

  let idx = 1;

  columns.push(plan.titleCol);
  params.push(`$${idx++}`);
  values.push(title);

  columns.push(plan.urlCol);
  params.push(`$${idx++}`);
  values.push(url);

  if (plan.visibilityCol) {
    columns.push(plan.visibilityCol);
    params.push(`$${idx++}`);
    values.push(visibility);
  }

  if (plan.categoryCol) {
    columns.push(plan.categoryCol);
    params.push(`$${idx++}`);
    values.push(category_id ?? null);
  }

  // If created_at exists, set NOW(); otherwise rely on DB defaults
  const createdAtSQL = plan.createdAtCol ? `, ${plan.createdAtCol}` : "";
  const createdAtValSQL = plan.createdAtCol ? `, NOW()` : "";

  const sql = `
    INSERT INTO videos (${columns.join(", ")}${createdAtSQL})
    VALUES (${params.join(", ")}${createdAtValSQL})
  `;

  await db.query(sql, values);
}

/* =======================================================
   MAIN RUNNER
======================================================= */
async function runJob(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error("Job not found");

  if (job.status === "canceled") return { ok: true, status: "canceled" };

  const totalsBuf = makeTotalsBuffer(jobId);

  await setJobStatus(jobId, "running", { started: true, last_error: null });

  await db.query(
    `UPDATE import_jobs SET totals = COALESCE(totals,'{}'::jsonb) WHERE id=$1`,
    [jobId],
  );

  const settings = job.settings || {};
  await ensureJobBytesTotal(jobId);

  const mode = safeStr(job.mode || "remote");

  let exitedPaused = false;
  let exitedCanceled = false;

  while (true) {
    const live = await getJob(jobId);
    if (!live) break;

    const status = safeStr(live.status);
    if (status === "paused") {
      exitedPaused = true;
      break;
    }
    if (status === "canceled") {
      exitedCanceled = true;
      break;
    }

    const batch = await listNextQueued(jobId, 3);
    if (!batch.length) break;

    for (const item of batch) {
      const live2 = await getJob(jobId);
      if (!live2) break;

      const st2 = safeStr(live2.status);
      if (st2 === "paused") {
        exitedPaused = true;
        break;
      }
      if (st2 === "canceled") {
        exitedCanceled = true;
        break;
      }

      const itemId = item.id;
      const key = safeStr(item.source_key);

      try {
        if (mode === "copy_to_bunny") {
          await updateItem(jobId, itemId, { status: "copying", error: null });

          let head = null;
          try {
            head = await wasabi.headObject({ key });
          } catch {
            head = null;
          }

          const contentLength = asBigIntOr0(
            head?.contentLength ||
              head?.ContentLength ||
              head?.size ||
              item.source_size_bytes ||
              0,
          );

          // ✅ Persist size ASAP so UI can show "0 / X" even while queued/copying
          if (contentLength > 0 && !asBigIntOr0(item.source_size_bytes)) {
            await updateItem(jobId, itemId, {
              source_size_bytes: contentLength,
            });
          }

          const contentType =
            safeStr(head?.contentType || head?.ContentType || "") ||
            (String(key).toLowerCase().endsWith(".mp4") ? "video/mp4" : "");

          const { stream: srcStream } = await getWasabiReadable(key);

          const counter = new PassThrough();
          srcStream.on("data", (chunk) => {
            const n = chunk?.length || 0;
            if (n > 0) totalsBuf.add({ bytes_copied: n });
          });
          srcStream.on("error", (e) => counter.destroy(e));
          srcStream.pipe(counter);

          const up = await bunny.copyFromWasabiStream({
            sourceKey: key,
            contentType,
            contentLength: contentLength || undefined,
            stream: counter,
          });

          const destUrl = up?.cdnUrl || up?.destPath || "";
          if (!destUrl)
            throw new Error("Bunny upload did not return a URL/path");

          await updateItem(jobId, itemId, {
            status: "importing",
            dest_url: destUrl || null,
          });

          const title =
            typeof wasabi.titleFromKey === "function"
              ? wasabi.titleFromKey({
                  key,
                  mode: safeStr(
                    settings.default_title_mode || "filename_no_ext",
                  ),
                })
              : safeStr(key).split("/").pop();

          await insertVideoRecord({
            title,
            url: destUrl,
            visibility: safeStr(settings.visibility || "private"),
            category_id: settings.category_id || null,
          });

          await updateItem(jobId, itemId, { status: "completed", error: null });
          totalsBuf.add({ completed: 1 });
        } else {
          // remote mode
          await updateItem(jobId, itemId, { status: "importing", error: null });

          // ✅ Persist size for remote too (helps UI + snapshots)
          if (!asBigIntOr0(item.source_size_bytes)) {
            try {
              const head = await wasabi.headObject({ key });
              const size = asBigIntOr0(
                head?.contentLength || head?.ContentLength || head?.size || 0,
              );
              if (size > 0) {
                await updateItem(jobId, itemId, { source_size_bytes: size });
              }
            } catch {
              // ignore
            }
          }

          const url =
            typeof wasabi.buildRemoteUrl === "function"
              ? await wasabi.buildRemoteUrl({
                  key,
                  access_mode: safeStr(settings.access_mode || "auto"),
                  signed_url_ttl_seconds: asBigIntOr0(
                    settings.signed_url_ttl_seconds || 3600,
                  ),
                })
              : await wasabi.makeRemoteUrl({ key });

          const title =
            typeof wasabi.titleFromKey === "function"
              ? wasabi.titleFromKey({
                  key,
                  mode: safeStr(
                    settings.default_title_mode || "filename_no_ext",
                  ),
                })
              : safeStr(key).split("/").pop();

          await insertVideoRecord({
            title,
            url,
            visibility: safeStr(settings.visibility || "private"),
            category_id: settings.category_id || null,
          });

          await updateItem(jobId, itemId, {
            status: "completed",
            dest_url: url,
            error: null,
          });

          totalsBuf.add({ completed: 1 });
        }
      } catch (e) {
        const msg = safeStr(e?.message || "Import failed");
        console.error("[engine item failed]", jobId, itemId, msg);

        await updateItem(jobId, itemId, { status: "failed", error: msg });
        totalsBuf.add({ failed: 1 });

        await db.query(`UPDATE import_jobs SET last_error=$2 WHERE id=$1`, [
          jobId,
          msg,
        ]);
      }
    }

    if (exitedPaused || exitedCanceled) break;
  }

  await totalsBuf.flush();

  if (exitedPaused) {
    return { ok: true, job_id: jobId, status: "paused" };
  }

  if (exitedCanceled) {
    await setJobStatus(jobId, "canceled", { finished: true });
    return { ok: true, job_id: jobId, status: "canceled" };
  }

  return await finalizeJob(jobId);
}

module.exports = { runJob };
