// =====================================================================
// BIZIPLEX — src/lib/site-pages.js
// Homepage ("/") and Explore ("/explore") for biziplex.com.
// These are the first versions: real, fast, server-rendered pages that
// already use the shared header/footer and the live sponsored/featured
// brand data. Search results and filters arrive with the /explore build.
// =====================================================================

import { renderSitePage, esc, SITE } from "./layout.js";

export function renderHomePage(url) {
  const o = url.origin;
  const body = `
<section class="bz-hero">
  <div class="bz-container bz-hero-inner">
    <p class="bz-eyebrow">The marketplace for businesses</p>
    <h1>Get your business <em>discovered</em>.</h1>
    <p class="bz-lead">BiziPlex gives every business its own digital brand space inside one searchable marketplace. Showcase your products and services, and connect directly with customers.</p>
    <form class="bz-hero-search" action="/explore" method="get" role="search">
      <input type="search" name="q" placeholder="Search brands, products &amp; services" aria-label="Search BiziPlex" autocomplete="off" enterkeyhint="search">
      <button class="bz-btn bz-btn-primary" type="submit">Search</button>
    </form>
    <div class="bz-hero-cta">
      <a class="bz-btn bz-btn-primary bz-btn-lg" href="/join">Create your free profile</a>
      <a class="bz-btn bz-btn-ghost bz-btn-lg" href="/explore">Explore brands</a>
    </div>
    <ul class="bz-slogan" aria-label="${esc(SITE.slogan)}">
      <li>Discover</li><li>Connect</li><li>Grow</li><li>Earn</li>
    </ul>
  </div>
</section>

<section class="bz-section">
  <div class="bz-container">
    <div class="bz-embed" data-liyog-ads="profiles" data-format="grid" data-title="Featured brands"></div>
  </div>
</section>

<section class="bz-section" style="padding-top:0">
  <div class="bz-container">
    <h2 class="bz-h2">How BiziPlex works</h2>
    <p class="bz-sub">Three simple steps from invisible to impossible to miss.</p>
    <div class="bz-steps">
      <div class="bz-step"><div class="bz-step-num">1</div><h3>Create your brand space</h3><p>Sign in with Google and claim your own link, like biziplex.com/b/yourbrand, in under a minute.</p></div>
      <div class="bz-step"><div class="bz-step-num">2</div><h3>Showcase what you sell</h3><p>Add your story, photos, products and services so customers see exactly what you offer.</p></div>
      <div class="bz-step"><div class="bz-step-num">3</div><h3>Connect and grow</h3><p>Customers message you on WhatsApp or call you directly. Boost your brand to reach even more people.</p></div>
    </div>
  </div>
</section>

<section class="bz-section" style="padding-top:0">
  <div class="bz-container">
    <div class="bz-earn">
      <span class="bz-earn-badge">Coming soon</span>
      <div>
        <h3>Earn as you grow</h3>
        <p>A BiziPlex referral programme is on its way, so you can earn by helping other businesses get discovered.</p>
      </div>
    </div>
  </div>
</section>

<section class="bz-section" style="padding-top:0">
  <div class="bz-container">
    <div class="bz-band">
      <h2>Every business deserves to be found.</h2>
      <p>Join BiziPlex free and give your brand a home customers can search, share and trust.</p>
      <a class="bz-btn bz-btn-ghost bz-btn-lg" href="/join">Create your free profile</a>
    </div>
  </div>
</section>`;

  return renderSitePage(url, {
    title: "BiziPlex — Discover. Connect. Grow. Earn.",
    description: SITE.description,
    canonicalPath: "/",
    active: "home",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "name": SITE.name, "url": o, "logo": `${o}/brand/icon-512.png`, "sameAs": [SITE.social.x] },
        { "@type": "WebSite", "name": SITE.name, "url": o, "description": SITE.description }
      ]
    },
    bodyHtml: body,
    scripts: ["/brands.js", "/sponsored-ui.js"]
  });
}

export function renderExplorePage(url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const body = `
<div class="bz-container">
  <div class="bz-page-head">
    <h1>Explore BiziPlex</h1>
    <p class="bz-sub" style="margin-bottom:0">Discover brands, shops and products from businesses near you and around the world.</p>
    ${q ? `<p class="bz-note">You searched for <strong>${esc(q)}</strong>. Full search and filters are being built, so for now here are featured brands, shops and products.</p>` : ""}
  </div>
</div>
<section class="bz-section" style="padding-top:20px">
  <div class="bz-container"><div class="bz-embed" data-liyog-ads="profiles" data-format="grid" data-title="Brands"></div></div>
</section>
<section class="bz-section" style="padding-top:0">
  <div class="bz-container"><div class="bz-embed" data-liyog-ads="catalogues" data-format="grid" data-title="Shops"></div></div>
</section>
<section class="bz-section" style="padding-top:0">
  <div class="bz-container"><div class="bz-embed" data-liyog-ads="products" data-format="grid" data-title="Products &amp; services"></div></div>
</section>`;

  return renderSitePage(url, {
    title: "Explore brands, shops and products | BiziPlex",
    description: "Explore businesses, products and services on BiziPlex and connect with them directly on WhatsApp or by phone.",
    canonicalPath: "/explore",
    active: "explore",
    noindex: !!q,
    bodyHtml: body,
    scripts: ["/brands.js", "/sponsored-ui.js"]
  });
}
