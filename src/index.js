import PROFILE_CSS from "./assets/profile-css.txt";
import PROFILE_JS from "./assets/profile-js.txt";
import PROFILE_TEMPLATE_HTML from "./assets/profile-template.html";
import AUTH_UI_JS from "./assets/auth-ui-js.txt";
import AUTH_UI_CSS from "./assets/auth-ui-css.txt";
import { verifyGoogleToken, findOrCreateUser, createSessionToken, verifySessionToken } from "./lib/auth.js";
import { checkText, saveModerationFlags } from "./lib/moderation.js";

const GOOGLE_CLIENT_ID = "339189715859-r0ieuulq2932t2s4paq0muvmj0mlkln1.apps.googleusercontent.com";

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -----------------------------------------------------------------
    // Static assets
    // -----------------------------------------------------------------
    if (url.pathname === "/brands.css") {
      return new Response(PROFILE_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
    }
    if (url.pathname === "/brands.js") {
      return new Response(PROFILE_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/brands-template.html") {
      return new Response(PROFILE_TEMPLATE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/auth-ui.js") {
      return new Response(AUTH_UI_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/auth-ui.css") {
      return new Response(AUTH_UI_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
    }

    if (url.pathname === "/api/config") {
      const pagePath = await getSetting(env, "blogger_profile_page", "/p/brands.html");
      return jsonResponse({ blogger_profile_page: pagePath, google_client_id: GOOGLE_CLIENT_ID });
    }

    // -----------------------------------------------------------------
    // Auth: sign in with Google — verifies token, creates/finds user,
    // issues a session cookie. This is the single entry point for both
    // "new user signing up" and "returning user logging in" — the
    // distinction only matters for whether they already have a profile.
    // -----------------------------------------------------------------
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      const body = await request.json();
      const payload = await verifyGoogleToken(body.credential, GOOGLE_CLIENT_ID);
      if (!payload) return jsonResponse({ error: "Invalid Google token" }, 401);

      const user = await findOrCreateUser(env, payload, body.marketingOptIn === true);
      const sessionToken = await createSessionToken(env, user.id);

      const { results: existingProfiles } = await env.DB.prepare(
        "SELECT id, slug FROM profiles WHERE owner_id = ?"
      ).bind(user.id).all();

      const response = jsonResponse({
        user: { id: user.id, email: user.email, name: user.display_name, avatar: user.avatar_url },
        profiles: existingProfiles
      });
      response.headers.set(
        "Set-Cookie",
        `liyog_session=${sessionToken}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`
      );
      return response;
    }

    // Returns the current logged-in user (if any) based on session cookie.
    if (url.pathname === "/api/auth/me") {
      const sessionToken = getCookie(request, "liyog_session");
      if (!sessionToken) return jsonResponse({ loggedIn: false });

      const userId = await verifySessionToken(env, sessionToken);
      if (!userId) return jsonResponse({ loggedIn: false });

      const { results } = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).all();
      if (!results.length) return jsonResponse({ loggedIn: false });

      const { results: profiles } = await env.DB.prepare(
        "SELECT id, slug, business_name, moderation_status FROM profiles WHERE owner_id = ?"
      ).bind(userId).all();

      return jsonResponse({
        loggedIn: true,
        user: { id: results[0].id, email: results[0].email, name: results[0].display_name, avatar: results[0].avatar_url },
        profiles
      });
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const response = jsonResponse({ success: true });
      response.headers.set("Set-Cookie", "liyog_session=; Path=/; Max-Age=0");
      return response;
    }

    // -----------------------------------------------------------------
    // Slug availability check — used live while the user types during signup
    // -----------------------------------------------------------------
    if (url.pathname === "/api/check-slug") {
      const slug = (url.searchParams.get("slug") || "").toLowerCase().trim();
      const validFormat = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/.test(slug);
      if (!validFormat) return jsonResponse({ available: false, reason: "invalid_format" });

      const { results: reserved } = await env.DB.prepare(
        "SELECT slug FROM reserved_slugs WHERE slug = ?"
      ).bind(slug).all();
      if (reserved.length) return jsonResponse({ available: false, reason: "reserved" });

      const { results: taken } = await env.DB.prepare(
        "SELECT slug FROM profiles WHERE slug = ?"
      ).bind(slug).all();
      if (taken.length) return jsonResponse({ available: false, reason: "taken" });

      return jsonResponse({ available: true });
    }

    // Returns the allowed business categories, so the signup form never
    // hardcodes a category list that could drift from what's actually valid.
    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(
        "SELECT slug, label FROM business_categories WHERE is_allowed = 1"
      ).all();
      return jsonResponse({ categories: results });
    }

    // -----------------------------------------------------------------
    // Image upload — accepts a compressed WebP blob from the client,
    // stores it in R2, returns the public URL. Client does compression
    // before this ever runs, so this endpoint stays simple and fast.
    // -----------------------------------------------------------------
    if (url.pathname === "/api/upload-image" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("image/webp")) {
        return jsonResponse({ error: "Only WebP images are accepted" }, 400);
      }

      const arrayBuffer = await request.arrayBuffer();
      const sizeInMb = arrayBuffer.byteLength / (1024 * 1024);
      if (sizeInMb > 2) {
        return jsonResponse({ error: "Image too large — please use a smaller image" }, 400);
      }

      // Use an SEO-friendly filename when the client provides one (brand
      // name + field type, e.g. "zion-store-logo"), falling back to a
      // random id if not — never blocks upload on a missing name.
      const requestedName = (url.searchParams.get("name") || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const filename = requestedName ? `${requestedName}-${uniqueSuffix}` : crypto.randomUUID();
      const key = `profile-images/${userId}/${filename}.webp`;
      await env.ASSETS.put(key, arrayBuffer, {
        httpMetadata: { contentType: "image/webp" }
      });

      const publicUrl = `${url.origin}/api/image/${key}`;
      return jsonResponse({ success: true, url: publicUrl });
    }

    // Serves an uploaded image back out of R2.
    if (url.pathname.startsWith("/api/image/")) {
      const key = url.pathname.replace("/api/image/", "");
      const object = await env.ASSETS.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000" }
      });
    }

    // -----------------------------------------------------------------
    // Create a new brand profile — requires a valid session
    // -----------------------------------------------------------------
    if (url.pathname === "/api/profiles" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const body = await request.json();
      const slug = (body.slug || "").toLowerCase().trim();
      const businessName = (body.business_name || "").trim();
      const category = body.business_category;

      if (!slug || !businessName || !category) {
        return jsonResponse({ error: "Missing required fields" }, 400);
      }

      const { results: categoryCheck } = await env.DB.prepare(
        "SELECT slug FROM business_categories WHERE slug = ? AND is_allowed = 1"
      ).bind(category).all();
      if (!categoryCheck.length) return jsonResponse({ error: "Invalid category" }, 400);

      const { results: slugTaken } = await env.DB.prepare(
        "SELECT slug FROM profiles WHERE slug = ? UNION SELECT slug FROM reserved_slugs WHERE slug = ?"
      ).bind(slug, slug).all();
      if (slugTaken.length) return jsonResponse({ error: "Slug already taken" }, 409);

      // Layer 1 moderation gate — text fields only, at profile-creation time.
      const nameCheck = checkText(businessName);
      const taglineCheck = checkText(body.tagline || "");
      const flags = [];
      if (!nameCheck.passed) flags.push({ checkType: "text_auto", fieldName: "business_name", flaggedValue: nameCheck.matchedTerm });
      if (!taglineCheck.passed) flags.push({ checkType: "text_auto", fieldName: "tagline", flaggedValue: taglineCheck.matchedTerm });

      const profileId = crypto.randomUUID();
      const moderationStatus = flags.length > 0 ? "pending" : "approved";

      await env.DB.prepare(
        `INSERT INTO profiles (id, owner_id, slug, business_name, business_category, tagline, moderation_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(profileId, userId, slug, businessName, category, body.tagline || null, moderationStatus).run();

      if (flags.length) await saveModerationFlags(env, profileId, flags);

      return jsonResponse({ success: true, profileId, slug, moderationStatus });
    }

    // -----------------------------------------------------------------
    // Update an existing brand profile — owner-only, re-triggers
    // moderation on any changed text field per the moderation spec.
    // -----------------------------------------------------------------
    if (url.pathname.startsWith("/api/profiles/") && request.method === "PATCH") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const profileId = url.pathname.split("/")[3];
      const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(profileId).all();
      if (!results.length) return jsonResponse({ error: "Profile not found" }, 404);
      if (results[0].owner_id !== userId) return jsonResponse({ error: "Not your profile" }, 403);

      const body = await request.json();
      const editableFields = [
        "business_name", "tagline", "bio_html", "year_established", "whatsapp_number", "wa_message",
        "phone_number", "response_time", "store_address", "store_city", "store_country",
        "map_address", "logo_url", "cover_url", "store_photos", "youtube_url", "key_points",
        "social_facebook", "social_instagram", "social_twitter", "social_tiktok",
        "social_youtube", "social_website"
      ];

      const updates = {};
      const flags = [];
      for (const field of editableFields) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
          if (["business_name", "tagline", "bio_html"].includes(field)) {
            const check = checkText(body[field]);
            if (!check.passed) flags.push({ checkType: "text_auto", fieldName: field, flaggedValue: check.matchedTerm });
          }
        }
      }

      if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400);

      // Any edit re-triggers moderation review, per the original spec:
      // an approved profile that changes its bio/logo shouldn't stay
      // approved on stale content forever.
      const newStatus = flags.length > 0 ? "pending" : "approved";
      updates.moderation_status = newStatus;

      const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(updates);
      await env.DB.prepare(
        `UPDATE profiles SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`
      ).bind(...values, profileId).run();

      if (flags.length) await saveModerationFlags(env, profileId, flags);

      // Delete any R2-hosted images that this update just replaced, so
      // storage doesn't silently accumulate orphaned files over time.
      // Only runs after the DB write succeeds, and only ever deletes
      // files this platform hosts (never touches external URLs).
      ctx.waitUntil(cleanupReplacedImages(env, results[0], updates));

      return jsonResponse({ success: true, moderationStatus: newStatus });
    }

    // -----------------------------------------------------------------
    // Inquiries — the "Send an inquiry" form on a brand profile. Stores
    // sender contact temporarily; the existing scheduled cleanup job
    // deletes rows older than 7 days, per the original privacy design.
    // -----------------------------------------------------------------
    // Owner-only: fetch inquiries sent to a specific profile, most
    // recent first. Requires the requester to actually own the profile.
    if (url.pathname.match(/^\/api\/profiles\/[^/]+\/inquiries$/) && request.method === "GET") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const profileId = url.pathname.split("/")[3];
      const { results: profileRows } = await env.DB.prepare(
        "SELECT owner_id FROM profiles WHERE id = ?"
      ).bind(profileId).all();
      if (!profileRows.length) return jsonResponse({ error: "Profile not found" }, 404);
      if (profileRows[0].owner_id !== userId) return jsonResponse({ error: "Not your profile" }, 403);

      const { results: inquiries } = await env.DB.prepare(
        "SELECT sender_name, sender_contact, message, created_at FROM inquiries WHERE profile_id = ? ORDER BY created_at DESC"
      ).bind(profileId).all();

      return jsonResponse({ inquiries });
    }

    if (url.pathname === "/api/inquiries" && request.method === "POST") {
      const body = await request.json();
      const { profile_id, sender_name, sender_contact, message } = body;

      if (!profile_id || !sender_name || !sender_contact || !message) {
        return jsonResponse({ error: "Please fill in all fields" }, 400);
      }
      if (message.length > 500) {
        return jsonResponse({ error: "Message is too long" }, 400);
      }

      const messageCheck = checkText(message);
      if (!messageCheck.passed) {
        return jsonResponse({ error: "Your message couldn't be sent — please rephrase and try again" }, 400);
      }

      const { results } = await env.DB.prepare(
        "SELECT id FROM profiles WHERE id = ? AND is_active = 1"
      ).bind(profile_id).all();
      if (!results.length) return jsonResponse({ error: "This brand profile is no longer available" }, 404);

      await env.DB.prepare(
        `INSERT INTO inquiries (profile_id, sender_name, sender_contact, message)
         VALUES (?, ?, ?, ?)`
      ).bind(profile_id, sender_name.slice(0, 60), sender_contact.slice(0, 100), message.slice(0, 500)).run();

      return jsonResponse({ success: true });
    }

    // -----------------------------------------------------------------
    // Public profile routes (unchanged from before)
    // -----------------------------------------------------------------
    if (!url.pathname.startsWith("/b/")) {
      return new Response("Not a profile route", { status: 404 });
    }

    const slug = url.pathname.split("/")[2];
    if (!slug) return new Response("Missing profile slug", { status: 400 });

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

    if (results.length === 0) return jsonResponse({ found: false, slug }, 404);

    const profile = results[0];
    if (profile.moderation_status !== "approved") {
      return jsonResponse({ found: true, status: "pending_review", slug });
    }

    profile.is_verified = computeIsVerified(profile) ? 1 : 0;
    ctx.waitUntil(logProfileView(request, env, profile));

    return jsonResponse({ found: true, profile });
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
      env.DB.prepare("DELETE FROM boost_log WHERE expires_at < datetime('now', '-7 days')"),
      env.DB.prepare("DELETE FROM inquiries WHERE created_at < datetime('now', '-7 days')")
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

/**
 * Deletes R2 objects that a profile update just replaced. Compares the
 * old row's image fields against the incoming updates, and for any
 * field that changed, deletes the old file — but ONLY if it's actually
 * hosted on our own domain (via /api/image/), never an external URL,
 * since we can't and shouldn't delete files we don't own.
 */
async function cleanupReplacedImages(env, oldProfile, updates) {
  try {
    const toDelete = [];

    // Single-image fields: logo and cover.
    for (const field of ["logo_url", "cover_url"]) {
      if (updates[field] !== undefined && updates[field] !== oldProfile[field]) {
        const key = extractR2KeyFromUrl(oldProfile[field]);
        if (key) toDelete.push(key);
      }
    }

    // Gallery is an array field — diff old vs new, delete anything
    // present in the old list but missing from the new one.
    if (updates.store_photos !== undefined) {
      const oldPhotos = safeParseArray(oldProfile.store_photos);
      const newPhotos = safeParseArray(updates.store_photos);
      const removedPhotos = oldPhotos.filter((url) => !newPhotos.includes(url));
      for (const url of removedPhotos) {
        const key = extractR2KeyFromUrl(url);
        if (key) toDelete.push(key);
      }
    }

    if (toDelete.length) {
      await Promise.all(toDelete.map((key) => env.ASSETS.delete(key)));
      console.log("Cleaned up orphaned images:", toDelete);
    }
  } catch (err) {
    // Cleanup failing must never affect the profile save itself —
    // worst case is a harmless orphaned file, not a broken update.
    console.error("Image cleanup failed:", err);
  }
}

/**
 * Extracts the R2 object key from one of our own /api/image/... URLs.
 * Returns null for anything else (external URLs, empty values) — we
 * only ever delete files we actually host and control.
 */
function extractR2KeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/api\/image\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
