export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/b/")) {
      return new Response("Not a profile route", { status: 404 });
    }

    const slug = url.pathname.split("/")[2];

    if (!slug) {
      return new Response(
        JSON.stringify({ error: "Missing profile slug" }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

    const { results } = await env.DB.prepare(
      "SELECT * FROM profiles WHERE slug = ? AND is_active = 1"
    ).bind(slug).all();

    if (results.length === 0) {
      return new Response(
        JSON.stringify({ found: false, slug }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }

    const profile = results[0];

    if (profile.moderation_status !== "approved") {
      return new Response(
        JSON.stringify({ found: true, status: "pending_review", slug }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Log the view AFTER building the response, so it never delays page load.
    // ctx.waitUntil lets this finish in the background even after we return.
    ctx.waitUntil(logProfileView(request, env, profile));

    return new Response(
      JSON.stringify({ found: true, profile }),
      { headers: { "content-type": "application/json" } }
    );
  }
};

async function logProfileView(request, env, profile) {
  try {
    const url = new URL(request.url);
    const ownerParam = url.searchParams.get("viewer_id"); // set by Blogger script if visitor is logged in
    const isOwnerViewing = ownerParam && ownerParam === profile.owner_id;

    // Don't count the owner viewing their own profile — keeps stats honest.
    if (isOwnerViewing) return;

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ua = request.headers.get("User-Agent") || "unknown";
    const referrer = request.headers.get("Referer") || null;

    // Hash IP+UA instead of storing raw IP — enough to dedupe roughly, no raw PII kept.
    const viewerHash = await sha256(`${ip}:${ua}`);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO profile_views (profile_id, viewer_hash, referrer) VALUES (?, ?, ?)"
      ).bind(profile.id, viewerHash, referrer),
      env.DB.prepare(
        "UPDATE profiles SET profile_views = profile_views + 1 WHERE id = ?"
      ).bind(profile.id)
    ]);
  } catch (err) {
    // View tracking must never break the actual page response.
    console.error("View logging failed:", err);
  }
}

async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
