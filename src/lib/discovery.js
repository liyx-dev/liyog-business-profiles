// =====================================================================
// LIYOG WORLD — src/lib/discovery.js   (3b-1 targeted serving + 3b-2 contact buttons + 3b-3 page context)
// Assembles what actually gets DISPLAYED for boosted items: joins the
// fair-rotation selections from boost.js with real profile/product data,
// and gracefully fills any remaining slots with regular (non-boosted)
// items so a strip never looks sparse or broken.
//
// 3b-1 CHANGES (everything else is as before):
//  - Viewer country is decided HERE, on the server, never by the browser:
//      registered viewer -> country on their own brand profile,
//      else / empty      -> Cloudflare's geo-detection of the request.
//  - The page's category arrives as ?category=<slug> (validated).
//  - When the switch app_settings.boost_targeting_enabled = '1', boosts
//    are chosen by the targeted engine in boost.js. If that switch is
//    off — or the engine ever throws — the original selector is used,
//    so a bug here can never blank out a strip.
//  - Fillers prefer the page's category when one is known.
//  3b-2: boosts whose advertiser switched "Contact buttons" ON now carry a
//    small `cta` object ({ wa, tel }) so the sponsored card can show WApp /
//    Call buttons. Numbers are sanitised HERE (digits only, sane length),
//    only ever attached to boosts that opted in, and never to filler items.
//    If this lookup fails for any reason the strip simply renders without
//    buttons — it can never break the strip.
//  3b-3: pages that cannot name their category (blog posts, homepage,
//    feed) may send ?ctx=<short text read from the page> instead. When no
//    explicit, valid ?category= is given, lib/context.js works out which
//    category that text is about — only if the evidence is clear — and
//    the result feeds the same ranking as an explicit category. An
//    explicit category ALWAYS wins. Runs only while the targeting switch
//    is on; any failure simply means "no category" (country-only).
//  - Admin-only testing: send header x-admin-secret and
//      ?debug=1            -> adds a _debug block explaining the ranking
//                             (never counts impressions)
//      &force=1            -> run the targeted engine even if switched off
//      &country=NG|NONE    -> pretend to be a viewer from that country
// =====================================================================

import {
  selectBoostedItems, selectBoostedItemsSmart, explainSmartSelection,
  isTargetingEnabled, sanitizePageCategory, resolveProfileCountry, COUNTRY_NAMES
} from "./boost.js";
import { verifySessionToken } from "./auth.js";
import { inferCategoryFromContext } from "./context.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    // Results now vary per viewer (country / category) — never let a
    // shared cache hand one viewer's strip to another.
    headers: { "content-type": "application/json", "cache-control": "private, no-store" }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------
// Serving context — who is looking, and at what kind of page.
// ---------------------------------------------------------------------

async function detectViewerCountry(request, env) {
  // 1) Registered viewer: the country on their own brand profile.
  try {
    const token = getCookie(request, "liyog_session");
    if (token) {
      const userId = await verifySessionToken(env, token);
      if (userId) {
        const { results } = await env.DB.prepare(
          "SELECT store_country, map_address, store_address FROM profiles WHERE owner_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 5"
        ).bind(userId).all();
        for (const row of results) {
          const c = resolveProfileCountry(row);
          if (c) return { code: c.code, source: "viewer_profile" };
        }
      }
    }
  } catch (e) { /* fall through to geo-detection */ }

  // 2) Everyone else (and registered viewers with no country on file).
  const geo = request.cf && request.cf.country ? String(request.cf.country).toUpperCase() : null;
  if (geo && COUNTRY_NAMES[geo]) return { code: geo, source: "geo" };

  // 3) Unknown (VPN/Tor/odd network): only "All countries" boosts qualify.
  return { code: null, source: "unknown" };
}

