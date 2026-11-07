// =====================================================================
// BIZIPLEX — src/lib/plans.js
// One place that answers "what is this brand allowed to do?".
// Every number lives in D1 (plans + plan_limits), so the admin dashboard
// can change limits later with NO deploy. -1 means unlimited.
// If the tables are missing or empty, safe built-in defaults apply, so a
// database hiccup can never brick uploads.
// =====================================================================

export const DEFAULT_LIMITS = Object.freeze({
  max_products: 5,
  max_images_per_product: 1,
  video_allowed: 0,
  max_collections: 2,
  catalogue_collections_strip: 5,
  catalogue_videos_strip: 5,
  catalogue_services_strip: 6,
  max_items_per_collection: 25
});

const TTL_MS = 60 * 1000;
const limitCache = new Map();
let tierMapCache = null;

async function tierMap(env) {
  if (tierMapCache && Date.now() - tierMapCache.at < TTL_MS) return tierMapCache.map;
  const map = {};
  try {
    const { results } = await env.DB.prepare("SELECT plan_id, legacy_tier_id FROM plans WHERE legacy_tier_id IS NOT NULL").all();
    for (const r of results) map[r.legacy_tier_id] = r.plan_id;
  } catch (e) { /* plans table not created yet -> everyone is "free" */ }
  tierMapCache = { at: Date.now(), map };
  return map;
}

export async function getPlanId(env, profile) {
  if (!profile || !profile.tier_id) return "free";
  const map = await tierMap(env);
  return map[profile.tier_id] || "free";
}

export async function getPlanLimits(env, planId) {
  const hit = limitCache.get(planId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.limits;
  const limits = { ...DEFAULT_LIMITS };
  try {
    const { results } = await env.DB.prepare("SELECT limit_key, value FROM plan_limits WHERE plan_id = ?").bind(planId).all();
    for (const r of results) if (r.limit_key in limits) limits[r.limit_key] = Number(r.value);
  } catch (e) { /* defaults */ }
  limitCache.set(planId, { at: Date.now(), limits });
  return limits;
}

/** Effective limits for one brand. Existing brands never lose capacity they already have. */
export async function getProfileLimits(env, profile) {
  const planId = await getPlanId(env, profile);
  const limits = { ...(await getPlanLimits(env, planId)) };
  if (limits.max_products >= 0) {
    const legacy = Number(profile && profile.max_products) || 0;
    if (legacy > limits.max_products) limits.max_products = legacy;
  }
  return { planId, limits };
}

/** true when another item still fits. limit < 0 = unlimited. */
export function hasRoom(used, limit) {
  return limit < 0 || used < limit;
}
