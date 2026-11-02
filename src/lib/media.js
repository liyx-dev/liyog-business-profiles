// =====================================================================
// BIZIPLEX — src/lib/media.js
// YouTube handling. We store ONLY the 11-character video id (never the
// pasted link or any HTML), so nothing a user types can ever become markup.
// Health checks use YouTube's public oEmbed endpoint: no API key, no quota.
// =====================================================================

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidYouTubeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** Accepts watch?v=, youtu.be/, /shorts/, /embed/, /live/ links (or a bare id). Anything else -> null. */
export function extractYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s || s.length > 300) return null;
  if (ID_RE.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else { const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
  }
  return isValidYouTubeId(id) ? id : null;
}

/** ok | broken (deleted / private / embedding disabled) | unknown (could not tell: never flips anything) */
export async function checkYouTube(videoId) {
  if (!isValidYouTubeId(videoId)) return { status: "broken" };
  try {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(`https://www.youtube.com/oembed?url=${target}&format=json`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 200) return { status: "ok" };
    if (res.status === 404 || res.status === 401 || res.status === 403) return { status: "broken" };
    return { status: "unknown" };
  } catch (e) {
    return { status: "unknown" };
  }
}

/** Nightly: re-check a small, oldest-first batch so a deleted video never sits broken for long. */
export async function runVideoChecks(env, limit = 25) {
  const { results } = await env.DB.prepare(
    `SELECT id, video_id FROM products
     WHERE video_id IS NOT NULL AND video_id != '' AND is_active = 1
       AND (video_status IN ('unknown','suspect') OR video_checked_at IS NULL OR video_checked_at < datetime('now','-7 days'))
     ORDER BY video_checked_at IS NULL DESC, video_checked_at ASC LIMIT ?`
  ).bind(limit).all();
  let checked = 0;
  for (const row of results) {
    const { status } = await checkYouTube(row.video_id);
    if (status === "unknown") continue;
    await env.DB.prepare("UPDATE products SET video_status = ?, video_checked_at = datetime('now') WHERE id = ?").bind(status, row.id).run();
    checked++;
  }
  return { checked, candidates: results.length };
}
