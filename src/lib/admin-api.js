// =====================================================================
// BIZIPLEX — src/lib/admin-api.js
// The small, safe back-office for plans: everything below needs your admin secret (header x-admin-secret).
//   GET  /api/admin/plans-config   settings, plans, limits, prices and a few live numbers, in ONE request
//   PUT  /api/admin/setting        change one setting            { key, value }
//   PUT  /api/admin/limit          change one plan limit         { plan_id, limit_key, value }   (-1 = unlimited)
//   PUT  /api/admin/price          add / change a price          { plan_id, billing, country_code, currency, amount, ngn_amount?, is_active? }
//   DELETE /api/admin/price        remove a price                { plan_id, billing, country_code }
//   POST /api/admin/grant          give a plan                   { slug, plan_id, days? }  (no days = for good; empty plan_id = take it away)
//   POST /api/admin/recheck        re-apply a brand's plan now   { slug }
// The page that uses these is /admin (assets/admin-ui.txt).
// =====================================================================
import { isAdminRequest } from "./security.js";
import { SETTING_DEFS, getSettings, clearSettingsCache, getCatalog, tierOfPlan, applyPlanChange, sqlTime, DAY } from "./plan-engine.js";
import { BILLING } from "./subscriptions.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (m, s = 400) => json({ error: m }, s);
async function body(request) { try { const t = await request.text(); return t.length > 20000 ? {} : JSON.parse(t || "{}"); } catch (e) { return {}; } }
const num = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const PATHS = ["/api/admin/plans-config", "/api/admin/setting", "/api/admin/limit", "/api/admin/price", "/api/admin/grant", "/api/admin/recheck"];

function validSetting(key, raw) {
  const d = SETTING_DEFS[key]; if (!d) return null;
  const v = String(raw == null ? "" : raw).trim();
  if (d.type === "bool") return v === "1" || v === "0" ? v : null;
  if (d.type === "int") { const n = num(v, d.min, d.max); return n == null ? null : String(n); }
  if (d.type === "list") { const items = v.split(",").map((x) => x.trim()).filter(Boolean); return items.every((x) => /^[a-z0-9_]{1,24}$/.test(x)) ? items.join(",") : null; }
  if (d.type === "date") return v === "" ? "" : (Number.isFinite(Date.parse(v)) ? v : null);
  if (d.type === "plan") return /^[a-z0-9_]{2,24}$/.test(v) ? v : null;
  return null;
}

