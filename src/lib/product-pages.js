// =====================================================================
// BIZIPLEX — src/lib/product-pages.js  (v3, premium rebuild)
//   /products/{brand}            catalogue: sticky search + collection chips + fast grid
//   /product/{product}/{brand}   product page: gallery + video + buy box + collection loop
// Both are real server-rendered documents (title, canonical, Open Graph, JSON-LD,
// breadcrumbs) so Google and link previews read them with zero JavaScript.
// Cards come from shop-render.js, data from shop-data.js: one query per page
// section, never one query per product.
// =====================================================================
import * as productsEngagement from "./products-engagement.js";
import { siteHeadHtml, siteCssLinkHtml, siteHeaderHtml, siteFooterHtml, siteBottomNavHtml } from "./layout.js";
import * as data from "./shop-data.js";
import {
  esc, toCard, cardsHtml, cardHtml, chipsHtml, mediaHtml, priceHtml, priceInner, youtubeFacadeHtml,
  safetyNoteHtml, engagementBarHtml, catalogueInsightHtml, waLink, productUrl, fitMode
} from "./shop-render.js";
import { minorToMajorString } from "./money.js";

const PAGE_SIZE = 24;
const ICON = {
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  flag: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 21V4a1 1 0 0 1 1-1h11.5a.5.5 0 0 1 .4.8L14 8l2.9 4.2a.5.5 0 0 1-.4.8H5v8"/></svg>',
  wa: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0012.04 2z"/></svg>',
  call: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  prev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>'
};

