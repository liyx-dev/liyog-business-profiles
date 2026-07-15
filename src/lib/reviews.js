// =====================================================================
// LIYOG WORLD — src/lib/reviews.js
// Brand Reputation Engine: reviews, reactions, stats, archiving.
// Imported into src/index.js exactly like lib/auth.js and lib/moderation.js.
// Nothing here touches the existing profiles table or its routes.
// =====================================================================

const LIVE_REVIEW_CAP = 100; // newest N reviews kept live per profile; rest archive
const MAX_PHOTOS_PER_REVIEW = 3;

// ---------------------------------------------------------------------
// Fingerprinting & fraud prevention
// ---------------------------------------------------------------------

/**
 * Builds a stable-but-anonymous fingerprint for rate-limiting anonymous
 * visitors. Combines IP + User-Agent + an optional client-supplied
 * device signal (canvas/timezone hash from the browser) — never stores
 * the raw IP or UA, only a SHA-256 hash of the combination.
 */
async function buildFingerprint(request, clientDeviceSignal) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";
  const raw = `${ip}:${ua}:${clientDeviceSignal || ""}`;
  return sha256(raw);
}

async function ipHashOnly(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256(ip);
}

async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Enforces "1 review per profile, ever" per fingerprint (anonymous or
 * logged-in). Logged-in users are also checked by user_id so switching
 * devices doesn't bypass the limit; anonymous visitors are checked by
 * fingerprint only.
 */
async function hasAlreadyReviewed(env, profileId, { userId, fingerprint }) {
  if (userId) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM brand_reviews WHERE profile_id = ? AND author_user_id = ? LIMIT 1"
    ).bind(profileId, userId).all();
    if (results.length) return true;
  }
  const { results } = await env.DB.prepare(
    "SELECT id FROM brand_reviews WHERE profile_id = ? AND device_hash = ? LIMIT 1"
  ).bind(profileId, fingerprint).all();
  return results.length > 0;
}

// ---------------------------------------------------------------------
// Review text -> short summary extraction (used at archive time).
// Lightweight heuristic now; designed to be swapped for an AI call
// later without changing the archive table shape.
// ---------------------------------------------------------------------
function extractSummary(reviewText, title) {
  const source = (title ? `${title}. ` : "") + (reviewText || "");
  const cleaned = source.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 80) return cleaned;
  const firstSentence = cleaned.split(/(?<=[.!?])\s/)[0];
  const base = firstSentence.length <= 100 ? firstSentence : cleaned.slice(0, 80) + "…";
  return base;
}

// ---------------------------------------------------------------------
// Stats — the single cached row profile pages read on every load.
// ---------------------------------------------------------------------

async function getStats(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM brand_review_stats WHERE profile_id = ?"
  ).bind(profileId).all();
  if (results.length) return results[0];
  return {
    profile_id: profileId, rating_count: 0, rating_sum: 0, average_rating: 0,
    five_star_count: 0, four_star_count: 0, three_star_count: 0,
    two_star_count: 0, one_star_count: 0,
    recommend_yes_count: 0, recommend_no_count: 0,
    likes_count: 0, dislikes_count: 0
  };
}

/** Recomputes and upserts the cached stats row for a profile from scratch.
 *  Called after any review or reaction change — cheap because it's a
 *  single aggregate query, and reads are always against the cache, not this. */
