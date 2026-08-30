// =====================================================================
// LIYOG WORLD — src/lib/boost.js
// Boost status checks + manual activation logging. New, additive file
// — does not modify any existing module. Matches the "manual payment
// first" plan: no payment gateway, just a WhatsApp handoff and a
// manually-inserted boost_log row once payment is confirmed off-platform.
// =====================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// Same Paystack-native-currency list as tiers.js — kept as a separate
// local constant rather than importing across files, matching this
// codebase's existing convention (see tiers.js's own comment on this)
// of each lib file staying self-contained and copy-safe.
const PAYSTACK_COUNTRIES = { NG: "NGN", GH: "GHS", ZA: "ZAR", KE: "KES" };

function resolveCountry(request) {
  const detected = request.cf && request.cf.country;
  if (detected && PAYSTACK_COUNTRIES[detected]) return detected;
  return "USD";
}

/**
 * GET /api/boost/pricing — public. Returns durations priced for the
 * visitor's detected country, filtered to only the tier_group(s)
 * currently unlocked for public use (app_settings.boost_tiers_unlocked
 * — 'extended' at launch, 'all' once every distribution channel is
 * live). Rows are already seeded for micro/standard even while
 * hidden, so unlocking later is a single settings row change with
 * zero schema or code changes needed.
 */
export async function handleGetBoostPricing(request, env) {
  const countryCode = resolveCountry(request);
  const unlockedGroups = await getUnlockedTierGroups(env);

  const { results } = await env.DB.prepare(
    "SELECT * FROM boost_pricing WHERE country_code = ? ORDER BY sort_order ASC"
  ).bind(countryCode).all();

  const durations = results.filter((r) => unlockedGroups.includes(r.tier_group));

  let customDuration = null;
  if (durations.length) {
    const longestDays = Math.max(...durations.map((d) => d.hours)) / 24;
    const maxDays = Number(await getSettingLocal(env, "boost_custom_max_days", "90"));
    customDuration = { minDays: longestDays + 1, maxDays };
  }

  return jsonResponse({ countryCode, durations, customDuration });
}

