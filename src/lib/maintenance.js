// =====================================================================
// LIYOG WORLD — src/lib/maintenance.js   (nightly boost housekeeping)
//
// Runs once a night from the EXISTING 03:00 cron (no new cron needed).
// Keeps the database small and cheap as the platform grows, the way big
// platforms do it: recent data stays detailed, older data is summarised,
// and old records are removed on a policy YOU control.
//
//   HOT   boost_stats_hourly   hour-by-hour counters, kept N days
//   WARM  boost_stats_daily    one row per boost/day/page/country, kept M days
//   COLD  R2 archive           (optional) a copy of paid purchases kept for
//                              receipts after they leave the database
//
// EVERY rule below is a setting (see analytics-settings.js), changeable
// with one line of SQL, and almost all can be switched off:
//
//   boost_maintenance_enabled          master switch for everything here
//   analytics_rollup_enabled           roll hourly counters into daily rows
//   analytics_hourly_retention_days    14   how long hourly detail is kept
//   analytics_daily_retention_days     730  (0 = keep daily history forever)
//   purchase_retention_pending_days    7    unpaid requests   (0 = keep forever)
//   purchase_retention_failed_days     90   failed payments   (0 = keep forever)
//   purchase_retention_confirmed_days  0    PAID purchases    (0 = keep forever)
//   purchase_archive_to_r2             0    copy to R2 before deleting a paid one
//   boost_log_retention_days           7    live boost rows after they end
//
// Safety design:
//   * Each step has its own try/catch: one failing step never stops the rest.
//   * The roll-up adds to the daily row and deletes the hourly rows in ONE
//     atomic batch, so a crash can never double-count or lose a count.
//   * A "circuit breaker" skips any day with more rows than
//     analytics_rollup_max_rows, protecting your daily quota.
//   * Paid purchases are NEVER deleted unless you set a retention for them;
//     with archiving on, a purchase is only deleted after its R2 copy is saved.
//   * Few database calls per night (about 8 in a normal run).
//   * dryRun reports what WOULD happen and changes nothing.
// =====================================================================

import { getTunables } from "./analytics-settings.js";

const DAY = 86400e3;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (ms) => Math.floor(ms / DAY) * DAY;
const changesOf = (res) => Number(res && res.meta && res.meta.changes) || 0;
const DAILY_DELETE_CHUNK = 5000;

export const ARCHIVE_PREFIX = "archive/boost-purchases";

const safePart = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
export const archiveKey = (profileId, purchaseId) => `${ARCHIVE_PREFIX}/${safePart(profileId)}/${safePart(purchaseId)}.json`;