async function getServingContext(request, env, url) {
  const adminOk = !!env.ADMIN_SECRET && request.headers.get("x-admin-secret") === env.ADMIN_SECRET;
  const debug = adminOk && url.searchParams.get("debug") === "1";
  const forced = adminOk && url.searchParams.get("force") === "1";

  let enabled = false;
  try { enabled = forced || await isTargetingEnabled(env); } catch (e) { enabled = false; }

  const serving = {
    useSmart: enabled, viewerCountry: null, countrySource: "off",
    pageCategory: null, dryRun: debug, debug, forced
  };
  if (!enabled) return serving;

  serving.pageCategory = sanitizePageCategory(url.searchParams.get("category"));
  serving.contextSource = serving.pageCategory ? "explicit" : "none";
  if (!serving.pageCategory) {
    const ctxText = url.searchParams.get("ctx");
    if (ctxText) {
      const inferred = await inferCategoryFromContext(env, ctxText);   // never throws
      if (inferred) {
        serving.pageCategory = inferred.slug;
        serving.contextSource = "inferred";
        serving.inference = inferred;
      } else {
        serving.contextSource = "context_unclear";
      }
    }
  }

  const override = adminOk ? (url.searchParams.get("country") || "").toUpperCase() : "";
  if (override) {
    serving.viewerCountry = COUNTRY_NAMES[override] ? override : null;
    serving.countrySource = "admin_override";
  } else {
    const v = await detectViewerCountry(request, env);
    serving.viewerCountry = v.code;
    serving.countrySource = v.source;
  }
  return serving;
}

/** Targeted engine when switched on; original selector otherwise — and
 *  as an automatic fallback if the targeted engine throws for any reason. */
async function pickBoosts(env, serving, { scope, excludeProfileId, limit }) {
  if (serving.useSmart) {
    try {
      const opts = {
        scope, excludeProfileId, limit,
        viewerCountry: serving.viewerCountry,
        pageCategory: serving.pageCategory,
        dryRun: serving.dryRun
      };
      if (serving.debug) {
        serving.explain = serving.explain || {};
        serving.explain[scope] = await explainSmartSelection(env, opts);
      }
      return await selectBoostedItemsSmart(env, opts);
    } catch (err) {
      console.error("Targeted boost selection failed — using legacy selector:", err);
      serving.fellBack = true;
    }
  }
  return selectBoostedItems(env, { scope, excludeProfileId, limit });
}

// ---------------------------------------------------------------------
// 3b-2 — contact buttons for boosts that opted in (show_cta = 1)
// ---------------------------------------------------------------------

function cleanWhatsappDigits(raw) {
  const digits = String(raw == null ? "" : raw).replace(/[^\d]/g, "");
  return /^\d{7,15}$/.test(digits) ? digits : null;
}
function cleanTel(raw) {
  const t = String(raw == null ? "" : raw).replace(/[^\d+]/g, "");
  return /^\+?\d{6,16}$/.test(t) ? t : null;
}

/**
 * Returns { [key]: { wa, tel } } for the picked boosts that opted in.
 * keyField is "product_id" (products strip) or "profile_id" (profiles /
 * catalogues). Never throws — on any problem it returns what it has.
 */
