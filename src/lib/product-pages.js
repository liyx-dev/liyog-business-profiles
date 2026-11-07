// =====================================================================
// BIZIPLEX / LIYOG WORLD — src/lib/product-pages.js  (restored original + premium product page)
//   1. /products/{brand}            CATALOGUE — your original design and behaviour, untouched.
//                                   Only additions: services/flyers fit neatly (blur backdrop),
//                                   a small video icon, and it never breaks if a new column is missing.
//   2. /product/{product}/{brand}   PRODUCT PAGE — your original page, upgraded:
//                                   photo gallery + YouTube video, live breadcrumbs, search-this-brand,
//                                   seller card + location, stay-safe note, collection row,
//                                   "Also from this Brand", smart bottom contact bar.
// Everything marked [R1] is new; everything else is the original code.
// =====================================================================

import * as productsEngagement from "./products-engagement.js";
import { siteHeadHtml, siteCssLinkHtml, siteHeaderHtml, siteFooterHtml, siteBottomNavHtml } from "./layout.js";
import { getProductImages, getCollectionForProduct, getCollectionItems } from "./shop-data.js"; // [R1]
import { minorToMajorString } from "./money.js";                                                // [R1]
import { getProfileLimits } from "./plans.js";                                                    // [R3]

function escapeHtmlAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function siteNameFor(url) {
  return /^(www\.)?biziplex\.com$/.test(url.hostname) ? "BiziPlex" : "Liyog World";
}

// Safe for JSON inside an inline <script>.
function safeJson(value) {
  const s = JSON.stringify(value);
  if (s === undefined) return "null";
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Only decides whether to TRY the owner-only chart; the real check is in /api/products/:id/chart.
function hasSessionCookie(request) {
  return /(?:^|;\s*)liyog_session=/.test(request.headers.get("Cookie") || "");
}

function buildMetaDescription(description, priceDisplay, maxLen = 160) {
  const desc = (description || "").replace(/\s+/g, " ").trim();
  const pricePart = priceDisplay ? `${priceDisplay} — ` : "";
  const combined = pricePart + desc;
  return combined.length > maxLen ? combined.slice(0, maxLen - 1) + "…" : combined;
}

async function getApprovedProfileBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, business_name, tagline, bio_html, logo_url, cover_url, business_category, is_active, moderation_status, referral_code, whatsapp_number, phone_number, store_city, store_country, response_time, tier_id, max_products, youtube_url FROM profiles WHERE slug = ?"
  ).bind(slug).all();
  if (!results.length || !results[0].is_active || results[0].moderation_status !== "approved") return null;
  return results[0];
}

// [R1] Optional extras must never take a page down (for example if a database upgrade step was missed).
async function safe(promise, fallback) {
  try { return await promise; } catch (e) { console.error("optional page query failed:", e); return fallback; }
}

