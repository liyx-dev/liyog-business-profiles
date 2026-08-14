// =====================================================================
// LIYOG WORLD — src/lib/product-pages.js
// Two real, standalone, server-rendered pages (not SPA-redirect shims):
//   1. /products/{brand-slug}           — the full catalogue listing
//   2. /product/{product-slug}/{brand-slug} — one product's own page
//
// Both are genuine documents with real <title>, meta description,
// canonical URL, Open Graph + Twitter Card tags, and JSON-LD structured
// data — built for search engines and link-preview crawlers to read
// directly, with zero JavaScript required. A real browser gets the
// same HTML, then a small inline script boots the interactive layer
// (search/filter on the listing page; engagement bar wiring, view
// tracking, and "back to catalogue / back to brand" navigation on the
// product page) using the same profile.js functions already used
// elsewhere, so there is exactly one visual language across the whole
// site, just reached through purpose-built pages instead of modals.
//
// Deliberately split into its own file (per the "split code for easy
// debug/maintenance" instruction) — index.js only ever calls the two
// exported handlers below and never builds this HTML itself.
// =====================================================================

import * as productsEngagement from "./products-engagement.js";

function escapeHtmlAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Local, read-only cookie reader — deliberately duplicated rather than
// imported from index.js (which doesn't export it) to avoid touching
// index.js's existing exports/surface at all. Pure, single-purpose,
// identical behavior to index.js's own getCookie. Only ever used below
// to decide whether to bother attempting the owner-only chart fetch
// client-side (a UX nicety) — the actual security boundary remains the
// existing, unmodified /api/products/:id/chart endpoint in index.js,
// which independently verifies the session and ownership itself.
function hasSessionCookie(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  return /(?:^|;\s*)liyog_session=/.test(cookieHeader);
}

function buildMetaDescription(description, priceDisplay, maxLen = 160) {
  const desc = (description || "").replace(/\s+/g, " ").trim();
  const pricePart = priceDisplay ? `${priceDisplay} — ` : "";
  const combined = pricePart + desc;
  return combined.length > maxLen ? combined.slice(0, maxLen - 1) + "…" : combined;
}

async function getApprovedProfileBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, business_name, tagline, bio_html, logo_url, cover_url, business_category, is_active, moderation_status, referral_code, whatsapp_number, phone_number FROM profiles WHERE slug = ?"
  ).bind(slug).all();
  if (!results.length || !results[0].is_active || results[0].moderation_status !== "approved") return null;
  return results[0];
}

/* =====================================================================
   SERVER-SIDE CARD RENDERING — full parity with the brand-profile
   page's inline cards (engagementBarHtml/feedCardHtml/compactCardHtml
   in profile.js), re-implemented here so the listing page can
   server-render every product as real, crawlable HTML (profile.js
   only runs in the browser — it can't be called from the Worker).
   Every class name, data-action, and data attribute below is copied
   EXACTLY from profile.js so wireProductCardActions() (loaded from
   window.LiyogProductUI on the client) can wire these server-rendered
   cards with ZERO changes to that function — same selectors, same
   dataset keys, same nesting. If profile.js's card markup ever
   changes, this needs updating to match — see the comment above
   feedCardHtml() in profile.js for the counterpart. (2026-08-13)
   ===================================================================== */

const PRODUCT_PLACEHOLDER_SVG = `<div class="lp-product-image-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`;

function serverProductImageBlock(prod) {
  return prod.image_url
    ? `<img src="${escapeHtmlAttr(prod.image_url)}" alt="${escapeHtmlAttr(prod.name)}" loading="lazy" data-fallback="true">`
    : PRODUCT_PLACEHOLDER_SVG;
}

function serverEyeSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function serverLikeHandSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lp-like-hand-svg"><path d="M12 21s-6.7-4.35-9.3-8.2C1.1 10.5 1.6 7.4 4 5.9c2.1-1.3 4.7-.7 6.2 1.1L12 9l1.8-2c1.5-1.8 4.1-2.4 6.2-1.1 2.4 1.5 2.9 4.6 1.3 6.9C18.7 16.65 12 21 12 21z"/></svg>`;
}

function serverStarSvg(fillPercent, size) {
  const clipId = `pstar-clip-${Math.random().toString(36).slice(2, 9)}`;
  const pct = Math.max(0, Math.min(100, fillPercent));
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" class="lp-pstar-svg"><defs><clipPath id="${clipId}"><rect x="0" y="0" width="${(pct / 100) * 24}" height="24" /></clipPath></defs><path class="lp-pstar-bg" d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-.7z"/><path class="lp-pstar-fill" clip-path="url(#${clipId})" d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-.7z"/></svg>`;
}

function formatCompactNumberSSR(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1000000) return (num / 1000).toFixed(num % 1000 >= 100 ? 1 : 0) + "k";
  return (num / 1000000).toFixed(1) + "m";
}

