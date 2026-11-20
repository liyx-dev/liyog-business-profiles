// =====================================================================
// BIZIPLEX — src/lib/studio-api.js
// The two small endpoints the Studio (/studio/{brand}) needs. Everything else the Studio does
// reuses the endpoints you already have (products, collections, boosts, tiers, inquiries, referrals).
//   GET  /api/studio/overview?slug=...   owner only: who you are, your brands, the chosen brand's full
//                                        profile, counts, rating, and your plan limits. ONE request.
//   POST /api/studio/log                 owner only: the Studio reports a problem it hit (goes to the
//                                        Worker logs only: nothing is written to the database).
// Reads are a handful of small indexed queries, run only when the Studio opens or is refreshed.
// =====================================================================
import { verifySessionToken } from "./auth.js";
import { getProfileLimits } from "./plans.js";
import * as reviews from "./reviews.js";
import { readReviewStats } from "./brand-seo.js";

const J = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "private, no-store" }
});

function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
async function sessionUser(request, env) {
  const t = cookie(request, "liyog_session");
  return t ? await verifySessionToken(env, t) : null;
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).hostname === new URL(request.url).hostname; } catch (e) { return false; }
}

async function overview(request, env, url) {
  const uid = await sessionUser(request, env);
  if (!uid) return J({ ok: false, signedOut: true, error: "Please sign in to open your Studio." }, 401);

  // who + all their brands (small columns only)
  const [{ results: users }, { results: brands }] = await env.DB.batch([
    env.DB.prepare("SELECT id, display_name, avatar_url FROM users WHERE id = ?").bind(uid),
    env.DB.prepare("SELECT id, slug, business_name, logo_url, moderation_status FROM profiles WHERE owner_id = ? ORDER BY created_at ASC LIMIT 10").bind(uid)
  ]);
  const user = users[0] ? { id: users[0].id, name: users[0].display_name || "", avatar: users[0].avatar_url || "" } : { id: uid, name: "", avatar: "" };

  const out = { ok: true, user, brands, profile: null, stats: null, plan: null, serverTime: new Date().toISOString() };
  const slug = String(url.searchParams.get("slug") || "").toLowerCase().trim();
  const chosen = slug ? brands.find((b) => String(b.slug).toLowerCase() === slug) : null;
  if (!chosen) return J(out);

  // the chosen brand: full row (the same fields the profile page already uses), counts and plan, in one round trip
  const [{ results: rows }, { results: items }, { results: cols }, { results: inq }] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND owner_id = ?").bind(chosen.id, uid),
    env.DB.prepare("SELECT kind, is_draft, COUNT(*) AS n FROM products WHERE profile_id = ? AND is_active = 1 GROUP BY kind, is_draft").bind(chosen.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM collections WHERE profile_id = ?").bind(chosen.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE profile_id = ?").bind(chosen.id)
  ]);
  if (!rows.length) return J(out);
  const profile = rows[0];
  const stats = { products: 0, services: 0, drafts: 0, collections: cols[0] ? cols[0].n : 0, inquiries: inq[0] ? inq[0].n : 0,
    views: profile.profile_views || 0, likes: null, dislikes: null, rating: null, ratingCount: null, activeBoosts: null };
  for (const r of items) {
    if (r.is_draft) stats.drafts += r.n; else if (r.kind === "service") stats.services += r.n; else stats.products += r.n;
  }

  // optional extras: any one of these failing must never break the Studio
  try {
    const s = readReviewStats(await reviews.getStats(env, profile.id));
    stats.rating = s.avg || null; stats.ratingCount = s.count || 0; stats.likes = s.likes || 0; stats.dislikes = s.dislikes || 0;
  } catch (e) { /* ratings are optional */ }
  try {
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM boost_log WHERE profile_id = ? AND expires_at > datetime('now')").bind(profile.id).all();
    stats.activeBoosts = results[0] ? results[0].n : 0;
  } catch (e) { /* column names differ: the boost page reads its own data */ }
  try { out.plan = await getProfileLimits(env, profile); } catch (e) { out.plan = null; }

  out.profile = profile;
  out.stats = stats;
  return J(out);
}

async function clientLog(request, env) {
  if (!sameOrigin(request)) return new Response(null, { status: 204 });
  const uid = await sessionUser(request, env);
  if (!uid) return new Response(null, { status: 204 });
  try {
    const text = (await request.text()).slice(0, 1500);
    const d = JSON.parse(text || "{}");
    console.error("[studio-client]", JSON.stringify({ user: uid, where: String(d.w || "").slice(0, 40), msg: String(d.m || "").slice(0, 200), status: d.s || 0, path: String(d.u || "").slice(0, 80) }));
  } catch (e) { /* a bad report is simply ignored */ }
  return new Response(null, { status: 204 });
}

export async function routeStudioApi(request, env, ctx, url) {
  if (!url.pathname.startsWith("/api/studio/")) return null;
  try {
    if (request.method === "GET" && url.pathname === "/api/studio/overview") return await overview(request, env, url);
    if (request.method === "POST" && url.pathname === "/api/studio/log") return await clientLog(request, env);
  } catch (err) {
    console.error("Studio API failed:", err);
    return J({ ok: false, error: "Something went wrong on our side. Please try again." }, 500);
  }
  return null;
}

