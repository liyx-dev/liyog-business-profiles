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

/**
 * POST /api/products — create a product for the authenticated owner's
 * profile. Checks: auth, ownership, referral unlock, dynamic cap,
 * text moderation on name/description.
 */
export async function handleCreateProduct(request, env, userId) {
  const body = await request.json();
  const { profile_id, name, description, price_display } = body;

  if (!profile_id || !name) {
    return jsonResponse({ error: "Please provide at least a product name." }, 400);
  }

  const { results: profileRows } = await env.DB.prepare(
    "SELECT * FROM profiles WHERE id = ?"
  ).bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const profile = profileRows[0];
  if (profile.owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);

  if (!hasUnlockedProducts(profile)) {
    return jsonResponse({ error: "Product listings unlock once you refer a friend who completes their brand profile." }, 403);
  }

  const capCheck = await canAddMoreProducts(env, profile_id);
  if (!capCheck.allowed) {
    return jsonResponse({ error: `You've reached your limit of ${capCheck.max} products.` }, 403);
  }

  const nameCheck = checkText(name);
  if (!nameCheck.passed) {
    return jsonResponse({ error: "That product name isn't allowed. Please rephrase it." }, 422);
  }
  const descCheck = checkText(description || "");
  if (!descCheck.passed) {
    return jsonResponse({ error: "That description isn't allowed. Please rephrase it." }, 422);
  }

  const productId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO products (id, profile_id, name, description, price_display)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(productId, profile_id, name.slice(0, 80), (description || null), (price_display || null)).run();
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
 */
export async function handleListProducts(env, profileId) {
  const { results: profileRows } = await env.DB.prepare(
    "SELECT id, moderation_status, is_active, max_products, completed_referrals_count FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  const profile = profileRows[0];

  const { results: products } = await env.DB.prepare(
    "SELECT id, name, description, price_display, image_url, created_at FROM products WHERE profile_id = ? AND is_active = 1 ORDER BY created_at DESC"
  ).bind(profileId).all();

  return jsonResponse({
    products,
    unlocked: hasUnlockedProducts(profile),
    maxProducts: profile.max_products ?? 10,
    referralsNeeded: hasUnlockedProducts(profile) ? 0 : 1
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