// [R1] Services/flyers and unusually shaped photos sit whole on a soft blurred copy of themselves.
function bgStyle(url) {
  if (!url) return "";
  const u = encodeURI(String(url)).replace(/['"()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16));
  return `--bz-bg:url('${u}');`;
}
function needsBlur(prod) {
  if (!prod || !prod.image_url) return false;
  if (prod.kind === "service") return true;
  const w = Number(prod.img_w), h = Number(prod.img_h);
  if (!w || !h) return false;
  const r = w / h;
  return r < 0.92 || r > 1.1;
}
function hasVideo(prod) { return !!(prod && prod.video_id && prod.video_status !== "broken"); }
const VIDEO_BADGE = `<span class="lp-vid-badge" title="Has video" aria-label="Has video"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>`;

/* =====================================================================
   SERVER-SIDE CARD RENDERING — unchanged original (parity with profile.js)
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

// Same row-split structure as engagementBarHtml() in profile.js. Server-rendered logged-out default;
// product-pages-client.js re-syncs it with the visitor's real state after load.
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

function serverBoostBadgeHtml(isBoosted, feed) {
  if (!isBoosted) return "";
  return `<span class="${feed ? "lp-prodfeed-featured" : "lp-prodcard-featured"}" title="Featured"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.26L21 9.27l-4.5 4.38L17.8 20 12 16.9 6.2 20l1.3-6.35L3 9.27l6.1-1.01z"/></svg>Featured</span>`;
}

// [R1] image wrapper attributes: blur-fit for services/odd shapes + the small video icon. Otherwise identical to the original.
function imgWrapExtras(prod) {
  const blur = needsBlur(prod);
  return { cls: blur ? " lp-fit-blur" : "", style: blur ? ` style="${escapeHtmlAttr(bgStyle(prod.image_url))}"` : "", badge: hasVideo(prod) ? VIDEO_BADGE : "" };
}

function serverFeedCardHtml(prod, profile, stats, isFeatured) {
  const x = imgWrapExtras(prod);
  return `
    <div class="lp-prodfeed" data-product-id="${escapeHtmlAttr(prod.id)}">
      ${serverBoostBadgeHtml(isFeatured, true)}
      ${serverCardReportButtonHtml(prod)}
      <a class="lp-prodfeed-imgwrap${x.cls}"${x.style} href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}">
        ${serverProductImageBlock(prod)}${x.badge}
      </a>
      <div class="lp-prodfeed-body">
        <a class="lp-prodfeed-name" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}" style="text-decoration:none;color:inherit;">${escapeHtmlAttr(prod.name)}</a>
        ${prod.price_display ? `<div class="lp-prodfeed-price"${fxAttrs(prod)}>${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodfeed-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 3))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, true)}
        ${serverContactButtonsHtml(profile, prod, true)}
      </div>
    </div>`;
}

function serverCompactCardHtml(prod, profile, stats, isFeatured) {
  const x = imgWrapExtras(prod);
  return `
    <div class="lp-prodcard" data-product-id="${escapeHtmlAttr(prod.id)}">
      ${serverBoostBadgeHtml(isFeatured, false)}
      ${serverCardReportButtonHtml(prod)}
      <a class="lp-prodcard-imgwrap${x.cls}"${x.style} href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}">
        ${serverProductImageBlock(prod)}${x.badge}
      </a>
      <div class="lp-prodcard-body">
        <a class="lp-prodcard-name" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(profile.slug)}" style="text-decoration:none;color:inherit;">${escapeHtmlAttr(prod.name)}</a>
        ${prod.price_display ? `<div class="lp-prodcard-price"${fxAttrs(prod)}>${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodcard-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 2))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, false)}
        ${serverContactButtonsHtml(profile, prod, false)}
      </div>
    </div>`;
}

// Shared page chrome (original) + [R1] shop.css / shop-ui.js and the optional bottom contact bar.
function pageShell({ title, metaDescription, canonicalUrl, ogImage, ogType, jsonLd, bodyHtml, origin, showFloatingInquiry, inquiryContextJs, ctaBarHtml, robots }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtmlAttr(title)}</title>
<meta name="description" content="${escapeHtmlAttr(metaDescription)}">
<link rel="canonical" href="${escapeHtmlAttr(canonicalUrl)}">
<meta name="robots" content="${robots || "index, follow, max-image-preview:large"}">
<meta property="og:type" content="${escapeHtmlAttr(ogType)}">
<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(metaDescription)}">
<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">
<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtmlAttr(title)}">
<meta name="twitter:description" content="${escapeHtmlAttr(metaDescription)}">
<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">
${siteHeadHtml(origin)}
<style>img,video{max-width:100%;height:auto}.bz-fsearch,.bz-ffilter,.bz-ctabar,.bz-dial,.bz-ss{display:none}</style>
<link rel="stylesheet" href="${origin}/brands.css" id="lp-css-brands" onerror="window.__lpCssFailed=true">
<link rel="stylesheet" href="${origin}/product-pages.css" id="lp-css-shop" onerror="window.__lpCssFailed=true">
${siteCssLinkHtml(origin)}
<link rel="stylesheet" href="${origin}/shop.css">
<script type="application/ld+json">${safeJson(jsonLd)}</script>
<script>
(function() {
  try {
    var t = localStorage.getItem("liyog_shop_theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();

// Poor-network detector: shows a small "Refresh" banner if the stylesheets never applied.
(function() {
  function cssActuallyLoaded() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue("--liyog-green");
      return !!(v && v.trim());
    } catch (e) { return true; }
  }
  function showNetworkBanner() {
    if (document.getElementById("lp-asset-fail-banner")) return;
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
  setTimeout(check, 4000);
  window.addEventListener("online", function() { setTimeout(check, 500); });
})();
</script>
</head>
<body class="bz-site bz-has-bottomnav${ctaBarHtml ? " bz-has-ctabar" : ""}">
${siteHeaderHtml({ active: "" })}
<main class="bz-main" id="bz-main">
<div class="lp-root lp-root-wide" id="lp-root">
${bodyHtml}
${showFloatingInquiry ? `
<button type="button" class="lp-shop-float-inquiry" id="lp-shop-float-inquiry-btn" aria-label="Send an inquiry">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <span>Send an Inquiry</span>
</button>` : ""}
${ctaBarHtml || ""}
</div>
</main>
${siteFooterHtml()}
${siteBottomNavHtml({ active: "" })}
<script src="${origin}/brands.js"></script>
<script src="${origin}/sponsored-ui.js"></script>
<script src="${origin}/product-pages-client.js"></script>
<script src="${origin}/shop-ui.js"></script>
${inquiryContextJs || ""}
<script src="${origin}/site.js" defer></script>
</body>
</html>`;
}

function serverLiyxLogoSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" class="lp-liyx-logo-svg" role="img" aria-label="LiyX AI"><defs><radialGradient id="liyxSphereGradient" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#FFF6D6"/><stop offset="45%" stop-color="#FFC24B"/><stop offset="100%" stop-color="#E8590C"/></radialGradient></defs><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(-20 50 50)"/><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(20 50 50)"/><g fill="none" stroke="#1E7A32" stroke-width="1.6" stroke-linejoin="round"><polygon points="50,10 68,18 78,32 78,50 68,68 50,78 32,68 22,50 22,32 32,18"/><polygon points="50,22 61,27 68,36 68,50 61,61 50,66 39,61 32,50 32,36 39,27"/><line x1="50" y1="10" x2="50" y2="22"/><line x1="68" y1="18" x2="61" y2="27"/><line x1="78" y1="32" x2="68" y2="36"/><line x1="78" y1="50" x2="68" y2="50"/><line x1="68" y1="68" x2="61" y2="61"/><line x1="50" y1="78" x2="50" y2="66"/><line x1="32" y1="68" x2="39" y2="61"/><line x1="22" y1="50" x2="32" y2="50"/><line x1="22" y1="32" x2="32" y2="36"/><line x1="32" y1="18" x2="39" y2="27"/><line x1="50" y1="10" x2="61" y2="27"/><line x1="68" y1="18" x2="68" y2="36"/><line x1="78" y1="32" x2="68" y2="50"/><line x1="78" y1="50" x2="61" y2="61"/><line x1="68" y1="68" x2="50" y2="66"/><line x1="50" y1="78" x2="39" y2="61"/><line x1="32" y1="68" x2="32" y2="50"/><line x1="22" y1="50" x2="32" y2="36"/><line x1="22" y1="32" x2="39" y2="27"/><line x1="32" y1="18" x2="50" y2="22"/></g><circle cx="50" cy="50" r="15" fill="url(#liyxSphereGradient)"/></svg>`;
}

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
// [R3] shared builders used by the catalogue, collection page and video page
// ---------------------------------------------------------------------
const STAY_SAFE_MSGS = [
  "doesn't control chats or payments that happen outside the platform. Meet in safe places and never pay for something you haven't confirmed.",
  "will never ask you for passwords or card PINs. Be careful with anyone who does, and confirm what you are buying before you pay.",
  "can't protect deals made outside the platform. Check the seller's profile and reviews first, and keep proof of what you agree."
];
function staySafeHtml(url, seed) {
  const m = STAY_SAFE_MSGS[Math.abs(Number(seed) || 0) % STAY_SAFE_MSGS.length];
  return `<div class="bz-safe" role="note">${IC.shield}<p><strong>Stay safe.</strong> ${siteNameFor(url)} ${m}</p></div>`;
}
function fxAttrs(p) {
  return (p && p.price_minor != null && p.currency)
    ? ` data-fx-minor="${Number(p.price_minor) || 0}" data-fx-cur="${escapeHtmlAttr(p.currency)}"${p.price_type === "from" ? ' data-fx-from="1"' : ""}` : "";
}
function firstSentence(text, max = 110) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  const out = m ? m[1] : s;
  return out.length > max ? out.slice(0, max - 1).trim() + "…" : out;
}
function safeColor(c) { return /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : ""; }
function hrefWith(base, params) {
  const u = new URLSearchParams();
  Object.keys(params).forEach((k) => { if (params[k] !== "" && params[k] != null) u.set(k, params[k]); });
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}
function ytIdFrom(raw) {
  const m = String(raw || "").trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function productHref(p, brandSlug, colSlug) {
  return `/product/${encodeURIComponent(p.slug || p.id)}/${encodeURIComponent(brandSlug)}${colSlug ? `?c=${encodeURIComponent(colSlug)}` : ""}`;
}

// Services show in their own shape (1:1, 4:5 or 16:9). Anything else sits in a 16:9 frame over a soft blur.
const SVC_RATIOS = [0.8, 1, 16 / 9];
function svcFrame(p) {
  const w = Number(p.img_w), h = Number(p.img_h);
  if (!w || !h) return { ar: 16 / 9, exact: false };
  const r = w / h;
  let best = SVC_RATIOS[0];
  for (const x of SVC_RATIOS) if (Math.abs(Math.log(r / x)) < Math.abs(Math.log(r / best))) best = x;
  return Math.abs(r / best - 1) <= 0.06 ? { ar: best, exact: true } : { ar: 16 / 9, exact: false };
}

function serverServiceCardHtml(prod, profile, stats, isFeatured, extraCls) {
  const f = svcFrame(prod);
  const style = `--bz-ar:${f.ar.toFixed(4)};${f.exact ? "" : bgStyle(prod.image_url)}`;
  const href = productHref(prod, profile.slug);
  return `
    <div class="lp-prodcard lp-svccard${extraCls || ""}" data-product-id="${escapeHtmlAttr(prod.id)}">
      ${serverBoostBadgeHtml(isFeatured, false)}
      ${serverCardReportButtonHtml(prod)}
      <a class="lp-prodcard-imgwrap lp-svc-media${f.exact ? "" : " lp-fit-blur"}" style="${escapeHtmlAttr(style)}" href="${href}">
        ${serverProductImageBlock(prod)}${hasVideo(prod) ? VIDEO_BADGE : ""}<span class="bz-svc-tag">Service</span>
      </a>
      <div class="lp-prodcard-body">
        <a class="lp-prodcard-name" href="${href}" style="text-decoration:none;color:inherit;">${escapeHtmlAttr(prod.name)}</a>
        ${prod.price_display ? `<div class="lp-prodcard-price"${fxAttrs(prod)}>${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodcard-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 2))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, false)}
        ${serverContactButtonsHtml(profile, prod, false)}
      </div>
    </div>`;
}

const STACK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M6 5h12M8.5 2h7"/></svg>`;

// Collection cover: the first item's picture. 16:9 pictures fill the frame; other shapes sit whole on a blur.
function collectionCoverHtml(c, cls) {
  const cw = Number(c.cw), ch = Number(c.ch);
  const exact = c.cover_url && cw && ch && Math.abs(cw / ch / (16 / 9) - 1) <= 0.06;
  if (!c.cover_url) {
    const col = safeColor(c.cover_color);
    return `<div class="${cls} bz-cover-fallback" style="${col ? `--bz-fb:${col};` : ""}"><img class="bz-cover-logo" src="/brand/logo-mark.png" alt="" width="56" height="56" loading="lazy"></div>`;
  }
  return `<div class="${cls}${exact ? "" : " lp-fit-blur"}"${exact ? "" : ` style="${escapeHtmlAttr(bgStyle(c.cover_url))}"`}><img src="${escapeHtmlAttr(c.cover_url)}" alt="" loading="lazy" decoding="async"></div>`;
}
function serverCollectionCardHtml(c, brandSlug) {
  const href = `/collection/${encodeURIComponent(brandSlug)}/${encodeURIComponent(c.slug)}`;
  const blurb = firstSentence(c.description, 90);
  return `<a class="bz-colcard" href="${href}" aria-label="Collection: ${escapeHtmlAttr(c.title)}, ${Number(c.item_count) || 0} items">
    <div class="bz-colcard-frame">${collectionCoverHtml(c, "bz-colcard-media")}<span class="bz-colcard-count">${STACK_ICON}${Number(c.item_count) || 0} items</span></div>
    <div class="bz-colcard-body"><strong>${escapeHtmlAttr(c.title)}</strong>${blurb ? `<p>${escapeHtmlAttr(blurb)}</p>` : ""}<span class="bz-colcard-view">View collection ›</span></div></a>`;
}

function serverVideoCardHtml(v, brandSlug) {
  const href = `/video/${encodeURIComponent(brandSlug)}/${encodeURIComponent(v.ref)}`;
  return `<a class="bz-vidcard" href="${href}" aria-label="Watch video: ${escapeHtmlAttr(v.title)}">
    <div class="bz-vidcard-media"><img src="https://i.ytimg.com/vi/${escapeHtmlAttr(v.vid)}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="bz-vidcard-play"><svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span><span class="bz-vidcard-tag">${escapeHtmlAttr(v.tag)}</span></div>
    <div class="bz-vidcard-body"><strong>${escapeHtmlAttr(v.title)}</strong>${v.price_display ? `<span${fxAttrs(v)}>${escapeHtmlAttr(v.price_display)}</span>` : ""}</div></a>`;
}

// Every video a brand has: its profile video plus the video of each listing. Broken ones never appear.
function collectVideos(products, profile) {
  const out = [];
  const bv = ytIdFrom(profile.youtube_url);
  if (bv) out.push({ ref: "brand", vid: bv, title: `${profile.business_name} — brand video`, tag: "Brand video", kind: "brand" });
  for (const p of products) {
    if (hasVideo(p)) out.push({ ref: p.slug || p.id, vid: p.video_id, title: p.name, tag: p.kind === "service" ? "Service" : "Product", kind: p.kind === "service" ? "service" : "product", price_display: p.price_display, price_minor: p.price_minor, currency: p.currency, price_type: p.price_type, description: p.description, productId: p.id });
  }
  return out;
}

function stripSection(title, seeAllHref, inner, cls) {
  return `<section class="bz-strip${cls ? " " + cls : ""}" aria-label="${escapeHtmlAttr(title)}">
    <div class="bz-strip-head"><h2>${escapeHtmlAttr(title)}</h2>${seeAllHref ? `<a class="bz-linkbtn" href="${seeAllHref}">See all ›</a>` : ""}</div>
    <div class="bz-strip-scroll" tabindex="0">${inner}</div></section>`;
}

// Ad slots for views that have no scroll-reveal: sponsored-ui mounts these when they come near the screen.
const AD_SEQUENCE = [["products", "strip"], ["products", "grid"], ["catalogues", "grid"], ["products", "grid"], ["catalogues", "strip"], ["profiles", "grid"]];
function adSlotHtml(i, profile) {
  const [surface, format] = AD_SEQUENCE[i % AD_SEQUENCE.length];
  const title = surface === "products" ? "Sponsored Products" : surface === "catalogues" ? "Discover More Shops" : "You Might Also Like";
  return `<div class="bz-ad-slot" data-liyog-ads="${surface}" data-format="${format}" data-title="${title}" data-limit="${format === "grid" ? 6 : 8}" data-exclude="${escapeHtmlAttr(profile.id)}" data-category="${escapeHtmlAttr(profile.business_category || "")}"></div>`;
}

// ---------------------------------------------------------------------
// Route 1: GET /products/{brand-slug} — CATALOGUE.
// Your original page (feed card, insight card, engagement cards, infinite reveal, ads) plus:
//   Search sheet, scrollable filter tabs (Products / Services / Collections / Videos + sorts),
//   rows for collections, services and videos, price in the visitor's currency, stay-safe note.
// ---------------------------------------------------------------------
async function handleProductsListingPage(request, env, ctx, url) {
  const brandSlug = url.pathname.split("/")[2];
  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  const sp = url.searchParams;
  const VIEWS = ["products", "services", "collections", "videos"];
  const view = VIEWS.includes(sp.get("view")) ? sp.get("view") : "products";
  const SORTS = ["newest", "rating", "views", "likes", "price_asc", "price_desc"];
  const sortParam = SORTS.includes(sp.get("sort")) ? sp.get("sort") : "newest";
  const queryRaw = (sp.get("q") || "").slice(0, 80);
  const queryParam = queryRaw.toLowerCase();
  const featuredOnly = sp.get("featured") === "1";

  // [R3] the richer column list first; if a database upgrade step is missing, the original query.
  let products;
  try {
    ({ results: products } = await env.DB.prepare(
      `SELECT id, name, description, price_display, price_minor, currency, price_type, image_url, slug, view_count, share_count, created_at, kind, img_w, img_h, img_color, video_id, video_status
       FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 ORDER BY created_at DESC LIMIT 1500`
    ).bind(profile.id).all());
  } catch (e) {
    ({ results: products } = await env.DB.prepare(
      `SELECT id, name, description, price_display, image_url, slug, view_count, share_count, created_at
       FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 ORDER BY created_at DESC LIMIT 1500`
    ).bind(profile.id).all());
  }

  // [R3] rating/like numbers for all cards in as few queries as possible (was one query per product).
  const statsByProduct = {};
  const ids = products.map((p) => p.id);
  try {
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const { results } = await env.DB.prepare(`SELECT * FROM product_stats WHERE product_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      results.forEach((r) => { statsByProduct[r.product_id] = r; });
    }
  } catch (e) {
    for (const prod of products.slice(0, 120)) statsByProduct[prod.id] = await productsEngagement.getProductStats(env, prod.id);
  }
  const statsOf = (id) => statsByProduct[id] || { average_rating: 0, rating_count: 0, like_count: 0 };

  const featuredSet = new Set();
  try {
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const { results: boostRows } = await env.DB.prepare(
        `SELECT DISTINCT product_id FROM boost_log WHERE scope = 'product' AND product_id IN (${chunk.map(() => "?").join(",")}) AND expires_at > datetime('now')`
      ).bind(...chunk).all();
      boostRows.forEach((r) => featuredSet.add(r.product_id));
    }
  } catch (e) { /* featured badges are cosmetic */ }

  const productsAll = products.filter((p) => p.kind !== "service");
  const servicesAll = products.filter((p) => p.kind === "service");
  const videosAll = collectVideos(products, profile);
  const planLimits = (await safe(getProfileLimits(env, { tier_id: profile.tier_id, max_products: profile.max_products }), { limits: {} })).limits || {};
  const stripCollections = Math.max(0, Number(planLimits.catalogue_collections_strip ?? 5));
  const stripVideos = Math.max(0, Number(planLimits.catalogue_videos_strip ?? 5));
  const stripServices = Math.max(0, Number(planLimits.catalogue_services_strip ?? 6));

  const collections = await safe(env.DB.prepare(
    `SELECT c.id, c.slug, c.title, c.description, c.item_count, c.reach, c.cover_url, c.cover_color,
       (SELECT p.img_w FROM collection_items ci JOIN products p ON p.id = ci.product_id WHERE ci.collection_id = c.id AND p.is_active = 1 AND p.is_draft = 0 ORDER BY ci.position ASC LIMIT 1) AS cw,
       (SELECT p.img_h FROM collection_items ci JOIN products p ON p.id = ci.product_id WHERE ci.collection_id = c.id AND p.is_active = 1 AND p.is_draft = 0 ORDER BY ci.position ASC LIMIT 1) AS ch
     FROM collections c WHERE c.profile_id = ? AND c.status = 'live' AND c.item_count > 0 ORDER BY c.position ASC, c.created_at ASC LIMIT 60`
  ).bind(profile.id).all().then((r) => r.results), []);

  const matchQ = (text) => !queryParam || String(text || "").toLowerCase().includes(queryParam);
  const sorters = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    views: (a, b) => (b.view_count || 0) - (a.view_count || 0),
    rating: (a, b) => (statsOf(b.id).average_rating || 0) - (statsOf(a.id).average_rating || 0),
    likes: (a, b) => (statsOf(b.id).like_count || 0) - (statsOf(a.id).like_count || 0),
    price_asc: (a, b) => { const x = a.price_minor, y = b.price_minor; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x - y; },
    price_desc: (a, b) => { const x = a.price_minor, y = b.price_minor; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return y - x; }
  };
  const refine = (list) => {
    let out = list.filter((p) => matchQ(p.name) || matchQ(p.description));
    if (featuredOnly) out = out.filter((p) => featuredSet.has(p.id));
    return [...out].sort(sorters[sortParam] || sorters.newest);
  };

  const base = `/products/${encodeURIComponent(brandSlug)}`;
  const isFiltered = !!(queryParam || featuredOnly || sortParam !== "newest");
  const isPlain = view === "products" && !isFiltered;
  const viewLabel = { products: "Products", services: "Services", collections: "Collections", videos: "Videos" }[view];
  const canonicalUrl = `${url.origin}${view === "products" ? base : hrefWith(base, { view })}`;
  const title = `${view === "products" ? "Products & Services" : viewLabel} — ${profile.business_name} | ${siteNameFor(url)}`;
  const metaDescription = buildMetaDescription(
    profile.tagline || `Browse ${view === "products" ? "everything" : `the ${viewLabel.toLowerCase()}`} ${profile.business_name} offers on ${siteNameFor(url)}.`, null, 160);
  const ogImage = profile.cover_url || profile.logo_url || `${url.origin}/default-og-image.png`;

  const insight = view === "products" ? await safe(productsEngagement.getCatalogueInsight(env, profile.id), null) : null;

  // ---- the main area, per view ------------------------------------------------
  const INITIAL_VISIBLE = 10;
  const hidden = (i) => (i >= INITIAL_VISIBLE ? " lp-shop-card-hidden" : "");
  let gridHtml = "", gridCls = "", listForLd = [], total = 0;
  let adIndex = 0;
  const withAds = (items, every) => items.map((h, i) => ((i + 1) % every === 0 && i + 1 < items.length ? h + adSlotHtml(adIndex++, profile) : h));

  if (view === "products") {
    const filtered = refine(productsAll);
    total = filtered.length; listForLd = filtered;
    const [firstProd, ...restProds] = filtered;
    const firstCardHtml = firstProd ? serverFeedCardHtml(firstProd, profile, statsOf(firstProd.id), featuredSet.has(firstProd.id)) : "";
    const insightHtml = insight && insight.summary_text ? serverCatalogueInsightCardHtml(insight) : "";
    const servicesStrip = isPlain && servicesAll.length && stripServices
      ? stripSection("Services", hrefWith(base, { view: "services" }),
          servicesAll.slice(0, stripServices).map((s) => `<div class="bz-strip-item bz-strip-item-svc">${serverServiceCardHtml(s, profile, statsOf(s.id), featuredSet.has(s.id))}</div>`).join(""), "bz-strip-svc") : "";
    const rest = restProds.map((prod, i) => {
      const card = serverCompactCardHtml(prod, profile, statsOf(prod.id), featuredSet.has(prod.id));
      return hidden(i) ? card.replace('class="lp-prodcard"', `class="lp-prodcard${hidden(i)}"`) : card;
    }).join("");
    gridHtml = `${firstCardHtml}${insightHtml}${servicesStrip}${rest}${!filtered.length ? `<p class="lp-shop-empty">${productsAll.length ? "No products match this filter." : "No products listed yet."}</p>` : ""}`;
  } else if (view === "services") {
    const filtered = refine(servicesAll);
    total = filtered.length; listForLd = filtered;
    const cards = filtered.map((s, i) => `<div class="bz-svc-cell${hidden(i)}">${serverServiceCardHtml(s, profile, statsOf(s.id), featuredSet.has(s.id))}</div>`);
    gridHtml = filtered.length ? withAds(cards, 8).join("") : `<p class="lp-shop-empty">${servicesAll.length ? "No services match this filter." : "No services listed yet."}</p>`;
    gridCls = " bz-grid-svc";
  } else if (view === "collections") {
    const filtered = collections.filter((c) => matchQ(c.title) || matchQ(c.description));
    total = filtered.length;
    const cards = filtered.map((c) => serverCollectionCardHtml(c, brandSlug));
    gridHtml = filtered.length ? withAds(cards, 8).join("") : `<p class="lp-shop-empty">No collections yet.</p>`;
    gridCls = " bz-grid-wide";
  } else {
    const filtered = videosAll.filter((v) => matchQ(v.title) || matchQ(v.description));
    total = filtered.length;
    const cards = filtered.map((v) => serverVideoCardHtml(v, brandSlug));
    gridHtml = filtered.length ? withAds(cards, 8).join("") : `<p class="lp-shop-empty">No videos yet.</p>`;
    gridCls = " bz-grid-wide";
  }
  const revealable = view === "products" ? Math.max(0, total - 1) : view === "services" ? total : 0;
  const hasMoreThanInitial = revealable > INITIAL_VISIBLE;

  // ---- rows above the grid (default view only): collections + videos ----------
  const rowsHtml = isPlain ? [
    collections.length && stripCollections
      ? stripSection("Collections", hrefWith(base, { view: "collections" }), collections.slice(0, stripCollections).map((c) => `<div class="bz-strip-item bz-strip-item-col">${serverCollectionCardHtml(c, brandSlug)}</div>`).join(""), "bz-strip-col") : "",
    videosAll.length && stripVideos
      ? stripSection("Videos", hrefWith(base, { view: "videos" }), videosAll.slice(0, stripVideos).map((v) => `<div class="bz-strip-item bz-strip-item-vid">${serverVideoCardHtml(v, brandSlug)}</div>`).join(""), "bz-strip-vid") : ""
  ].join("") : "";

  // ---- tabs --------------------------------------------------------------------
  const counts = { products: productsAll.length, services: servicesAll.length, collections: collections.length, videos: videosAll.length };
  const typeTab = (v, label) => `<a class="bz-tab${view === v ? " is-active" : ""}" href="${hrefWith(base, { view: v === "products" ? "" : v, q: queryRaw })}"${view === v ? ' aria-current="page"' : ""}>${label}<i>${counts[v]}</i></a>`;
  const sortBtn = (key, label) => `<button type="button" class="lp-shop-filter-btn bz-tab ${sortParam === key ? "lp-shop-filter-btn-active is-active" : ""}" data-sort="${key}">${label}</button>`;
  const showSorts = view === "products" || view === "services";
  const tabsHtml = `
    <nav class="bz-tabs" id="bz-tabs" aria-label="Browse and filter ${escapeHtmlAttr(profile.business_name)}">
      ${typeTab("products", "Products")}${typeTab("services", "Services")}${typeTab("collections", "Collections")}${typeTab("videos", "Videos")}
      ${showSorts ? `<span class="bz-tabs-sep" aria-hidden="true"></span>
      <div class="lp-shop-filter-group bz-sortgroup" id="lp-shop-sort-group" role="group" aria-label="Sort">
        ${sortBtn("newest", "Newest")}${sortBtn("rating", "Top Rated")}${sortBtn("views", "Most Viewed")}${sortBtn("likes", "Most Liked")}${sortBtn("price_asc", "Price ↑")}${sortBtn("price_desc", "Price ↓")}
        ${featuredSet.size > 0 ? `<button type="button" class="lp-shop-filter-btn bz-tab lp-shop-filter-btn-featured ${featuredOnly ? "lp-shop-filter-btn-active is-active" : ""}" id="lp-shop-featured-toggle" data-featured-toggle="${featuredOnly ? "0" : "1"}" aria-pressed="${featuredOnly}">⭐ Featured</button>` : ""}
      </div>` : `<div id="lp-shop-sort-group" hidden></div>`}
    </nav>
    ${queryRaw ? `<p class="bz-qchip">Results for “${escapeHtmlAttr(queryRaw)}” <a href="${hrefWith(base, { view: view === "products" ? "" : view })}" aria-label="Clear search">✕ Clear</a></p>` : ""}`;

  const robots = isFiltered || queryRaw ? "noindex, follow" : undefined;
  const ldList = view === "collections"
    ? collections.slice(0, 50).map((c, i) => ({ "@type": "ListItem", position: i + 1, url: `${url.origin}/collection/${encodeURIComponent(brandSlug)}/${encodeURIComponent(c.slug)}` }))
    : view === "videos"
      ? videosAll.slice(0, 50).map((v, i) => ({ "@type": "ListItem", position: i + 1, url: `${url.origin}/video/${encodeURIComponent(brandSlug)}/${encodeURIComponent(v.ref)}` }))
      : listForLd.slice(0, 50).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${url.origin}${productHref(p, brandSlug)}` }));
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: `${profile.business_name} — ${viewLabel}`, url: canonicalUrl },
      { "@type": "ItemList", name: `${profile.business_name} — ${viewLabel}`, itemListElement: ldList },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: url.origin },
        { "@type": "ListItem", position: 2, name: profile.business_name, item: `${url.origin}/b/${brandSlug}` },
        { "@type": "ListItem", position: 3, name: view === "products" ? "Products & Services" : viewLabel }
      ] }
    ]
  };

  const bodyHtml = `
    <header class="lp-shop-topheader lp-shop-topheader-inline">
      <div class="lp-shop-topheader-inner">
        <div class="lp-shop-topheader-brand">
          ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
          <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        </div>
        <nav class="lp-shop-topheader-nav" aria-label="Brand navigation">
          <button type="button" class="lp-shop-theme-toggle" id="lp-shop-theme-toggle-btn" aria-label="Toggle dark mode">
            <svg class="lp-theme-icon-sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            <svg class="lp-theme-icon-moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn lp-shop-nav-btn-primary lp-shop-nav-btn-alive" aria-label="Go to ${escapeHtmlAttr(profile.business_name)}'s brand profile">
            <span>Brand Profile</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
          </a>
        </nav>
      </div>
    </header>

    <div class="lp-shop-page-body">
      <div class="lp-shop-hero">
        <h1 class="lp-shop-hero-title">${view === "products" ? "Products &amp; Services" : viewLabel}</h1>
        ${profile.tagline || view === "products" ? `<p class="lp-shop-hero-subtitle bz-tagline">${escapeHtmlAttr(profile.tagline || `Everything ${profile.business_name} offers, all in one place.`)}</p>` : ""}
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

      <div class="lp-shop-toolbar bz-toolbar" id="bz-toolbar">
        <button type="button" class="bz-searchpill bz-searchpill-lg" id="bz-search-open" data-bz-search-open aria-haspopup="dialog">
          ${IC.search}<span>Search products, services &amp; collections</span>
        </button>
        <input type="hidden" id="lp-shop-search-input" value="${escapeHtmlAttr(queryRaw)}">
      </div>
      ${tabsHtml}
      ${rowsHtml}

      <div class="lp-shop-grid${gridCls}" id="lp-shop-grid" data-all-products="${escapeHtmlAttr(JSON.stringify(view === "products" ? refine(productsAll) : []))}">
        ${gridHtml}
      </div>
      ${total ? `
      <div class="lp-shop-infinite-sentinel" id="lp-shop-infinite-sentinel" data-done="${hasMoreThanInitial ? "false" : "true"}" data-loading="false">
        <div class="lp-shop-infinite-spinner"></div>
        <button type="button" class="lp-shop-infinite-loadmore-btn" id="lp-shop-loadmore-btn">Load More</button>
        <span class="lp-shop-infinite-done-text">You've seen everything here</span>
      </div>` : ""}
      ${staySafeHtml(url, ids.length)}
    </div>

    <button type="button" class="bz-fsearch" id="bz-fsearch" data-bz-fsearch aria-label="Search ${escapeHtmlAttr(profile.business_name)}" hidden>
      <span class="bz-fsearch-icon">${IC.search}</span><span class="bz-fsearch-text">Search this brand</span>
    </button>
    <button type="button" class="bz-ffilter" id="bz-ffilter" aria-label="Filter and sort" aria-haspopup="dialog" hidden>
      ${IC.filter}<span>Filter</span>
    </button>

    <footer class="lp-shop-footer">
      <div class="lp-shop-footer-inner">
        <div class="lp-shop-footer-brand">${escapeHtmlAttr(profile.business_name)}</div>
        <div class="lp-shop-footer-text">© <span id="lp-shop-footer-year"></span> ${escapeHtmlAttr(profile.business_name)}. Powered by ${siteNameFor(url)}.</div>
        <div class="lp-shop-footer-links">
          <a href="/b/${escapeHtmlAttr(brandSlug)}">Brand Profile</a>
          <a href="/products/${escapeHtmlAttr(brandSlug)}">All Products</a>
        </div>
      </div>
    </footer>

    <script>