async function getUnlockedTierGroups(env) {
  const raw = await getSettingLocal(env, "boost_tiers_unlocked", "extended");
  if (raw === "all") return ["micro", "standard", "extended"];
  // Comma-separated list support (e.g. "standard,extended") for a
  // gradual rollout later, not just an all-or-nothing flip.
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Custom duration is now DAYS-based (not hours) and only allowed
 * ABOVE the longest currently-unlocked official tier — e.g. today
 * that's 30 days, so custom starts at 31+. This is deliberate: letting
 * custom start from 1 hour let people route small/cheap boosts through
 * the custom path instead of buying an official tier, undercutting the
 * whole pricing ladder. Restricting custom to "bulk, above the top
 * tier" makes it a genuine enterprise option, not a workaround.
 *
 * The minimum for custom is DERIVED from the longest unlocked tier's
 * day count — never hardcoded — so it self-adjusts the moment a new,
 * longer official tier is added or unlocked. The maximum and the
 * maximum discount percentage are both stored in app_settings, fully
 * admin-controlled without any code change:
 *   boost_custom_max_days          (e.g. "90" for 3 months)
 *   boost_custom_max_discount_pct  (e.g. "35" for up to 35% off)
 *
 * Pricing formula — extrapolated from the longest tier's per-day rate,
 * with a discount that scales from 0% (right at the longest tier's day
 * count) up to the configured max (right at the configured max days):
 *   baseRate = longestTier.amount / longestTier.days
 *   progress = min(1, (customDays - longestTier.days) / (maxDays - longestTier.days))
 *   discount = (maxDiscountPct / 100) * progress
 *   price = ceil(baseRate * (1 - discount) * customDays)
 */
async function computeCustomBoostPrice(env, durations, customDays) {
  const sorted = [...durations].sort((a, b) => a.hours - b.hours);
  if (!sorted.length) return null;

  const longest = sorted[sorted.length - 1];
  const longestDays = longest.hours / 24;

  const maxDays = Number(await getSettingLocal(env, "boost_custom_max_days", "90"));
  const maxDiscountPct = Number(await getSettingLocal(env, "boost_custom_max_discount_pct", "35"));

  if (customDays <= longestDays) return null; // caller must reject — custom is only valid above the top tier

  const baseRate = longest.amount / longestDays;
  const denominator = Math.max(1, maxDays - longestDays); // avoid divide-by-zero if misconfigured
  const progress = Math.min(1, (customDays - longestDays) / denominator);
  const discount = (maxDiscountPct / 100) * progress;
  const effectiveRate = baseRate * (1 - discount);

  return {
    amount: Math.ceil(effectiveRate * customDays),
    minDays: longestDays,
    maxDays
  };
}

/**
 * Returns the currently-active boost row for a given scope, or null if
 * none is active. "Active" means expires_at is in the future — expiry
 * is handled by simply not matching here, no cron/cleanup needed for
 * correctness (the existing stale-row cleanup job just keeps the table
 * tidy, it isn't load-bearing for this check).
 *
 * scope: 'profile' (whole brand profile), 'catalogue' (the all-products
 * page), or 'product' (one specific product — productId required).
 * Profile and catalogue boosts can be active independently and at the
 * same time for the same profile — they're genuinely separate purchases
 * targeting separate surfaces, not mutually exclusive states.
 */
export async function getActiveBoost(env, profileId, scope = "profile", productId = null) {
  const query = scope === "product"
    ? `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = 'product' AND product_id = ? AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`
    : `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = ? AND product_id IS NULL AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`;

  const binds = scope === "product" ? [profileId, productId] : [profileId, scope];
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return results.length ? results[0] : null;
}

/**
 * GET /api/profiles/:id/boost-status — used by the edit panel to show
 * current boost state (active + expiry) for the profile itself, the
 * catalogue (all-products page), and, optionally, a batch of product
 * ids in one round trip so the Products tab doesn't fire one request
 * per product card. Profile and catalogue are reported independently
 * since a profile can have either, both, or neither active at once.
 */
export async function handleBoostStatus(env, profileId, productIdsParam) {
  const profileBoost = await getActiveBoost(env, profileId, "profile");
  const catalogueBoost = await getActiveBoost(env, profileId, "catalogue");

  const productStatuses = {};
  if (productIdsParam) {
    const ids = productIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    for (const pid of ids) {
      productStatuses[pid] = await getActiveBoost(env, profileId, "product", pid);
    }
  }

  return jsonResponse({
    profileBoost,
    catalogueBoost,
    productBoosts: productStatuses
  });
}

/**
 * GET /api/profiles/:id/active-boosts — returns EVERY currently-active
 * boost for a profile in one list (profile + catalogue + every boosted
 * product, with product names joined in), rather than requiring the
 * caller to already know which product ids to check. This is what
 * powers the "Your Active Boosts" summary panel — a single call gets
 * the full picture instead of piecing it together from multiple
 * targeted lookups.
 */
export async function handleActiveBoosts(env, profileId) {
  const { results } = await env.DB.prepare(
    `SELECT bl.id, bl.scope, bl.product_id, bl.boosted_at, bl.expires_at, p.name AS product_name
     FROM boost_log bl
     LEFT JOIN products p ON p.id = bl.product_id
     WHERE bl.profile_id = ? AND bl.expires_at > datetime('now')
     ORDER BY bl.expires_at ASC`
  ).bind(profileId).all();

  return jsonResponse({ boosts: results });
}

/**
 * GET /api/boost-config — public, read-only. Returns the WhatsApp
 * number the boost sheet should message, sourced from app_settings so
 * it's changeable without a redeploy. Falls back to null if not set,
 * in which case the frontend should just skip the wa.me prefill and
 * show a plain instruction instead of a broken link.
 */
export async function handleBoostConfig(env) {
  const { results } = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'admin_whatsapp_number'"
  ).all();
  const number = results.length ? results[0].value : null;
  return jsonResponse({ adminWhatsapp: (number && number !== "REPLACE_WITH_YOUR_NUMBER") ? number : null });
}

