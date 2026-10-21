// =====================================================================
// LIYOG WORLD — src/lib/ad-analytics.js   (boost analytics)
//
// What an advertiser sees about their boost:
//   delivered / seen / taps / contacts / profile visits / time left.
//
// Three small parts, all additive and all switch-protected:
//
//  1. TOKENS      Every sponsored item the server hands to a page carries
//                 a short-lived, signed token. The browser sends it back
//                 with each event, so nobody can invent events for boosts
//                 that were never served. (No new secret needed: the key
//                 is derived from ADMIN_SECRET.)
//  2. COLLECTOR   POST /api/ads/track receives small batches of events
//                 from the browser and adds them to hourly counters in
//                 ONE database batch. It ALWAYS answers 204 and never
//                 throws, so analytics can never slow down or break a page.
//  3. INSIGHTS    GET /api/profiles/:id/boost-insights (owner only) reads
//                 the owner's boosts, their history and counters.
//
// Switch:  app_settings  boost_analytics_enabled = '1'  (default OFF).
// While OFF: no tokens are issued, the collector does nothing, and the
// browser sends nothing. Insights still work (without Seen/Taps).
//
// Privacy: no cookies, no IP addresses, no personal data. Only the boost,
// the hour, the page type and the visitor's COUNTRY are counted.
// =====================================================================

import { COUNTRY_NAMES, parseTargetList } from "./boost.js";

const FLAG_KEY = "boost_analytics_enabled";
const SINCE_KEY = "boost_analytics_since";
const TOKEN_TTL_SECONDS = 12 * 3600;
const MAX_EVENTS_PER_BEACON = 24;
const MAX_BODY_CHARS = 6000;
const PLACEMENTS = new Set(["brand", "catalogue", "product", "blog", "home", "more", "other"]);
const TYPE_TO_FIELD = { i: "impressions", c: "clicks", w: "whatsapp", p: "calls" };
const PER_BEACON_CAPS = { impressions: 12, clicks: 5, whatsapp: 5, calls: 5 };

const encoder = new TextEncoder();

// ---------------------------------------------------------------------
// Feature switch (cached ~30s per isolate, so it costs ~0 queries)
// ---------------------------------------------------------------------
let flagCache = { value: false, at: 0 };

export async function isAnalyticsEnabled(env) {
  const now = Date.now();
  if (now - flagCache.at < 30000) return flagCache.value;
  let value = false;
  try {
    const { results } = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(FLAG_KEY).all();
    const raw = results.length ? String(results[0].value) : "0";
    value = raw === "1" || raw === "true" || raw === "on";
  } catch (e) { value = false; }
  flagCache = { value, at: now };
  return value;
}

/** Forget the cached values (used by tests and safe to call anytime). */
export function resetAnalyticsCache() {
  flagCache = { value: false, at: 0 };
  sinceCache = { value: null };
}

// ---------------------------------------------------------------------
// "Tracking began" — the moment counting started. A boost that started
// BEFORE this has only part of its life counted, so its cost per tap
// would look too high; the Insights sheet hides it for those boosts.
// Stored once in app_settings (boost_analytics_since, UTC). If the switch
// was turned on without it, it is worked out once from the data (the
// first hour that has any counts) and remembered.
// ---------------------------------------------------------------------
let sinceCache = { value: null };    // 'YYYY-MM-DD HH:MM:SS' once known; it never changes

export async function getAnalyticsSince(env, { derive = true } = {}) {
  if (sinceCache.value) return sinceCache.value;
  try {
    const { results } = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SINCE_KEY).all();
    if (results.length && results[0].value) { sinceCache.value = String(results[0].value); return sinceCache.value; }
    if (!derive) return null;

    let first = null;
    try {
      const r = await env.DB.prepare("SELECT MIN(bucket) AS first FROM boost_stats_hourly").all();
      first = r.results[0] && r.results[0].first;
    } catch (e) { first = null; }
    const since = first ? `${first}:00` : new Date().toISOString().slice(0, 19).replace("T", " ");
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)"
    ).bind(SINCE_KEY, since, SINCE_KEY).run();
    sinceCache.value = since;
    return since;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// Signed tokens:  <statKey>.<expiry base36>.<24-hex signature>
// ---------------------------------------------------------------------
let keyCache = { secret: null, promise: null };

function hmacKey(env) {
  if (!keyCache.promise || keyCache.secret !== env.ADMIN_SECRET) {
    keyCache = {
      secret: env.ADMIN_SECRET,
      promise: crypto.subtle.importKey(
        "raw", encoder.encode("liyog-ad-track-v1|" + env.ADMIN_SECRET),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      )
    };
  }
  return keyCache.promise;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(env, payload) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(payload));
  return toHex(sig).slice(0, 24);
}