export async function routeAdminApi(request, env, ctx, url) {
  if (!PATHS.includes(url.pathname)) return null;
  if (!isAdminRequest(request, env)) return fail("Not authorized.", 401);
  const m = request.method, p = url.pathname;
  try {
    if (m === "GET" && p === "/api/admin/plans-config") {
      const S = await getSettings(env, { fresh: true });
      const raw = {}, keys = Object.keys(SETTING_DEFS);
      const { results: sr } = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
      for (const r of sr) raw[r.key] = r.value;
      const settings = keys.map((k) => ({ key: k, ...SETTING_DEFS[k], value: raw[k] != null && raw[k] !== "" ? raw[k] : SETTING_DEFS[k].def, parsed: S[k] }));
      const { results: plans } = await env.DB.prepare("SELECT plan_id, label, rank, legacy_tier_id, is_active FROM plans ORDER BY rank ASC").all();
      const { results: limits } = await env.DB.prepare("SELECT plan_id, limit_key, value FROM plan_limits ORDER BY plan_id, limit_key").all();
      let prices = [], stats = {};
      try { prices = (await env.DB.prepare("SELECT plan_id, billing, country_code, currency, amount, ngn_amount, is_active FROM plan_prices ORDER BY plan_id, billing, country_code").all()).results; } catch (e) { /* migration not run */ }
      try {
        const q = async (sql) => Number((await env.DB.prepare(sql).all()).results[0].n) || 0;
        stats = {
          activeSubscriptions: await q("SELECT COUNT(*) n FROM subscriptions WHERE status IN ('active','past_due')"),
          pastDue: await q("SELECT COUNT(*) n FROM subscriptions WHERE status = 'past_due'"),
          activeTrials: await q(`SELECT COUNT(*) n FROM profile_plan WHERE trial_tier_id IS NOT NULL AND trial_ends_at > '${sqlTime(Date.now())}'`),
          trialsEver: await q("SELECT COUNT(*) n FROM profile_plan WHERE trial_count > 0"),
          hiddenItems: await q("SELECT COUNT(*) n FROM products WHERE plan_hidden = 1")
        };
      } catch (e) { stats = null; }
      return json({ ok: true, settings, plans, limits, prices, billing: Object.keys(BILLING), stats });
    }

    if (m === "PUT" && p === "/api/admin/setting") {
      const b = await body(request), v = validSetting(b.key, b.value);
      if (v == null) return fail("That value isn't allowed for this setting.");
      await env.DB.batch([
        env.DB.prepare("UPDATE app_settings SET value = ? WHERE key = ?").bind(v, b.key),
        env.DB.prepare("INSERT INTO app_settings (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)").bind(b.key, v, b.key)
      ]);
      clearSettingsCache();
      return json({ success: true, key: b.key, value: v });
    }

    if (m === "PUT" && p === "/api/admin/limit") {
      const b = await body(request), val = num(b.value, -1, 1000000000);
      if (!/^[a-z0-9_]{2,40}$/.test(b.limit_key || "") || !/^[a-z0-9_]{2,24}$/.test(b.plan_id || "") || val == null) return fail("Check the plan, the limit name and the number (-1 means unlimited).");
      const cat = await getCatalog(env); if (!cat.byId[b.plan_id]) return fail("That plan doesn't exist.", 404);
      await env.DB.prepare("INSERT INTO plan_limits (plan_id, limit_key, value) VALUES (?, ?, ?) ON CONFLICT(plan_id, limit_key) DO UPDATE SET value = excluded.value").bind(b.plan_id, b.limit_key, val).run();
      return json({ success: true, note: "Takes effect within about a minute." });
    }

    if (m === "PUT" && p === "/api/admin/price") {
      const b = await body(request), amount = num(b.amount, 1, 100000000000), ngn = b.ngn_amount == null || b.ngn_amount === "" ? null : num(b.ngn_amount, 1, 100000000000);
      const cc = String(b.country_code || "").toUpperCase(), cur = String(b.currency || "").toUpperCase();
      if (!BILLING[b.billing] || !/^[A-Z]{2,3}$/.test(cc) || !/^[A-Z]{3}$/.test(cur) || amount == null || (b.ngn_amount != null && b.ngn_amount !== "" && ngn == null)) return fail("Check the billing choice, country, currency and amount.");
      const cat = await getCatalog(env); if (!cat.byId[b.plan_id] || !cat.byId[b.plan_id].legacy_tier_id) return fail("That plan can't be sold yet (it needs a tier link).", 400);
      await env.DB.prepare(
        `INSERT INTO plan_prices (plan_id, billing, country_code, currency, amount, ngn_amount, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, billing, country_code) DO UPDATE SET currency = excluded.currency, amount = excluded.amount, ngn_amount = excluded.ngn_amount, is_active = excluded.is_active`
      ).bind(b.plan_id, b.billing, cc, cur, amount, ngn, b.is_active === 0 || b.is_active === false ? 0 : 1).run();
      return json({ success: true, note: "Customers already subscribed keep the price they signed up at." });
    }
    if (m === "DELETE" && p === "/api/admin/price") {
      const b = await body(request);
      await env.DB.prepare("DELETE FROM plan_prices WHERE plan_id = ? AND billing = ? AND country_code = ?").bind(b.plan_id, b.billing, String(b.country_code || "").toUpperCase()).run();
      return json({ success: true });
    }

    if (m === "POST" && (p === "/api/admin/grant" || p === "/api/admin/recheck")) {
      const b = await body(request), slug = String(b.slug || "").toLowerCase().trim();
      const { results } = await env.DB.prepare("SELECT id, tier_id FROM profiles WHERE slug = ?").bind(slug).all();
      if (!results.length) return fail("No brand with that link.", 404);
      const id = results[0].id;
      if (p === "/api/admin/grant") {
        const cat = await getCatalog(env), planId = String(b.plan_id || "").trim();
        if (planId && !tierOfPlan(cat, planId)) return fail("That plan can't be given (no tier link).");
        const days = b.days == null || b.days === "" ? null : num(b.days, 1, 3650);
        if (b.days != null && b.days !== "" && days == null) return fail("Days must be a number from 1 to 3650.");
        await env.DB.prepare("INSERT OR IGNORE INTO profile_plan (profile_id, base_tier_id, eff_tier_id) VALUES (?, ?, ?)").bind(id, results[0].tier_id || null, results[0].tier_id || null).run();
        await applyPlanChange(env, id);   // lock in their own plan before adding the gift on top
        await env.DB.prepare("UPDATE profile_plan SET grant_tier_id = ?, grant_ends_at = ?, updated_at = datetime('now') WHERE profile_id = ?")
          .bind(planId ? tierOfPlan(cat, planId) : null, planId && days ? sqlTime(Date.now() + days * DAY) : null, id).run();
      }
      return json({ success: true, result: await applyPlanChange(env, id) });
    }
  } catch (err) {
    console.error("Admin API failed:", err);
    return fail("Something went wrong: " + String((err && err.message) || err).slice(0, 160), 500);
  }
  return null;
}

export function adminShellHtml(url) {
  const o = url.origin;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Admin | BiziPlex</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F2F5F3;color:#0F1419}@media(prefers-color-scheme:dark){body{background:#0D1114;color:#E8ECEF}}</style></head>
<body><div id="bz-admin"><p style="padding:24px">Loading…</p></div><script src="${o}/admin-ui.js"></script></body></html>`;
}