window.__LIYOG_SHOP_CONTEXT__ = {
        profileId: ${safeJson(profile.id)},
        profile: ${safeJson(profile)},
        brandSlug: ${safeJson(brandSlug)},
        businessName: ${safeJson(profile.business_name)},
        insight: ${safeJson(insight)},
        initialVisible: ${INITIAL_VISIBLE},
        view: ${safeJson(view)}
      };
window.__BZ_BRAND__ = ${safeJson({ profileId: profile.id, brandName: profile.business_name, brandSlug, profile: { id: profile.id, slug: profile.slug, business_name: profile.business_name, business_category: profile.business_category, whatsapp_number: profile.whatsapp_number, phone_number: profile.phone_number } })};
window.__BZ_CAT__ = ${safeJson({ base, view, sort: sortParam, q: queryRaw, featured: featuredOnly, hasFeatured: featuredSet.size > 0, counts, collections: collections.slice(0, 12).map((c) => ({ id: c.id, slug: c.slug, title: c.title, item_count: c.item_count, cover_url: c.cover_url || null, cover_color: safeColor(c.cover_color) || null, cw: c.cw || null, ch: c.ch || null, blurb: firstSentence(c.description, 90) })), videos: videosAll.slice(0, 12).map((v) => ({ ref: v.ref, vid: v.vid, title: v.title, tag: v.tag, price_display: v.price_display || null })), stripCollections })};
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage, robots,
    ogType: "website", jsonLd, bodyHtml, origin: url.origin,
    showFloatingInquiry: true
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

