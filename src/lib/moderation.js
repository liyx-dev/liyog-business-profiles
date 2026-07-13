// =====================================================================
// LIYOG WORLD — src/lib/moderation.js
// One shared moderation gate for ALL user-generated content: profiles
// today, reviews and Discovery feed posts/comments later, plus catalogue
// products going forward. Callers pass in what they have; this module
// never assumes a specific content type.
// =====================================================================

// Server-side only — never expose this list to any client response.
const BANNED_KEYWORDS = [
  // Placeholder list — replace with your actual moderation keyword set.
  // Kept short here since the real list should stay private and is
  // best maintained directly in this file, not documented elsewhere.
  "xxx", "porn", "escort", "casino", "bet9ja-scam"
];

// Terms that indicate a restricted CATEGORY of listing (as opposed to
// explicit content, which the image checker handles). This is the layer
// that should carry the weight for "medicine/supplement/etc." judgment
// calls — not the image checker, which can't tell a legal product photo
// from an illegal one. Tune this list against your actual category
// policy rather than loosening image thresholds to compensate.
const RESTRICTED_CATEGORY_TERMS = [
  "gambling", "adult content", "firearm", "gun for sale", "lottery ticket",
  "loan shark", "prescription drugs", "controlled substance"
];

// Terms that are fine in a health/wellness context but worth a lighter
// second look rather than an outright block — e.g. supplement listings
// mentioning dosages. These go to manual review, not auto-reject, so
// legitimate sellers aren't blocked by an overly blunt keyword match.
const CAUTION_TERMS = [
  "prescription", "dosage", "mg per", "supplement", "medication"
];

/**
 * Runs text through the banned-keyword filter. Works on any string —
 * a bio, a review body, a Discovery feed post, a comment, a product
 * description.
 * Returns { passed: boolean, matchedTerm: string|null, needsReview: boolean }
 */
export function checkText(rawText) {
  if (!rawText) return { passed: true, matchedTerm: null, needsReview: false };
  const plain = stripHtml(rawText).toLowerCase();

  for (const term of BANNED_KEYWORDS) {
    if (plain.includes(term)) return { passed: false, matchedTerm: term, needsReview: false };
  }
  for (const term of RESTRICTED_CATEGORY_TERMS) {
    if (plain.includes(term)) return { passed: false, matchedTerm: term, needsReview: false };
  }
  for (const term of CAUTION_TERMS) {
    if (plain.includes(term)) return { passed: true, matchedTerm: term, needsReview: true };
  }
  return { passed: true, matchedTerm: null, needsReview: false };
}

/**
 * Checks an image (as raw bytes, already fetched by the caller) against
 * Google Cloud Vision's SafeSearch detection. This is the real
 * integration — previous versions of this function were a placeholder.
 *
 * Vision returns LIKELIHOOD ratings (UNKNOWN, VERY_UNLIKELY, UNLIKELY,
 * POSSIBLE, LIKELY, VERY_LIKELY) for adult, violence, racy, medical, and
 * spoof content — not a single numeric score, so thresholds are judged
 * against these categorical levels.
 *
 * Decision policy (tuned to reduce manual review load while staying safe):
 *   - adult or violence at LIKELY or VERY_LIKELY  -> hard reject
 *   - racy at VERY_LIKELY                          -> hard reject
 *   - racy at LIKELY                               -> soft flag (needsReview)
 *   - everything else                              -> pass automatically
 *
 * Returns { passed: boolean, needsReview: boolean, reason: string|null, raw: object|null }
 */
