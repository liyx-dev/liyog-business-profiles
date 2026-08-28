// =====================================================================
// LIYOG WORLD — src/lib/products.js
// Product CRUD endpoints, called from index.js's main fetch handler.
// Each function takes (request, env, ctx, url) and returns a Response,
// matching the existing handler style already used in index.js.
// =====================================================================

import { checkText, checkImage, getReadableRejectionMessage } from "./moderation.js";
import { canAddMoreProducts, hasUnlockedProducts } from "./referral.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ---------------------------------------------------------------------
// Product slug generation (2026-08-15).
//
// Root cause of the "untitled-product" URL bug: nothing in this file
// — on create OR on edit — ever wrote to products.slug. Every URL
// builder elsewhere (product-pages.js, profile.js) correctly falls
// back to the raw product id whenever slug is empty (`prod.slug ||
// prod.id`), so that fallback was silently doing the right thing for
// every product... until a handful of rows ended up with slug
// literally SET to the string "untitled-product" by something outside
// this codebase (traced via direct DB inspection — no trigger exists
// on the table). Once slug holds ANY truthy value, `slug || id`
// always prefers it, correct or not, and nothing here ever corrected
// it afterward.
//
// The real fix is for the one place that legitimately owns a
// product's identity — creation and edit, right here — to actually
// generate and maintain a proper slug, so the field is never left for
// something else to fill incorrectly, and any past bad value gets
// overwritten the next time the product is edited.
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")   // strip punctuation/emoji
    .replace(/\s+/g, "-")            // spaces -> hyphens
    .replace(/-+/g, "-")             // collapse repeats
    .replace(/^-|-$/g, "")           // trim leading/trailing hyphens
    .slice(0, 60);
}

