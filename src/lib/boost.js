// =====================================================================
// LIYOG WORLD — src/lib/boost.js   (3a fix release)
// Boost status checks + checkout + activation + fair-rotation selection.
//
// WHAT CHANGED IN THIS RELEASE (everything else is untouched):
//  1. Targeting now works for EVERY country (full ISO list), not only
//     the 4 Paystack pricing countries. Pricing is still resolved with
//     the Paystack list (resolveCountry) — targeting is a separate thing.
//  2. The advertiser's "own" country / category are derived on the
//     SERVER from the profile row (store_country, then the country at
//     the end of map_address / store_address). The browser now only
//     sends intent ("own" | "all" + show_cta) — never lists of values.
//     Legacy clients that still send target_countries / target_categories
//     keep working (validated against the real allowlists).
//  3. No country on the profile  -> defaults to ALL + a note.
//     No category on the profile -> defaults to ALL + a note.
//     Nothing here can throw because of missing profile data.
//  4. show_cta is only stored as 1 if the profile really has a WhatsApp
//     or phone number.
//  5. Every checkout returns a RECAP built from exactly what was stored
//     (manual purchases show it + put it in the WhatsApp message).
//  6. New: GET /api/boost/recap?ref=... (owner-only) for the
//     post-payment recap; callback redirect now carries boost_ref.
//  7. GET /api/boost/pricing?profile_id=... additionally returns the
//     targeting defaults in the SAME request (no extra round trip).
//  8. handleActiveBoosts additionally returns the stored targeting.
//  selectBoostedItems (rotation engine) is NOT touched — that is 3b.
// =====================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// Pricing currencies — UNCHANGED. Only used to decide which price row
// a visitor sees / is charged. Targeting no longer depends on this.
const PAYSTACK_COUNTRIES = { NG: "NGN", GH: "GHS", ZA: "ZAR", KE: "KES" };

function resolveCountry(request) {
  const detected = request.cf && request.cf.country;
  if (detected && PAYSTACK_COUNTRIES[detected]) return detected;
  return "USD";
}

// ---------------------------------------------------------------------
// Country registry (ISO 3166-1 alpha-2) — used ONLY for targeting.
// Any country a user types on their profile can be recognised, so a
// brand from Europe / America / Canada etc. can target its own country.
// ---------------------------------------------------------------------
const COUNTRY_DATA =
  "AF:Afghanistan|AL:Albania|DZ:Algeria|AS:American Samoa|AD:Andorra|AO:Angola|AI:Anguilla|AG:Antigua and Barbuda|AR:Argentina|AM:Armenia|AW:Aruba|AU:Australia|AT:Austria|AZ:Azerbaijan|" +
  "BS:Bahamas|BH:Bahrain|BD:Bangladesh|BB:Barbados|BY:Belarus|BE:Belgium|BZ:Belize|BJ:Benin|BM:Bermuda|BT:Bhutan|BO:Bolivia|BA:Bosnia and Herzegovina|BW:Botswana|BR:Brazil|BN:Brunei|BG:Bulgaria|BF:Burkina Faso|BI:Burundi|" +
  "CV:Cabo Verde|KH:Cambodia|CM:Cameroon|CA:Canada|KY:Cayman Islands|CF:Central African Republic|TD:Chad|CL:Chile|CN:China|CO:Colombia|KM:Comoros|CG:Congo|CD:DR Congo|CK:Cook Islands|CR:Costa Rica|CI:Côte d'Ivoire|HR:Croatia|CU:Cuba|CW:Curaçao|CY:Cyprus|CZ:Czechia|" +
  "DK:Denmark|DJ:Djibouti|DM:Dominica|DO:Dominican Republic|EC:Ecuador|EG:Egypt|SV:El Salvador|GQ:Equatorial Guinea|ER:Eritrea|EE:Estonia|SZ:Eswatini|ET:Ethiopia|FK:Falkland Islands|FO:Faroe Islands|FJ:Fiji|FI:Finland|FR:France|GF:French Guiana|PF:French Polynesia|" +
  "GA:Gabon|GM:Gambia|GE:Georgia|DE:Germany|GH:Ghana|GI:Gibraltar|GR:Greece|GL:Greenland|GD:Grenada|GP:Guadeloupe|GU:Guam|GT:Guatemala|GG:Guernsey|GN:Guinea|GW:Guinea-Bissau|GY:Guyana|HT:Haiti|HN:Honduras|HK:Hong Kong|HU:Hungary|" +
  "IS:Iceland|IN:India|ID:Indonesia|IR:Iran|IQ:Iraq|IE:Ireland|IM:Isle of Man|IL:Israel|IT:Italy|JM:Jamaica|JP:Japan|JE:Jersey|JO:Jordan|KZ:Kazakhstan|KE:Kenya|KI:Kiribati|XK:Kosovo|KW:Kuwait|KG:Kyrgyzstan|" +
  "LA:Laos|LV:Latvia|LB:Lebanon|LS:Lesotho|LR:Liberia|LY:Libya|LI:Liechtenstein|LT:Lithuania|LU:Luxembourg|MO:Macao|MG:Madagascar|MW:Malawi|MY:Malaysia|MV:Maldives|ML:Mali|MT:Malta|MH:Marshall Islands|MQ:Martinique|MR:Mauritania|MU:Mauritius|YT:Mayotte|MX:Mexico|FM:Micronesia|MD:Moldova|MC:Monaco|MN:Mongolia|ME:Montenegro|MS:Montserrat|MA:Morocco|MZ:Mozambique|MM:Myanmar|" +
  "NA:Namibia|NR:Nauru|NP:Nepal|NL:Netherlands|NC:New Caledonia|NZ:New Zealand|NI:Nicaragua|NE:Niger|NG:Nigeria|NU:Niue|KP:North Korea|MK:North Macedonia|MP:Northern Mariana Islands|NO:Norway|OM:Oman|" +
  "PK:Pakistan|PW:Palau|PS:Palestine|PA:Panama|PG:Papua New Guinea|PY:Paraguay|PE:Peru|PH:Philippines|PL:Poland|PT:Portugal|PR:Puerto Rico|QA:Qatar|RE:Réunion|RO:Romania|RU:Russia|RW:Rwanda|" +
  "BL:Saint Barthélemy|SH:Saint Helena|KN:Saint Kitts and Nevis|LC:Saint Lucia|MF:Saint Martin|PM:Saint Pierre and Miquelon|VC:Saint Vincent and the Grenadines|WS:Samoa|SM:San Marino|ST:São Tomé and Príncipe|SA:Saudi Arabia|SN:Senegal|RS:Serbia|SC:Seychelles|SL:Sierra Leone|SG:Singapore|SX:Sint Maarten|SK:Slovakia|SI:Slovenia|SB:Solomon Islands|SO:Somalia|ZA:South Africa|KR:South Korea|SS:South Sudan|ES:Spain|LK:Sri Lanka|SD:Sudan|SR:Suriname|SE:Sweden|CH:Switzerland|SY:Syria|" +
  "TW:Taiwan|TJ:Tajikistan|TZ:Tanzania|TH:Thailand|TL:Timor-Leste|TG:Togo|TK:Tokelau|TO:Tonga|TT:Trinidad and Tobago|TN:Tunisia|TR:Türkiye|TM:Turkmenistan|TC:Turks and Caicos Islands|TV:Tuvalu|" +
  "UG:Uganda|UA:Ukraine|AE:United Arab Emirates|GB:United Kingdom|US:United States|UY:Uruguay|UZ:Uzbekistan|VU:Vanuatu|VA:Vatican City|VE:Venezuela|VN:Vietnam|VG:British Virgin Islands|VI:U.S. Virgin Islands|WF:Wallis and Futuna|EH:Western Sahara|YE:Yemen|ZM:Zambia|ZW:Zimbabwe";

