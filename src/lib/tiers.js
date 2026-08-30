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

/**
 * Your Paystack account currently only settles in NGN — this is a
 * per-account setting on Paystack's side (tied to business
 * verification tier), not something this code can change. So every
 * Paystack charge, regardless of the visitor's country, is always
 * initialized in NGN. What the visitor SEES (local currency, from
 * tier_pricing) and what gets ACTUALLY CHARGED (NGN, from this
 * function) are deliberately decoupled — card networks handle the
 * customer-side conversion automatically at checkout, the same way
 * many international sites charge a single settlement currency while
 * displaying local-feeling prices.
 *
 * Priority order for determining the NGN amount to charge:
 *   1. tier_pricing.ngn_amount, if explicitly set — a manual override
 *      for exact psychological pricing control (e.g. "always exactly
 *      ₦4,800 for this tier/country, regardless of live rates").
 *   2. A live exchange rate lookup, converting the local amount to
 *      NGN, then rounded to a clean denomination.
 *   3. If the live rate lookup fails for any reason (network issue,
 *      provider down, rate-limited) — a fixed fallback rate stored in
 *      D1 (fx_fallback_rates), so checkout NEVER hard-fails just
 *      because a third-party forex API had a bad moment. This table
 *      should be updated periodically (weekly/monthly is plenty) —
 *      it's a safety net, not meant to track live markets.
 *
 * Rounding: always ROUNDS UP to the nearest ₦50. Never round down —
 * a small buffer protects your margin against rate drift between
 * when a price was set and when someone actually pays, and clean
 * multiples of 50 read as an intentional price, not a conversion
 * artifact.
 */
async function getNgnChargeAmount(env, price) {
  // Local currency IS Naira already — no conversion needed, use the
  // display amount directly as the charge amount.
  if (price.currency === "NGN") return price.amount;

  // Priority 1: explicit manual override.
  if (price.ngn_amount != null) return price.ngn_amount;

  // Priority 2: live rate.
  try {
    const liveRate = await fetchLiveNgnRate(price.currency);
    if (liveRate) {
      const converted = (price.amount / 100) * liveRate; // price.amount is in minor units (kobo/cents)
      return roundUpToNearest50(converted * 100); // back to kobo
    }
  } catch (err) {
    console.error(`Live FX lookup failed for ${price.currency}:`, err);
  }

  // Priority 3: fixed fallback rate stored in D1.
  const { results } = await env.DB.prepare(
    "SELECT ngn_per_unit FROM fx_fallback_rates WHERE currency = ?"
  ).bind(price.currency).all();
  if (results.length) {
    const converted = (price.amount / 100) * results[0].ngn_per_unit;
    return roundUpToNearest50(converted * 100);
  }

  // Nothing worked — this only happens if a currency has neither a
  // manual override, a live rate, nor a fallback row. Fail loudly
  // rather than silently charging something wrong.
  throw new Error(`No NGN conversion available for currency ${price.currency}`);
}

function roundUpToNearest50(amountInKobo) {
  const nairaAmount = amountInKobo / 100;
  const roundedNaira = Math.ceil(nairaAmount / 50) * 50;
  return roundedNaira * 100; // back to kobo for Paystack
}

/**
 * Live exchange rate lookup. Uses exchangerate-api.com's free
 * endpoint (no API key required for the base 'latest' tier) —
 * swap this out for a paid/keyed provider if you need higher
 * reliability or rate limits later; the rest of the system doesn't
 * care which provider this function uses internally.
 */
async function fetchLiveNgnRate(fromCurrency) {
  const res = await fetch(`https://open.er-api.com/v6/latest/${fromCurrency}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.rates || !data.rates.NGN) return null;
  return data.rates.NGN;
}

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

  // Flag the highest tier and give every tier an explicit rank (its
  // position in TIER_IDS) so the frontend can compare "is this tier
  // above/below the one the user already has" without ever hardcoding
  // tier names or count — adding tier5 to TIER_IDS is the only change
  // needed anywhere in the system for ranking to stay correct.
  tiers.forEach((t, i) => {
    t.isLast = i === tiers.length - 1;
    t.rank = i;
  });

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

  // Your Paystack account only settles in NGN today, regardless of
  // what currency was DISPLAYED to the visitor above — see
  // getNgnChargeAmount's doc comment for the full reasoning. The
  // purchase row's `currency`/`amount` columns stay as the display
  // values (what the person saw and agreed to); `ngn_charge_amount`
  // records what was ACTUALLY sent to Paystack, so verification later
  // checks the right number regardless of which one a bug might
  // otherwise confuse.
  let ngnChargeAmount;
  try {
    ngnChargeAmount = await getNgnChargeAmount(env, price);
  } catch (err) {
    console.error("NGN conversion failed:", err);
    return jsonResponse({ error: "Couldn't calculate pricing right now — please use the manual option or try again shortly." }, 502);
  }

  await env.DB.prepare(
    "UPDATE tier_purchases SET ngn_charge_amount = ? WHERE id = ?"
  ).bind(ngnChargeAmount, purchaseId).run();

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
        amount: ngnChargeAmount,
        currency: "NGN",
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

    // Every Paystack charge is initialized in NGN regardless of the
    // display currency shown to the visitor (see getNgnChargeAmount),
    // so verification must check against ngn_charge_amount + "NGN" —
    // NOT purchase.amount/purchase.currency, which hold the display
    // values the person saw (e.g. GHS) and would never match what
    // Paystack actually processed.
    const paidOk =
      verifyRes.ok &&
      verifyData.status &&
      verifyData.data &&
      verifyData.data.status === "success" &&
      verifyData.data.amount === purchase.ngn_charge_amount &&
      verifyData.data.currency === "NGN";

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
  // This fallback should realistically never fire — it only matters if
  // a tier_pricing row is missing for a tier/country that a purchase
  // was somehow confirmed against. 1 (not 10) matches the system's
  // free-tier baseline everywhere else, so a confirmed-but-misconfigured
  // purchase never accidentally grants more than the safest default.
  return results.length ? results[0].max_products : 1;
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

