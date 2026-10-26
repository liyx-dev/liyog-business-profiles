// =====================================================================
// LIYOG WORLD — src/lib/analytics-settings.js
//
// Every limit used by boost analytics, charts, summaries and the nightly
// maintenance lives here as a SETTING (a row in app_settings), never as a
// hard-coded number. You change one with a single line of SQL in the D1
// console, no deploy needed:
//
//   UPDATE app_settings SET value = '30' WHERE key = 'analytics_hourly_retention_days';
//   INSERT INTO app_settings (key, value) SELECT 'analytics_hourly_retention_days', '30'
//     WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'analytics_hourly_retention_days');
//
// A missing row simply means "use the default below". Every value is
// clamped to a safe range, so a typo (for example -5 or 99999999) can never
// break the system or wipe data by accident.
//
// Reads are cheap by design: ONE query fetches all of them, and the result
// is cached for 60 seconds per server instance.
// =====================================================================

// type: "int" -> whole number clamped to [min, max];  "bool" -> 1 / 0
export const TUNABLES = {
  // ---- master switches ------------------------------------------------
  boost_maintenance_enabled:        { type: "bool", def: 1 },          // nightly clean-up + roll-up as a whole
  analytics_rollup_enabled:         { type: "bool", def: 1 },          // roll hourly counters into daily rows
  purchase_archive_to_r2:           { type: "bool", def: 0 },          // copy a paid purchase to R2 before deleting it

  // ---- analytics data (counters) --------------------------------------
  analytics_hourly_retention_days:  { type: "int", def: 14,  min: 2,  max: 90 },     // keep hour-by-hour detail this long
  analytics_daily_retention_days:   { type: "int", def: 730, min: 0,  max: 3650 },   // 0 = keep daily history forever
  analytics_rollup_max_rows:        { type: "int", def: 50000, min: 1000, max: 500000 }, // safety: skip a day bigger than this
  analytics_rollup_max_days_per_run:{ type: "int", def: 2,   min: 1,  max: 14 },     // catch-up speed per night

  // ---- what owners see ------------------------------------------------
  analytics_history_limit:          { type: "int", def: 20,  min: 5,  max: 100 },    // ended boosts listed (active ones are ALWAYS all shown)
  analytics_chart_hourly_max_hours: { type: "int", def: 72,  min: 24, max: 336 },    // boosts up to this long get an hour-by-hour chart
  analytics_summary_window_days:    { type: "int", def: 14,  min: 0,  max: 90 },     // "your boost ended" card for this long; 0 = never show it

  // ---- money records (boost purchases) --------------------------------
  purchase_retention_pending_days:  { type: "int", def: 7,   min: 0,  max: 365 },    // unpaid requests; 0 = keep forever
  purchase_retention_failed_days:   { type: "int", def: 90,  min: 0,  max: 3650 },   // failed payments; 0 = keep forever
  purchase_retention_confirmed_days:{ type: "int", def: 0,   min: 0,  max: 7300 },   // PAID purchases; 0 = keep forever (the safe default)
  purchase_retention_batch:         { type: "int", def: 10,  min: 1,  max: 500 },    // paid purchases processed per night (each archive = 1 R2 write)

  // ---- live boost rows -------------------------------------------------
  boost_log_retention_days:         { type: "int", def: 7,   min: 1,  max: 365 }     // ended boosts' live rows (powers "Delivered")
};

const KEYS = Object.keys(TUNABLES);
const CACHE_MS = 60000;
let cache = { at: 0, value: null };

function parse(spec, raw) {
  if (raw === undefined || raw === null || raw === "") return spec.def;
  if (spec.type === "bool") {
    const v = String(raw).trim().toLowerCase();
    if (v === "1" || v === "true" || v === "on" || v === "yes") return 1;
    if (v === "0" || v === "false" || v === "off" || v === "no") return 0;
    return spec.def;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

/** All settings as numbers (bools are 1/0). One query, cached 60s unless { fresh: true }. */
export async function getTunables(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.value && now - cache.at < CACHE_MS) return cache.value;

  const raw = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM app_settings WHERE key IN (${KEYS.map(() => "?").join(",")})`
    ).bind(...KEYS).all();
    results.forEach((r) => { raw[r.key] = r.value; });
  } catch (e) { /* settings unreadable: fall back to the defaults below */ }

  const value = {};
  KEYS.forEach((k) => { value[k] = parse(TUNABLES[k], raw[k]); });
  cache = { at: now, value };
  return value;
}

export function resetTunablesCache() {
  cache = { at: 0, value: null };
}