// Same row-split structure as engagementBarHtml() in profile.js after
// the 2026-08-13 like/rating collision fix — views+rating share a top
// row, like gets its own full-width row beneath. Server-rendered with
// the logged-out default (no my_like/my_rating — that per-visitor
// state doesn't exist pre-hydration); the client-side init in
// product-pages-client.js re-syncs this against the real per-visitor
// state right after load for a signed-in visitor.
function serverEngagementBarHtml(prod, stats, feed) {
  const views = stats.view_count ?? prod.view_count ?? 0;
  const avgRating = stats.average_rating || 0;
  const ratingCount = stats.rating_count || 0;
  const likeCount = stats.like_count || 0;
  const sizeCls = feed ? "lp-engbar-feed" : "";
  const starSize = feed ? 20 : 17;
  const heartSize = feed ? 20 : 17;
  return `
    <div class="lp-engbar ${sizeCls}" data-product-id="${escapeHtmlAttr(prod.id)}" data-product-json="${escapeHtmlAttr(JSON.stringify(prod))}">
      <div class="lp-engbar-row-top">
        <span class="lp-engbar-item lp-engbar-views" title="Views">${serverEyeSvg()}<span>${formatCompactNumberSSR(views)}</span></span>
        <button type="button" class="lp-engbar-item lp-engbar-rate lp-engbar-invite-tap" data-action="rate" aria-label="Rate this product">${serverStarSvg(avgRating ? 100 : 0, starSize)}<span>${avgRating ? avgRating.toFixed(1) : ""}${ratingCount ? ` (${ratingCount})` : ""}</span></button>
      </div>
      <div class="lp-engbar-row-like">
        <button type="button" class="lp-engbar-item lp-engbar-like lp-engbar-invite-tap" data-action="like" aria-label="Like this product">${serverLikeHandSvg(heartSize)}<span>${formatCompactNumberSSR(likeCount)}</span></button>
      </div>
    </div>`;
}

function serverCardReportButtonHtml(prod) {
  return `<button type="button" class="lp-card-report-btn" data-action="report-flag" data-product-id="${escapeHtmlAttr(prod.id)}" data-product-name="${escapeHtmlAttr(prod.name)}" aria-label="Report this product"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V4a1 1 0 0 1 1-1h11.5a.5.5 0 0 1 .4.8L14 8l2.9 4.2a.5.5 0 0 1-.4.8H5v8"/></svg></button>`;
}

function serverContactButtonsHtml(profile, prod, feed) {
  const hasWhatsapp = !!profile.whatsapp_number;
  const hasCall = !!profile.phone_number;
  if (!hasWhatsapp && !hasCall) return "";
  const wrapClass = feed ? "lp-prodfeed-contacts" : "lp-prodcard-contacts";
  const btnClass = feed ? "lp-prodfeed-btn" : "lp-prodcard-btn";
  return `
    <div class="${wrapClass}">
      ${hasWhatsapp ? `
        <button type="button" class="${btnClass} ${btnClass}-whatsapp" data-product-name="${escapeHtmlAttr(prod.name)}" data-action="whatsapp">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0012.04 2z"/></svg>
          <span>WhatsApp</span>
        </button>` : ""}
      ${hasCall ? `
        <button type="button" class="${btnClass} ${btnClass}-call" data-action="call">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          <span>Call</span>
        </button>` : ""}
    </div>`;
}

function truncateLinesSSR(text, approxLines) {
  const charsPerLine = 42;
  const limit = approxLines * charsPerLine;
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit).trim() + "…";
}

// Full parity with feedCardHtml() in profile.js — same .lp-prodfeed
// markup, same nesting order (image → name → price → description →
// engagement bar → contact buttons). This is the "Facebook ad" style
// edge-to-edge card used for the very first product in the grid.
function serverFeedCardHtml(prod, profile, stats) {
  return `
    <div class="lp-prodfeed" data-product-id="${escapeHtmlAttr(prod.id)}">
      ${serverCardReportButtonHtml(prod)}
      <a class="lp-prodfeed-imgwrap" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}">
        ${serverProductImageBlock(prod)}
      </a>
      <div class="lp-prodfeed-body">
        <a class="lp-prodfeed-name" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}" style="text-decoration:none;color:inherit;">${escapeHtmlAttr(prod.name)}</a>
        ${prod.price_display ? `<div class="lp-prodfeed-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodfeed-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 3))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, true)}
        ${serverContactButtonsHtml(profile, prod, true)}
      </div>
    </div>`;
}

// Full parity with compactCardHtml() in profile.js — same .lp-prodcard
// markup used for every card after the first (the 2/3/4-column grid).
function serverCompactCardHtml(prod, profile, stats) {
  return `
    <div class="lp-prodcard" data-product-id="${escapeHtmlAttr(prod.id)}">
      ${serverCardReportButtonHtml(prod)}
      <a class="lp-prodcard-imgwrap" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}">
        ${serverProductImageBlock(prod)}
      </a>
      <div class="lp-prodcard-body">
        <a class="lp-prodcard-name" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}" style="text-decoration:none;color:inherit;">${escapeHtmlAttr(prod.name)}</a>
        ${prod.price_display ? `<div class="lp-prodcard-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodcard-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 2))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, false)}
        ${serverContactButtonsHtml(profile, prod, false)}
      </div>
    </div>`;
}