// Common alternative spellings people type into a "Country" field.
const COUNTRY_ALIASES = {
  "usa": "US", "us": "US", "united states of america": "US", "america": "US", "the united states": "US",
  "uk": "GB", "great britain": "GB", "britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB", "the united kingdom": "GB",
  "uae": "AE", "emirates": "AE", "the uae": "AE",
  "ivory coast": "CI", "cote d ivoire": "CI",
  "drc": "CD", "democratic republic of the congo": "CD", "democratic republic of congo": "CD", "congo kinshasa": "CD", "congo dr": "CD",
  "republic of the congo": "CG", "congo brazzaville": "CG",
  "korea": "KR", "republic of korea": "KR",
  "russian federation": "RU",
  "turkey": "TR",
  "czech republic": "CZ",
  "swaziland": "SZ",
  "cape verde": "CV",
  "burma": "MM",
  "viet nam": "VN",
  "macedonia": "MK",
  "the gambia": "GM",
  "the bahamas": "BS",
  "holland": "NL", "the netherlands": "NL",
  "east timor": "TL",
  "lao pdr": "LA",
  "macau": "MO",
  "st lucia": "LC", "st kitts and nevis": "KN",
  "south korea republic": "KR",
  "vatican": "VA", "holy see": "VA",
  "palestinian territories": "PS",
  "republic of ireland": "IE",
  "federated states of micronesia": "FM"
};

function normalizeCountryText(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'’`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const COUNTRY_NAMES = {};          // "NG" -> "Nigeria"
const COUNTRY_NAME_TO_CODE = {};   // "nigeria" -> "NG"
(function initCountryRegistry() {
  COUNTRY_DATA.split("|").forEach((pair) => {
    const idx = pair.indexOf(":");
    const code = pair.slice(0, idx);
    const name = pair.slice(idx + 1);
    COUNTRY_NAMES[code] = name;
    COUNTRY_NAME_TO_CODE[normalizeCountryText(name)] = code;
  });
  Object.keys(COUNTRY_ALIASES).forEach((alias) => {
    COUNTRY_NAME_TO_CODE[normalizeCountryText(alias)] = COUNTRY_ALIASES[alias];
  });
})();

/** Text -> ISO code, or null. allowCode lets "NG"/"CA" style codes through. */
function lookupCountryCode(text, allowCode) {
  const n = normalizeCountryText(text);
  if (!n) return null;
  if (allowCode && /^[a-z]{2}$/.test(n)) {
    const up = n.toUpperCase();
    if (COUNTRY_NAMES[up]) return up;
  }
  if (COUNTRY_NAME_TO_CODE[n]) return COUNTRY_NAME_TO_CODE[n];
  // "Lagos Nigeria" style (no comma): try the last 1-3 words.
  const words = n.split(" ");
  for (let take = Math.min(3, words.length); take >= 1; take--) {
    const candidate = words.slice(-take).join(" ");
    if (COUNTRY_NAME_TO_CODE[candidate]) return COUNTRY_NAME_TO_CODE[candidate];
  }
  return null;
}

/**
 * Works out the advertiser's own country from data ALREADY on the
 * profile row (no extra lookups, no geo-IP guess):
 *   1. store_country (free text or a 2-letter code)
 *   2. the last comma-segment of map_address (e.g. "Onitsha, Anambra, Nigeria")
 *   3. the last comma-segment of store_address
 * Returns { code, name, source } or null. Never throws.
 */
export function resolveProfileCountry(row) {
  try {
    if (!row) return null;
    if (row.store_country) {
      const code = lookupCountryCode(row.store_country, true);
      if (code) return { code, name: COUNTRY_NAMES[code], source: "store_country" };
    }
    const fallbacks = [["map_address", row.map_address], ["store_address", row.store_address]];
    for (const [source, value] of fallbacks) {
      if (!value) continue;
      const parts = String(value).split(",");
      const last = parts[parts.length - 1];
      const code = lookupCountryCode(last, false);
      if (code) return { code, name: COUNTRY_NAMES[code], source };
    }
  } catch (e) { /* never let a weird profile value break boosting */ }
  return null;
}

function prettifySlug(slug) {
  return String(slug || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ctaChannelsFor(row) {
  const channels = [];
  if (row && row.whatsapp_number) channels.push("whatsapp");
  if (row && row.phone_number) channels.push("call");
  return channels;
}

const NOTE_NO_COUNTRY = "We couldn't find a country on your profile, so this boost will show to all countries. To show it only in your own country, update the Country field on your profile.";
const NOTE_NO_CATEGORY = "We couldn't find a category on your profile, so this boost will show in all categories.";
const NOTE_NO_CTA = "Your profile has no WhatsApp or phone number yet, so contact buttons can't be shown on your sponsored cards.";

/** Own-country / own-category / contact info derived from the profile row. */
async function getOwnTargetingDefaults(env, row) {
  const country = resolveProfileCountry(row);

  let category = null;
  if (row && row.business_category) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT slug, label FROM business_categories WHERE slug = ? AND is_allowed = 1"
      ).bind(row.business_category).all();
      if (results.length) category = { slug: results[0].slug, label: results[0].label };
    } catch (e) {
      // Categories table unavailable: trust the slug already on the live profile.
      category = { slug: row.business_category, label: prettifySlug(row.business_category) };
    }
  }

  const channels = ctaChannelsFor(row);
  return {
    country,
    category,
    ctaChannels: channels,
    ctaAvailable: channels.length > 0,
    countryNote: country ? null : NOTE_NO_COUNTRY,
    categoryNote: category ? null : NOTE_NO_CATEGORY,
    ctaNote: channels.length ? null : NOTE_NO_CTA
  };
}

