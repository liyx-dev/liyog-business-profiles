// =====================================================================
// BIZIPLEX — src/lib/brand-seo.js
// Gives every brand page (/b/{slug}) a real, search-engine-ready document BEFORE any JavaScript runs:
//   * a rich title + description built from the brand's own details and location
//   * LocalBusiness structured data (name, address, phone, rating, socials, what they offer)
//   * a readable snapshot (name, story, location, top listings, links) that the live page replaces on load
// It only ever improves the HTML it is given. If anything fails, the original page is returned untouched.
// =====================================================================
import * as reviews from "./reviews.js";

const CATEGORY_LABELS = {
  retail: "Retail & Shops", fashion: "Fashion & Apparel", food: "Food & Restaurants", beauty: "Beauty & Personal Care",
  electronics: "Electronics & Gadgets", services: "Professional Services", health: "Health & Wellness", education: "Education & Training",
  automotive: "Automotive", real_estate: "Real Estate", agriculture: "Agriculture", events: "Events & Entertainment",
  logistics: "Logistics & Delivery", other: "Local Business"
};
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const plain = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const clip = (t, n) => { const s = String(t || "").trim(); return s.length > n ? s.slice(0, n - 1).trim() + "…" : s; };
const num = (...v) => { for (const x of v) { const n = Number(x); if (x != null && x !== "" && isFinite(n)) return n; } return 0; };

export function readReviewStats(s) {
  s = s || {};
  return {
    avg: num(s.average_rating, s.avg_rating, s.average, s.rating_avg, s.avg),
    count: num(s.review_count, s.total_reviews, s.reviews_count, s.rating_count, s.count, s.total),
    likes: num(s.like_count, s.likes, s.reaction_likes, s.total_likes, s.likes_count),
    dislikes: num(s.dislike_count, s.dislikes, s.reaction_dislikes, s.total_dislikes)
  };
}

