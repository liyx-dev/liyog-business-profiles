import PROFILE_CSS from "./assets/profile-css.txt";
import PROFILE_JS from "./assets/profile-js.txt";
import PROFILE_TEMPLATE_HTML from "./assets/profile-template.html";

// A profile earns the verified badge once it has been on the platform
// for at least 7 days AND has filled in the fields that matter for
// trust: logo, cover, tagline, bio, at least one contact method, and
// at least one gallery photo. This runs on every read rather than a
// stored flag alone, so a profile that later removes key info loses
// the badge automatically rather than keeping it stale forever.
function computeIsVerified(profile) {
  const daysSinceCreated = (Date.now() - new Date(profile.created_at.replace(" ", "T") + "Z").getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreated < 7) return false;
  if (profile.moderation_status !== "approved") return false;

  const hasContact = !!(profile.whatsapp_number || profile.phone_number);
  const hasMedia = !!profile.logo_url && !!profile.cover_url;
  const hasContent = !!profile.tagline && !!profile.bio_html;
  const photos = safeParseArray(profile.store_photos);
  const hasGallery = photos.length > 0;

  return hasContact && hasMedia && hasContent && hasGallery;
}

function safeParseArray(val) {
  try { const parsed = JSON.parse(val || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/brands.css") {
      return new Response(PROFILE_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
    }
    if (url.pathname === "/brands.js") {
      return new Response(PROFILE_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/brands-template.html") {
      return new Response(PROFILE_TEMPLATE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/config") {
      const pagePath = await getSetting(env, "blogger_profile_page", "/p/brands.html");
      return new Response(
        JSON.stringify({ blogger_profile_page: pagePath }),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (!url.pathname.startsWith("/b/")) {
      return new Response("Not a profile route", { status: 404 });
    }

    const slug = url.pathname.split("/")[2];

    if (!slug) {
      return new Response("Missing profile slug", { status: 400 });
    }

    const wantsJson = url.searchParams.get("format") === "json";

    if (!wantsJson) {
      const pagePath = await getSetting(env, "blogger_profile_page", "/p/brands.html");
      const redirectUrl = new URL(pagePath, url.origin);
      redirectUrl.searchParams.set("biz", slug);
      return Response.redirect(redirectUrl.toString(), 302);
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

    // Compute verification status live on every read (see comment above
    // computeIsVerified for why this isn't just a static stored flag).
    profile.is_verified = computeIsVerified(profile) ? 1 : 0;

    ctx.waitUntil(logProfileView(request, env, profile));

    return new Response(
      JSON.stringify({ found: true, profile }),
      { headers: { "content-type": "application/json" } }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldLogs(env));
  }
};

async function cleanupOldLogs(env) {
  try {
    const result = await env.DB.batch([
      env.DB.prepare("DELETE FROM profile_views WHERE viewed_at < datetime('now', '-30 days')"),
      env.DB.prepare("DELETE FROM share_events WHERE shared_at < datetime('now', '-90 days')"),
      env.DB.prepare("DELETE FROM boost_log WHERE expires_at < datetime('now', '-7 days')")
    ]);
    console.log("Cleanup complete:", JSON.stringify(result.map(r => r.meta)));
  } catch (err) {
    console.error("Scheduled cleanup failed:", err);
  }
}

async function logProfileView(request, env, profile) {
  try {
    const url = new URL(request.url);
    const ownerParam = url.searchParams.get("viewer_id");
    const isOwnerViewing = ownerParam && ownerParam === profile.owner_id;
    if (isOwnerViewing) return;

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ua = request.headers.get("User-Agent") || "unknown";
    const referrer = request.headers.get("Referer") || null;
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
    console.error("View logging failed:", err);
  }
}

async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getSetting(env, key, fallback) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = ?"
    ).bind(key).all();
    return results.length > 0 ? results[0].value : fallback;
  } catch (err) {
    console.error("getSetting failed:", err);
    return fallback;
  }
}