/**
 * POST /api/boost/activate — admin-only manual activation, called
 * yourself after confirming payment via WhatsApp for a 'manual'
 * boost_purchases row, OR directly with raw parameters for ad-hoc use.
 * Guarded by env.ADMIN_SECRET so it's never reachable by a normal user
 * even if they discover the route.
 */
export async function handleActivateBoost(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json();
  const { profile_id, product_id, days, scope } = body;
  if (!profile_id || !days) {
    return jsonResponse({ error: "profile_id and days are required." }, 400);
  }

  const resolvedScope = scope || (product_id ? "product" : "profile");

  await env.DB.prepare(
    `INSERT INTO boost_log (profile_id, product_id, scope, expires_at)
     VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'))`
  ).bind(profile_id, product_id || null, resolvedScope, Number(days)).run();

  return jsonResponse({ success: true });
}
// =====================================================================
// Boost checkout — Paystack (NGN-charging, same pattern as tiers.js)
// + manual fallback. Handles all three scopes: profile, catalogue,
// and a single product. Both an official duration_id and a custom
// hour count are supported; exactly one of the two must be provided.
// =====================================================================

/**
 * POST /api/boost/checkout — authenticated, owner-only. Creates a
 * 'pending' boost_purchases row, then either returns a Paystack
 * redirect URL or (for manual) the purchase details for the WhatsApp
 * handoff — mirroring tiers.js's handleCheckout exactly.
 */
export async function handleBoostCheckout(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const { profile_id, scope, product_id, duration_id, custom_hours, custom_days, method } = body;

  if (!profile_id || !scope || !["profile", "catalogue", "product"].includes(scope)) {
    return jsonResponse({ error: "Invalid boost selection." }, 400);
  }
  if (scope === "product" && !product_id) {
    return jsonResponse({ error: "A product must be specified for a product boost." }, 400);
  }
  const hasCustomInput = custom_days != null || custom_hours != null;
  if (!duration_id && !hasCustomInput) {
    return jsonResponse({ error: "Choose a duration." }, 400);
  }
  if (duration_id && hasCustomInput) {
    return jsonResponse({ error: "Choose either a listed duration or a custom one, not both." }, 400);
  }
  if (method !== "paystack" && method !== "manual") {
    return jsonResponse({ error: "Invalid payment method." }, 400);
  }

  const { results: profileRows } = await env.DB.prepare(
    "SELECT id, owner_id, business_name, slug FROM profiles WHERE id = ?"
  ).bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  if (profileRows[0].owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);

  if (scope === "product") {
    const { results: productRows } = await env.DB.prepare(
      "SELECT id FROM products WHERE id = ? AND profile_id = ?"
    ).bind(product_id, profile_id).all();
    if (!productRows.length) return jsonResponse({ error: "Product not found on this profile." }, 404);
  }

  const countryCode = resolveCountry(request);
  const unlockedGroups = await getUnlockedTierGroups(env);
  const { results: allDurations } = await env.DB.prepare(
    "SELECT * FROM boost_pricing WHERE country_code = ? ORDER BY sort_order ASC"
  ).bind(countryCode).all();
  const unlockedDurations = allDurations.filter((d) => unlockedGroups.includes(d.tier_group));

  if (!unlockedDurations.length) {
    return jsonResponse({ error: "Boosting isn't available right now — please check back soon." }, 400);
  }

  let hours, amount, currency, resolvedDurationId, resolvedCustomHours;

  if (duration_id) {
    const match = unlockedDurations.find((d) => d.duration_id === duration_id);
    if (!match) return jsonResponse({ error: "That duration isn't available." }, 400);
    hours = match.hours;
    amount = match.amount;
    currency = match.currency;
    resolvedDurationId = duration_id;
    resolvedCustomHours = null;
  } else {
    // custom_days is the new field name (days, not hours) — custom_hours
    // is still accepted for backward compatibility with any in-flight
    // client that hasn't refreshed yet, but is interpreted as hours/24.
    const customDaysNum = body.custom_days != null
      ? Number(body.custom_days)
      : (custom_hours != null ? Number(custom_hours) / 24 : NaN);

    if (!Number.isFinite(customDaysNum) || customDaysNum <= 0) {
      return jsonResponse({ error: "Enter a valid number of days." }, 400);
    }

    const priced = await computeCustomBoostPrice(env, unlockedDurations, customDaysNum);
    if (!priced) {
      const longestDays = Math.max(...unlockedDurations.map((d) => d.hours)) / 24;
      return jsonResponse({ error: `Custom duration must be more than ${longestDays} days — choose a listed duration for anything shorter.` }, 400);
    }
    if (customDaysNum > priced.maxDays) {
      return jsonResponse({ error: `Custom duration can't exceed ${priced.maxDays} days right now.` }, 400);
    }

    hours = Math.round(customDaysNum * 24);
    amount = priced.amount;
    currency = unlockedDurations[0].currency;
    resolvedDurationId = null;
    resolvedCustomHours = hours;
  }

  const purchaseId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO boost_purchases (id, profile_id, scope, product_id, duration_id, custom_hours, country_code, currency, amount, method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(purchaseId, profile_id, scope, product_id || null, resolvedDurationId, resolvedCustomHours, countryCode, currency, amount, method).run();

  if (method === "manual") {
    return jsonResponse({
      success: true,
      method: "manual",
      purchase: { id: purchaseId, scope, hours, currency, amount }
    });
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse({ error: "Card payment isn't available right now — please use the manual option." }, 503);
  }

  let ngnChargeAmount;
  try {
    ngnChargeAmount = await getBoostNgnChargeAmount(env, { currency, amount, country_code: countryCode });
  } catch (err) {
    console.error("Boost NGN conversion failed:", err);
    return jsonResponse({ error: "Couldn't calculate pricing right now — please use the manual option or try again shortly." }, 502);
  }

  await env.DB.prepare(
    "UPDATE boost_purchases SET ngn_charge_amount = ? WHERE id = ?"
  ).bind(ngnChargeAmount, purchaseId).run();

  const { results: userRows } = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).all();
  const email = userRows.length ? userRows[0].email : "no-reply@liyogworld.com";
  const callbackUrl = `${new URL(request.url).origin}/api/boost/paystack-callback`;

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
        reference: purchaseId,
        metadata: { profile_id, scope, product_id: product_id || null, purchase_id: purchaseId }
      })
    });

    const initData = await initRes.json();
    if (!initRes.ok || !initData.status) {
      console.error("Paystack boost init failed:", JSON.stringify(initData));
      return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
    }

    return jsonResponse({ success: true, method: "paystack", authorizationUrl: initData.data.authorization_url });
  } catch (err) {
    console.error("Paystack boost checkout error:", err);
    return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
  }
}

