// =====================================================================
// LIYOG WORLD — src/lib/richtext.js
// A small, custom formatting engine built specifically for this
// platform. Users write using simple inline markers; this module is
// the ONLY thing that turns those markers into HTML — the HTML it
// produces is always from a fixed, safe set of tags. Raw HTML typed
// by a user is never trusted or rendered; it's escaped as plain text.
//
// Supported syntax:
//   *bold text*
//   _italic text_
//   ~underlined text~
//   {{red:text}} {{green:text}} {{blue:text}} {{gold:text}}   (brand colors only)
//   [link text](https://example.com)                          (URLs only, no javascript:)
//   Line breaks become <br>
// =====================================================================

const ALLOWED_COLORS = {
  red: "#FF3B30",
  green: "#28A428",
  blue: "#1877F2",
  gold: "#FFD700",
  black: "#111111"
};

const MAX_INPUT_LENGTH = 3000;
const MAX_LINK_LENGTH = 300;

/**
 * Escapes any raw HTML in the input FIRST, before applying any
 * formatting. This is the core safety guarantee: whatever the user
 * typed as literal "<script>" becomes the literal text "<script>" on
 * the page, never an executable tag — formatting markers are applied
 * on top of already-escaped text, so there's no way for a crafted
 * input to smuggle real HTML through.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parses the constrained syntax into safe HTML. This is the single
 * entry point — call this on any user-submitted bio text before
 * storing it, and the stored value is always render-safe.
 */
export function parseRichText(rawInput) {
  if (!rawInput || typeof rawInput !== "string") return "";

  const trimmed = rawInput.slice(0, MAX_INPUT_LENGTH);
  let safe = escapeHtml(trimmed);

  // Links: [text](url) — only http/https URLs allowed, anything else
  // (javascript:, data:, etc.) is rejected and rendered as plain text
  // instead of a link, closing off the classic XSS-via-href vector.
  const linkPattern = new RegExp(`\\[([^\\]]{1,100})\\]\\(([^)]{1,${MAX_LINK_LENGTH}})\\)`, "g");
  safe = safe.replace(linkPattern, (match, text, url) => {
    const cleanUrl = url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) return escapeHtml(match);
    return `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold: *text*
  safe = safe.replace(/\*([^*\n]{1,200})\*/g, "<strong>$1</strong>");

  // Italic: _text_
  safe = safe.replace(/_([^_\n]{1,200})_/g, "<em>$1</em>");

  // Underline: ~text~
  safe = safe.replace(/~([^~\n]{1,200})~/g, "<u>$1</u>");

  // Colors: {{colorname:text}} — only from the fixed palette, anything
  // else is left as literal escaped text rather than guessing intent.
  safe = safe.replace(/\{\{(red|green|blue|gold|black):([^}]{1,200})\}\}/g, (match, colorName, text) => {
    const hex = ALLOWED_COLORS[colorName];
    return `<span style="color:${hex}">${text}</span>`;
  });

  // Line breaks last, so they don't interfere with multi-line matching above.
  safe = safe.replace(/\n/g, "<br>");

  return safe;
}

/**
 * Strips all formatting markers and returns plain text — used for
 * character counting in the UI (so "*bold*" counts as 4 visible
 * characters, not 6) and for search/preview snippets.
 */
export function stripRichTextSyntax(rawInput) {
  if (!rawInput) return "";
  return rawInput
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~([^~\n]+)~/g, "$1")
    .replace(/\{\{(?:red|green|blue|gold|black):([^}]+)\}\}/g, "$1");
}

export const RICHTEXT_MAX_LENGTH = MAX_INPUT_LENGTH;
export const RICHTEXT_ALLOWED_COLORS = Object.keys(ALLOWED_COLORS);
