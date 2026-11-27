// =====================================================================
// BIZIPLEX — src/lib/plan-engine.js
// "What plan is this brand on RIGHT NOW?": one place that answers it, whatever the source:
//   an old one-time purchase (kept for good), a plan you gave them, a paid subscription, or a free trial.
// The answer is written onto profiles.tier_id, which every existing page already reads (plans.js), so nothing
// else in the system has to change. Reads stay cheap: nothing here runs per page view.
//
//   recomputeEffectivePlan   picks the best plan and writes it         (only when something changed)
//   enforceVisibility        hides items beyond the plan's limit, shows them again after an upgrade (never deletes)
//   applyPlanChange          both of the above, then reports
//   startTrial               "Try Premium": starts the free trial
//   getPlanStatus            everything the Studio needs to show the plan, trial and reminders
//   syncIfDue                applies a trial/plan that ended since the last look
//   runPlanMaintenance       the nightly sweep: ends expired trials/subscriptions, tidies stale pending rows
// Every number you may want to tune is a SETTING (see SETTING_DEFS), editable on the admin page.
// =====================================================================
import { getProfileLimits } from "./plans.js";

export const DAY = 86400e3;

export const SETTING_DEFS = {
  trial_enabled:        { def: "1", type: "bool", group: "Free trial", label: "Free trial switched on" },
  trial_days:           { def: "14", type: "int", min: 1, max: 90, group: "Free trial", label: "Trial length (days)" },
  trial_plan_id:        { def: "plus", type: "plan", group: "Free trial", label: "Plan given during the trial" },
  trial_per_user:       { def: "1", type: "int", min: 1, max: 5, group: "Free trial", label: "Trials allowed per person (across all their brands)" },
  reminder_days:        { def: "3,1", type: "list", group: "Free trial", label: "Remind them when this many days are left (e.g. 3,1)" },
  sub_enabled:          { def: "1", type: "bool", group: "Paid plans", label: "Monthly / yearly plans switched on" },
  sub_billing_offered:  { def: "monthly,semiannual,yearly", type: "list", group: "Paid plans", label: "Billing choices shown (monthly, semiannual, yearly)" },
  sub_grace_days:       { def: "3", type: "int", min: 0, max: 30, group: "Paid plans", label: "Days a plan stays on after a payment is missed" },
  sub_retry_days:       { def: "3", type: "int", min: 1, max: 14, group: "Paid plans", label: "Daily payment retries before giving up" },
  sub_renewals_per_run: { def: "10", type: "int", min: 1, max: 200, group: "Paid plans", label: "Renewals charged per nightly run" },
  sub_upgrade_credit:   { def: "1", type: "bool", group: "Paid plans", label: "Give credit for unused time when upgrading" },
  legacy_ends_at:       { def: "", type: "date", group: "Old one-time plans", label: "End date for old one-time plans (empty = they keep them for good)" }
};

let settingsCache = { at: 0, v: null };
export function clearSettingsCache() { settingsCache = { at: 0, v: null }; }

export function parseSetting(key, raw) {
  const d = SETTING_DEFS[key]; if (!d) return null;
  const v = raw == null || raw === "" ? d.def : String(raw).trim();
  if (d.type === "bool") return v === "1" || v === "true" || v === "on";
  if (d.type === "int") { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(d.max, Math.max(d.min, n)) : Number(d.def); }
  if (d.type === "list") return String(v).split(",").map((x) => x.trim()).filter(Boolean);
  return v;
}

export async function getSettings(env, { fresh = false } = {}) {
  if (!fresh && settingsCache.v && Date.now() - settingsCache.at < 45000) return settingsCache.v;
  const keys = Object.keys(SETTING_DEFS), raw = {};
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
    for (const r of results) raw[r.key] = r.value;
  } catch (e) { /* defaults */ }
  const out = {};
  for (const k of keys) out[k] = parseSetting(k, raw[k]);
  settingsCache = { at: Date.now(), v: out };
  return out;
}

