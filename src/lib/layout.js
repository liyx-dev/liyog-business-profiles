// =====================================================================
// BIZIPLEX — src/lib/layout.js
// The shared "site layer": head tags (fonts, icons, theme), the global
// header, footer and mobile bottom bar, plus the generic page builder
// used by the homepage, explore, join and brand-profile shell pages.
// Server-rendered, so Google and link previews see real content.
//
// Brand image files are served from here too (they are embedded in
// assets/brand-assets.js, so deploying from GitHub is all it takes).
// =====================================================================

import { BRAND_ASSETS } from "../assets/brand-assets.js";

export const SITE = {
  name: "BiziPlex",
  slogan: "Discover. Connect. Grow. Earn.",
  description: "BiziPlex is an online marketplace that helps businesses get discovered, showcase their products and services, and connect directly with customers.",
  social: { x: "https://x.com/LiyogWorld" }   // change when BiziPlex has its own handle
};

export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Safe for JSON inside an inline <script> (cannot end the script or open a tag).
export function safeJson(value) {
  const s = JSON.stringify(value);
  if (s === undefined) return "null";
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------
// Brand files: /brand/*, /favicon.ico, /apple-touch-icon.png, /og-default.jpg
// ---------------------------------------------------------------------
const ASSET_ROUTES = {
  "/brand/logo-mark.png": "logo-mark.png",
  "/brand/icon-32.png": "icon-32.png",
  "/brand/icon-48.png": "icon-48.png",
  "/brand/icon-192.png": "icon-192.png",
  "/brand/icon-512.png": "icon-512.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/favicon.ico": "icon-48.png",
  "/og-default.jpg": "og-default.jpg",
  "/default-og-image.png": "og-default.jpg"      // older pages still point here
};
const decoded = new Map();

function decodeAsset(name) {
  if (decoded.has(name)) return decoded.get(name);
  const entry = BRAND_ASSETS[name];
  if (!entry) return null;
  const bin = atob(entry.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = { bytes, type: entry.type };
  decoded.set(name, out);
  return out;
}

/** Returns a Response for a brand file path, or null if the path is not one. */
export function serveBrandAsset(pathname) {
  const name = ASSET_ROUTES[pathname];
  if (!name) return null;
  const asset = decodeAsset(name);
  if (!asset) return null;
  return new Response(asset.bytes, {
    headers: { "content-type": asset.type, "cache-control": "public, max-age=86400" }
  });
}

export function serveManifest(origin) {
  const manifest = {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F2F5F3",
    theme_color: "#00A94F",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=86400" }
  });
}

// ---------------------------------------------------------------------
// Icons (inline SVG, no extra requests)
// ---------------------------------------------------------------------
const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  moon: '<svg class="bz-ico-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg class="bz-ico-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  compass: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>',
  user: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3L14.2 10.6 22 21h-6.1l-4.8-6.3L5.6 21h-3l7-8.1L2.2 3h6.2l4.3 5.8zm-1 16.2h1.7L7.5 4.7H5.7z"/></svg>'
};

// ---------------------------------------------------------------------
// <head> pieces
// ---------------------------------------------------------------------
export function siteHeadHtml(origin) {
  return `<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0D1114" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/png" sizes="48x48" href="${origin}/brand/icon-48.png">
<link rel="icon" type="image/png" sizes="32x32" href="${origin}/brand/icon-32.png">
<link rel="apple-touch-icon" href="${origin}/apple-touch-icon.png">
<link rel="manifest" href="${origin}/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap">
<script>
/* Applies the saved theme before first paint (no flash). Same storage key the
   product pages already use, so existing visitors keep their choice. */
(function(){try{var t=localStorage.getItem("liyog_shop_theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();
</script>`;
}

/** Must be placed AFTER brands.css / product-pages.css so the brand palette wins. */
export function siteCssLinkHtml(origin) {
  return `<link rel="stylesheet" href="${origin}/site.css">`;
}

// ---------------------------------------------------------------------
// Header, footer, bottom bar
// ---------------------------------------------------------------------
export function siteHeaderHtml({ active = "" } = {}) {
  return `<a class="bz-skip" href="#bz-main">Skip to content</a>
<header class="bz-header" id="bz-header" data-active="${esc(active)}">
  <div class="bz-header-inner">
    <a class="bz-brand" href="/" aria-label="BiziPlex home">
      <img class="bz-brand-mark" src="/brand/logo-mark.png" width="36" height="36" alt="">
      <span class="bz-brand-word">Bizi<b>Plex</b></span>
    </a>
    <form class="bz-search" role="search" action="/explore" method="get">
      ${ICON.search}
      <input type="search" name="q" placeholder="Search brands, products &amp; services" aria-label="Search BiziPlex" autocomplete="off" enterkeyhint="search">
    </form>
    <nav class="bz-nav" aria-label="Primary">
      <a class="bz-nav-link" data-nav="explore" href="/explore">Explore</a>
    </nav>
    <div class="bz-actions">
      <button type="button" class="bz-icon-btn bz-search-toggle" id="bz-search-toggle" aria-label="Search" aria-expanded="false">${ICON.search}</button>
      <button type="button" class="bz-icon-btn bz-theme-toggle" id="bz-theme-toggle" aria-label="Switch to dark mode" aria-pressed="false">${ICON.moon}${ICON.sun}</button>
      <div class="bz-auth" id="bz-auth">
        <a class="bz-btn bz-btn-ghost bz-signin" href="/join">Sign in</a>
        <a class="bz-btn bz-btn-primary bz-create" href="/join">Create profile</a>
      </div>
    </div>
  </div>
  <form class="bz-search-mobile" id="bz-search-mobile" role="search" action="/explore" method="get" hidden>
    <input type="search" name="q" placeholder="Search brands, products &amp; services" aria-label="Search BiziPlex" autocomplete="off" enterkeyhint="search">
  </form>
</header>`;
}