async function recalculateStats(env, profileId) {
  const { results: reviewRows } = await env.DB.prepare(
    `SELECT rating, recommend FROM brand_reviews WHERE profile_id = ? AND moderation_status = 'approved'`
  ).bind(profileId).all();

  const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0, recYes = 0, recNo = 0;
  for (const r of reviewRows) {
    counts[r.rating] = (counts[r.rating] || 0) + 1;
    sum += r.rating;
    if (r.recommend === 1) recYes++;
    if (r.recommend === 0) recNo++;
  }

  // Archived reviews still count toward lifetime rating totals (that's
  // the whole point of preserving stats forever), so fold those in too.
  const { results: archiveAgg } = await env.DB.prepare(
    `SELECT rating, COUNT(*) as cnt, SUM(CASE WHEN recommend = 1 THEN 1 ELSE 0 END) as rec_yes,
            SUM(CASE WHEN recommend = 0 THEN 1 ELSE 0 END) as rec_no
     FROM brand_review_archive WHERE profile_id = ? GROUP BY rating`
  ).bind(profileId).all();
  for (const row of archiveAgg) {
    counts[row.rating] = (counts[row.rating] || 0) + row.cnt;
    sum += row.rating * row.cnt;
    recYes += row.rec_yes || 0;
    recNo += row.rec_no || 0;
  }

  const ratingCount = counts[5] + counts[4] + counts[3] + counts[2] + counts[1];
  const avg = ratingCount ? sum / ratingCount : 0;

  const { results: reactionAgg } = await env.DB.prepare(
    `SELECT reaction, COUNT(*) as cnt FROM brand_reactions WHERE profile_id = ? GROUP BY reaction`
  ).bind(profileId).all();
  let likes = 0, dislikes = 0;
  for (const row of reactionAgg) {
    if (row.reaction === "like") likes = row.cnt;
    if (row.reaction === "dislike") dislikes = row.cnt;
  }

  await env.DB.prepare(
    `INSERT INTO brand_review_stats
       (profile_id, rating_count, rating_sum, average_rating,
        five_star_count, four_star_count, three_star_count, two_star_count, one_star_count,
        recommend_yes_count, recommend_no_count, likes_count, dislikes_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id) DO UPDATE SET
       rating_count = excluded.rating_count,
       rating_sum = excluded.rating_sum,
       average_rating = excluded.average_rating,
       five_star_count = excluded.five_star_count,
       four_star_count = excluded.four_star_count,
       three_star_count = excluded.three_star_count,
       two_star_count = excluded.two_star_count,
       one_star_count = excluded.one_star_count,
       recommend_yes_count = excluded.recommend_yes_count,
       recommend_no_count = excluded.recommend_no_count,
       likes_count = excluded.likes_count,
       dislikes_count = excluded.dislikes_count,
       updated_at = datetime('now')`
  ).bind(
    profileId, ratingCount, sum, avg,
    counts[5], counts[4], counts[3], counts[2], counts[1],
    recYes, recNo, likes, dislikes
  ).run();
}

// ---------------------------------------------------------------------
// Creating a review
// ---------------------------------------------------------------------

class UserFacingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function createReview(env, { profileId, userId, authorProfileId, authorName, rating, recommend, title, reviewText, photos, request, clientDeviceSignal, checkText }) {
  if (!profileId) throw new UserFacingError("Missing profile");
  if (!rating || rating < 1 || rating > 5) throw new UserFacingError("Please choose a star rating");
  if (!reviewText || !reviewText.trim()) throw new UserFacingError("Please write a short review");
  if (reviewText.length > 1000) throw new UserFacingError("Review is too long");

  const { results: profileCheck } = await env.DB.prepare(
    "SELECT id, owner_id FROM profiles WHERE id = ? AND is_active = 1"
  ).bind(profileId).all();
  if (!profileCheck.length) throw new UserFacingError("This brand profile is no longer available", 404);

  // A brand can't review itself.
  if (authorProfileId && authorProfileId === profileId) {
    throw new UserFacingError("A brand can't review its own profile");
  }
  if (userId && profileCheck[0].owner_id === userId) {
    throw new UserFacingError("You can't review your own brand profile");
  }

  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  const ipHash = await ipHashOnly(request);

  const alreadyReviewed = await hasAlreadyReviewed(env, profileId, { userId, fingerprint });
  if (alreadyReviewed) throw new UserFacingError("You've already reviewed this brand", 409);

  // Basic burst protection: same fingerprint, any profile, too many in a short window.
  const { results: recentByFingerprint } = await env.DB.prepare(
    `SELECT id FROM brand_reviews WHERE device_hash = ? AND created_at > datetime('now', '-10 minutes')`
  ).bind(fingerprint).all();
  if (recentByFingerprint.length >= 3) {
    throw new UserFacingError("Please slow down and try again shortly", 429);
  }

  const titleCheck = checkText(title || "");
  const textCheck = checkText(reviewText);
  const moderationStatus = (!titleCheck.passed || !textCheck.passed) ? "pending" : "approved";

  const reviewId = crypto.randomUUID();
  const safePhotos = Array.isArray(photos) ? photos.slice(0, MAX_PHOTOS_PER_REVIEW) : [];

