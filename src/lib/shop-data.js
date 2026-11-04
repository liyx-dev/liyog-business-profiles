// =====================================================================
// BIZIPLEX — src/lib/shop-data.js
// The data layer for catalogue, collections and product media.
// Rules every query here follows:
//   * always scoped by an indexed profile_id / collection_id
//   * always parameterised (no string-built SQL from user input)
//   * one JOIN instead of one query per product
//   * visitors only ever get live, non-draft, active rows
// =====================================================================

export const ALLOWED_IMAGE_HOSTS = new Set(["biziplex.com", "www.biziplex.com", "liyogworld.com.ng", "www.liyogworld.com.ng"]);
/** The site's configured image origin (app_settings.image_origin) is trusted too. */
export function allowImageHost(h) { if (h) ALLOWED_IMAGE_HOSTS.add(h); }

const CARD_COLS = `p.id, p.slug, p.name, p.kind, substr(p.description, 1, 160) AS description,
  p.price_minor, p.currency, p.price_type, p.price_display, p.image_url, p.img_w, p.img_h, p.img_color,
  p.video_id, p.video_status, p.view_count, p.created_at,
  COALESCE(s.average_rating, 0) AS avg_rating, COALESCE(s.rating_count, 0) AS rating_count, COALESCE(s.like_count, 0) AS like_count,
  EXISTS(SELECT 1 FROM boost_log b WHERE b.product_id = p.id AND b.scope = 'product' AND b.expires_at > datetime('now')) AS featured`;

export function slugify(text, max = 50) {
  return String(text || "").toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, max);
}

export function buildSearchText(name, description) {
  return `${name || ""} ${String(description || "").slice(0, 200)}`.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
}

/** An image URL is only accepted if it is OUR host AND sits in THIS user's products/ folder. Returns { url, key } or null. */
export function parseOwnProductImage(urlStr, userId, requestHost) {
  try {
    const u = new URL(String(urlStr));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!ALLOWED_IMAGE_HOSTS.has(u.hostname) && u.hostname !== requestHost) return null;
    const m = u.pathname.match(/^\/api\/image\/(products\/([^/]+)\/[a-z0-9-]+\.webp)$/);
    if (!m || m[2] !== userId) return null;
    return { url: u.toString(), key: m[1] };
  } catch (e) { return null; }
}

export function cleanColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || "") ? String(c).toLowerCase() : null; }
export function cleanDim(n) { const v = Math.trunc(Number(n)); return v >= 1 && v <= 8000 ? v : null; }

export async function getPublicProfile(env, profileId) {
  const { results } = await env.DB.prepare(
    `SELECT id, owner_id, slug, business_name, business_category, tagline, logo_url, cover_url, whatsapp_number, phone_number,
            default_currency, store_city, store_country, response_time, youtube_url, tier_id, max_products
     FROM profiles WHERE id = ? AND is_active = 1 AND moderation_status = 'approved'`
  ).bind(profileId).all();
  return results.length ? results[0] : null;
}

export async function getPublicProfileBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT id, owner_id, slug, business_name, business_category, tagline, logo_url, cover_url, whatsapp_number, phone_number,
            default_currency, store_city, store_country, response_time, tier_id, max_products
     FROM profiles WHERE slug = ? AND is_active = 1 AND moderation_status = 'approved'`
  ).bind(String(slug || "").toLowerCase()).all();
  return results.length ? results[0] : null;
}

// ---------------- Collections ----------------

export async function listCollections(env, profileId, { surface = "catalogue", mine = false } = {}) {
  const where = mine
    ? "profile_id = ?"
    : `profile_id = ? AND status = 'live' AND item_count > 0 ${surface === "profile" ? "AND show_on_profile = 1" : ""}`;
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, description, status, reach, show_on_profile, position, item_count, cover_url, cover_color
     FROM collections WHERE ${where} ORDER BY position ASC, created_at ASC LIMIT 100`
  ).bind(profileId).all();
  return results;
}

/** First N cards of several collections in ONE query (window function). */
export async function getCollectionPreviews(env, collectionIds, perCollection = 10) {
  if (!collectionIds.length) return {};
  const ph = collectionIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT ci.collection_id AS collection_id, ${CARD_COLS},
              ROW_NUMBER() OVER (PARTITION BY ci.collection_id ORDER BY ci.position ASC, p.id ASC) AS rn
       FROM collection_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN product_stats s ON s.product_id = p.id
       WHERE ci.collection_id IN (${ph}) AND p.is_active = 1 AND p.is_draft = 0
     ) WHERE rn <= ?`
  ).bind(...collectionIds, perCollection).all();
  const out = {};
  for (const r of results) (out[r.collection_id] = out[r.collection_id] || []).push(r);
  return out;
}

export async function getCollectionBySlug(env, profileId, slug) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, title, description, status, reach, item_count FROM collections WHERE profile_id = ? AND slug = ? AND status = 'live'"
  ).bind(profileId, slug).all();
  return results.length ? results[0] : null;
}

/** Which collection should "More from this collection" use for a product page? */
export async function getCollectionForProduct(env, productId, profileId, preferSlug) {
  if (preferSlug) {
    const c = await getCollectionBySlug(env, profileId, preferSlug);
    if (c) return c;
  }
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.slug, c.title FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
     WHERE ci.product_id = ? AND c.status = 'live' AND c.profile_id = ? ORDER BY c.position ASC LIMIT 1`
  ).bind(productId, profileId).all();
  return results.length ? results[0] : null;
}

