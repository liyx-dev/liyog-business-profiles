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

/**
 * Returns the currently-active boost row for a profile (product_id
 * NULL) or a specific product (product_id set), or null if none is
 * active. "Active" means expires_at is in the future — expiry is
 * handled by simply not matching here, no cron/cleanup needed for
 * correctness (your existing 7-day-stale cleanup job just keeps the
 * table tidy, it isn't load-bearing for this check).
 */
export async function getActiveBoost(env, profileId, productId = null) {
  const query = productId
    ? `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND product_id = ? AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`
    : `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND product_id IS NULL AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`;

  const binds = productId ? [profileId, productId] : [profileId];
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return results.length ? results[0] : null;
}

/**
 * GET /api/profiles/:id/boost-status — used by the edit panel to show
 * current boost state (active + expiry) for the profile itself and,
 * optionally, a batch of product ids in one round trip so the Products
 * tab doesn't fire one request per product card.
 */
export async function handleBoostStatus(env, profileId, productIdsParam) {
  const profileBoost = await getActiveBoost(env, profileId, null);

  const productStatuses = {};
  if (productIdsParam) {
    const ids = productIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    for (const pid of ids) {
      productStatuses[pid] = await getActiveBoost(env, profileId, pid);
    }
  }

  return jsonResponse({
    profileBoost,
    productBoosts: productStatuses
  });
}

/**
 * POST /api/boost/activate — NOT called by the customer-facing flow at
 * all. This is the admin-only manual activation endpoint you call
 * yourself (e.g. via a simple authenticated curl/Postman request)
 * after confirming payment via WhatsApp, matching the plan exactly:
 * "you receive that message, confirm payment happened however you
 * like, then manually insert a row into boost_log."
 *
 * Guarded by env.ADMIN_SECRET so it's never reachable by a normal user
 * even if they discover the route.
 */
export async function handleActivateBoost(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json();
  const { profile_id, product_id, days } = body;
  if (!profile_id || !days) {
    return jsonResponse({ error: "profile_id and days are required." }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO boost_log (profile_id, product_id, expires_at)
     VALUES (?, ?, datetime('now', '+' || ? || ' days'))`
  ).bind(profile_id, product_id || null, Number(days)).run();

  return jsonResponse({ success: true });
}