async function getTargetingInfoForProfile(env, profileId) {
  const { results } = await env.DB.prepare(
    "SELECT id, business_category, store_country, store_address, map_address, whatsapp_number, phone_number FROM profiles WHERE id = ?"
  ).bind(profileId).all();
  if (!results.length) return null;
  const own = await getOwnTargetingDefaults(env, results[0]);
  return {
    ownCountry: own.country ? { code: own.country.code, name: own.country.name } : null,
    countryNote: own.countryNote,
    ownCategory: own.category,
    categoryNote: own.categoryNote,
    ctaAvailable: own.ctaAvailable,
    ctaChannels: own.ctaChannels,
    ctaNote: own.ctaNote
  };
}

/**
 * GET /api/boost/pricing — public. Returns durations priced for the
 * visitor's detected country, filtered to only the tier_group(s)
 * currently unlocked for public use (app_settings.boost_tiers_unlocked).
 * NEW: optional ?profile_id= also returns `targeting` (the advertiser's
 * own country/category defaults) so the sheet needs only ONE request.
 */
export async function handleGetBoostPricing(request, env) {
  const countryCode = resolveCountry(request);
  const unlockedGroups = await getUnlockedTierGroups(env);

  const { results } = await env.DB.prepare(
    "SELECT * FROM boost_pricing WHERE country_code = ? ORDER BY sort_order ASC"
  ).bind(countryCode).all();

  const durations = results.filter((r) => unlockedGroups.includes(r.tier_group));

  let customDuration = null;
  if (durations.length) {
    const longestDays = Math.max(...durations.map((d) => d.hours)) / 24;
    const maxDays = Number(await getSettingLocal(env, "boost_custom_max_days", "90"));
    customDuration = { minDays: longestDays + 1, maxDays };
  }

  let targeting = null;
  const profileId = new URL(request.url).searchParams.get("profile_id");
  if (profileId) {
    try { targeting = await getTargetingInfoForProfile(env, profileId); }
    catch (err) { console.error("Targeting info lookup failed:", err); }
  }

  return jsonResponse({ countryCode, durations, customDuration, targeting });
}

async function getUnlockedTierGroups(env) {
  const raw = await getSettingLocal(env, "boost_tiers_unlocked", "extended");
  if (raw === "all") return ["micro", "standard", "extended"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Custom duration (days-based, only above the longest unlocked tier).
 * UNCHANGED from the previous release.
 */
async function computeCustomBoostPrice(env, durations, customDays) {
  const sorted = [...durations].sort((a, b) => a.hours - b.hours);
  if (!sorted.length) return null;

  const longest = sorted[sorted.length - 1];
  const longestDays = longest.hours / 24;

  const maxDays = Number(await getSettingLocal(env, "boost_custom_max_days", "90"));
  const maxDiscountPct = Number(await getSettingLocal(env, "boost_custom_max_discount_pct", "35"));

  if (customDays <= longestDays) return null;

  const baseRate = longest.amount / longestDays;
  const denominator = Math.max(1, maxDays - longestDays);
  const progress = Math.min(1, (customDays - longestDays) / denominator);
  const discount = (maxDiscountPct / 100) * progress;
  const effectiveRate = baseRate * (1 - discount);

  return {
    amount: Math.ceil(effectiveRate * customDays),
    minDays: longestDays,
    maxDays
  };
}

export async function getActiveBoost(env, profileId, scope = "profile", productId = null) {
  const query = scope === "product"
    ? `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = 'product' AND product_id = ? AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`
    : `SELECT id, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = ? AND product_id IS NULL AND expires_at > datetime('now')
       ORDER BY expires_at DESC LIMIT 1`;

  const binds = scope === "product" ? [profileId, productId] : [profileId, scope];
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return results.length ? results[0] : null;
}

export async function getAllActiveBoosts(env, profileId, scope = "profile", productId = null) {
  const query = scope === "product"
    ? `SELECT id, boosted_at, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = 'product' AND product_id = ? AND expires_at > datetime('now')
       ORDER BY expires_at ASC`
    : `SELECT id, boosted_at, expires_at FROM boost_log
       WHERE profile_id = ? AND scope = ? AND product_id IS NULL AND expires_at > datetime('now')
       ORDER BY expires_at ASC`;

  const binds = scope === "product" ? [profileId, productId] : [profileId, scope];
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return results;
}

export async function handleBoostStatus(env, profileId, productIdsParam) {
  const profileBoost = await getActiveBoost(env, profileId, "profile");
  const catalogueBoost = await getActiveBoost(env, profileId, "catalogue");

  const productStatuses = {};
  if (productIdsParam) {
    const ids = productIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    for (const pid of ids) {
      const allBoosts = await getAllActiveBoosts(env, profileId, "product", pid);
      productStatuses[pid] = allBoosts.length
        ? { ...allBoosts[allBoosts.length - 1], count: allBoosts.length, all: allBoosts }
        : null;
    }
  }

  return jsonResponse({
    profileBoost,
    catalogueBoost,
    productBoosts: productStatuses
  });
}

/**
 * GET /api/profiles/:id/active-boosts — NEW: also returns the stored
 * targeting columns (additive; existing consumers simply ignore them).
 */
export async function handleActiveBoosts(env, profileId) {
  const { results } = await env.DB.prepare(
    `SELECT bl.id, bl.scope, bl.product_id, bl.boosted_at, bl.expires_at,
            bl.target_countries, bl.target_categories, bl.show_cta,
            p.name AS product_name
     FROM boost_log bl
     LEFT JOIN products p ON p.id = bl.product_id
     WHERE bl.profile_id = ? AND bl.expires_at > datetime('now')
     ORDER BY bl.expires_at ASC`
  ).bind(profileId).all();

  return jsonResponse({ boosts: results });
}

export async function handleBoostConfig(env) {
  const { results } = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'admin_whatsapp_number'"
  ).all();
  const number = results.length ? results[0].value : null;
  return jsonResponse({ adminWhatsapp: (number && number !== "REPLACE_WITH_YOUR_NUMBER") ? number : null });
}

export async function handleActivateBoost(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json();
  const { profile_id, product_id, days, scope } = body;
  if (!profile_id || !days) {
    return jsonResponse({ error: "profile_id and days are required." }, 400);
  }

  const resolvedScope = scope || (product_id ? "product" : "profile");

  await env.DB.prepare(
    `INSERT INTO boost_log (profile_id, product_id, scope, expires_at)
     VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'))`
  ).bind(profile_id, product_id || null, resolvedScope, Number(days)).run();

  return jsonResponse({ success: true });
}

// =====================================================================
// Targeting validation + recap
// =====================================================================

/** Stored column value -> "ALL" | ["NG", ...]. NULL / junk = ALL (legacy rows). */
function parseTargetList(raw) {
  if (raw == null || raw === "" || raw === "ALL") return "ALL";
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : "ALL";
  } catch (e) { return "ALL"; }
}

