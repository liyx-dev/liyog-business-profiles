/* =====================================================================
   LIYOG WORLD BUSINESS PROFILES — profile.js
   Fetches profile data from the Cloudflare Worker and renders it into
   the #liyog-profile-root div on the Blogger page. Also injects
   per-profile SEO tags (title, meta description, Open Graph, JSON-LD)
   since Blogger's own <head> can't know about dynamic slugs.

   Depends on: profile.css loaded on the page, and a div with
   id="liyog-profile-root" present in the Blogger page HTML.
   ===================================================================== */

(function () {
  "use strict";

  const WORKER_BASE = "https://www.liyogworld.com.ng";
  const root = document.getElementById("liyog-profile-root");

  if (!root) {
    console.error("liyog-profile-root not found on this page.");
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const slug = params.get("biz");

  let currentPagePath = window.location.pathname; // safe fallback: wherever we already are

  init();

  async function init() {
    // Ask the Worker where the profile page currently lives, so nothing
    // here is ever hardcoded. If this page's own filename ever changes,
    // updating one row in D1 is the only thing required — this script
    // adapts automatically on next load.
    try {
      const res = await fetch(`${WORKER_BASE}/api/config`);
      const cfg = await res.json();
      if (cfg.blogger_profile_page) currentPagePath = cfg.blogger_profile_page;
    } catch (e) {
      // Config fetch failing is non-fatal — we already have a safe fallback above.
    }

    if (!slug) {
      renderClaimScreen(root, currentPagePath);
      return;
    }

    renderSkeleton(root);
    loadProfile(slug);
    cleanAddressBar(slug);
  }

  // Rewrites the visible browser URL to the short, clean, shareable form
  // (liyogworld.com.ng/b/slug) without reloading the page — so anyone
  // who copies the URL from their address bar gets the SEO-friendly
  // canonical link, not the Blogger path with ?biz=&m=1 attached.
  function cleanAddressBar(slug) {
    if (!window.history || !window.history.replaceState) return;
    const cleanUrl = `${WORKER_BASE}/b/${encodeURIComponent(slug)}`;
    if (window.location.href !== cleanUrl) {
      window.history.replaceState({}, "", cleanUrl);
    }
  }

  async function loadProfile(slug) {
    try {
      const currentUserId = getCurrentUserId(); // wired up fully once auth ships
      const url = `${WORKER_BASE}/b/${encodeURIComponent(slug)}?format=json${
        currentUserId ? `&viewer_id=${encodeURIComponent(currentUserId)}` : ""
      }`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.found) {
        renderNotFound(root, slug, currentPagePath);
        return;
      }
      if (data.status === "pending_review") {
        renderPendingReview(root);
        return;
      }

      const isOwner = currentUserId && currentUserId === data.profile.owner_id;
      renderProfile(root, data.profile, isOwner);
      injectSeoTags(data.profile);
    } catch (err) {
      console.error("Failed to load profile:", err);
      renderErrorState(root, err);
    }
  }

  // -------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------

  function renderSkeleton(el) {
    el.innerHTML = `
      <div class="lp-root">
        <div class="lp-skeleton">
          <div class="lp-skeleton-block" style="height:180px;margin-bottom:16px;"></div>
          <div class="lp-skeleton-block" style="height:24px;width:60%;margin-bottom:10px;"></div>
          <div class="lp-skeleton-block" style="height:16px;width:40%;"></div>
        </div>
      </div>`;
  }

  function renderProfile(el, p, isOwner) {
    const photos = safeParseArray(p.store_photos).slice(0, 5);
    const points = safeParseArray(p.key_points).slice(0, 5);
    const waLink = buildWhatsAppLink(p.whatsapp_number, p.wa_message, p.business_name);
    const telLink = p.phone_number ? `tel:${sanitizeTel(p.phone_number)}` : null;

    el.innerHTML = `
      <div class="lp-root" data-profile-id="${escAttr(p.id)}">
        <div class="lp-cover-wrap">
          <img class="lp-cover" src="${escAttr(p.cover_url || "")}" alt="${escAttr(p.business_name)} cover photo" loading="eager">
          <div class="lp-identity-card">
            ${isOwner ? `<button class="lp-edit-pen" id="lp-edit-toggle" aria-label="Edit profile" title="Edit profile">🖊️</button>` : ""}
            <img class="lp-logo" src="${escAttr(p.logo_url || "")}" alt="${escAttr(p.business_name)} logo" loading="eager">
            <div class="lp-identity-text">
              <h1 class="lp-business-name">
                ${esc(p.business_name)}
                ${p.moderation_status === "approved" ? `<span class="lp-verified-badge" title="Verified business">★</span>` : ""}
              </h1>
              ${p.tagline ? `<p class="lp-tagline">${esc(p.tagline)}</p>` : ""}
            </div>
          </div>
        </div>

        ${points.length ? `
        <div class="lp-trust-strip">
          ${points.map(pt => `<span class="lp-pill">${esc(pt)}</span>`).join("")}
        </div>` : ""}

        <div class="lp-action-bar">
          ${waLink ? `<a class="lp-btn lp-btn-whatsapp" href="${escAttr(waLink)}" target="_blank" rel="noopener" onclick="window.__lpTrackShare && window.__lpTrackShare('whatsapp')">💬 WhatsApp</a>` : `<span></span>`}
          ${telLink ? `<a class="lp-btn lp-btn-call" href="${escAttr(telLink)}">📞 Call</a>` : `<span></span>`}
          <button class="lp-btn lp-btn-share" id="lp-share-btn" aria-label="Share this profile" title="Share">🔗</button>
        </div>

        ${p.bio_html ? `
        <div class="lp-section">
          <h2 class="lp-section-title">About</h2>
          <div class="lp-bio">${sanitizeBioHtml(p.bio_html)}</div>
        </div>` : ""}

        ${photos.length ? `
        <div class="lp-section">
          <h2 class="lp-section-title">Storefront</h2>
          <div class="lp-gallery" id="lp-gallery">
            ${photos.map((url, i) => `<img class="lp-gallery-item-${i + 1}" src="${escAttr(url)}" alt="${escAttr(p.business_name)} photo ${i + 1}" loading="lazy" data-full="${escAttr(url)}">`).join("")}
          </div>
        </div>` : ""}

        ${p.youtube_url ? `
        <div class="lp-section">
          <h2 class="lp-section-title">Watch</h2>
          <div class="lp-embed-wrap">
            <iframe src="${escAttr(toYouTubeEmbed(p.youtube_url))}" title="${escAttr(p.business_name)} video" loading="lazy" allowfullscreen></iframe>
          </div>
        </div>` : ""}

        ${p.map_address ? `
        <div class="lp-section">
          <h2 class="lp-section-title">Location</h2>
          <div class="lp-map-wrap">
            <iframe src="https://www.google.com/maps?q=${encodeURIComponent(p.map_address)}&output=embed" loading="lazy" title="${escAttr(p.business_name)} location"></iframe>
          </div>
        </div>` : ""}

        ${hasAnySocial(p) ? `
        <div class="lp-section">
          <h2 class="lp-section-title">Find us elsewhere</h2>
          <div class="lp-social-row">
            ${socialLink(p.social_facebook, "Facebook", "📘")}
            ${socialLink(p.social_instagram, "Instagram", "📷")}
            ${socialLink(p.social_twitter, "X / Twitter", "𝕏")}
            ${socialLink(p.social_tiktok, "TikTok", "🎵")}
            ${socialLink(p.social_youtube, "YouTube", "▶️")}
            ${socialLink(p.social_website, "Website", "🌐")}
          </div>
        </div>` : ""}

        <div class="lp-meta-strip">
          <span>${p.profile_views || 0} views</span>
          <span>On Liyog World since ${formatYear(p.created_at)}</span>
        </div>
      </div>

      <div class="lp-lightbox" id="lp-lightbox">
        <button class="lp-lightbox-close" id="lp-lightbox-close" aria-label="Close">&times;</button>
        <img id="lp-lightbox-img" src="" alt="">
      </div>
    `;

    wireInteractions(p, isOwner);
  }

  function renderNotFound(el, slug, pagePath) {
    el.innerHTML = `
      <div class="lp-root">
        <div class="lp-state-screen">
          <h2>This profile doesn't exist yet</h2>
          <p>"${esc(slug)}" hasn't been claimed. Be the first to set it up.</p>
          <a class="lp-state-cta" href="${escAttr(pagePath)}?claim=${encodeURIComponent(slug)}">Claim this link</a>
        </div>
      </div>`;
  }

  function renderPendingReview(el) {
    el.innerHTML = `
      <div class="lp-root">
        <div class="lp-state-screen">
          <h2>Profile under review</h2>
          <p>This business profile is being checked and will be live shortly.</p>
        </div>
      </div>`;
  }

  function renderErrorState(el, err) {
    el.innerHTML = `
      <div class="lp-root">
        <div class="lp-state-screen">
          <h2>Something went wrong</h2>
          <p>We couldn't load this profile right now. Please try again shortly.</p>
          <p style="font-size:11px;color:#999;word-break:break-all;">${esc(err ? (err.message || String(err)) : "no error object")}</p>
        </div>
      </div>`;
  }

  function renderClaimScreen(el, pagePath) {
    el.innerHTML = `
      <div class="lp-root">
        <div class="lp-state-screen">
          <h2>Create your business profile</h2>
          <p>Get a free profile page and your own link to share, like liyogworld.com.ng/b/yourbusiness.</p>
          <a class="lp-state-cta" href="${escAttr(pagePath)}?signup=1">Get started</a>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------

  function wireInteractions(p, isOwner) {
    const gallery = document.getElementById("lp-gallery");
    const lightbox = document.getElementById("lp-lightbox");
    const lightboxImg = document.getElementById("lp-lightbox-img");
    const lightboxClose = document.getElementById("lp-lightbox-close");

    if (gallery) {
      gallery.addEventListener("click", (e) => {
        const img = e.target.closest("img[data-full]");
        if (!img) return;
        lightboxImg.src = img.dataset.full;
        lightboxImg.alt = img.alt;
        lightbox.classList.add("lp-open");
      });
    }
    if (lightboxClose) {
      lightboxClose.addEventListener("click", () => lightbox.classList.remove("lp-open"));
    }
    if (lightbox) {
      lightbox.addEventListener("click", (e) => {
        if (e.target === lightbox) lightbox.classList.remove("lp-open");
      });
    }

    const shareBtn = document.getElementById("lp-share-btn");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        const shareUrl = `${WORKER_BASE}/b/${p.slug}`;
        trackShare("copy_link");
        if (navigator.share) {
          try {
            await navigator.share({ title: p.business_name, url: shareUrl });
            return;
          } catch (e) { /* user cancelled, fall through to copy */ }
        }
        navigator.clipboard.writeText(shareUrl).then(() => {
          shareBtn.textContent = "✅";
          setTimeout(() => (shareBtn.innerHTML = "🔗"), 1500);
        });
      });
    }

    window.__lpTrackShare = trackShare;
    function trackShare(channel) {
      fetch(`${WORKER_BASE}/api/track-share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_id: p.id, channel })
      }).catch(() => {});
    }

    const editToggle = document.getElementById("lp-edit-toggle");
    if (editToggle && isOwner) {
      editToggle.addEventListener("click", () => {
        // Full inline edit form ships in the next build phase.
        // Placeholder confirms the toggle pattern works end to end.
        alert("Edit mode is coming in the next update — your pen button is wired and ready.");
      });
    }
  }

  // -------------------------------------------------------------------
  // SEO injection — per-slug meta tags Blogger's static <head> can't set
  // -------------------------------------------------------------------

  function injectSeoTags(p) {
    document.title = `${p.business_name} | Liyog World Business Profiles`;

    setMeta("description", p.tagline || stripHtml(p.bio_html).slice(0, 155));
    setMeta("og:title", p.business_name, true);
    setMeta("og:description", p.tagline || "", true);
    setMeta("og:image", p.cover_url || p.logo_url || "", true);
    setMeta("og:type", "business.business", true);
    setMeta("og:url", `${WORKER_BASE}/b/${p.slug}`, true);

    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = `${WORKER_BASE}/b/${p.slug}`;

    const ld = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "name": p.business_name,
      "description": p.tagline || "",
      "image": p.cover_url || p.logo_url || undefined,
      "telephone": p.phone_number || undefined,
      "address": {
        "@type": "PostalAddress",
        "streetAddress": p.store_address || undefined,
        "addressLocality": p.store_city || undefined,
        "addressCountry": p.store_country || undefined
      },
      "sameAs": [p.social_facebook, p.social_instagram, p.social_twitter, p.social_tiktok, p.social_youtube].filter(Boolean)
    };
    let script = document.getElementById("lp-jsonld");
    if (!script) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.id = "lp-jsonld";
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(ld);
  }

  function setMeta(name, content, isProperty) {
    if (!content) return;
    const attr = isProperty ? "property" : "name";
    let tag = document.querySelector(`meta[${attr}="${name}"]`);
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute(attr, name);
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
  }

  // -------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------

  function getCurrentUserId() {
    // Returns null until Google Auth phase ships. Kept as a single
    // function so wiring real auth later means editing one place.
    return null;
  }

  function safeParseArray(val) {
    try {
      const parsed = JSON.parse(val || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function buildWhatsAppLink(number, message, businessName) {
    if (!number) return null;
    const cleaned = number.replace(/[^\d+]/g, "");
    const text = message || `Hi ${businessName}, I found your profile on Liyog World and I'm interested.`;
    return `https://wa.me/${cleaned.replace("+", "")}?text=${encodeURIComponent(text)}`;
  }

  function sanitizeTel(number) {
    return number.replace(/[^\d+]/g, "");
  }

  function toYouTubeEmbed(url) {
    const match = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return match ? `https://www.youtube.com/embed/${match[1]}` : url;
  }

  function hasAnySocial(p) {
    return !!(p.social_facebook || p.social_instagram || p.social_twitter || p.social_tiktok || p.social_youtube || p.social_website);
  }

  function socialLink(url, label, icon) {
    if (!url) return "";
    return `<a class="lp-social-link" href="${escAttr(url)}" target="_blank" rel="noopener" aria-label="${escAttr(label)}" title="${escAttr(label)}">${icon}</a>`;
  }

  function formatYear(dateStr) {
    if (!dateStr) return "2026";
    return new Date(dateStr.replace(" ", "T") + "Z").getFullYear();
  }

  function stripHtml(html) {
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
  }

  function sanitizeBioHtml(html) {
    // Bio is stored pre-sanitized at save time (Quill output restricted
    // to bold/italic/color/font/lists per the moderation spec). This is
    // a defensive second pass: strips any script/iframe/link tags that
    // should never legitimately appear here.
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("script, iframe, a, object, embed").forEach(n => n.remove());
    return tmp.innerHTML;
  }

  function esc(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escAttr(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/"/g, "&quot;");
  }
})();