async function buildCtaMap(env, boosted, keyField) {
  const map = {};
  try {
    if (!boosted || !boosted.length) return map;

    let rows = boosted;
    // The original selector doesn't carry show_cta — look it up by boost id.
    if (boosted.some((b) => b.show_cta === undefined)) {
      const ids = boosted.map((b) => b.id);
      const { results } = await env.DB.prepare(
        `SELECT id, show_cta FROM boost_log WHERE id IN (${ids.map(() => "?").join(",")})`
      ).bind(...ids).all();
      const byId = {};
      results.forEach((r) => { byId[r.id] = r.show_cta; });
      rows = boosted.map((b) => ({ ...b, show_cta: b.show_cta !== undefined ? b.show_cta : byId[b.id] }));
    }

    const wanted = rows.filter((r) => Number(r.show_cta) === 1);
    if (!wanted.length) return map;

    const profileIds = [...new Set(wanted.map((r) => r.profile_id))];
    const { results: profs } = await env.DB.prepare(
      `SELECT id, whatsapp_number, phone_number FROM profiles WHERE id IN (${profileIds.map(() => "?").join(",")})`
    ).bind(...profileIds).all();

    const ctaByProfile = {};
    profs.forEach((p) => {
      const wa = cleanWhatsappDigits(p.whatsapp_number);
      const tel = cleanTel(p.phone_number);
      if (wa || tel) ctaByProfile[p.id] = { wa, tel };
    });

    wanted.forEach((r) => {
      const cta = ctaByProfile[r.profile_id];
      const key = r[keyField];
      if (cta && key) map[key] = cta;
    });
  } catch (err) {
    console.error("CTA lookup failed — serving strip without contact buttons:", err);
  }
  return map;
}

function withDebug(payload, serving) {
  if (!serving.debug) return payload;
  return {
    ...payload,
    _debug: {
      engine: serving.useSmart && !serving.fellBack ? "targeted" : "legacy",
      forced: serving.forced, fellBack: !!serving.fellBack,
      viewerCountry: serving.viewerCountry, countrySource: serving.countrySource,
      pageCategory: serving.pageCategory, contextSource: serving.contextSource || null,
      inference: serving.inference || null, ranking: serving.explain || null
    }
  };
}

/**
 * Sponsored BRAND PROFILES strip — for the "You Might Also Like"
 * section shown on a profile page, or the Brands tab of Discover.
 * excludeProfileId keeps a profile from ever seeing itself sponsored
 * on its own page.
 */