export async function signTrackToken(env, statKey, ttlSeconds = TOKEN_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${statKey}.${exp.toString(36)}`;
  return `${payload}.${await sign(env, payload)}`;
}

/** Returns the statKey for a valid, unexpired token, otherwise null. */
export async function verifyTrackToken(env, token) {
  try {
    if (!env.ADMIN_SECRET || typeof token !== "string" || token.length > 120) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [statKey, expB36, sig] = parts;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(statKey) || !/^[a-z0-9]{1,10}$/.test(expB36) || !/^[a-f0-9]{24}$/.test(sig)) return null;
    if (parseInt(expB36, 36) < Math.floor(Date.now() / 1000)) return null;
    const expected = await sign(env, `${statKey}.${expB36}`);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0 ? statKey : null;
  } catch (e) { return null; }
}

/**
 * For the sponsored items discovery.js is about to return: { [itemKey]: token }.
 * itemKey is product_id (product strip) or profile_id (brand / shop strips).
 * Never throws; returns {} when the switch is off or anything is missing
 * (for example the purchase_id column has not been added yet).
 */
export async function buildTrackingTokens(env, boosted, keyField) {
  try {
    if (!boosted || !boosted.length) return {};
    if (!env.ADMIN_SECRET || !(await isAnalyticsEnabled(env))) return {};
    const ids = boosted.map((b) => b.id);
    const { results } = await env.DB.prepare(
      `SELECT id, purchase_id FROM boost_log WHERE id IN (${ids.map(() => "?").join(",")})`
    ).bind(...ids).all();
    const purchaseById = {};
    results.forEach((r) => { purchaseById[r.id] = r.purchase_id; });

    const map = {};
    for (const b of boosted) {
      const itemKey = b[keyField];
      if (!itemKey) continue;
      map[itemKey] = await signTrackToken(env, purchaseById[b.id] || `L${b.id}`);
    }
    return map;
  } catch (err) {
    console.error("Tracking tokens skipped (ignored):", err);
    return {};
  }
}

// ---------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------
const UPSERT_SQL = `
  INSERT INTO boost_stats_hourly (stat_key, bucket, placement, country, impressions, clicks, whatsapp, calls)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (stat_key, bucket, placement, country) DO UPDATE SET
    impressions = impressions + excluded.impressions,
    clicks = clicks + excluded.clicks,
    whatsapp = whatsapp + excluded.whatsapp,
    calls = calls + excluded.calls`;

function currentHourBucket() {
  return new Date().toISOString().slice(0, 13).replace("T", " ") + ":00";
}

/** POST /api/ads/track — always 204. */
export async function handleAdTrack(request, env) {
  const quiet = () => new Response(null, { status: 204 });
  try {
    if (!(await isAnalyticsEnabled(env))) return quiet();

    const text = await request.text();
    if (!text || text.length > MAX_BODY_CHARS) return quiet();
    const body = JSON.parse(text);
    const events = Array.isArray(body && body.e) ? body.e.slice(0, MAX_EVENTS_PER_BEACON) : [];
    if (!events.length) return quiet();

    const geo = request.cf && request.cf.country ? String(request.cf.country).toUpperCase() : "";
    const country = COUNTRY_NAMES[geo] ? geo : "XX";
    const bucket = currentHourBucket();

    const agg = new Map();   // "statKey|placement" -> counters
    for (const ev of events) {
      if (!Array.isArray(ev)) continue;
      const field = TYPE_TO_FIELD[ev[1]];
      if (!field) continue;
      const statKey = await verifyTrackToken(env, ev[0]);
      if (!statKey) continue;
      const placement = PLACEMENTS.has(ev[2]) ? ev[2] : "other";
      const mapKey = `${statKey}|${placement}`;
      const row = agg.get(mapKey) || { statKey, placement, impressions: 0, clicks: 0, whatsapp: 0, calls: 0 };
      if (row[field] < PER_BEACON_CAPS[field]) row[field] += 1;
      agg.set(mapKey, row);
    }
    if (!agg.size) return quiet();

    await env.DB.batch([...agg.values()].map((r) =>
      env.DB.prepare(UPSERT_SQL).bind(r.statKey, bucket, r.placement, country, r.impressions, r.clicks, r.whatsapp, r.calls)
    ));
  } catch (err) {
    console.error("Ad tracking failed (ignored):", err);
  }
  return quiet();
}

// ---------------------------------------------------------------------
// Owner insights
// ---------------------------------------------------------------------
const toMs = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
const toIso = (ms) => new Date(ms).toISOString();
const toSqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const VISITS_WINDOW_DAYS = 30;     // profile_views is only kept for 30 days
const MAX_BOOSTS = 20;
const MAX_VISIT_BOOSTS = 6;

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "private, max-age=120" : "no-store"
    }
  });
}

async function loadLiveBoosts(env, profileId) {
  const base = `SELECT bl.id, bl.scope, bl.product_id, bl.boosted_at, bl.expires_at, bl.impression_count,
                       bl.target_countries, bl.target_categories, bl.show_cta, %PURCHASE% pr.name AS product_name
                FROM boost_log bl LEFT JOIN products pr ON pr.id = bl.product_id
                WHERE bl.profile_id = ? AND bl.expires_at > datetime('now', '-7 days')
                ORDER BY bl.expires_at ASC`;
  try {
    const { results } = await env.DB.prepare(base.replace("%PURCHASE%", "bl.purchase_id,")).bind(profileId).all();
    return results;
  } catch (e) {
    const { results } = await env.DB.prepare(base.replace("%PURCHASE%", "")).bind(profileId).all();
    return results.map((r) => ({ ...r, purchase_id: null }));
  }
}

async function loadVisits(env, profileId, boosts, nowMs) {
  const candidates = boosts
    .filter((b) => b.scope === "profile" && nowMs - b.startMs < VISITS_WINDOW_DAYS * 86400e3)
    .slice(0, MAX_VISIT_BOOSTS);
  if (!candidates.length) return {};
  try {
    const exprs = [];
    const binds = [];
    let earliest = Infinity;
    candidates.forEach((b) => {
      const duringEnd = Math.min(b.endMs, nowMs);
      const length = Math.max(1, duringEnd - b.startMs);
      const beforeStart = b.startMs - length;
      earliest = Math.min(earliest, beforeStart);
      exprs.push("SUM(CASE WHEN viewed_at >= ? AND viewed_at < ? THEN 1 ELSE 0 END)");
      binds.push(toSqlTime(b.startMs), toSqlTime(duringEnd));
      exprs.push("SUM(CASE WHEN viewed_at >= ? AND viewed_at < ? THEN 1 ELSE 0 END)");
      binds.push(toSqlTime(beforeStart), toSqlTime(b.startMs));
    });
    const row = (await env.DB.prepare(
      `SELECT ${exprs.map((e, i) => `${e} AS c${i}`).join(", ")} FROM profile_views WHERE profile_id = ? AND viewed_at >= ?`
    ).bind(...binds, profileId, toSqlTime(earliest)).all()).results[0] || {};
    const out = {};
    candidates.forEach((b, i) => {
      out[b.key] = { during: Number(row[`c${i * 2}`]) || 0, before: Number(row[`c${i * 2 + 1}`]) || 0 };
    });
    return out;
  } catch (e) { return {}; }
}

async function loadStats(env, keys) {
  if (!keys.length) return {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT stat_key, SUM(impressions) AS i, SUM(clicks) AS c, SUM(whatsapp) AS w, SUM(calls) AS p
       FROM boost_stats_hourly WHERE stat_key IN (${keys.map(() => "?").join(",")}) GROUP BY stat_key`
    ).bind(...keys).all();
    const out = {};
    results.forEach((r) => { out[r.stat_key] = { impressions: Number(r.i) || 0, clicks: Number(r.c) || 0, whatsapp: Number(r.w) || 0, calls: Number(r.p) || 0 }; });
    return out;
  } catch (e) { return {}; }
}

