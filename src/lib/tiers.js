// =====================================================================
// LIYOG WORLD — src/lib/tiers.js
// Product-tier upgrade system: country-aware pricing, Paystack checkout
// (redirect flow) + manual fallback. New, additive file — does not
// modify any existing module.
//
// A tier purchase is PERMANENT (one-time payment, no expiry) — unlike
// boost.js's boost_log rows, there is no expires_at here. Buying a
// tier replaces the profile's max_products outright and independently
// unlocks product listing (no referral needed), matching the two
// separate paths: "refer to unlock" (free) vs "upgrade to unlock" (paid).
// =====================================================================

// Paystack natively settles these currencies today. Any country code
// not in this list falls back to the 'USD' pricing row below — this
// list is the single source of truth for that fallback decision, so
// update it here (not scattered across the file) if Paystack adds a
// new supported country later.
const PAYSTACK_COUNTRIES = {
  NG: "NGN",
  GH: "GHS",
  ZA: "ZAR",
  KE: "KES"
};

const TIER_IDS = ["tier1", "tier2", "tier3", "tier4"];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Resolves which country_code row to price against. request.cf.country
 * is Cloudflare's free, edge-level geo lookup — no extra API call, no
 * user-provided location needed. Falls back to 'USD' whenever the
 * detected country isn't a Paystack-native one, or when cf data is
 * unavailable (e.g. local dev / some request types don't populate it).
 */
function resolveCountry(request) {
  const detected = request.cf && request.cf.country;
  if (detected && PAYSTACK_COUNTRIES[detected]) return detected;
  return "USD";
}

/**
 * GET /api/tiers/pricing — public. Returns all four tiers priced for
 * the requesting visitor's detected country (or USD fallback), so the
 * frontend never has to know currency logic itself — just render what
 * comes back.
 */
export async function handleGetPricing(request, env) {
  const countryCode = resolveCountry(request);

  const { results } = await env.DB.prepare(
    "SELECT tier_id, country_code, currency, amount, max_products FROM tier_pricing WHERE country_code = ?"
  ).bind(countryCode).all();

  // Guard: if for some reason this country has no pricing rows at all
  // (e.g. USD fallback rows haven't been seeded yet), don't 500 — just
  // return an empty list so the frontend can show a friendly message
  // instead of breaking.
  const byTier = {};
  for (const row of results) byTier[row.tier_id] = row;

  const tiers = TIER_IDS.map((id) => byTier[id]).filter(Boolean);

  return jsonResponse({ countryCode, tiers });
}

/**
 * POST /api/tiers/checkout — authenticated. Creates a 'pending'
 * tier_purchases row and, for the Paystack method, initializes a
 * Paystack transaction and returns the hosted checkout URL to redirect
 * the browser to. For manual method, just returns the pending purchase
 * details so the frontend can build the WhatsApp handoff message —
 * mirroring boost.js's manual pattern exactly.
 */
export async function handleCheckout(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const { profile_id, tier_id, method } = body;

  if (!profile_id || !tier_id || !TIER_IDS.includes(tier_id)) {
    return jsonResponse({ error: "Invalid tier selection." }, 400);
  }
  if (method !== "paystack" && method !== "manual") {
    return jsonResponse({ error: "Invalid payment method." }, 400);
  }

  const { results: profileRows } = await env.DB.prepare(
    "SELECT id, owner_id, business_name, slug FROM profiles WHERE id = ?"
  ).bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  if (profileRows[0].owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);
  const profile = profileRows[0];

  const countryCode = resolveCountry(request);
  const { results: priceRows } = await env.DB.prepare(
    "SELECT * FROM tier_pricing WHERE tier_id = ? AND country_code = ?"
  ).bind(tier_id, countryCode).all();
  if (!priceRows.length) return jsonResponse({ error: "Pricing not available for this tier right now." }, 400);
  const price = priceRows[0];

  const purchaseId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO tier_purchases (id, profile_id, tier_id, country_code, currency, amount, method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(purchaseId, profile_id, tier_id, price.country_code, price.currency, price.amount, method).run();

  if (method === "manual") {
    return jsonResponse({
      success: true,
      method: "manual",
      purchase: {
        id: purchaseId,
        tierId: tier_id,
        maxProducts: price.max_products,
        currency: price.currency,
        amount: price.amount
      }
    });
  }

  // ---- Paystack redirect flow ----
  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse({ error: "Card payment isn't available right now — please use the manual option." }, 503);
  }

  const { results: userRows } = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).all();
  const email = userRows.length ? userRows[0].email : "no-reply@liyogworld.com";

  const callbackUrl = `${new URL(request.url).origin}/api/tiers/paystack-callback`;

  try {
    const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: price.amount,
        currency: price.currency,
        callback_url: callbackUrl,
        reference: purchaseId, // reuse our purchase id as Paystack's reference — makes verify-lookup trivial
        metadata: {
          profile_id,
          tier_id,
          purchase_id: purchaseId
        }
      })
    });

    const initData = await initRes.json();
    if (!initRes.ok || !initData.status) {
      console.error("Paystack init failed:", JSON.stringify(initData));
      return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
    }

    await env.DB.prepare(
      "UPDATE tier_purchases SET paystack_reference = ? WHERE id = ?"
    ).bind(purchaseId, purchaseId).run();

    return jsonResponse({
      success: true,
      method: "paystack",
      authorizationUrl: initData.data.authorization_url
    });
  } catch (err) {
    console.error("Paystack checkout error:", err);
    return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
  }
}