/**
 * Validates + normalises the advertiser's choices SERVER-SIDE.
 *
 * Preferred input (new client):  country_mode / category_mode = "own" | "all"
 *   -> the actual values are DERIVED here from the profile row, so the
 *      browser never supplies a country or category value at all.
 * Legacy input (old client):     target_countries / target_categories
 *   -> still accepted, every entry checked against a real allowlist.
 * Nothing sent at all            -> defaults to the advertiser's own values.
 *
 * Returns { targetCountries, targetCategories, showCta, notes[] }.
 * Throws Error(message) only for genuinely invalid legacy input.
 */
async function validateTargeting(env, body, profileRow) {
  const own = await getOwnTargetingDefaults(env, profileRow);
  const notes = [];

  // ---- countries ----
  let targetCountries;
  const countryMode = body.country_mode === "own" || body.country_mode === "all" ? body.country_mode : null;

  if (countryMode === "all") {
    targetCountries = "ALL";
  } else if (countryMode === "own") {
    if (own.country) targetCountries = JSON.stringify([own.country.code]);
    else { targetCountries = "ALL"; notes.push(own.countryNote); }
  } else if (body.target_countries != null) {
    if (body.target_countries === "ALL") {
      targetCountries = "ALL";
    } else if (Array.isArray(body.target_countries)) {
      const cleaned = body.target_countries
        .map((c) => String(c).toUpperCase().trim())
        .filter((c) => COUNTRY_NAMES[c]);
      if (!cleaned.length) throw new Error("At least one valid target country is required, or choose All Countries.");
      targetCountries = JSON.stringify([...new Set(cleaned)]);
    } else {
      throw new Error("Invalid country targeting selection.");
    }
  } else if (own.country) {
    targetCountries = JSON.stringify([own.country.code]);
  } else {
    targetCountries = "ALL";
    notes.push(own.countryNote);
  }

  // ---- categories ----
  let targetCategories;
  const categoryMode = body.category_mode === "own" || body.category_mode === "all" ? body.category_mode : null;

  if (categoryMode === "all") {
    targetCategories = "ALL";
  } else if (categoryMode === "own") {
    if (own.category) targetCategories = JSON.stringify([own.category.slug]);
    else { targetCategories = "ALL"; notes.push(own.categoryNote); }
  } else if (body.target_categories != null) {
    if (body.target_categories === "ALL") {
      targetCategories = "ALL";
    } else if (Array.isArray(body.target_categories)) {
      let validSlugs = new Set();
      try {
        const { results } = await env.DB.prepare("SELECT slug FROM business_categories WHERE is_allowed = 1").all();
        validSlugs = new Set(results.map((c) => c.slug));
      } catch (e) { /* fall through to the profile's own category below */ }
      if (!validSlugs.size && own.category) validSlugs.add(own.category.slug);
      const cleaned = body.target_categories
        .map((c) => String(c).toLowerCase().trim())
        .filter((c) => validSlugs.has(c));
      if (!cleaned.length) throw new Error("At least one valid target category is required, or choose All Categories.");
      targetCategories = JSON.stringify([...new Set(cleaned)]);
    } else {
      throw new Error("Invalid category targeting selection.");
    }
  } else if (own.category) {
    targetCategories = JSON.stringify([own.category.slug]);
  } else {
    targetCategories = "ALL";
    notes.push(own.categoryNote);
  }

  // ---- CTA buttons ----
  const wantsCta = body.show_cta === true || body.show_cta === 1 || body.show_cta === "1";
  let showCta = 0;
  if (wantsCta) {
    if (own.ctaAvailable) showCta = 1;
    else notes.push(own.ctaNote);
  }

  return { targetCountries, targetCategories, showCta, notes };
}

