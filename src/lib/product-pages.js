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

function buildMetaDescription(description, priceDisplay, maxLen = 160) {
  const desc = (description || "").replace(/\s+/g, " ").trim();
  const pricePart = priceDisplay ? `${priceDisplay} — ` : "";
  const combined = pricePart + desc;
  return combined.length > maxLen ? combined.slice(0, maxLen - 1) + "…" : combined;
}

async function getApprovedProfileBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, business_name, tagline, bio_html, logo_url, cover_url, business_category, is_active, moderation_status, referral_code FROM profiles WHERE slug = ?"
  ).bind(slug).all();
  if (!results.length || !results[0].is_active || results[0].moderation_status !== "approved") return null;
  return results[0];
}

// Shared page chrome: header nav linking back to the brand profile,
// footer, and the CSS/JS assets already used everywhere else on the
// site — these pages intentionally reuse profile.css/profile.js
// rather than shipping a parallel styling system, so a visitor moving
// between the brand profile, the catalogue page, and a product page
// never sees a visual seam.
function pageShell({ title, metaDescription, canonicalUrl, ogImage, ogType, jsonLd, bodyHtml, origin }) {
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
<link rel="stylesheet" href="${origin}/brands.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<div class="lp-root" id="lp-root">
${bodyHtml}
</div>
<script src="${origin}/brands.js"></script>
<script src="${origin}/product-pages-client.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------
// Route 1: GET /products/{brand-slug} — the full catalogue listing.
// Server-renders every product's card markup directly (crawlable,
// indexable, no JS needed to see the catalogue), then a small inline
// script hydrates search/filter/sort interactivity and wires the
// engagement bar (like/rate/share/report) using profile.js's existing
// functions, exactly as the brand profile's inline grid already does.
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

  const canonicalUrl = `${url.origin}/products/${brandSlug}`;
  const title = `Products & Services — ${profile.business_name} | Liyog World`;
  const metaDescription = buildMetaDescription(
    profile.tagline || `Browse everything ${profile.business_name} offers.`,
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

  const cardsHtml = filtered.map((prod) => {
    const stats = statsByProduct[prod.id] || {};
    const productWithEngagement = { ...prod, _engagement: { stats, my_like: false, my_rating: null } };
    return `<a class="lp-shop-card" href="/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(brandSlug)}" data-product-id="${escapeHtmlAttr(prod.id)}">
      <div class="lp-shop-card-imgwrap">
        ${prod.image_url
          ? `<img src="${escapeHtmlAttr(prod.image_url)}" alt="${escapeHtmlAttr(prod.name)}" loading="lazy">`
          : `<div class="lp-shop-card-imgwrap-empty"></div>`}
      </div>
      <div class="lp-shop-card-body">
        <div class="lp-shop-card-name">${escapeHtmlAttr(prod.name)}</div>
        ${prod.price_display ? `<div class="lp-shop-card-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        <div class="lp-shop-card-meta">
          <span>${stats.average_rating ? stats.average_rating.toFixed(1) + " ★" : "No ratings yet"}</span>
          <span>${prod.view_count || 0} views</span>
        </div>
      </div>
    </a>`;
  }).join("");

  const bodyHtml = `
    <header class="lp-shop-header">
      <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-back-link">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
        <span>${escapeHtmlAttr(profile.business_name)}</span>
      </a>
      <h1 class="lp-shop-title">Products &amp; Services</h1>
      <p class="lp-shop-subtitle">${escapeHtmlAttr(profile.tagline || `Everything ${profile.business_name} offers, all in one place.`)}</p>
    </header>

    <div class="lp-shop-toolbar">
      <div class="lp-mgsearch" id="lp-shop-search-wrap">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="lp-shop-search-input" class="lp-mgsearch-input" placeholder="Search products & services…" value="${escapeHtmlAttr(url.searchParams.get("q") || "")}" autocomplete="off">
      </div>
      <div class="lp-shop-sort-wrap">
        <select id="lp-shop-sort-select" class="lp-shop-sort-select">
          <option value="newest" ${sortParam === "newest" ? "selected" : ""}>Newest</option>
          <option value="rating" ${sortParam === "rating" ? "selected" : ""}>Highest rated</option>
          <option value="views" ${sortParam === "views" ? "selected" : ""}>Most viewed</option>
          <option value="likes" ${sortParam === "likes" ? "selected" : ""}>Most liked</option>
        </select>
      </div>
    </div>

    <div class="lp-shop-grid" id="lp-shop-grid">
      ${cardsHtml || `<p class="lp-shop-empty">No products match your search.</p>`}
    </div>

    <script>
      window.__LIYOG_SHOP_CONTEXT__ = {
        profileId: ${JSON.stringify(profile.id)},
        brandSlug: ${JSON.stringify(brandSlug)},
        products: ${JSON.stringify(filtered)},
        statsByProduct: ${JSON.stringify(statsByProduct)}
      };
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "website", jsonLd, bodyHtml, origin: url.origin
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

  const bodyHtml = `
    <header class="lp-shop-header lp-shop-header-tight">
      <a href="/product/${encodeURIComponent(product.slug || product.id)}/${escapeHtmlAttr(brandSlug)}" class="lp-shop-back-link" id="lp-product-page-back-catalogue" data-catalogue-href="/products/${escapeHtmlAttr(brandSlug)}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M15 18l-6-6 6-6"/></svg>
        <span>All Products</span>
      </a>
      <a href="/b/${escapeHtmlAttr(brandSlug)}" class="lp-shop-back-link lp-shop-back-link-secondary">
        <span>${escapeHtmlAttr(profile.business_name)}</span>
      </a>
    </header>

    <div class="lp-detail-hero lp-detail-hero-static">
      ${product.image_url
        ? `<img src="${escapeHtmlAttr(product.image_url)}" alt="${escapeHtmlAttr(product.name)}" class="lp-detail-hero-img">`
        : `<div class="lp-detail-hero-placeholder"></div>`}
    </div>

    <div class="lp-detail-body">
      <h1 class="lp-detail-name">${escapeHtmlAttr(product.name)}</h1>
      ${product.price_display ? `<div class="lp-detail-price">${escapeHtmlAttr(product.price_display)}</div>` : ""}
      <div class="lp-detail-engbar" id="lp-detail-engbar"></div>
      ${product.description ? `<p class="lp-detail-desc">${escapeHtmlAttr(product.description)}</p>` : ""}
      <div class="lp-detail-contact" id="lp-detail-contact"></div>
      <div class="lp-detail-stats" id="lp-detail-stats"></div>
      <div class="lp-detail-insight" id="lp-detail-insight"></div>
      <div class="lp-detail-chart" id="lp-detail-chart"></div>
    </div>

    <script>
      window.__LIYOG_PRODUCT_PAGE_CONTEXT__ = {
        profile: ${JSON.stringify(profile)},
        product: ${JSON.stringify(product)},
        stats: ${JSON.stringify(stats)},
        insight: ${JSON.stringify(insight)},
        brandSlug: ${JSON.stringify(brandSlug)}
      };
    </script>
  `;

  const html = pageShell({
    title, metaDescription, canonicalUrl, ogImage,
    ogType: "product", jsonLd, bodyHtml, origin: url.origin
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export { handleProductsListingPage, handleProductDetailPage };

