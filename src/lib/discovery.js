// =====================================================================
// LIYOG WORLD — src/lib/discovery.js
// Assembles what actually gets DISPLAYED for boosted items: joins the
// fair-rotation selections from boost.js's selectBoostedItems with
// real profile/product data, and gracefully fills any remaining slots
// with regular (non-boosted) items so a strip never looks sparse or
// broken while boost adoption is still growing.
//
// This is deliberately a separate file from boost.js — boost.js owns
// the fairness/rotation MECHANISM (domain-agnostic, works on raw
// boost_log rows), this file owns turning that into something a page
// can actually render (profile cards, product cards).
// =====================================================================

import { selectBoostedItems } from "./boost.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Sponsored BRAND PROFILES strip — for the "You Might Also Like"
 * section shown on a profile page, or the Brands tab of Discover.
 * excludeProfileId keeps a profile from ever seeing itself sponsored
 * on its own page.
 */
export async function handleSponsoredProfiles(request, env) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 4));

  const boosted = await selectBoostedItems(env, { scope: "profile", excludeProfileId, limit });
  const boostedProfiles = await hydrateProfiles(env, boosted.map((b) => b.profile_id));

  let combined = boostedProfiles.map((p) => ({ ...p, isSponsored: true }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProfiles(env, {
      excludeIds: [...combined.map((p) => p.id), excludeProfileId].filter(Boolean),
      limit: limit - combined.length
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse({ profiles: combined });
}

/**
 * Sponsored PRODUCTS strip — for a catalogue/product page, or the
 * Products tab of Discover. excludeProfileId excludes products
 * belonging to the profile currently being viewed (so a shop doesn't
 * see its own products labeled "sponsored" on its own catalogue page).
 */
export async function handleSponsoredProducts(request, env) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));

  const boosted = await selectBoostedItems(env, { scope: "product", excludeProfileId, limit });
  const boostedProducts = await hydrateProducts(env, boosted.map((b) => b.product_id));

  let combined = boostedProducts.map((p) => ({ ...p, isSponsored: true }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProducts(env, {
      excludeIds: combined.map((p) => p.id),
      excludeProfileId,
      limit: limit - combined.length
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse({ products: combined });
}

/**
 * Sponsored CATALOGUES strip — "check out this shop's full catalogue"
 * cards, distinct from individual product cards. Same profile data as
 * handleSponsoredProfiles but framed for catalogue browsing (Discover
 * page's "Catalogues" tab links to /b/{slug}#products, not the bare
 * profile).
 */
export async function handleSponsoredCatalogues(request, env) {
  const url = new URL(request.url);
  const excludeProfileId = url.searchParams.get("exclude");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 4));

  const boosted = await selectBoostedItems(env, { scope: "catalogue", excludeProfileId, limit });
  const boostedProfiles = await hydrateProfiles(env, boosted.map((b) => b.profile_id));

  let combined = boostedProfiles.map((p) => ({ ...p, isSponsored: true }));

  if (combined.length < limit) {
    const filler = await fillWithRegularProfiles(env, {
      excludeIds: [...combined.map((p) => p.id), excludeProfileId].filter(Boolean),
      limit: limit - combined.length,
      requireProducts: true // catalogue filler should have actual products to show, unlike a plain profile filler
    });
    combined = combined.concat(filler.map((p) => ({ ...p, isSponsored: false })));
  }

  return jsonResponse({ catalogues: combined });
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

  // Preserve the fair-rotation order selectBoostedItems already
  // decided — the SQL IN() clause does NOT guarantee row order, so
  // without this re-sort the fairness work upstream would be silently
  // discarded by however SQLite happens to return matching rows.
  const byId = {};
  results.forEach((r) => { byId[r.id] = r; });
  return profileIds.map((id) => byId[id]).filter(Boolean);
}

async function hydrateProducts(env, productIds) {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, profile_id, name, price_display, image_url, slug
     FROM products
     WHERE id IN (${placeholders}) AND is_active = 1 AND is_draft = 0`
  ).bind(...productIds).all();

  const byId = {};
  results.forEach((r) => { byId[r.id] = r; });
  return productIds.map((id) => byId[id]).filter(Boolean);
}

// ---------------------------------------------------------------------
// Graceful fill — when there aren't enough active boosts to fill a
// strip, top it up with regular (non-boosted, non-sponsored) items so
// the section never looks sparse or broken, especially while boost
// adoption is still growing. Random sample, not "oldest" or "newest"
// first, so the fill doesn't quietly become its own unpaid ad slot for
// whoever happens to rank first by some other criterion.
// ---------------------------------------------------------------------

async function fillWithRegularProfiles(env, { excludeIds, limit, requireProducts = false }) {
  if (limit <= 0) return [];
  const excludeClause = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
  const productsJoinClause = requireProducts
    ? "AND EXISTS (SELECT 1 FROM products pr WHERE pr.profile_id = profiles.id AND pr.is_active = 1)"
    : "";

  const { results } = await env.DB.prepare(
    `SELECT id, slug, business_name, business_category, tagline, logo_url, cover_url
     FROM profiles
     WHERE moderation_status = 'approved' AND is_active = 1 ${excludeClause} ${productsJoinClause}
     ORDER BY RANDOM()
     LIMIT ?`
  ).bind(...excludeIds, limit).all();

  return results;
}

async function fillWithRegularProducts(env, { excludeIds, excludeProfileId, limit }) {
  if (limit <= 0) return [];
  const excludeClause = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
  const excludeProfileClause = excludeProfileId ? "AND profile_id != ?" : "";

  const binds = [...excludeIds];
  if (excludeProfileId) binds.push(excludeProfileId);
  binds.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT id, profile_id, name, price_display, image_url, slug
     FROM products
     WHERE is_active = 1 AND is_draft = 0 ${excludeClause} ${excludeProfileClause}
     ORDER BY RANDOM()
     LIMIT ?`
  ).bind(...binds).all();

  return results;
}

/**
 * GET /api/discover — powers the full Discover page. Returns a batch
 * of sponsored profiles, catalogues, and products in one call so the
 * page loads its three sections together rather than firing three
 * separate requests on mount. Search/filter (by category, keyword)
 * happens client-side against a fuller fetched set for now — fine at
 * current scale; if the catalog grows large enough that this becomes
 * slow, this is the endpoint to add real server-side search to later.
 */
export async function handleDiscoverPage(request, env) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const search = url.searchParams.get("q");

  const [profilesRes, cataloguesRes, productsRes] = await Promise.all([
    handleSponsoredProfiles(new Request(`${url.origin}/api/discover/profiles?limit=12`), env),
    handleSponsoredCatalogues(new Request(`${url.origin}/api/discover/catalogues?limit=12`), env),
    handleSponsoredProducts(new Request(`${url.origin}/api/discover/products?limit=24`), env)
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

