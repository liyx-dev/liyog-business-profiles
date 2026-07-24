// =====================================================================
// LIYOG WORLD — src/lib/products-engagement.js
// Product engagement: views, likes, star ratings (preset-text, no
// free-text reviews), shares, deep-link slugs, LiyX AI summaries.
//
// Mirrors src/lib/reviews.js conventions throughout — same fingerprint
// helper shape, same stats-cache-row pattern, same "AI generation is
// never awaited inline in a user-facing response path" rule. Imported
// into src/index.js exactly like reviews.js and products.js.
//
// IMPORTANT (matches reviews.js's own rule): maybeGenerateProductInsight
// must only ever be invoked via ctx.waitUntil() AFTER the response for
// whatever action triggered it has already been constructed/returned.
// If the AI call fails or is slow, it must never affect a like/rating/
// view/share request.
// =====================================================================

// ---------------------------------------------------------------------
// Preset rating text catalogue — the actual wording lives HERE, not in
// the database. product_ratings only ever stores which preset IDs a
// visitor picked, so editing/expanding this catalogue later never
// requires a migration or touches any existing row.
// ---------------------------------------------------------------------
const RATING_PRESETS = {
  5: {
    primary: [
      { id: "p5_1", text: "Excellent quality, exactly as described" },
      { id: "p5_2", text: "Exceeded my expectations" },
      { id: "p5_3", text: "Will definitely buy again" },
      { id: "p5_4", text: "Perfect, no complaints at all" },
      { id: "p5_5", text: "Best purchase I've made in a while" }
    ],
    tags: [
      { id: "t5_1", text: "Fast delivery" },
      { id: "t5_2", text: "Great price" },
      { id: "t5_3", text: "Exactly as pictured" },
      { id: "t5_4", text: "Great packaging" },
      { id: "t5_5", text: "Responsive seller" }
    ]
  },
  4: {
    primary: [
      { id: "p4_1", text: "Very good, minor issues only" },
      { id: "p4_2", text: "Good quality overall" },
      { id: "p4_3", text: "Happy with this purchase" },
      { id: "p4_4", text: "Good value for the price" },
      { id: "p4_5", text: "Solid choice, would recommend" }
    ],
    tags: [
      { id: "t4_1", text: "Fast delivery" },
      { id: "t4_2", text: "Good price" },
      { id: "t4_3", text: "Good communication" },
      { id: "t4_4", text: "Slightly different than expected" },
      { id: "t4_5", text: "Took a bit longer than expected" }
    ]
  },
  3: {
    primary: [
      { id: "p3_1", text: "It's okay, does the job" },
      { id: "p3_2", text: "Average, nothing special" },
      { id: "p3_3", text: "Decent but room for improvement" },
      { id: "p3_4", text: "Met basic expectations" },
      { id: "p3_5", text: "Fair for the price" }
    ],
    tags: [
      { id: "t3_1", text: "Delivery took a while" },
      { id: "t3_2", text: "Price is fair" },
      { id: "t3_3", text: "Quality could be better" },
      { id: "t3_4", text: "As expected, nothing more" }
    ]
  },
  2: {
    primary: [
      { id: "p2_1", text: "Below what I expected" },
      { id: "p2_2", text: "Quality wasn't great" },
      { id: "p2_3", text: "Had some issues with this" },
      { id: "p2_4", text: "Not quite as described" },
      { id: "p2_5", text: "Wouldn't rush to buy again" }
    ],
    tags: [
      { id: "t2_1", text: "Slow delivery" },
      { id: "t2_2", text: "Overpriced" },
      { id: "t2_3", text: "Different from photos" },
      { id: "t2_4", text: "Poor communication" }
    ]
  },
  1: {
    primary: [
      { id: "p1_1", text: "Very disappointed with this" },
      { id: "p1_2", text: "Not as described at all" },
      { id: "p1_3", text: "Would not recommend" },
      { id: "p1_4", text: "Had a poor experience" },
      { id: "p1_5", text: "Quality was well below expectations" }
    ],
    tags: [
      { id: "t1_1", text: "Never arrived / very late" },
      { id: "t1_2", text: "Way overpriced" },
      { id: "t1_3", text: "Nothing like the photos" },
      { id: "t1_4", text: "No response from seller" }
    ]
  }
};

/** Returns the full preset catalogue for the frontend to render the
 *  rating picker — one flat lookup, no per-star API calls needed. */
function getRatingPresets() {
  return RATING_PRESETS;
}

