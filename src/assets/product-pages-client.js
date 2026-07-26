/* =====================================================================
   LIYOG WORLD — src/assets/product-pages-client.js
   Small hydration script for the two standalone server-rendered pages
   (/products/{slug} listing, /product/{slug}/{brand} detail). Loaded
   AFTER profile.js (which exposes window.LiyogProductUI — see the
   bottom of profile.js), and after brands.css. Deliberately its own
   file, per the "split code for easy debug/maintenance" instruction —
   this never touches profile.js's internals directly, only the small
   public surface it exposes.
   ===================================================================== */
(function () {
  "use strict";

  const ui = window.LiyogProductUI;
  if (!ui) { console.error("LiyogProductUI not found — profile.js must load before this script."); return; }

  // -----------------------------------------------------------------
  // Listing page: /products/{slug}
  // -----------------------------------------------------------------
  if (window.__LIYOG_SHOP_CONTEXT__) {
    hydrateShopListingPage(window.__LIYOG_SHOP_CONTEXT__);
  }

  // -----------------------------------------------------------------
  // Individual product page: /product/{slug}/{brand}
  // -----------------------------------------------------------------
  if (window.__LIYOG_PRODUCT_PAGE_CONTEXT__) {
    hydrateProductDetailPage(window.__LIYOG_PRODUCT_PAGE_CONTEXT__);
  }

  function hydrateShopListingPage(ctx) {
    const searchInput = document.getElementById("lp-shop-search-input");
    const sortSelect = document.getElementById("lp-shop-sort-select");

    // Search/sort re-navigate with updated query params rather than
    // trying to re-render the grid client-side — this keeps the URL
    // itself always representing the current view (shareable,
    // bookmarkable, and correctly indexed per filter combination),
    // which a client-only re-render would not give you for free.
    function applyFilters() {
      const url = new URL(window.location.href);
      const q = searchInput.value.trim();
      if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
      url.searchParams.set("sort", sortSelect.value);
      window.location.href = url.toString();
    }

    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyFilters, 500);
    });
    sortSelect.addEventListener("change", applyFilters);

    // Engagement bars aren't server-rendered on the listing cards
    // themselves (they're plain <a> cards for fast, crawlable markup)
    // — but the small meta row (rating/views) already shows server-
    // rendered numbers, so nothing further to hydrate here beyond
    // search/sort. Card taps are plain navigation (real <a href>),
    // intentionally not intercepted by JS.
  }

  async function hydrateProductDetailPage(ctx) {
    const { profile, product, stats, insight, brandSlug } = ctx;

    const engBarEl = document.getElementById("lp-detail-engbar");
    const contactEl = document.getElementById("lp-detail-contact");
    const statsEl = document.getElementById("lp-detail-stats");
    const insightEl = document.getElementById("lp-detail-insight");

    // Merge server-provided stats into the product object in the same
    // shape engagementBarHtml expects (product._engagement.stats),
    // then fetch the visitor's OWN like/rating state client-side —
    // that part genuinely can't be server-rendered since it depends
    // on the visitor's session/fingerprint, not anything cacheable.
    let myLike = false;
    let myRating = null;
    try {
      const res = await fetch(`https://www.liyogworld.com.ng/api/products/${product.id}/engagement?ds=${encodeURIComponent(ui.getDeviceSignal())}`, { credentials: "include" });
      const data = await res.json();
      myLike = !!data.my_like;
      myRating = data.my_rating || null;
    } catch (e) { /* engagement personalization is an enhancement, not critical path */ }

    const productWithEngagement = { ...product, _engagement: { stats, my_like: myLike, my_rating: myRating } };

    if (engBarEl) {
      engBarEl.innerHTML = ui.engagementBarHtml(productWithEngagement, true);
      ui.wireProductCardActions(engBarEl, profile);
    }
    if (contactEl) {
      contactEl.innerHTML = ui.contactButtonsHtml(profile, product, true);
      ui.wireProductCardActions(contactEl, profile);
    }
    if (statsEl) statsEl.innerHTML = ui.detailStatsHtml(stats);
    if (insightEl && insight) insightEl.innerHTML = ui.detailInsightHtml(insight);
  }
})();