/** For the future receipts page: fetch a paid purchase that has left the database. */
export async function getArchivedPurchase(env, profileId, purchaseId) {
  try {
    if (!env.ASSETS) return null;
    const object = await env.ASSETS.get(archiveKey(profileId, purchaseId));
    return object ? JSON.parse(await object.text()) : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// Step 1 — live boost rows after they end
// ---------------------------------------------------------------------
async function cleanLiveBoosts(env, t, now, dryRun) {
  const cutoff = sqlTime(now - t.boost_log_retention_days * DAY);
  if (dryRun) {
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM boost_log WHERE expires_at < ?").bind(cutoff).all();
    return { wouldDelete: Number(results[0].n) || 0, olderThanDays: t.boost_log_retention_days };
  }
  const res = await env.DB.prepare("DELETE FROM boost_log WHERE expires_at < ?").bind(cutoff).run();
  return { deleted: changesOf(res), olderThanDays: t.boost_log_retention_days };
}

// ---------------------------------------------------------------------
// Step 2 — unpaid and failed purchase requests (one statement)
// ---------------------------------------------------------------------
async function cleanUnpaidPurchases(env, t, now, dryRun) {
  const clauses = [];
  const binds = [];
  if (t.purchase_retention_pending_days > 0) {
    clauses.push("(status = 'pending' AND created_at IS NOT NULL AND created_at < ?)");
    binds.push(sqlTime(now - t.purchase_retention_pending_days * DAY));
  }
  if (t.purchase_retention_failed_days > 0) {
    clauses.push("(status = 'failed' AND created_at IS NOT NULL AND created_at < ?)");
    binds.push(sqlTime(now - t.purchase_retention_failed_days * DAY));
  }
  if (!clauses.length) return { skipped: "pending and failed retention are both 0 (keep forever)" };

  const where = clauses.join(" OR ");
  if (dryRun) {
    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM boost_purchases WHERE ${where}`).bind(...binds).all();
    return { wouldDelete: Number(results[0].n) || 0, pendingDays: t.purchase_retention_pending_days, failedDays: t.purchase_retention_failed_days };
  }
  const res = await env.DB.prepare(`DELETE FROM boost_purchases WHERE ${where}`).bind(...binds).run();
  return { deleted: changesOf(res), pendingDays: t.purchase_retention_pending_days, failedDays: t.purchase_retention_failed_days };
}

// ---------------------------------------------------------------------
// Step 3 — PAID purchases (off by default: 0 = keep forever)
// ---------------------------------------------------------------------
async function retirePaidPurchases(env, t, now, dryRun) {
  if (t.purchase_retention_confirmed_days <= 0) return { skipped: "paid purchases are kept forever (purchase_retention_confirmed_days = 0)" };
  const cutoff = sqlTime(now - t.purchase_retention_confirmed_days * DAY);
  const archive = !!t.purchase_archive_to_r2;

  if (dryRun) {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM boost_purchases WHERE status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_at < ?"
    ).bind(cutoff).all();
    return { wouldRetire: Number(results[0].n) || 0, perNight: t.purchase_retention_batch, archiveToR2: archive, olderThanDays: t.purchase_retention_confirmed_days };
  }

  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM boost_purchases WHERE status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_at < ? ORDER BY confirmed_at ASC LIMIT ?"
  ).bind(cutoff, t.purchase_retention_batch).all();
  if (!rows.length) return { candidates: 0, deleted: 0, archived: 0, archiveFailed: 0, archiveToR2: archive };

  const deletable = [];
  let archived = 0, archiveFailed = 0;
  for (const row of rows) {
    if (!archive) { deletable.push(row.id); continue; }
    try {
      if (!env.ASSETS) throw new Error("no R2 binding");
      await env.ASSETS.put(archiveKey(row.profile_id, row.id), JSON.stringify({ ...row, archived_at: new Date(now).toISOString() }), {
        httpMetadata: { contentType: "application/json" }
      });
      archived++;
      deletable.push(row.id);                  // only after its copy is safely stored
    } catch (e) { archiveFailed++; }
  }

  let deleted = 0;
  if (deletable.length) {
    const res = await env.DB.prepare(
      `DELETE FROM boost_purchases WHERE status = 'confirmed' AND id IN (${deletable.map(() => "?").join(",")})`
    ).bind(...deletable).run();
    deleted = changesOf(res);
  }
  return { candidates: rows.length, deleted, archived, archiveFailed, archiveToR2: archive };
}

// ---------------------------------------------------------------------
// Step 4 — roll hourly counters into daily rows (one day = one atomic batch)
// ---------------------------------------------------------------------
const ROLLUP_SQL = `
  INSERT INTO boost_stats_daily (stat_key, day, placement, country, impressions, clicks, whatsapp, calls)
  SELECT stat_key, substr(bucket, 1, 10), placement, country,
         SUM(impressions), SUM(clicks), SUM(whatsapp), SUM(calls)
  FROM boost_stats_hourly
  WHERE bucket >= ? AND bucket < ?
  GROUP BY stat_key, substr(bucket, 1, 10), placement, country
  ON CONFLICT (stat_key, day, placement, country) DO UPDATE SET
    impressions = impressions + excluded.impressions,
    clicks = clicks + excluded.clicks,
    whatsapp = whatsapp + excluded.whatsapp,
    calls = calls + excluded.calls`;

async function rollupHourly(env, t, now, dryRun) {
  if (!t.analytics_rollup_enabled) return { skipped: "analytics_rollup_enabled is off" };

  // Only whole days older than the hourly retention are eligible.
  const cutoff = `${dayString(dayStartMs(now - t.analytics_hourly_retention_days * DAY))} 00:00`;
  const out = { days: 0, rows: 0, skipped: [], hourlyKeptDays: t.analytics_hourly_retention_days };
  let lower = "0000-00-00 00:00";

  for (let i = 0; i < t.analytics_rollup_max_days_per_run; i++) {
    const { results: first } = await env.DB.prepare(
      "SELECT MIN(bucket) AS b FROM boost_stats_hourly WHERE bucket >= ? AND bucket < ?"
    ).bind(lower, cutoff).all();
    const firstBucket = first[0] && first[0].b;
    if (!firstBucket) break;

    const day = firstBucket.slice(0, 10);
    const dayStart = `${day} 00:00`;
    const dayEnd = `${dayString(Date.parse(`${day}T00:00:00Z`) + DAY)} 00:00`;
    lower = dayEnd;

    const { results: counted } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM boost_stats_hourly WHERE bucket >= ? AND bucket < ?"
    ).bind(dayStart, dayEnd).all();
    const rows = Number(counted[0].n) || 0;

    if (rows > t.analytics_rollup_max_rows) { out.skipped.push({ day, rows, reason: "bigger than analytics_rollup_max_rows" }); continue; }
    if (!dryRun) {
      await env.DB.batch([
        env.DB.prepare(ROLLUP_SQL).bind(dayStart, dayEnd),
        env.DB.prepare("DELETE FROM boost_stats_hourly WHERE bucket >= ? AND bucket < ?").bind(dayStart, dayEnd)
      ]);
    }
    out.days++;
    out.rows += rows;
  }
  return out;
}

// ---------------------------------------------------------------------
// Step 5 — very old daily history (off when retention is 0)
// ---------------------------------------------------------------------
async function trimDaily(env, t, now, dryRun) {
  if (t.analytics_daily_retention_days <= 0) return { skipped: "daily history is kept forever (analytics_daily_retention_days = 0)" };
  const cutoff = dayString(now - t.analytics_daily_retention_days * DAY);
  if (dryRun) {
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM boost_stats_daily WHERE day < ?").bind(cutoff).all();
    return { wouldDelete: Number(results[0].n) || 0, olderThanDays: t.analytics_daily_retention_days };
  }
  const res = await env.DB.prepare(
    `DELETE FROM boost_stats_daily WHERE rowid IN (SELECT rowid FROM boost_stats_daily WHERE day < ? LIMIT ${DAILY_DELETE_CHUNK})`
  ).bind(cutoff).run();
  return { deleted: changesOf(res), olderThanDays: t.analytics_daily_retention_days };
}

// ---------------------------------------------------------------------
// Remember the last run (one tiny write a night) so you can check it in SQL:
//   SELECT value FROM app_settings WHERE key = 'boost_maintenance_last_run';
// ---------------------------------------------------------------------
async function recordRun(env, report) {
  try {
    const value = JSON.stringify({ at: report.at, steps: report.steps }).slice(0, 1800);
    await env.DB.batch([
      env.DB.prepare("UPDATE app_settings SET value = ? WHERE key = 'boost_maintenance_last_run'").bind(value),
      env.DB.prepare(
        "INSERT INTO app_settings (key, value) SELECT 'boost_maintenance_last_run', ? WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'boost_maintenance_last_run')"
      ).bind(value)
    ]);
  } catch (e) { /* the record is a convenience, never a requirement */ }
}

/** Runs every step. Never throws. dryRun:true changes nothing. */
export async function runBoostMaintenance(env, { dryRun = false, now = Date.now() } = {}) {
  const report = { dryRun, at: new Date(now).toISOString(), steps: {} };
  let t;
  try { t = await getTunables(env, { fresh: true }); }
  catch (e) { report.error = "settings unreadable"; return report; }

  if (!t.boost_maintenance_enabled) { report.skipped = "boost_maintenance_enabled is off"; return report; }

  const steps = [
    ["liveBoosts", () => cleanLiveBoosts(env, t, now, dryRun)],
    ["unpaidPurchases", () => cleanUnpaidPurchases(env, t, now, dryRun)],
    ["paidPurchases", () => retirePaidPurchases(env, t, now, dryRun)],
    ["rollup", () => rollupHourly(env, t, now, dryRun)],
    ["dailyHistory", () => trimDaily(env, t, now, dryRun)]
  ];
  for (const [name, step] of steps) {
    try { report.steps[name] = await step(); }
    catch (err) {
      console.error(`Boost maintenance step "${name}" failed (the others continue):`, err);
      report.steps[name] = { error: String((err && err.message) || err) };
    }
  }
  if (!dryRun) await recordRun(env, report);
  return report;
}

/**
 * POST /api/boost/maintenance   (admin only: header x-admin-secret)
 * Default is a DRY RUN. Add ?dry=0 to really run it now instead of waiting for 03:00.
 */
export async function handleMaintenanceRequest(request, env) {
  const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const given = request.headers.get("x-admin-secret") || "";
  const secret = env.ADMIN_SECRET || "";
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.min(given.length, secret.length); i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  if (!secret || diff !== 0) return json({ error: "Not authorized" }, 401);
  const dryRun = new URL(request.url).searchParams.get("dry") !== "0";
  return json(await runBoostMaintenance(env, { dryRun }));
}