function findPresetText(star, presetId, kind) {
  const level = RATING_PRESETS[star];
  if (!level) return null;
  const list = kind === "tag" ? level.tags : level.primary;
  const found = list.find((p) => p.id === presetId);
  return found ? found.text : null;
}

// ---------------------------------------------------------------------
// Fingerprinting — identical shape to reviews.js's buildFingerprint,
// duplicated rather than imported cross-file since both libs are
// meant to stay independently self-contained (matches how reviews.js
// itself doesn't import from products.js either).
// ---------------------------------------------------------------------
async function buildFingerprint(request, clientDeviceSignal) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";
  const raw = `${ip}:${ua}:${clientDeviceSignal || ""}`;
  return sha256(raw);
}

async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

class UserFacingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function safeParseArray(val) {
  try { const parsed = JSON.parse(val || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

async function getProduct(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT id, profile_id, name, slug, is_active FROM products WHERE id = ?"
  ).bind(productId).all();
  return results.length ? results[0] : null;
}

// ---------------------------------------------------------------------
// Slugs — used to build the shareable/deep-linkable product URL:
// liyogworld.com.ng/p/{brand-slug}/product/{product-slug}
// ---------------------------------------------------------------------
function slugify(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

/** Generates a slug for a new product, appending a short suffix if the
 *  base slug already exists for this profile (per-profile uniqueness
 *  only — two different brands can each have their own "blue-shirt"). */
async function generateUniqueProductSlug(env, profileId, name) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  while (true) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM products WHERE profile_id = ? AND slug = ?"
    ).bind(profileId, candidate).all();
    if (!results.length) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

// ---------------------------------------------------------------------
// Views — simple ever-incrementing counter, no per-visitor dedup, per
// the "every open counts while the platform is still growing" call.
// Also logs a lightweight event row purely for the chart's time series.
// ---------------------------------------------------------------------
async function recordView(env, productId) {
  const product = await getProduct(env, productId);
  if (!product) throw new UserFacingError("Product not found", 404);

  await env.DB.prepare("UPDATE products SET view_count = view_count + 1 WHERE id = ?").bind(productId).run();
  await env.DB.prepare("INSERT INTO product_view_events (product_id) VALUES (?)").bind(productId).run();

  return { success: true };
}

// ---------------------------------------------------------------------
// Likes — requires a logged-in user_id. Toggle behavior: liking again
// removes the existing like (handled here, not left to the frontend).
// ---------------------------------------------------------------------
async function toggleLike(env, { productId, userId }) {
  if (!userId) throw new UserFacingError("Please sign in to like a product", 401);

  const product = await getProduct(env, productId);
  if (!product) throw new UserFacingError("Product not found", 404);

  const { results: existing } = await env.DB.prepare(
    "SELECT id FROM product_likes WHERE product_id = ? AND user_id = ?"
  ).bind(productId, userId).all();

  let liked;
  if (existing.length) {
    await env.DB.prepare("DELETE FROM product_likes WHERE product_id = ? AND user_id = ?").bind(productId, userId).run();
    liked = false;
  } else {
    await env.DB.prepare(
      "INSERT INTO product_likes (id, product_id, profile_id, user_id) VALUES (?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), productId, product.profile_id, userId).run();
    liked = true;
  }

  await recalculateProductStats(env, productId);
  return { success: true, liked };
}

async function getMyLike(env, productId, userId) {
  if (!userId) return false;
  const { results } = await env.DB.prepare(
    "SELECT id FROM product_likes WHERE product_id = ? AND user_id = ?"
  ).bind(productId, userId).all();
  return results.length > 0;
}

// ---------------------------------------------------------------------
// Ratings — star + one preset primary text + up to 2 preset tags.
// Upsertable by fingerprint (a visitor can change their mind; same
// row updates), mirroring brand_reactions' ON CONFLICT pattern.
// ---------------------------------------------------------------------
async function submitRating(env, { productId, userId, rating, primaryPresetId, tagPresetIds, request, clientDeviceSignal }) {
  if (!rating || rating < 1 || rating > 5) throw new UserFacingError("Please choose a star rating");

  const product = await getProduct(env, productId);
  if (!product) throw new UserFacingError("Product not found", 404);

  const primaryText = findPresetText(rating, primaryPresetId, "primary");
  if (!primaryText) throw new UserFacingError("Please choose one of the listed options");

  const safeTagIds = Array.isArray(tagPresetIds) ? tagPresetIds.slice(0, 2) : [];
  for (const tagId of safeTagIds) {
    if (!findPresetText(rating, tagId, "tag")) throw new UserFacingError("Invalid option selected");
  }

  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  const ratingId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO product_ratings (id, product_id, profile_id, user_id, fingerprint, rating, primary_preset_id, tag_preset_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, fingerprint) DO UPDATE SET
       user_id = excluded.user_id,
       rating = excluded.rating,
       primary_preset_id = excluded.primary_preset_id,
       tag_preset_ids = excluded.tag_preset_ids,
       updated_at = datetime('now')`
  ).bind(
    ratingId, productId, product.profile_id, userId || null, fingerprint,
    rating, primaryPresetId, JSON.stringify(safeTagIds)
  ).run();

  await recalculateProductStats(env, productId);

  return { success: true };
}

async function getMyRating(env, productId, request, clientDeviceSignal) {
  const fingerprint = await buildFingerprint(request, clientDeviceSignal);
  const { results } = await env.DB.prepare(
    "SELECT rating, primary_preset_id, tag_preset_ids FROM product_ratings WHERE product_id = ? AND fingerprint = ?"
  ).bind(productId, fingerprint).all();
  if (!results.length) return null;
  return {
    rating: results[0].rating,
    primary_preset_id: results[0].primary_preset_id,
    tag_preset_ids: safeParseArray(results[0].tag_preset_ids)
  };
}

// ---------------------------------------------------------------------
// Stats — the single cached row product cards/detail pages read.
// ---------------------------------------------------------------------
async function getProductStats(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM product_stats WHERE product_id = ?"
  ).bind(productId).all();
  if (results.length) return results[0];
  return {
    product_id: productId, rating_count: 0, rating_sum: 0, average_rating: 0,
    five_star_count: 0, four_star_count: 0, three_star_count: 0,
    two_star_count: 0, one_star_count: 0, like_count: 0
  };
}

async function recalculateProductStats(env, productId) {
  const { results: ratingRows } = await env.DB.prepare(
    "SELECT rating FROM product_ratings WHERE product_id = ?"
  ).bind(productId).all();

  const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  for (const r of ratingRows) {
    counts[r.rating] = (counts[r.rating] || 0) + 1;
    sum += r.rating;
  }
  const ratingCount = counts[5] + counts[4] + counts[3] + counts[2] + counts[1];
  const avg = ratingCount ? sum / ratingCount : 0;

  const { results: likeCountRow } = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM product_likes WHERE product_id = ?"
  ).bind(productId).all();
  const likeCount = likeCountRow[0]?.cnt || 0;

  await env.DB.prepare(
    `INSERT INTO product_stats
       (product_id, rating_count, rating_sum, average_rating,
        five_star_count, four_star_count, three_star_count, two_star_count, one_star_count,
        like_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(product_id) DO UPDATE SET
       rating_count = excluded.rating_count,
       rating_sum = excluded.rating_sum,
       average_rating = excluded.average_rating,
       five_star_count = excluded.five_star_count,
       four_star_count = excluded.four_star_count,
       three_star_count = excluded.three_star_count,
       two_star_count = excluded.two_star_count,
       one_star_count = excluded.one_star_count,
       like_count = excluded.like_count,
       updated_at = datetime('now')`
  ).bind(
    productId, ratingCount, sum, avg,
    counts[5], counts[4], counts[3], counts[2], counts[1], likeCount
  ).run();
}

// ---------------------------------------------------------------------
// Shares — increments the fast-path counter + logs a lightweight event
// row for the chart. `channel` is a free-ish label (e.g. "whatsapp",
// "copy_link", "native_share") purely for display, not branched on.
// ---------------------------------------------------------------------
async function recordShare(env, productId, channel) {
  const product = await getProduct(env, productId);
  if (!product) throw new UserFacingError("Product not found", 404);

  await env.DB.prepare("UPDATE products SET share_count = share_count + 1 WHERE id = ?").bind(productId).run();
  await env.DB.prepare("INSERT INTO product_shares (product_id, channel) VALUES (?, ?)").bind(productId, (channel || "").slice(0, 40)).run();

  return { success: true };
}

// ---------------------------------------------------------------------
// Reporting — mirrors review_reports exactly. Queues for manual
// review; never auto-hides a product.
// ---------------------------------------------------------------------
const REPORT_REASONS = ["fake", "offensive", "spam", "off_topic", "other"];

async function reportProduct(env, { productId, reason, details, request, clientDeviceSignal }) {
  if (!REPORT_REASONS.includes(reason)) throw new UserFacingError("Invalid report reason");

  const product = await getProduct(env, productId);
  if (!product) throw new UserFacingError("Product not found", 404);

  const fingerprint = await buildFingerprint(request, clientDeviceSignal);

  try {
    await env.DB.prepare(
      `INSERT INTO product_reports (id, product_id, reporter_fingerprint, reason, details) VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), productId, fingerprint, reason, (details || "").slice(0, 300)).run();
  } catch (e) {
    return { success: true, alreadyReported: true };
  }

  return { success: true, alreadyReported: false };
}

// ---------------------------------------------------------------------
// Chart data — daily-bucketed views/shares + running rating/like
// totals, for the per-product engagement chart.
// ---------------------------------------------------------------------
async function getProductEngagementChart(env, productId, days = 30) {
  const { results: viewRows } = await env.DB.prepare(
    `SELECT date(created_at) as day, COUNT(*) as cnt
     FROM product_view_events
     WHERE product_id = ? AND created_at >= datetime('now', ?)
     GROUP BY day ORDER BY day ASC`
  ).bind(productId, `-${days} days`).all();

  const { results: shareRows } = await env.DB.prepare(
    `SELECT date(created_at) as day, COUNT(*) as cnt
     FROM product_shares
     WHERE product_id = ? AND created_at >= datetime('now', ?)
     GROUP BY day ORDER BY day ASC`
  ).bind(productId, `-${days} days`).all();

  const { results: ratingRows } = await env.DB.prepare(
    `SELECT date(created_at) as day, COUNT(*) as cnt
     FROM product_ratings
     WHERE product_id = ? AND created_at >= datetime('now', ?)
     GROUP BY day ORDER BY day ASC`
  ).bind(productId, `-${days} days`).all();

  return { views: viewRows, shares: shareRows, ratings: ratingRows };
}

// =====================================================================
// LiyX AI — product summary generation, identical trigger rule and
// model to the brand-review insight system. Reads directly from live
// product_ratings rows (star + preset primary text + preset tags) —
// there is no archive table to also fold in, since ratings are never
// pruned (they're cheap enough to keep forever).
//
// IMPORTANT: never awaited inline in a request-response path. Callers
// in index.js must invoke maybeGenerateProductInsight() via
// ctx.waitUntil() AFTER the response has already been constructed.
// =====================================================================

const PRODUCT_INSIGHT_REGEN_THRESHOLD = 3; // regenerate after this many new ratings since last generation
const PRODUCT_INSIGHT_SOURCE_LIMIT = 40; // most recent ratings fed to the model

async function getProductInsight(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT product_id, period, summary_text, top_keywords, rating_count_at_generation, generated_at FROM product_ai_summary WHERE product_id = ?"
  ).bind(productId).all();
  if (!results.length) return null;
  return {
    ...results[0],
    top_keywords: safeParseArray(results[0].top_keywords)
  };
}

