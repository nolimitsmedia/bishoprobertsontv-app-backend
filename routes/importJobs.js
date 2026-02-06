// server-api/routes/importJobs.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const wasabi = require("../services/importer/providers/importWasabi");
const { runJob } = require("../services/importer/engine");

function isMp4(key = "") {
  return String(key).toLowerCase().endsWith(".mp4");
}

function parseNullableInt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function parseIdArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
      .map((n) => Math.trunc(n))
      .filter((n) => n > 0);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n))
      .map((n) => Math.trunc(n))
      .filter((n) => n > 0);
  }
  return [];
}

/* =======================================================
   POST /api/admin/import-jobs
   ✅ FIX: totals is NOT NULL -> always insert '{}'::jsonb
======================================================= */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "remote");
    if (!["remote", "copy_to_bunny"].includes(mode)) {
      return res
        .status(400)
        .json({ ok: false, message: "mode must be remote or copy_to_bunny" });
    }

    const settings = {
      prefix: String(req.body?.prefix || "").trim(),
      visibility: String(req.body?.visibility || "private").toLowerCase(),
      category_id: parseNullableInt(req.body?.category_id),
      default_title_mode: String(
        req.body?.default_title_mode || "filename_no_ext",
      ),
    };

    const totals = {
      scanned: 0,
      bytes_total: 0,
      bytes_copied: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };

    const r = await db.query(
      `INSERT INTO import_jobs
        (source_provider, dest_provider, mode, status, settings, totals, requested_by_admin_id)
       VALUES
        ('wasabi', $1, $2, 'queued', $3::jsonb, $4::jsonb, $5)
       RETURNING *`,
      [
        mode === "copy_to_bunny" ? "bunny" : null,
        mode,
        JSON.stringify(settings),
        JSON.stringify(totals),
        req.user?.id || null,
      ],
    );

    res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("[import-jobs create]", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
});

/* =======================================================
   POST /api/admin/import-jobs/:id/scan
======================================================= */
router.post("/:id/scan", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    await db.query(
      `UPDATE import_jobs SET status='scanning', last_error=NULL WHERE id=$1`,
      [jobId],
    );

    const jobR = await db.query(`SELECT * FROM import_jobs WHERE id=$1`, [
      jobId,
    ]);
    if (!jobR.rows[0])
      return res.status(404).json({ ok: false, message: "Job not found" });

    const job = jobR.rows[0];
    const settings = job.settings || {};

    const prefix = String(req.body?.prefix || settings.prefix || "").trim();
    const limit = Math.max(1, Math.min(1000, Number(req.body?.limit || 1000)));

    const listed = await wasabi.listObjects({ prefix, limit, cursor: "" });
    const mp4Items = (listed.items || []).filter((it) => isMp4(it.key));

    let inserted = 0;

    if (mp4Items.length) {
      const payload = mp4Items.map((it) => ({
        key: it.key,
        etag: it.etag || null,
        size: Number(it.size || 0),
        lastModified: it.lastModified || null,
      }));

      const ins = await db.query(
        `
        WITH data AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb)
          AS x(key text, etag text, size bigint, "lastModified" timestamptz)
        )
        INSERT INTO import_job_items
          (job_id, status, source_key, source_etag, source_size_bytes, source_last_modified)
        SELECT
          $1,
          'queued',
          data.key,
          data.etag,
          data.size,
          data."lastModified"
        FROM data
        ON CONFLICT (job_id, source_key) DO NOTHING
        `,
        [jobId, JSON.stringify(payload)],
      );

      inserted = ins.rowCount || 0;
    }

    await db.query(
      `UPDATE import_jobs
       SET status='ready',
           totals = jsonb_set(coalesce(totals,'{}'::jsonb), '{scanned}', to_jsonb(($2)::int), true)
       WHERE id=$1`,
      [jobId, mp4Items.length],
    );

    res.json({
      ok: true,
      job_id: jobId,
      prefix: listed.prefix,
      scanned: mp4Items.length,
      inserted,
      next_cursor: listed.next_cursor,
      sample: mp4Items.slice(0, 25),
    });
  } catch (e) {
    console.error("[import-jobs scan]", e);
    try {
      await db.query(
        `UPDATE import_jobs SET status='failed', last_error=$2 WHERE id=$1`,
        [jobId, e.message || "scan failed"],
      );
    } catch {}
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
});