/** Turns STORED targeting columns into a human-readable structure. */
async function describeStoredTargeting(env, countriesRaw, categoriesRaw, showCta) {
  const countryList = parseTargetList(countriesRaw);
  const countries = countryList === "ALL"
    ? "ALL"
    : countryList.map((code) => ({ code, name: COUNTRY_NAMES[code] || code }));

  const categoryList = parseTargetList(categoriesRaw);
  let categories = "ALL";
  if (categoryList !== "ALL") {
    const labelBySlug = {};
    try {
      const placeholders = categoryList.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT slug, label FROM business_categories WHERE slug IN (${placeholders})`
      ).bind(...categoryList).all();
      results.forEach((r) => { labelBySlug[r.slug] = r.label; });
    } catch (e) { /* fall back to prettified slugs */ }
    categories = categoryList.map((slug) => ({ slug, label: labelBySlug[slug] || prettifySlug(slug) }));
  }

  return { countries, categories, showCta: Number(showCta) === 1 };
}

async function buildRecap(env, { scope, productName, hours, amount, currency, countriesRaw, categoriesRaw, showCta, profileRow, notes }) {
  const t = await describeStoredTargeting(env, countriesRaw, categoriesRaw, showCta);
  return {
    scope,
    productName: productName || null,
    hours,
    amount,
    currency,
    countries: t.countries,
    categories: t.categories,
    showCta: t.showCta,
    ctaChannels: t.showCta ? ctaChannelsFor(profileRow) : [],
    notes: (notes || []).filter(Boolean)
  };
}

// =====================================================================
// Boost checkout — Paystack (NGN-charging) + manual fallback.
// =====================================================================

export async function handleBoostCheckout(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const { profile_id, scope, product_id, duration_id, custom_hours, custom_days, method } = body;

  if (!profile_id || !scope || !["profile", "catalogue", "product"].includes(scope)) {
    return jsonResponse({ error: "Invalid boost selection." }, 400);
  }
  if (scope === "product" && !product_id) {
    return jsonResponse({ error: "A product must be specified for a product boost." }, 400);
  }
  const hasCustomInput = custom_days != null || custom_hours != null;
  if (!duration_id && !hasCustomInput) {
    return jsonResponse({ error: "Choose a duration." }, 400);
  }
  if (duration_id && hasCustomInput) {
    return jsonResponse({ error: "Choose either a listed duration or a custom one, not both." }, 400);
  }
  if (method !== "paystack" && method !== "manual") {
    return jsonResponse({ error: "Invalid payment method." }, 400);
  }

  const { results: profileRows } = await env.DB.prepare(
    `SELECT id, owner_id, business_name, slug, business_category, store_country, store_address,
            map_address, whatsapp_number, phone_number
     FROM profiles WHERE id = ?`
  ).bind(profile_id).all();
  if (!profileRows.length) return jsonResponse({ error: "Profile not found." }, 404);
  if (profileRows[0].owner_id !== userId) return jsonResponse({ error: "Not your profile." }, 403);
  const profileRow = profileRows[0];

  let productName = null;
  if (scope === "product") {
    const { results: productRows } = await env.DB.prepare(
      "SELECT id, name FROM products WHERE id = ? AND profile_id = ?"
    ).bind(product_id, profile_id).all();
    if (!productRows.length) return jsonResponse({ error: "Product not found on this profile." }, 404);
    productName = productRows[0].name;
  }

  // Targeting is derived from the profile row on the server.
  let targeting;
  try {
    targeting = await validateTargeting(env, body, profileRow);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }

  const countryCode = resolveCountry(request);
  const unlockedGroups = await getUnlockedTierGroups(env);
  const { results: allDurations } = await env.DB.prepare(
    "SELECT * FROM boost_pricing WHERE country_code = ? ORDER BY sort_order ASC"
  ).bind(countryCode).all();
  const unlockedDurations = allDurations.filter((d) => unlockedGroups.includes(d.tier_group));

  if (!unlockedDurations.length) {
    return jsonResponse({ error: "Boosting isn't available right now — please check back soon." }, 400);
  }

  let hours, amount, currency, resolvedDurationId, resolvedCustomHours;

  if (duration_id) {
    const match = unlockedDurations.find((d) => d.duration_id === duration_id);
    if (!match) return jsonResponse({ error: "That duration isn't available." }, 400);
    hours = match.hours;
    amount = match.amount;
    currency = match.currency;
    resolvedDurationId = duration_id;
    resolvedCustomHours = null;
  } else {
    const customDaysNum = body.custom_days != null
      ? Number(body.custom_days)
      : (custom_hours != null ? Number(custom_hours) / 24 : NaN);

    if (!Number.isFinite(customDaysNum) || customDaysNum <= 0) {
      return jsonResponse({ error: "Enter a valid number of days." }, 400);
    }

    const priced = await computeCustomBoostPrice(env, unlockedDurations, customDaysNum);
    if (!priced) {
      const longestDays = Math.max(...unlockedDurations.map((d) => d.hours)) / 24;
      return jsonResponse({ error: `Custom duration must be more than ${longestDays} days — choose a listed duration for anything shorter.` }, 400);
    }
    if (customDaysNum > priced.maxDays) {
      return jsonResponse({ error: `Custom duration can't exceed ${priced.maxDays} days right now.` }, 400);
    }

    hours = Math.round(customDaysNum * 24);
    amount = priced.amount;
    currency = unlockedDurations[0].currency;
    resolvedDurationId = null;
    resolvedCustomHours = hours;
  }

  const purchaseId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO boost_purchases (id, profile_id, scope, product_id, duration_id, custom_hours, country_code, currency, amount, method, status, target_countries, target_categories, show_cta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).bind(purchaseId, profile_id, scope, product_id || null, resolvedDurationId, resolvedCustomHours, countryCode, currency, amount, method, targeting.targetCountries, targeting.targetCategories, targeting.showCta).run();

  // Recap is built from the EXACT values just stored.
  const recap = await buildRecap(env, {
    scope, productName, hours, amount, currency,
    countriesRaw: targeting.targetCountries,
    categoriesRaw: targeting.targetCategories,
    showCta: targeting.showCta,
    profileRow,
    notes: targeting.notes
  });

  if (method === "manual") {
    return jsonResponse({
      success: true,
      method: "manual",
      purchase: { id: purchaseId, scope, hours, currency, amount, recap }
    });
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse({ error: "Card payment isn't available right now — please use the manual option." }, 503);
  }

  let ngnChargeAmount;
  try {
    ngnChargeAmount = await getBoostNgnChargeAmount(env, { currency, amount, country_code: countryCode });
  } catch (err) {
    console.error("Boost NGN conversion failed:", err);
    return jsonResponse({ error: "Couldn't calculate pricing right now — please use the manual option or try again shortly." }, 502);
  }

  await env.DB.prepare(
    "UPDATE boost_purchases SET ngn_charge_amount = ? WHERE id = ?"
  ).bind(ngnChargeAmount, purchaseId).run();

  const { results: userRows } = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).all();
  const email = userRows.length ? userRows[0].email : "no-reply@liyogworld.com";
  const callbackUrl = `${new URL(request.url).origin}/api/boost/paystack-callback`;

  try {
    const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: ngnChargeAmount,
        currency: "NGN",
        callback_url: callbackUrl,
        reference: purchaseId,
        metadata: {
          profile_id, scope, product_id: product_id || null, purchase_id: purchaseId,
          target_countries: targeting.targetCountries,
          target_categories: targeting.targetCategories,
          show_cta: targeting.showCta
        }
      })
    });

    const initData = await initRes.json();
    if (!initRes.ok || !initData.status) {
      console.error("Paystack boost init failed:", JSON.stringify(initData));
      return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
    }

    return jsonResponse({ success: true, method: "paystack", authorizationUrl: initData.data.authorization_url, recap });
  } catch (err) {
    console.error("Paystack boost checkout error:", err);
    return jsonResponse({ error: "Couldn't start payment — please try again or use the manual option." }, 502);
  }
}

