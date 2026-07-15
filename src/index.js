import PROFILE_CSS from "./assets/profile-css.txt";
import PROFILE_JS from "./assets/profile-js.txt";
import PROFILE_TEMPLATE_HTML from "./assets/profile-template.html";
import AUTH_UI_JS from "./assets/auth-ui-js.txt";
import AUTH_UI_CSS from "./assets/auth-ui-css.txt";
import { verifyGoogleToken, findOrCreateUser, createSessionToken, verifySessionToken } from "./lib/auth.js";
import { checkText, checkImage, saveModerationFlags, getReadableRejectionMessage } from "./lib/moderation.js";
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
          `INSERT INTO profiles (id, owner_id, slug, business_name, business_category, tagline, moderation_status)
           VALUES (?, ?, ?, ?, ?, ?, 'approved')`
        ).bind(profileId, userId, slug, businessName, category, body.tagline || null).run();
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

function extractR2KeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/api\/image\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