/**
 * GET /api/tiers/paystack-callback — Paystack redirects the browser
 * here after checkout (success OR user-cancelled). We NEVER trust the
 * redirect itself as proof of payment — always re-verify server-side
 * against Paystack's /transaction/verify endpoint before touching the
 * database. Redirects back to the profile page with a query flag so
 * the frontend can show a toast.
 */
export async function handlePaystackCallback(request, env) {
  const url = new URL(request.url);
  const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");

  const pagePath = await getSettingLocal(env, "blogger_profile_page", "/p/brands.html");
  const redirectBase = new URL(pagePath, url.origin);

  if (!reference) {
    redirectBase.searchParams.set("tier_result", "error");
    return Response.redirect(redirectBase.toString(), 302);
  }

  const result = await verifyAndConfirmPurchase(env, reference);

  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT profile_id FROM tier_purchases WHERE id = ?"
  ).bind(reference).all();
  if (purchaseRows.length) {
    const { results: profileRows } = await env.DB.prepare(
      "SELECT slug FROM profiles WHERE id = ?"
    ).bind(purchaseRows[0].profile_id).all();
    if (profileRows.length) redirectBase.searchParams.set("biz", profileRows[0].slug);
  }

  redirectBase.searchParams.set("tier_result", result.success ? "success" : "error");
  return Response.redirect(redirectBase.toString(), 302);
}

/**
 * POST /api/tiers/paystack-webhook — Paystack's server-to-server
 * webhook, the reliable confirmation path (the browser callback above
 * can be closed/interrupted by the user before it fires; the webhook
 * fires regardless). Verifies the signature, then re-verifies the
 * transaction server-side the same as the callback path before
 * crediting anything — belt and suspenders.
 */
export async function handlePaystackWebhook(request, env) {
  if (!env.PAYSTACK_SECRET_KEY) return new Response("Not configured", { status: 503 });

  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");

  const expectedSig = await hmacSha512Hex(env.PAYSTACK_SECRET_KEY, rawBody);
  if (!signature || signature !== expectedSig) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return new Response("Bad payload", { status: 400 }); }

  if (event.event === "charge.success" && event.data && event.data.reference) {
    await verifyAndConfirmPurchase(env, event.data.reference);
  }

  return new Response("ok", { status: 200 });
}

