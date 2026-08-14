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

// ---------------------------------------------------------------------
// Sentence-safe truncation for AI-generated summary_text before it's
// saved to D1. (2026-08-14 fix — see maxLen bump + call sites below.)
//
// Previously both generateAndStoreProductInsight and
// generateAndStoreCatalogueInsight did a raw `.slice(0, 900)` on the
// model's output. Both system prompts already ask the model to finish
// every thought and never truncate mid-sentence — but that's only an
// instruction to the model, not a guarantee it's followed, and a raw
// character slice has no idea where a sentence ends. If the model's
// prose ever ran past 900 chars (easy for the catalogue insight, whose
// own prompt asks for a longer 3-4 sentence summary plus keyword-rich
// phrasing), the saved text got chopped at an arbitrary character —
// visibly mid-word or mid-sentence on the brand-profile and product
// pages, exactly the bug reported.
//
// This function never invents or extends text — it only ever trims.
// If the text is already within maxLen, it's returned untouched. If
// it's longer, it looks for the LAST sentence-ending punctuation
// (. ! ?) at or before maxLen and cuts there, keeping the punctuation,
// so the stored text always ends as a complete sentence. Only if no
// sentence boundary exists at all within maxLen (a single very long
// run-on with no punctuation — pathological, but handled rather than
// crashing or silently keeping an oversized row) does it fall back to
// a hard cut, and even then at the last whitespace rather than
// mid-word, with an ellipsis so it's visibly marked as cut rather than
// looking like a naturally short summary.
function truncateToSentence(text, maxLen) {
  const trimmed = (text || "").trim();
  if (trimmed.length <= maxLen) return trimmed;

  const window = trimmed.slice(0, maxLen);
  // Find the last ., !, or ? in the window, followed by end-of-string,
  // a space, or a quote/paren close — avoids matching decimals like
  // "4.5 stars" or abbreviations followed directly by another letter.
  const sentenceEndRe = /[.!?]["')\]]?(?=\s|$)/g;
  let lastEnd = -1;
  let match;
  while ((match = sentenceEndRe.exec(window)) !== null) {
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd > 0) {
    return trimmed.slice(0, lastEnd).trim();
  }

  // No sentence boundary found in-window at all — fall back to the
  // last whitespace so we at least don't cut a word in half, and mark
  // it clearly as truncated rather than presenting a fake-complete
  // sentence.
  const lastSpace = window.lastIndexOf(" ");
  const safeCut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return safeCut.trim() + "…";
}

async function getProduct(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT id, profile_id, name, slug, is_active, view_count, share_count FROM products WHERE id = ?"
  ).bind(productId).all();
  return results.length ? results[0] : null;
}

/** Everything the /engagement endpoint needs from the products row
 *  itself (view_count/share_count live on `products`, NOT on
 *  product_stats — that table only tracks ratings/likes). Kept as its
 *  own small export rather than folding into getProductStats, so the
 *  distinction between "rating/like aggregates" (product_stats) and
 *  "raw counters" (products.view_count/share_count) stays visible in
 *  the code, not just in the schema comments. */
async function getProductCounters(env, productId) {
  const product = await getProduct(env, productId);
  return {
    view_count: product?.view_count || 0,
    share_count: product?.share_count || 0
  };
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
// 2026-08-14: raised from the old flat 900-char slice (shared with the
// catalogue insight, which needs meaningfully more room — see
// CATALOGUE_INSIGHT_MAX_CHARS below). The system prompt asks for only
// 1-2 sentences, so 500 chars is already generous headroom for that —
// this ceiling should now only ever be reached by a genuine model
// outlier, and even then truncateToSentence() (see above) cuts at the
// last full sentence, never mid-word/mid-thought.
const PRODUCT_INSIGHT_MAX_CHARS = 500;

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
    truncateToSentence(parsed.summary_text, PRODUCT_INSIGHT_MAX_CHARS),
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

// =====================================================================
// LiyX AI — CATALOGUE-WIDE insight (2026-07-24), shown in the "See
// All" sheet after the first couple of products, and reusable later
// on the brand profile inline page (per product decision). One row
// per profile in profile_catalogue_insight, always overwritten — same
// "never accumulates history" shape as product_ai_summary. Computed
// purely from data that already exists (products.view_count/
// share_count, product_ratings, product_likes) — no new per-event
// tables needed. Regenerates roughly monthly OR after enough new
// signals have accumulated since the last generation, whichever comes
// first, so an active catalogue gets a fresher read without needing a
// visitor to wait for a full calendar month.
// =====================================================================

const CATALOGUE_INSIGHT_SIGNAL_THRESHOLD = 10; // new views+likes+ratings combined since last generation
const CATALOGUE_INSIGHT_MAX_AGE_DAYS = 30;
// 2026-08-14: the old flat 900-char slice was shared with the
// (shorter) product insight above; this one gets its own, slightly
// higher ceiling since its prompt explicitly asks for 3-4 full
// sentences PLUS naturally-worked-in keywords — legitimately longer
// prose than the product-level summary. truncateToSentence() is still
// the actual safety net if the model ever runs past this.
const CATALOGUE_INSIGHT_MAX_CHARS = 1100;

async function getCatalogueInsight(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM profile_catalogue_insight WHERE profile_id = ?"
  ).bind(profileId).all();
  if (!results.length) return null;
  return {
    ...results[0],
    top_keywords: safeParseArray(results[0].top_keywords),
    flags: safeParseArray(results[0].flags)
  };
}