// =====================================================================
// [R1] PRODUCT PAGE helpers
// =====================================================================
const IC = {
  play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  search: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  shield: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
  wa: `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0012.04 2z"/></svg>`,
  call: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  filter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
  ask: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
};

function videoFacadeHtml(id, name) {
  return `<div class="bz-video" data-yt="${escapeHtmlAttr(id)}"><button type="button" class="bz-video-play" aria-label="Play video: ${escapeHtmlAttr(name)}"><img class="bz-video-poster" src="https://i.ytimg.com/vi/${escapeHtmlAttr(id)}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="bz-video-btn"><svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></button></div>`;
}

function renderRelatedCard(r, brandSlug) {
  const rHref = `/product/${encodeURIComponent(r.slug || r.id)}/${escapeHtmlAttr(brandSlug)}`;
  const x = imgWrapExtras(r);
  return `<a class="lp-related-card" href="${rHref}">
      <div class="lp-related-card-imgwrap${x.cls}"${x.style}>
        ${r.image_url ? `<img src="${escapeHtmlAttr(r.image_url)}" alt="${escapeHtmlAttr(r.name)}" loading="lazy">` : ""}${x.badge}
      </div>
      <div class="lp-related-card-body">
        <div class="lp-related-card-name">${escapeHtmlAttr(r.name)}</div>
        ${r.price_display ? `<div class="lp-related-card-price">${escapeHtmlAttr(r.price_display)}</div>` : ""}
      </div>
    </a>`;
}

