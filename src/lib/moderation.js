// =====================================================================
// LIYOG WORLD — src/lib/moderation.js
// One shared moderation gate for ALL user-generated content: profiles
// today, reviews and Discovery feed posts/comments later. Callers pass
// in what they have; this module never assumes a specific content type.
// =====================================================================

// Server-side only — never expose this list to any client response.
const BANNED_KEYWORDS = [
  // Placeholder list — replace with your actual moderation keyword set.
  // Kept short here since the real list should stay private and is
  // best maintained directly in this file, not documented elsewhere.
  "xxx", "porn", "escort", "casino", "bet9ja-scam"
];

const RESTRICTED_CATEGORY_TERMS = [
  "gambling", "adult", "weapon", "firearm", "lottery", "loan shark"
];

/**
 * Runs text through the banned-keyword filter. Works on any string —
 * a bio, a review body, a Discovery feed post, a comment.
 * Returns { passed: boolean, matchedTerm: string|null }
 */
export function checkText(rawText) {
  if (!rawText) return { passed: true, matchedTerm: null };
  const plain = stripHtml(rawText).toLowerCase();

  for (const term of BANNED_KEYWORDS) {
    if (plain.includes(term)) return { passed: false, matchedTerm: term };
  }
  for (const term of RESTRICTED_CATEGORY_TERMS) {
    if (plain.includes(term)) return { passed: false, matchedTerm: term };
  }
  return { passed: true, matchedTerm: null };
}

/**
 * Checks an image URL against an external moderation API (SafeSearch-
 * style). This is a single integration point — swap the provider here
 * once you choose one, and every caller (profile photos, review photos,
 * Discovery feed images) benefits without changing their own code.
 *
 * Returns { passed: boolean, score: number, reason: string|null }
 */
export async function checkImage(imageUrl, env) {
  if (!imageUrl) return { passed: true, score: 0, reason: null };

  if (!env.IMAGE_MODERATION_API_KEY) {
    // No provider configured yet — this is a deliberate soft-pass with
    // a loud console warning, so nothing silently breaks in development,
    // but it's obvious in logs that real moderation isn't active yet.
    console.warn("IMAGE_MODERATION_API_KEY not set — image moderation is currently a no-op.");
    return { passed: true, score: 0, reason: "moderation_not_configured" };
  }

  try {
    // Placeholder call shape for a SafeSearch-style API. Replace the
    // URL/body/parsing with your chosen provider's actual contract
    // once IMAGE_MODERATION_API_KEY is set.
    const res = await fetch("https://api.example-moderation-provider.com/v1/safesearch", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.IMAGE_MODERATION_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ image_url: imageUrl })
    });
    const data = await res.json();
    const score = data.adult_score || 0;
    return { passed: score < 0.7, score, reason: score >= 0.7 ? "adult_content_detected" : null };
  } catch (err) {
    console.error("Image moderation call failed:", err);
    // Fail closed on error would block legitimate content on a network
    // blip; fail open with logging is the safer default for launch,
    // revisit once volume justifies stricter handling.
    return { passed: true, score: 0, reason: "moderation_check_failed" };
  }
}

/**
 * Full moderation pass for a piece of content made of multiple fields.
 * This is the one function every content type should call.
 *
 * @param {object} content - e.g. { textFields: {...}, imageFields: {...} }
 * @param {object} env - Worker env, for image API access
 * @returns {object} { status: 'approved'|'pending', flags: [...] }
 */
export async function runModerationGate(content, env) {
  const flags = [];

  for (const [fieldName, value] of Object.entries(content.textFields || {})) {
    const result = checkText(value);
    if (!result.passed) {
      flags.push({ checkType: "text_auto", fieldName, flaggedValue: result.matchedTerm });
    }
  }

  for (const [fieldName, url] of Object.entries(content.imageFields || {})) {
    const result = await checkImage(url, env);
    if (!result.passed) {
      flags.push({ checkType: "image_auto", fieldName, flaggedValue: url, autoScore: result.score });
    }
  }

  return {
    status: flags.length > 0 ? "pending" : "approved",
    flags
  };
}

/**
 * Persists moderation flags to the shared moderation_queue table.
 * Generic across content types — pass the owning table + row id.
 */
export async function saveModerationFlags(env, contentId, flags) {
  if (!flags.length) return;
  const inserts = flags.map((flag) =>
    env.DB.prepare(
      "INSERT INTO moderation_queue (profile_id, check_type, field_name, flagged_value, auto_score, status) VALUES (?, ?, ?, ?, ?, 'open')"
    ).bind(contentId, flag.checkType, flag.fieldName, flag.flaggedValue, flag.autoScore || null)
  );
  await env.DB.batch(inserts);
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ");
}