/**
 * Shared verify-then-confirm logic used by both the callback and the
 * webhook path. Idempotent — if the purchase is already 'confirmed'
 * (e.g. webhook fires, then the callback also lands), it's a no-op on
 * the second call rather than double-applying the tier.
 */
async function verifyAndConfirmPurchase(env, reference) {
  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT * FROM tier_purchases WHERE id = ?"
  ).bind(reference).all();
  if (!purchaseRows.length) return { success: false, reason: "not_found" };
  const purchase = purchaseRows[0];

  if (purchase.status === "confirmed") return { success: true, alreadyConfirmed: true };

  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { "Authorization": `Bearer ${env.PAYSTACK_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();

    const paidOk =
      verifyRes.ok &&
      verifyData.status &&
      verifyData.data &&
      verifyData.data.status === "success" &&
      verifyData.data.amount === purchase.amount &&
      verifyData.data.currency === purchase.currency;

    if (!paidOk) {
      await env.DB.prepare(
        "UPDATE tier_purchases SET status = 'failed' WHERE id = ?"
      ).bind(reference).run();
      return { success: false, reason: "verification_failed" };
    }

    await applyConfirmedTier(env, purchase);
    return { success: true };
  } catch (err) {
    console.error("Paystack verify error:", err);
    return { success: false, reason: "error" };
  }
}

/**
 * Actually grants the tier: marks the purchase confirmed and updates
 * the profile's tier_id + max_products in one batch. Replaces the cap
 * outright (per the product decision: one-time payment, no stacking).
 */
async function applyConfirmedTier(env, purchase) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE tier_purchases SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?"
    ).bind(purchase.id),
    env.DB.prepare(
      "UPDATE profiles SET tier_id = ?, max_products = ? WHERE id = ?"
    ).bind(purchase.tier_id, await getTierMaxProducts(env, purchase.tier_id, purchase.country_code), purchase.profile_id)
  ]);
}

async function getTierMaxProducts(env, tierId, countryCode) {
  const { results } = await env.DB.prepare(
    "SELECT max_products FROM tier_pricing WHERE tier_id = ? AND country_code = ?"
  ).bind(tierId, countryCode).all();
  return results.length ? results[0].max_products : 10;
}

/**
 * POST /api/tiers/activate — admin-only manual confirmation, exact
 * same guard pattern as boost.js's handleActivateBoost. You call this
 * yourself after confirming payment via WhatsApp for a 'manual'
 * purchase row.
 */
export async function handleActivateTier(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const { purchase_id } = body;
  if (!purchase_id) return jsonResponse({ error: "purchase_id is required." }, 400);

  const { results } = await env.DB.prepare(
    "SELECT * FROM tier_purchases WHERE id = ?"
  ).bind(purchase_id).all();
  if (!results.length) return jsonResponse({ error: "Purchase not found." }, 404);
  const purchase = results[0];

  if (purchase.status === "confirmed") return jsonResponse({ success: true, alreadyConfirmed: true });
  if (purchase.method !== "manual") return jsonResponse({ error: "This purchase isn't a manual one — use Paystack verification instead." }, 400);

  await applyConfirmedTier(env, purchase);
  return jsonResponse({ success: true });
}

/**
 * GET /api/profiles/:id/tier-status — used by the frontend after
 * returning from a Paystack redirect (or just on load) to know the
 * profile's current tier + cap without re-deriving it client-side.
 */
export async function handleTierStatus(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT tier_id, max_products FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!results.length) return jsonResponse({ error: "Profile not found." }, 404);
  return jsonResponse({ tierId: results[0].tier_id, maxProducts: results[0].max_products });
}

// ---------------------------------------------------------------------
// Small local helpers (deliberately not imported from index.js to keep
// this file self-contained/copy-safe, same reasoning as boost.js).
// ---------------------------------------------------------------------

async function getSettingLocal(env, key, fallback) {
  try {
    const { results } = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).all();
    return results.length > 0 ? results[0].value : fallback;
  } catch (err) {
    return fallback;
  }
}

async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}