  await env.DB.prepare(
    `INSERT INTO brand_reviews
       (id, profile_id, author_user_id, author_profile_id, author_name,
        rating, recommend, title, review_text, photos, ip_hash, device_hash, moderation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reviewId, profileId, userId || null, authorProfileId || null,
    userId || authorProfileId ? null : (authorName || "Anonymous").slice(0, 60),
    rating, recommend === true ? 1 : recommend === false ? 0 : null,
    (title || "").slice(0, 100), reviewText.slice(0, 1000), JSON.stringify(safePhotos),
    ipHash, fingerprint, moderationStatus
  ).run();

  if (moderationStatus === "approved") {
    await recalculateStats(env, profileId);
  }

  await enforceLiveCap(env, profileId);

  return { reviewId, moderationStatus };
}

// ---------------------------------------------------------------------
// Archiving — keeps only LIVE_REVIEW_CAP newest (or featured) reviews
// live per profile; anything older gets summarized and archived.
// ---------------------------------------------------------------------

async function enforceLiveCap(env, profileId) {
  const { results: overflow } = await env.DB.prepare(
    `SELECT id, rating, recommend, title, review_text, created_at
     FROM brand_reviews
     WHERE profile_id = ? AND moderation_status = 'approved' AND is_featured = 0
     ORDER BY created_at DESC
     LIMIT -1 OFFSET ?`
  ).bind(profileId, LIVE_REVIEW_CAP).all();

  if (!overflow.length) return;

  for (const review of overflow) {
    const archiveId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO brand_review_archive
         (id, profile_id, source_review_id, rating, recommend, summary, original_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      archiveId, profileId, review.id, review.rating, review.recommend,
      extractSummary(review.review_text, review.title), review.created_at
    ).run();
    await env.DB.prepare("DELETE FROM brand_reviews WHERE id = ?").bind(review.id).run();
  }
}

/**
 * Called from the worker's existing scheduled() cron. Runs the archive
 * pass across all profiles that currently exceed the live cap, so this
 * self-heals even if enforceLiveCap was skipped for any reason.
 */
async function runScheduledArchive(env) {
  const { results: profileIds } = await env.DB.prepare(
    `SELECT profile_id, COUNT(*) as cnt FROM brand_reviews
     WHERE moderation_status = 'approved' AND is_featured = 0
     GROUP BY profile_id HAVING cnt > ?`
  ).bind(LIVE_REVIEW_CAP).all();

  for (const row of profileIds) {
    await enforceLiveCap(env, row.profile_id);
  }
  return profileIds.length;
}

// ---------------------------------------------------------------------
// Reactions (like/dislike) — upsert, one per fingerprint per profile
// ---------------------------------------------------------------------

async function setReaction(env, { profileId, userId, reaction, request, clientDeviceSignal }) {
  if (!["like", "dislike"].includes(reaction)) throw new UserFacingError("Invalid reaction");

  const { results: profileCheck } = await env.DB.prepare(
    "SELECT id FROM profiles WHERE id = ? AND is_active = 1"
  ).bind(profileId).all();
  if (!profileCheck.length) throw new UserFacingError("This brand profile is no longer available", 404);

  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  const reactionId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO brand_reactions (id, profile_id, user_id, fingerprint, reaction)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, fingerprint) DO UPDATE SET
       reaction = excluded.reaction, user_id = excluded.user_id, updated_at = datetime('now')`
  ).bind(reactionId, profileId, userId || null, fingerprint, reaction).run();

  await recalculateStats(env, profileId);
  return { success: true };
}

async function getMyReaction(env, profileId, request, clientDeviceSignal) {
  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  const { results } = await env.DB.prepare(
    "SELECT reaction FROM brand_reactions WHERE profile_id = ? AND fingerprint = ?"
  ).bind(profileId, fingerprint).all();
  return results.length ? results[0].reaction : null;
}

// ---------------------------------------------------------------------
// Listing reviews (live, sorted, paginated)
// ---------------------------------------------------------------------

const SORT_COLUMNS = {
  recent: "created_at DESC",
  helpful: "helpful_count DESC, created_at DESC",
  highest: "rating DESC, created_at DESC",
  lowest: "rating ASC, created_at DESC"
};