// ---- time (the database stores UTC "YYYY-MM-DD HH:MM:SS") ----
const pad = (n) => String(n).padStart(2, "0");
export function sqlTime(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
export function parseSql(s) { return s ? Date.parse(String(s).replace(" ", "T") + (/[zZ]$/.test(s) ? "" : "Z")) : NaN; }
export function addMonths(ms, n) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

// ---- plan catalogue (plans table), cached a minute ----
let catCache = { at: 0, v: null };
export function clearCatalogCache() { catCache = { at: 0, v: null }; }
export async function getCatalog(env) {
  if (catCache.v && Date.now() - catCache.at < 60000) return catCache.v;
  const byId = {}, byTier = {};
  try {
    const { results } = await env.DB.prepare("SELECT plan_id, label, rank, legacy_tier_id, is_active FROM plans").all();
    for (const r of results) { byId[r.plan_id] = r; if (r.legacy_tier_id) byTier[r.legacy_tier_id] = r; }
  } catch (e) { /* plans table missing: everyone is free */ }
  catCache = { at: Date.now(), v: { byId, byTier } };
  return catCache.v;
}
const rankOfTier = (cat, tier) => (tier && cat.byTier[tier] ? Number(cat.byTier[tier].rank) : -1);
export const tierOfPlan = (cat, planId) => (cat.byId[planId] && cat.byId[planId].legacy_tier_id) || null;

async function getRow(env, profileId) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM profile_plan WHERE profile_id = ?").bind(profileId).all();
    return results[0] || null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// Which plan is in force?
// ---------------------------------------------------------------------
export async function recomputeEffectivePlan(env, profileId, { now = Date.now() } = {}) {
  const { results: pr } = await env.DB.prepare("SELECT id, tier_id, max_products FROM profiles WHERE id = ?").bind(profileId).all();
  if (!pr.length) return null;
  const profile = pr[0], cat = await getCatalog(env), S = await getSettings(env);

  let row = await getRow(env, profileId);
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO profile_plan (profile_id, base_tier_id, eff_tier_id, eff_max_products) VALUES (?, ?, ?, ?)")
      .bind(profileId, profile.tier_id || null, profile.tier_id || null, profile.max_products == null ? null : profile.max_products).run();
    row = await getRow(env, profileId);
  }
  let base = row.base_tier_id || null;
  // The plan was changed outside this engine (an old one-time purchase, or you in SQL): that becomes their own plan.
  if ((profile.tier_id || null) !== (row.eff_tier_id || null) || (profile.max_products ?? null) !== (row.eff_max_products ?? null)) base = profile.tier_id || null;

  const legacyEnd = S.legacy_ends_at ? Date.parse(S.legacy_ends_at) : NaN;
  const cands = [];
  if (base && !(Number.isFinite(legacyEnd) && now > legacyEnd)) cands.push(base);
  const grantOn = row.grant_tier_id && (!row.grant_ends_at || parseSql(row.grant_ends_at) > now);
  const subOn = row.sub_tier_id && parseSql(row.sub_ends_at) > now;
  const trialOn = row.trial_tier_id && parseSql(row.trial_ends_at) > now;
  if (grantOn) cands.push(row.grant_tier_id);
  if (subOn) cands.push(row.sub_tier_id);
  if (trialOn) cands.push(row.trial_tier_id);

  let best = null, bestRank = -1;
  for (const t of cands) { const r = rankOfTier(cat, t); if (r > bestRank) { best = t; bestRank = r; } }

  const clearTrial = row.trial_tier_id && !trialOn, clearSub = row.sub_tier_id && !subOn, clearGrant = row.grant_tier_id && !grantOn;
  const changed = (profile.tier_id || null) !== best;
  await env.DB.batch([
    ...(changed ? [env.DB.prepare("UPDATE profiles SET tier_id = ? WHERE id = ?").bind(best, profileId)] : []),
    env.DB.prepare(
      `UPDATE profile_plan SET base_tier_id = ?, eff_tier_id = ?, eff_max_products = ?,
         trial_tier_id = ${clearTrial ? "NULL" : "trial_tier_id"}, sub_tier_id = ${clearSub ? "NULL" : "sub_tier_id"},
         grant_tier_id = ${clearGrant ? "NULL" : "grant_tier_id"}, grant_ends_at = ${clearGrant ? "NULL" : "grant_ends_at"},
         updated_at = datetime('now') WHERE profile_id = ?`
    ).bind(base, best, profile.max_products == null ? null : profile.max_products, profileId)
  ]);
  return { tierId: best, planId: best && cat.byTier[best] ? cat.byTier[best].plan_id : "free", changed };
}

