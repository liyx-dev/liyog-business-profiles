// =====================================================================
// BIZIPLEX — src/lib/subscriptions.js
// Paid plans that renew: monthly, 6 months or yearly.
//   * Card:    the first payment is a normal Paystack checkout. If the card can be reused, we charge it again
//              ourselves each period (nightly sweep, plus a quick check when the owner opens the Studio).
//              Prices are LOCKED for as long as they stay subscribed.
//   * Manual:  pay over WhatsApp for one period, you confirm it (no auto-renew).
//   * Upgrading: pay the new plan minus credit for the unused time of the old one.
//   * The old one-time upgrade keeps working untouched until you have set prices (plan_prices).
// All money is whole minor units (kobo/cents). Every payment attempt is a row in subscription_payments,
// which is also what the BiziPartner commissions will read later.
// =====================================================================
import { isAdminRequest } from "./security.js";
import { verifySessionToken } from "./auth.js";
import { getPlanLimits } from "./plans.js";
import { handlePaystackWebhook as tiersWebhook } from "./tiers.js";
import { handleBoostPaystackWebhook as boostWebhook } from "./boost.js";
import { DAY, getSettings, getCatalog, tierOfPlan, sqlTime, parseSql, addMonths, applyPlanChange, getPlanStatus, startTrial, runPlanMaintenance } from "./plan-engine.js";

export const BILLING = { monthly: { months: 1, label: "Monthly" }, semiannual: { months: 6, label: "6 months" }, yearly: { months: 12, label: "Yearly" } };
const PAYSTACK_COUNTRIES = { NG: "NGN", GH: "GHS", ZA: "ZAR", KE: "KES" };
const MIN_CHARGE_KOBO = 10000;               // never charge less than ₦100

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store", ...headers } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const onNewSite = (url) => /(^|\.)biziplex\.com$/.test(url.hostname);

function cookie(request, name) { const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : null; }
async function sessionUser(request, env) { const t = cookie(request, "liyog_session"); return t ? await verifySessionToken(env, t) : null; }
function sameOrigin(request) { const o = request.headers.get("Origin"); if (!o) return true; try { return new URL(o).hostname === new URL(request.url).hostname; } catch (e) { return false; } }
async function readJson(request) { try { const t = await request.text(); return t.length > 20000 ? {} : JSON.parse(t || "{}"); } catch (e) { return {}; } }

function resolveCountry(request) { const c = request.cf && request.cf.country; return c && PAYSTACK_COUNTRIES[c] ? c : "USD"; }

