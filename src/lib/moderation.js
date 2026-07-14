// =====================================================================
// LIYOG WORLD — src/lib/moderation.js (v4 — Quad-Layer Resilient System)
// 
// 1. Google Cloud Vision (Primary - Paid API)
// 2. OpenAI Moderation (Fallback 1 - Paid API)
// 3. Gemini 2.5 Flash (Fallback 2 - Free API, No Credit Card Required)
// 4. Cloudflare Workers AI (Fallback 3 - Local GPU Edge Inference)
//
// Fails closed only if ALL 4 checks fail or encounter errors.
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
 * Layer 1 Check: Google Cloud Vision SafeSearch.
 * Returns null on any failure, prompting fallback.
 */
async function checkImageWithVision(imageBytes, env) {
  if (!env.IMAGE_MODERATION_API_KEY) {
    console.warn("Vision API Key missing. Skipping to fallback.");
    return null;
  }

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
      console.error("Vision API failed, trying fallback — status", res.status, "body:", errBody);
      return null;
    }

    const data = await res.json();
    if (data.responses?.[0]?.error) {
      console.error("Vision returned an error object, trying fallback:", JSON.stringify(data.responses[0].error));
      return null;
    }

    const annotation = data.responses?.[0]?.safeSearchAnnotation;
    if (!annotation) {
      console.error("Vision returned no annotation, trying fallback.");
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
    console.error("Vision call threw, trying fallback:", err.message);
    return null;
  }
}

/**
 * Layer 2 Check: OpenAI's Moderation API.
 * Returns null on any failure, prompting fallback.
 */
async function checkImageWithOpenAI(imageBytes, env) {
  if (!env.OPENAI_API_KEY) {
    console.warn("OpenAI API Key missing. Skipping to fallback.");
    return null;
  }

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
      console.error("OpenAI moderation failed, trying fallback — status", res.status, "body:", errBody);
      return null;
    }

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) {
      console.error("OpenAI moderation returned no result.");
      return null;
    }

    console.log("OpenAI moderation categories:", JSON.stringify(result.categories));

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
 * Layer 3 Check: Gemini 2.5 Flash via Google AI Studio.
 * 100% Free Tier (10 RPM / 250 RPD limit), NO credit card required.
 */
async function checkImageWithGemini(imageBytes, env) {
  if (!env.GEMINI_API_KEY) {
    console.warn("Gemini API Key missing. Skipping to fallback.");
    return null;
  }

  try {
    const base64Image = arrayBufferToBase64(imageBytes);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Analyze this image for content safety. Respond ONLY with a valid, raw JSON object using this exact structure: { "passed": boolean, "reason": "adult_content_detected" | "violent_content_detected" | null }. Set "passed" to false and specify the "reason" if the image contains pornography, racy/explicit nudity, graphic violence, weapons, or illegal drug deals. Otherwise, set "passed" to true and "reason" to null. Do not write markdown code formatting.'
              },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini fallback failed — status:", response.status, "body:", errText);
      return null;
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      console.error("Gemini returned an empty response.");
      return null;
    }

    const result = JSON.parse(responseText.trim());
    return {
      passed: result.passed,
      needsReview: false,
      reason: result.reason,
      provider: "gemini"
    };
  } catch (err) {
    console.error("Gemini fallback threw an error:", err.message);
    return null;
  }
}

/**
 * Layer 4 Check: Cloudflare Workers AI.
 * Runs on GPU infrastructure at the Edge. No cold starts, local performance.
 */
async function checkImageWithWorkersAI(imageBytes, env) {
  if (!env.AI) {
    console.warn("Workers AI binding (env.AI) is missing in wrangler.toml.");
    return null;
  }

  try {
    // Converts the raw image binary into an array format accepted by Cloudflare's AI runtime
    const imageArray = [...new Uint8Array(imageBytes)];

    // Uses the high-performance ResNet-50 image classification model
    const response = await env.AI.run("@cf/microsoft/resnet-50", {
      image: imageArray
    });

    if (!response || !Array.isArray(response)) {
      console.error("Workers AI returned an unexpected response format.");
      return null;
    }

    console.log("Workers AI ResNet classifications:", JSON.stringify(response));

    // Common labels for sensitive categories
    const flaggedLabels = [
      "bikini", "undergarment", "swimwear", "brassiere", "weapon", "assault rifle", "revolver"
    ];

    for (const prediction of response) {
      const label = prediction.label.toLowerCase();
      // Flag if matching labels score higher than 45% confidence
      if (flaggedLabels.some(flagged => label.includes(flagged)) && prediction.score > 0.45) {
        console.warn(`Local AI flagged content: ${label} (Confidence: ${prediction.score})`);
        return { 
          passed: false, 
          needsReview: false, 
          reason: "racy_content_detected", 
          provider: "workers-ai" 
        };
      }
    }

    return { passed: true, needsReview: false, reason: null, provider: "workers-ai" };
  } catch (err) {
    console.error("Workers AI call failed:", err.message);
    return null;
  }
}

/**
 * Public Orchestration Gateway
 */
export async function checkImage(imageBytes, env) {
  if (!imageBytes) return { passed: true, needsReview: false, reason: null };

  // Layer 1
  const visionResult = await checkImageWithVision(imageBytes, env);
  if (visionResult) return visionResult;

  // Layer 2
  console.log("Falling back to OpenAI moderation.");
  const openaiResult = await checkImageWithOpenAI(imageBytes, env);
  if (openaiResult) return openaiResult;

  // Layer 3
  console.log("Falling back to Gemini 2.5 Flash.");
  const geminiResult = await checkImageWithGemini(imageBytes, env);
  if (geminiResult) return geminiResult;

  // Layer 4
  console.log("Falling back to local Cloudflare Workers AI edge engine.");
  const localAIResult = await checkImageWithWorkersAI(imageBytes, env);
  if (localAIResult) return localAIResult;

  // Absolute fail-closed safely
  console.error("CRITICAL MODERATION ALERT: All providers failed — failing closed.");
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
