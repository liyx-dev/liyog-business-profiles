import PROFILE_CSS from "./assets/profile-css.txt";
import PROFILE_JS from "./assets/profile-js.txt";
import PROFILE_TEMPLATE_HTML from "./assets/profile-template.html";
import AUTH_UI_JS from "./assets/auth-ui-js.txt";
import AUTH_UI_CSS from "./assets/auth-ui-css.txt";
import REVIEWS_UI_JS from "./assets/reviews-ui-js.txt";
import { verifyGoogleToken, findOrCreateUser, createSessionToken, verifySessionToken } from "./lib/auth.js";
import { checkText, checkImage, saveModerationFlags, getReadableRejectionMessage } from "./lib/moderation.js";
import * as reviews from "./lib/reviews.js";
import { handleCreateProduct, handleUpdateProduct, handleDeleteProduct, handleListProducts, handleUploadProductImage } from "./lib/products.js";
import * as productsEngagement from "./lib/products-engagement.js";
import { maybeCreditReferral, getMyReferrals } from "./lib/referral.js";
import { handleBoostStatus, handleActivateBoost, handleBoostConfig } from "./lib/boost.js";
import { parseRichText, stripRichTextSyntax, RICHTEXT_MAX_LENGTH } from "./lib/richtext.js";

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

/**
 * Parses a contact string (phone or email) and returns a clean, clickable action URL.
 * Automatically handles WhatsApp formatting or mailto syntax.
 */