// ---- money: shown price -> what Paystack actually charges (your account settles in NGN) ----
const up50 = (kobo) => Math.ceil(kobo / 100 / 50) * 50 * 100;
async function toNgn(env, price) {
  if (price.currency === "NGN") return price.amount;
  if (price.ngn_amount != null) return price.ngn_amount;
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${price.currency}`);
    if (r.ok) { const d = await r.json(); if (d.rates && d.rates.NGN) return up50(price.amount / 100 * d.rates.NGN * 100); }
  } catch (e) { console.error("Live FX lookup failed:", e); }
  const { results } = await env.DB.prepare("SELECT ngn_per_unit FROM fx_fallback_rates WHERE currency = ?").bind(price.currency).all();
  if (results.length) return up50(price.amount / 100 * results[0].ngn_per_unit * 100);
  throw new Error(`No NGN conversion for ${price.currency}`);
}

async function priceFor(env, planId, billing, country) {
  for (const c of country === "USD" ? ["USD"] : [country, "USD"]) {
    const { results } = await env.DB.prepare(
      "SELECT plan_id, billing, country_code, currency, amount, ngn_amount FROM plan_prices WHERE plan_id = ? AND billing = ? AND country_code = ? AND is_active = 1").bind(planId, billing, c).all();
    if (results.length) return results[0];
  }
  return null;
}

async function ownedProfile(env, profileId, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, owner_id, slug, business_name, moderation_status, tier_id, max_products, profile_views FROM profiles WHERE id = ? AND owner_id = ?").bind(profileId, userId).all();
  return results[0] || null;
}

// ---------------------------------------------------------------------
// Public pricing: everything the plan chooser needs in ONE request
// ---------------------------------------------------------------------
async function pricing(request, env, url) {
  const S = await getSettings(env), cat = await getCatalog(env), country = resolveCountry(request);
  const trial = { enabled: !!S.trial_enabled, days: S.trial_days, planId: S.trial_plan_id, planLabel: (cat.byId[S.trial_plan_id] || {}).label || null };
  const off = { enabled: false, country, plans: [], billing: [], trial };
  if (!onNewSite(url) || !S.sub_enabled) return json(off, 200, { "cache-control": "private, max-age=30" });

  let rows = [];
  try {
    for (const c of country === "USD" ? ["USD"] : [country, "USD"]) {
      const r = await env.DB.prepare(
        `SELECT pp.plan_id, pp.billing, pp.currency, pp.amount FROM plan_prices pp JOIN plans pl ON pl.plan_id = pp.plan_id
         WHERE pp.country_code = ? AND pp.is_active = 1 AND pl.is_active = 1`).bind(c).all();
      if (r.results.length) { rows = r.results; break; }
    }
  } catch (e) { return json(off); }
  const offered = S.sub_billing_offered.filter((b) => BILLING[b]);
  rows = rows.filter((r) => offered.includes(r.billing) && BILLING[r.billing]);
  if (!rows.length) return json(off, 200, { "cache-control": "private, max-age=30" });

  const byPlan = {};
  for (const r of rows) (byPlan[r.plan_id] = byPlan[r.plan_id] || { prices: {} }).prices[r.billing] = { amount: r.amount, currency: r.currency };
  const plans = [];
  for (const [id, p] of Object.entries(byPlan)) {
    const meta = cat.byId[id]; if (!meta || !meta.legacy_tier_id) continue;
    plans.push({ plan_id: id, label: meta.label, rank: Number(meta.rank), prices: p.prices, limits: await getPlanLimits(env, id) });
  }
  plans.sort((a, b) => a.rank - b.rank);
  const billing = offered.filter((b) => plans.some((p) => p.prices[b]));
  return json({ enabled: plans.length > 0, country, plans, billing: billing.map((b) => ({ id: b, label: BILLING[b].label, months: BILLING[b].months })), trial }, 200, { "cache-control": "private, max-age=30" });
}

// ---------------------------------------------------------------------
// A price quote (includes upgrade credit) and the checkout that uses it
// ---------------------------------------------------------------------
async function activeSub(env, profileId, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscriptions WHERE profile_id = ? AND status IN ('active','past_due') ORDER BY created_at DESC LIMIT 1`).bind(profileId).all();
  const s = results[0];
  return s && parseSql(s.current_period_end) > now ? s : null;
}