// ---------------------------------------------------------------------
// Hide / show items to match the plan. NEVER deletes. "First N stay visible" = the N earliest-added items.
// ---------------------------------------------------------------------
const IN = (n) => Array(n).fill("?").join(",");
async function runChunks(env, stmts) { for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40)); }

export async function enforceVisibility(env, profileId) {
  const { results: pr } = await env.DB.prepare("SELECT id, tier_id, max_products FROM profiles WHERE id = ?").bind(profileId).all();
  if (!pr.length) return { hidden: 0, restored: 0 };
  const { limits } = await getProfileLimits(env, pr[0]);
  const quota = Number(limits.max_products);
  const { results: vis } = await env.DB.prepare(
    "SELECT id FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 ORDER BY created_at ASC, id ASC LIMIT 20000").bind(profileId).all();
  const { results: hid } = await env.DB.prepare(
    "SELECT id FROM products WHERE profile_id = ? AND plan_hidden = 1 AND is_draft = 0 ORDER BY created_at ASC, id ASC LIMIT 20000").bind(profileId).all();

  let toHide = [], toShow = [];
  if (quota >= 0 && vis.length > quota) toHide = vis.slice(quota).map((r) => r.id);
  else if (hid.length && (quota < 0 || vis.length < quota)) toShow = hid.slice(0, quota < 0 ? hid.length : quota - vis.length).map((r) => r.id);
  if (!toHide.length && !toShow.length) return { hidden: 0, restored: 0 };

  const stmts = [];
  for (let i = 0; i < toHide.length; i += 80) { const c = toHide.slice(i, i + 80); stmts.push(env.DB.prepare(`UPDATE products SET is_active = 0, plan_hidden = 1 WHERE profile_id = ? AND id IN (${IN(c.length)})`).bind(profileId, ...c)); }
  for (let i = 0; i < toShow.length; i += 80) { const c = toShow.slice(i, i + 80); stmts.push(env.DB.prepare(`UPDATE products SET is_active = 1, plan_hidden = 0 WHERE profile_id = ? AND id IN (${IN(c.length)}) AND plan_hidden = 1`).bind(profileId, ...c)); }
  await runChunks(env, stmts);
  // collections keep their counts and cover in step with what is visible
  await env.DB.prepare(
    `UPDATE collections SET
       item_count = (SELECT COUNT(*) FROM collection_items ci JOIN products p ON p.id = ci.product_id WHERE ci.collection_id = collections.id AND p.is_active = 1 AND p.is_draft = 0),
       cover_url = (SELECT p.image_url FROM collection_items ci JOIN products p ON p.id = ci.product_id WHERE ci.collection_id = collections.id AND p.is_active = 1 AND p.is_draft = 0 ORDER BY ci.position ASC LIMIT 1),
       cover_color = (SELECT p.img_color FROM collection_items ci JOIN products p ON p.id = ci.product_id WHERE ci.collection_id = collections.id AND p.is_active = 1 AND p.is_draft = 0 ORDER BY ci.position ASC LIMIT 1),
       updated_at = datetime('now')
     WHERE profile_id = ?`).bind(profileId).run();
  return { hidden: toHide.length, restored: toShow.length };
}

export async function applyPlanChange(env, profileId, opts = {}) {
  const eff = await recomputeEffectivePlan(env, profileId, opts);
  if (!eff) return null;
  const vis = await enforceVisibility(env, profileId);
  return { ...eff, ...vis };
}

