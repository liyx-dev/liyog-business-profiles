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
    "SELECT id, slug, business_name, tagline, bio_html, logo_url, cover_url, business_category, is_active, moderation_status, referral_code, whatsapp_number, phone_number, store_city, store_country, response_time FROM profiles WHERE slug = ?"
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
        ${prod.price_display ? `<div class="lp-prodfeed-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
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
        ${prod.price_display ? `<div class="lp-prodcard-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        ${prod.description ? `<div class="lp-prodcard-desc">${escapeHtmlAttr(truncateLinesSSR(prod.description, 2))}</div>` : ""}
        ${serverEngagementBarHtml(prod, stats, false)}
        ${serverContactButtonsHtml(profile, prod, false)}
      </div>
    </div>`;
}

// Shared page chrome (original) + [R1] shop.css / shop-ui.js and the optional bottom contact bar.
function pageShell({ title, metaDescription, canonicalUrl, ogImage, ogType, jsonLd, bodyHtml, origin, showFloatingInquiry, inquiryContextJs, ctaBarHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
${siteHeadHtml(origin)}
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
// Route 1: GET /products/{brand-slug} — ORIGINAL catalogue (see header note for the only additions).
// ---------------------------------------------------------------------
async function handleProductsListingPage(request, env, ctx, url) {
  const brandSlug = url.pathname.split("/")[2];
  const profile = await getApprovedProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  // [R1] try the richer column list first; if a database upgrade step is missing, fall back to the original query.
  let products;
  try {
    ({ results: products } = await env.DB.prepare(
      `SELECT id, name, description, price_display, image_url, slug, view_count, share_count, created_at, kind, img_w, img_h, img_color, video_id, video_status
       FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0
       ORDER BY created_at DESC`
    ).bind(profile.id).all());
  } catch (e) {
    ({ results: products } = await env.DB.prepare(
      `SELECT id, name, description, price_display, image_url, slug, view_count, share_count, created_at
       FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0
       ORDER BY created_at DESC`
    ).bind(profile.id).all());
  }

  const statsByProduct = {};
  for (const prod of products) {
    statsByProduct[prod.id] = await productsEngagement.getProductStats(env, prod.id);
  }

  const productIds = products.map((p) => p.id);
  const featuredSet = new Set();
  if (productIds.length) {
    const placeholders = productIds.map(() => "?").join(",");
    const { results: boostRows } = await env.DB.prepare(
      `SELECT DISTINCT product_id FROM boost_log
       WHERE scope = 'product' AND product_id IN (${placeholders}) AND expires_at > datetime('now')`
    ).bind(...productIds).all();
    boostRows.forEach((r) => featuredSet.add(r.product_id));
  }

  const sortParam = url.searchParams.get("sort") || "newest";
  const queryParam = (url.searchParams.get("q") || "").toLowerCase();
  const featuredOnly = url.searchParams.get("featured") === "1";

  let filtered = products;
  if (queryParam) {
    filtered = filtered.filter((p) =>
      (p.name || "").toLowerCase().includes(queryParam) ||
      (p.description || "").toLowerCase().includes(queryParam)
    );
  }
  if (featuredOnly) {
    filtered = filtered.filter((p) => featuredSet.has(p.id));
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
  const title = `Products & Services — ${profile.business_name} | ${siteNameFor(url)}`;
  const metaDescription = buildMetaDescription(
    profile.tagline || `Browse everything ${profile.business_name} offers — quality products and services.`,
    null,
    160
  );
  const ogImage = profile.cover_url || profile.logo_url || `${url.origin}/default-og-image.png`;

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

  const INITIAL_VISIBLE = 10;
  const [firstProd, ...restProds] = filtered;
  const firstCardHtml = firstProd ? serverFeedCardHtml(firstProd, profile, statsByProduct[firstProd.id] || {}, featuredSet.has(firstProd.id)) : "";
  const insightHtml = insight && insight.summary_text ? serverCatalogueInsightCardHtml(insight) : "";
  const restCardsHtml = restProds.map((prod, i) => {
    const hiddenCls = i >= INITIAL_VISIBLE ? " lp-shop-card-hidden" : "";
    const stats = statsByProduct[prod.id] || {};
    const card = serverCompactCardHtml(prod, profile, stats, featuredSet.has(prod.id));
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
          ${featuredSet.size > 0 ? `<button type="button" class="lp-shop-filter-btn lp-shop-filter-btn-featured ${featuredOnly ? "lp-shop-filter-btn-active" : ""}" id="lp-shop-featured-toggle" data-featured-toggle="${featuredOnly ? "0" : "1"}" aria-pressed="${featuredOnly}">⭐ Featured</button>` : ""}
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
        products: ${safeJson(filtered)},
        statsByProduct: ${safeJson(statsByProduct)},
        insight: ${safeJson(insight)},
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

      <button type="button" class="bz-searchpill" id="bz-search-open" aria-haspopup="dialog">
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
        <h2 class="lp-related-products-title">More from ${escapeHtmlAttr(collection.title)}</h2>
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

    <button type="button" class="bz-fsearch" id="bz-fsearch" aria-label="Search ${escapeHtmlAttr(profile.business_name)}" hidden>
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
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "product", jsonLd, bodyHtml, origin: url.origin,
    showFloatingInquiry: false, ctaBarHtml
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export { handleProductsListingPage, handleProductDetailPage };