async function makeQuote(env, request, profile, planId, billing, now) {
  const S = await getSettings(env), cat = await getCatalog(env);
  if (!S.sub_enabled) return { error: "Paid plans aren't available right now." };
  if (!BILLING[billing] || !S.sub_billing_offered.includes(billing)) return { error: "That billing choice isn't available." };
  const meta = cat.byId[planId];
  if (!meta || !meta.legacy_tier_id || !Number(meta.is_active)) return { error: "That plan isn't available." };
  const country = resolveCountry(request), price = await priceFor(env, planId, billing, country);
  if (!price) return { error: "That plan isn't available in your country yet." };

  // A plan they already own for good (an old one-time purchase, or one you gave them) can't be bought again below it.
  try {
    const { results: own } = await env.DB.prepare("SELECT base_tier_id, grant_tier_id, grant_ends_at FROM profile_plan WHERE profile_id = ?").bind(profile.id).all();
    const o = own[0], ownTiers = [];
    if (o && o.base_tier_id) ownTiers.push(o.base_tier_id);
    if (o && o.grant_tier_id && (!o.grant_ends_at || parseSql(o.grant_ends_at) > now)) ownTiers.push(o.grant_tier_id);
    if (!o && profile.tier_id) ownTiers.push(profile.tier_id);
    const best = Math.max(-1, ...ownTiers.map((t) => (cat.byTier[t] ? Number(cat.byTier[t].rank) : -1)));
    if (best >= Number(meta.rank)) return { error: "Your brand already has this plan, or a better one, for good." };
  } catch (e) { /* migration not run yet */ }

  const ngnFull = await toNgn(env, price);
  const cur = await activeSub(env, profile.id, now);
  let mode = "new", credit = 0, replaces = null;
  if (cur) {
    const curRank = Number((cat.byId[cur.plan_id] || {}).rank), newRank = Number(meta.rank);
    if (cur.plan_id === planId) { mode = "same"; }
    else if (newRank > curRank) {
      mode = "upgrade"; replaces = cur.id;
      if (S.sub_upgrade_credit) {
        const total = parseSql(cur.current_period_end) - parseSql(cur.current_period_start), left = parseSql(cur.current_period_end) - now;
        if (total > 0 && left > 0) credit = Math.floor(cur.ngn_amount * Math.min(1, left / total));
      }
    } else return { error: "You're already on a higher plan. You can switch when it ends." };
  }
  const ngnCharge = Math.max(MIN_CHARGE_KOBO, up50(Math.max(0, ngnFull - credit)));
  return { ok: true, plan: meta, planId, billing, months: BILLING[billing].months, country, price, ngnFull, credit, ngnCharge, mode, replaces, existing: cur };
}

const quoteView = (q) => ({ planId: q.planId, planLabel: q.plan.label, billing: q.billing, months: q.months, currency: q.price.currency, amount: q.price.amount, ngnCharge: q.ngnCharge, credit: q.credit, mode: q.mode });

async function checkout(request, env, userId, now = Date.now()) {
  const body = await readJson(request), method = body.method === "manual" ? "manual" : body.method === "card" ? "card" : null;
  if (!method) return fail("Choose how you'd like to pay.");
  const profile = await ownedProfile(env, body.profile_id, userId);
  if (!profile) return fail("Not your profile.", 403);

  const { results: recent } = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscription_payments WHERE profile_id = ? AND status = 'pending' AND created_at > ?").bind(profile.id, sqlTime(now - 3600e3)).all();
  if (Number(recent[0].n) >= 6) return fail("You've started a few payments already. Please finish one or wait a little.", 429);

  let q; try { q = await makeQuote(env, request, profile, body.plan_id, body.billing, now); } catch (e) { console.error("Quote failed:", e); return fail("We couldn't work out the price right now. Please try again shortly.", 502); }
  if (q.error) return fail(q.error);
  if (method === "card" && !env.PAYSTACK_SECRET_KEY) return fail("Card payment isn't available right now. Please use WhatsApp instead.", 503);

  let subId, kind;
  if (q.mode === "same") { subId = q.existing.id; kind = "renewal"; }
  else {
    subId = crypto.randomUUID(); kind = "initial";
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, profile_id, user_id, plan_id, billing, country_code, currency, amount, ngn_amount, status, auto_renew)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(subId, profile.id, userId, q.planId, q.billing, q.country, q.price.currency, q.price.amount, q.ngnFull, method === "card" ? 1 : 0).run();
  }
  const payId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO subscription_payments (id, subscription_id, profile_id, kind, method, currency, amount, ngn_charge_amount, credit_ngn, replaces_sub_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(payId, subId, profile.id, kind, method, q.price.currency, q.price.amount, q.ngnCharge, q.credit, q.replaces).run();

  if (method === "manual") return json({ success: true, method: "manual", purchase: { id: payId, ...quoteView(q) } });

  const { results: u } = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).all();
  const email = u.length ? u[0].email : "no-reply@biziplex.com";
  try {
    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST", headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, amount: q.ngnCharge, currency: "NGN", channels: ["card"], reference: payId, callback_url: `${new URL(request.url).origin}/api/plans/paystack-callback`,
        metadata: { kind: "subscription", profile_id: profile.id, plan_id: q.planId, billing: q.billing, payment_id: payId } })
    });
    const d = await res.json();
    if (!res.ok || !d.status) { console.error("Paystack subscription init failed:", JSON.stringify(d)); await env.DB.prepare("UPDATE subscription_payments SET status = 'failed' WHERE id = ?").bind(payId).run(); return fail("Couldn't start payment. Please try again or use WhatsApp.", 502); }
    return json({ success: true, method: "card", authorizationUrl: d.data.authorization_url, summary: quoteView(q) });
  } catch (e) { console.error("Paystack subscription checkout error:", e); return fail("Couldn't start payment. Please try again or use WhatsApp.", 502); }
}