async function getBoostNgnChargeAmount(env, price) {
  if (price.currency === "NGN") return price.amount;

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${price.currency}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rates && data.rates.NGN) {
        const converted = (price.amount / 100) * data.rates.NGN;
        return roundUpToNearest50(converted * 100);
      }
    }
  } catch (err) {
    console.error(`Live FX lookup failed for ${price.currency}:`, err);
  }

  const { results } = await env.DB.prepare(
    "SELECT ngn_per_unit FROM fx_fallback_rates WHERE currency = ?"
  ).bind(price.currency).all();
  if (results.length) {
    const converted = (price.amount / 100) * results[0].ngn_per_unit;
    return roundUpToNearest50(converted * 100);
  }

  throw new Error(`No NGN conversion available for currency ${price.currency}`);
}

function roundUpToNearest50(amountInKobo) {
  const nairaAmount = amountInKobo / 100;
  const roundedNaira = Math.ceil(nairaAmount / 50) * 50;
  return roundedNaira * 100;
}

/**
 * GET /api/boost/paystack-callback — now also passes boost_ref so the
 * brand page can show a post-payment recap (see handleBoostRecap).
 */
export async function handleBoostPaystackCallback(request, env) {
  const url = new URL(request.url);
  const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");

  const pagePath = await getSettingLocal(env, "blogger_profile_page", "/p/brands.html");
  const redirectBase = new URL(pagePath, url.origin);

  if (!reference) {
    redirectBase.searchParams.set("boost_result", "error");
    return Response.redirect(redirectBase.toString(), 302);
  }

  const result = await verifyAndConfirmBoostPurchase(env, reference);

  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT profile_id FROM boost_purchases WHERE id = ?"
  ).bind(reference).all();
  if (purchaseRows.length) {
    const { results: profileRows } = await env.DB.prepare(
      "SELECT slug FROM profiles WHERE id = ?"
    ).bind(purchaseRows[0].profile_id).all();
    if (profileRows.length) redirectBase.searchParams.set("biz", profileRows[0].slug);
    redirectBase.searchParams.set("boost_ref", reference);
  }

  redirectBase.searchParams.set("boost_result", result.success ? "success" : "error");
  return Response.redirect(redirectBase.toString(), 302);
}

export async function handleBoostPaystackWebhook(request, env) {
  if (!env.PAYSTACK_SECRET_KEY) return new Response("Not configured", { status: 503 });

  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");
  const expectedSig = await hmacSha512Hex(env.PAYSTACK_SECRET_KEY, rawBody);
  if (!signature || signature !== expectedSig) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return new Response("Bad payload", { status: 400 }); }

  if (event.event === "charge.success" && event.data && event.data.reference) {
    await verifyAndConfirmBoostPurchase(env, event.data.reference);
  }

  return new Response("ok", { status: 200 });
}

