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
<link rel="stylesheet" href="${origin}/product-pages.css">
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

  // Every 8th card becomes a full-width "Facebook ad" style feature
  // break — a dynamic rhythm change for longer catalogues, exactly
  // like the brand-profile's own inline feed does with its first item.
  const FEATURE_BREAK_EVERY = 8;
  const cardsHtml = filtered.map((prod, i) => {
    const stats = statsByProduct[prod.id] || {};
    const href = `/product/${encodeURIComponent(prod.slug || prod.id)}/${escapeHtmlAttr(brandSlug)}`;
    const isFeature = i > 0 && i % FEATURE_BREAK_EVERY === 0;

    if (isFeature) {
      return `<a class="lp-shop-feature-break" href="${href}">
        <div class="lp-shop-feature-imgwrap">
          ${prod.image_url ? `<img src="${escapeHtmlAttr(prod.image_url)}" alt="${escapeHtmlAttr(prod.name)}" loading="lazy">` : ""}
        </div>
        <div class="lp-shop-feature-body">
          <div class="lp-shop-feature-name">${escapeHtmlAttr(prod.name)}</div>
          ${prod.price_display ? `<div class="lp-shop-card-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        </div>
      </a>`;
    }

    return `<a class="lp-shop-card" href="${href}" data-product-id="${escapeHtmlAttr(prod.id)}">
      <div class="lp-shop-card-imgwrap">
        ${prod.image_url
          ? `<img src="${escapeHtmlAttr(prod.image_url)}" alt="${escapeHtmlAttr(prod.name)}" loading="lazy">`
          : `<div class="lp-shop-card-imgwrap-empty"></div>`}
      </div>
      <div class="lp-shop-card-body">
        <div class="lp-shop-card-name">${escapeHtmlAttr(prod.name)}</div>
        ${prod.price_display ? `<div class="lp-shop-card-price">${escapeHtmlAttr(prod.price_display)}</div>` : ""}
        <div class="lp-shop-card-meta">
          <span>★ ${stats.average_rating ? stats.average_rating.toFixed(1) : "—"}</span>
          <span>${prod.view_count || 0} views</span>
        </div>
      </div>
    </a>`;
  }).join("");

  const bodyHtml = `
    <header class="lp-shop-topheader">
      <div class="lp-shop-topheader-inner">
        ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
        <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        <nav class="lp-shop-topheader-nav">
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

      <div class="lp-shop-insight-wrap" id="lp-shop-insight-wrap">
        ${insight && insight.summary_text ? "" : ""}
      </div>

      <div class="lp-shop-grid" id="lp-shop-grid">
        ${cardsHtml || `<p class="lp-shop-empty">No products match your search.</p>`}
      </div>
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
        brandSlug: ${JSON.stringify(brandSlug)},
        businessName: ${JSON.stringify(profile.business_name)},
        products: ${JSON.stringify(filtered)},
        statsByProduct: ${JSON.stringify(statsByProduct)},
        insight: ${JSON.stringify(insight)}
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

  const bodyHtml = `
    <header class="lp-shop-topheader">
      <div class="lp-shop-topheader-inner">
        ${profile.logo_url ? `<img src="${escapeHtmlAttr(profile.logo_url)}" alt="" class="lp-shop-topheader-logo">` : ""}
        <span class="lp-shop-topheader-name">${escapeHtmlAttr(profile.business_name)}</span>
        <nav class="lp-shop-topheader-nav">
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

      <div class="lp-product-page-engbar" id="lp-detail-engbar"></div>

      ${product.description ? `<p class="lp-product-page-desc">${escapeHtmlAttr(product.description)}</p>` : ""}

      <div class="lp-detail-contact" id="lp-detail-contact"></div>

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

      ${related.length ? `
      <div class="lp-related-products">
        <h2 class="lp-related-products-title">You might also like</h2>
        <div class="lp-related-products-scroll">${relatedHtml}</div>
      </div>` : ""}
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