// ---------------------------------------------------------------------
// Route 2: GET /product/{product-slug}/{brand-slug} — original page + [R1] upgrades.
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

  const { results: boostRows } = await env.DB.prepare(
    `SELECT 1 FROM boost_log WHERE scope = 'product' AND product_id = ? AND expires_at > datetime('now') LIMIT 1`
  ).bind(product.id).all();
  const isFeatured = boostRows.length > 0;

  // The canonical view-count moment (unchanged): opening a product's own page counts one view.
  ctx.waitUntil(productsEngagement.recordView(env, product.id));

  const stats = await productsEngagement.getProductStats(env, product.id);
  const insight = await productsEngagement.getProductInsight(env, product.id);

  const { results: candidateRows } = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.price_display, p.image_url, p.view_count,
            COALESCE(ps.average_rating, 0) as average_rating
     FROM products p LEFT JOIN product_stats ps ON ps.product_id = p.id
     WHERE p.profile_id = ? AND p.is_active = 1 AND p.is_draft = 0 AND p.id != ?`
  ).bind(profile.id, product.id).all();
  const related = [...candidateRows]
    .sort((a, b) => ((b.view_count || 0) + (b.average_rating || 0) * 20) - ((a.view_count || 0) + (a.average_rating || 0) * 20))
    .slice(0, 5);

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

  // [R1] photos + collection (each optional; the page still renders without them)
  const images = await safe(getProductImages(env, product.id), []);
  const gallery = images.length ? images : (product.image_url ? [{ url: product.image_url, width: product.img_w, height: product.img_h }] : []);
  const collection = await safe(getCollectionForProduct(env, product.id, profile.id, (url.searchParams.get("c") || "").slice(0, 60)), null);
  const collectionItems = collection ? await safe(getCollectionItems(env, collection.id, { limit: 10, excludeProductId: product.id }), { rows: [] }) : { rows: [] };
  const isService = product.kind === "service";
  const videoId = hasVideo(product) ? product.video_id : null;

  const canonicalUrl = `${url.origin}/product/${encodeURIComponent(product.slug || product.id)}/${brandSlug}`;
  const title = `${product.name} — ${profile.business_name} | ${siteNameFor(url)}`;
  const metaDescription = buildMetaDescription(product.description, product.price_display);
  const ogImage = (gallery[0] && gallery[0].url) || product.image_url || profile.cover_url || `${url.origin}/default-og-image.png`;

  // [R1] a real price + currency when we have one; the original guess otherwise
  let offers;
  if (product.price_minor != null && product.price_minor > 0 && product.currency) {
    offers = { "@type": "Offer", "price": minorToMajorString(product.price_minor, product.currency), "priceCurrency": product.currency, "availability": "https://schema.org/InStock", "url": canonicalUrl };
  } else if (product.price_display) {
    offers = { "@type": "Offer", "price": (product.price_display.match(/[\d.]+/) || [""])[0].replace(/,/g, ""), "priceCurrency": "NGN", "availability": "https://schema.org/InStock", "url": canonicalUrl };
  }
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "name": product.name,
        "description": product.description || undefined,
        "image": gallery.length ? gallery.map((g) => g.url).slice(0, 8) : (product.image_url || undefined),
        "offers": offers,
        "aggregateRating": stats.rating_count ? { "@type": "AggregateRating", "ratingValue": stats.average_rating, "reviewCount": stats.rating_count } : undefined
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": url.origin },
          { "@type": "ListItem", "position": 2, "name": profile.business_name, "item": `${url.origin}/b/${brandSlug}` },
          { "@type": "ListItem", "position": 3, "name": "Products & Services", "item": `${url.origin}/products/${brandSlug}` },
          { "@type": "ListItem", "position": 4, "name": product.name }
        ]
      }
    ]
  };

  const relatedHtml = related.map((r) => renderRelatedCard(r, brandSlug)).join("");
  const collectionHtml = collectionItems.rows.map((r) => renderRelatedCard(r, brandSlug)).join("");

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

  const hasOwnerSessionHint = hasSessionCookie(request);

  // [R1] HERO. One photo and no video -> exactly your original hero (with its zoom lightbox).
  // Several photos and/or a video -> a swipe gallery in the same edge-to-edge spot.
  let heroHtml;
  if (gallery.length <= 1 && !videoId) {
    const g = gallery[0];
    const blur = g && needsBlur({ ...product, image_url: g.url });
    heroHtml = `
      <div class="lp-product-hero-wrap${blur ? " lp-fit-blur" : ""}" id="lp-product-hero-wrap"${blur ? ` style="${escapeHtmlAttr(bgStyle(g.url))}"` : ""}>
        ${g
          ? `<img src="${escapeHtmlAttr(g.url)}" alt="${escapeHtmlAttr(product.name)}" class="lp-product-hero-img" id="lp-product-hero-img">`
          : `<div class="lp-product-hero-placeholder"></div>`}
      </div>`;
  } else {
    const total = gallery.length + (videoId ? 1 : 0);
    const slides = gallery.map((g, i) => `
        <figure class="bz-gal-slide lp-fit-blur" style="${escapeHtmlAttr(bgStyle(g.url))}" data-i="${i}">
          <img src="${escapeHtmlAttr(g.url)}" alt="${escapeHtmlAttr(product.name)}${gallery.length > 1 ? ` — photo ${i + 1}` : ""}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
        </figure>`).join("") + (videoId ? `
        <figure class="bz-gal-slide bz-gal-video" data-i="${gallery.length}">${videoFacadeHtml(videoId, product.name)}</figure>` : "");
    const dots = total > 1 ? `<div class="bz-gal-dots" role="tablist" aria-label="Choose photo">${Array.from({ length: total }, (_, i) => `<button type="button" class="bz-gal-dot${i === 0 ? " is-active" : ""}${videoId && i === total - 1 ? " bz-gal-dot-video" : ""}" data-i="${i}" aria-label="${videoId && i === total - 1 ? "Video" : `Photo ${i + 1}`}"></button>`).join("")}</div>` : "";
    heroHtml = `
      <div class="lp-product-hero-wrap bz-gal" id="lp-product-hero-wrap" data-count="${total}">
        <div class="bz-gal-track" id="bz-gal-track" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Photos${videoId ? " and video" : ""} of ${escapeHtmlAttr(product.name)}">${slides}</div>
        ${total > 1 ? `<span class="bz-gal-count" id="bz-gal-count" aria-live="polite">1 / ${total}</span>
        <button type="button" class="bz-gal-arrow bz-gal-prev" aria-label="Previous"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button type="button" class="bz-gal-arrow bz-gal-next" aria-label="Next"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg></button>` : ""}
        ${videoId ? `<button type="button" class="bz-vid-chip" id="bz-vid-chip" aria-label="Jump to the video">${IC.play}<span>Video</span></button>` : ""}
        ${dots}
      </div>`;
  }

  const location = [profile.store_city, profile.store_country].filter(Boolean).join(", ");
  const priceAttrs = product.price_minor != null && product.currency
    ? ` data-fx-minor="${Number(product.price_minor)}" data-fx-cur="${escapeHtmlAttr(product.currency)}"${product.price_type === "from" ? ' data-fx-from="1"' : ""}` : "";

  const waReady = !!profile.whatsapp_number, callReady = !!profile.phone_number;
  const ctaBarHtml = `
    <div class="bz-ctabar" id="bz-ctabar" role="region" aria-label="Contact ${escapeHtmlAttr(profile.business_name)}">
      ${waReady ? `<button type="button" class="bz-cta bz-cta-wa" data-action="whatsapp" data-product-name="${escapeHtmlAttr(product.name)}">${IC.wa}<span>WhatsApp</span></button>` : ""}
      ${callReady ? `<button type="button" class="bz-cta bz-cta-call" data-action="call">${IC.call}<span>Call</span></button>` : ""}
      <button type="button" class="bz-cta bz-cta-ask" id="bz-ask-btn">${IC.ask}<span>Ask</span></button>
    </div>`;

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
          <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn lp-shop-nav-btn-primary lp-shop-nav-btn-alive">
            <span>Brand Profile</span>
          </a>
        </nav>
      </div>
    </header>

    <div class="lp-product-page-body">
      <nav class="bz-crumbs" aria-label="Breadcrumb">
        <a class="bz-crumb" href="/">Home</a><i aria-hidden="true">›</i>
        <a class="bz-crumb" href="/b/${escapeHtmlAttr(brandSlug)}">${escapeHtmlAttr(profile.business_name)}</a><i aria-hidden="true">›</i>
        <a class="bz-crumb" href="/products/${escapeHtmlAttr(brandSlug)}">Products &amp; Services</a><i aria-hidden="true">›</i>
        <span class="bz-crumb bz-crumb-now" aria-current="page">${escapeHtmlAttr(product.name)}</span>
      </nav>

      <button type="button" class="bz-searchpill" id="bz-search-open" data-bz-search-open aria-haspopup="dialog">
        ${IC.search}<span>Search ${escapeHtmlAttr(profile.business_name)}</span>
      </button>

      ${heroHtml}

      <div class="bz-tags">
        <span class="bz-tag">${isService ? "Service" : "Product"}</span>
        ${videoId ? `<span class="bz-tag bz-tag-video">${IC.play}Video</span>` : ""}
        ${location ? `<span class="bz-tag bz-tag-soft">${IC.pin}${escapeHtmlAttr(location)}</span>` : ""}
      </div>

      <h1 class="lp-product-page-name">
        ${escapeHtmlAttr(product.name)}
        ${isFeatured ? `<span class="lp-product-page-featured-badge" title="Featured"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.26L21 9.27l-4.5 4.38L17.8 20 12 16.9 6.2 20l1.3-6.35L3 9.27l6.1-1.01z"/></svg>Featured</span>` : ""}
      </h1>
      ${product.price_display ? `<div class="lp-product-page-price"${priceAttrs}>${escapeHtmlAttr(product.price_display)}</div>` : ""}

      <div class="lp-product-page-engbar" id="lp-detail-engbar">${serverEngagementBarHtml(product, stats, false)}</div>

      ${product.description ? `<p class="lp-product-page-desc">${escapeHtmlAttr(product.description)}</p>` : ""}

      <div class="lp-detail-contact" id="lp-detail-contact">${serverContactButtonsHtml(profile, product, false)}</div>

      <a class="bz-seller" href="/b/${escapeHtmlAttr(brandSlug)}">
        ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" width="44" height="44" loading="lazy">` : `<span class="bz-seller-logo"></span>`}
        <span class="bz-seller-text"><strong>${escapeHtmlAttr(profile.business_name)}</strong><small>${location ? `${IC.pin} ${escapeHtmlAttr(location)}` : "View the full brand profile"}${profile.response_time ? ` · ${escapeHtmlAttr(profile.response_time)}` : ""}</small></span>
        <span class="bz-seller-go">View Profile<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M9 18l6-6-6-6"/></svg></span>
      </a>

      <div class="bz-safe" role="note">${IC.shield}<p><strong>Stay safe.</strong> ${siteNameFor(url)} doesn't control chats or payments that happen outside the platform. Meet in safe places and never pay for something you haven't confirmed.</p></div>

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

      ${collectionHtml ? `
      <div class="lp-related-products bz-collection-row">
        <div class="bz-row-head"><h2 class="lp-related-products-title">More from ${escapeHtmlAttr(collection.title)}</h2><a class="bz-linkbtn" href="/collection/${encodeURIComponent(brandSlug)}/${encodeURIComponent(collection.slug)}">View collection ›</a></div>
        <div class="lp-related-products-row">
          <div class="lp-related-products-scroll bz-row-scroll">${collectionHtml}</div>
        </div>
      </div>` : ""}

      ${related.length ? `
      <div class="lp-related-products">
        <h2 class="lp-related-products-title">Also from this Brand</h2>
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

    <button type="button" class="bz-fsearch" id="bz-fsearch" data-bz-fsearch aria-label="Search ${escapeHtmlAttr(profile.business_name)}" hidden>
      <span class="bz-fsearch-icon">${IC.search}</span><span class="bz-fsearch-text">Search this brand</span>
    </button>

    <div class="lp-product-hero-lightbox" id="lp-product-hero-lightbox">
      <button type="button" class="lp-product-hero-lightbox-close" id="lp-product-hero-lightbox-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <img id="bz-lb-img" src="${gallery[0] ? escapeHtmlAttr(gallery[0].url) : ""}" alt="${escapeHtmlAttr(product.name)}">
    </div>

    <footer class="lp-shop-footer">
      <div class="lp-shop-footer-inner">
        <div class="lp-shop-footer-brand">${escapeHtmlAttr(profile.business_name)}</div>
        <div class="lp-shop-footer-text">© <span id="lp-shop-footer-year"></span> ${escapeHtmlAttr(profile.business_name)}. Powered by ${siteNameFor(url)}.</div>
        <div class="lp-shop-footer-links">
          <a href="/b/${escapeHtmlAttr(brandSlug)}">Brand Profile</a>
          <a href="/products/${escapeHtmlAttr(brandSlug)}">All Products</a>
        </div>
      </div>
    </footer>

    <script>
      window.__LIYOG_PRODUCT_PAGE_CONTEXT__ = {
        profile: ${safeJson(profile)},
        product: ${safeJson(product)},
        stats: ${safeJson(stats)},
        insight: ${safeJson(insight)},
        brandSlug: ${safeJson(brandSlug)},
        hasOwnerSessionHint: ${safeJson(hasOwnerSessionHint)}
      };
      window.__BZ_PRODUCT__ = ${safeJson({ productId: product.id, profileId: profile.id, brandName: profile.business_name, brandSlug, hasVideo: !!videoId })};
      window.__BZ_BRAND__ = ${safeJson({ profileId: profile.id, brandName: profile.business_name, brandSlug, profile: { id: profile.id, slug: profile.slug, business_name: profile.business_name, business_category: profile.business_category, whatsapp_number: profile.whatsapp_number, phone_number: profile.phone_number } })};
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "product", jsonLd, bodyHtml, origin: url.origin,
    showFloatingInquiry: false, ctaBarHtml
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

// =====================================================================
// [R3] COLLECTION PAGE  /collection/{brand}/{collection}   (a playlist-style page, reusable everywhere)
// =====================================================================
function itemRowHtml(r, brandSlug, colSlug, n) {
  const x = imgWrapExtras(r);
  return `<a class="bz-item" href="${productHref(r, brandSlug, colSlug)}">
    <span class="bz-item-n" aria-hidden="true">${n}</span>
    <span class="bz-item-thumb${x.cls}"${x.style}>${r.image_url ? `<img src="${escapeHtmlAttr(r.image_url)}" alt="" loading="lazy" decoding="async">` : ""}${x.badge}</span>
    <span class="bz-item-t"><strong>${escapeHtmlAttr(r.name)}</strong>${r.price_display ? `<span class="bz-item-price"${fxAttrs(r)}>${escapeHtmlAttr(r.price_display)}</span>` : ""}<small>${r.kind === "service" ? "Service" : "Product"}</small></span>
    <span class="bz-ss-go" aria-hidden="true">›</span></a>`;
}

function crumbsFor(url, brandSlug, brandName, lastLabel, midLabel, midHref) {
  return `<nav class="bz-crumbs" aria-label="Breadcrumb">
    <a class="bz-crumb" href="/">Home</a><i aria-hidden="true">›</i>
    <a class="bz-crumb" href="/b/${escapeHtmlAttr(brandSlug)}">${escapeHtmlAttr(brandName)}</a><i aria-hidden="true">›</i>
    ${midLabel ? `<a class="bz-crumb" href="${midHref}">${escapeHtmlAttr(midLabel)}</a><i aria-hidden="true">›</i>` : ""}
    <span class="bz-crumb bz-crumb-now" aria-current="page">${escapeHtmlAttr(lastLabel)}</span></nav>`;
}

function brandRowHtml(profile) {
  return `<a class="bz-seller" href="/b/${escapeHtmlAttr(profile.slug)}">
    ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" width="44" height="44" loading="lazy">` : `<span class="bz-seller-logo"></span>`}
    <span class="bz-seller-text"><strong>${escapeHtmlAttr(profile.business_name)}</strong><small>${escapeHtmlAttr([profile.store_city, profile.store_country].filter(Boolean).join(", ") || "View the full brand profile")}</small></span>
    <span class="bz-seller-go">View Profile<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M9 18l6-6-6-6"/></svg></span></a>`;
}