function safeParseArray(val) {
  try { const parsed = JSON.parse(val || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

async function listReviews(env, profileId, { sort = "recent", limit = 20, offset = 0, featuredOnly = false } = {}) {
  const orderBy = SORT_COLUMNS[sort] || SORT_COLUMNS.recent;
  const featuredClause = featuredOnly ? "AND r.is_featured = 1" : "";
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.profile_id, r.author_user_id, r.author_profile_id, r.author_name,
            u.display_name AS user_display_name,
            ap.business_name AS author_profile_name,
            r.rating, r.recommend, r.title, r.review_text, r.photos, r.owner_reply, r.owner_replied_at,
            r.helpful_count, r.is_verified_customer, r.is_featured, r.created_at
     FROM brand_reviews r
     LEFT JOIN users u ON u.id = r.author_user_id
     LEFT JOIN profiles ap ON ap.id = r.author_profile_id
     WHERE r.profile_id = ? AND r.moderation_status = 'approved' ${featuredClause}
     ORDER BY r.is_featured DESC, ${orderBy}
     LIMIT ? OFFSET ?`
  ).bind(profileId, limit, offset).all();

  return results.map((r) => ({
    ...r,
    photos: safeParseArray(r.photos),
    // Resolution order: brand-profile author name > logged-in user's real name > typed anonymous name > "Anonymous"
    display_name: r.author_profile_name || r.user_display_name || r.author_name || "Anonymous"
  }));
}

// ---------------------------------------------------------------------
// Owner actions: reply, feature/pin, moderate
// ---------------------------------------------------------------------

async function assertOwnsReview(env, reviewId, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT p.owner_id FROM brand_reviews r JOIN profiles p ON p.id = r.profile_id WHERE r.id = ?`
  ).bind(reviewId).all();
  return results.length && results[0].owner_id === ownerId;
}

async function ownerReply(env, { reviewId, ownerId, replyText }) {
  if (!replyText || !replyText.trim()) throw new UserFacingError("Reply can't be empty");
  if (replyText.length > 500) throw new UserFacingError("Reply is too long");

  const owned = await assertOwnsReview(env, reviewId, ownerId);
  if (!owned) throw new UserFacingError("Not authorized", 403);

  await env.DB.prepare(
    `UPDATE brand_reviews SET owner_reply = ?, owner_replied_at = datetime('now') WHERE id = ?`
  ).bind(replyText.slice(0, 500), reviewId).run();

  return { success: true };
}

async function setFeatured(env, { reviewId, ownerId, featured }) {
  const owned = await assertOwnsReview(env, reviewId, ownerId);
  if (!owned) throw new UserFacingError("Not authorized", 403);

  if (featured) {
    const { results: countRow } = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM brand_reviews WHERE profile_id = (SELECT profile_id FROM brand_reviews WHERE id = ?) AND is_featured = 1`
    ).bind(reviewId).all();
    if (countRow[0].cnt >= 50) throw new UserFacingError("You can feature up to 50 reviews. Unfeature one first.");
  }

  await env.DB.prepare(
    `UPDATE brand_reviews SET is_featured = ? WHERE id = ?`
  ).bind(featured ? 1 : 0, reviewId).run();

  return { success: true };
}

async function voteHelpful(env, { reviewId, request, clientDeviceSignal }) {
  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  try {
    await env.DB.prepare(
      `INSERT INTO review_helpful_votes (review_id, fingerprint) VALUES (?, ?)`
    ).bind(reviewId, fingerprint).run();
    await env.DB.prepare(
      `UPDATE brand_reviews SET helpful_count = helpful_count + 1 WHERE id = ?`
    ).bind(reviewId).run();
    return { success: true, alreadyVoted: false };
  } catch (e) {
    // Primary key conflict = already voted; treat as a no-op, not an error.
    return { success: true, alreadyVoted: true };
  }
}

// ---------------------------------------------------------------------
// Badges — computed on read, not stored, so they always reflect
// current stats with zero maintenance.
// ---------------------------------------------------------------------

function computeBadges(stats) {
  const badges = [];
  const count = stats.rating_count || 0;
  const avg = stats.average_rating || 0;
  const totalReactions = (stats.likes_count || 0) + (stats.dislikes_count || 0);
  const recommendPct = (stats.recommend_yes_count + stats.recommend_no_count) > 0
    ? Math.round((stats.recommend_yes_count / (stats.recommend_yes_count + stats.recommend_no_count)) * 100)
    : null;

  if (count >= 10 && avg >= 4.5) badges.push("Top Rated");
  if (count >= 25 && avg >= 4.0) badges.push("Trusted Brand");
  if (recommendPct !== null && recommendPct >= 90 && count >= 10) badges.push("Highly Recommended");
  if (count >= 50 && avg >= 4.7) badges.push("Customer Favorite");
  if (totalReactions >= 100 && stats.likes_count / Math.max(totalReactions, 1) >= 0.9) badges.push("Most Loved");
  if (count >= 5 && avg >= 4.8) badges.push("Excellent Service");

  return badges;
}

module.exports = {
  createReview,
  setReaction,
  getMyReaction,
  listReviews,
  getStats,
  computeBadges,
  ownerReply,
  setFeatured,
  voteHelpful,
  runScheduledArchive,
  recalculateStats,
  buildFingerprint,
  UserFacingError
};