// ---------------------------------------------------------------------
// Confirming a payment (idempotent: callback, webhook, renewal and admin all end up here)
// ---------------------------------------------------------------------
export async function confirmPayment(env, paymentId, authorization = null, { now = Date.now() } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT sp.*, s.plan_id, s.billing, s.status AS sub_status, s.auto_renew, s.current_period_end, s.user_id
     FROM subscription_payments sp JOIN subscriptions s ON s.id = sp.subscription_id WHERE sp.id = ?`).bind(paymentId).all();
  if (!results.length) return { ok: false, reason: "not_found" };
  const pay = results[0];
  if (pay.status === "confirmed") return { ok: true, already: true };

  const claim = await env.DB.prepare("UPDATE subscription_payments SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status IN ('pending','failed')").bind(sqlTime(now), paymentId).run();
  if (!claim.meta || claim.meta.changes !== 1) return { ok: true, already: true };

  const S = await getSettings(env), cat = await getCatalog(env);
  const months = (BILLING[pay.billing] || BILLING.monthly).months, endMs = parseSql(pay.current_period_end);
  const continuous = pay.sub_status !== "pending" && Number.isFinite(endMs) && (endMs > now || now - endMs < (S.sub_grace_days + 1) * DAY);
  const start = continuous ? endMs : now, newEnd = addMonths(start, months);
  const reusable = authorization && authorization.reusable && authorization.authorization_code;
  const autoRenew = pay.method === "card" && (reusable || pay.auto_renew) ? 1 : 0;

  const stmts = [
    env.DB.prepare(
      `UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, next_charge_at = ?, fail_count = 0, last_error = NULL,
         auto_renew = CASE WHEN ? = 1 THEN 1 ELSE auto_renew END,
         authorization_code = COALESCE(?, authorization_code), auth_email = COALESCE(?, auth_email), card_last4 = COALESCE(?, card_last4), card_brand = COALESCE(?, card_brand)
       WHERE id = ?`
    ).bind(sqlTime(start), sqlTime(newEnd), autoRenew ? sqlTime(newEnd) : null, autoRenew,
      reusable ? authorization.authorization_code : null, reusable ? (authorization.email || null) : null, reusable ? (authorization.last4 || null) : null, reusable ? (authorization.brand || authorization.card_type || null) : null, pay.subscription_id)
  ];
  if (pay.replaces_sub_id) stmts.push(env.DB.prepare("UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, next_charge_at = NULL, cancelled_at = ? WHERE id = ?").bind(sqlTime(now), pay.replaces_sub_id));
  await env.DB.batch(stmts);

  const tier = tierOfPlan(cat, pay.plan_id);
  await env.DB.prepare("INSERT OR IGNORE INTO profile_plan (profile_id) VALUES (?)").bind(pay.profile_id).run();
  await applyPlanChange(env, pay.profile_id, { now });   // lock in the brand's own plan BEFORE the subscription goes on top
  await env.DB.prepare("UPDATE profile_plan SET sub_tier_id = ?, sub_ends_at = ?, updated_at = datetime('now') WHERE profile_id = ?")
    .bind(tier, sqlTime(newEnd + S.sub_grace_days * DAY), pay.profile_id).run();
  await applyPlanChange(env, pay.profile_id, { now });
  return { ok: true, periodEnd: sqlTime(newEnd), autoRenew: !!autoRenew };
}

async function paystackVerify(env, reference) {
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

export async function verifyAndConfirm(env, reference) {
  const { results } = await env.DB.prepare("SELECT * FROM subscription_payments WHERE id = ?").bind(reference).all();
  if (!results.length) return { ok: false, reason: "not_found" };
  const pay = results[0];
  if (pay.status === "confirmed") return { ok: true, already: true };
  if (pay.method !== "card") return { ok: false, reason: "not_card" };
  try {
    const v = await paystackVerify(env, reference), d = v.body && v.body.data;
    if (!(v.ok && v.body.status && d && d.status === "success" && d.amount === pay.ngn_charge_amount && d.currency === "NGN")) {
      if (d && d.status && d.status !== "abandoned" && d.status !== "ongoing") await env.DB.prepare("UPDATE subscription_payments SET status = 'failed' WHERE id = ? AND status = 'pending'").bind(reference).run();
      return { ok: false, reason: "verification_failed" };
    }
    const auth = d.authorization ? { ...d.authorization, email: d.customer && d.customer.email } : null;
    return await confirmPayment(env, reference, auth);
  } catch (e) { console.error("Subscription verify error:", e); return { ok: false, reason: "error" }; }
}

// ---------------------------------------------------------------------
// Renewals
// ---------------------------------------------------------------------
export async function chargeRenewal(env, sub, { now = Date.now() } = {}) {
  const S = await getSettings(env);
  const payId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO subscription_payments (id, subscription_id, profile_id, kind, method, currency, amount, ngn_charge_amount, status)
     VALUES (?, ?, ?, 'renewal', 'card', ?, ?, ?, 'pending')`).bind(payId, sub.id, sub.profile_id, sub.currency, sub.amount, sub.ngn_amount).run();
  let ok = false, reason = "declined";
  try {
    const r = await fetch("https://api.paystack.co/transaction/charge_authorization", {
      method: "POST", headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_code: sub.authorization_code, email: sub.auth_email, amount: sub.ngn_amount, currency: "NGN", reference: payId, metadata: { kind: "subscription", payment_id: payId, profile_id: sub.profile_id } })
    });
    const b = await r.json().catch(() => ({})), d = b.data;
    if (r.ok && b.status && d && d.status === "success" && d.amount === sub.ngn_amount && d.currency === "NGN") ok = true;
    else reason = (d && (d.gateway_response || d.status)) || b.message || "declined";
  } catch (e) { reason = "network"; console.error("Renewal charge error:", e); }

  if (ok) { const c = await confirmPayment(env, payId, null, { now }); return { ok: c.ok, paymentId: payId }; }
  const fails = (sub.fail_count || 0) + 1, giveUp = fails >= S.sub_retry_days;
  await env.DB.batch([
    env.DB.prepare("UPDATE subscription_payments SET status = 'failed' WHERE id = ?").bind(payId),
    env.DB.prepare("UPDATE subscriptions SET fail_count = ?, last_error = ?, status = ?, auto_renew = ?, next_charge_at = ? WHERE id = ?")
      .bind(fails, String(reason).slice(0, 120), giveUp ? "expired" : "past_due", giveUp ? 0 : 1, giveUp ? null : sqlTime(now + DAY), sub.id)
  ]);
  return { ok: false, reason, giveUp };
}

