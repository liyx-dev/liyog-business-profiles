// =====================================================================
// BIZIPLEX — src/lib/shop-api.js
// ONE router for every new Round 1 endpoint, so index.js needs a single
// call. Returns a Response, or null when the path is not one of ours.
//   Public (cached at the edge for a short time, no cookies involved):
//     GET /api/profiles/:id/collections   /catalogue   /search-index
//     GET /api/collections/:id/items      GET /api/fx
//   Owner only (session + ownership + same-origin check on every write):
//     collections create/edit/delete/items/order, product photos, video, plan limits
//   Admin only (x-admin-secret): /api/admin/fx-refresh, /api/admin/backfill-prices
// =====================================================================
import { verifySessionToken } from "./auth.js";
import { checkText } from "./moderation.js";
import { getProfileLimits, hasRoom } from "./plans.js";
import { extractYouTubeId, checkYouTube, runVideoChecks } from "./media.js";
import { getRates, refreshFxRates, viewerCurrencyFromCountry, parseLegacyPriceDisplay, normalizeCurrency, currencyFromCountryName } from "./money.js";
import { isAdminRequest } from "./security.js";
import * as data from "./shop-data.js";

const ID = "([A-Za-z0-9-]{8,64})";
const R = {
  profCollections: new RegExp(`^/api/profiles/${ID}/collections$`),
  profSearch: new RegExp(`^/api/profiles/${ID}/search$`),
  profLimits: new RegExp(`^/api/profiles/${ID}/plan-limits$`),
  profColOrder: new RegExp(`^/api/profiles/${ID}/collections-order$`),
  colItems: new RegExp(`^/api/collections/${ID}/items$`),
  colOrder: new RegExp(`^/api/collections/${ID}/order$`),
  colMembers: new RegExp(`^/api/collections/${ID}/members$`),
  col: new RegExp(`^/api/collections/${ID}$`),
  prodMedia: new RegExp(`^/api/products/${ID}/media$`),
  prodImages: new RegExp(`^/api/products/${ID}/images$`),
  prodImage: new RegExp(`^/api/products/${ID}/images/${ID}$`),
  prodImgOrder: new RegExp(`^/api/products/${ID}/images-order$`),
  prodVideo: new RegExp(`^/api/products/${ID}/video$`),
  prodVideoReport: new RegExp(`^/api/products/${ID}/video-report$`)
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
const fail = (msg, status = 400) => json({ error: msg }, status);

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
async function sessionUser(request, env) {
  const t = getCookie(request, "liyog_session");
  return t ? await verifySessionToken(env, t) : null;
}
/** Browsers always send Origin on cross-site writes: refuse any that is not one of our own sites. */
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { const h = new URL(origin).hostname; return h === new URL(request.url).hostname || data.ALLOWED_IMAGE_HOSTS.has(h); } catch (e) { return false; }
}
async function readJson(request, max = 40000) {
  try {
    const text = await request.text();
    if (text.length > max) return {};
    return JSON.parse(text || "{}");
  } catch (e) { return {}; }
}
const asIds = (arr, max) => Array.isArray(arr) ? [...new Set(arr.filter((x) => typeof x === "string" && /^[A-Za-z0-9-]{8,64}$/.test(x)))].slice(0, max) : [];