export function siteFooterHtml() {
  const year = new Date().getFullYear();
  return `<footer class="bz-footer">
  <div class="bz-footer-inner">
    <div class="bz-footer-brand">
      <a class="bz-brand" href="/" aria-label="BiziPlex home">
        <img class="bz-brand-mark" src="/brand/logo-mark.png" width="32" height="32" alt="" loading="lazy">
        <span class="bz-brand-word">Bizi<b>Plex</b></span>
      </a>
      <p class="bz-footer-text">Every business visible. Every brand discoverable. Every connection an opportunity for growth.</p>
      <p class="bz-footer-slogan">${esc(SITE.slogan)}</p>
    </div>
    <div class="bz-footer-col">
      <h4>Platform</h4>
      <a href="/explore">Explore</a>
      <a href="/join">Create your profile</a>
      <a href="/join">Sign in</a>
    </div>
    <div class="bz-footer-col">
      <h4>Follow us</h4>
      <a href="${esc(SITE.social.x)}" target="_blank" rel="noopener noreferrer">${ICON.x}<span>X (Twitter)</span></a>
    </div>
  </div>
  <div class="bz-footer-bottom">
    <span>&copy; ${year} ${esc(SITE.name)}. All rights reserved.</span>
  </div>
</footer>`;
}

export function siteBottomNavHtml({ active = "" } = {}) {
  return `<nav class="bz-bottomnav" aria-label="Main" data-active="${esc(active)}">
  <a class="bz-tab" data-tab="home" href="/">${ICON.home}<span>Home</span></a>
  <a class="bz-tab" data-tab="explore" href="/explore">${ICON.compass}<span>Explore</span></a>
  <a class="bz-tab" data-tab="account" id="bz-tab-account" href="/join">${ICON.user}<span>Join</span></a>
</nav>`;
}

// ---------------------------------------------------------------------
// Generic page builder (home, explore, join, brand-profile shell)
// ---------------------------------------------------------------------
export function buildSitePageHtml(url, opts) {
  const o = url.origin;
  const {
    title, description, canonicalPath = url.pathname, ogImage, ogType = "website",
    jsonLd = null, active = "", bodyHtml = "", extraHead = "", scripts = [], noindex = false
  } = opts;
  const canonical = `${o}${canonicalPath}`;
  const image = ogImage || `${o}/og-default.jpg`;
  const scriptTags = scripts.map((s) => `<script src="${o}${s}"></script>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
${siteHeadHtml(o)}
<link rel="stylesheet" href="${o}/brands.css">
${extraHead}
${siteCssLinkHtml(o)}
${jsonLd ? `<script type="application/ld+json">${safeJson(jsonLd)}</script>` : ""}
</head>
<body class="bz-site bz-has-bottomnav">
${siteHeaderHtml({ active })}
<main class="bz-main" id="bz-main">
${bodyHtml}
</main>
${siteFooterHtml()}
${siteBottomNavHtml({ active })}
${scriptTags}
<script src="${o}/site.js" defer></script>
</body>
</html>`;
}

export function renderSitePage(url, opts, status = 200) {
  return new Response(buildSitePageHtml(url, opts), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" }
  });
}

// ---------------------------------------------------------------------
// Brand-profile / join shell (profile.js renders into #liyog-profile-root)
// ---------------------------------------------------------------------
export function profileShellHtml(url, { slug = null, profile = null } = {}) {
  const name = profile ? profile.business_name : null;
  const title = name ? `${name} | ${SITE.name}` : `Create your free brand profile | ${SITE.name}`;
  const description = profile
    ? (profile.tagline || `${name} on ${SITE.name} — products, services and direct contact.`)
    : "Create your free brand profile on BiziPlex and get discovered by customers.";
  const image = profile ? (profile.cover_url || profile.logo_url || null) : null;
  const slugJs = safeJson(slug || null);

  // Instant, crawlable summary inside the mount point. profile.js replaces it
  // with the full page as soon as it loads.
  const ssr = name
    ? `<div class="bz-ssr"><h1>${esc(name)}</h1>${profile.tagline ? `<p>${esc(profile.tagline)}</p>` : ""}</div>`
    : (slug ? "" : `<div class="bz-ssr"><h1>Create your free brand profile</h1><p>Give your business a home online. Sign in with Google to get started.</p></div>`);

  return buildSitePageHtml(url, {
    title, description, ogImage: image,
    canonicalPath: slug ? `/b/${encodeURIComponent(slug)}` : "/join",
    ogType: slug ? "profile" : "website",
    noindex: !!(slug && !profile),
    active: slug ? "" : "join",
    extraHead: `<link rel="stylesheet" href="${url.origin}/auth-ui.css">
<script>window.__LIYOG_SLUG__ = ${slugJs};</script>`,
    bodyHtml: `<div id="liyog-profile-root">${ssr}</div>`,
    scripts: ["/auth-ui.js", "/reviews-ui.js", "/tiers-ui.js", "/boost-ui.js", "/sponsored-ui.js", "/brands.js"]
  });
}
