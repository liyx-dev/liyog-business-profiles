// =====================================================================
// BIZIPLEX — src/lib/products.js  (v2)
// Product create / edit / delete / list / image upload.
//   * Money is stored as integer minor units + ISO currency (price_minor, currency)
//     and price_display is still written for older screens.
//   * Every limit (products, drafts) comes from lib/plans.js, never hard-coded.
//   * Image URLs are only accepted if they are OUR host and THIS user's folder.
//   * Old clients that still send price_display / image_url keep working.
// =====================================================================
import { checkText, checkImage, getReadableRejectionMessage } from "./moderation.js";
import { getProfileLimits, hasRoom } from "./plans.js";
import {
  majorToMinor, formatMoney, normalizeCurrency, parseLegacyPriceDisplay, currencyFromCountryName
} from "./money.js";
import {
  buildSearchText, parseOwnProductImage, allowImageHost, cleanColor, cleanDim, recomputeCollectionsForProduct
} from "./shop-data.js";

const MAX_DRAFTS = 10;

class ClientError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function getImageOrigin(env, fallback) {
  try {
    const { results } = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'image_origin'").all();
    return results.length && results[0].value ? results[0].value : fallback;
  } catch (e) { return fallback; }
}

function defaultCurrencyFor(profile) {
  return normalizeCurrency(profile.default_currency) || currencyFromCountryName(profile.store_country) || "NGN";
}

/** Returns the price columns to write, or null when the request says nothing about price. */
function resolvePrice(body, profile) {
  const cur = normalizeCurrency(body.currency) || defaultCurrencyFor(profile);
  if (body.price !== undefined || body.price_type !== undefined) {
    const type = ["fixed", "from", "contact"].includes(body.price_type) ? body.price_type : "fixed";
    const empty = body.price === "" || body.price == null;
    if (type === "contact" || empty) return { price_minor: null, currency: cur, price_type: "contact", price_display: null, price_source: "entered" };
    const minor = majorToMinor(body.price, cur);
    if (minor === null) throw new ClientError("Please enter a valid price, for example 15000 or 15000.50");
    return { price_minor: minor, currency: cur, price_type: type, price_display: (type === "from" ? "From " : "") + formatMoney(minor, cur), price_source: "entered" };
  }
  if (body.price_display !== undefined) {
    const text = String(body.price_display || "").trim().slice(0, 40);
    if (!text) return { price_minor: null, currency: cur, price_type: "contact", price_display: null, price_source: "entered" };
    const p = parseLegacyPriceDisplay(text, cur);
    return { price_minor: p.price_minor, currency: p.currency, price_type: p.price_type, price_display: text, price_source: p.price_source };
  }
  return null;
}

async function countProducts(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN is_draft = 0 THEN 1 ELSE 0 END), 0) AS real, COALESCE(SUM(CASE WHEN is_draft = 1 THEN 1 ELSE 0 END), 0) AS drafts FROM products WHERE profile_id = ? AND is_active = 1"
  ).bind(profileId).all();
  return results[0];
}