/** Short edge cache for public reads: protects D1 on busy brands. Never used when a cookie changes the answer. */
async function cachedPublic(request, ctx, ttl, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(request.url, { method: "GET" });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const payload = await produce();
  const res = json(payload, 200, { "cache-control": `public, max-age=${ttl}` });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** One compact, safe JSON shape for every product list (search, collections, profile rows). */
function row(r) {
  return {
    id: r.id, slug: r.slug || null, name: r.name, kind: r.kind === "service" ? "service" : "product",
    description: r.description || "", price_display: r.price_display || null, price_minor: r.price_minor ?? null,
    currency: r.currency || null, price_type: r.price_type || "fixed", image_url: r.image_url || null,
    img_w: r.img_w || null, img_h: r.img_h || null, img_color: r.img_color || null,
    has_video: !!(r.video_id && r.video_status !== "broken"), view_count: r.view_count || 0,
    avg_rating: r.avg_rating || 0, rating_count: r.rating_count || 0, like_count: r.like_count || 0
  };
}
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

async function ownedProfile(env, profileId, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE id = ? AND owner_id = ?").bind(profileId, userId).all();
  return results.length ? results[0] : null;
}
async function ownedCollection(env, id, userId) {
  const { results } = await env.DB.prepare(
    "SELECT c.*, p.tier_id AS p_tier, p.max_products AS p_max FROM collections c JOIN profiles p ON p.id = c.profile_id WHERE c.id = ? AND p.owner_id = ?"
  ).bind(id, userId).all();
  return results.length ? results[0] : null;
}
async function ownedProduct(env, id, userId) {
  const { results } = await env.DB.prepare(
    `SELECT pr.id, pr.profile_id, pr.video_id, pr.video_status, p.tier_id AS p_tier, p.max_products AS p_max
     FROM products pr JOIN profiles p ON p.id = pr.profile_id WHERE pr.id = ? AND pr.is_active = 1 AND p.owner_id = ?`
  ).bind(id, userId).all();
  return results.length ? results[0] : null;
}

// Shown (by the tiny service worker below) whenever a page can't be reached because the phone is offline.
const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>You're offline | BiziPlex</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F3F1EA;color:#111;text-align:center}
@media(prefers-color-scheme:dark){body{background:#0F0E0C;color:#F3F0E8}.c{background:#1A1A1A!important;border-color:#2E2B24!important}p{color:#B0AA98!important}}
.c{max-width:380px;background:#fff;border:1px solid #E4DFD1;border-radius:24px;padding:34px 24px;box-shadow:0 10px 28px rgba(17,17,17,.12)}
.i{width:72px;height:72px;margin:0 auto 16px;border-radius:50%;background:rgba(0,169,79,.12);display:flex;align-items:center;justify-content:center;color:#00A94F}
h1{font-size:21px;margin:0 0 8px}p{margin:0 0 20px;font-size:14.5px;line-height:1.55;color:#625F53}
button{height:48px;padding:0 28px;border:0;border-radius:999px;background:#00A94F;color:#fff;font:800 15px system-ui;cursor:pointer}
small{display:block;margin-top:14px;color:#9B9686;font-size:12.5px}</style></head><body><div class="c" role="alert">
<div class="i"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/><path d="M3 3l18 18"/></svg></div>
<h1>You're offline</h1><p>We can't reach BiziPlex right now. Check your connection. This page will reload by itself as soon as you're back online.</p>
<button type="button" id="r">Try again</button><small id="s"></small></div>
<script>var b=document.getElementById("r"),s=document.getElementById("s");function go(){s.textContent="Checking…";location.reload()}b.onclick=go;addEventListener("online",go);setInterval(function(){if(navigator.onLine)go()},8000)</script></body></html>`;

// Minimal service worker: it ONLY steps in when a page navigation fails because there is no network.
const SW_JS = `const V="bz-offline-v1",OFF="/offline";
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.add(new Request(OFF,{cache:"reload"}))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request;if(r.mode!=="navigate")return;e.respondWith(fetch(r).catch(()=>caches.match(OFF).then(x=>x||new Response("You are offline",{status:503,headers:{"content-type":"text/plain"}}))))});`;

export async function routeShopApi(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
  if (path === "/offline") return new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  if (!path.startsWith("/api/")) return null;
  const method = request.method;
  let m;

  // ------------------------------ public reads ------------------------------
  // Quick self-check the owner screens call when something fails: it only says which parts of the
  // database upgrade are missing. No private data.
  if (method === "GET" && path === "/api/shop/health") {
    const need = { products: ["kind", "price_minor", "currency", "price_type", "search_text", "img_w", "img_h", "img_color", "video_id", "video_status"],
      product_images: ["url", "position"], collections: ["slug", "status", "item_count"], collection_items: ["collection_id", "product_id"], plans: ["plan_id"], plan_limits: ["limit_key"] };
    const missing = [];
    for (const [table, cols] of Object.entries(need)) {
      try {
        const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const have = new Set(results.map((r) => r.name));
        if (!have.size) { missing.push(table); continue; }
        cols.forEach((c) => { if (!have.has(c)) missing.push(`${table}.${c}`); });
      } catch (e) { missing.push(table); }
    }
    return json({ ok: missing.length === 0, missing });
  }

  // Profile page rows: the first items of every public collection, as plain data (the page draws them with the
  // normal product card, so nothing new is invented).
  if (method === "GET" && (m = path.match(R.profCollections))) {
    const mine = url.searchParams.get("mine") === "1";
    const surface = url.searchParams.get("surface") === "profile" ? "profile" : "catalogue";
    const preview = Math.min(Math.max(parseInt(url.searchParams.get("preview") || "0", 10) || 0, 0), 12);
    const build = async () => {
      if (mine) {
        const uid = await sessionUser(request, env);
        const owner = uid ? await ownedProfile(env, m[1], uid) : null;
        if (!owner) return null;
        return { collections: await data.listCollections(env, m[1], { surface, mine: true }) };
      }
      const profile = await data.getPublicProfile(env, m[1]);
      if (!profile) return { collections: [] };
      const cols = await data.listCollections(env, m[1], { surface });
      const previews = preview > 0 ? await data.getCollectionPreviews(env, cols.slice(0, 8).map((c) => c.id), preview) : {};
      return { collections: cols.map((c) => ({ ...c, items: (previews[c.id] || []).map(row) })) };
    };
    if (mine) { const out = await build(); return out ? json(out) : fail("Not authenticated", 401); }
    return cachedPublic(request, ctx, 30, async () => (await build()) || { collections: [] });
  }

  // Brand-only search: products, services and collections of ONE brand, paginated, edge-cached.
  if (method === "GET" && (m = path.match(R.profSearch))) {
    const profile = await data.getPublicProfile(env, m[1]);
    if (!profile) return fail("Not found", 404);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
    const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), 60);
    const per = 8;
    return cachedPublic(request, ctx, 30, async () => {
      const r = await data.queryCatalogue(env, profile.id, { q, sort: q ? "" : "views", offset: (page - 1) * per, limit: per, withTotal: true });
      let collections = [];
      if (page === 1) {
        const binds = [profile.id];
        let where = "profile_id = ? AND status = 'live' AND item_count > 0";
        if (q) { where += " AND lower(title) LIKE ? ESCAPE '\\'"; binds.push(`%${likeEsc(q.toLowerCase())}%`); }
        const { results } = await env.DB.prepare(`SELECT id, slug, title, item_count, cover_url, cover_color FROM collections WHERE ${where} ORDER BY position ASC LIMIT 6`).bind(...binds).all();
        collections = results;
      }
      return { products: r.rows.map(row), collections, total: r.total, page, pages: Math.max(1, Math.ceil(r.total / per)),
        brandVideo: page === 1 && !q ? extractYouTubeId(profile.youtube_url) : null };
    });
  }

  if (method === "GET" && (m = path.match(R.colItems))) {
    const { results } = await env.DB.prepare(`SELECT id, profile_id FROM collections WHERE id = ? AND status = 'live'`).bind(m[1]).all();
    if (!results.length) return fail("Not found", 404);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
    return cachedPublic(request, ctx, 30, async () => {
      const r = await data.getCollectionItems(env, m[1], { offset, limit: 12, excludeProductId: url.searchParams.get("exclude") || null });
      return { items: r.rows.map(row), next: r.hasMore ? offset + 12 : null };
    });
  }

  if (method === "GET" && path === "/api/fx") {
    const { perUsd, updatedAt } = await getRates(env);
    const cc = request.cf && request.cf.country;
    return json({ currency: viewerCurrencyFromCountry(cc), rates: perUsd, updatedAt }, 200, { "cache-control": "private, max-age=600" });
  }

  // ------------------------------ video report (public, can never hide a video by itself) ------------------------------
  if (method === "POST" && (m = path.match(R.prodVideoReport))) {
    if (!sameOrigin(request)) return fail("Not allowed", 403);
    await env.DB.prepare("UPDATE products SET video_status = 'suspect' WHERE id = ? AND video_id IS NOT NULL AND video_status IN ('ok','unknown')").bind(m[1]).run();
    return json({ success: true });
  }

  // ------------------------------ admin ------------------------------
  if (method === "POST" && path === "/api/admin/fx-refresh") {
    if (!isAdminRequest(request, env)) return fail("Not authorized", 403);
    try { return json({ success: true, ...(await refreshFxRates(env, { force: true })) }); } catch (e) { return fail(String(e.message || e), 502); }
  }
  if (method === "POST" && path === "/api/admin/backfill-prices") {
    if (!isAdminRequest(request, env)) return fail("Not authorized", 403);
    const dry = url.searchParams.get("dry") !== "0";
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.price_display, pr.default_currency, pr.store_country FROM products p JOIN profiles pr ON pr.id = p.profile_id
       WHERE p.price_source IS NULL AND p.price_display IS NOT NULL AND TRIM(p.price_display) != '' LIMIT 500`
    ).all();
    const plan = results.map((r) => {
      const fb = normalizeCurrency(r.default_currency) || currencyFromCountryName(r.store_country) || "NGN";
      return { id: r.id, text: r.price_display, ...parseLegacyPriceDisplay(r.price_display, fb) };
    });
    if (!dry) {
      for (let i = 0; i < plan.length; i += 50) {
        await env.DB.batch(plan.slice(i, i + 50).map((x) =>
          env.DB.prepare("UPDATE products SET price_minor = ?, currency = ?, price_type = ?, price_source = ? WHERE id = ? AND price_source IS NULL")
            .bind(x.price_minor, x.currency, x.price_type, x.price_source, x.id)));
      }
    }
    return json({ dryRun: dry, processed: plan.length, unparsed: plan.filter((x) => x.price_source === "unparsed").length, sample: plan.slice(0, 15) });
  }

  // ------------------------------ everything below needs a signed-in owner ------------------------------
  const owned = R.profLimits.test(path) || R.profColOrder.test(path) || R.colItems.test(path) || R.colOrder.test(path) || R.colMembers.test(path) || R.col.test(path) ||
    R.prodMedia.test(path) || R.prodImages.test(path) || R.prodImage.test(path) || R.prodImgOrder.test(path) || R.prodVideo.test(path) ||
    (R.profCollections.test(path) && method === "POST");
  if (!owned) return null;

  if (method !== "GET" && !sameOrigin(request)) return fail("Not allowed", 403);
  const userId = await sessionUser(request, env);
  if (!userId) return fail("Not authenticated", 401);

  // plan limits + usage
  if (method === "GET" && (m = path.match(R.profLimits))) {
    const profile = await ownedProfile(env, m[1], userId);
    if (!profile) return fail("Not your profile", 403);
    const { planId, limits } = await getProfileLimits(env, profile);
    const { results: c } = await env.DB.prepare("SELECT COUNT(*) AS n FROM collections WHERE profile_id = ?").bind(profile.id).all();
    return json({ planId, limits, usage: { collections: c[0].n }, defaultCurrency: normalizeCurrency(profile.default_currency) || currencyFromCountryName(profile.store_country) || "NGN" });
  }

  // create collection
  if (method === "POST" && (m = path.match(R.profCollections))) {
    const profile = await ownedProfile(env, m[1], userId);
    if (!profile) return fail("Not your profile", 403);
    const body = await readJson(request);
    const title = String(body.title || "").trim().slice(0, 60);
    const description = String(body.description || "").trim().slice(0, 200);
    if (!title) return fail("Please give your collection a title.");
    if (!checkText(`${title} ${description}`).passed) return fail("That text isn't allowed. Please rephrase it.", 422);
    const { limits } = await getProfileLimits(env, profile);
    const { results: cnt } = await env.DB.prepare("SELECT COUNT(*) AS n FROM collections WHERE profile_id = ?").bind(profile.id).all();
    if (!hasRoom(cnt[0].n, limits.max_collections)) return fail(`Your plan allows ${limits.max_collections} collections. Upgrade to add more.`, 403);
    let base = data.slugify(title) || "collection", slug = base, n = 2;
    for (;;) {
      const { results } = await env.DB.prepare("SELECT 1 FROM collections WHERE profile_id = ? AND slug = ?").bind(profile.id, slug).all();
      if (!results.length) break;
      slug = `${base}-${n++}`;
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO collections (id, profile_id, slug, title, description, status, reach, show_on_profile, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1024 FROM collections WHERE profile_id = ?))`
    ).bind(id, profile.id, slug, title, description || null, body.status === "draft" ? "draft" : "live", body.reach === "public" ? "public" : "brand", body.show_on_profile === 0 || body.show_on_profile === false ? 0 : 1, profile.id).run();
    return json({ success: true, id, slug });
  }

  // order collections
  if (method === "PUT" && (m = path.match(R.profColOrder))) {
    const profile = await ownedProfile(env, m[1], userId);
    if (!profile) return fail("Not your profile", 403);
    const ids = asIds((await readJson(request)).collection_ids, 200);
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map((id, k) =>
        env.DB.prepare("UPDATE collections SET position = ? WHERE id = ? AND profile_id = ?").bind((i + k + 1) * 1024, id, profile.id)));
    }
    return json({ success: true });
  }

  // edit / delete one collection
  if (method === "PATCH" && (m = path.match(R.col))) {
    const col = await ownedCollection(env, m[1], userId);
    if (!col) return fail("Not found", 404);
    const body = await readJson(request);
    const u = {};
    if (body.title !== undefined) { u.title = String(body.title).trim().slice(0, 60); if (!u.title) return fail("Title can't be empty."); }
    if (body.description !== undefined) u.description = String(body.description || "").trim().slice(0, 200) || null;
    if (u.title || u.description) if (!checkText(`${u.title || ""} ${u.description || ""}`).passed) return fail("That text isn't allowed. Please rephrase it.", 422);
    if (body.reach !== undefined) u.reach = body.reach === "public" ? "public" : "brand";
    if (body.status !== undefined) u.status = body.status === "draft" ? "draft" : "live";
    if (body.show_on_profile !== undefined) u.show_on_profile = body.show_on_profile ? 1 : 0;
    const keys = Object.keys(u);
    if (!keys.length) return fail("Nothing to update.");
    await env.DB.prepare(`UPDATE collections SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...keys.map((k) => u[k]), col.id).run();
    return json({ success: true });
  }
  if (method === "DELETE" && (m = path.match(R.col))) {
    const col = await ownedCollection(env, m[1], userId);
    if (!col) return fail("Not found", 404);
    await env.DB.batch([env.DB.prepare("DELETE FROM collection_items WHERE collection_id = ?").bind(col.id), env.DB.prepare("DELETE FROM collections WHERE id = ?").bind(col.id)]);
    return json({ success: true });
  }

  // which products are in this collection (owner only; used by the item picker)
  if (method === "GET" && (m = path.match(R.colMembers))) {
    const col = await ownedCollection(env, m[1], userId);
    if (!col) return fail("Not found", 404);
    const { results } = await env.DB.prepare("SELECT product_id FROM collection_items WHERE collection_id = ?").bind(col.id).all();
    return json({ ids: results.map((r) => r.product_id) });
  }

  // add / remove items
  if (method === "PUT" && (m = path.match(R.colItems))) {
    const col = await ownedCollection(env, m[1], userId);
    if (!col) return fail("Not found", 404);
    const body = await readJson(request);
    const add = asIds(body.add, 200), remove = asIds(body.remove, 200);
    if (add.length) {
      const { limits } = await getProfileLimits(env, { tier_id: col.p_tier, max_products: col.p_max });
      const ph = add.map(() => "?").join(",");
      const { results: valid } = await env.DB.prepare(`SELECT id FROM products WHERE id IN (${ph}) AND profile_id = ? AND is_active = 1 AND is_draft = 0`).bind(...add, col.profile_id).all();
      const { results: have } = await env.DB.prepare("SELECT product_id FROM collection_items WHERE collection_id = ?").bind(col.id).all();
      const haveSet = new Set(have.map((h) => h.product_id));
      const fresh = valid.map((v) => v.id).filter((id) => !haveSet.has(id));
      if (limits.max_items_per_collection >= 0 && haveSet.size + fresh.length > limits.max_items_per_collection) return fail(`A collection on your plan can hold ${limits.max_items_per_collection} items.`, 403);
      const { results: mx } = await env.DB.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM collection_items WHERE collection_id = ?").bind(col.id).all();
      let pos = mx[0].p;
      for (let i = 0; i < fresh.length; i += 50) {
        await env.DB.batch(fresh.slice(i, i + 50).map((pid) => env.DB.prepare("INSERT OR IGNORE INTO collection_items (collection_id, product_id, position) VALUES (?, ?, ?)").bind(col.id, pid, (pos += 1024))));
      }
    }
    if (remove.length) await env.DB.prepare(`DELETE FROM collection_items WHERE collection_id = ? AND product_id IN (${remove.map(() => "?").join(",")})`).bind(col.id, ...remove).run();
    await data.recomputeCollection(env, col.id);
    return json({ success: true });
  }
  if (method === "PUT" && (m = path.match(R.colOrder))) {
    const col = await ownedCollection(env, m[1], userId);
    if (!col) return fail("Not found", 404);
    const ids = asIds((await readJson(request)).product_ids, 500);
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map((pid, k) => env.DB.prepare("UPDATE collection_items SET position = ? WHERE collection_id = ? AND product_id = ?").bind((i + k + 1) * 1024, col.id, pid)));
    }
    await data.recomputeCollection(env, col.id);
    return json({ success: true });
  }

  // ------------------------------ product media ------------------------------
  if (method === "GET" && (m = path.match(R.prodMedia))) {
    const prod = await ownedProduct(env, m[1], userId);
    if (!prod) return fail("Not found", 404);
    const { results: det } = await env.DB.prepare("SELECT kind, price_minor, currency, price_type FROM products WHERE id = ?").bind(prod.id).all();
    const images = await data.getProductImages(env, prod.id);
    const { results: cols } = await env.DB.prepare("SELECT collection_id FROM collection_items WHERE product_id = ?").bind(prod.id).all();
    return json({ images, video: prod.video_id ? { id: prod.video_id, status: prod.video_status } : null, collections: cols.map((c) => c.collection_id), fields: det[0] || {} });
  }

  if (method === "POST" && (m = path.match(R.prodImages))) {
    const prod = await ownedProduct(env, m[1], userId);
    if (!prod) return fail("Not found", 404);
    const body = await readJson(request);
    try { const io = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'image_origin'").all(); if (io.results.length) data.allowImageHost(new URL(io.results[0].value).hostname); } catch (e) {}
    const img = data.parseOwnProductImage(body.url, userId, new URL(request.url).hostname);
    if (!img) return fail("That image can't be used. Please upload it again.");
    const { limits } = await getProfileLimits(env, { tier_id: prod.p_tier, max_products: prod.p_max });
    const { results: cnt } = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS mx FROM product_images WHERE product_id = ?").bind(prod.id).all();
    if (!hasRoom(cnt[0].n, limits.max_images_per_product)) return fail(`Your plan allows ${limits.max_images_per_product} photo${limits.max_images_per_product === 1 ? "" : "s"} per item. Upgrade to add more.`, 403);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO product_images (id, product_id, url, position, width, height, color) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, prod.id, img.url, cnt[0].mx + 1, data.cleanDim(body.w), data.cleanDim(body.h), data.cleanColor(body.color)).run();
    await data.syncProductCover(env, prod.id);
    return json({ success: true, id });
  }

  if (method === "DELETE" && (m = path.match(R.prodImage))) {
    const prod = await ownedProduct(env, m[1], userId);
    if (!prod) return fail("Not found", 404);
    const { results } = await env.DB.prepare("SELECT id, url FROM product_images WHERE id = ? AND product_id = ?").bind(m[2], prod.id).all();
    if (!results.length) return fail("Not found", 404);
    await env.DB.prepare("DELETE FROM product_images WHERE id = ?").bind(results[0].id).run();
    await data.syncProductCover(env, prod.id);
    // Remove the file too, but only if it is THIS user's file and nothing else still points at it.
    const own = data.parseOwnProductImage(results[0].url, userId, new URL(request.url).hostname);
    if (own) {
      const { results: still } = await env.DB.prepare("SELECT 1 FROM product_images WHERE url = ? LIMIT 1").bind(results[0].url).all();
      if (!still.length) ctx.waitUntil(env.ASSETS.delete(own.key));
    }
    return json({ success: true });
  }

  if (method === "PUT" && (m = path.match(R.prodImgOrder))) {
    const prod = await ownedProduct(env, m[1], userId);
    if (!prod) return fail("Not found", 404);
    const ids = asIds((await readJson(request)).image_ids, 30);
    await env.DB.batch(ids.map((id, i) => env.DB.prepare("UPDATE product_images SET position = ? WHERE id = ? AND product_id = ?").bind(i, id, prod.id)));
    await data.syncProductCover(env, prod.id);
    return json({ success: true });
  }

  if (method === "PUT" && (m = path.match(R.prodVideo))) {
    const prod = await ownedProduct(env, m[1], userId);
    if (!prod) return fail("Not found", 404);
    const raw = String((await readJson(request)).video_url || "").trim();
    if (!raw) {
      await env.DB.prepare("UPDATE products SET video_id = NULL, video_status = 'none', video_checked_at = NULL WHERE id = ?").bind(prod.id).run();
      return json({ success: true, video: null });
    }
    const { limits } = await getProfileLimits(env, { tier_id: prod.p_tier, max_products: prod.p_max });
    if (!limits.video_allowed) return fail("Video is available on paid plans. Upgrade to add one.", 403);
    const vid = extractYouTubeId(raw);
    if (!vid) return fail("Please paste a YouTube link (for example https://youtu.be/...).");
    const check = await checkYouTube(vid);
    if (check.status === "broken") return fail("YouTube says this video is private, removed, or not allowed to be embedded. Please choose another.");
    await env.DB.prepare("UPDATE products SET video_id = ?, video_status = ?, video_checked_at = datetime('now') WHERE id = ?").bind(vid, check.status === "ok" ? "ok" : "unknown", prod.id).run();
    return json({ success: true, video: { id: vid, status: check.status } });
  }

  return null;
}

/** Called from the nightly cron (index.js scheduled()). */
export async function runShopMaintenance(env) {
  try { await refreshFxRates(env); } catch (e) { console.error("FX refresh failed (non-fatal):", e); }
  try { await runVideoChecks(env, 25); } catch (e) { console.error("Video checks failed (non-fatal):", e); }
}