function formatContactLink(contact) {
  if (!contact) return "";
  const trimmed = contact.trim();
  
  // Simple check: if it contains '@' and looks like an email, use mailto
  if (trimmed.includes("@") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return `mailto:${trimmed}`;
  }
  
  // Treat as phone number / WhatsApp link
  // Strip non-numeric characters except +
  const numericOnly = trimmed.replace(/[^\d+]/g, "");
  // Ensure we have a valid country code (clean leading 0s for WhatsApp direct links if necessary)
  let cleanNumber = numericOnly;
  if (cleanNumber.startsWith("0") && !cleanNumber.startsWith("+")) {
    // If it starts with 0 (typical for local Nigerian numbers) we assume country prefix +234
    cleanNumber = "234" + cleanNumber.slice(1);
  } else if (cleanNumber.startsWith("+")) {
    cleanNumber = cleanNumber.replace("+", "");
  }
  
  return `https://wa.me/${cleanNumber}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -----------------------------------------------------------------
    // Static assets
    //
    // NOTE: These are served with an explicit "no-store" Cache-Control
    // header. Without it, Cloudflare's edge commonly caches .css/.js
    // responses by file extension regardless of what the Worker sends,
    // independent of any browser-side hard refresh — so a real deploy
    // can silently keep serving a stale asset to visitors. If that
    // matters more than always-fresh assets (e.g. traffic grows and the
    // extra origin hits become a cost/latency concern), replace
    // "no-store" with a short max-age plus a cache-busting version
    // query param on the <link>/<script> tags in the Blogger template
    // instead of removing this header outright.
    // -----------------------------------------------------------------
    const NO_CACHE_HEADERS = { "cache-control": "no-store" };
    if (url.pathname === "/brands.css") {
      return new Response(PROFILE_CSS, { headers: { "content-type": "text/css; charset=utf-8", ...NO_CACHE_HEADERS } });
    }
    if (url.pathname === "/brands.js") {
      return new Response(PROFILE_JS, { headers: { "content-type": "application/javascript; charset=utf-8", ...NO_CACHE_HEADERS } });
    }
if (url.pathname === "/reviews-ui.js") {
      return new Response(REVIEWS_UI_JS, { headers: { "content-type": "application/javascript; charset=utf-8", ...NO_CACHE_HEADERS } });
    }
    if (url.pathname === "/brands-template.html") {
      return new Response(PROFILE_TEMPLATE_HTML, { headers: { "content-type": "text/html; charset=utf-8", ...NO_CACHE_HEADERS } });
    }
    if (url.pathname === "/auth-ui.js") {
      return new Response(AUTH_UI_JS, { headers: { "content-type": "application/javascript; charset=utf-8", ...NO_CACHE_HEADERS } });
    }
    if (url.pathname === "/auth-ui.css") {
      return new Response(AUTH_UI_CSS, { headers: { "content-type": "text/css; charset=utf-8", ...NO_CACHE_HEADERS } });
    }

    if (url.pathname === "/api/config") {
      const pagePath = await getSetting(env, "blogger_profile_page", "/p/brands.html");
      return jsonResponse({ blogger_profile_page: pagePath, google_client_id: GOOGLE_CLIENT_ID });
    }

    // -----------------------------------------------------------------
    // Auth: sign in with Google
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

    // Returns the current logged-in user
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

    // Slug availability check
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

    // Categories endpoint
    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(
        "SELECT slug, label FROM business_categories WHERE is_allowed = 1"
      ).all();
      return jsonResponse({ categories: results });
    }

    // -----------------------------------------------------------------
    // Image Upload — Instant DB persistence + R2 replacement to prevent orphaned files.
    // -----------------------------------------------------------------
    if (url.pathname === "/api/upload-image" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("image/webp")) {
        return jsonResponse({ error: "Only WebP images are accepted" }, 400);
      }

      // Rate limiting checks
      const listResult = await env.ASSETS.list({ prefix: `profile-images/${userId}/` });
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const recentUploads = listResult.objects.filter((obj) => new Date(obj.uploaded).getTime() > oneHourAgo);
      if (recentUploads.length >= 20) {
        return jsonResponse({ error: "Upload limit reached — please try again in an hour" }, 429);
      }

      const arrayBuffer = await request.arrayBuffer();
      const sizeInMb = arrayBuffer.byteLength / (1024 * 1024);
      if (sizeInMb > 2) {
        return jsonResponse({ error: "Image too large — please use a smaller image" }, 400);
      }

      // Image content moderation
      const moderationResult = await checkImage(arrayBuffer, env);
      if (!moderationResult.passed) {
        return jsonResponse({ error: getReadableRejectionMessage(moderationResult.reason) }, 422);
      }

      const fieldName = url.searchParams.get("field"); // e.g. "logo_url", "cover_url", "store_photos"
      const profileId = url.searchParams.get("profile_id");

      if (!fieldName || !profileId) {
        return jsonResponse({ error: "Missing destination field or profile ID parameters" }, 400);
      }

      // Verify ownership before altering the database row or bucket
      const { results: ownerCheck } = await env.DB.prepare(
        "SELECT owner_id, logo_url, cover_url, store_photos FROM profiles WHERE id = ?"
      ).bind(profileId).all();

      if (!ownerCheck.length) return jsonResponse({ error: "Profile not found" }, 404);
      if (ownerCheck[0].owner_id !== userId) return jsonResponse({ error: "Not authorized to edit this profile" }, 403);

      const profileRow = ownerCheck[0];

      // Generate unique name
      const requestedName = (url.searchParams.get("name") || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const filename = requestedName ? `${requestedName}-${uniqueSuffix}` : crypto.randomUUID();
      const key = `profile-images/${userId}/${filename}.webp`;

      // Upload key to R2
      await env.ASSETS.put(key, arrayBuffer, {
        httpMetadata: { contentType: "image/webp" }
      });

      const publicUrl = `${url.origin}/api/image/${key}`;

      // Handle Immediate DB and R2 replacements
      let oldImageToDelete = null;
      let dbValueToStore = publicUrl;

      if (fieldName === "logo_url" || fieldName === "cover_url") {
        oldImageToDelete = profileRow[fieldName];
        await env.DB.prepare(
          `UPDATE profiles SET ${fieldName} = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(dbValueToStore, profileId).run();
      } else if (fieldName === "store_photos") {
        // The gallery grid on the frontend (wireGalleryUpload in profile-js.txt)
        // has 5 fixed slots. When the user taps an OCCUPIED slot to replace its
        // photo, the client sends the old URL back as "replace_url" so we can
        // swap it in place. When the user taps an EMPTY slot, no replace_url is
        // sent and we just append. Without this distinction, replacing a slot
        // would silently leave the old gallery file behind in R2 forever.
        const replaceUrl = url.searchParams.get("replace_url");
        const currentPhotos = safeParseArray(profileRow.store_photos);

        if (replaceUrl && currentPhotos.includes(replaceUrl)) {
          const idx = currentPhotos.indexOf(replaceUrl);
          currentPhotos[idx] = publicUrl;
          oldImageToDelete = replaceUrl;
        } else {
          currentPhotos.push(publicUrl);
        }

        dbValueToStore = JSON.stringify(currentPhotos);
        await env.DB.prepare(
          "UPDATE profiles SET store_photos = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(dbValueToStore, profileId).run();
      } else {
        return jsonResponse({ error: "Invalid upload destination field" }, 400);
      }

      // Delete the old file immediately to avoid orphaned storage leaks
      if (oldImageToDelete) {
        const oldKey = extractR2KeyFromUrl(oldImageToDelete);
        if (oldKey) {
          ctx.waitUntil(env.ASSETS.delete(oldKey));
        }
      }

      // Moderation review registration
      if (moderationResult.needsReview) {
        ctx.waitUntil(
          env.DB.prepare(
            "INSERT INTO moderation_queue (profile_id, check_type, field_name, flagged_value, status) VALUES (?, ?, ?, ?, 'open')"
          ).bind(profileId, "image_caution", fieldName, moderationResult.reason).run()
        );
      }

      return jsonResponse({ success: true, url: publicUrl });
    }

    // -----------------------------------------------------------------
    // Remove Image Endpoint — Solves orphaned media immediately on removal
    // -----------------------------------------------------------------
    if (url.pathname === "/api/remove-image" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      // NOTE: profile-js.txt calls this endpoint as a body-less POST with the
      // profile_id / field / url all in the query string. The previous code
      // called `await request.json()` on that empty body, which throws before
      // any storage/DB logic runs. That uncaught exception is exactly what
      // produced the "<!DOCTYPE ... is not valid JSON" error the user saw in
      // the browser — Cloudflare's own HTML error page was being served
      // instead of our jsonResponse(). Reading from url.searchParams matches
      // what the client actually sends, and lets this handler run at all.
      const profile_id = url.searchParams.get("profile_id");
      const field = url.searchParams.get("field");
      const target_url = url.searchParams.get("url"); // client's param name is "url", not "target_url"

      if (!profile_id || !field) {
        return jsonResponse({ error: "Missing required parameters" }, 400);
      }

      const { results: ownerCheck } = await env.DB.prepare(
        "SELECT owner_id, logo_url, cover_url, store_photos FROM profiles WHERE id = ?"
      ).bind(profile_id).all();

      if (!ownerCheck.length) return jsonResponse({ error: "Profile not found" }, 404);
      if (ownerCheck[0].owner_id !== userId) return jsonResponse({ error: "Not authorized" }, 403);

      const profileRow = ownerCheck[0];
      let keyToDelete = null;

      if (field === "logo_url" || field === "cover_url") {
        keyToDelete = extractR2KeyFromUrl(profileRow[field]);
        await env.DB.prepare(
          `UPDATE profiles SET ${field} = NULL, updated_at = datetime('now') WHERE id = ?`
        ).bind(profile_id).run();
      } else if (field === "store_photos" && target_url) {
        const photos = safeParseArray(profileRow.store_photos);
        const filteredPhotos = photos.filter(u => u !== target_url);
        keyToDelete = extractR2KeyFromUrl(target_url);
        await env.DB.prepare(
          "UPDATE profiles SET store_photos = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(JSON.stringify(filteredPhotos), profile_id).run();
      }

      if (keyToDelete) {
        await env.ASSETS.delete(keyToDelete);
      }

      return jsonResponse({ success: true });
    }

    // Serves an uploaded image out of R2
    if (url.pathname.startsWith("/api/image/")) {
      const key = url.pathname.replace("/api/image/", "");
      const object = await env.ASSETS.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000" }
      });
    }

    // -----------------------------------------------------------------
    // Create a new brand profile
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

      // -----------------------------------------------------------------
      // Resolve referral code (if present) to an actual referring profile.
      // Invalid/unknown/self codes are silently ignored rather than
      // blocking signup — a bad ref param should never stop someone from
      // joining, it just means no referral gets attributed.
      // -----------------------------------------------------------------
      let referringProfileId = null;
      const refCode = (body.referred_by || "").trim();
      if (refCode && refCode.toLowerCase() !== slug.toLowerCase()) {
        const { results: referrer } = await env.DB.prepare(
          "SELECT id, owner_id FROM profiles WHERE referral_code = ? AND moderation_status = 'approved'"
        ).bind(refCode).all();
        // Anti-cheat: the referring profile must exist, be approved, and
        // must not belong to the same Google account creating this new
        // profile (no self-referral via a second brand under one owner).
        if (referrer.length && referrer[0].owner_id !== userId) {
          referringProfileId = referrer[0].id;
        }
      }

      // Perform text check before inserting
      const nameCheck = checkText(businessName);
      const taglineCheck = checkText(body.tagline || "");
      const flags = [];
      const validationErrors = {};

      if (!nameCheck.passed) {
        validationErrors.business_name = { error: "Prohibited language detected", term: nameCheck.matchedTerm };
        flags.push({ checkType: "text_auto", fieldName: "business_name", flaggedValue: nameCheck.matchedTerm });
      }
      if (!taglineCheck.passed) {
        validationErrors.tagline = { error: "Prohibited language detected", term: taglineCheck.matchedTerm };
        flags.push({ checkType: "text_auto", fieldName: "tagline", flaggedValue: taglineCheck.matchedTerm });
      }

      // If text validation fails, reject immediately with precise feedback
      if (Object.keys(validationErrors).length > 0) {
        return jsonResponse({
          error: "Some text fields contain inappropriate words. Please revise them.",
          fields: validationErrors
        }, 422);
      }

      const profileId = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO profiles (id, owner_id, slug, business_name, business_category, tagline, moderation_status, referral_code, referred_by_profile_id)
           VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)`
        ).bind(profileId, userId, slug, businessName, category, body.tagline || null, slug, referringProfileId).run();
      } catch (dbErr) {
        console.error("Profile creation DB error:", dbErr);
        return jsonResponse(
          { error: "We couldn't create your profile — please check your brand name and link, then try again." },
          400
        );
      }

      return jsonResponse({ success: true, profileId, slug, moderationStatus: "approved" });
    }

    // -----------------------------------------------------------------
    // Update an existing brand profile
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

      // Check for Strike-Out limit (15 failed edits per session)
      const attemptKey = `attempts:${userId}`;
      const failedAttemptsStr = getCookie(request, "liyog_strikes") || "0";
      let failedAttempts = parseInt(failedAttemptsStr, 10);

      let slugUpdate = null;
      if (body.slug !== undefined && body.slug !== results[0].slug) {
        const newSlug = String(body.slug).toLowerCase().trim();
        const validFormat = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/.test(newSlug);
        if (!validFormat) {
          return jsonResponse({ error: "Your link can only use lowercase letters, numbers, and hyphens, and must be 3-20 characters." }, 400);
        }

        if (results[0].slug_updated_at) {
          const daysSinceChange = (Date.now() - new Date(results[0].slug_updated_at.replace(" ", "T") + "Z").getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceChange < 7) {
            const daysLeft = Math.ceil(7 - daysSinceChange);
            return jsonResponse({ error: `You can change your link again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.` }, 429);
          }
        }

        const { results: reserved } = await env.DB.prepare(
          "SELECT slug FROM reserved_slugs WHERE slug = ?"
        ).bind(newSlug).all();
        if (reserved.length) return jsonResponse({ error: "That link isn't available. Please choose another." }, 400);

        const { results: taken } = await env.DB.prepare(
          "SELECT slug FROM profiles WHERE slug = ? AND id != ?"
        ).bind(newSlug, profileId).all();
        if (taken.length) return jsonResponse({ error: "That link is already taken. Please choose another." }, 409);

        slugUpdate = newSlug;
      }

      const editableFields = [
        "business_name", "tagline", "bio_html", "year_established", "whatsapp_number", "wa_message",
        "phone_number", "response_time", "store_address", "store_city", "store_country",
        "map_address", "logo_url", "cover_url", "store_photos", "youtube_url", "key_points",
        "social_facebook", "social_instagram", "social_twitter", "social_tiktok",
        "social_youtube", "social_website"
      ];

      const updates = {};
      const validationErrors = {};
      const flags = [];

      for (const field of editableFields) {
        if (body[field] !== undefined) {
          if (field === "bio_html") {
            const rawSyntax = String(body[field]).slice(0, RICHTEXT_MAX_LENGTH);
            const plainTextForModeration = stripRichTextSyntax(rawSyntax);
            const check = checkText(plainTextForModeration);
            if (!check.passed) {
              validationErrors.bio_html = { error: "Inappropriate language detected", term: check.matchedTerm };
              flags.push({ checkType: "text_auto", fieldName: field, flaggedValue: check.matchedTerm });
            }
            updates[field] = parseRichText(rawSyntax);
          } else {
            updates[field] = body[field];
            if (["business_name", "tagline"].includes(field)) {
              const check = checkText(body[field]);
              if (!check.passed) {
                validationErrors[field] = { error: "Inappropriate language detected", term: check.matchedTerm };
                flags.push({ checkType: "text_auto", fieldName: field, flaggedValue: check.matchedTerm });
              }
            }
          }
        }
      }

      // Handle validation failure
      if (Object.keys(validationErrors).length > 0) {
        failedAttempts += 1;

        // Auto-lock into pending manual review if user exceeds 15 sequential strikes
        if (failedAttempts >= 15) {
          await env.DB.prepare(
            "UPDATE profiles SET moderation_status = 'pending', updated_at = datetime('now') WHERE id = ?"
          ).bind(profileId).run();

          if (flags.length) await saveModerationFlags(env, profileId, flags);

          const errorResponse = jsonResponse({
            error: "Too many failed edits. Your profile has been locked and put in the queue for manual team review.",
            locked: true,
            fields: validationErrors
          }, 422);
          errorResponse.headers.set("Set-Cookie", `liyog_strikes=0; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`);
          return errorResponse;
        }

        const errorResponse = jsonResponse({
          error: "Validation failed. Please correct the marked fields.",
          fields: validationErrors,
          strikesRemaining: 15 - failedAttempts
        }, 422);
        errorResponse.headers.set("Set-Cookie", `liyog_strikes=${failedAttempts}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`);
        return errorResponse;
      }

      if (!Object.keys(updates).length && !slugUpdate) {
        return jsonResponse({ error: "No valid fields to update" }, 400);
      }

      // Cleared validation, reset strikes
      updates.moderation_status = "approved";

      if (slugUpdate) {
        updates.slug = slugUpdate;
        updates.slug_updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");
      }

      const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(updates);

      try {
        await env.DB.prepare(
          `UPDATE profiles SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`
        ).bind(...values, profileId).run();
      } catch (dbErr) {
        console.error("Profile update DB error:", dbErr);
        return jsonResponse(
          { error: "One of your fields is too long or contains an unexpected value. Please review your entries and try again." },
          400
        );
      }

ctx.waitUntil(maybeCreditReferral(env, { ...results[0], ...updates }));

      const response = jsonResponse({ success: true, moderationStatus: "approved", newSlug: slugUpdate || null });
      response.headers.set("Set-Cookie", "liyog_strikes=0; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax");
      return response;
    }

    // Owner-only: fetch inquiries sent to a specific profile
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

      // Transform sender contacts dynamically into actionable URLs
      const formattedInquiries = inquiries.map(inq => ({
        ...inq,
        action_url: formatContactLink(inq.sender_contact)
      }));

      return jsonResponse({ inquiries: formattedInquiries });
    }

    // -----------------------------------------------------------------
    // Inquiries Form Submission
    // -----------------------------------------------------------------
    if (url.pathname === "/api/inquiries" && request.method === "POST") {
      const body = await request.json();
      const { profile_id, sender_name, sender_contact, message } = body;

      if (!profile_id || !sender_name || !sender_contact || !message) {
        return jsonResponse({ error: "Please fill in all fields" }, 400);
      }
      if (message.length > 500) {
        return jsonResponse({ error: "Message is too long" }, 400);
      }

      const { results: recentCount } = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM inquiries WHERE sender_contact = ? AND created_at > datetime('now', '-1 hour')"
      ).bind(sender_contact).all();
      if (recentCount[0].count >= 3) {
        return jsonResponse({ error: "You've sent several inquiries recently — please wait a bit before sending more" }, 429);
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

// ---- Products: create ----
    if (url.pathname === "/api/products" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const createResponse = await handleCreateProduct(request, env, userId);

      // Backfill a shareable/deep-linkable slug right after creation,
      // without touching products.js's own internals — read the id it
      // just returned, then generate+store the slug as a follow-up
      // step. If anything here fails, product creation itself has
      // already succeeded and returned to the caller; the product
      // simply falls back to its id-derived slug until the next edit.
      try {
        const cloned = createResponse.clone();
        const body = await cloned.json();
        const newProductId = body?.product?.id || body?.id;
        if (newProductId) {
          const { results } = await env.DB.prepare("SELECT profile_id, name, slug FROM products WHERE id = ?").bind(newProductId).all();
          if (results.length && !results[0].slug) {
            const slug = await productsEngagement.generateUniqueProductSlug(env, results[0].profile_id, results[0].name);
            await env.DB.prepare("UPDATE products SET slug = ? WHERE id = ?").bind(slug, newProductId).run();
          }
        }
      } catch (err) {
        console.error("Product slug backfill failed (non-fatal):", err);
      }

      return createResponse;
    }

    // ---- Products: update ----
    if (url.pathname.match(/^\/api\/products\/[^/]+$/) && request.method === "PATCH") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);
      const productId = url.pathname.split("/")[3];
      return handleUpdateProduct(request, env, userId, productId);
    }

    // ---- Products: delete ----
    if (url.pathname.match(/^\/api\/products\/[^/]+$/) && request.method === "DELETE") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);
      const productId = url.pathname.split("/")[3];
      return handleDeleteProduct(env, userId, productId);
    }

    // ---- Products: list (public, used by both profile view and edit panel) ----
    if (url.pathname.match(/^\/api\/profiles\/[^/]+\/products$/) && request.method === "GET") {
      const profileId = url.pathname.split("/")[3];
      const sessionToken = getCookie(request, "liyog_session");
      const requesterId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      let includeDrafts = false;
      if (requesterId) {
        const { results: ownerCheck } = await env.DB.prepare(
          "SELECT owner_id FROM profiles WHERE id = ?"
        ).bind(profileId).all();
        includeDrafts = ownerCheck.length > 0 && ownerCheck[0].owner_id === requesterId;
      }
      return handleListProducts(env, profileId, includeDrafts);
    }

    // ---- Products: image upload (reuses the same moderation pipeline) ----
    if (url.pathname === "/api/upload-product-image" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);
      return handleUploadProductImage(request, env, userId, url);
    }

    // -----------------------------------------------------------------
    // Product engagement — views, likes, star ratings (preset-text,
    // no free-text reviews), shares, reports, LiyX AI summaries.
    // Mirrors the Brand Reputation Engine routes just below in shape.
    // -----------------------------------------------------------------

    // GET /api/products/rating-presets — the full preset catalogue the
    // frontend needs to render the rating picker. Static per-deploy,
    // safe to cache client-side for the session.
    if (url.pathname === "/api/products/rating-presets" && request.method === "GET") {
      return jsonResponse({ presets: productsEngagement.getRatingPresets() });
    }

    // GET /api/products/:productId/engagement — everything a product
    // card/detail page needs in one call: stats, my rating, my like,
    // LiyX AI insight. Public — same visibility rule as product
    // listings themselves.
    if (url.pathname.match(/^\/api\/products\/[^/]+\/engagement$/) && request.method === "GET") {
      const productId = url.pathname.split("/")[3];
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;

      const stats = await productsEngagement.getProductStats(env, productId);
      const myRating = await productsEngagement.getMyRating(env, productId, request, url.searchParams.get("ds"));
      const myLike = await productsEngagement.getMyLike(env, productId, userId);
      const insight = await productsEngagement.getProductInsight(env, productId);

      return jsonResponse({ stats, my_rating: myRating, my_like: myLike, insight });
    }

    // POST /api/products/:productId/view — record a view (simple
    // ever-incrementing counter, no per-visitor dedup).
    if (url.pathname.match(/^\/api\/products\/[^/]+\/view$/) && request.method === "POST") {
      const productId = url.pathname.split("/")[3];
      try {
        const result = await productsEngagement.recordView(env, productId);
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof productsEngagement.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("recordView failed:", err);
        return jsonResponse({ error: "Something went wrong." }, 500);
      }
    }

    // POST /api/products/:productId/like — toggle like. Requires
    // sign-in (product decision — no anonymous likes, unlike reactions).
    if (url.pathname.match(/^\/api\/products\/[^/]+\/like$/) && request.method === "POST") {
      const productId = url.pathname.split("/")[3];
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      try {
        const result = await productsEngagement.toggleLike(env, { productId, userId });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof productsEngagement.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("toggleLike failed:", err);
        return jsonResponse({ error: "Something went wrong." }, 500);
      }
    }

    // POST /api/products/:productId/rating — submit/update a star
    // rating + one preset primary text + up to 2 preset tags.
    if (url.pathname.match(/^\/api\/products\/[^/]+\/rating$/) && request.method === "POST") {
      const productId = url.pathname.split("/")[3];
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      const body = await request.json().catch(() => ({}));
      try {
        const result = await productsEngagement.submitRating(env, {
          productId,
          userId,
          rating: parseInt(body.rating, 10),
          primaryPresetId: body.primary_preset_id,
          tagPresetIds: body.tag_preset_ids,
          request,
          clientDeviceSignal: body.device_signal
        });
        const response = jsonResponse(result);
        // LiyX AI: fire-and-forget, exactly like the brand-review insight
        // rule — never awaited, never able to delay or fail this response.
        ctx.waitUntil(productsEngagement.maybeGenerateProductInsight(env, productId));
        return response;
      } catch (err) {
        if (err instanceof productsEngagement.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("submitRating failed:", err);
        return jsonResponse({ error: "Something went wrong." }, 500);
      }
    }

    // POST /api/products/:productId/share — log a share event (also
    // used by the deep-link page to bump share_count when someone
    // taps a share button, independent of which channel they chose).
    if (url.pathname.match(/^\/api\/products\/[^/]+\/share$/) && request.method === "POST") {
      const productId = url.pathname.split("/")[3];
      const body = await request.json().catch(() => ({}));
      try {
        const result = await productsEngagement.recordShare(env, productId, body.channel);
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof productsEngagement.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("recordShare failed:", err);
        return jsonResponse({ error: "Something went wrong." }, 500);
      }
    }

    // POST /api/products/:productId/report — anyone can report; never
    // auto-hides, only queues for manual review (same philosophy as
    // review_reports).
    if (url.pathname.match(/^\/api\/products\/[^/]+\/report$/) && request.method === "POST") {
      const productId = url.pathname.split("/")[3];
      const body = await request.json().catch(() => ({}));
      try {
        const result = await productsEngagement.reportProduct(env, {
          productId,
          reason: body.reason,
          details: body.details,
          request,
          clientDeviceSignal: body.device_signal
        });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof productsEngagement.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("reportProduct failed:", err);
        return jsonResponse({ error: "Something went wrong." }, 500);
      }
    }

    // GET /api/products/:productId/chart?days=30 — daily-bucketed
    // views/shares/ratings for the per-product engagement chart.
    // Owner-only — this is a management-facing metric view, not
    // something every visitor needs to fetch.
    if (url.pathname.match(/^\/api\/products\/[^/]+\/chart$/) && request.method === "GET") {
      const productId = url.pathname.split("/")[3];
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const { results: ownerCheck } = await env.DB.prepare(
        `SELECT p.owner_id FROM products pr JOIN profiles p ON p.id = pr.profile_id WHERE pr.id = ?`
      ).bind(productId).all();
      if (!ownerCheck.length || ownerCheck[0].owner_id !== userId) return jsonResponse({ error: "Not authorized" }, 403);

      const days = parseInt(url.searchParams.get("days") || "30", 10) || 30;
      const chart = await productsEngagement.getProductEngagementChart(env, productId, days);
      return jsonResponse({ chart });
    }

    // ---- Boost: public config (admin WhatsApp number for the handoff link) ----
    if (url.pathname === "/api/boost-config" && request.method === "GET") {
      return handleBoostConfig(env);
    }

    // ---- Boost: status (profile + optional batch of product ids) ----
    // Public — same visibility rule as product listings themselves,
    // since the badge needs to render for every visitor, not just the owner.
    if (url.pathname.match(/^\/api\/profiles\/[^/]+\/boost-status$/) && request.method === "GET") {
      const profileId = url.pathname.split("/")[3];
      const productIds = url.searchParams.get("products");
      return handleBoostStatus(env, profileId, productIds);
    }

    // ---- Boost: manual activation (admin-only, called by you after
    // confirming payment over WhatsApp — never exposed to end users) ----
    if (url.pathname === "/api/boost/activate" && request.method === "POST") {
      return handleActivateBoost(request, env);
    }

    // ---- Referrals: who this profile's owner has successfully referred,
    // plus anyone pending — owner-only, shown in the Products edit tab ----
    if (url.pathname.match(/^\/api\/profiles\/[^/]+\/referrals$/) && request.method === "GET") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);
      const profileId = url.pathname.split("/")[3];
      const { results: profileRows } = await env.DB.prepare(
        "SELECT owner_id FROM profiles WHERE id = ?"
      ).bind(profileId).all();
      if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
      if (profileRows[0].owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);
      const data = await getMyReferrals(env, profileId);
      return jsonResponse(data);
    }


   // -----------------------------------------------------------------
    // Brand Reputation Engine — reviews, reactions, owner replies
    // -----------------------------------------------------------------

    // GET /api/reviews/:profileId?sort=recent&offset=0 — list live reviews
    if (url.pathname.startsWith("/api/reviews/") && request.method === "GET" && !url.pathname.endsWith("/stats")) {
      const profileId = url.pathname.split("/")[3];
      const sort = url.searchParams.get("sort") || "recent";
      const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;

      const sessionToken = getCookie(request, "liyog_session");
      const viewerUserId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      const viewerFingerprint = viewerUserId ? null : await reviews.buildFingerprint(request, url.searchParams.get("ds"));

      const list = await reviews.listReviews(env, profileId, { sort, offset, limit: 20, viewerUserId, viewerFingerprint });
      return jsonResponse({ reviews: list });
    }

    // GET /api/reviews/:profileId/stats — cached stats + badges (lightweight, cacheable)
    if (url.pathname.startsWith("/api/reviews/") && url.pathname.endsWith("/stats") && request.method === "GET") {
      const profileId = url.pathname.split("/")[3];
      const stats = await reviews.getStats(env, profileId);
      const badges = reviews.computeBadges(stats);
      return jsonResponse({ stats, badges });
    }

    // POST /api/reviews — submit a new review (logged-in, brand-as-author, or anonymous)
    if (url.pathname === "/api/reviews" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;

      const body = await request.json();
      try {
        const result = await reviews.createReview(env, {
          profileId: body.profile_id,
          userId,
          authorProfileId: body.author_profile_id || null, // set only if user is posting AS one of their own brand profiles
          authorName: body.author_name,
          rating: parseInt(body.rating, 10),
          recommend: typeof body.recommend === "boolean" ? body.recommend : null,
          title: body.title,
          reviewText: body.review_text,
          photos: body.photos,
          request,
          clientDeviceSignal: body.device_signal,
          checkText
        });
        const response = jsonResponse({ success: true, ...result });
        // LiyX AI: fire-and-forget. Runs after the response above is already
        // being sent — never awaited, never able to delay or fail review
        // submission. maybeGenerateInsight() itself also swallows its own
        // errors as a second layer of protection.
        ctx.waitUntil(reviews.maybeGenerateInsight(env, body.profile_id));
        return response;
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("createReview failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // POST /api/reviews/:reviewId/helpful — mark a review as helpful
    if (url.pathname.match(/^\/api\/reviews\/[^/]+\/helpful$/) && request.method === "POST") {
      const reviewId = url.pathname.split("/")[3];
      const body = await request.json().catch(() => ({}));
      const result = await reviews.voteHelpful(env, { reviewId, request, clientDeviceSignal: body.device_signal });
      return jsonResponse(result);
    }

    // POST /api/reviews/:reviewId/reply — owner replies to a review on their own profile
    if (url.pathname.match(/^\/api\/reviews\/[^/]+\/reply$/) && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const reviewId = url.pathname.split("/")[3];
      const body = await request.json();
      try {
        const result = await reviews.ownerReply(env, { reviewId, ownerId: userId, replyText: body.reply_text });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("ownerReply failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // POST /api/reviews/:reviewId/feature — owner pins/unpins a review (max 50 featured)
    if (url.pathname.match(/^\/api\/reviews\/[^/]+\/feature$/) && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;
      if (!userId) return jsonResponse({ error: "Not authenticated" }, 401);

      const reviewId = url.pathname.split("/")[3];
      const body = await request.json();
      try {
        const result = await reviews.setFeatured(env, { reviewId, ownerId: userId, featured: !!body.featured });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("setFeatured failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // PATCH /api/reviews/:reviewId — the review's own author edits it.
    // Deliberately NOT gated behind ownerId/profile ownership — this is
    // an author-only action, checked entirely inside reviews.editReview
    // via the same userId/fingerprint identity used at creation time.
    if (url.pathname.match(/^\/api\/reviews\/[^/]+$/) && request.method === "PATCH") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;

      const reviewId = url.pathname.split("/")[3];
      const body = await request.json();
      try {
        const result = await reviews.editReview(env, {
          reviewId,
          userId,
          request,
          clientDeviceSignal: body.device_signal,
          rating: parseInt(body.rating, 10),
          recommend: typeof body.recommend === "boolean" ? body.recommend : null,
          title: body.title,
          reviewText: body.review_text,
          checkText
        });
        ctx.waitUntil(reviews.maybeGenerateInsight(env, result.profileId));
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("editReview failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // DELETE /api/reviews/:reviewId — the review's own author deletes it.
    // Same author-only scoping as PATCH above — never available to the
    // profile owner, only to whoever originally wrote the review.
    if (url.pathname.match(/^\/api\/reviews\/[^/]+$/) && request.method === "DELETE") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;

      const reviewId = url.pathname.split("/")[3];
      const body = await request.json().catch(() => ({}));
      try {
        const result = await reviews.deleteReview(env, {
          reviewId,
          userId,
          request,
          clientDeviceSignal: body.device_signal
        });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("deleteReview failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // POST /api/reviews/:reviewId/report — anyone (visitor or profile
    // owner) flags a review for manual review. Never auto-hides
    // anything — just queues it in review_reports for a human to check.
    if (url.pathname.match(/^\/api\/reviews\/[^/]+\/report$/) && request.method === "POST") {
      const reviewId = url.pathname.split("/")[3];
      const body = await request.json().catch(() => ({}));
      try {
        const result = await reviews.reportReview(env, {
          reviewId,
          reason: body.reason,
          details: body.details,
          request,
          clientDeviceSignal: body.device_signal
        });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("reportReview failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // POST /api/reactions — like or dislike a brand profile (upsert)
    if (url.pathname === "/api/reactions" && request.method === "POST") {
      const sessionToken = getCookie(request, "liyog_session");
      const userId = sessionToken ? await verifySessionToken(env, sessionToken) : null;

      const body = await request.json();
      try {
        const result = await reviews.setReaction(env, {
          profileId: body.profile_id,
          userId,
          reaction: body.reaction,
          request,
          clientDeviceSignal: body.device_signal
        });
        return jsonResponse(result);
      } catch (err) {
        if (err instanceof reviews.UserFacingError) return jsonResponse({ error: err.message }, err.status);
        console.error("setReaction failed:", err);
        return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // -----------------------------------------------------------------
    // Product deep-link — /p/{brand-slug}/product/{product-slug}
    // Server-renders real <meta property="og:*"> tags for this SPECIFIC
    // product (image + 2-line description), so WhatsApp/Facebook/
    // Twitter link previews show the actual product being shared, not
    // the brand's generic profile card. A crawler only ever reads this
    // static HTML — no JS execution needed for the preview to work.
    // A real browser gets the same HTML, then profile.js boots as
    // normal and hydrates straight into that product's detail view
    // (see the embedded bootstrap script below), so there's exactly
    // one visual experience, just reached two different ways.
    // -----------------------------------------------------------------
    if (url.pathname.match(/^\/p\/[^/]+\/product\/[^/]+$/)) {
      const parts = url.pathname.split("/");
      const brandSlug = parts[2];
      const productSlug = parts[4];

      const { results: profileRows } = await env.DB.prepare(
        "SELECT id, business_name, is_active, moderation_status FROM profiles WHERE slug = ?"
      ).bind(brandSlug).all();

      if (!profileRows.length || !profileRows[0].is_active || profileRows[0].moderation_status !== "approved") {
        return new Response("Not found", { status: 404 });
      }
      const profile = profileRows[0];

      const { results: productRows } = await env.DB.prepare(
        "SELECT id, name, description, price_display, image_url FROM products WHERE profile_id = ? AND slug = ? AND is_active = 1"
      ).bind(profile.id, productSlug).all();

      if (!productRows.length) return new Response("Not found", { status: 404 });
      const product = productRows[0];

      ctx.waitUntil(productsEngagement.recordView(env, product.id));

      const pagePath = await getSetting(env, "blogger_profile_page", "/p/brands.html");
      const canonicalUrl = `${url.origin}${url.pathname}`;
      const ogDescription = buildOgDescription(product.description, product.price_display);
      const ogImage = product.image_url || `${url.origin}/default-og-image.png`;

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttr(product.name)} — ${escapeHtmlAttr(profile.business_name)} | Liyog World</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${escapeHtmlAttr(product.name)} — ${escapeHtmlAttr(profile.business_name)}">
<meta property="og:description" content="${escapeHtmlAttr(ogDescription)}">
<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">
<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtmlAttr(product.name)}">
<meta name="twitter:description" content="${escapeHtmlAttr(ogDescription)}">
<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">
<script>
  // Real browsers: redirect straight into the normal profile page,
  // carrying the product id so profile.js opens its detail view on
  // load. Crawlers never execute this — they only ever read the
  // meta tags above, which is the whole point of this route existing.
  var target = ${JSON.stringify(pagePath)} + "?biz=" + ${JSON.stringify(brandSlug)} + "&product=" + ${JSON.stringify(product.id)};
  window.location.replace(target);
</script>
</head>
<body>
  <p>Redirecting to <a href="/b/${escapeHtmlAttr(brandSlug)}">${escapeHtmlAttr(profile.business_name)}</a>…</p>
</body>
</html>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    }

    // -----------------------------------------------------------------
    // Public profile routes
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

    const reviewStats = await reviews.getStats(env, profile.id);
    profile.review_stats = reviewStats;
    profile.review_badges = reviews.computeBadges(reviewStats);
    profile.my_reaction = await reviews.getMyReaction(env, profile.id, request, url.searchParams.get("ds"));
    profile.review_insight = await reviews.getInsight(env, profile.id); // LiyX AI — null if none generated yet

    return jsonResponse({ found: true, profile });

  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldLogs(env));
    ctx.waitUntil(reviews.runScheduledArchive(env));
    ctx.waitUntil(reviews.runScheduledInsights(env)); // LiyX AI — regenerates insights for profiles with 3+ new reviews since last generation
    ctx.waitUntil(productsEngagement.runScheduledProductInsights(env)); // LiyX AI — same rule, per product
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

// Minimal HTML-attribute escaping for the product deep-link page's
// server-rendered <meta> tags — this is the ONLY place in index.js
// that builds raw HTML from database content, so it gets its own
// small, explicit escaper rather than pulling in a dependency.
function escapeHtmlAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Builds a short, share-preview-friendly description (roughly 2 lines
// worth of characters) from a product's full description + price —
// WhatsApp/Facebook truncate long og:description values anyway, so
// this keeps the meaningful part front-loaded rather than relying on
// the platform's own (inconsistent) truncation point.
function buildOgDescription(description, priceDisplay) {
  const desc = (description || "").replace(/\s+/g, " ").trim();
  const pricePart = priceDisplay ? `${priceDisplay} — ` : "";
  const combined = pricePart + desc;
  return combined.length > 160 ? combined.slice(0, 157) + "…" : combined || "Check out this product on Liyog World.";
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

function extractR2KeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/api\/image\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