/** Cheap check used when the owner opens the Studio: if a trial / plan / gift has ended since the last look, apply it now. */
export async function syncIfDue(env, profileId, { now = Date.now() } = {}) {
  const row = await getRow(env, profileId);
  if (!row) return false;
  const gone = (tier, end) => tier && Number.isFinite(parseSql(end)) && parseSql(end) <= now;
  const due = gone(row.trial_tier_id, row.trial_ends_at) || gone(row.sub_tier_id, row.sub_ends_at) || (row.grant_tier_id && row.grant_ends_at && parseSql(row.grant_ends_at) <= now);
  if (!due) return false;
  await applyPlanChange(env, profileId, { now });
  return true;
}

// ---------------------------------------------------------------------
// The free trial
// ---------------------------------------------------------------------
export async function startTrial(env, profile, { now = Date.now() } = {}) {
  const S = await getSettings(env), cat = await getCatalog(env);
  if (!S.trial_enabled) return { ok: false, error: "The free trial isn't available right now." };
  if (profile.moderation_status && profile.moderation_status !== "approved") return { ok: false, error: "Your brand needs to be live before you can start a trial." };
  const trialTier = tierOfPlan(cat, S.trial_plan_id);
  if (!trialTier) return { ok: false, error: "The free trial isn't available right now." };

  const st = await getPlanStatus(env, profile, { now });
  if (st.trial.used) return { ok: false, error: "You've already used your free trial on this brand." };
  if (st.trial.active) return { ok: false, error: "Your trial is already running." };
  if (rankOfTier(cat, profile.tier_id) >= rankOfTier(cat, trialTier)) return { ok: false, error: "You're already on a plan as good as the trial." };
  if (st.trial.usedByPerson >= S.trial_per_user) return { ok: false, error: "You've already used your free trial. Pick a plan to keep going." };

  const ends = now + S.trial_days * DAY;
  await env.DB.prepare("INSERT OR IGNORE INTO profile_plan (profile_id, base_tier_id, eff_tier_id, eff_max_products) VALUES (?, ?, ?, ?)")
    .bind(profile.id, profile.tier_id || null, profile.tier_id || null, profile.max_products == null ? null : profile.max_products).run();
  const res = await env.DB.prepare(
    `UPDATE profile_plan SET trial_tier_id = ?, trial_started_at = ?, trial_ends_at = ?, trial_views_start = ?, trial_count = trial_count + 1, updated_at = datetime('now')
     WHERE profile_id = ? AND trial_count = 0`
  ).bind(trialTier, sqlTime(now), sqlTime(ends), profile.profile_views || 0, profile.id).run();
  if (!res.meta || res.meta.changes !== 1) return { ok: false, error: "You've already used your free trial on this brand." };
  await applyPlanChange(env, profile.id, { now });
  return { ok: true, days: S.trial_days, endsAt: sqlTime(ends) };
}