async function verifyAndConfirmBoostPurchase(env, reference) {
  const { results: purchaseRows } = await env.DB.prepare(
    "SELECT * FROM boost_purchases WHERE id = ?"
  ).bind(reference).all();
  if (!purchaseRows.length) return { success: false, reason: "not_found" };
  const purchase = purchaseRows[0];

  if (purchase.status === "confirmed") return { success: true, alreadyConfirmed: true };

  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { "Authorization": `Bearer ${env.PAYSTACK_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();

    const paidOk =
      verifyRes.ok &&
      verifyData.status &&
      verifyData.data &&
      verifyData.data.status === "success" &&
      verifyData.data.amount === purchase.ngn_charge_amount &&
      verifyData.data.currency === "NGN";

    if (!paidOk) {
      await env.DB.prepare("UPDATE boost_purchases SET status = 'failed' WHERE id = ?").bind(reference).run();
      return { success: false, reason: "verification_failed" };
    }

    await applyConfirmedBoost(env, purchase);
    return { success: true };
  } catch (err) {
    console.error("Paystack boost verify error:", err);
    return { success: false, reason: "error" };
  }
}

/** Hours for a purchase row (custom value, or the matched official duration). */
async function getPurchaseHours(env, purchase) {
  let hours = purchase.custom_hours;
  if (!hours && purchase.duration_id) {
    const { results } = await env.DB.prepare(
      "SELECT hours FROM boost_pricing WHERE duration_id = ? AND country_code = ?"
    ).bind(purchase.duration_id, purchase.country_code).all();
    hours = results.length ? results[0].hours : 24;
  }
  return hours || 24;
}

/**
 * Grants the boost: marks the purchase confirmed and inserts the
 * boost_log row. Targeting columns are copied straight from the
 * purchase row (that is what the checkout stored). UNCHANGED logic.
 */
async function applyConfirmedBoost(env, purchase) {
  const hours = await getPurchaseHours(env, purchase);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE boost_purchases SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?"
    ).bind(purchase.id),
    env.DB.prepare(
      `INSERT INTO boost_log (profile_id, product_id, scope, expires_at, target_countries, target_categories, show_cta)
       VALUES (?, ?, ?, datetime('now', '+' || ? || ' hours'), ?, ?, ?)`
    ).bind(purchase.profile_id, purchase.product_id || null, purchase.scope, hours, purchase.target_countries, purchase.target_categories, purchase.show_cta)
  ]);
}

/** Recap rebuilt from a STORED purchase row (admin response + owner recap). */
async function recapFromPurchaseRow(env, purchase) {
  const hours = await getPurchaseHours(env, purchase);
  let productName = null;
  if (purchase.product_id) {
    const { results } = await env.DB.prepare("SELECT name FROM products WHERE id = ?").bind(purchase.product_id).all();
    productName = results.length ? results[0].name : null;
  }
  const { results: profileRows } = await env.DB.prepare(
    "SELECT whatsapp_number, phone_number FROM profiles WHERE id = ?"
  ).bind(purchase.profile_id).all();

  const recap = await buildRecap(env, {
    scope: purchase.scope,
    productName,
    hours,
    amount: purchase.amount,
    currency: purchase.currency,
    countriesRaw: purchase.target_countries,
    categoriesRaw: purchase.target_categories,
    showCta: purchase.show_cta,
    profileRow: profileRows[0] || null,
    notes: []
  });
  return recap;
}

/**
 * POST /api/boost/manual-activate — admin-only. Same as before, but the
 * response now includes the recap of what was activated so you can
 * confirm country / category / CTA at a glance.
 */
export async function handleActivateBoostPurchase(request, env) {
  const adminHeader = request.headers.get("x-admin-secret");
  if (!env.ADMIN_SECRET || adminHeader !== env.ADMIN_SECRET) {
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const { purchase_id } = body;
  if (!purchase_id) return jsonResponse({ error: "purchase_id is required." }, 400);

  const { results } = await env.DB.prepare(
    "SELECT * FROM boost_purchases WHERE id = ?"
  ).bind(purchase_id).all();
  if (!results.length) return jsonResponse({ error: "Purchase not found." }, 404);
  const purchase = results[0];

  if (purchase.status === "confirmed") return jsonResponse({ success: true, alreadyConfirmed: true });
  if (purchase.method !== "manual") return jsonResponse({ error: "This purchase isn't manual — use Paystack verification instead." }, 400);

  await applyConfirmedBoost(env, purchase);

  let recap = null;
  try { recap = await recapFromPurchaseRow(env, purchase); } catch (e) { console.error("Recap build failed:", e); }
  return jsonResponse({ success: true, recap });
}

/**
 * GET /api/boost/recap?ref=<purchaseId> — OWNER ONLY. Returns what a
 * purchase was for (scope, duration, price, country, category, CTA)
 * and its status. Used by the brand page after returning from Paystack.
 * Requires the logged-in user to own the profile the purchase belongs to.
 */
export async function handleBoostRecap(request, env, userId) {
  const ref = new URL(request.url).searchParams.get("ref");
  if (!ref) return jsonResponse({ error: "Missing reference." }, 400);

  const { results } = await env.DB.prepare("SELECT * FROM boost_purchases WHERE id = ?").bind(ref).all();
  if (!results.length) return jsonResponse({ error: "Not found." }, 404);
  const purchase = results[0];

  const { results: ownerRows } = await env.DB.prepare("SELECT owner_id FROM profiles WHERE id = ?").bind(purchase.profile_id).all();
  if (!ownerRows.length || ownerRows[0].owner_id !== userId) return jsonResponse({ error: "Not authorized." }, 403);

  const recap = await recapFromPurchaseRow(env, purchase);
  return jsonResponse({
    success: true,
    status: purchase.status,
    method: purchase.method,
    chargedNgn: purchase.ngn_charge_amount && purchase.currency !== "NGN" ? purchase.ngn_charge_amount : null,
    recap
  });
}

// =====================================================================
// Boost DISPLAY — the fair-rotation selection primitive.
// *** UNCHANGED — kept as the automatic fallback for the 3b engine below. ***
// =====================================================================

const POOL_MULTIPLIER = 3;

export async function selectBoostedItems(env, { scope, excludeProfileId = null, limit = 4 }) {
  const poolSize = limit * POOL_MULTIPLIER;

  const excludeClause = excludeProfileId ? "AND profile_id != ?" : "";
  const binds = [scope];
  if (excludeProfileId) binds.push(excludeProfileId);
  binds.push(poolSize);

  const { results: pool } = await env.DB.prepare(
    `SELECT id, profile_id, product_id, scope, boosted_at, expires_at, impression_count
     FROM boost_log
     WHERE scope = ? AND expires_at > datetime('now') ${excludeClause}
     ORDER BY impression_count ASC, RANDOM()
     LIMIT ?`
  ).bind(...binds).all();

  if (!pool.length) return [];

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const selected = shuffled.slice(0, limit);

  if (selected.length) {
    const ids = selected.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE boost_log SET impression_count = impression_count + 1, last_shown_at = datetime('now') WHERE id IN (${placeholders})`
    ).bind(...ids).run();
  }

  return selected;
}

// =====================================================================
// 3b — TARGETED SERVING ENGINE  (ADDITIVE — selectBoostedItems above is
// untouched and remains the automatic fallback if anything below fails
// or the feature switch is off.)
//
//  Gate (never relaxed):  the boost targets ALL countries, or includes
//                         the viewer's country. Unknown viewer country
//                         -> only ALL-country boosts are eligible.
//  Tier 0: the boost chose THIS page's category.
//  Tier 1: the boost targets ALL categories (or the page has no category).
//  Tier 2: the boost chose a different category — only used to fill
//          whatever slots tiers 0 and 1 could not.
//  Within a tier: PACING order — boosts that are behind their fair
//          delivery rate (impressions per hour paid-for) go first, so a
//          brand-new boost can't starve older paid boosts and nobody is
//          left unseen. Random tiebreak + a small shuffled window keep
//          simultaneous visitors from all receiving identical strips.
//  One card per product/brand (stacked boosts no longer duplicate).
//
//  Switch:  app_settings  boost_targeting_enabled = '1'  (default OFF).
// =====================================================================