async function computeCatalogueSignals(env, profileId) {
  const { results: productRows } = await env.DB.prepare(
    "SELECT id, view_count, share_count FROM products WHERE profile_id = ? AND is_active = 1"
  ).bind(profileId).all();

  const totalViews = productRows.reduce((sum, p) => sum + (p.view_count || 0), 0);
  const totalShares = productRows.reduce((sum, p) => sum + (p.share_count || 0), 0);

  const { results: statsRows } = await env.DB.prepare(
    `SELECT ps.rating_count, ps.average_rating, ps.like_count, pr.name
     FROM product_stats ps JOIN products pr ON pr.id = ps.product_id
     WHERE pr.profile_id = ? AND pr.is_active = 1`
  ).bind(profileId).all();

  const totalRatings = statsRows.reduce((sum, r) => sum + (r.rating_count || 0), 0);
  const totalLikes = statsRows.reduce((sum, r) => sum + (r.like_count || 0), 0);
  const weightedRatingSum = statsRows.reduce((sum, r) => sum + (r.average_rating || 0) * (r.rating_count || 0), 0);
  const overallAverage = totalRatings ? weightedRatingSum / totalRatings : 0;

  return {
    productCount: productRows.length,
    totalViews, totalShares, totalRatings, totalLikes, overallAverage,
    perProductStats: statsRows,
    signalCount: totalViews + totalLikes + totalRatings + totalShares
  };
}

async function maybeGenerateCatalogueInsight(env, profileId) {
  try {
    const signals = await computeCatalogueSignals(env, profileId);
    if (signals.productCount < 1) return;

    const existing = await getCatalogueInsight(env, profileId);
    const daysSinceGeneration = existing
      ? (Date.now() - new Date(existing.generated_at + "Z").getTime()) / 86400000
      : Infinity;
    const newSignalsSinceGeneration = signals.signalCount - (existing?.signal_count_at_generation || 0);

    const shouldGenerate = !existing
      || daysSinceGeneration >= CATALOGUE_INSIGHT_MAX_AGE_DAYS
      || newSignalsSinceGeneration >= CATALOGUE_INSIGHT_SIGNAL_THRESHOLD;
    if (!shouldGenerate) return;

    await generateAndStoreCatalogueInsight(env, profileId, signals);
  } catch (err) {
    console.error("maybeGenerateCatalogueInsight failed:", err);
  }
}

