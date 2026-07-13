// =====================================================================
// LIYOG WORLD — src/lib/moderation.js (v2 — hardened after a real
// safety failure: an explicit image passed the previous threshold
// policy. This version is deliberately stricter and logs the FULL
// raw Vision response on every check, so any future failure can be
// diagnosed from real data instead of guessed at.)
// =====================================================================

const BANNED_KEYWORDS = [
  "xxx", "porn", "escort", "casino", "bet9ja-scam"
];

const RESTRICTED_CATEGORY_TERMS = [
  "gambling", "adult content", "firearm", "gun for sale", "lottery ticket",
  "loan shark", "prescription drugs", "controlled substance"
];

const CAUTION_TERMS = [
  "prescription", "dosage", "mg per", "supplement", "medication"
];

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
 * Checks image bytes against Google Cloud Vision SafeSearch.
 *
 * POLICY CHANGE (hardened): the previous thresholds (reject only at
 * LIKELY/VERY_LIKELY) were too permissive — real explicit content got
 * through. This version rejects at POSSIBLE and above for adult/racy,
 * and LIKELY and above for violence (violence has more legitimate
 * borderline cases — historical photos, sports injuries in a health
 * context, etc. — so it keeps a slightly looser bar than adult content,
 * which has essentially no legitimate borderline case on this platform).
 *
 * Every call logs the FULL raw annotation via console.log, regardless
 * of outcome, specifically so a failure can be diagnosed from actual
 * Vision output next time rather than guessed at blind.
 */
export async function checkImage(imageBytes, env) {
  if (!imageBytes) return { passed: true, needsReview: false, reason: null, raw: null };

  if (!env.IMAGE_MODERATION_API_KEY) {
    console.warn("MODERATION ALERT: IMAGE_MODERATION_API_KEY not set — image was NOT checked and passed by default.");
    return { passed: true, needsReview: false, reason: "moderation_not_configured", raw: null };
  }

  try {
    const base64Image = arrayBufferToBase64(imageBytes);
    console.log("Vision check starting, image byte length:", imageBytes.byteLength);

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
      console.error("MODERATION ALERT: Vision API request FAILED - status", res.status, "body:", errBody);
      // Fail CLOSED, not open, given the real failure we just had. An
      // API error should never silently let content through unchecked.
      return { passed: false, needsReview: true, reason: "moderation_unavailable", raw: null };
    }

    const data = await res.json();
    console.log("Vision RAW response:", JSON.stringify(data));

    if (data.responses?.[0]?.error) {
      console.error("MODERATION ALERT: Vision returned an error object:", JSON.stringify(data.responses[0].error));
      return { passed: false, needsReview: true, reason: "moderation_unavailable", raw: data };
    }

    const annotation = data.responses?.[0]?.safeSearchAnnotation;
    if (!annotation) {
      console.error("MODERATION ALERT: No safeSearchAnnotation in Vision response - failing closed.");
      return { passed: false, needsReview: true, reason: "moderation_no_result", raw: data };
    }

    console.log("Vision SafeSearch levels — adult:", annotation.adult, "violence:", annotation.violence, "racy:", annotation.racy, "medical:", annotation.medical, "spoof:", annotation.spoof);

    const LIKELIHOOD_RANK = {
      UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5
    };
    const rank = (level) => LIKELIHOOD_RANK[level] ?? 5; // unknown level treated as worst-case, not best-case

    const adultRank = rank(annotation.adult);
    const violenceRank = rank(annotation.violence);
    const racyRank = rank(annotation.racy);

    // Adult and racy: reject at POSSIBLE or above. This platform has no
    // legitimate use case for borderline adult/racy imagery, so the bar
    // is deliberately low — a false positive (blocking a genuinely safe
    // photo) is a far smaller cost than a false negative here.
    if (adultRank >= LIKELIHOOD_RANK.POSSIBLE) {
      console.warn("MODERATION: REJECTED for adult content, rank:", annotation.adult);
      return { passed: false, needsReview: false, reason: "adult_content_detected", raw: annotation };
    }
    if (racyRank >= LIKELIHOOD_RANK.POSSIBLE) {
      console.warn("MODERATION: REJECTED for racy content, rank:", annotation.racy);
      return { passed: false, needsReview: false, reason: "racy_content_detected", raw: annotation };
    }
    // Violence: reject at LIKELY or above, keeping a slightly looser bar
    // since it has more legitimate borderline cases than adult content.
    if (violenceRank >= LIKELIHOOD_RANK.LIKELY) {
      console.warn("MODERATION: REJECTED for violent content, rank:", annotation.violence);
      return { passed: false, needsReview: false, reason: "violent_content_detected", raw: annotation };
    }

    console.log("MODERATION: image passed all checks.");
    return { passed: true, needsReview: false, reason: null, raw: annotation };
  } catch (err) {
    console.error("MODERATION ALERT: checkImage threw an exception:", err.message, err.stack);
    // Fail CLOSED on unexpected errors too, given the stakes.
    return { passed: false, needsReview: true, reason: "moderation_check_failed", raw: null };
  }
}

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

export async function saveModerationFlags(env, contentId, flags) {
  if (!flags.length) return;
  const inserts = flags.map((flag) =>
    env.DB.prepare(
      "INSERT INTO moderation_queue (profile_id, check_type, field_name, flagged_value, auto_score, status) VALUES (?, ?, ?, ?, ?, 'open')"
    ).bind(contentId, flag.checkType, flag.fieldName, flag.flaggedValue, flag.autoScore || null)
  );
  await env.DB.batch(inserts);
}

export function getReadableRejectionMessage(reason) {
  const messages = {
    adult_content_detected: "This image can't be used — it appears to contain adult content. Please choose a different photo.",
    violent_content_detected: "This image can't be used — it appears to contain graphic or violent content. Please choose a different photo.",
    racy_content_detected: "This image can't be used — it doesn't meet our content guidelines. Please choose a different photo.",
    moderation_unavailable: "We couldn't verify this image right now. Please try uploading again in a moment.",
    moderation_no_result: "We couldn't verify this image right now. Please try uploading again in a moment.",
    moderation_check_failed: "We couldn't verify this image right now. Please try uploading again in a moment."
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