export async function runRenewals(env, { now = Date.now(), limit = null } = {}) {
  if (!env.PAYSTACK_SECRET_KEY) return { charged: 0, failed: 0, skipped: "no key" };
  const S = await getSettings(env), cap = limit || S.sub_renewals_per_run, out = { charged: 0, failed: 0 };
  let due = [];
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM subscriptions WHERE status IN ('active','past_due') AND auto_renew = 1 AND next_charge_at IS NOT NULL AND next_charge_at <= ? AND authorization_code IS NOT NULL
       ORDER BY next_charge_at ASC LIMIT ?`).bind(sqlTime(now), cap).all();
    due = r.results;
  } catch (e) { return out; }
  for (const s of due) { try { const x = await chargeRenewal(env, s, { now }); if (x.ok) out.charged++; else out.failed++; } catch (e) { out.failed++; console.error("Renewal failed for one subscription:", e); } }
  return out;
}

/** Called when the owner opens the Studio: if their renewal is due, charge it now instead of waiting for the night. */
export async function renewIfDue(env, profileId, { now = Date.now() } = {}) {
  if (!env.PAYSTACK_SECRET_KEY) return null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM subscriptions WHERE profile_id = ? AND status IN ('active','past_due') AND auto_renew = 1 AND next_charge_at IS NOT NULL AND next_charge_at <= ? AND authorization_code IS NOT NULL LIMIT 1`
    ).bind(profileId, sqlTime(now)).all();
    return results[0] ? await chargeRenewal(env, results[0], { now }) : null;
  } catch (e) { console.error("renewIfDue failed:", e); return null; }
}