/**
 * Same three-priority NGN conversion as tiers.js's getNgnChargeAmount
 * (manual override -> live rate -> fixed fallback), reusing the same
 * fx_fallback_rates table tiers.js already populates — one shared
 * exchange-rate source of truth for the whole system, not duplicated
 * per feature.
 */
async function getBoostNgnChargeAmount(env, price) {
  if (price.currency === "NGN") return price.amount;

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${price.currency}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rates && data.rates.NGN) {
        const converted = (price.amount / 100) * data.rates.NGN;
        return roundUpToNearest50(converted * 100);
      }
    }
  } catch (err) {
    console.error(`Live FX lookup failed for ${price.currency}:`, err);
  }

  const { results } = await env.DB.prepare(
    "SELECT ngn_per_unit FROM fx_fallback_rates WHERE currency = ?"
  ).bind(price.currency).all();
  if (results.length) {
    const converted = (price.amount / 100) * results[0].ngn_per_unit;
    return roundUpToNearest50(converted * 100);
  }

  throw new Error(`No NGN conversion available for currency ${price.currency}`);
}

function roundUpToNearest50(amountInKobo) {
  const nairaAmount = amountInKobo / 100;
  const roundedNaira = Math.ceil(nairaAmount / 50) * 50;
  return roundedNaira * 100;
}

/**
 * GET /api/boost/paystack-callback — Paystack redirects the browser
 * here after checkout. Always re-verifies server-side before touching
 * the database, exactly like tiers.js's callback handler.
 */