// ---------------------------------------------------------------------
// Everything the Studio needs to show the plan, the trial and the reminders
// ---------------------------------------------------------------------
export async function getPlanStatus(env, profile, { now = Date.now() } = {}) {
  const cat = await getCatalog(env), S = await getSettings(env);
  const row = await getRow(env, profile.id);
  const plan = (profile.tier_id && cat.byTier[profile.tier_id]) || null;
  const freeLabel = (cat.byId.free && cat.byId.free.label) || "Free";

  const trialEnds = row ? parseSql(row.trial_ends_at) : NaN;
  const trialActive = !!(row && row.trial_tier_id && trialEnds > now);
  const trialStartMs = row ? parseSql(row.trial_started_at) : NaN;
  const trialPlan = cat.byId[S.trial_plan_id] || null;
  let usedByPerson = row ? (row.trial_count || 0) : 0;
  if (profile.owner_id) {
    try {
      const { results } = await env.DB.prepare("SELECT COALESCE(SUM(pp.trial_count), 0) AS n FROM profile_plan pp JOIN profiles p ON p.id = pp.profile_id WHERE p.owner_id = ?").bind(profile.owner_id).all();
      usedByPerson = Number(results[0].n) || 0;
    } catch (e) { /* table not created yet */ }
  }
  const used = !!(row && row.trial_count > 0);
  const eligible = !!(S.trial_enabled && trialPlan && !used && !trialActive && usedByPerson < S.trial_per_user && rankOfTier(cat, profile.tier_id) < Number(trialPlan.rank));
  const daysLeft = trialActive ? Math.max(1, Math.ceil((trialEnds - now) / DAY)) : 0;

  let hidden = 0;
  if (row) { try { const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE profile_id = ? AND plan_hidden = 1").bind(profile.id).all(); hidden = Number(results[0].n) || 0; } catch (e) { /* column not added yet */ } }

  let sub = null;
  if (row && (row.sub_tier_id || row.sub_ends_at)) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, plan_id, billing, status, auto_renew, current_period_end, card_last4, card_brand, fail_count
         FROM subscriptions WHERE profile_id = ? AND status IN ('active','past_due') ORDER BY created_at DESC LIMIT 1`).bind(profile.id).all();
      if (results[0]) sub = { ...results[0], auto_renew: !!results[0].auto_renew };
    } catch (e) { /* subscriptions not created yet */ }
  }

  const thresholds = S.reminder_days.map(Number).filter((n) => n > 0).sort((a, b) => b - a);
  let reminder = null;
  if (trialActive) {
    if (thresholds.length && daysLeft <= thresholds[thresholds.length - 1]) reminder = "trial_last";
    else if (thresholds.length && daysLeft <= thresholds[0]) reminder = "trial_soon";
  } else if (used && hidden > 0 && !sub) reminder = "trial_ended";
  if (!reminder && sub && sub.status === "past_due") reminder = "payment_failed";
  if (!reminder && hidden > 0 && !sub) reminder = "items_hidden";

  return {
    planId: plan ? plan.plan_id : "free", planLabel: plan ? plan.label : freeLabel, tierId: profile.tier_id || null,
    trial: {
      enabled: !!S.trial_enabled, eligible, active: trialActive, used, usedByPerson, days: S.trial_days,
      planId: trialPlan ? trialPlan.plan_id : null, planLabel: trialPlan ? trialPlan.label : null,
      daysLeft, endsAt: trialActive ? row.trial_ends_at : null,
      viewsGained: trialActive && Number.isFinite(trialStartMs) ? Math.max(0, (profile.profile_views || 0) - (row.trial_views_start || 0)) : 0
    },
    subscription: sub, hidden, reminder, graceDays: S.sub_grace_days
  };
}

// ---------------------------------------------------------------------
// Nightly sweep. Bounded, and every step is its own try/catch.
// ---------------------------------------------------------------------
export async function runPlanMaintenance(env, { now = Date.now(), limit = 60 } = {}) {
  const out = { processed: 0, failed: 0, cleaned: 0 };
  const stamp = sqlTime(now);
  try {
    const { results } = await env.DB.prepare(
      `SELECT profile_id FROM profile_plan
       WHERE (trial_tier_id IS NOT NULL AND trial_ends_at <= ?) OR (sub_tier_id IS NOT NULL AND sub_ends_at <= ?)
          OR (grant_tier_id IS NOT NULL AND grant_ends_at IS NOT NULL AND grant_ends_at <= ?) LIMIT ?`).bind(stamp, stamp, stamp, limit).all();
    for (const r of results) {
      try { await applyPlanChange(env, r.profile_id, { now }); out.processed++; }
      catch (e) { out.failed++; console.error("Plan maintenance failed for one brand:", e); }
    }
  } catch (e) { console.error("Plan maintenance sweep failed:", e); }
  try {
    const old = sqlTime(now - 2 * DAY);   // checkouts that were started but never paid
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscription_payments WHERE status = 'pending' AND created_at < ?").bind(old),
      env.DB.prepare("DELETE FROM subscriptions WHERE status = 'pending' AND created_at < ? AND id NOT IN (SELECT subscription_id FROM subscription_payments)").bind(old)
    ]);
    out.cleaned = 1;
  } catch (e) { /* tables may not exist yet */ }
  return out;
}