/* =======================================================
   POST /api/admin/import-jobs/:id/start
   ✅ FIX: mark job running immediately (so UI polls)
======================================================= */
router.post("/:id/start", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    const jr = await db.query(`SELECT * FROM import_jobs WHERE id=$1`, [jobId]);
    if (!jr.rows[0])
      return res.status(404).json({ ok: false, message: "Job not found" });

    const status = jr.rows[0].status;
    if (!["queued", "ready", "paused", "failed"].includes(status)) {
      return res
        .status(400)
        .json({ ok: false, message: `Job is ${status}. Cannot start.` });
    }

    const itemIds = parseIdArray(req.body?.item_ids);

    // If "start selected" was used, skip everything else and ensure selected are queued
    if (itemIds.length) {
      await db.query(
        `
        WITH sel AS (SELECT unnest($2::int[]) AS id)
        UPDATE import_job_items
        SET status='skipped'
        WHERE job_id=$1
          AND status IN ('queued','retrying')
          AND id NOT IN (SELECT id FROM sel)
        `,
        [jobId, itemIds],
      );

      await db.query(
        `
        WITH sel AS (SELECT unnest($2::int[]) AS id)
        UPDATE import_job_items
        SET status='queued'
        WHERE job_id=$1
          AND id IN (SELECT id FROM sel)
          AND status='skipped'
        `,
        [jobId, itemIds],
      );
    }

    // ✅ Make job "running" right away so frontend poll kicks in
    await db.query(
      `UPDATE import_jobs
       SET status='running',
           started_at=COALESCE(started_at, NOW()),
           finished_at=NULL,
           last_error=NULL
       WHERE id=$1`,
      [jobId],
    );

    res.json({
      ok: true,
      message: itemIds.length
        ? `Job started (selected only: ${itemIds.length})`
        : "Job started",
      job_id: jobId,
      selected_count: itemIds.length || 0,
    });

    setImmediate(async () => {
      try {
        await runJob(jobId);
      } catch (e) {
        console.error("[import-jobs start runner]", e);
        try {
          await db.query(
            `UPDATE import_jobs SET status='failed', last_error=$2 WHERE id=$1`,
            [jobId, e.message || "job failed"],
          );
        } catch {}
      }
    });
  } catch (e) {
    console.error("[import-jobs start]", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
});

/* =======================================================
   POST /api/admin/import-jobs/:id/pause
======================================================= */
router.post("/:id/pause", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    await db.query(`UPDATE import_jobs SET status='paused' WHERE id=$1`, [
      jobId,
    ]);
    res.json({ ok: true, message: "Job paused", job_id: jobId });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   POST /api/admin/import-jobs/:id/cancel
======================================================= */
router.post("/:id/cancel", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    await db.query(
      `UPDATE import_jobs SET status='canceled', finished_at=NOW() WHERE id=$1`,
      [jobId],
    );
    res.json({ ok: true, message: "Job canceled", job_id: jobId });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   GET /api/admin/import-jobs/:id
======================================================= */
router.get("/:id", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    const jobR = await db.query(`SELECT * FROM import_jobs WHERE id=$1`, [
      jobId,
    ]);
    if (!jobR.rows[0])
      return res.status(404).json({ ok: false, message: "Job not found" });

    const agg = await db.query(
      `SELECT
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('queued','retrying','validating','copying','importing') THEN 1 ELSE 0 END) AS pending
       FROM import_job_items WHERE job_id=$1`,
      [jobId],
    );

    res.json({ ok: true, job: jobR.rows[0], counts: agg.rows[0] });
  } catch (e) {
    console.error("[import-jobs get]", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   GET /api/admin/import-jobs/:id/items/by-ids?ids=1,2,3
======================================================= */
router.get("/:id/items/by-ids", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    const ids = parseIdArray(req.query.ids).slice(0, 500);
    if (!ids.length) return res.json({ ok: true, items: [] });

    const r = await db.query(
      `
      SELECT *
      FROM import_job_items
      WHERE job_id = $1
        AND id = ANY($2::int[])
      ORDER BY id ASC
      `,
      [jobId, ids],
    );

    res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error("[import-jobs by-ids]", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   GET /api/admin/import-jobs/:id/items?status=queued&limit=200
======================================================= */
router.get("/:id/items", requireAuth, requireAdmin, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId))
    return res.status(400).json({ ok: false, message: "Invalid job id" });

  try {
    const status = String(req.query.status || "").trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    let r;
    if (status) {
      r = await db.query(
        `SELECT * FROM import_job_items
         WHERE job_id=$1 AND status=$2
         ORDER BY id DESC
         LIMIT $3`,
        [jobId, status, limit],
      );
    } else {
      r = await db.query(
        `SELECT * FROM import_job_items
         WHERE job_id=$1
         ORDER BY id DESC
         LIMIT $2`,
        [jobId, limit],
      );
    }

    res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error("[import-jobs items]", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