export async function checkImage(imageBytes, env) {
  if (!imageBytes) return { passed: true, needsReview: false, reason: null, raw: null };

  if (!env.IMAGE_MODERATION_API_KEY) {
    console.warn("IMAGE_MODERATION_API_KEY not set — image moderation is currently a no-op.");
    return { passed: true, needsReview: false, reason: "moderation_not_configured", raw: null };
  }

  try {
    const base64Image = arrayBufferToBase64(imageBytes);

    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.IMAGE_MODERATION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64Image },
              features: [{ type: "SAFE_SEARCH_DETECTION" }]
            }
          ]
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Vision API request failed:", res.status, errBody);
      // Fail open on an API-level error (bad key, quota, network) — a
      // provider outage should never be the reason a legitimate upload
      // gets stuck. This is a deliberate, documented tradeoff, not an
      // oversight: revisit if abuse volume ever justifies fail-closed.
      return { passed: true, needsReview: true, reason: "moderation_api_error", raw: null };
    }

    const data = await res.json();
    const annotation = data.responses?.[0]?.safeSearchAnnotation;
    if (!annotation) {
      return { passed: true, needsReview: true, reason: "moderation_no_result", raw: null };
    }

    const LIKELIHOOD_RANK = {
      UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5
    };
    const rank = (level) => LIKELIHOOD_RANK[level] ?? 0;

    const adultRank = rank(annotation.adult);
    const violenceRank = rank(annotation.violence);
    const racyRank = rank(annotation.racy);

    if (adultRank >= LIKELIHOOD_RANK.LIKELY) {
      return { passed: false, needsReview: false, reason: "adult_content_detected", raw: annotation };
    }
    if (violenceRank >= LIKELIHOOD_RANK.LIKELY) {
      return { passed: false, needsReview: false, reason: "violent_content_detected", raw: annotation };
    }
    if (racyRank >= LIKELIHOOD_RANK.VERY_LIKELY) {
      return { passed: false, needsReview: false, reason: "racy_content_detected", raw: annotation };
    }
    if (racyRank >= LIKELIHOOD_RANK.LIKELY) {
      return { passed: true, needsReview: true, reason: "racy_content_possible", raw: annotation };
    }

    return { passed: true, needsReview: false, reason: null, raw: annotation };
  } catch (err) {
    console.error("Image moderation call failed:", err);
    return { passed: true, needsReview: true, reason: "moderation_check_failed", raw: null };
  }
}

/**
 * Full moderation pass for a piece of content made of multiple fields.
 * Text fields are checked directly; image fields are expected to already
 * be raw bytes (ArrayBuffer) — fetch them before calling this, since the
 * gate itself shouldn't need to know where an image came from.
 *
 * @param {object} content - { textFields: {...}, imageFields: {fieldName: ArrayBuffer} }
 * @param {object} env - Worker env, for image API access
 * @returns {object} { status: 'approved'|'pending', flags: [...] }
 */
export async function runModerationGate(content, env) {
  const flags = [];

  for (const [fieldName, value] of Object.entries(content.textFields || {})) {
    const result = checkText(value);
    if (!result.passed) {
      flags.push({ checkType: "text_auto", fieldName, flaggedValue: result.matchedTerm, hardReject: true });
    } else if (result.needsReview) {
      flags.push({ checkType: "text_caution", fieldName, flaggedValue: result.matchedTerm, hardReject: false });
    }
  }

  for (const [fieldName, imageBytes] of Object.entries(content.imageFields || {})) {
    const result = await checkImage(imageBytes, env);
    if (!result.passed) {
      flags.push({ checkType: "image_auto", fieldName, flaggedValue: result.reason, autoScore: null, hardReject: true });
    } else if (result.needsReview) {
      flags.push({ checkType: "image_caution", fieldName, flaggedValue: result.reason, autoScore: null, hardReject: false });
    }
  }

  const hasHardReject = flags.some((f) => f.hardReject);
  return {
    status: hasHardReject ? "rejected" : (flags.length > 0 ? "pending" : "approved"),
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

/**
 * Returns a short, human-readable message for a rejection reason —
 * used to build the toast message the frontend shows immediately,
 * instead of silently demoting content to "pending" with no explanation.
 */
export function getReadableRejectionMessage(reason) {
  const messages = {
    adult_content_detected: "This image can't be used — it appears to contain adult content. Please choose a different photo.",
    violent_content_detected: "This image can't be used — it appears to contain graphic or violent content. Please choose a different photo.",
    racy_content_detected: "This image can't be used — it doesn't meet our content guidelines. Please choose a different photo."
  };
  return messages[reason] || "This image can't be used right now. Please try a different photo.";
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ");
}