/** GET /api/profiles/:id/boost-insights — owner only. */
export async function handleBoostInsights(env, profileId, userId) {
  try {
    const { results: owner } = await env.DB.prepare("SELECT owner_id FROM profiles WHERE id = ?").bind(profileId).all();
    if (!owner.length) return respond({ error: "Profile not found." }, 404);
    if (owner[0].owner_id !== userId) return respond({ error: "Not your profile." }, 403);

    const nowMs = Date.now();
    const { results: purchases } = await env.DB.prepare(
      `SELECT bpu.id, bpu.scope, bpu.product_id, bpu.custom_hours, bpu.currency, bpu.amount,
              bpu.target_countries, bpu.target_categories, bpu.show_cta, bpu.confirmed_at,
              bp.hours AS pricing_hours, pr.name AS product_name
       FROM boost_purchases bpu
       LEFT JOIN boost_pricing bp ON bp.duration_id = bpu.duration_id AND bp.country_code = bpu.country_code
       LEFT JOIN products pr ON pr.id = bpu.product_id
       WHERE bpu.profile_id = ? AND bpu.status = 'confirmed'
       ORDER BY bpu.confirmed_at DESC LIMIT ?`
    ).bind(profileId, MAX_BOOSTS).all();
    const logs = (await loadLiveBoosts(env, profileId)).map((l) => ({ ...l, _used: false }));

    const boosts = [];
    for (const pu of purchases) {
      let log = logs.find((l) => !l._used && l.purchase_id && l.purchase_id === pu.id);
      if (!log) {
        // Boosts bought before purchase_id existed: match on what they are
        // and the second they were confirmed (both are written together).
        log = logs.find((l) => !l._used && !l.purchase_id && l.scope === pu.scope &&
          (l.product_id || null) === (pu.product_id || null) &&
          Math.abs(toMs(l.boosted_at) - toMs(pu.confirmed_at)) <= 90000);
      }
      if (log) log._used = true;
      const hours = pu.custom_hours || pu.pricing_hours || 24;
      const startMs = log ? toMs(log.boosted_at) : toMs(pu.confirmed_at);
      const endMs = log ? toMs(log.expires_at) : startMs + hours * 3600e3;
      boosts.push({
        key: pu.id, statKeys: [pu.id, log ? `L${log.id}` : null].filter(Boolean),
        source: "purchase", scope: pu.scope, productId: pu.product_id || null, productName: pu.product_name || null,
        startMs, endMs, hours, amount: pu.amount, currency: pu.currency,
        countriesRaw: pu.target_countries, categoriesRaw: pu.target_categories, showCta: Number(pu.show_cta) === 1,
        served: log ? Number(log.impression_count) || 0 : null
      });
    }
    for (const log of logs.filter((l) => !l._used)) {
      boosts.push({
        key: `L${log.id}`, statKeys: [`L${log.id}`],
        source: "granted", scope: log.scope, productId: log.product_id || null, productName: log.product_name || null,
        startMs: toMs(log.boosted_at), endMs: toMs(log.expires_at),
        hours: Math.round((toMs(log.expires_at) - toMs(log.boosted_at)) / 3600e3), amount: null, currency: null,
        countriesRaw: log.target_countries, categoriesRaw: log.target_categories, showCta: Number(log.show_cta) === 1,
        served: Number(log.impression_count) || 0
      });
    }

    boosts.sort((a, b) => {
      const aActive = a.endMs > nowMs, bActive = b.endMs > nowMs;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return aActive ? a.endMs - b.endMs : b.endMs - a.endMs;
    });
    const shown = boosts.slice(0, MAX_BOOSTS);

    const enabled = await isAnalyticsEnabled(env);
    const sinceStr = await getAnalyticsSince(env, { derive: enabled });
    const sinceMs = sinceStr ? toMs(sinceStr) : null;

    const visits = await loadVisits(env, profileId, shown, nowMs);
    const statKeys = [...new Set(shown.flatMap((b) => b.statKeys))].slice(0, 40);
    const stats = await loadStats(env, statKeys);

    const countryList = (raw) => {
      const list = parseTargetList(raw);
      return list === "ALL" ? "ALL" : list.map((code) => ({ code, name: COUNTRY_NAMES[code] || code }));
    };

    return respond({
      serverNow: toIso(nowMs),
      analytics: { enabled, since: sinceMs ? toIso(sinceMs) : null },
      boosts: shown.map((b) => {
        const parts = b.statKeys.map((k) => stats[k]).filter(Boolean);
        // Counting only began at `since`. A boost that started earlier has only part
        // of its life counted ("partial"); one that ended before it has none.
        const known = sinceMs != null;
        const beforeTracking = known && b.endMs <= sinceMs;
        const statsPartial = !beforeTracking && (enabled || parts.length > 0) && (!known || b.startMs < sinceMs);
        return {
          key: b.key, source: b.source, scope: b.scope, productId: b.productId, productName: b.productName,
          status: b.endMs > nowMs ? "active" : "ended",
          startedAt: toIso(b.startMs), endsAt: toIso(b.endMs), hours: b.hours,
          amount: b.amount, currency: b.currency,
          countries: countryList(b.countriesRaw), categories: parseTargetList(b.categoriesRaw), showCta: b.showCta,
          served: b.served,
          visits: visits[b.key] || null,
          statsPartial, beforeTracking,
          stats: parts.length ? parts.reduce((t, s) => ({
            impressions: t.impressions + s.impressions, clicks: t.clicks + s.clicks,
            whatsapp: t.whatsapp + s.whatsapp, calls: t.calls + s.calls
          }), { impressions: 0, clicks: 0, whatsapp: 0, calls: 0 }) : null
        };
      })
    });
  } catch (err) {
    console.error("Boost insights failed:", err);
    return respond({ error: "Couldn't load insights right now." }, 500);
  }
}