async function setAutoRenew(env, profile, on, now) {
  const s = await activeSub(env, profile.id, now);
  if (!s) return { error: "You don't have a plan that renews." };
  if (on && !s.authorization_code) return { error: "To renew automatically, please pay once with your card." };
  await env.DB.prepare("UPDATE subscriptions SET auto_renew = ?, next_charge_at = ?, fail_count = 0 WHERE id = ?").bind(on ? 1 : 0, on ? s.current_period_end : null, s.id).run();
  return { ok: true, autoRenew: on, until: s.current_period_end };
}

// ---------------------------------------------------------------------
// Webhook (card payments finishing while the browser was closed)
// ---------------------------------------------------------------------
async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder(), key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function handleSubscriptionWebhook(request, env) {
  if (!env.PAYSTACK_SECRET_KEY) return new Response("Not configured", { status: 503 });
  const raw = await request.text(), sig = request.headers.get("x-paystack-signature");
  if (!sig || sig !== (await hmacSha512Hex(env.PAYSTACK_SECRET_KEY, raw))) return new Response("Invalid signature", { status: 401 });
  let ev; try { ev = JSON.parse(raw); } catch (e) { return new Response("Bad payload", { status: 400 }); }
  if (ev.event === "charge.success" && ev.data && ev.data.reference) await verifyAndConfirm(env, ev.data.reference);
  return new Response("ok", { status: 200 });
}

/** One address for Paystack to call. It hands the same message to the tier, boost and subscription handlers; each ignores references that aren't its own. */
async function unifiedWebhook(request, env) {
  const results = [];
  for (const h of [tiersWebhook, boostWebhook, handleSubscriptionWebhook]) {
    try { results.push((await h(request.clone(), env)).status); } catch (e) { console.error("Webhook handler failed:", e); results.push(500); }
  }
  const good = results.some((s) => s === 200);
  return new Response(good ? "ok" : "rejected", { status: good ? 200 : (results.includes(401) ? 401 : 500) });
}