const SMART_FLAG_KEY = "boost_targeting_enabled";
let smartFlagCache = { value: false, at: 0 };

/** Feature switch, cached ~30s per isolate so it costs ~0 queries. */
export async function isTargetingEnabled(env) {
  const now = Date.now();
  if (now - smartFlagCache.at < 30000) return smartFlagCache.value;
  const raw = await getSettingLocal(env, SMART_FLAG_KEY, "0");
  const value = raw === "1" || raw === "true" || raw === "on";
  smartFlagCache = { value, at: now };
  return value;
}

/** A page category must look like a slug; anything else is ignored. */
export function sanitizePageCategory(raw) {
  const s = String(raw == null ? "" : raw).toLowerCase().trim();
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : null;
}

// LIKE pattern matching a quoted member of a stored JSON array, with
// LIKE wildcards escaped (slugs may contain "_").
function jsonMemberLike(value) {
  return `%"${String(value).replace(/[\\%_]/g, (c) => "\\" + c)}"%`;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function runSmartSelection(env, { scope, excludeProfileId = null, limit = 4, viewerCountry = null, pageCategory = null, dryRun = false }) {
  const poolSize = Math.max(24, limit * 6);

  // Placeholder order must follow the SQL text order: SELECT -> WHERE -> LIMIT.
  const binds = [];
  let tierSql = "1";
  if (pageCategory) {
    tierSql = `CASE
        WHEN target_categories LIKE ? ESCAPE '\\' THEN 0
        WHEN target_categories IS NULL OR target_categories = '' OR target_categories = 'ALL' THEN 1
        ELSE 2 END`;
    binds.push(jsonMemberLike(pageCategory));
  }

  const where = ["scope = ?", "expires_at > datetime('now')"];
  binds.push(scope);
  if (excludeProfileId) { where.push("profile_id != ?"); binds.push(excludeProfileId); }
  if (viewerCountry) {
    where.push("(target_countries IS NULL OR target_countries = '' OR target_countries = 'ALL' OR target_countries LIKE ? ESCAPE '\\')");
    binds.push(jsonMemberLike(viewerCountry));
  } else {
    where.push("(target_countries IS NULL OR target_countries = '' OR target_countries = 'ALL')");
  }
  binds.push(poolSize);

  const { results: pool } = await env.DB.prepare(
    `SELECT id, profile_id, product_id, scope, boosted_at, expires_at, impression_count,
            target_countries, target_categories, show_cta,
            ${tierSql} AS tier,
            (COALESCE(impression_count, 0) * 1.0) /
              MAX(1.0, (julianday('now') - julianday(COALESCE(boosted_at, datetime('now', '-1 hour')))) * 24.0) AS pace
     FROM boost_log
     WHERE ${where.join(" AND ")}
     ORDER BY tier ASC, pace ASC, RANDOM()
     LIMIT ?`
  ).bind(...binds).all();

  const picked = [];
  if (pool.length) {
    const seenKeys = new Set();
    const brandCount = {};
    const perBrandCap = scope === "product" ? 2 : 1;
    const keyOf = (row) => (scope === "product" ? row.product_id : row.profile_id);

    const take = (row, enforceCap) => {
      const key = keyOf(row);
      if (!key || seenKeys.has(key)) return;
      if (enforceCap && (brandCount[row.profile_id] || 0) >= perBrandCap) return;
      seenKeys.add(key);
      brandCount[row.profile_id] = (brandCount[row.profile_id] || 0) + 1;
      picked.push(row);
    };

    for (const tier of [0, 1, 2]) {
      if (picked.length >= limit) break;
      const group = pool.filter((r) => Number(r.tier) === tier);
      if (!group.length) continue;
      const windowSize = Math.max(limit * 2, 8);
      const ordered = shuffleInPlace(group.slice(0, windowSize)).concat(group.slice(windowSize));
      for (const row of ordered) {
        if (picked.length >= limit) break;
        take(row, true);
      }
    }
    // Strip still short and one brand dominated the pool: relax the
    // per-brand cap (never the per-product dedupe) so the strip fills.
    if (picked.length < limit && scope === "product") {
      for (const row of pool) {
        if (picked.length >= limit) break;
        take(row, false);
      }
    }
  }

  if (picked.length && !dryRun) {
    const ids = picked.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE boost_log SET impression_count = impression_count + 1, last_shown_at = datetime('now') WHERE id IN (${placeholders})`
    ).bind(...ids).run();
  }

  return { picked, pool };
}

/** Targeted selection. Returns the chosen boost_log rows (same shape the
 *  legacy selector returns, plus tier / pace / show_cta). May throw —
 *  callers fall back to selectBoostedItems. */
export async function selectBoostedItemsSmart(env, opts) {
  const { picked } = await runSmartSelection(env, opts);
  return picked;
}

/** Admin-only explanation: same ranking, but never counts impressions. */
export async function explainSmartSelection(env, opts) {
  const { picked, pool } = await runSmartSelection(env, { ...opts, dryRun: true });
  const pickedIds = new Set(picked.map((p) => p.id));
  return pool.map((r) => ({
    boost_id: r.id, profile_id: r.profile_id, product_id: r.product_id,
    tier: Number(r.tier), pace: Number(Number(r.pace).toFixed(4)),
    impressions: r.impression_count, countries: r.target_countries, categories: r.target_categories,
    show_cta: r.show_cta, selected: pickedIds.has(r.id)
  }));
}

async function getSettingLocal(env, key, fallback) {
  try {
    const { results } = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).all();
    return results.length > 0 ? results[0].value : fallback;
  } catch (err) {
    return fallback;
  }
}

async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Exposed for part 3b (viewer-side serving) and for debugging.
export { COUNTRY_NAMES, parseTargetList };