export async function handleBoostPaystackCallback(request, env) {
  const url = new URL(request.url);
  const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");

  const pagePath = await getSettingLocal(env, "blogger_profile_page", "/p/brands.html");
  const redirectBase = new URL(pagePath, url.origin);

  if (!reference) {
    redirectBase.searchParams.set("boost_result", "error");
    return Response.redirect(redirectBase.toString(), 302);
  }

  const result = await verifyAndConfirmBoostPurchase(env, reference);

  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT profile_id FROM boost_purchases WHERE id = ?"
  ).bind(reference).all();
  if (purchaseRows.length) {
    const { results: profileRows } = await env.DB.prepare(
      "SELECT slug FROM profiles WHERE id = ?"
    ).bind(purchaseRows[0].profile_id).all();
    if (profileRows.length) redirectBase.searchParams.set("biz", profileRows[0].slug);
  }

  redirectBase.searchParams.set("boost_result", result.success ? "success" : "error");
  return Response.redirect(redirectBase.toString(), 302);
}

/**
 * POST /api/boost/paystack-webhook — the reliable server-to-server
 * confirmation path, identical pattern to tiers.js's webhook handler.
 */
export async function handleBoostPaystackWebhook(request, env) {
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
    await verifyAndConfirmBoostPurchase(env, event.data.reference);
  }

  return new Response("ok", { status: 200 });
}

async function verifyAndConfirmBoostPurchase(env, reference) {
  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT * FROM boost_purchases WHERE id = ?"
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
      verifyData.data.amount === purchase.ngn_charge_amount &&
      verifyData.data.currency === "NGN";

    if (!paidOk) {
      await env.DB.prepare("UPDATE boost_purchases SET status = 'failed' WHERE id = ?").bind(reference).run();
      return { success: false, reason: "verification_failed" };
    }

    await applyConfirmedBoost(env, purchase);
    return { success: true };
  } catch (err) {
    console.error("Paystack boost verify error:", err);
    return { success: false, reason: "error" };
  }
}

/**
 * Grants the boost: marks the purchase confirmed and inserts the
 * actual boost_log row that makes badges/sorting go live. Hours come
 * from either the matched official duration or the stored custom
 * value — whichever this purchase used.
 */
async function applyConfirmedBoost(env, purchase) {
  let hours = purchase.custom_hours;
  if (!hours && purchase.duration_id) {
    const { results } = await env.DB.prepare(
      "SELECT hours FROM boost_pricing WHERE duration_id = ? AND country_code = ?"
    ).bind(purchase.duration_id, purchase.country_code).all();
    hours = results.length ? results[0].hours : 24;
  }
  hours = hours || 24;

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE boost_purchases SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?"
    ).bind(purchase.id),
    env.DB.prepare(
      `INSERT INTO boost_log (profile_id, product_id, scope, expires_at)
       VALUES (?, ?, ?, datetime('now', '+' || ? || ' hours'))`
    ).bind(purchase.profile_id, purchase.product_id || null, purchase.scope, hours)
  ]);
}

/**
 * POST /api/boost/manual-activate — admin-only, confirms a MANUAL
 * boost_purchases row (distinct from the raw /api/boost/activate
 * above, which inserts directly without a purchase record — kept for
 * backward compatibility). This is the one to use going forward for
 * anything that came through the WhatsApp handoff, since it carries
 * the full audit trail.
 */
export async function handleActivateBoostPurchase(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const { purchase_id } = body;
  if (!purchase_id) return jsonResponse({ error: "purchase_id is required." }, 400);

  const { results } = await env.DB.prepare(
    "SELECT * FROM boost_purchases WHERE id = ?"
  ).bind(purchase_id).all();
  if (!results.length) return jsonResponse({ error: "Purchase not found." }, 404);
  const purchase = results[0];

  if (purchase.status === "confirmed") return jsonResponse({ success: true, alreadyConfirmed: true });
  if (purchase.method !== "manual") return jsonResponse({ error: "This purchase isn't manual — use Paystack verification instead." }, 400);

  await applyConfirmedBoost(env, purchase);
  return jsonResponse({ success: true });
}

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