// Ensures the slug is unique among this profile's OTHER products (two
// different brands can safely share a slug — the URL is always
// /product/{slug}/{brandSlug}, and the brand slug already disambiguates
// globally; only two products under the SAME brand actually collide).
// excludeProductId lets an edit check uniqueness without tripping over
// the product's own existing row.
async function generateUniqueProductSlug(env, profileId, name, excludeProductId) {
  const base = slugify(name);
  if (!base) return null; // nothing sluggable (e.g. emoji-only name) — id fallback still covers this
  let candidate = base;
  let suffix = 2;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM products WHERE profile_id = ? AND slug = ? AND id != ? LIMIT 1`
    ).bind(profileId, candidate, excludeProductId || "").all();
    if (!results.length) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
}

/**
 * POST /api/products — create a product for the authenticated owner's
 * profile. Checks: auth, ownership, referral unlock, dynamic cap,
 * text moderation on name/description.
 */
export async function handleCreateProduct(request, env, userId) {
  const body = await request.json();
  const { profile_id, name, description, price_display, image_url, is_draft } = body;

  // A draft is created the instant a photo finishes uploading, before
  // the owner has typed a name — this is what prevents an orphaned R2
  // file with no matching product row. Drafts still require an image,
  // since a draft with neither a name nor a photo serves no purpose.
  const creatingDraft = !!is_draft;
  if (!profile_id) {
    return jsonResponse({ error: "Missing profile." }, 400);
  }
  if (creatingDraft && !image_url) {
    return jsonResponse({ error: "An image is required to start a draft." }, 400);
  }
  if (!creatingDraft && !name) {
    return jsonResponse({ error: "Please provide at least a product name." }, 400);
  }

  const { results: profileRows } = await env.DB.prepare(
    "SELECT * FROM profiles WHERE id = ?"
  ).bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const profile = profileRows[0];
  if (profile.owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);

  // Two independent unlock paths: a free profile unlocks via referral
  // (hasUnlockedProducts), a paying profile unlocks the instant a tier
  // purchase is confirmed (profile.tier_id gets set in tiers.js). Either
  // one is sufficient — a paying user never needs a referral too.
  const isUnlockedViaReferral = hasUnlockedProducts(profile);
  const isUnlockedViaTier = !!profile.tier_id;
  if (!isUnlockedViaReferral && !isUnlockedViaTier) {
    return jsonResponse({ error: "Product listings unlock once you refer a friend who completes their brand profile, or upgrade your plan." }, 403);
  }

  const capCheck = await canAddMoreProducts(env, profile_id);
  if (!capCheck.allowed) {
    return jsonResponse({ error: `You've reached your limit of ${capCheck.max} products.` }, 403);
  }

  const nameToSave = creatingDraft ? (name ? String(name).slice(0, 80) : "Untitled product") : name.slice(0, 80);

  if (name) {
    const nameCheck = checkText(name);
    if (!nameCheck.passed) {
      return jsonResponse({ error: "That product name isn't allowed. Please rephrase it." }, 422);
    }
  }
  if (description) {
    const descCheck = checkText(description);
    if (!descCheck.passed) {
      return jsonResponse({ error: "That description isn't allowed. Please rephrase it." }, 422);
    }
  }

  const productId = crypto.randomUUID();
  // Only generate a real slug when there's a real name to base it on —
  // a nameless draft (photo-only, per the comment above) has nothing
  // meaningful to slugify yet, so it stays NULL exactly as before and
  // every URL builder already falls back to the product id correctly
  // in that case. The slug gets filled in properly the moment a real
  // name is saved — either right here if the name was provided at
  // creation, or in handleUpdateProduct below when a draft is finalized.
  const slugToSave = (!creatingDraft || name)
    ? await generateUniqueProductSlug(env, profile_id, nameToSave, productId)
    : null;
  try {
    await env.DB.prepare(
      `INSERT INTO products (id, profile_id, name, description, price_display, image_url, is_draft, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(productId, profile_id, nameToSave, (description || null), (price_display || null), (image_url || null), creatingDraft ? 1 : 0, slugToSave).run();
  } catch (dbErr) {
    console.error("Product creation DB error:", dbErr);
    return jsonResponse({ error: "Couldn't save that product — please check your entries and try again." }, 400);
  }

  return jsonResponse({ success: true, productId });
}

/**
 * PATCH /api/products/:id — update a product. Same ownership +
 * moderation checks as creation.
 */
export async function handleUpdateProduct(request, env, userId, productId) {
  const { results: productRows } = await env.DB.prepare(
    `SELECT products.*, profiles.owner_id as profile_owner_id
     FROM products JOIN profiles ON products.profile_id = profiles.id
     WHERE products.id = ?`
  ).bind(productId).all();
  if (!productRows.length) return jsonResponse({ error: "Product not found." }, 404);
  if (productRows[0].profile_owner_id !== userId) return jsonResponse({ error: "Not your product." }, 403);

  const body = await request.json();
  const updates = {};

  if (body.name !== undefined) {
    const check = checkText(body.name);
    if (!check.passed) return jsonResponse({ error: "That product name isn't allowed. Please rephrase it." }, 422);
    updates.name = String(body.name).slice(0, 80);
    // Providing a real name finalizes a draft into a genuine listing —
    // this is the only place is_draft ever flips back to 0.
    if (productRows[0].is_draft) updates.is_draft = 0;

    // 2026-08-15: slug is now generated ONCE and then left alone.
    // Earlier this regenerated on every name edit, which meant a
    // product's public URL could change after it had already been
    // shared — an old link still resolved fine (product-pages.js
    // falls back to matching by id), but it stopped being THE
    // canonical link, which is worse for SEO and confusing for a
    // merchant who's already sent someone the old one. A slug should
    // be set once and stay put, the same way most platforms treat a
    // permalink — an owner fixing a typo five seconds after saving
    // shouldn't be blocked by this, so the guard is "does a real slug
    // already exist", not "is this the first save".
    //
    // 2026-08-15 (updated): currentSlug also treats any slug matching
    // /^untitled-product(-\d+)?$/ as NOT-yet-real. The bad legacy
    // value wasn't only ever the bare string "untitled-product" — an
    // owner with more than one abandoned/in-progress draft at the
    // same time could have ended up with "untitled-product-2",
    // "untitled-product-3", and so on, from whatever external process
    // wrote these before this slug system existed (it used the same
    // kind of numbered-suffix collision handling generateUniqueProductSlug
    // uses today). A single exact-string check only ever caught the
    // first one and left every numbered variant permanently locked in
    // as if it were a real, intentional slug. The regex is anchored
    // (^...$) so it can only ever match that exact bad shape — it
    // will NOT match a genuinely different product whose real name
    // happens to contain the word "untitled" as part of something
    // longer, e.g. "my-untitled-product-line" or "untitled-2024-drop".
    const currentSlug = productRows[0].slug;
    const looksLikeLegacyBadSlug = currentSlug && /^untitled-product(-\d+)?$/.test(currentSlug);
    const slugNeedsFixing = !currentSlug || looksLikeLegacyBadSlug;
    if (slugNeedsFixing) {
      updates.slug = await generateUniqueProductSlug(env, productRows[0].profile_id, updates.name, productId);
    }
  }
  if (body.description !== undefined) {
    const check = checkText(body.description || "");
    if (!check.passed) return jsonResponse({ error: "That description isn't allowed. Please rephrase it." }, 422);
    updates.description = body.description || null;
  }
  if (body.price_display !== undefined) updates.price_display = body.price_display || null;
  if (body.image_url !== undefined) updates.image_url = body.image_url || null;

  if (!Object.keys(updates).length) return jsonResponse({ error: "Nothing to update." }, 400);

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  const values = Object.values(updates);

  try {
    await env.DB.prepare(
      `UPDATE products SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values, productId).run();
  } catch (dbErr) {
    console.error("Product update DB error:", dbErr);
    return jsonResponse({ error: "Couldn't save your changes — please check your entries and try again." }, 400);
  }

  return jsonResponse({ success: true });
}