async function generateAndStoreCatalogueInsight(env, profileId, signals) {
  const { results: profileRows } = await env.DB.prepare("SELECT business_name, business_category FROM profiles WHERE id = ?").bind(profileId).all();
  const businessName = profileRows.length ? profileRows[0].business_name : "This brand";
  const businessCategory = profileRows.length ? profileRows[0].business_category : null;

  // Flags are computed directly from the numbers — deterministic,
  // never invented by the model — then handed to LiyX AI alongside the
  // raw stats so its prose stays grounded in what's actually true.
  const flags = [];
  if (signals.totalViews > 0 && signals.totalRatings === 0) flags.push("Getting views but no ratings yet");
  if (signals.overallAverage > 0 && signals.overallAverage < 3) flags.push("Average rating is below 3 stars");
  if (signals.totalLikes === 0 && signals.totalViews > 20) flags.push("Good traffic, but no likes yet");
  const topRated = signals.perProductStats.filter((r) => r.rating_count > 0).sort((a, b) => b.average_rating - a.average_rating)[0];
  if (topRated) flags.push(`"${topRated.name}" is the highest-rated item`);

  const prompt = buildCatalogueInsightPrompt(businessName, businessCategory, signals, flags);

  let parsed;
  try {
    const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: CATALOGUE_INSIGHT_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      max_tokens: 400
    });
    parsed = parseProductInsightResponse(aiResponse); // same strict-JSON shape/parser as product insights
  } catch (err) {
    console.error("LiyX AI (catalogue) generation call failed:", err);
    return;
  }
  if (!parsed || !parsed.summary_text) return;

  await env.DB.prepare(
    `INSERT INTO profile_catalogue_insight
       (profile_id, period, summary_text, top_keywords, flags,
        total_views, total_likes, total_ratings, average_rating,
        signal_count_at_generation, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id) DO UPDATE SET
       period = excluded.period,
       summary_text = excluded.summary_text,
       top_keywords = excluded.top_keywords,
       flags = excluded.flags,
       total_views = excluded.total_views,
       total_likes = excluded.total_likes,
       total_ratings = excluded.total_ratings,
       average_rating = excluded.average_rating,
       signal_count_at_generation = excluded.signal_count_at_generation,
       generated_at = datetime('now')`
  ).bind(
    profileId,
    new Date().toISOString().slice(0, 7),
    truncateToSentence(parsed.summary_text, CATALOGUE_INSIGHT_MAX_CHARS),
    JSON.stringify((parsed.top_keywords || []).slice(0, 6)),
    JSON.stringify(flags.slice(0, 4)),
    signals.totalViews, signals.totalLikes, signals.totalRatings, signals.overallAverage,
    signals.signalCount
  ).run();
}

const CATALOGUE_INSIGHT_SYSTEM_PROMPT = `You are LiyX AI, writing a catalogue-level insight for a brand's product/service listings on Liyog World, a Nigerian business directory. You are given the brand name, business category, aggregate numbers (views, likes, ratings, average rating), and a list of pre-computed factual flags — never invent numbers or claims beyond what's given. Be truthful, including about weak spots, but frame everything constructively toward improvement.

Write the summary to be genuinely useful to a reader AND naturally keyword-rich for search engines: work in the brand's name, its business category/niche, and words a real customer would search for (e.g. "trusted", "reviews", "Nigeria", the product category itself) — but only where they fit naturally in a real sentence, never as a stuffed list. Never mention you are an AI language model. Reply with strict JSON only, no markdown, no commentary, in exactly this shape: {"summary_text": "...", "top_keywords": ["...", "..."]}. summary_text should be 3-4 full sentences, naturally readable, not truncated mid-thought. top_keywords should be 3-6 short recurring themes (2-4 words each) that double as real search terms, lowercase, no punctuation.`;

function buildCatalogueInsightPrompt(businessName, businessCategory, signals, flags) {
  const lines = [];
  lines.push(`Brand: ${businessName}`);
  if (businessCategory) lines.push(`Business category/niche: ${businessCategory}`);
  lines.push(`Products/services listed: ${signals.productCount}`);
  lines.push(`Total views across all items: ${signals.totalViews}`);
  lines.push(`Total likes: ${signals.totalLikes}`);
  lines.push(`Total ratings: ${signals.totalRatings}`);
  lines.push(`Overall average rating: ${signals.overallAverage ? signals.overallAverage.toFixed(1) : "N/A"}`);
  if (flags.length) {
    lines.push(`Factual flags (already computed — do not contradict these):`);
    flags.forEach((f) => lines.push(`- ${f}`));
  }
  lines.push(`Write a complete, naturally keyword-rich summary of how this catalogue is performing overall — do not truncate mid-sentence, finish every thought.`);
  return lines.join("\n");
}

async function runScheduledCatalogueInsights(env) {
  const { results: profileIds } = await env.DB.prepare(
    "SELECT DISTINCT profile_id FROM products WHERE is_active = 1"
  ).all();

  let generated = 0;
  for (const row of profileIds) {
    const before = await getCatalogueInsight(env, row.profile_id);
    await maybeGenerateCatalogueInsight(env, row.profile_id);
    const after = await getCatalogueInsight(env, row.profile_id);
    if (!before || (after && after.generated_at !== before.generated_at)) generated++;
  }
  return { checked: profileIds.length, generated };
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
  getProductCounters,
  recalculateProductStats,
  recordShare,
  reportProduct,
  getProductEngagementChart,
  getProductInsight,
  maybeGenerateProductInsight,
  runScheduledProductInsights,
  getCatalogueInsight,
  maybeGenerateCatalogueInsight,
  runScheduledCatalogueInsights,
  buildFingerprint,
  UserFacingError
};