export async function getCollectionItems(env, collectionId, { offset = 0, limit = 12, excludeProductId = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT ${CARD_COLS}
     FROM collection_items ci JOIN products p ON p.id = ci.product_id LEFT JOIN product_stats s ON s.product_id = p.id
     WHERE ci.collection_id = ? AND p.is_active = 1 AND p.is_draft = 0 AND p.id != ?
     ORDER BY ci.position ASC, p.id ASC LIMIT ? OFFSET ?`
  ).bind(collectionId, excludeProductId || "", limit + 1, offset).all();
  return { rows: results.slice(0, limit), hasMore: results.length > limit };
}

export async function recomputeCollection(env, collectionId) {
  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM collection_items ci JOIN products p ON p.id = ci.product_id
     WHERE ci.collection_id = ? AND p.is_active = 1 AND p.is_draft = 0`
  ).bind(collectionId).all();
  const { results: first } = await env.DB.prepare(
    `SELECT p.image_url, p.img_color FROM collection_items ci JOIN products p ON p.id = ci.product_id
     WHERE ci.collection_id = ? AND p.is_active = 1 AND p.is_draft = 0 ORDER BY ci.position ASC LIMIT 1`
  ).bind(collectionId).all();
  await env.DB.prepare(
    "UPDATE collections SET item_count = ?, cover_url = ?, cover_color = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(cnt[0].n, first.length ? first[0].image_url : null, first.length ? first[0].img_color : null, collectionId).run();
}

export async function recomputeCollectionsForProduct(env, productId) {
  const { results } = await env.DB.prepare("SELECT DISTINCT collection_id FROM collection_items WHERE product_id = ?").bind(productId).all();
  for (const r of results) await recomputeCollection(env, r.collection_id);
}

// ---------------- Catalogue (search + filters + pages) ----------------

const SORTS = {
  newest: "p.created_at DESC, p.id DESC",
  views: "p.view_count DESC, p.id ASC",
  rating: "COALESCE(s.average_rating,0) DESC, COALESCE(s.rating_count,0) DESC, p.id ASC",
  likes: "COALESCE(s.like_count,0) DESC, p.id ASC",
  price_asc: "(p.price_minor IS NULL) ASC, p.price_minor ASC, p.id ASC",
  price_desc: "(p.price_minor IS NULL) ASC, p.price_minor DESC, p.id ASC"
};
export const SORT_KEYS = Object.keys(SORTS);

function likeEscape(s) { return s.replace(/[\\%_]/g, (c) => "\\" + c); }

export async function queryCatalogue(env, profileId, { collectionSlug = "", q = "", sort = "", kind = "", offset = 0, limit = 24, withTotal = false } = {}) {
  limit = Math.min(Math.max(Number(limit) || 24, 1), 48);
  offset = Math.min(Math.max(Number(offset) || 0, 0), 10000);

  let collection = null;
  if (collectionSlug) {
    collection = await getCollectionBySlug(env, profileId, collectionSlug);
    if (!collection) return { rows: [], hasMore: false, total: 0, collection: null };
  }
  const joins = collection ? "JOIN collection_items ci ON ci.product_id = p.id AND ci.collection_id = ?" : "";
  const where = ["p.profile_id = ?", "p.is_active = 1", "p.is_draft = 0"];
  const binds = [];
  if (collection) binds.push(collection.id);
  binds.push(profileId);
  if (kind === "product" || kind === "service") { where.push("p.kind = ?"); binds.push(kind); }
  const tokens = String(q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80).split(" ").filter(Boolean).slice(0, 4);
  for (const t of tokens) { where.push("p.search_text LIKE ? ESCAPE '\\'"); binds.push(`%${likeEscape(t)}%`); }

  const order = collection && !sort ? "ci.position ASC, p.id ASC" : (SORTS[sort] || SORTS.newest);
  const { results } = await env.DB.prepare(
    `SELECT ${CARD_COLS} FROM products p LEFT JOIN product_stats s ON s.product_id = p.id ${joins}
     WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...binds, limit + 1, offset).all();

  let total = null;
  if (withTotal) {
    const { results: c } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products p ${joins} WHERE ${where.join(" AND ")}`).bind(...binds).all();
    total = c[0].n;
  }
  return { rows: results.slice(0, limit), hasMore: results.length > limit, total, collection };
}

/** Light list for instant, no-database-per-keystroke search suggestions. */
export async function getSearchIndex(env, profileId, cap = 3000) {
  const { results } = await env.DB.prepare(
    "SELECT slug, id, name, kind FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 ORDER BY created_at DESC LIMIT ?"
  ).bind(profileId, cap + 1).all();
  const truncated = results.length > cap;
  return { truncated, items: results.slice(0, cap).map((r) => [r.slug || r.id, r.name, r.kind === "service" ? "s" : "p"]) };
}

export async function getProductImages(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT id, url, width, height, color FROM product_images WHERE product_id = ? ORDER BY position ASC, created_at ASC"
  ).bind(productId).all();
  return results;
}

export async function syncProductCover(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT url, width, height, color FROM product_images WHERE product_id = ? ORDER BY position ASC, created_at ASC LIMIT 1"
  ).bind(productId).all();
  const f = results[0];
  await env.DB.prepare(
    "UPDATE products SET image_url = ?, img_w = ?, img_h = ?, img_color = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(f ? f.url : null, f ? f.width : null, f ? f.height : null, f ? f.color : null, productId).run();
  await recomputeCollectionsForProduct(env, productId);
}
