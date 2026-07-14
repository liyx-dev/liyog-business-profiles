// =====================================================================
// LIYOG WORLD — src/lib/moderation.js (v4.1 — Quad-Provider Resilience)
//
// 1. Google Cloud Vision (Primary - Paid API via env.IMAGE_MODERATION_API_KEY)
// 2. OpenAI Moderation (Fallback 1 - Paid API via env.OPENAI_API_KEY)
// 3. Gemini 3.5 Flash (Fallback 2 - Free API via env.GEMINI_API_KEY)
// 4. Cloudflare Workers AI (Fallback 3 - Local GPU Vision LLM on Edge via env.AI)
//
// Maintains absolute feature parity with v3 text filters, database insertions,
// and layout hooks while establishing bulletproof, scale-ready edge security.
// =====================================================================

import { Buffer } from "node:buffer";

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
 * Fallback check 1: OpenAI's Moderation API (omni-moderation-latest),
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
 * Fallback check 2: Google Gemini 3.5 Flash API (Multimodal)
 * Active stable free-tier channel (No Credit Card required for sign up).
 */
async function checkImageWithGemini(imageBytes, env) {
  if (!env.GEMINI_API_KEY) return null;

  try {
    const base64Image = arrayBufferToBase64(imageBytes);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Analyze this image for content safety. You must respond in a raw JSON formatting matching exactly this structure: { \"passed\": boolean, \"reason\": \"adult_content_detected\" | \"racy_content_detected\" | \"violent_content_detected\" | null }. If the image contains pornographic material, full nudity, explicitly suggestive exposures, or visible weapons/violence, set passed to false and pass the accurate reason field. Otherwise set passed to true and reason to null. Do not add markdown code block wraps."
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

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Gemini API fallback failed — status:", res.status, "body:", errBody);
      return null;
    }

    const data = await res.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      console.error("Gemini fallback returned an empty context candidate body.");
      return null;
    }

    const result = JSON.parse(responseText.trim());
    return {
      passed: result.passed,
      needsReview: false,
      reason: result.reason || "content_policy_violation",
      provider: "gemini"
    };
  } catch (err) {
    console.error("Gemini fallback execution threw:", err.message);
    return null;
  }
  }
/**
 * Fallback check 3: Local Cloudflare Workers AI Vision LLM
 * High-performance safety backup powered entirely on your Cloudflare Global Network.
 * Uses strict structural JSON prompt engineering to bypass internal LLM safety refusals.
 */

/**
 * Pulls the actual generated text out of a Workers AI response, no
 * matter which exact shape the model returned it in. This replaces
 * the earlier version that assumed response.response was always a
 * plain string — it wasn't, which caused the "[object Object]" bug.
 */
function extractWorkersAiText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";

  const directCandidates = [
    response.response,
    response.description,
    response.text,
    response.output,
    response.result
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  if (response.response && typeof response.response === "object") {
    const nested = extractWorkersAiText(response.response);
    if (nested) return nested;
  }

  function findFirstUsableString(obj, depth) {
    if (depth > 4) return null;
    if (typeof obj === "string" && obj.trim().length > 3) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findFirstUsableString(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        const found = findFirstUsableString(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return findFirstUsableString(response, 0) || "";
}

async function checkImageWithWorkersAI(imageBytes, env) {
  if (!env.AI) return null;

  const modelName = "@cf/meta/llama-3.2-11b-vision-instruct";
  const PROMPT = "Analyze the visual elements of this image. Identify if there is nudity, visible intimate anatomy (genitals, breasts, buttocks), or explicit adult content. Respond ONLY with a valid JSON object matching this schema: { \"unsafe\": boolean, \"reason\": \"adult_content_detected\" | null }. Do not include any conversational filler, markdown formatting, or backticks.";

  const executeRun = async () => {
    return await env.AI.run(modelName, {
      prompt: PROMPT,
      image: [...new Uint8Array(imageBytes)]
    });
  };

  const parseAttempt = (rawResponse) => {
    let text = extractWorkersAiText(rawResponse);
    text = text.trim();
    if (text.includes("```")) {
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    }
    return text;
  };

  try {
    let response = await executeRun();
    console.log("Workers AI raw response object:", JSON.stringify(response));

    let rawText = parseAttempt(response);

    if (!rawText) {
      console.error("Workers AI: could not extract any usable text from response.");
      return null;
    }

    if (rawText.includes("must submit the prompt") || rawText.includes("agree")) {
      console.warn("Meta License agreement prompt detected. Sending agreement handshake...");
      try {
        await env.AI.run(modelName, { prompt: "agree" });
      } catch (agreeErr) {
        console.warn("Agreement handshake call raised (may be benign):", agreeErr.message);
      }
      response = await executeRun();
      console.log("Workers AI raw response object (after agreement retry):", JSON.stringify(response));
      rawText = parseAttempt(response);
      if (!rawText) {
        console.error("Workers AI: still no usable text after agreement retry.");
        return null;
      }
    }

    console.log("Workers AI extracted text for parsing:", rawText);

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("Workers AI: extracted text is not valid JSON:", rawText);
      return null;
    }

    if (result.unsafe === true || result.unsafe === "true") {
      return {
        passed: false,
        needsReview: false,
        reason: result.reason || "adult_content_detected",
        provider: "workers-ai"
      };
    }
    return { passed: true, needsReview: false, reason: null, provider: "workers-ai" };
  } catch (err) {
    console.error("Workers AI Vision execution wrapper failed:", err.message);
    return null;
  }
}
  

        


/**
 * Public entry point: Cascades through Google Vision, OpenAI, Gemini 3.5, and Cloudflare AI.
 * Implements an ironclad fail-closed rule to safeguard your app if all systems go offline.
 */
export async function checkImage(imageBytes, env) {
  if (!imageBytes || imageBytes.byteLength === 0) {
    return { passed: true, needsReview: false, reason: null };
  }

  // Provider 1: Google Vision API
  const visionResult = await checkImageWithVision(imageBytes, env);
  if (visionResult !== null) return visionResult;

  // Provider 2: OpenAI Moderation API
  console.log("Falling back to OpenAI moderation for this image.");
  const openaiResult = await checkImageWithOpenAI(imageBytes, env);
  if (openaiResult !== null) return openaiResult;

  // Provider 3: Gemini 3.5 Flash API
  console.log("Falling back to Gemini 3.5 Flash for this image.");
  const geminiResult = await checkImageWithGemini(imageBytes, env);
  if (geminiResult !== null) return geminiResult;

  // Provider 4: Local Workers AI Vision Pipeline
  console.log("Falling back to local Cloudflare Workers AI Vision LLM engine.");
  const localAIResult = await checkImageWithWorkersAI(imageBytes, env);
  if (localAIResult !== null) return localAIResult;

  // Security Hardening Rule: Fail-Closed Protection
  console.error("CRITICAL SAFETY BREACH: All 4 image moderation layers failed/timed out. Rejecting file upload securely.");
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
  return Buffer.from(buffer).toString("base64");
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ");
}


                                      