export async function handleSponsoredProfiles(request, env, servingOverride = null) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 4));
  const serving = servingOverride || await getServingContext(request, env, url);

  const boosted = await pickBoosts(env, serving, { scope: "profile", excludeProfileId, limit });
  const boostedProfiles = await hydrateProfiles(env, boosted.map((b) => b.profile_id));

  const ctaMap = await buildCtaMap(env, boosted, "profile_id");
  let combined = boostedProfiles.map((p) => ({ ...p, isSponsored: true, ...(ctaMap[p.id] ? { cta: ctaMap[p.id] } : {}) }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProfiles(env, {
      excludeIds: [...combined.map((p) => p.id), excludeProfileId].filter(Boolean),
      limit: limit - combined.length,
      pageCategory: serving.useSmart ? serving.pageCategory : null
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse(withDebug({ profiles: combined }, serving));
}

/**
 * Premium ad-suppression check — a SINGLE point of control for a
 * future feature: profiles on a paid "no ads on my catalogue/product
 * pages" plan should never have sponsored strips shown to THEIR
 * visitors, even though their own items can still be boosted and
 * shown to OTHER people elsewhere. This only matters for the two
 * handlers that render onto a specific profile's own pages
 * (products/catalogues) — the main profile-page "You Might Also
 * Like" strip is a platform-wide discovery feature, not scoped to
 * one profile's page, so it's deliberately NOT gated here.
 *
 * Currently always returns false (no suppression active) — nothing
 * downstream changes until this actually checks a real column/table.
 * When that feature is built, this is the ONLY function that needs
 * updating; both call sites already defer to it.
 */
async function isAdSuppressed(env, profileId) {
  if (!profileId) return false;
  // Placeholder for future premium-tier check, e.g.:
  //   const { results } = await env.DB.prepare(
  //     "SELECT ad_free FROM profiles WHERE id = ?"
  //   ).bind(profileId).all();
  //   return results.length && results[0].ad_free === 1;
  return false;
}

/**
 * Sponsored PRODUCTS strip — for a catalogue/product page, or the
 * Products tab of Discover. excludeProfileId excludes products
 * belonging to the profile currently being viewed (so a shop doesn't
 * see its own products labeled "sponsored" on its own catalogue page).
 */
export async function handleSponsoredProducts(request, env, servingOverride = null) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));

  if (await isAdSuppressed(env, excludeProfileId)) return jsonResponse({ products: [] });
  const serving = servingOverride || await getServingContext(request, env, url);

  const boosted = await pickBoosts(env, serving, { scope: "product", excludeProfileId, limit });
  const boostedProducts = await hydrateProducts(env, boosted.map((b) => b.product_id));

  const ctaMap = await buildCtaMap(env, boosted, "product_id");
  let combined = boostedProducts.map((p) => ({ ...p, isSponsored: true, ...(ctaMap[p.id] ? { cta: ctaMap[p.id] } : {}) }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProducts(env, {
      excludeIds: combined.map((p) => p.id),
      excludeProfileId,
      limit: limit - combined.length,
      pageCategory: serving.useSmart ? serving.pageCategory : null
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse(withDebug({ products: combined }, serving));
}

/**
 * Sponsored CATALOGUES strip — "check out this shop's full catalogue"
 * cards, distinct from individual product cards. Same profile data as
 * handleSponsoredProfiles but framed for catalogue browsing.
 */
export async function handleSponsoredCatalogues(request, env, servingOverride = null) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 4));

  if (await isAdSuppressed(env, excludeProfileId)) return jsonResponse({ catalogues: [] });
  const serving = servingOverride || await getServingContext(request, env, url);

  const boosted = await pickBoosts(env, serving, { scope: "catalogue", excludeProfileId, limit });
  const boostedProfiles = await hydrateProfiles(env, boosted.map((b) => b.profile_id));

  const ctaMap = await buildCtaMap(env, boosted, "profile_id");
  let combined = boostedProfiles.map((p) => ({ ...p, isSponsored: true, ...(ctaMap[p.id] ? { cta: ctaMap[p.id] } : {}) }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProfiles(env, {
      excludeIds: [...combined.map((p) => p.id), excludeProfileId].filter(Boolean),
      limit: limit - combined.length,
      requireProducts: true, // catalogue filler should have actual products to show
      pageCategory: serving.useSmart ? serving.pageCategory : null
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse(withDebug({ catalogues: combined }, serving));
}

// ---------------------------------------------------------------------
// Hydration — turns raw boost_log rows into real, renderable data.
// ---------------------------------------------------------------------

async function hydrateProfiles(env, profileIds) {
  if (!profileIds.length) return [];
  const placeholders = profileIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, slug, business_name, business_category, tagline, logo_url, cover_url
     FROM profiles
     WHERE id IN (${placeholders}) AND moderation_status = 'approved' AND is_active = 1`
  ).bind(...profileIds).all();

  // Preserve the fair-rotation order the selector already decided — the
  // SQL IN() clause does NOT guarantee row order.
  const byId = {};
  results.forEach((r) => { byId[r.id] = r; });
  return profileIds.map((id) => byId[id]).filter(Boolean);
}

async function hydrateProducts(env, productIds) {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT pr.id, pr.profile_id, pr.name, pr.price_display, pr.image_url, pr.slug, pr.description, pr.view_count,
            p.slug AS profile_slug, p.business_name AS profile_business_name, p.logo_url AS profile_logo_url
     FROM products pr
     JOIN profiles p ON p.id = pr.profile_id
     WHERE pr.id IN (${placeholders}) AND pr.is_active = 1 AND pr.is_draft = 0
       AND p.moderation_status = 'approved' AND p.is_active = 1`
  ).bind(...productIds).all();

  const byId = {};
  results.forEach((r) => { byId[r.id] = r; });
  return productIds.map((id) => byId[id]).filter(Boolean);
}

// ---------------------------------------------------------------------
// Graceful fill — when there aren't enough active boosts to fill a
// strip, top it up with regular (non-boosted, non-sponsored) items so
// the section never looks sparse or broken. Random sample, with the
// page's category first when one is known (3b-1).
// ---------------------------------------------------------------------

async function fillWithRegularProfiles(env, { excludeIds, limit, requireProducts = false, pageCategory = null }) {
  if (limit <= 0) return [];
  const excludeClause = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
  const productsJoinClause = requireProducts
    ? "AND EXISTS (SELECT 1 FROM products pr WHERE pr.profile_id = profiles.id AND pr.is_active = 1)"
    : "";
  const orderBy = pageCategory
    ? "ORDER BY CASE WHEN business_category = ? THEN 0 ELSE 1 END, RANDOM()"
    : "ORDER BY RANDOM()";

  const binds = [...excludeIds];
  if (pageCategory) binds.push(pageCategory);
  binds.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT id, slug, business_name, business_category, tagline, logo_url, cover_url
     FROM profiles
     WHERE moderation_status = 'approved' AND is_active = 1 ${excludeClause} ${productsJoinClause}
     ${orderBy}
     LIMIT ?`
  ).bind(...binds).all();

  return results;
}

async function fillWithRegularProducts(env, { excludeIds, excludeProfileId, limit, pageCategory = null }) {
  if (limit <= 0) return [];
  const excludeClause = excludeIds.length ? `AND pr.id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
  const excludeProfileClause = excludeProfileId ? "AND pr.profile_id != ?" : "";
  const orderBy = pageCategory
    ? "ORDER BY CASE WHEN p.business_category = ? THEN 0 ELSE 1 END, RANDOM()"
    : "ORDER BY RANDOM()";

  const binds = [...excludeIds];
  if (excludeProfileId) binds.push(excludeProfileId);
  if (pageCategory) binds.push(pageCategory);
  binds.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT pr.id, pr.profile_id, pr.name, pr.price_display, pr.image_url, pr.slug, pr.description, pr.view_count,
            p.slug AS profile_slug, p.business_name AS profile_business_name, p.logo_url AS profile_logo_url
     FROM products pr
     JOIN profiles p ON p.id = pr.profile_id
     WHERE pr.is_active = 1 AND pr.is_draft = 0 ${excludeClause} ${excludeProfileClause}
       AND p.moderation_status = 'approved' AND p.is_active = 1
     ${orderBy}
     LIMIT ?`
  ).bind(...binds).all();

  return results;
}

/**
 * GET /api/discover — powers the full Discover page. Returns a batch
 * of sponsored profiles, catalogues, and products in one call. The
 * serving context (viewer country, category) is worked out ONCE from
 * the real request and shared with the three inner calls.
 */
export async function handleDiscoverPage(request, env) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const search = url.searchParams.get("q");
  const serving = await getServingContext(request, env, url);

  const [profilesRes, cataloguesRes, productsRes] = await Promise.all([
    handleSponsoredProfiles(new Request(`${url.origin}/api/discover/profiles?limit=12`), env, serving),
    handleSponsoredCatalogues(new Request(`${url.origin}/api/discover/catalogues?limit=12`), env, serving),
    handleSponsoredProducts(new Request(`${url.origin}/api/discover/products?limit=24`), env, serving)
  ]);

  const [profilesData, cataloguesData, productsData] = await Promise.all([
    profilesRes.json(), cataloguesRes.json(), productsRes.json()
  ]);

  let profiles = profilesData.profiles || [];
  let catalogues = cataloguesData.catalogues || [];
  let products = productsData.products || [];

  if (category) {
    profiles = profiles.filter((p) => p.business_category === category);
    catalogues = catalogues.filter((p) => p.business_category === category);
  }
  if (search) {
    const q = search.toLowerCase();
    profiles = profiles.filter((p) => p.business_name.toLowerCase().includes(q));
    catalogues = catalogues.filter((p) => p.business_name.toLowerCase().includes(q));
    products = products.filter((p) => p.name.toLowerCase().includes(q));
  }

  return jsonResponse({ profiles, catalogues, products });
}