async function maybeGenerateProductInsight(env, productId) {
  try {
    if (!productId) return;

    const stats = await getProductStats(env, productId);
    const ratingCount = stats.rating_count || 0;
    if (ratingCount < 1) return;

    const existing = await getProductInsight(env, productId);
    const shouldGenerate = !existing || (ratingCount - (existing.rating_count_at_generation || 0)) >= PRODUCT_INSIGHT_REGEN_THRESHOLD;
    if (!shouldGenerate) return;

    await generateAndStoreProductInsight(env, productId, ratingCount);
  } catch (err) {
    console.error("maybeGenerateProductInsight failed:", err);
  }
}

async function runScheduledProductInsights(env) {
  const { results: productIds } = await env.DB.prepare(
    "SELECT product_id FROM product_stats WHERE rating_count >= 1"
  ).all();

  let generated = 0;
  for (const row of productIds) {
    const before = await getProductInsight(env, row.product_id);
    await maybeGenerateProductInsight(env, row.product_id);
    const after = await getProductInsight(env, row.product_id);
    if (!before || (after && after.generated_at !== before.generated_at)) generated++;
  }
  return { checked: productIds.length, generated };
}

async function generateAndStoreProductInsight(env, productId, ratingCountAtGeneration) {
  const { results: productRows } = await env.DB.prepare(
    "SELECT name FROM products WHERE id = ?"
  ).bind(productId).all();
  const productName = productRows.length ? productRows[0].name : "This product";

  const { results: ratingRows } = await env.DB.prepare(
    `SELECT rating, primary_preset_id, tag_preset_ids, created_at
     FROM product_ratings WHERE product_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(productId, PRODUCT_INSIGHT_SOURCE_LIMIT).all();

  const decoratedRatings = ratingRows.map((r) => ({
    rating: r.rating,
    primaryText: findPresetText(r.rating, r.primary_preset_id, "primary") || "",
    tagTexts: safeParseArray(r.tag_preset_ids).map((tid) => findPresetText(r.rating, tid, "tag")).filter(Boolean)
  }));

  const prompt = buildProductInsightPrompt(productName, decoratedRatings, ratingCountAtGeneration);

  let parsed;
  try {
    const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: PRODUCT_INSIGHT_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      max_tokens: 250
    });
    parsed = parseProductInsightResponse(aiResponse);
    if (!parsed) {
      console.error("LiyX AI (product): raw response could not be parsed:", JSON.stringify(aiResponse));
    }
  } catch (err) {
    console.error("LiyX AI (product) generation call failed:", err);
    return;
  }

  if (!parsed || !parsed.summary_text) return;

  await env.DB.prepare(
    `INSERT INTO product_ai_summary
       (product_id, period, summary_text, top_keywords, rating_count_at_generation, generated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(product_id) DO UPDATE SET
       period = excluded.period,
       summary_text = excluded.summary_text,
       top_keywords = excluded.top_keywords,
       rating_count_at_generation = excluded.rating_count_at_generation,
       generated_at = datetime('now')`
  ).bind(
    productId,
    new Date().toISOString().slice(0, 7),
    parsed.summary_text.slice(0, 350),
    JSON.stringify((parsed.top_keywords || []).slice(0, 6)),
    ratingCountAtGeneration
  ).run();
}

const PRODUCT_INSIGHT_SYSTEM_PROMPT = `You are LiyX AI, a product-insight writer for Liyog World, a brand directory. You write short, warm, specific summaries of what customers think of a product, based only on the star ratings and short preset phrases given to you (customers pick from fixed options, they do not write free text). Never invent details not present in the data. Never mention that you are an AI language model or refer to your own limitations. Reply with strict JSON only, no markdown, no commentary, in exactly this shape: {"summary_text": "...", "top_keywords": ["...", "..."]}. summary_text should be 1-2 sentences. top_keywords should be 2-5 short recurring phrases (2-4 words each) pulled from the actual preset phrases customers picked, lowercase, no punctuation.`;

function buildProductInsightPrompt(productName, decoratedRatings, totalRatingCount) {
  const lines = [];
  lines.push(`Product: ${productName}`);
  lines.push(`Total ratings so far: ${totalRatingCount}`);

  if (totalRatingCount === 1 && decoratedRatings.length === 1) {
    const r = decoratedRatings[0];
    lines.push(`This product has exactly ONE rating so far. Write a warm, encouraging, specific summary based on this single rating — do not say "not enough data" or anything generic.`);
    lines.push(`Rating: ${r.rating} stars — "${r.primaryText}"${r.tagTexts.length ? ", also noted: " + r.tagTexts.join(", ") : ""}`);
    return lines.join("\n");
  }

  lines.push(`Write a summary that synthesizes common themes across these ratings. Focus on what's repeated, not any single outlier.`);
  lines.push(`Ratings:`);
  for (const r of decoratedRatings) {
    lines.push(`- ${r.rating} stars: "${r.primaryText}"${r.tagTexts.length ? " (" + r.tagTexts.join(", ") + ")" : ""}`);
  }
  return lines.join("\n");
}

function parseProductInsightResponse(aiResponse) {
  const text = (aiResponse && (aiResponse.response || aiResponse.result || aiResponse)) || "";
  const raw = typeof text === "string" ? text : JSON.stringify(text);
  try {
    const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    if (!parsed.summary_text || typeof parsed.summary_text !== "string") return null;
    return {
      summary_text: parsed.summary_text.trim(),
      top_keywords: Array.isArray(parsed.top_keywords) ? parsed.top_keywords.filter((k) => typeof k === "string").map((k) => k.trim()).filter(Boolean) : []
    };
  } catch (err) {
    console.error("Failed to parse LiyX AI (product) response:", err, raw.slice(0, 200));
    return null;
  }
}

export {
  getRatingPresets,
  generateUniqueProductSlug,
  recordView,
  toggleLike,
  getMyLike,
  submitRating,
  getMyRating,
  getProductStats,
  recalculateProductStats,
  recordShare,
  reportProduct,
  getProductEngagementChart,
  getProductInsight,
  maybeGenerateProductInsight,
  runScheduledProductInsights,
  buildFingerprint,
  UserFacingError
};