// Shared page chrome: header nav linking back to the brand profile,
// footer, and the CSS/JS assets already used everywhere else on the
// site — these pages intentionally reuse profile.css/profile.js
// rather than shipping a parallel styling system, so a visitor moving
// between the brand profile, the catalogue page, and a product page
// never sees a visual seam.
// 2026-08-13: added a dark-mode bootstrap (inline, before paint, so
// there's no flash-of-wrong-theme) and the floating inquiry button
// container — both purely additive, both explained in full where the
// mechanism actually lives (profile.css's dark-mode block + the
// initShopThemeToggle/openInquirySheet functions profile.js now
// exports on window.LiyogProductUI).
function pageShell({ title, metaDescription, canonicalUrl, ogImage, ogType, jsonLd, bodyHtml, origin, showFloatingInquiry, inquiryContextJs }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttr(title)}</title>
<meta name="description" content="${escapeHtmlAttr(metaDescription)}">
<link rel="canonical" href="${escapeHtmlAttr(canonicalUrl)}">
<meta property="og:type" content="${escapeHtmlAttr(ogType)}">
<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(metaDescription)}">
<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">
<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtmlAttr(title)}">
<meta name="twitter:description" content="${escapeHtmlAttr(metaDescription)}">
<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">
<link rel="stylesheet" href="${origin}/brands.css" id="lp-css-brands" onerror="window.__lpCssFailed=true">
<link rel="stylesheet" href="${origin}/product-pages.css" id="lp-css-shop" onerror="window.__lpCssFailed=true">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script>
// Runs before first paint so a returning visitor's saved dark-mode
// choice applies immediately — no flash of the wrong theme. Mirrors
// exactly what profile.css's dark-mode block already reads
// (data-theme on <html>); if nothing is saved, this does nothing and
// the page falls back to the OS prefers-color-scheme, same as today.
(function() {
  try {
    var t = localStorage.getItem("liyog_shop_theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();

// 2026-08-14: self-healing network detector for this server-rendered
// page. Unlike the brand-profile page, the CONTENT here is already
// real HTML from the first response — nothing needs a JS fetch to
// appear. The actual risk on a poor connection is the two
// stylesheets above (or product-pages-client.js below) failing or
// stalling mid-load, which leaves correct HTML but unstyled and
// non-interactive ("awkward and totally unstyled" per the reported
// issue). This checks for that specific condition rather than
// guessing:
//   1. onerror on either <link> sets window.__lpCssFailed immediately
//      if the browser reports an outright load failure.
//   2. As a backstop for a request that just STALLS instead of
//      failing (no onerror fires for that), a short timeout checks
//      whether the stylesheets actually applied by looking for a CSS
//      custom property we know profile.css defines at :root — if
//      it's still empty after the grace period, styling never landed.
// Either signal shows a small, dismissable "poor network" banner with
// a one-tap refresh — it never hides or blocks the real page content
// underneath, since that content is already there regardless.
(function() {
  function cssActuallyLoaded() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue("--liyog-green");
      return !!(v && v.trim());
    } catch (e) { return true; } // if we can't check, don't false-positive
  }
  function showNetworkBanner() {
    if (document.getElementById("lp-asset-fail-banner")) return; // already shown
    var banner = document.createElement("div");
    banner.id = "lp-asset-fail-banner";
    banner.className = "lp-asset-fail-banner";
    banner.innerHTML = "Your network looks poor — some parts of this page may not have loaded correctly. " +
      "<button type=\\"button\\" id=\\"lp-asset-fail-refresh\\">Refresh</button>";
    document.body.insertBefore(banner, document.body.firstChild);
    var btn = document.getElementById("lp-asset-fail-refresh");
    if (btn) btn.addEventListener("click", function() { window.location.reload(); });
  }
  function check() {
    if (window.__lpCssFailed || !cssActuallyLoaded()) showNetworkBanner();
  }
  // Grace period before checking — a normal (even moderately slow)
  // load easily finishes well within this, so it never fires on a
  // healthy connection; this is deliberately generous rather than
  // twitchy.
  setTimeout(check, 4000);
  // Also re-check sooner if the browser reports we're online after
  // having been offline — catches the "loaded broken, then recovered"
  // case without waiting the full grace period again.
  window.addEventListener("online", function() { setTimeout(check, 500); });
})();
</script>
</head>
<body>
<div class="lp-root" id="lp-root">
${bodyHtml}
${showFloatingInquiry ? `
<button type="button" class="lp-shop-float-inquiry" id="lp-shop-float-inquiry-btn" aria-label="Send an inquiry">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <span>Send an Inquiry</span>
</button>` : ""}
</div>
<script src="${origin}/brands.js"></script>
<script src="${origin}/product-pages-client.js"></script>
${inquiryContextJs || ""}
</body>
</html>`;
}


function serverLiyxLogoSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" class="lp-liyx-logo-svg" role="img" aria-label="LiyX AI"><defs><radialGradient id="liyxSphereGradient" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#FFF6D6"/><stop offset="45%" stop-color="#FFC24B"/><stop offset="100%" stop-color="#E8590C"/></radialGradient></defs><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(-20 50 50)"/><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(20 50 50)"/><g fill="none" stroke="#1E7A32" stroke-width="1.6" stroke-linejoin="round"><polygon points="50,10 68,18 78,32 78,50 68,68 50,78 32,68 22,50 22,32 32,18"/><polygon points="50,22 61,27 68,36 68,50 61,61 50,66 39,61 32,50 32,36 39,27"/><line x1="50" y1="10" x2="50" y2="22"/><line x1="68" y1="18" x2="61" y2="27"/><line x1="78" y1="32" x2="68" y2="36"/><line x1="78" y1="50" x2="68" y2="50"/><line x1="68" y1="68" x2="61" y2="61"/><line x1="50" y1="78" x2="50" y2="66"/><line x1="32" y1="68" x2="39" y2="61"/><line x1="22" y1="50" x2="32" y2="50"/><line x1="22" y1="32" x2="32" y2="36"/><line x1="32" y1="18" x2="39" y2="27"/><line x1="50" y1="10" x2="61" y2="27"/><line x1="68" y1="18" x2="68" y2="36"/><line x1="78" y1="32" x2="68" y2="50"/><line x1="78" y1="50" x2="61" y2="61"/><line x1="68" y1="68" x2="50" y2="66"/><line x1="50" y1="78" x2="39" y2="61"/><line x1="32" y1="68" x2="32" y2="50"/><line x1="22" y1="50" x2="32" y2="36"/><line x1="22" y1="32" x2="39" y2="27"/><line x1="32" y1="18" x2="50" y2="22"/></g><circle cx="50" cy="50" r="15" fill="url(#liyxSphereGradient)"/></svg>`;
}

// Full parity with catalogueInsightCardHtml() in profile.js — same
// .lp-liyx-insight/.lp-catalogue-insight markup, server-rendered so
// it's part of the indexable HTML (and visible to no-JS visitors),
// not injected after the fact.
function serverCatalogueInsightCardHtml(insight) {
  const keywords = Array.isArray(insight.top_keywords) ? insight.top_keywords : [];
  const flags = Array.isArray(insight.flags) ? insight.flags : [];
  return `
    <div class="lp-liyx-insight lp-catalogue-insight">
      <div class="lp-liyx-badge">
        ${serverLiyxLogoSvg(15)}
        <span>LiyX AI — Catalogue Insight</span>
      </div>
      <p class="lp-liyx-summary">${escapeHtmlAttr(insight.summary_text)}</p>
      <div class="lp-catalogue-insight-stats">
        <div class="lp-catalogue-stat"><strong>${formatCompactNumberSSR(insight.total_views || 0)}</strong><span>Views</span></div>
        <div class="lp-catalogue-stat"><strong>${formatCompactNumberSSR(insight.total_likes || 0)}</strong><span>Likes</span></div>
        <div class="lp-catalogue-stat"><strong>${formatCompactNumberSSR(insight.total_ratings || 0)}</strong><span>Ratings</span></div>
        <div class="lp-catalogue-stat"><strong>${insight.average_rating ? insight.average_rating.toFixed(1) : "—"}</strong><span>Avg ★</span></div>
      </div>
      ${flags.length ? `<div class="lp-catalogue-flags">${flags.map((f) => `<span class="lp-catalogue-flag">${escapeHtmlAttr(f)}</span>`).join("")}</div>` : ""}
      ${keywords.length ? `<div class="lp-liyx-keywords">${keywords.slice(0, 5).map((k) => `<span class="lp-liyx-keyword">${escapeHtmlAttr(k)}</span>`).join("")}</div>` : ""}
    </div>`;
}

// ---------------------------------------------------------------------
// Route 1: GET /products/{brand-slug} — the full catalogue listing.
// Server-renders EVERY product's full card markup directly (crawlable,
// indexable, no JS needed to see the catalogue — full parity with the
// brand-profile's inline cards: flag/report, views, like, star rating,
// name, description, WhatsApp/Call all present in the raw HTML), then
// a small inline script hydrates search/filter/sort interactivity and
// wires the engagement bar (like/rate/share/report) using profile.js's
// existing functions, exactly as the brand profile's inline grid does.
//
// 2026-08-13: every card is ALWAYS present in the server HTML (so
// nothing is ever hidden from a crawler or held back from indexing) —
// infinite scroll only progressively un-hides them for a real browser
// via the lp-shop-card-hidden class, so a long catalogue doesn't dump
// every product's image request at once. See product-pages-client.js.
// ---------------------------------------------------------------------
async function handleProductsListingPage(request, env, ctx, url) {
  const brandSlug = url.pathname.split("/")[2];
  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  const { results: products } = await env.DB.prepare(
    `SELECT id, name, description, price_display, image_url, slug, view_count, share_count, created_at
     FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0
     ORDER BY created_at DESC`
  ).bind(profile.id).all();

  // Pull stats for every product in one pass so sort-by-rating/likes
  // works server-side for the initial (pre-JS) render too — a crawler
  // or a visitor with JS disabled still sees a correctly sorted page,
  // not just an empty shell waiting on client-side data.
  const statsByProduct = {};
  for (const prod of products) {
    statsByProduct[prod.id] = await productsEngagement.getProductStats(env, prod.id);
  }

  const sortParam = url.searchParams.get("sort") || "newest";
  const queryParam = (url.searchParams.get("q") || "").toLowerCase();

  let filtered = products;
  if (queryParam) {
    filtered = filtered.filter((p) =>
      (p.name || "").toLowerCase().includes(queryParam) ||
      (p.description || "").toLowerCase().includes(queryParam)
    );
  }
  const sorters = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    views: (a, b) => (b.view_count || 0) - (a.view_count || 0),
    rating: (a, b) => (statsByProduct[b.id]?.average_rating || 0) - (statsByProduct[a.id]?.average_rating || 0),
    likes: (a, b) => (statsByProduct[b.id]?.like_count || 0) - (statsByProduct[a.id]?.like_count || 0)
  };
  filtered = [...filtered].sort(sorters[sortParam] || sorters.newest);

  const insight = await productsEngagement.getCatalogueInsight(env, profile.id);

  const canonicalUrl = `${url.origin}/products/${brandSlug}`;
  const title = `Products & Services — ${profile.business_name} | Liyog World`;
  const metaDescription = buildMetaDescription(
    profile.tagline || `Browse everything ${profile.business_name} offers — quality products and services in Nigeria.`,
    null,
    160
  );
  const ogImage = profile.cover_url || profile.logo_url || `${url.origin}/default-og-image.png`;

  // JSON-LD ItemList — tells search engines this page is a catalogue,
  // with each product as a ListItem pointing at its own canonical
  // product-page URL (real technical SEO, not decoration).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `${profile.business_name} — Products & Services`,
    "itemListElement": filtered.slice(0, 50).map((p, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "url": `${url.origin}/product/${encodeURIComponent(p.slug || p.id)}/${brandSlug}`
    }))
  };

  // Row 1 uses the full-width .lp-prodfeed "Facebook ad" style card
  // (exact same treatment as the brand-profile's inline row 1); every
  // subsequent product uses the compact .lp-prodcard grid tile. The
  // LiyX AI catalogue insight is server-rendered directly after that
  // first card, before the rest of the grid — matching the requested
  // "right after the first row of products" placement, and present in
  // the raw HTML (not injected later) so it's indexable too.
  //
  // Infinite scroll: the first INITIAL_VISIBLE compact cards render
  // normally; everything past that gets the lp-shop-card-hidden class
  // — still fully present in the DOM/HTML (so nothing is hidden from
  // search engines or no-JS visitors), just visually hidden until
  // product-pages-client.js's IntersectionObserver reveals batches of
  // 10 as the visitor scrolls.
  const INITIAL_VISIBLE = 10;
  const [firstProd, ...restProds] = filtered;
  const firstCardHtml = firstProd ? serverFeedCardHtml(firstProd, profile, statsByProduct[firstProd.id] || {}) : "";
  const insightHtml = insight && insight.summary_text ? serverCatalogueInsightCardHtml(insight) : "";
  const restCardsHtml = restProds.map((prod, i) => {
    const hiddenCls = i >= INITIAL_VISIBLE ? " lp-shop-card-hidden" : "";
    const stats = statsByProduct[prod.id] || {};
    const card = serverCompactCardHtml(prod, profile, stats);
    // Inject the hidden class onto the outer .lp-prodcard wrapper
    // without needing a second render pass.
    return hiddenCls ? card.replace('class="lp-prodcard"', `class="lp-prodcard${hiddenCls}"`) : card;
  }).join("");
  const hasMoreThanInitial = restProds.length > INITIAL_VISIBLE;

  const bodyHtml = `
    <header class="lp-shop-topheader">
      <div class="lp-shop-topheader-inner">
        <div class="lp-shop-topheader-brand">
          ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
          <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        </div>
        <nav class="lp-shop-topheader-nav">
          <button type="button" class="lp-shop-theme-toggle" id="lp-shop-theme-toggle-btn" aria-label="Toggle dark mode">
            <svg class="lp-theme-icon-sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            <svg class="lp-theme-icon-moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
            <span>Brand Profile</span>
          </a>
        </nav>
      </div>
    </header>

    <div class="lp-shop-page-body">
      <div class="lp-shop-hero">
        <h1 class="lp-shop-hero-title">Products &amp; Services</h1>
        <p class="lp-shop-hero-subtitle">${escapeHtmlAttr(profile.tagline || `Everything ${profile.business_name} offers, all in one place.`)}</p>
        <div class="lp-shop-hero-actions">
          <button type="button" class="lp-product-page-share-btn" id="lp-shop-page-share">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg>
            <span>Share</span>
          </button>
          <button type="button" class="lp-product-page-copy-btn" id="lp-shop-page-copy">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>Copy Link</span>
          </button>
        </div>
      </div>

      <div class="lp-shop-toolbar">
        <div class="lp-shop-toolbar-search" id="lp-shop-search-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
          <input type="text" id="lp-shop-search-input" class="lp-shop-search-input" placeholder="Search products & services…" value="${escapeHtmlAttr(url.searchParams.get("q") || "")}" autocomplete="off">
        </div>
        <div class="lp-shop-filter-group" id="lp-shop-sort-group" role="group" aria-label="Sort products">
          <button type="button" class="lp-shop-filter-btn ${sortParam === "newest" ? "lp-shop-filter-btn-active" : ""}" data-sort="newest">Newest</button>
          <button type="button" class="lp-shop-filter-btn ${sortParam === "rating" ? "lp-shop-filter-btn-active" : ""}" data-sort="rating">Top Rated</button>
          <button type="button" class="lp-shop-filter-btn ${sortParam === "views" ? "lp-shop-filter-btn-active" : ""}" data-sort="views">Most Viewed</button>
          <button type="button" class="lp-shop-filter-btn ${sortParam === "likes" ? "lp-shop-filter-btn-active" : ""}" data-sort="likes">Most Liked</button>
        </div>
      </div>

      <div class="lp-shop-grid" id="lp-shop-grid" data-all-products="${escapeHtmlAttr(JSON.stringify(filtered))}">
        ${firstCardHtml}
        ${insightHtml}
        ${restCardsHtml}
        ${!filtered.length ? `<p class="lp-shop-empty">No products match your search.</p>` : ""}
      </div>
      ${filtered.length ? `
      <div class="lp-shop-infinite-sentinel" id="lp-shop-infinite-sentinel" data-done="${hasMoreThanInitial ? "false" : "true"}" data-loading="false">
        <div class="lp-shop-infinite-spinner"></div>
        <button type="button" class="lp-shop-infinite-loadmore-btn" id="lp-shop-loadmore-btn">Load More Products</button>
        <span class="lp-shop-infinite-done-text">You've seen every product</span>
      </div>` : ""}
    </div>

    <footer class="lp-shop-footer">
      <div class="lp-shop-footer-inner">
        <div class="lp-shop-footer-brand">${escapeHtmlAttr(profile.business_name)}</div>
        <div class="lp-shop-footer-text">© <span id="lp-shop-footer-year"></span> ${escapeHtmlAttr(profile.business_name)}. Powered by Liyog World.</div>
        <div class="lp-shop-footer-links">
          <a href="/b/${escapeHtmlAttr(brandSlug)}">Brand Profile</a>
          <a href="/products/${escapeHtmlAttr(brandSlug)}">All Products</a>
        </div>
      </div>
    </footer>

    <script>
      window.__LIYOG_SHOP_CONTEXT__ = {
        profileId: ${JSON.stringify(profile.id)},
        profile: ${JSON.stringify(profile)},
        brandSlug: ${JSON.stringify(brandSlug)},
        businessName: ${JSON.stringify(profile.business_name)},
        products: ${JSON.stringify(filtered)},
        statsByProduct: ${JSON.stringify(statsByProduct)},
        insight: ${JSON.stringify(insight)},
        initialVisible: ${INITIAL_VISIBLE}
      };
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "website", jsonLd, bodyHtml, origin: url.origin,
    showFloatingInquiry: true
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}


// ---------------------------------------------------------------------
// Route 2: GET /product/{product-slug}/{brand-slug} — one product's
// own real page. Fully server-rendered (image, name, price,
// description, rating breakdown) so it's indexable and gives a
// correct link-preview card, then an inline script hydrates the
// interactive engagement bar / rating sheet / share menu.
// ---------------------------------------------------------------------
async function handleProductDetailPage(request, env, ctx, url) {
  const parts = url.pathname.split("/");
  const productSlug = parts[2];
  const brandSlug = parts[3];

  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  const { results: productRows } = await env.DB.prepare(
    "SELECT * FROM products WHERE profile_id = ? AND (slug = ? OR id = ?) AND is_active = 1"
  ).bind(profile.id, productSlug, productSlug).all();
  if (!productRows.length) return new Response("Not found", { status: 404 });
  const product = productRows[0];

  // The canonical view-count moment: a product's OWN page is what
  // counts as "the product was opened", per your instruction that
  // views should be tallied on the individual page rather than any
  // modal/lightbox. Fire-and-forget, never blocks the response.
  ctx.waitUntil(productsEngagement.recordView(env, product.id));

  const stats = await productsEngagement.getProductStats(env, product.id);
  const insight = await productsEngagement.getProductInsight(env, product.id);

  // Related products: top 5 by views+rating combined, excluding this
  // product. Falls back to any other 5 active products if nothing has
  // meaningful engagement yet, per instruction — visitors should never
  // see an empty "related" section just because a catalogue is new.
  const { results: candidateRows } = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.price_display, p.image_url, p.view_count,
            COALESCE(ps.average_rating, 0) as average_rating
     FROM products p LEFT JOIN product_stats ps ON ps.product_id = p.id
     WHERE p.profile_id = ? AND p.is_active = 1 AND p.is_draft = 0 AND p.id != ?`
  ).bind(profile.id, product.id).all();
  const related = [...candidateRows]
    .sort((a, b) => ((b.view_count || 0) + (b.average_rating || 0) * 20) - ((a.view_count || 0) + (a.average_rating || 0) * 20))
    .slice(0, 5);

  // Prev/Next: the same catalogue order the listing page defaults to
  // (newest first) — lets a visitor walk through every product without
  // returning to /products/{slug} first. Purely additive: one small
  // extra query, no schema change, no change to any existing route or
  // behavior. Falls back to wrapping around (last <-> first) rather
  // than dead-ending, so the nav is always usable.
  const { results: catalogueOrder } = await env.DB.prepare(
    `SELECT id, name, slug, image_url FROM products
     WHERE profile_id = ? AND is_active = 1 AND is_draft = 0
     ORDER BY created_at DESC`
  ).bind(profile.id).all();
  let prevProduct = null, nextProduct = null;
  if (catalogueOrder.length > 1) {
    const idx = catalogueOrder.findIndex((p) => p.id === product.id);
    if (idx !== -1) {
      prevProduct = catalogueOrder[(idx - 1 + catalogueOrder.length) % catalogueOrder.length];
      nextProduct = catalogueOrder[(idx + 1) % catalogueOrder.length];
    }
  }

  const canonicalUrl = `${url.origin}/product/${encodeURIComponent(product.slug || product.id)}/${brandSlug}`;
  const title = `${product.name} — ${profile.business_name} | Liyog World`;
  const metaDescription = buildMetaDescription(product.description, product.price_display);
  const ogImage = product.image_url || profile.cover_url || `${url.origin}/default-og-image.png`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": product.name,
    "description": product.description || undefined,
    "image": product.image_url || undefined,
    "offers": product.price_display ? {
      "@type": "Offer",
      "price": (product.price_display.match(/[\d.]+/) || [""])[0].replace(/,/g, ""),
      "priceCurrency": "NGN",
      "availability": "https://schema.org/InStock",
      "url": canonicalUrl
    } : undefined,
    "aggregateRating": stats.rating_count ? {
      "@type": "AggregateRating",
      "ratingValue": stats.average_rating,
      "reviewCount": stats.rating_count
    } : undefined
  };

  const relatedHtml = related.map((r) => {
    const rHref = `/product/${encodeURIComponent(r.slug || r.id)}/${escapeHtmlAttr(brandSlug)}`;
    return `<a class="lp-related-card" href="${rHref}">
      <div class="lp-related-card-imgwrap">
        ${r.image_url ? `<img src="${escapeHtmlAttr(r.image_url)}" alt="${escapeHtmlAttr(r.name)}" loading="lazy">` : ""}
      </div>
      <div class="lp-related-card-body">
        <div class="lp-related-card-name">${escapeHtmlAttr(r.name)}</div>
        ${r.price_display ? `<div class="lp-related-card-price">${escapeHtmlAttr(r.price_display)}</div>` : ""}
      </div>
    </a>`;
  }).join("");

  const prevNextHtml = (prevProduct && nextProduct) ? `
      <div class="lp-product-page-prevnext">
        <a class="lp-prevnext-btn lp-prevnext-btn-prev" href="/product/${encodeURIComponent(prevProduct.slug || prevProduct.id)}/${escapeHtmlAttr(brandSlug)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
          ${prevProduct.image_url ? `<img class="lp-prevnext-thumb" src="${escapeHtmlAttr(prevProduct.image_url)}" alt="" loading="lazy">` : ""}
          <span class="lp-prevnext-text"><span class="lp-prevnext-label">Previous</span><span class="lp-prevnext-name">${escapeHtmlAttr(prevProduct.name)}</span></span>
        </a>
        <a class="lp-prevnext-btn lp-prevnext-btn-next" href="/product/${encodeURIComponent(nextProduct.slug || nextProduct.id)}/${escapeHtmlAttr(brandSlug)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M9 18l6-6-6-6"/></svg>
          ${nextProduct.image_url ? `<img class="lp-prevnext-thumb" src="${escapeHtmlAttr(nextProduct.image_url)}" alt="" loading="lazy">` : ""}
          <span class="lp-prevnext-text"><span class="lp-prevnext-label">Next</span><span class="lp-prevnext-name">${escapeHtmlAttr(nextProduct.name)}</span></span>
        </a>
      </div>` : "";

  // The owner-only chart section only ever renders as an empty,
  // hidden mount point here — product-pages-client.js attempts the
  // existing owner-gated /api/products/:id/chart request and only
  // reveals this (via the lp-visible class) if that request actually
  // succeeds, i.e. the visitor genuinely is the authenticated owner.
  // hasOwnerSessionHint is just a cheap signal to skip the attempt
  // entirely for a visitor with no session cookie at all — it is
  // NOT the security boundary (the endpoint's own session+ownership
  // check is), just avoids a wasted network call for the common case
  // of an anonymous visitor.
  const hasOwnerSessionHint = hasSessionCookie(request);

  const bodyHtml = `
    <header class="lp-shop-topheader">
      <div class="lp-shop-topheader-inner">
        <div class="lp-shop-topheader-brand">
          ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
          <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        </div>
        <nav class="lp-shop-topheader-nav">
          <button type="button" class="lp-shop-theme-toggle" id="lp-shop-theme-toggle-btn" aria-label="Toggle dark mode">
            <svg class="lp-theme-icon-sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            <svg class="lp-theme-icon-moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <a href="/products/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
            <span>All Products</span>
          </a>
          <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn lp-shop-nav-btn-primary">
            <span>Brand Profile</span>
          </a>
        </nav>
      </div>
    </header>

    <div class="lp-product-page-body">
      <div class="lp-product-hero-wrap" id="lp-product-hero-wrap">
        ${product.image_url
          ? `<img src="${escapeHtmlAttr(product.image_url)}" alt="${escapeHtmlAttr(product.name)}" class="lp-product-hero-img" id="lp-product-hero-img">`
          : `<div class="lp-product-hero-placeholder"></div>`}
      </div>

      <h1 class="lp-product-page-name">${escapeHtmlAttr(product.name)}</h1>
      ${product.price_display ? `<div class="lp-product-page-price">${escapeHtmlAttr(product.price_display)}</div>` : ""}

      <div class="lp-product-page-engbar" id="lp-detail-engbar">${serverEngagementBarHtml(product, stats, false)}</div>

      ${product.description ? `<p class="lp-product-page-desc">${escapeHtmlAttr(product.description)}</p>` : ""}

      <div class="lp-detail-contact" id="lp-detail-contact">${serverContactButtonsHtml(profile, product, false)}</div>

      <div class="lp-product-page-actions">
        <button type="button" class="lp-product-page-share-btn" id="lp-product-page-share">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg>
          <span>Share</span>
        </button>
        <button type="button" class="lp-product-page-copy-btn" id="lp-product-page-copy">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Copy Link</span>
        </button>
        <button type="button" class="lp-product-page-report-btn" id="lp-product-page-report" data-product-id="${escapeHtmlAttr(product.id)}" data-product-name="${escapeHtmlAttr(product.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V4a1 1 0 0 1 1-1h11.5a.5.5 0 0 1 .4.8L14 8l2.9 4.2a.5.5 0 0 1-.4.8H5v8"/></svg>
          <span>Report</span>
        </button>
      </div>

      <div class="lp-detail-stats" id="lp-detail-stats"></div>
      <div class="lp-detail-insight" id="lp-detail-insight"></div>

      <div class="lp-product-page-owner-chart" id="lp-product-page-owner-chart" data-has-session-hint="${hasOwnerSessionHint ? "true" : "false"}" data-product-id="${escapeHtmlAttr(product.id)}"></div>

      ${related.length ? `
      <div class="lp-related-products">
        <h2 class="lp-related-products-title">You might also like</h2>
        <div class="lp-related-products-row">
          <button type="button" class="lp-related-arrow lp-related-arrow-prev" id="lp-related-arrow-prev" aria-label="Scroll left" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="lp-related-products-scroll" id="lp-related-products-scroll">${relatedHtml}</div>
          <button type="button" class="lp-related-arrow lp-related-arrow-next" id="lp-related-arrow-next" aria-label="Scroll right">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
      </div>` : ""}

      ${prevNextHtml}
    </div>

    <div class="lp-product-hero-lightbox" id="lp-product-hero-lightbox">
      <button type="button" class="lp-product-hero-lightbox-close" id="lp-product-hero-lightbox-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      ${product.image_url ? `<img src="${escapeHtmlAttr(product.image_url)}" alt="${escapeHtmlAttr(product.name)}">` : ""}
    </div>

    <footer class="lp-shop-footer">
      <div class="lp-shop-footer-inner">
        <div class="lp-shop-footer-brand">${escapeHtmlAttr(profile.business_name)}</div>
        <div class="lp-shop-footer-text">© <span id="lp-shop-footer-year"></span> ${escapeHtmlAttr(profile.business_name)}. Powered by Liyog World.</div>
        <div class="lp-shop-footer-links">
          <a href="/b/${escapeHtmlAttr(brandSlug)}">Brand Profile</a>
          <a href="/products/${escapeHtmlAttr(brandSlug)}">All Products</a>
        </div>
      </div>
    </footer>

    <script>
      window.__LIYOG_PRODUCT_PAGE_CONTEXT__ = {
        profile: ${JSON.stringify(profile)},
        product: ${JSON.stringify(product)},
        stats: ${JSON.stringify(stats)},
        insight: ${JSON.stringify(insight)},
        brandSlug: ${JSON.stringify(brandSlug)},
        hasOwnerSessionHint: ${JSON.stringify(hasOwnerSessionHint)}
      };
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "product", jsonLd, bodyHtml, origin: url.origin,
    showFloatingInquiry: true
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export { handleProductsListingPage, handleProductDetailPage };