export async function handleCreateProduct(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const { profile_id, name, description, image_url } = body;
  const creatingDraft = !!body.is_draft;
  const host = new URL(request.url).hostname;

  if (!profile_id) return jsonResponse({ error: "Missing profile." }, 400);
  if (creatingDraft && !image_url) return jsonResponse({ error: "An image is required to start a draft." }, 400);
  if (!creatingDraft && !name) return jsonResponse({ error: "Please provide at least a name." }, 400);

  const { results: profileRows } = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const profile = profileRows[0];
  if (profile.owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);

  try {
    const { limits } = await getProfileLimits(env, profile);
    if (limits.max_products === 0) return jsonResponse({ error: "Your plan doesn't include listings yet. Please upgrade." }, 403);
    const counts = await countProducts(env, profile_id);
    if (creatingDraft && counts.drafts >= MAX_DRAFTS) return jsonResponse({ error: "You have several unfinished items. Please finish or remove one first." }, 403);
    if (!creatingDraft && !hasRoom(counts.real, limits.max_products)) return jsonResponse({ error: `You've reached your limit of ${limits.max_products} listings. Upgrade your plan to add more.` }, 403);

    if (name && !checkText(name).passed) return jsonResponse({ error: "That name isn't allowed. Please rephrase it." }, 422);
    if (description && !checkText(description).passed) return jsonResponse({ error: "That description isn't allowed. Please rephrase it." }, 422);

    let image = null;
    if (image_url) {
      try { allowImageHost(new URL(await getImageOrigin(env, "https://invalid.invalid")).hostname); } catch (e) {}
      image = parseOwnProductImage(image_url, userId, host);
      if (!image) return jsonResponse({ error: "That image can't be used. Please upload it again." }, 400);
    }

    const price = resolvePrice(body, profile);
    const kind = body.kind === "service" ? "service" : "product";
    const nameToSave = creatingDraft ? (name ? String(name).slice(0, 80) : "Untitled product") : String(name).slice(0, 80);
    const desc = description ? String(description).slice(0, 500) : null;
    const productId = crypto.randomUUID();
    const imgId = crypto.randomUUID();
    const w = cleanDim(body.img_w), h = cleanDim(body.img_h), color = cleanColor(body.img_color);

    const stmts = [env.DB.prepare(
      `INSERT INTO products (id, profile_id, name, description, price_display, image_url, is_draft, kind, price_minor, currency, price_type, price_source, search_text, img_w, img_h, img_color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(productId, profile_id, nameToSave, desc, price ? price.price_display : null, image ? image.url : null, creatingDraft ? 1 : 0, kind,
      price ? price.price_minor : null, price ? price.currency : null, price ? price.price_type : "fixed", price ? price.price_source : null,
      buildSearchText(nameToSave, desc), image ? w : null, image ? h : null, image ? color : null)];
    if (image) stmts.push(env.DB.prepare("INSERT INTO product_images (id, product_id, url, position, width, height, color) VALUES (?, ?, ?, 0, ?, ?, ?)").bind(imgId, productId, image.url, w, h, color));
    await env.DB.batch(stmts);
    return jsonResponse({ success: true, productId, imageId: image ? imgId : null });
  } catch (err) {
    if (err instanceof ClientError) return jsonResponse({ error: err.message }, err.status);
    console.error("Product creation error:", err);
    return jsonResponse({ error: "Couldn't save that. Please check your entries and try again." }, 400);
  }
}

export async function handleUpdateProduct(request, env, userId, productId) {
  const { results: rows } = await env.DB.prepare(
    `SELECT products.*, profiles.owner_id AS profile_owner_id, profiles.default_currency AS p_default_currency,
            profiles.store_country AS p_store_country, profiles.tier_id AS p_tier_id, profiles.max_products AS p_max_products
     FROM products JOIN profiles ON products.profile_id = profiles.id WHERE products.id = ?`
  ).bind(productId).all();
  if (!rows.length) return jsonResponse({ error: "Product not found." }, 404);
  const cur = rows[0];
  if (cur.profile_owner_id !== userId) return jsonResponse({ error: "Not your product." }, 403);

  const body = await request.json().catch(() => ({}));
  const host = new URL(request.url).hostname;
  const updates = {};

  try {
    if (body.name !== undefined) {
      if (!checkText(body.name).passed) return jsonResponse({ error: "That name isn't allowed. Please rephrase it." }, 422);
      updates.name = String(body.name).slice(0, 80);
      if (cur.is_draft) {
        const { limits } = await getProfileLimits(env, { tier_id: cur.p_tier_id, max_products: cur.p_max_products });
        const counts = await countProducts(env, cur.profile_id);
        if (!hasRoom(counts.real, limits.max_products)) return jsonResponse({ error: `You've reached your limit of ${limits.max_products} listings. Upgrade your plan to add more.` }, 403);
        updates.is_draft = 0;
      }
      // A slug is set once and then left alone, so a shared link never changes. Old placeholder slugs get repaired.
      const bad = !cur.slug || /^untitled-product(-\d+)?$/.test(cur.slug);
      if (bad) {
        const { generateUniqueProductSlug } = await import("./products-engagement.js");
        updates.slug = await generateUniqueProductSlug(env, cur.profile_id, updates.name, productId);
      }
    }
    if (body.description !== undefined) {
      if (!checkText(body.description || "").passed) return jsonResponse({ error: "That description isn't allowed. Please rephrase it." }, 422);
      updates.description = body.description ? String(body.description).slice(0, 500) : null;
    }
    if (body.kind !== undefined) updates.kind = body.kind === "service" ? "service" : "product";
    const price = resolvePrice(body, { default_currency: cur.p_default_currency, store_country: cur.p_store_country });
    if (price) Object.assign(updates, price);
    if (body.image_url !== undefined) {
      if (body.image_url) {
        try { allowImageHost(new URL(await getImageOrigin(env, "https://invalid.invalid")).hostname); } catch (e) {}
        const image = parseOwnProductImage(body.image_url, userId, host);
        if (!image) return jsonResponse({ error: "That image can't be used. Please upload it again." }, 400);
        updates.image_url = image.url;
        updates.img_w = cleanDim(body.img_w); updates.img_h = cleanDim(body.img_h); updates.img_color = cleanColor(body.img_color);
      } else { updates.image_url = null; updates.img_w = null; updates.img_h = null; updates.img_color = null; }
    }
    if (!Object.keys(updates).length) return jsonResponse({ error: "Nothing to update." }, 400);

    if (updates.name !== undefined || updates.description !== undefined) {
      updates.search_text = buildSearchText(updates.name ?? cur.name, updates.description !== undefined ? updates.description : cur.description);
    }
    const keys = Object.keys(updates);
    const stmts = [env.DB.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...keys.map((k) => updates[k]), productId)];

    // Older screens only send image_url: keep the first photo row in step so nothing drifts.
    if (updates.image_url) {
      const { results: first } = await env.DB.prepare("SELECT id FROM product_images WHERE product_id = ? ORDER BY position ASC LIMIT 1").bind(productId).all();
      stmts.push(first.length
        ? env.DB.prepare("UPDATE product_images SET url = ?, width = ?, height = ?, color = ? WHERE id = ?").bind(updates.image_url, updates.img_w ?? null, updates.img_h ?? null, updates.img_color ?? null, first[0].id)
        : env.DB.prepare("INSERT INTO product_images (id, product_id, url, position, width, height, color) VALUES (?, ?, ?, 0, ?, ?, ?)").bind(crypto.randomUUID(), productId, updates.image_url, updates.img_w ?? null, updates.img_h ?? null, updates.img_color ?? null));
    }
    await env.DB.batch(stmts);
    return jsonResponse({ success: true });
  } catch (err) {
    if (err instanceof ClientError) return jsonResponse({ error: err.message }, err.status);
    console.error("Product update error:", err);
    return jsonResponse({ error: "Couldn't save your changes. Please check your entries and try again." }, 400);
  }
}

