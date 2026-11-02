// =====================================================================
// BIZIPLEX — src/lib/money.js
// Money the way banks do it: whole integers in the currency's smallest unit
// (kobo, cents...), plus an ISO 4217 code. NEVER floats for stored money.
// Floats appear only in display-only conversion, and are rounded straight back.
// =====================================================================

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "UGX", "RWF", "XAF", "XOF", "CLP", "PYG", "ISK", "KMF", "GNF", "DJF"]);
const THREE_DECIMAL = new Set(["KWD", "BHD", "OMR", "JOD", "TND"]);

export const SUPPORTED_CURRENCIES = new Set([
  "USD", "NGN", "GBP", "EUR", "GHS", "KES", "ZAR", "UGX", "TZS", "RWF", "XOF", "XAF", "EGP", "MAD", "ETB", "ZMW",
  "CAD", "AUD", "NZD", "INR", "PKR", "BDT", "AED", "SAR", "QAR", "KWD", "TRY", "BRL", "MXN", "ARS", "CLP", "COP",
  "PEN", "JPY", "KRW", "CNY", "HKD", "SGD", "MYR", "IDR", "PHP", "THB", "VND", "CHF", "SEK", "NOK", "DKK", "PLN",
  "CZK", "HUF", "RON", "UAH", "ILS", "MUR", "BWP", "NAD", "AOA", "GMD", "LKR", "NPR"
]);

export const MAX_MINOR = 10 ** 13; // far above any real price; keeps integers safe

const COUNTRY_CURRENCY = {
  NG: "NGN", US: "USD", GB: "GBP", GH: "GHS", KE: "KES", ZA: "ZAR", UG: "UGX", TZ: "TZS", RW: "RWF", CM: "XAF",
  CI: "XOF", SN: "XOF", EG: "EGP", MA: "MAD", ET: "ETB", ZM: "ZMW", CA: "CAD", AU: "AUD", NZ: "NZD", IN: "INR",
  PK: "PKR", BD: "BDT", AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", TR: "TRY", BR: "BRL", MX: "MXN", AR: "ARS",
  CL: "CLP", CO: "COP", PE: "PEN", JP: "JPY", KR: "KRW", CN: "CNY", HK: "HKD", SG: "SGD", MY: "MYR", ID: "IDR",
  PH: "PHP", TH: "THB", VN: "VND", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF",
  RO: "RON", UA: "UAH", IL: "ILS", MU: "MUR", BW: "BWP", NA: "NAD", AO: "AOA", GM: "GMD", LK: "LKR", NP: "NPR"
};
for (const cc of ["DE", "FR", "ES", "IT", "NL", "BE", "AT", "PT", "IE", "FI", "GR", "LU", "SK", "SI", "EE", "LV", "LT", "CY", "MT", "HR"]) COUNTRY_CURRENCY[cc] = "EUR";

const COUNTRY_NAME_CURRENCY = {
  nigeria: "NGN", ghana: "GHS", kenya: "KES", "south africa": "ZAR", uganda: "UGX", tanzania: "TZS", rwanda: "RWF",
  "united states": "USD", usa: "USD", "united kingdom": "GBP", uk: "GBP", canada: "CAD", cameroon: "XAF", egypt: "EGP"
};

export function currencyExponent(code) {
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function normalizeCurrency(input) {
  const c = String(input || "").trim().toUpperCase();
  return SUPPORTED_CURRENCIES.has(c) ? c : null;
}

export function viewerCurrencyFromCountry(cc) {
  return COUNTRY_CURRENCY[String(cc || "").toUpperCase()] || "USD";
}

export function currencyFromCountryName(name) {
  return COUNTRY_NAME_CURRENCY[String(name || "").trim().toLowerCase()] || null;
}

/** "15,000.50" -> 1500050 (NGN). Pure string maths, no floats. null = invalid. */
export function majorToMinor(input, currency) {
  const exp = currencyExponent(currency);
  const s = String(input == null ? "" : input).trim().replace(/[\s,_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  let [whole, frac = ""] = s.split(".");
  if (frac.length > exp) {
    if (/[^0]/.test(frac.slice(exp))) return null; // refuse hidden extra precision
    frac = frac.slice(0, exp);
  }
  frac = frac.padEnd(exp, "0");
  const minor = Number(whole + frac);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) return null;
  return minor;
}

export function minorToMajorString(minor, currency) {
  const exp = currencyExponent(currency);
  const n = Math.trunc(Number(minor) || 0);
  if (exp === 0) return String(n);
  const str = String(Math.abs(n)).padStart(exp + 1, "0");
  return (n < 0 ? "-" : "") + str.slice(0, -exp) + "." + str.slice(-exp);
}

/** Pretty text, e.g. 1500050 NGN -> "₦15,000.50"; whole amounts drop the decimals. */
export function formatMoney(minor, currency, locale = "en") {
  const exp = currencyExponent(currency);
  const unit = 10 ** exp;
  const m = Math.trunc(Number(minor) || 0);
  const major = m / unit;
  const whole = m % unit === 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency", currency, currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : exp, maximumFractionDigits: exp
    }).format(major);
  } catch (e) {
    return `${currency} ${major.toLocaleString("en")}`;
  }
}

