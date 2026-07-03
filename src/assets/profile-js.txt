/* =====================================================================
   LIYOG WORLD BUSINESS PROFILES — profile.js (v2 rebuild)
   Loads profile-template.html once, then fills it with data using
   plain DOM binding (textContent, src, href) — no HTML strings built
   for the main structure. Only small repeated lists (gallery, pills,
   social icons) are generated dynamically, and even those use
   createElement, not innerHTML concatenation.
   ===================================================================== */

(function () {
  "use strict";

  const WORKER_BASE = "https://www.liyogworld.com.ng";
  const TEMPLATE_URL = `${WORKER_BASE}/brands-template.html`;

  const mount = document.getElementById("liyog-profile-root");
  if (!mount) { console.error("liyog-profile-root not found."); return; }

  const params = new URLSearchParams(window.location.search);
  const slug = params.get("biz");
  let pagePath = window.location.pathname;

  init();

  async function init() {
    try {
      const cfgRes = await fetch(`${WORKER_BASE}/api/config`);
      const cfg = await cfgRes.json();
      if (cfg.blogger_profile_page) pagePath = cfg.blogger_profile_page;
    } catch (e) { /* fallback already set */ }

    if (!slug) {
      showClaimScreen();
      return;
    }

    showSkeleton();

    let templateHtml;
    try {
      const tplRes = await fetch(TEMPLATE_URL);
      templateHtml = await tplRes.text();
    } catch (e) {
      console.error("Template fetch failed:", e);
      showErrorScreen();
      return;
    }

    try {
      const currentUserId = getCurrentUserId();
      const dataRes = await fetch(
        `${WORKER_BASE}/b/${encodeURIComponent(slug)}?format=json${currentUserId ? `&viewer_id=${encodeURIComponent(currentUserId)}` : ""}`
      );
      const data = await dataRes.json();

      if (!data.found) { showNotFoundScreen(slug); return; }
      if (data.status === "pending_review") { showPendingScreen(); return; }

      mount.innerHTML = templateHtml;
      const isOwner = currentUserId && currentUserId === data.profile.owner_id;
      bindProfile(data.profile, isOwner);
      injectSeoTags(data.profile);
      cleanAddressBar(slug);
    } catch (e) {
      console.error("Profile fetch/render failed:", e);
      showErrorScreen();
    }
  }

  // -------------------------------------------------------------------
  // Data binding — the core of the rebuild
  // -------------------------------------------------------------------

  function bindProfile(p, isOwner) {
    setImg("[data-bind='cover_url']", p.cover_url, `${p.business_name} cover`);
    setImg(".lp-logo", p.logo_url, `${p.business_name} logo`);
    setText("[data-bind='business_name']", p.business_name);
    setText("[data-bind='tagline']", p.tagline || "");
    if (!p.tagline) hide(".lp-tagline");

    const verified = document.getElementById("lp-verified");
    if (verified && p.moderation_status === "approved") verified.hidden = false;

    const editBtn = document.getElementById("lp-edit-toggle");
    if (editBtn && isOwner) {
      editBtn.hidden = false;
      editBtn.addEventListener("click", () => {
        alert("Edit mode is coming in the next update — your edit button is wired and ready.");
      });
    }

    bindPills(safeParseArray(p.key_points));
    bindActions(p);
    bindBio(p.bio_html);
    bindGallery(safeParseArray(p.store_photos), p.business_name);
    bindVideo(p.youtube_url, p.business_name);
    bindMap(p.map_address, p.business_name);
    bindSocial(p);
    bindMeta(p);
    wireShare(p);
    wireLightbox();
  }

  function bindPills(points) {
    const wrap = document.getElementById("lp-pills");
    if (!wrap || !points.length) return;
    points.slice(0, 5).forEach((text) => {
      const pill = document.createElement("span");
      pill.className = "lp-pill";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("width", "12"); icon.setAttribute("height", "12");
      icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "3");
      icon.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
      pill.appendChild(icon);
      pill.appendChild(document.createTextNode(text));
      wrap.appendChild(pill);
    });
  }

  function bindActions(p) {
    const waLink = buildWhatsAppLink(p.whatsapp_number, p.wa_message, p.business_name);
    const waBtn = document.getElementById("lp-btn-whatsapp");
    if (waLink && waBtn) { waBtn.href = waLink; waBtn.hidden = false; }

    const callBtn = document.getElementById("lp-btn-call");
    if (p.phone_number && callBtn) { callBtn.href = `tel:${sanitizeTel(p.phone_number)}`; callBtn.hidden = false; }
  }

  function bindBio(bioHtml) {
    if (!bioHtml) return;
    const section = document.getElementById("lp-about-section");
    const target = document.querySelector("[data-bind='bio_html']");
    if (section && target) {
      target.innerHTML = sanitizeBioHtml(bioHtml);
      section.hidden = false;
    }
  }

  function bindGallery(photos, businessName) {
    if (!photos.length) return;
    const section = document.getElementById("lp-gallery-section");
    const wrap = document.getElementById("lp-gallery");
    if (!section || !wrap) return;
    photos.slice(0, 5).forEach((url, i) => {
      const img = document.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.alt = `${businessName} photo ${i + 1}`;
      img.dataset.full = url;
      wrap.appendChild(img);
    });
    section.hidden = false;
  }

  function bindVideo(youtubeUrl, businessName) {
    if (!youtubeUrl) return;
    const section = document.getElementById("lp-video-section");
    const iframe = document.getElementById("lp-youtube");
    if (!section || !iframe) return;
    iframe.src = toYouTubeEmbed(youtubeUrl);
    iframe.title = `${businessName} video`;
    section.hidden = false;
  }

  function bindMap(address, businessName) {
    if (!address) return;
    const section = document.getElementById("lp-map-section");
    const iframe = document.getElementById("lp-map");
    if (!section || !iframe) return;
    iframe.src = `https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed`;
    iframe.title = `${businessName} location`;
    section.hidden = false;
  }

  function bindSocial(p) {
    const links = [
      [p.social_facebook, "Facebook", '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'],
      [p.social_instagram, "Instagram", '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>'],
      [p.social_twitter, "X", '<path d="M4 4l16 16M20 4L4 20"/>'],
      [p.social_tiktok, "TikTok", '<path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/>'],
      [p.social_youtube, "YouTube", '<rect x="2" y="5" width="20" height="14" rx="4"/><polygon points="10 9 15 12 10 15"/>'],
      [p.social_website, "Website", '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>']
    ];
    const section = document.getElementById("lp-social-section");
    const wrap = document.getElementById("lp-social-row");
    if (!section || !wrap) return;
    let any = false;
    links.forEach(([url, label, pathData]) => {
      if (!url) return;
      any = true;
      const a = document.createElement("a");
      a.className = "lp-social-link";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = label;
      a.setAttribute("aria-label", label);
      a.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${pathData}</svg>`;
      wrap.appendChild(a);
    });
    if (any) section.hidden = false;
  }

  function bindMeta(p) {
    const views = document.getElementById("lp-views-count");
    const since = document.getElementById("lp-since-year");
    if (views) views.textContent = `${p.profile_views || 0} views`;
    if (since) since.textContent = `On Liyog World since ${formatYear(p.created_at)}`;
  }

  function wireShare(p) {
    const btn = document.getElementById("lp-btn-share");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const shareUrl = `${WORKER_BASE}/b/${p.slug}`;
      trackShare(p.id, "copy_link");
      if (navigator.share) {
        try { await navigator.share({ title: p.business_name, url: shareUrl }); return; }
        catch (e) { /* cancelled, fall through */ }
      }
      navigator.clipboard.writeText(shareUrl).then(() => {
        const original = btn.innerHTML;
        btn.textContent = "Copied";
        setTimeout(() => (btn.innerHTML = original), 1500);
      });
    });
  }

  function wireLightbox() {
    const gallery = document.getElementById("lp-gallery");
    const lightbox = document.getElementById("lp-lightbox");
    const img = document.getElementById("lp-lightbox-img");
    const closeBtn = document.getElementById("lp-lightbox-close");
    if (!gallery || !lightbox) return;
    gallery.addEventListener("click", (e) => {
      const target = e.target.closest("img[data-full]");
      if (!target) return;
      img.src = target.dataset.full;
      img.alt = target.alt;
      lightbox.classList.add("lp-open");
    });
    closeBtn.addEventListener("click", () => lightbox.classList.remove("lp-open"));
    lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.classList.remove("lp-open"); });
  }

  function trackShare(profileId, channel) {
    fetch(`${WORKER_BASE}/api/track-share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, channel })
    }).catch(() => {});
  }

  function cleanAddressBar(slug) {
    if (!window.history || !window.history.replaceState) return;
    const cleanUrl = `${WORKER_BASE}/b/${encodeURIComponent(slug)}`;
    if (window.location.href !== cleanUrl) window.history.replaceState({}, "", cleanUrl);
  }

  // -------------------------------------------------------------------
  // State screens
  // -------------------------------------------------------------------

  function showSkeleton() {
    mount.innerHTML = `<div class="lp-root"><div class="lp-skeleton">
      <div class="lp-skeleton-block" style="height:160px;margin-bottom:16px;"></div>
      <div class="lp-skeleton-block" style="height:22px;width:55%;margin:0 auto 10px;"></div>
      <div class="lp-skeleton-block" style="height:14px;width:35%;margin:0 auto;"></div>
    </div></div>`;
  }

  function showClaimScreen() {
    mount.innerHTML = `<div class="lp-root"><div class="lp-state-screen">
      <h2>Create your business profile</h2>
      <p>Get a free profile page and your own link to share, like liyogworld.com.ng/b/yourbusiness.</p>
      <a class="lp-state-cta" href="${escAttr(pagePath)}?signup=1">Get started</a>
    </div></div>`;
  }

  function showNotFoundScreen(slug) {
    mount.innerHTML = `<div class="lp-root"><div class="lp-state-screen">
      <h2>This profile doesn't exist yet</h2>
      <p>"${esc(slug)}" hasn't been claimed. Be the first to set it up.</p>
      <a class="lp-state-cta" href="${escAttr(pagePath)}?claim=${encodeURIComponent(slug)}">Claim this link</a>
    </div></div>`;
  }

  function showPendingScreen() {
    mount.innerHTML = `<div class="lp-root"><div class="lp-state-screen">
      <h2>Profile under review</h2>
      <p>This business profile is being checked and will be live shortly.</p>
    </div></div>`;
  }

  function showErrorScreen() {
    mount.innerHTML = `<div class="lp-root"><div class="lp-state-screen">
      <h2>Something went wrong</h2>
      <p>We couldn't load this profile right now. Please try again shortly.</p>
    </div></div>`;
  }

  // -------------------------------------------------------------------
  // SEO injection
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
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.appendChild(canonical); }
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
    if (!script) { script = document.createElement("script"); script.type = "application/ld+json"; script.id = "lp-jsonld"; document.head.appendChild(script); }
    script.textContent = JSON.stringify(ld);
  }

  function setMeta(name, content, isProperty) {
    if (!content) return;
    const attr = isProperty ? "property" : "name";
    let tag = document.querySelector(`meta[${attr}="${name}"]`);
    if (!tag) { tag = document.createElement("meta"); tag.setAttribute(attr, name); document.head.appendChild(tag); }
    tag.setAttribute("content", content);
  }

  // -------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------

  function setText(selector, value) {
    const el = document.querySelector(selector);
    if (el) el.textContent = value || "";
  }
  function setImg(selector, url, alt) {
    const el = document.querySelector(selector);
    if (el) { el.src = url || ""; el.alt = alt || ""; }
  }
  function hide(selector) {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  }

  // -------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------

  function getCurrentUserId() { return null; }

  function safeParseArray(val) {
    try { const parsed = JSON.parse(val || "[]"); return Array.isArray(parsed) ? parsed : []; }
    catch (e) { return []; }
  }
  function buildWhatsAppLink(number, message, businessName) {
    if (!number) return null;
    const cleaned = number.replace(/[^\d+]/g, "").replace("+", "");
    const text = message || `Hi ${businessName}, I found your profile on Liyog World and I'm interested.`;
    return `https://wa.me/${cleaned}?text=${encodeURIComponent(text)}`;
  }
  function sanitizeTel(number) { return number.replace(/[^\d+]/g, ""); }
  function toYouTubeEmbed(url) {
    const match = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return match ? `https://www.youtube.com/embed/${match[1]}` : url;
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
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("script, iframe, a, object, embed").forEach((n) => n.remove());
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