function topHeaderHtml(profile, brandSlug, backHref, backLabel) {
  return `<header class="lp-shop-topheader lp-shop-topheader-inline">
      <div class="lp-shop-topheader-inner">
        <div class="lp-shop-topheader-brand">
          ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
          <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        </div>
        <nav class="lp-shop-topheader-nav" aria-label="Brand navigation">
          <button type="button" class="lp-shop-theme-toggle" id="lp-shop-theme-toggle-btn" aria-label="Toggle dark mode">
            <svg class="lp-theme-icon-sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            <svg class="lp-theme-icon-moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <a href="${backHref}" class="lp-shop-nav-btn" aria-label="${escapeHtmlAttr(backLabel)}"><span>${escapeHtmlAttr(backLabel)}</span></a>
          <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-nav-btn lp-shop-nav-btn-primary lp-shop-nav-btn-alive" aria-label="Go to ${escapeHtmlAttr(profile.business_name)}'s brand profile"><span>Brand Profile</span></a>
        </nav>
      </div>
    </header>`;
}

function footerHtml(profile, brandSlug, url) {
  return `<footer class="lp-shop-footer"><div class="lp-shop-footer-inner">
    <div class="lp-shop-footer-brand">${escapeHtmlAttr(profile.business_name)}</div>
    <div class="lp-shop-footer-text">© <span id="lp-shop-footer-year"></span> ${escapeHtmlAttr(profile.business_name)}. Powered by ${siteNameFor(url)}.</div>
    <div class="lp-shop-footer-links"><a href="/b/${escapeHtmlAttr(brandSlug)}">Brand Profile</a><a href="/products/${escapeHtmlAttr(brandSlug)}">All Products</a></div></div></footer>`;
}