// ---------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------
export async function routePlansApi(request, env, ctx, url) {
  const path = url.pathname, method = request.method, now = Date.now();
  if (!path.startsWith("/api/plans/") && path !== "/api/paystack/webhook") return null;
  try {
    if (method === "GET" && path === "/api/plans/pricing") return await pricing(request, env, url);
    if (method === "POST" && path === "/api/paystack/webhook") return await unifiedWebhook(request, env);

    if (method === "GET" && path === "/api/plans/paystack-callback") {
      const ref = url.searchParams.get("reference") || url.searchParams.get("trxref");
      const res = ref ? await verifyAndConfirm(env, ref) : { ok: false };
      let slug = null;
      if (ref) { const { results } = await env.DB.prepare("SELECT p.slug FROM subscription_payments sp JOIN profiles p ON p.id = sp.profile_id WHERE sp.id = ?").bind(ref).all(); slug = results[0] && results[0].slug; }
      const dest = new URL(slug ? `/studio/${encodeURIComponent(slug)}/plan` : "/studio", url.origin);
      dest.searchParams.set("pay", res.ok ? "success" : "error");
      return Response.redirect(dest.toString(), 302);
    }

    if (method === "POST" && path === "/api/plans/manual-activate") {
      if (!isAdminRequest(request, env)) return fail("Not authorized.", 403);
      const b = await readJson(request); if (!b.purchase_id) return fail("purchase_id is required.");
      const { results } = await env.DB.prepare("SELECT method FROM subscription_payments WHERE id = ?").bind(b.purchase_id).all();
      if (!results.length) return fail("Payment not found.", 404);
      if (results[0].method !== "manual") return fail("This isn't a manual payment.");
      return json({ success: true, ...(await confirmPayment(env, b.purchase_id, null, { now })) });
    }

    // everything below needs a signed-in owner
    if (method !== "GET" && !sameOrigin(request)) return fail("Not allowed", 403);
    const userId = await sessionUser(request, env);
    if (!userId) return fail("Not authenticated", 401);

    if (method === "POST" && path === "/api/plans/checkout") return await checkout(request, env, userId, now);

    const profileId = method === "GET" ? url.searchParams.get("profile_id") : (await readJson(request.clone())).profile_id;
    const profile = profileId ? await ownedProfile(env, profileId, userId) : null;
    if (!profile) return fail("Not your profile.", 403);

    if (method === "GET" && path === "/api/plans/me") {
      await renewIfDue(env, profile.id, { now });
      const p2 = (await env.DB.prepare("SELECT id, owner_id, tier_id, max_products, profile_views, moderation_status FROM profiles WHERE id = ?").bind(profile.id).all()).results[0];
      return json({ ok: true, status: await getPlanStatus(env, p2, { now }) });
    }
    if (method === "GET" && path === "/api/plans/quote") {
      const q = await makeQuote(env, request, profile, url.searchParams.get("plan_id"), url.searchParams.get("billing"), now);
      return q.error ? fail(q.error) : json({ ok: true, quote: quoteView(q) });
    }
    if (method === "POST" && path === "/api/plans/trial/start") {
      const full = (await env.DB.prepare("SELECT id, owner_id, tier_id, max_products, profile_views, moderation_status FROM profiles WHERE id = ?").bind(profile.id).all()).results[0];
      const r = await startTrial(env, full, { now });
      return r.ok ? json({ success: true, ...r }) : fail(r.error, 400);
    }
    if (method === "POST" && path === "/api/plans/auto-renew") {
      const b = await readJson(request), r = await setAutoRenew(env, profile, !!b.on, now);
      return r.error ? fail(r.error) : json({ success: true, ...r });
    }
  } catch (err) {
    console.error("Plans API failed:", err);
    return fail("Something went wrong on our side. Please try again.", 500);
  }
  return null;
}

/** Nightly: end expired trials/plans, then charge a bounded number of renewals. */
export async function runPlanNightly(env) {
  const out = {};
  try { out.maintenance = await runPlanMaintenance(env); } catch (e) { console.error("Plan maintenance failed:", e); }
  try { out.renewals = await runRenewals(env); } catch (e) { console.error("Renewals failed:", e); }
  return out;
}

