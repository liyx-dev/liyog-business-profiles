// =====================================================================
// BIZIPLEX — src/lib/studio-shell.js
// The page for /studio and /studio/{brand}/... . The same header, footer and bottom bar as the rest of
// the site, with the Studio app (assets/studio-app.txt) drawing everything inside #bz-studio.
// Never indexed by search engines: it is a private working area.
// =====================================================================
import { buildSitePageHtml } from "./layout.js";

export function studioShellHtml(url) {
  const o = url.origin;
  return buildSitePageHtml(url, {
    title: "Studio | BiziPlex",
    description: "Manage your BiziPlex brand: items, collections, boosts, profile and more.",
    canonicalPath: "/studio",
    noindex: true,
    active: "join",
    extraHead: `<link rel="stylesheet" href="${o}/shop.css">\n<link rel="stylesheet" href="${o}/studio.css">`,
    bodyHtml: `<div id="bz-studio" class="bz-st" data-state="boot">
  <div class="bz-st-boot" role="status" aria-live="polite">
    <div class="bz-st-sk bz-st-sk-hero"></div>
    <div class="bz-st-sk-row"><div class="bz-st-sk"></div><div class="bz-st-sk"></div><div class="bz-st-sk"></div></div>
    <div class="bz-st-sk-tiles"><div class="bz-st-sk"></div><div class="bz-st-sk"></div><div class="bz-st-sk"></div><div class="bz-st-sk"></div></div>
    <noscript><p class="bz-st-note">Studio needs JavaScript. Please turn it on and reload this page.</p></noscript>
  </div>
</div>
<div class="lp-root lp-embed bz-st-host" id="bz-st-host" aria-live="polite"></div>`,
    scripts: ["/tiers-ui.js", "/plans-ui.js", "/boost-ui.js", "/studio-ui.js", "/brands.js", "/studio-app.js"]
  });
}