function brandContextScript(profile, brandSlug, extra) {
  return `<script>window.__BZ_BRAND__ = ${safeJson({ profileId: profile.id, brandName: profile.business_name, brandSlug, profile: { id: profile.id, slug: profile.slug, business_name: profile.business_name, business_category: profile.business_category, whatsapp_number: profile.whatsapp_number, phone_number: profile.phone_number } })};${extra || ""}</script>`;
}

const SHARE_BTNS = `<div class="lp-shop-hero-actions bz-pl-actions">
  <button type="button" class="lp-product-page-share-btn" data-bz-share><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg><span>Share</span></button>
  <button type="button" class="lp-product-page-copy-btn" data-bz-copy><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy Link</span></button></div>`;

async function handleCollectionPage(request, env, ctx, url) {
  const parts = url.pathname.split("/");
  const brandSlug = decodeURIComponent(parts[2] || ""), colSlug = decodeURIComponent(parts[3] || "");
  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  let col;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, slug, title, description, reach, item_count, cover_url, cover_color, created_at, updated_at FROM collections WHERE profile_id = ? AND slug = ? AND status = 'live'`
    ).bind(profile.id, colSlug).all();
    col = results[0];
  } catch (e) { col = null; }
  if (!col) return new Response("Not found", { status: 404 });

  const first = await safe(getCollectionItems(env, col.id, { limit: 24, offset: 0 }), { rows: [], hasMore: false });
  const rows = first.rows || [];
  const lead = rows[0] || {};
  const cover = { cover_url: col.cover_url || lead.image_url || null, cover_color: col.cover_color || lead.img_color || null, cw: lead.img_w, ch: lead.img_h };
  const canonicalUrl = `${url.origin}/collection/${encodeURIComponent(brandSlug)}/${encodeURIComponent(col.slug)}`;
  const title = `${col.title} — ${profile.business_name} | ${siteNameFor(url)}`;
  const metaDescription = buildMetaDescription(col.description || `${col.item_count} item${col.item_count === 1 ? "" : "s"} curated by ${profile.business_name}.`, null, 160);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: col.title, description: col.description || undefined, url: canonicalUrl, image: cover.cover_url || undefined, author: { "@type": "Organization", name: profile.business_name, url: `${url.origin}/b/${brandSlug}` } },
      { "@type": "ItemList", numberOfItems: col.item_count, itemListElement: rows.map((r, i) => ({ "@type": "ListItem", position: i + 1, url: `${url.origin}${productHref(r, brandSlug)}` })) },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: url.origin },
        { "@type": "ListItem", position: 2, name: profile.business_name, item: `${url.origin}/b/${brandSlug}` },
        { "@type": "ListItem", position: 3, name: "Collections", item: `${url.origin}/products/${brandSlug}?view=collections` },
        { "@type": "ListItem", position: 4, name: col.title }
      ] }
    ]
  };
  const isPublic = col.reach === "public";
  const bodyHtml = `
    ${topHeaderHtml(profile, brandSlug, `/products/${encodeURIComponent(brandSlug)}?view=collections`, "All collections")}
    <div class="lp-shop-page-body bz-pl-wrap">
      ${crumbsFor(url, brandSlug, profile.business_name, col.title, "Collections", `/products/${encodeURIComponent(brandSlug)}?view=collections`)}
      <button type="button" class="bz-searchpill" data-bz-search-open aria-haspopup="dialog">${IC.search}<span>Search ${escapeHtmlAttr(profile.business_name)}</span></button>
      <div class="bz-pl">
        <aside class="bz-pl-side">
          ${collectionCoverHtml(cover, "bz-pl-cover")}
          <h1 class="bz-pl-title">${escapeHtmlAttr(col.title)}</h1>
          <p class="bz-pl-meta">${STACK_ICON} ${Number(col.item_count) || rows.length} item${col.item_count === 1 ? "" : "s"} · <span class="bz-pl-reach">${isPublic ? "Public collection" : `Only on ${escapeHtmlAttr(profile.business_name)}`}</span></p>
          ${brandRowHtml(profile)}
          ${col.description ? `<p class="bz-pl-desc">${escapeHtmlAttr(col.description)}</p>` : ""}
          ${SHARE_BTNS}
        </aside>
        <section class="bz-pl-list" aria-label="Items in ${escapeHtmlAttr(col.title)}">
          <div id="bz-pl-items">${rows.map((r, i) => itemRowHtml(r, brandSlug, col.slug, i + 1)).join("") || `<p class="lp-shop-empty">This collection is empty right now.</p>`}</div>
          ${first.hasMore ? `<div class="bz-ss-pager"><button type="button" id="bz-pl-more" data-collection="${escapeHtmlAttr(col.id)}" data-next="24" data-brand="${escapeHtmlAttr(brandSlug)}" data-col="${escapeHtmlAttr(col.slug)}">Load more</button></div>` : ""}
        </section>
      </div>
      ${staySafeHtml(url, 7)}
      ${adSlotHtml(1, profile)}${adSlotHtml(2, profile)}
    </div>
    ${footerHtml(profile, brandSlug, url)}
    <button type="button" class="bz-fsearch" data-bz-fsearch aria-label="Search ${escapeHtmlAttr(profile.business_name)}" hidden><span class="bz-fsearch-icon">${IC.search}</span><span class="bz-fsearch-text">Search this brand</span></button>
    ${brandContextScript(profile, brandSlug)}`;
  return new Response(pageShell({ title, metaDescription, canonicalUrl, ogImage: cover.cover_url || profile.cover_url || profile.logo_url || `${url.origin}/default-og-image.png`, ogType: "website", jsonLd, bodyHtml, origin: url.origin, showFloatingInquiry: true }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

// =====================================================================
// [R3] VIDEO PAGE  /video/{brand}/{product-or-"brand"}   (watch page + discovery, reusable everywhere)
// =====================================================================
async function handleVideoPage(request, env, ctx, url) {
  const parts = url.pathname.split("/");
  const brandSlug = decodeURIComponent(parts[2] || ""), ref = decodeURIComponent(parts[3] || "");
  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  let products = [];
  try {
    ({ results: products } = await env.DB.prepare(
      `SELECT id, name, description, price_display, price_minor, currency, price_type, image_url, slug, created_at, kind, img_w, img_h, video_id, video_status
       FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 AND video_id IS NOT NULL ORDER BY created_at DESC LIMIT 200`
    ).bind(profile.id).all());
  } catch (e) { products = []; }
  const videos = collectVideos(products, profile);
  const current = videos.find((v) => v.ref === ref || v.productId === ref);
  if (!current) return new Response("Not found", { status: 404 });
  const owner = current.productId ? products.find((p) => p.id === current.productId) : null;
  const related = videos.filter((v) => v.ref !== current.ref).slice(0, 8);

  const canonicalUrl = `${url.origin}/video/${encodeURIComponent(brandSlug)}/${encodeURIComponent(current.ref)}`;
  const title = `${current.title} (video) — ${profile.business_name} | ${siteNameFor(url)}`;
  const desc = (owner && owner.description) || profile.tagline || `Watch ${current.title} from ${profile.business_name}.`;
  const metaDescription = buildMetaDescription(desc, current.price_display, 160);
  const thumb = `https://i.ytimg.com/vi/${current.vid}/hqdefault.jpg`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "VideoObject", name: current.title, description: desc, thumbnailUrl: thumb, embedUrl: `https://www.youtube.com/embed/${current.vid}`, uploadDate: owner ? new Date(String(owner.created_at).replace(" ", "T") + "Z").toISOString() : undefined, publisher: { "@type": "Organization", name: profile.business_name } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: url.origin },
        { "@type": "ListItem", position: 2, name: profile.business_name, item: `${url.origin}/b/${brandSlug}` },
        { "@type": "ListItem", position: 3, name: "Videos", item: `${url.origin}/products/${brandSlug}?view=videos` },
        { "@type": "ListItem", position: 4, name: current.title }
      ] }
    ]
  };
  const bodyHtml = `
    ${topHeaderHtml(profile, brandSlug, `/products/${encodeURIComponent(brandSlug)}?view=videos`, "All videos")}
    <div class="lp-shop-page-body bz-vp-wrap">
      ${crumbsFor(url, brandSlug, profile.business_name, current.title, "Videos", `/products/${encodeURIComponent(brandSlug)}?view=videos`)}
      <div class="bz-vp">
        <div class="bz-vp-main">
          <div class="bz-vp-player">${videoFacadeHtml(current.vid, current.title)}</div>
          <h1 class="bz-pl-title">${escapeHtmlAttr(current.title)}</h1>
          <p class="bz-pl-meta"><span class="bz-tag">${escapeHtmlAttr(current.tag)}</span>${current.price_display ? ` <span class="bz-item-price"${fxAttrs(current)}>${escapeHtmlAttr(current.price_display)}</span>` : ""}</p>
          ${brandRowHtml(profile)}
          ${owner && owner.description ? `<p class="bz-pl-desc">${escapeHtmlAttr(owner.description)}</p>` : ""}
          ${owner ? `<a class="bz-btn-link" href="${productHref(owner, brandSlug)}">View this ${owner.kind === "service" ? "service" : "product"} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M9 18l6-6-6-6"/></svg></a>` : `<a class="bz-btn-link" href="/b/${encodeURIComponent(brandSlug)}">Visit ${escapeHtmlAttr(profile.business_name)} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M9 18l6-6-6-6"/></svg></a>`}
          ${SHARE_BTNS}
          ${staySafeHtml(url, 3)}
        </div>
        <aside class="bz-vp-rail" aria-label="More videos">
          ${related.length ? `<h2 class="bz-rail-title">More videos from ${escapeHtmlAttr(profile.business_name)}</h2><div class="bz-vp-related">${related.map((v) => serverVideoCardHtml(v, brandSlug)).join("")}</div>` : ""}
        </aside>
      </div>
      ${adSlotHtml(0, profile)}${adSlotHtml(2, profile)}${adSlotHtml(5, profile)}
    </div>
    ${footerHtml(profile, brandSlug, url)}
    <button type="button" class="bz-fsearch" data-bz-fsearch aria-label="Search ${escapeHtmlAttr(profile.business_name)}" hidden><span class="bz-fsearch-icon">${IC.search}</span><span class="bz-fsearch-text">Search this brand</span></button>
    ${brandContextScript(profile, brandSlug)}`;
  return new Response(pageShell({ title, metaDescription, canonicalUrl, ogImage: thumb, ogType: "video.other", jsonLd, bodyHtml, origin: url.origin, showFloatingInquiry: true }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export { handleProductsListingPage, handleProductDetailPage, handleCollectionPage, handleVideoPage };