export async function brandSeoEnhance(html, env, url, slug) {
  try {
    if (typeof html !== "string") return html;
    const { results: rows } = await env.DB.prepare("SELECT * FROM profiles WHERE slug = ? AND is_active = 1 AND moderation_status = 'approved'").bind(String(slug).toLowerCase()).all();
    const p = rows[0];
    if (!p) return html;
    const o = url.origin;
    const pageUrl = `${o}/b/${encodeURIComponent(p.slug)}`;
    const cat = CATEGORY_LABELS[p.business_category] || "Local Business";
    const city = [p.store_city, p.store_country].filter(Boolean).join(", ");

    let st = { avg: 0, count: 0, likes: 0, dislikes: 0 };
    try { st = readReviewStats(await reviews.getStats(env, p.id)); } catch (e) { /* ratings are optional */ }

    const q = async (sql, ...b) => { try { return (await env.DB.prepare(sql).bind(...b).all()).results; } catch (e) { return []; } };
    const items = (await q("SELECT name, slug, price_display, price_minor, currency, kind, image_url, description FROM products WHERE profile_id = ? AND is_active = 1 AND is_draft = 0 AND slug IS NOT NULL ORDER BY view_count DESC, created_at DESC LIMIT 12", p.id)).filter((it) => it.slug);
    const cols = await q("SELECT slug, title FROM collections WHERE profile_id = ? AND status = 'live' AND item_count > 0 ORDER BY position ASC LIMIT 8", p.id);

    const story = plain(p.bio_html);
    const title = `${p.business_name} — ${cat}${p.store_city ? ` in ${p.store_city}` : ""} | BiziPlex`;
    const descBase = p.tagline || clip(story, 120) || `${p.business_name} on BiziPlex.`;
    const description = clip(`${descBase}${city ? ` Based in ${city}.` : ""}${items.length ? ` ${items.length}+ products and services.` : ""}`, 158);
    const image = p.cover_url || p.logo_url || "";

    const hasAddress = !!(p.store_address || p.store_city || p.store_country);
    const sameAs = [p.social_facebook, p.social_instagram, p.social_twitter, p.social_tiktok, p.social_youtube, p.social_website].filter((u) => /^https?:\/\//i.test(u || ""));
    const business = {
      "@type": hasAddress ? "LocalBusiness" : "Organization",
      "@id": `${pageUrl}#brand`,
      name: p.business_name,
      url: pageUrl,
      description: clip(story || p.tagline || description, 300) || undefined,
      image: [p.logo_url, p.cover_url].filter(Boolean),
      logo: p.logo_url || undefined,
      telephone: p.phone_number ? `+${String(p.phone_number).replace(/[^\d]/g, "")}` : undefined,
      address: hasAddress ? { "@type": "PostalAddress", streetAddress: p.store_address || undefined, addressLocality: p.store_city || undefined, addressCountry: p.store_country || undefined } : undefined,
      hasMap: p.map_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.map_address)}` : undefined,
      foundingDate: p.created_at ? String(p.created_at).slice(0, 10) : undefined,
      knowsAbout: cat,
      sameAs: sameAs.length ? sameAs : undefined,
      aggregateRating: st.count > 0 && st.avg > 0 ? { "@type": "AggregateRating", ratingValue: Math.round(st.avg * 10) / 10, reviewCount: st.count, bestRating: 5, worstRating: 1 } : undefined,
      hasOfferCatalog: items.length ? {
        "@type": "OfferCatalog", name: `${p.business_name} — products and services`,
        itemListElement: items.map((it) => ({
          "@type": "Offer", url: `${o}/product/${encodeURIComponent(it.slug)}/${encodeURIComponent(p.slug)}`,
          itemOffered: { "@type": it.kind === "service" ? "Service" : "Product", name: it.name, image: it.image_url || undefined, description: it.description ? clip(it.description, 160) : undefined }
        }))
      } : undefined
    };
    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        business,
        { "@type": "ProfilePage", url: pageUrl, name: title, mainEntity: { "@id": `${pageUrl}#brand` } },
        { "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: "BiziPlex", item: o },
          { "@type": "ListItem", position: 2, name: cat, item: `${o}/explore` },
          { "@type": "ListItem", position: 3, name: p.business_name, item: pageUrl }
        ] }
      ]
    };

    let out = html;
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
    out = out.replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${esc(description)}">`);
    out = out.replace(/<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${esc(title)}">`);
    out = out.replace(/<meta\s+property="og:description"[^>]*>/i, `<meta property="og:description" content="${esc(description)}">`);
    const extras = [];
    if (!/name="robots"/i.test(out)) extras.push(`<meta name="robots" content="index, follow, max-image-preview:large">`);
    if (!/property="og:type"/i.test(out)) extras.push(`<meta property="og:type" content="business.business">`);
    if (!/property="og:site_name"/i.test(out)) extras.push(`<meta property="og:site_name" content="BiziPlex">`);
    if (!/name="twitter:card"/i.test(out)) extras.push(`<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}">${image ? `<meta name="twitter:image" content="${esc(image)}">` : ""}`);
    if (image && !/property="og:image"/i.test(out)) extras.push(`<meta property="og:image" content="${esc(image)}">`);
    if (hasAddress) extras.push(`<meta name="geo.placename" content="${esc(city)}">`);
    extras.push(`<script type="application/ld+json">${jsonForScript(ld)}</script>`);
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, extras.join("\n") + "\n</head>") : extras.join("\n") + out;

    const money = (it) => it.price_display ? ` — ${esc(it.price_display)}` : "";
    const snapshot = `<div id="bz-seo-snapshot" class="bz-seo-snapshot" style="max-width:720px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif">
<h1>${esc(p.business_name)}</h1>
${p.tagline ? `<p>${esc(p.tagline)}</p>` : ""}
<p>${esc(cat)}${city ? ` · ${esc(city)}` : ""}${st.count ? ` · Rated ${Math.round(st.avg * 10) / 10}/5 from ${st.count} review${st.count === 1 ? "" : "s"}` : ""}</p>
${story ? `<p>${esc(clip(story, 700))}</p>` : ""}
${p.store_address ? `<p>Address: ${esc([p.store_address, p.store_city, p.store_country].filter(Boolean).join(", "))}</p>` : ""}
${items.length ? `<h2>Products and services</h2><ul>${items.map((it) => `<li><a href="/product/${encodeURIComponent(it.slug)}/${encodeURIComponent(p.slug)}">${esc(it.name)}</a>${money(it)}</li>`).join("")}</ul>` : ""}
${cols.length ? `<h2>Collections</h2><ul>${cols.map((c) => `<li><a href="/collection/${encodeURIComponent(p.slug)}/${encodeURIComponent(c.slug)}">${esc(c.title)}</a></li>`).join("")}</ul>` : ""}
<p><a href="/products/${encodeURIComponent(p.slug)}">Browse everything from ${esc(p.business_name)}</a> · <a href="/products/${encodeURIComponent(p.slug)}?view=videos">Videos</a> · <a href="/products/${encodeURIComponent(p.slug)}?view=collections">Collections</a></p>
</div>`;
    const rootRe = /(<div[^>]*id="liyog-profile-root"[^>]*>)(\s*)(<\/div>)/i;
    if (rootRe.test(out)) out = out.replace(rootRe, `$1${snapshot}$3`);
    else out = out.replace(/<\/body>/i, `<noscript>${snapshot}</noscript></body>`);
    return out;
  } catch (e) {
    console.error("brandSeoEnhance failed (page served unchanged):", e);
    return html;
  }
}