/**
 * DELETE /api/products/:id — soft-delete (is_active = 0) rather than
 * a hard delete, so historical boost/analytics data isn't orphaned.
 */
export async function handleDeleteProduct(env, userId, productId) {
  const { results } = await env.DB.prepare(
    `SELECT products.id, profiles.owner_id as profile_owner_id
     FROM products JOIN profiles ON products.profile_id = profiles.id
     WHERE products.id = ?`
  ).bind(productId).all();
  if (!results.length) return jsonResponse({ error: "Product not found." }, 404);
  if (results[0].profile_owner_id !== userId) return jsonResponse({ error: "Not your product." }, 403);

  await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(productId).run();
  return jsonResponse({ success: true });
}

/**
 * GET /api/profiles/:id/products — public list of active products for
 * a profile, used both by the public profile view and the owner's edit
 * panel. No auth required (products are public once created), but the
 * profile itself must be active and approved.
 *
 * Boosted products are sorted first (most-recently-boosted first among
 * boosted items), then the rest by newest-first — read via a LEFT JOIN
 * against boost_log rather than a second round trip.
 */
export async function handleListProducts(env, profileId, includeDrafts = false) {
  const { results: profileRows } = await env.DB.prepare(
    "SELECT id, moderation_status, is_active, max_products, completed_referrals_count, tier_id FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const profile = profileRows[0];

  const draftFilter = includeDrafts ? "" : "AND p.is_draft = 0";
  const { results: products } = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.price_display, p.image_url, p.created_at, p.is_draft,
            p.slug, p.view_count, p.share_count,
            b.expires_at as boost_expires_at
     FROM products p
     LEFT JOIN boost_log b ON b.product_id = p.id AND b.expires_at > datetime('now')
     WHERE p.profile_id = ? AND p.is_active = 1 ${draftFilter}
     ORDER BY (b.expires_at IS NOT NULL) DESC, b.expires_at DESC, p.created_at DESC`
  ).bind(profileId).all();

  // Same two-path logic as handleCreateProduct above: unlocked if
  // EITHER the referral requirement is met OR a tier has been bought.
  const isUnlockedViaReferral = hasUnlockedProducts(profile);
  const isUnlockedViaTier = !!profile.tier_id;
  const isUnlocked = isUnlockedViaReferral || isUnlockedViaTier;

  return jsonResponse({
    products,
    unlocked: isUnlocked,
    tierId: profile.tier_id || null,
    maxProducts: profile.max_products ?? 1,
    referralsNeeded: isUnlockedViaReferral ? 0 : 1
  });
}

/**
 * Product image upload — reuses the exact same moderation pipeline as
 * profile image uploads (checkImage's 4-provider cascade), just stored
 * under a products/ prefix in R2 instead of profile-images/.
 */
export async function handleUploadProductImage(request, env, userId, url) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("image/webp")) {
    return jsonResponse({ error: "Only WebP images are accepted" }, 400);
  }

  const arrayBuffer = await request.arrayBuffer();
  const sizeInMb = arrayBuffer.byteLength / (1024 * 1024);
  if (sizeInMb > 2) {
    return jsonResponse({ error: "Image too large — please use a smaller image" }, 400);
  }

  const moderationResult = await checkImage(arrayBuffer, env);
  if (!moderationResult.passed) {
    return jsonResponse({ error: getReadableRejectionMessage(moderationResult.reason) }, 422);
  }

  const requestedName = (url.searchParams.get("name") || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  const filename = requestedName ? `${requestedName}-${uniqueSuffix}` : crypto.randomUUID();
  const key = `products/${userId}/${filename}.webp`;

  await env.ASSETS.put(key, arrayBuffer, { httpMetadata: { contentType: "image/webp" } });

  const publicUrl = `${url.origin}/api/image/${key}`;
  return jsonResponse({ success: true, url: publicUrl });
}