export async function handleDeleteProduct(env, userId, productId) {
  const { results } = await env.DB.prepare(
    "SELECT products.id, profiles.owner_id AS profile_owner_id FROM products JOIN profiles ON products.profile_id = profiles.id WHERE products.id = ?"
  ).bind(productId).all();
  if (!results.length) return jsonResponse({ error: "Product not found." }, 404);
  if (results[0].profile_owner_id !== userId) return jsonResponse({ error: "Not your product." }, 403);
  await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(productId).run();
  try { await recomputeCollectionsForProduct(env, productId); } catch (e) { console.error("collection recount failed:", e); }
  return jsonResponse({ success: true });
}

export async function handleListProducts(env, profileId, includeDrafts = false) {
  const { results: profileRows } = await env.DB.prepare(
    "SELECT id, moderation_status, is_active, max_products, tier_id FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const { planId, limits } = await getProfileLimits(env, profileRows[0]);

  const draftFilter = includeDrafts ? "" : "AND p.is_draft = 0";
  const { results: products } = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.price_display, p.price_minor, p.currency, p.price_type, p.kind, p.image_url, p.img_w, p.img_h, p.img_color,
            p.created_at, p.is_draft, p.slug, p.view_count, p.share_count, p.video_id, p.video_status, b.expires_at AS boost_expires_at
     FROM products p LEFT JOIN boost_log b ON b.product_id = p.id AND b.expires_at > datetime('now')
     WHERE p.profile_id = ? AND p.is_active = 1 ${draftFilter}
     ORDER BY (b.expires_at IS NOT NULL) DESC, b.expires_at DESC, p.created_at DESC LIMIT 500`
  ).bind(profileId).all();

  return jsonResponse({
    products,
    unlocked: limits.max_products !== 0,
    tierId: profileRows[0].tier_id || null,
    planId,
    maxProducts: limits.max_products < 0 ? 1000000 : limits.max_products,
    limits,
    referralsNeeded: 0
  });
}

export async function handleUploadProductImage(request, env, userId, url) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("image/webp")) return jsonResponse({ error: "Only WebP images are accepted" }, 400);

  const arrayBuffer = await request.arrayBuffer();
  if (arrayBuffer.byteLength / (1024 * 1024) > 2) return jsonResponse({ error: "Image too large. Please use a smaller image" }, 400);

  // Storage-abuse guard: a person cannot pour unlimited files into the bucket.
  const listed = await env.ASSETS.list({ prefix: `products/${userId}/` });
  const oneHourAgo = Date.now() - 3600 * 1000;
  if (listed.objects.filter((o) => new Date(o.uploaded).getTime() > oneHourAgo).length >= 40) {
    return jsonResponse({ error: "Upload limit reached. Please try again in an hour" }, 429);
  }

  const moderation = await checkImage(arrayBuffer, env);
  if (!moderation.passed) return jsonResponse({ error: getReadableRejectionMessage(moderation.reason) }, 422);

  const requestedName = (url.searchParams.get("name") || "").replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 60);
  const suffix = crypto.randomUUID().slice(0, 8);
  const filename = requestedName ? `${requestedName}-${suffix}` : crypto.randomUUID();
  const key = `products/${userId}/${filename}.webp`;
  await env.ASSETS.put(key, arrayBuffer, { httpMetadata: { contentType: "image/webp" } });
  return jsonResponse({ success: true, url: `${await getImageOrigin(env, url.origin)}/api/image/${key}` });
}
