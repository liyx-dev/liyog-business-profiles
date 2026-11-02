// =====================================================================
// BIZIPLEX — src/lib/shop-render.js
// The ONE place cards and shared widgets are turned into HTML. Pages,
// catalogue paging, profile rows and "more from this collection" all use
// these functions, so there is a single source of truth and every value
// is escaped here, once.
// =====================================================================
import { formatMoney } from "./money.js";
import { isValidYouTubeId } from "./media.js";

export function esc(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** http(s) URL with no characters that could break out of an attribute or url(...) */
export function safeImgUrl(u) {
  const s = String(u || "");
  return /^https?:\/\/[^\s"'()<>\\]+$/.test(s) ? s : "";
}

export function toCard(row) {
  return {
    id: row.id, slug: row.slug || "", name: row.name || "", kind: row.kind === "service" ? "service" : "product",
    desc: row.description || "", price_minor: row.price_minor == null ? null : Number(row.price_minor),
    currency: row.currency || "", price_type: row.price_type || "fixed", price_display: row.price_display || "",
    image_url: row.image_url || "", w: row.img_w || null, h: row.img_h || null,
    color: /^#[0-9a-fA-F]{6}$/.test(row.img_color || "") ? row.img_color : "",
    video: isValidYouTubeId(row.video_id) && row.video_status !== "broken" ? row.video_id : "",
    rating: Number(row.avg_rating) || 0, rating_count: Number(row.rating_count) || 0,
    likes: Number(row.like_count) || 0, views: Number(row.view_count) || 0, featured: !!row.featured
  };
}

/** Square-friendly photos fill the frame; flyers and unusual shapes are shown whole over a soft blurred backdrop. */
export function fitMode(card) {
  if (card.kind === "service") return "contain";
  if (card.w && card.h) { const r = card.w / card.h; if (r < 0.72 || r > 1.4) return "contain"; }
  return "cover";
}

export function productUrl(card, brandSlug) {
  return `/product/${encodeURIComponent(card.slug || card.id)}/${encodeURIComponent(brandSlug)}`;
}

export function priceInner(card) {
  if (card.price_minor === 0) return "Free";
  if (card.price_minor != null && card.price_type !== "contact" && card.currency) {
    return (card.price_type === "from" ? "From " : "") + formatMoney(card.price_minor, card.currency);
  }
  if (card.price_display) return esc(card.price_display);
  return "Contact for price";
}

export function priceHtml(card, extraClass = "") {
  const fx = card.price_minor > 0 && card.price_type !== "contact" && card.currency;
  const attrs = fx ? ` data-minor="${card.price_minor}" data-cur="${esc(card.currency)}"${card.price_type === "from" ? ' data-from="1"' : ""}` : "";
  return `<div class="bz-price ${extraClass}"${attrs}>${fx ? esc(priceInner(card)) : priceInner(card)}</div>`;
}

const ICON_PLAY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_STAR = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-.7z"/></svg>';
const ICON_WA = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0012.04 2z"/></svg>';

export function waLink(brand, card, origin = "") {
  const digits = String(brand.whatsapp_number || "").replace(/\D/g, "");
  if (!/^\d{7,15}$/.test(digits)) return "";
  const text = `Hi ${brand.business_name}, I'm interested in "${card.name}" ${origin}${productUrl(card, brand.slug)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function mediaHtml(card, brandSlug, { eager = false, link = true } = {}) {
  const fit = fitMode(card);
  const bg = safeImgUrl(card.image_url);
  const style = [card.color ? `--bz-c:${card.color}` : "", fit === "contain" && bg ? `--bz-bg:url(&quot;${esc(bg)}&quot;)` : ""].filter(Boolean).join(";");
  const dims = card.w && card.h ? ` width="${card.w}" height="${card.h}"` : "";
  const img = bg ? `<img src="${esc(bg)}" alt="${esc(card.name)}"${dims} ${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async" data-fallback="true">` : '<span class="bz-media-empty" aria-hidden="true"></span>';
  const badges =
    (card.featured ? `<span class="bz-badge bz-badge-featured">${ICON_STAR}Featured</span>` : "") +
    (card.kind === "service" ? '<span class="bz-badge bz-badge-service">Service</span>' : "") +
    (card.video ? `<span class="bz-badge bz-badge-video" title="Has video">${ICON_PLAY}</span>` : "");
  const inner = `${img}${badges}`;
  return link
    ? `<a class="bz-media bz-fit-${fit}" href="${productUrl(card, brandSlug)}" style="${style}" tabindex="-1" aria-hidden="true">${inner}</a>`
    : `<div class="bz-media bz-fit-${fit}" style="${style}">${inner}</div>`;
}

export function cardHtml(card, brand, { eager = false, origin = "" } = {}) {
  const href = productUrl(card, brand.slug);
  const wa = waLink(brand, card, origin);
  const rating = card.rating_count > 0
    ? `<span class="bz-rate">${ICON_STAR}${card.rating.toFixed(1)}<i>(${card.rating_count})</i></span>`
    : '<span class="bz-rate bz-rate-new">New</span>';
  return `<article class="bz-card" data-id="${esc(card.id)}">
  ${mediaHtml(card, brand.slug, { eager })}
  <div class="bz-card-body">
    <h3 class="bz-card-name"><a href="${href}">${esc(card.name)}</a></h3>
    ${priceHtml(card)}
    <div class="bz-card-foot">${rating}${wa ? `<a class="bz-card-wa" href="${esc(wa)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Message about ${esc(card.name)} on WhatsApp">${ICON_WA}</a>` : ""}</div>
  </div>
</article>`;
}

export function cardsHtml(rows, brand, opts = {}) {
  return rows.map((r, i) => cardHtml(toCard(r), brand, { ...opts, eager: opts.eagerFirst && i < 2 })).join("");
}

export function chipsHtml(collections, activeSlug) {
  const all = `<button type="button" class="bz-chip${activeSlug ? "" : " is-active"}" data-c="">All</button>`;
  return all + collections.map((c) =>
    `<button type="button" class="bz-chip${c.slug === activeSlug ? " is-active" : ""}" data-c="${esc(c.slug)}">${esc(c.title)}<i>${c.item_count}</i></button>`
  ).join("");
}

export function youtubeFacadeHtml(videoId, title) {
  if (!isValidYouTubeId(videoId)) return "";
  return `<div class="bz-video" data-yt="${esc(videoId)}">
  <button type="button" class="bz-video-play" aria-label="Play video${title ? ": " + esc(title) : ""}">
    <img class="bz-video-poster" src="https://i.ytimg.com/vi/${esc(videoId)}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer">
    <span class="bz-video-btn"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
  </button>
</div>`;
}

export function safetyNoteHtml(compact = false) {
  return `<div class="bz-safe${compact ? " bz-safe-compact" : ""}" role="note">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>
  <p><strong>Stay safe.</strong> BiziPlex connects you with sellers but does not control chats or payments that happen outside our platform. Verify the seller, inspect before you pay, and avoid sending advance payments to people you haven't verified.</p>
</div>`;
}

// ---- Engagement bar + LiyX card: byte-for-byte the markup profile.js already wires ----
function formatCompact(n) { const x = Number(n) || 0; return x < 1000 ? String(x) : x < 1e6 ? (x / 1000).toFixed(x % 1000 >= 100 ? 1 : 0) + "k" : (x / 1e6).toFixed(1) + "m"; }
function starSvg(pct, size) {
  const id = `ps-${Math.random().toString(36).slice(2, 9)}`;
  const w = (Math.max(0, Math.min(100, pct)) / 100) * 24;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" class="lp-pstar-svg"><defs><clipPath id="${id}"><rect x="0" y="0" width="${w}" height="24"/></clipPath></defs><path class="lp-pstar-bg" d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-.7z"/><path class="lp-pstar-fill" clip-path="url(#${id})" d="M12 2.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-.7z"/></svg>`;
}
export function engagementBarHtml(prod, stats) {
  const views = stats.view_count ?? prod.view_count ?? 0;
  const avg = stats.average_rating || 0, rc = stats.rating_count || 0, lc = stats.like_count || 0;
  const json = esc(JSON.stringify({ id: prod.id, name: prod.name, slug: prod.slug, price_display: prod.price_display || "", image_url: prod.image_url || "" }));
  return `<div class="lp-engbar lp-engbar-feed" data-product-id="${esc(prod.id)}" data-product-json="${json}">
  <div class="lp-engbar-row-top">
    <span class="lp-engbar-item lp-engbar-views" title="Views"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg><span>${formatCompact(views)}</span></span>
    <button type="button" class="lp-engbar-item lp-engbar-rate lp-engbar-invite-tap" data-action="rate" aria-label="Rate this">${starSvg(avg ? 100 : 0, 20)}<span>${avg ? avg.toFixed(1) : ""}${rc ? ` (${rc})` : ""}</span></button>
  </div>
  <div class="lp-engbar-row-like">
    <button type="button" class="lp-engbar-item lp-engbar-like lp-engbar-invite-tap" data-action="like" aria-label="Like this"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lp-like-hand-svg"><path d="M12 21s-6.7-4.35-9.3-8.2C1.1 10.5 1.6 7.4 4 5.9c2.1-1.3 4.7-.7 6.2 1.1L12 9l1.8-2c1.5-1.8 4.1-2.4 6.2-1.1 2.4 1.5 2.9 4.6 1.3 6.9C18.7 16.65 12 21 12 21z"/></svg><span>${formatCompact(lc)}</span></button>
  </div>
</div>`;
}
const LIYX = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 100 100" class="lp-liyx-logo-svg" role="img" aria-label="LiyX AI"><defs><radialGradient id="liyxSphereGradient" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#FFF6D6"/><stop offset="45%" stop-color="#FFC24B"/><stop offset="100%" stop-color="#E8590C"/></radialGradient></defs><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(-20 50 50)"/><ellipse cx="50" cy="50" rx="44" ry="17" fill="none" stroke="#F5A623" stroke-width="2.2" transform="rotate(20 50 50)"/><g fill="none" stroke="#1E7A32" stroke-width="1.6" stroke-linejoin="round"><polygon points="50,10 68,18 78,32 78,50 68,68 50,78 32,68 22,50 22,32 32,18"/><polygon points="50,22 61,27 68,36 68,50 61,61 50,66 39,61 32,50 32,36 39,27"/></g><circle cx="50" cy="50" r="15" fill="url(#liyxSphereGradient)"/></svg>`;
export function catalogueInsightHtml(insight) {
  const kw = Array.isArray(insight.top_keywords) ? insight.top_keywords : [];
  const flags = Array.isArray(insight.flags) ? insight.flags : [];
  return `<div class="lp-liyx-insight lp-catalogue-insight bz-span-all">
  <div class="lp-liyx-badge">${LIYX(15)}<span>LiyX AI — Catalogue Insight</span></div>
  <p class="lp-liyx-summary">${esc(insight.summary_text)}</p>
  <div class="lp-catalogue-insight-stats">
    <div class="lp-catalogue-stat"><strong>${formatCompact(insight.total_views || 0)}</strong><span>Views</span></div>
    <div class="lp-catalogue-stat"><strong>${formatCompact(insight.total_likes || 0)}</strong><span>Likes</span></div>
    <div class="lp-catalogue-stat"><strong>${formatCompact(insight.total_ratings || 0)}</strong><span>Ratings</span></div>
    <div class="lp-catalogue-stat"><strong>${insight.average_rating ? insight.average_rating.toFixed(1) : "—"}</strong><span>Avg ★</span></div>
  </div>
  ${flags.length ? `<div class="lp-catalogue-flags">${flags.map((f) => `<span class="lp-catalogue-flag">${esc(f)}</span>`).join("")}</div>` : ""}
  ${kw.length ? `<div class="lp-liyx-keywords">${kw.slice(0, 5).map((k) => `<span class="lp-liyx-keyword">${esc(k)}</span>`).join("")}</div>` : ""}
</div>`;
}
