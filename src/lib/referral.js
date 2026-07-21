// =====================================================================
// LIYOG WORLD — src/lib/referral.js
// Referral completion check + products cap logic. New, additive file —
// does not modify any existing module.
// =====================================================================

/**
 * Same completeness bar as computeIsVerified in index.js, except the
 * gallery requirement is raised from 1 photo to 3 — a referral should
 * only count once the new profile is genuinely real and presentable,
 * not just technically signed up.
 */
export function isReferralQualifyingProfile(profile) {
  if (profile.moderation_status !== "approved") return false;

  const hasContact = !!(profile.whatsapp_number || profile.phone_number);
  const hasMedia = !!profile.logo_url && !!profile.cover_url;
  const hasContent = !!profile.tagline && !!profile.bio_html;

  let photos = [];
  try {
    photos = JSON.parse(profile.store_photos || "[]");
  } catch (e) { /* leave as empty array */ }
  const hasEnoughGallery = Array.isArray(photos) && photos.length >= 3;

  return hasContact && hasMedia && hasContent && hasEnoughGallery;
}

/**
 * Call this any time a referred profile is updated (e.g. after every
 * PATCH /api/profiles/:id save). If the profile now qualifies AND
 * hasn't already been counted, credits the referring profile once.
 * Safe to call repeatedly — it only credits a given referral one time,
 * tracked via the referral_credited flag check below.
 */
export async function maybeCreditReferral(env, profile) {
  if (!profile.referred_by_profile_id) return;
  if (!isReferralQualifyingProfile(profile)) return;

  // Idempotency check: has this specific referral already been
  // credited? We check via a marker row rather than trusting the
  // caller not to call this twice, since PATCH can run many times.
  const { results: existing } = await env.DB.prepare(
    "SELECT id FROM referral_credits WHERE referred_profile_id = ?"
  ).bind(profile.id).all();
  if (existing.length > 0) return; // already credited, do nothing

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO referral_credits (referred_profile_id, referring_profile_id, credited_at) VALUES (?, ?, datetime('now'))"
    ).bind(profile.id, profile.referred_by_profile_id),
    env.DB.prepare(
      "UPDATE profiles SET completed_referrals_count = completed_referrals_count + 1 WHERE id = ?"
    ).bind(profile.referred_by_profile_id)
  ]);
}

/**
 * Whether a profile has unlocked product listings — simple, direct
 * check against the counter maintained by maybeCreditReferral above.
 */
export function hasUnlockedProducts(profile) {
  return (profile.completed_referrals_count || 0) >= 1;
}

/**
 * Enforces the dynamic, per-profile product cap (profiles.max_products,
 * defaulting to 10, adjustable per-profile directly in D1). Never
 * hardcoded — always reads the actual column value.
 */
export async function canAddMoreProducts(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT max_products FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!results.length) return { allowed: false, max: 0, current: 0 };

  const max = results[0].max_products ?? 10;
  const { results: countResult } = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM products WHERE profile_id = ? AND is_active = 1"
  ).bind(profileId).all();
  const current = countResult[0].count;

  return { allowed: current < max, max, current };
}

/**
 * List of profiles this profile has successfully referred — i.e. rows
 * in referral_credits where this profile is the referring one. Used
 * by the owner-only Products tab so they can see who came through
 * their link and whether each has already been credited (all rows
 * here ARE already credited, since referral_credits only ever holds
 * completed referrals — see maybeCreditReferral above).
 *
 * Also separately returns anyone who signed up with this profile's
 * referral code but hasn't completed their profile yet, so the owner
 * can see "1 pending" rather than assuming their link did nothing.
 */
export async function getMyReferrals(env, profileId) {
  const { results: completed } = await env.DB.prepare(
    `SELECT p.id, p.business_name, p.slug, p.logo_url, rc.credited_at
     FROM referral_credits rc
     JOIN profiles p ON p.id = rc.referred_profile_id
     WHERE rc.referring_profile_id = ?
     ORDER BY rc.credited_at DESC`
  ).bind(profileId).all();

  const { results: pending } = await env.DB.prepare(
    `SELECT p.id, p.business_name, p.slug, p.logo_url, p.created_at
     FROM profiles p
     WHERE p.referred_by_profile_id = ?
       AND p.id NOT IN (SELECT referred_profile_id FROM referral_credits WHERE referring_profile_id = ?)
     ORDER BY p.created_at DESC`
  ).bind(profileId, profileId).all();

  return { completed, pending };
}