/** Display-only conversion. perUsd = { NGN: 1500, EUR: 0.92 ... } (USD is 1). null if a rate is missing. */
export function convertMinor(minor, from, to, perUsd) {
  if (from === to) return minor;
  const rf = from === "USD" ? 1 : perUsd[from];
  const rt = to === "USD" ? 1 : perUsd[to];
  if (!rf || !rt) return null;
  const usdMajor = (minor / 10 ** currencyExponent(from)) / rf;
  return Math.round(usdMajor * rt * 10 ** currencyExponent(to));
}

/**
 * Turns the OLD free-text price ("₦15,000", "#50,000", "$5000", "100,000", "Contact us")
 * into real money, best effort. Anything doubtful becomes "contact for price".
 */
export function parseLegacyPriceDisplay(text, fallbackCurrency) {
  const raw = String(text == null ? "" : text).trim();
  const fallback = normalizeCurrency(fallbackCurrency) || "NGN";
  const none = { price_minor: null, currency: fallback, price_type: "contact", price_source: "unparsed" };
  if (!raw || raw.length > 60) return none;
  const lower = raw.toLowerCase();

  let currency = null;
  if (/₦|\bngn\b|\bnaira\b|^#|\bn(?=\d)/i.test(raw)) currency = "NGN";
  else if (/gh₵|₵|\bghs\b|\bcedi/i.test(raw)) currency = "GHS";
  else if (/\$|\busd\b|\bdollar/i.test(raw)) currency = "USD";
  else if (/£|\bgbp\b|\bpound/i.test(raw)) currency = "GBP";
  else if (/€|\beur\b|\beuro/i.test(raw)) currency = "EUR";
  else if (/\bksh\b|\bkes\b/i.test(raw)) currency = "KES";
  else if (/\bzar\b|\brand\b|\br(?=\d)/i.test(raw)) currency = "ZAR";
  else if (/\bxof\b|\bcfa\b/i.test(raw)) currency = "XOF";
  const cur = currency || fallback;

  const letters = lower.replace(/ngn|naira|usd|dollars?|gbp|pounds?|eur|euros?|ghs|cedis?|kes|ksh|zar|rand|xof|cfa|from|starting|at|only|each|per|to|k\b/g, "").replace(/[^a-z]/g, "");
  if (letters.length > 12) return none;                  // a sentence, not a price
  const nums = raw.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!nums) {
    if (/^free\b/.test(lower)) return { price_minor: 0, currency: cur, price_type: "fixed", price_source: "parsed" };
    return none;
  }
  let first = nums[0].replace(/,/g, "");
  if (new RegExp(first.replace(".", "\\.") + "\\s*k\\b", "i").test(raw.replace(/,/g, ""))) first = String(Number(first) * 1000);
  const minor = majorToMinor(first, cur);
  if (minor === null) return none;
  const isFrom = /\bfrom\b|\bstarting\b|\bstarts?\b/.test(lower) || (nums.length >= 2 && /[-–—]|\bto\b/.test(raw));
  return { price_minor: minor, currency: cur, price_type: isFrom ? "from" : "fixed", price_source: "parsed" };
}

// ---------------------------------------------------------------------
// Exchange rates: stored in D1, refreshed nightly, read through a 10-minute
// in-memory cache so a busy page never hits the database for them.
// ---------------------------------------------------------------------
let ratesCache = null;

export async function getRates(env) {
  if (ratesCache && Date.now() - ratesCache.at < 10 * 60 * 1000) return ratesCache.data;
  const perUsd = {};
  let updatedAt = null;
  try {
    const { results } = await env.DB.prepare("SELECT currency, per_usd, updated_at FROM fx_rates").all();
    for (const r of results) { perUsd[r.currency] = r.per_usd; if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at; }
  } catch (e) { /* table not created yet */ }
  const data = { perUsd, updatedAt };
  ratesCache = { at: Date.now(), data };
  return data;
}

export async function refreshFxRates(env, { force = false } = {}) {
  if (!force) {
    const { updatedAt } = await getRates(env);
    if (updatedAt && Date.now() - new Date(updatedAt.replace(" ", "T") + "Z").getTime() < 20 * 3600 * 1000) return { skipped: true };
  }
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) throw new Error("FX provider returned " + res.status);
  const j = await res.json();
  if (j.result !== "success" || !j.rates) throw new Error("FX provider gave no rates");
  const rows = Object.entries(j.rates).filter(([k, v]) => SUPPORTED_CURRENCIES.has(k) && typeof v === "number" && v > 0);
  for (let i = 0; i < rows.length; i += 40) {
    await env.DB.batch(rows.slice(i, i + 40).map(([cur, rate]) =>
      env.DB.prepare(
        "INSERT INTO fx_rates (currency, per_usd, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(currency) DO UPDATE SET per_usd = excluded.per_usd, updated_at = datetime('now')"
      ).bind(cur, rate)
    ));
  }
  ratesCache = null;
  return { updated: rows.length };
}