function siteNameFor(url) { return /^(www\.)?biziplex\.com$/.test(url.hostname) ? "BiziPlex" : "Liyog World"; }
function safeJson(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return "null";
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function hasSessionCookie(request) { return /(?:^|;\s*)liyog_session=/.test(request.headers.get("Cookie") || ""); }
function isBot(request) { return /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|embedly|headless/i.test(request.headers.get("User-Agent") || ""); }
function metaDesc(text, max = 160) { const t = String(text || "").replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; }

function brandBarHtml(profile, { active }) {
  return `<div class="bz-brandbar">
  <a class="bz-brandbar-id" href="/b/${esc(profile.slug)}">
    ${profile.logo_url ? `<img src="${esc(profile.logo_url)}" alt="" width="36" height="36" class="bz-brandbar-logo">` : '<span class="bz-brandbar-logo bz-brandbar-logo-empty"></span>'}
    <span class="bz-brandbar-name">${esc(profile.business_name)}</span>
  </a>
  <nav class="bz-brandbar-nav" aria-label="Store">
    ${active === "product" ? `<button type="button" class="bz-iconbtn" id="bz-brand-search-btn" aria-label="Search this store">${ICON.search}</button>` : ""}
    <a class="bz-pill${active === "catalogue" ? " is-active" : ""}" href="/products/${esc(profile.slug)}">All products</a>
    <a class="bz-pill bz-pill-solid" href="/b/${esc(profile.slug)}">Visit store</a>
  </nav>
</div>`;
}

function pageShell({ title, description, canonical, ogImage, ogType, jsonLd, bodyHtml, origin, robots, ctaBar, scriptsExtra }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${robots || "index, follow, max-image-preview:large"}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
${siteHeadHtml(origin)}
<link rel="stylesheet" href="${origin}/brands.css" id="lp-css-brands" onerror="window.__lpCssFailed=true">
${siteCssLinkHtml(origin)}
<link rel="stylesheet" href="${origin}/shop.css" onerror="window.__lpCssFailed=true">
<script type="application/ld+json">${safeJson(jsonLd)}</script>
<script>
(function(){
  function cssOk(){try{var v=getComputedStyle(document.documentElement).getPropertyValue("--liyog-green");return !!(v&&v.trim());}catch(e){return true;}}
  function banner(){ if(document.getElementById("lp-asset-fail-banner"))return; var b=document.createElement("div"); b.id="lp-asset-fail-banner"; b.className="lp-asset-fail-banner"; b.innerHTML="Your network looks poor. Some parts of this page may not have loaded. <button type=\\"button\\" id=\\"lp-asset-fail-refresh\\">Refresh</button>"; document.body.insertBefore(b,document.body.firstChild); document.getElementById("lp-asset-fail-refresh").addEventListener("click",function(){location.reload();}); }
  function check(){ if(window.__lpCssFailed||!cssOk()) banner(); }
  setTimeout(check,4000); window.addEventListener("online",function(){setTimeout(check,500);});
})();
</script>
</head>
<body class="bz-site${ctaBar ? " bz-has-ctabar" : " bz-has-bottomnav"}">
${siteHeaderHtml({ active: "" })}
<main class="bz-main" id="bz-main">
<div class="lp-root lp-root-wide" id="lp-root">
${bodyHtml}
</div>
</main>
${siteFooterHtml()}
${ctaBar || siteBottomNavHtml({ active: "" })}
<script src="${origin}/brands.js"></script>
<script src="${origin}/sponsored-ui.js"></script>
<script src="${origin}/shop-ui.js"></script>
${scriptsExtra || ""}
<script src="${origin}/site.js" defer></script>
</body>
</html>`;
}

const crumbsHtml = (items) => `<nav class="bz-crumbs" aria-label="Breadcrumb">${items.map((it, i) => it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : `<span aria-current="page">${esc(it.label)}</span>`).join('<i aria-hidden="true">›</i>')}</nav>`;
const crumbsLd = (origin, items) => ({ "@type": "BreadcrumbList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.label, ...(it.href ? { item: origin + it.href } : {}) })) });

// =====================================================================
// CATALOGUE  /products/{brand}
// =====================================================================
async function handleProductsListingPage(request, env, ctx, url) {
  const brandSlug = decodeURIComponent(url.pathname.split("/")[2] || "");
  const profile = await data.getPublicProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  const sp = url.searchParams;
  const state = {
    c: (sp.get("c") || "").slice(0, 60), q: (sp.get("q") || "").slice(0, 80),
    sort: data.SORT_KEYS.includes(sp.get("sort")) ? sp.get("sort") : "",
    kind: ["product", "service"].includes(sp.get("kind")) ? sp.get("kind") : ""
  };
  const page = Math.min(Math.max(parseInt(sp.get("page") || "1", 10) || 1, 1), 400);

  const [collections, result, insight] = await Promise.all([
    data.listCollections(env, profile.id, { surface: "catalogue" }),
    data.queryCatalogue(env, profile.id, { collectionSlug: state.c, q: state.q, sort: state.sort, kind: state.kind, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, withTotal: true }),
    productsEngagement.getCatalogueInsight(env, profile.id)
  ]);
  const brand = { slug: profile.slug, business_name: profile.business_name, whatsapp_number: profile.whatsapp_number };
  const activeCollection = result.collection;
  const filtered = !!(state.q || state.sort || state.kind);

  const cards = result.rows.map((r) => toCard(r));
  const parts = cards.map((c, i) => cardHtml(c, brand, { eager: i < 2, origin: url.origin }));
  // The LiyX insight sits after the first full rows, but only on the unfiltered first page.
  if (insight && insight.summary_text && !filtered && !state.c && page === 1 && parts.length > 6) parts.splice(6, 0, catalogueInsightHtml(insight));
  const gridHtml = parts.join("") || '<p class="bz-empty">Nothing matches yet. Try a different search or collection.</p>';

  const basePath = `/products/${encodeURIComponent(profile.slug)}`;
  const canonical = `${url.origin}${basePath}${activeCollection && !filtered && page === 1 ? `?c=${encodeURIComponent(activeCollection.slug)}` : ""}`;
  const titleCore = activeCollection ? `${activeCollection.title} — ${profile.business_name}` : `Products & Services — ${profile.business_name}`;
  const title = `${titleCore} | ${siteNameFor(url)}`;
  const description = metaDesc((activeCollection && activeCollection.description) || profile.tagline || `Browse everything ${profile.business_name} offers on ${siteNameFor(url)}. Message the seller directly on WhatsApp.`);
  const ogImage = (cards[0] && cards[0].image_url) || profile.cover_url || profile.logo_url || `${url.origin}/og-default.jpg`;
  const robots = filtered || page > 1 ? "noindex, follow" : undefined;

  const crumbs = [{ label: "Home", href: "/" }, { label: profile.business_name, href: `/b/${profile.slug}` }, { label: "Products & Services" }];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: titleCore, url: canonical, isPartOf: { "@type": "WebSite", name: siteNameFor(url), url: url.origin } },
      { "@type": "ItemList", itemListElement: cards.slice(0, PAGE_SIZE).map((c, i) => ({ "@type": "ListItem", position: i + 1, url: url.origin + productUrl(c, profile.slug), name: c.name })) },
      crumbsLd(url.origin, crumbs)
    ]
  };

  const nextPage = result.hasMore ? page + 1 : null;
  const qsBase = (p) => { const u = new URLSearchParams(); if (state.c) u.set("c", state.c); if (state.q) u.set("q", state.q); if (state.sort) u.set("sort", state.sort); if (state.kind) u.set("kind", state.kind); if (p > 1) u.set("page", p); const s = u.toString(); return `${basePath}${s ? "?" + s : ""}`; };

  const bodyHtml = `
<div class="bz-shop">
  ${brandBarHtml(profile, { active: "catalogue" })}
  <section class="bz-shop-hero">
    ${crumbsHtml(crumbs)}
    <h1>${esc(activeCollection ? activeCollection.title : "Products & Services")}</h1>
    <p class="bz-shop-sub">${esc(activeCollection && activeCollection.description ? activeCollection.description : (profile.tagline || `Everything ${profile.business_name} offers, in one place.`))}</p>
    <div class="bz-shop-meta"><span id="bz-count">${result.total} item${result.total === 1 ? "" : "s"}</span>
      <button type="button" class="bz-pill" id="bz-share">${ICON.share}<span>Share</span></button>
      <button type="button" class="bz-pill" id="bz-copy">${ICON.copy}<span>Copy link</span></button>
    </div>
  </section>

  <div class="bz-sticky" id="bz-sticky">
    <div class="bz-toolbar">
      <div class="bz-search" id="bz-search-wrap">
        ${ICON.search}
        <input id="bz-search-input" type="search" placeholder="Search this store" value="${esc(state.q)}" autocomplete="off" enterkeyhint="search" aria-label="Search this store" role="combobox" aria-expanded="false" aria-controls="bz-suggest">
        <div class="bz-suggest" id="bz-suggest" role="listbox" hidden></div>
      </div>
      <select id="bz-sort" class="bz-select" aria-label="Sort">
        ${[["", "Newest"], ["rating", "Top rated"], ["views", "Most viewed"], ["likes", "Most liked"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"]].map(([v, l]) => `<option value="${v}"${state.sort === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      <div class="bz-seg" id="bz-kind" role="group" aria-label="Type">
        ${[["", "All"], ["product", "Products"], ["service", "Services"]].map(([v, l]) => `<button type="button" data-k="${v}" class="${state.kind === v ? "is-active" : ""}">${l}</button>`).join("")}
      </div>
    </div>
    ${collections.length ? `<div class="bz-chips" id="bz-chips">${chipsHtml(collections, activeCollection ? activeCollection.slug : "")}</div>` : '<div id="bz-chips" hidden></div>'}
  </div>

  <div class="bz-grid" id="bz-grid">${gridHtml}</div>
  <div class="bz-sentinel" id="bz-sentinel" data-done="${nextPage ? "false" : "true"}" data-loading="false">
    <div class="bz-spinner" aria-hidden="true"></div>
    <button type="button" class="bz-more" id="bz-more-btn">Load more</button>
    <span class="bz-done">You've seen everything here</span>
  </div>
  <noscript>${page > 1 ? `<a href="${qsBase(page - 1)}">Previous page</a> ` : ""}${nextPage ? `<a href="${qsBase(nextPage)}" rel="next">Next page</a>` : ""}</noscript>

  <div class="bz-ad-slot" data-liyog-ads="products" data-format="banner" data-title="Sponsored" data-exclude="${esc(profile.id)}" data-category="${esc(profile.business_category || "")}"></div>
  ${safetyNoteHtml()}
  <div class="bz-ad-slot" data-liyog-ads="catalogues" data-format="grid" data-title="Discover more shops" data-exclude="${esc(profile.id)}" data-category="${esc(profile.business_category || "")}"></div>
</div>
<script>window.__BZ_SHOP__ = ${safeJson({ profileId: profile.id, brandSlug: profile.slug, state, next: nextPage ? page * PAGE_SIZE : null, pageSize: PAGE_SIZE, profile: { id: profile.id, business_name: profile.business_name, slug: profile.slug, whatsapp_number: profile.whatsapp_number, phone_number: profile.phone_number, business_category: profile.business_category } })};</script>`;

  return new Response(pageShell({ title, description, canonical, ogImage, ogType: "website", jsonLd, bodyHtml, origin: url.origin, robots }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache" } });
}

// =====================================================================
// PRODUCT PAGE  /product/{product}/{brand}
// =====================================================================
async function handleProductDetailPage(request, env, ctx, url) {
  const parts = url.pathname.split("/");
  const productSlug = decodeURIComponent(parts[2] || ""), brandSlug = decodeURIComponent(parts[3] || "");
  const profile = await data.getPublicProfileBySlug(env, brandSlug);
  if (!profile) return new Response("Not found", { status: 404 });

  const { results: pr } = await env.DB.prepare(
    "SELECT * FROM products WHERE profile_id = ? AND (slug = ? OR id = ?) AND is_active = 1 AND is_draft = 0"
  ).bind(profile.id, productSlug, productSlug).all();
  if (!pr.length) return new Response("Not found", { status: 404 });
  const product = pr[0];
  const card = toCard({ ...product, avg_rating: 0, rating_count: 0, like_count: 0, featured: 0 });

  if (!isBot(request)) ctx.waitUntil(Promise.resolve().then(() => productsEngagement.recordView(env, product.id)).catch(() => {}));

  const preferSlug = (url.searchParams.get("c") || "").slice(0, 60);
  const [stats, insight, images, collection, boost] = await Promise.all([
    productsEngagement.getProductStats(env, product.id),
    productsEngagement.getProductInsight(env, product.id),
    data.getProductImages(env, product.id),
    data.getCollectionForProduct(env, product.id, profile.id, preferSlug),
    env.DB.prepare("SELECT 1 FROM boost_log WHERE scope = 'product' AND product_id = ? AND expires_at > datetime('now') LIMIT 1").bind(product.id).all()
  ]);
  card.featured = boost.results.length > 0;
  card.rating = stats.average_rating || 0; card.rating_count = stats.rating_count || 0;

  let moreTitle = "", moreHtml = "", moreNext = null, moreCollectionId = "";
  if (collection) {
    const r = await data.getCollectionItems(env, collection.id, { limit: 12, excludeProductId: product.id });
    if (r.rows.length) { moreTitle = `More from ${collection.title}`; moreCollectionId = collection.id; moreNext = r.hasMore ? 12 : null; moreHtml = cardsHtml(r.rows, { slug: profile.slug, business_name: profile.business_name, whatsapp_number: profile.whatsapp_number }, { origin: url.origin }); }
  }
  if (!moreHtml) {
    const r = await data.queryCatalogue(env, profile.id, { sort: "views", limit: 13 });
    const rel = r.rows.filter((x) => x.id !== product.id).slice(0, 12);
    if (rel.length) { moreTitle = "You might also like"; moreHtml = cardsHtml(rel, { slug: profile.slug, business_name: profile.business_name, whatsapp_number: profile.whatsapp_number }, { origin: url.origin }); }
  }

  // Previous / next in the store, in the catalogue's default order.
  const { results: order } = await env.DB.prepare("SELECT id, name, slug FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 ORDER BY created_at DESC LIMIT 1000").bind(profile.id).all();
  let prev = null, next = null;
  const idx = order.findIndex((p) => p.id === product.id);
  if (order.length > 1 && idx !== -1) { prev = order[(idx - 1 + order.length) % order.length]; next = order[(idx + 1) % order.length]; }

  const canonical = `${url.origin}${productUrl(card, profile.slug)}`;
  const title = `${product.name} — ${profile.business_name} | ${siteNameFor(url)}`;
  const description = metaDesc(`${priceInner(card).replace(/<[^>]+>/g, "")}${card.price_minor != null ? " — " : ""}${product.description || `${product.name} by ${profile.business_name}.`}`);
  const imgs = images.length ? images : (product.image_url ? [{ url: product.image_url, width: product.img_w, height: product.img_h, color: product.img_color }] : []);
  const ogImage = (imgs[0] && imgs[0].url) || profile.cover_url || `${url.origin}/og-default.jpg`;

  const crumbs = [{ label: "Home", href: "/" }, { label: profile.business_name, href: `/b/${profile.slug}` }, { label: "Products & Services", href: `/products/${profile.slug}` }, { label: product.name }];
  const offer = card.price_minor != null && card.price_minor > 0 && card.currency ? {
    "@type": "Offer", price: minorToMajorString(card.price_minor, card.currency), priceCurrency: card.currency,
    availability: "https://schema.org/InStock", url: canonical, seller: { "@type": "Organization", name: profile.business_name }
  } : undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Product", name: product.name, description: product.description || undefined, image: imgs.map((i) => i.url).slice(0, 8), brand: { "@type": "Brand", name: profile.business_name }, offers: offer,
        aggregateRating: stats.rating_count ? { "@type": "AggregateRating", ratingValue: stats.average_rating, reviewCount: stats.rating_count } : undefined },
      crumbsLd(url.origin, crumbs)
    ]
  };

  const slides = imgs.map((im, i) => mediaHtml(toCard({ ...product, image_url: im.url, img_w: im.width, img_h: im.height, img_color: im.color, video_id: null }), profile.slug, { eager: i === 0, link: false }));
  const slideHtml = slides.map((s, i) => `<figure class="bz-slide" data-i="${i}">${s}</figure>`).join("") +
    (card.video ? `<figure class="bz-slide bz-slide-video" data-i="${slides.length}">${youtubeFacadeHtml(card.video, product.name)}</figure>` : "");
  const total = slides.length + (card.video ? 1 : 0);
  const thumbs = total > 1 ? `<div class="bz-thumbs">${imgs.map((im, i) => `<button type="button" class="bz-thumb${i === 0 ? " is-active" : ""}" data-i="${i}" aria-label="Photo ${i + 1}"><img src="${esc(im.url)}" alt="" loading="lazy" decoding="async"></button>`).join("")}${card.video ? `<button type="button" class="bz-thumb bz-thumb-video" data-i="${slides.length}" aria-label="Video"><img src="https://i.ytimg.com/vi/${esc(card.video)}/default.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span>▶</span></button>` : ""}</div>` : "";
  const gallery = total ? `<div class="bz-gallery" id="bz-gallery">
    <div class="bz-gallery-track" id="bz-gal-track" tabindex="0" aria-label="Photos">${slideHtml}</div>
    ${total > 1 ? `<span class="bz-gallery-count" id="bz-gal-count">1 / ${total}</span><button type="button" class="bz-gal-btn bz-gal-prev" aria-label="Previous">${ICON.prev}</button><button type="button" class="bz-gal-btn bz-gal-next" aria-label="Next">${ICON.next}</button>` : ""}
    ${thumbs}</div>` : '<div class="bz-gallery"><div class="bz-media bz-fit-cover"><span class="bz-media-empty"></span></div></div>';

  const wa = waLink({ slug: profile.slug, business_name: profile.business_name, whatsapp_number: profile.whatsapp_number }, card, url.origin);
  const tel = String(profile.phone_number || "").replace(/[^\d+]/g, "");
  const isService = card.kind === "service";
  const ctaButtons = `${wa ? `<a class="bz-btn bz-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener noreferrer nofollow">${ICON.wa}<span>${isService ? "Book on WhatsApp" : "Order on WhatsApp"}</span></a>` : ""}${/^\+?\d{6,16}$/.test(tel) ? `<a class="bz-btn bz-btn-call" href="tel:${esc(tel)}">${ICON.call}<span>Call</span></a>` : ""}<button type="button" class="bz-btn bz-btn-ask" id="bz-ask">${ICON.chat}<span>Ask</span></button>`;
  const ctaBar = `<div class="bz-ctabar" role="region" aria-label="Contact the seller">${ctaButtons}</div>`;

  const hasOwnerHint = hasSessionCookie(request);
  const pv = (p) => p ? `<a class="bz-prevnext-btn" href="/product/${encodeURIComponent(p.slug || p.id)}/${esc(profile.slug)}"><span>${esc(p === prev ? "Previous" : "Next")}</span><strong>${esc(p.name)}</strong></a>` : "";

  const bodyHtml = `
<div class="bz-shop bz-pdp-wrap">
  ${brandBarHtml(profile, { active: "product" })}
  ${crumbsHtml(crumbs)}
  <div class="bz-pdp">
    <section class="bz-pdp-media">${gallery}</section>
    <section class="bz-pdp-info">
      <div class="bz-tags">
        <span class="bz-tag">${isService ? "Service" : "Product"}</span>
        ${card.featured ? '<span class="bz-tag bz-tag-gold">★ Featured</span>' : ""}
        ${profile.store_city ? `<span class="bz-tag bz-tag-soft">${esc(profile.store_city)}</span>` : ""}
      </div>
      <h1 class="bz-pdp-title">${esc(product.name)}</h1>
      ${priceHtml(card, "bz-price-xl")}
      <div class="bz-pdp-eng" id="lp-detail-engbar">${engagementBarHtml(product, stats)}</div>
      <div class="bz-cta-inline">${ctaButtons}</div>
      <a class="bz-seller" href="/b/${esc(profile.slug)}">
        ${profile.logo_url ? `<img src="${esc(profile.logo_url)}" alt="" width="44" height="44" loading="lazy">` : '<span class="bz-seller-logo"></span>'}
        <span class="bz-seller-text"><strong>${esc(profile.business_name)}</strong><small>${esc(profile.response_time ? profile.response_time : "View store and reviews")}</small></span><i aria-hidden="true">›</i>
      </a>
      ${safetyNoteHtml()}
      ${product.description ? `<div class="bz-desc" id="bz-desc"><h2>About this ${isService ? "service" : "item"}</h2><p class="bz-desc-text">${esc(product.description)}</p><button type="button" class="bz-linkbtn" id="bz-desc-toggle" hidden>Read more</button></div>` : ""}
      <div class="bz-actions-row">
        <button type="button" class="bz-pill" id="lp-product-page-share">${ICON.share}<span>Share</span></button>
        <button type="button" class="bz-pill" id="lp-product-page-copy">${ICON.copy}<span>Copy link</span></button>
        <button type="button" class="bz-pill bz-pill-quiet" id="lp-product-page-report" data-product-id="${esc(product.id)}" data-product-name="${esc(product.name)}">${ICON.flag}<span>Report</span></button>
      </div>
      <div class="lp-detail-stats" id="lp-detail-stats"></div>
      <div class="lp-detail-insight" id="lp-detail-insight"></div>
    </section>
  </div>

  ${moreHtml ? `<section class="bz-more-row" id="bz-more-row" data-collection="${esc(moreCollectionId)}" data-next="${moreNext == null ? "" : moreNext}" data-exclude="${esc(product.id)}">
    <div class="bz-row-head"><h2>${esc(moreTitle)}</h2>${collection ? `<a class="bz-linkbtn" href="/products/${esc(profile.slug)}?c=${encodeURIComponent(collection.slug)}">See all</a>` : `<a class="bz-linkbtn" href="/products/${esc(profile.slug)}">See all</a>`}</div>
    <div class="bz-row" id="bz-row">${moreHtml}</div></section>` : ""}

  <div class="bz-ad-slot" data-liyog-ads="products" data-format="strip" data-title="Sponsored" data-exclude="${esc(profile.id)}" data-category="${esc(profile.business_category || "")}"></div>
  <div class="lp-product-page-owner-chart" id="lp-product-page-owner-chart" data-product-id="${esc(product.id)}"></div>
  ${prev && next ? `<div class="bz-prevnext">${pv(prev)}${pv(next)}</div>` : ""}
  <div class="bz-ad-slot" data-liyog-ads="catalogues" data-format="strip" data-title="Discover more shops" data-exclude="${esc(profile.id)}" data-category="${esc(profile.business_category || "")}"></div>
</div>
<div class="bz-overlay" id="bz-brand-search" hidden>
  <div class="bz-overlay-card" role="dialog" aria-label="Search this store">
    <div class="bz-search bz-search-lg">${ICON.search}<input id="bz-bs-input" type="search" placeholder="Search ${esc(profile.business_name)}" autocomplete="off" aria-label="Search this store"></div>
    <div class="bz-bs-results" id="bz-bs-results"></div>
    <button type="button" class="bz-pill" id="bz-bs-close">Close</button>
  </div>
</div>
<script>window.__BZ_PRODUCT__ = ${safeJson({
    profile: { id: profile.id, business_name: profile.business_name, slug: profile.slug, whatsapp_number: profile.whatsapp_number, phone_number: profile.phone_number, business_category: profile.business_category },
    product: { id: product.id, name: product.name, slug: product.slug, description: product.description, price_display: product.price_display, image_url: product.image_url },
    stats, insight, hasOwnerSessionHint: hasOwnerHint
  })};</script>`;

  return new Response(pageShell({ title, description, canonical, ogImage, ogType: "product", jsonLd, bodyHtml, origin: url.origin, ctaBar }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache" } });
}

export { handleProductsListingPage, handleProductDetailPage };
