// =====================================================================
// LIYOG WORLD — src/lib/moderation.js (v3 — dual provider)
// Tries Google Cloud Vision first; if that call fails for ANY reason
// (billing, quota, network, bad key), falls back to OpenAI's
// Moderation API before giving up. Only fails closed (rejects) if
// BOTH providers are unavailable — this is a genuine redundancy
// pattern, not a workaround, since either provider going down
// shouldn't take your entire upload pipeline with it.
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
 * Primary check: Google Cloud Vision SafeSearch.
 * Returns null (not a result) on any failure, so the caller knows to
 * try the fallback provider instead of treating a provider outage as
 * a content verdict.
 */
async function checkImageWithVision(imageBytes, env) {
  if (!env.IMAGE_MODERATION_API_KEY) return null;

  try {
    const base64Image = arrayBufferToBase64(imageBytes);
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${env.IMAGE_MODERATION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content: base64Image }, features: [{ type: "SAFE_SEARCH_DETECTION" }] }]
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Vision API failed, will try fallback provider — status", res.status, "body:", errBody);
      return null;
    }

    const data = await res.json();
    if (data.responses?.[0]?.error) {
      console.error("Vision returned an error object, will try fallback:", JSON.stringify(data.responses[0].error));
      return null;
    }

    const annotation = data.responses?.[0]?.safeSearchAnnotation;
    if (!annotation) {
      console.error("Vision returned no annotation, will try fallback.");
      return null;
    }

    console.log("Vision SafeSearch levels — adult:", annotation.adult, "violence:", annotation.violence, "racy:", annotation.racy);

    const LIKELIHOOD_RANK = { UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5 };
    const rank = (level) => LIKELIHOOD_RANK[level] ?? 5;

    if (rank(annotation.adult) >= LIKELIHOOD_RANK.POSSIBLE) {
      return { passed: false, needsReview: false, reason: "adult_content_detected", provider: "vision" };
    }
    if (rank(annotation.racy) >= LIKELIHOOD_RANK.POSSIBLE) {
      return { passed: false, needsReview: false, reason: "racy_content_detected", provider: "vision" };
    }
    if (rank(annotation.violence) >= LIKELIHOOD_RANK.LIKELY) {
      return { passed: false, needsReview: false, reason: "violent_content_detected", provider: "vision" };
    }
    return { passed: true, needsReview: false, reason: null, provider: "vision" };
  } catch (err) {
    console.error("Vision call threw, will try fallback:", err.message);
    return null;
  }
}

/**
 * Fallback check: OpenAI's Moderation API (omni-moderation-latest),
 * which accepts images directly. Only called if Vision is unavailable.
 */
async function checkImageWithOpenAI(imageBytes, env) {
  if (!env.OPENAI_API_KEY) return null;

  try {
    const base64Image = arrayBufferToBase64(imageBytes);
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [{ type: "image_url", image_url: { url: `data:image/webp;base64,${base64Image}` } }]
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("OpenAI moderation failed — status", res.status, "body:", errBody);
      return null;
    }

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) {
      console.error("OpenAI moderation returned no result.");
      return null;
    }

    console.log("OpenAI moderation categories:", JSON.stringify(result.categories), "scores:", JSON.stringify(result.category_scores));

    if (result.flagged) {
      const flaggedCategory = Object.entries(result.categories).find(([, isFlagged]) => isFlagged)?.[0] || "policy_violation";
      const reasonMap = {
        sexual: "adult_content_detected",
        "sexual/minors": "adult_content_detected",
        violence: "violent_content_detected",
        "violence/graphic": "violent_content_detected"
      };
      return { passed: false, needsReview: false, reason: reasonMap[flaggedCategory] || "content_policy_violation", provider: "openai" };
    }

    return { passed: true, needsReview: false, reason: null, provider: "openai" };
  } catch (err) {
    console.error("OpenAI moderation call threw:", err.message);
    return null;
  }
}

/**
 * Public entry point: tries Vision, falls back to OpenAI, and only
 * fails closed (rejects the upload) if BOTH providers are unavailable —
 * a genuine dual-provider safety net, not a single point of failure.
 */
export async function checkImage(imageBytes, env) {
  if (!imageBytes) return { passed: true, needsReview: false, reason: null };

  const visionResult = await checkImageWithVision(imageBytes, env);
  if (visionResult) return visionResult;

  console.log("Falling back to OpenAI moderation for this image.");
  const openaiResult = await checkImageWithOpenAI(imageBytes, env);
  if (openaiResult) return openaiResult;

  console.error("MODERATION ALERT: both Vision and OpenAI failed — failing closed.");
  return { passed: false, needsReview: true, reason: "moderation_unavailable" };
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
    content_policy_violation: "This image can't be used — it doesn't meet our content guidelines. Please choose a different photo.",
    moderation_unavailable: "We couldn't verify this image right now. Please try uploading again in a moment."
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
