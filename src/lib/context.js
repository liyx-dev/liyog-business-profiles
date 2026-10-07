// =====================================================================
// LIYOG WORLD — src/lib/context.js   (3b-3: contextual relevance)
//
// Works out which business category a PAGE is about, from a few short
// signals the browser reads off that page (labels/tags, headline,
// description, opening lines) — like contextual advertising does — so
// the 3b-1 engine can show boosts from that category first.
//
// Design rules:
//  * Pure text matching. No AI call, no external request, no stored
//    data: the text is read, scored and thrown away.
//  * Conservative: it only answers when the evidence is clear, and
//    returns null otherwise (the engine then simply uses country-only
//    rotation, exactly as before). A weak or ambiguous page never
//    produces a confident-looking wrong category.
//  * Signal weighting: labels/tags count most, then headline, then
//    description, then the opening lines. A word is counted once per
//    signal, so repeating a word cannot game the score.
//  * Categories come from YOUR business_categories table (cached 5
//    minutes); a category added later is picked up automatically from
//    its label words even without a keyword list.
//  * Never throws. Never trusts input: length-capped, control
//    characters stripped, only a validated slug is ever returned.
// =====================================================================

const MAX_CONTEXT_CHARS = 700;
const SEGMENT_WEIGHTS = [3, 2, 1.5, 1];   // labels | headline | description | opening lines
const MIN_TOP_SCORE = 4;                  // e.g. one strong word in the headline
const MIN_LEAD_RATIO = 1.5;               // winner must clearly beat the runner-up
const WEAK_CAP = 3;                       // weak words can add at most this much, and never win alone

const STOPWORDS = new Set((
  "the and for with that this from your you are was were has have had not but all any can will our out about into over more most " +
  "than then them they their there here what when where which who whom why how its it is in on at by an as or we my me do go up so no if be he us " +
  "of to a i am been being very just also too get got new best top ways way tips tip guide how-to"
).split(/\s+/));

// strong = clear signal of the category (weight 2); weak = supporting only (weight 1).
const KEYWORDS = {
  electronics: {
    strong: ["phone","smartphone","iphone","android","samsung","tecno","infinix","itel","laptop","macbook","computer","tablet","gadget","earbud","headphone","charger","power bank","powerbank","speaker","television","tv","camera","drone","printer","router","wifi","inverter","solar","battery","gaming","playstation","xbox","console"],
    weak: ["tech","technology","device","electronic","software","app","smartwatch","watch","accessory","screen","usb","cable","bluetooth"]
  },
  fashion: {
    strong: ["fashion","dress","ankara","aso ebi","asoebi","gele","fabric","tailor","sneaker","shoe","sandal","bag","handbag","jean","shirt","suit","kaftan","agbada","native","lace","outfit","wardrobe","thrift","jewelry","jewellery","clothing","apparel","designer"],
    weak: ["style","trend","wear","collection","model","runway","cloth"]
  },
  food: {
    strong: ["food","restaurant","jollof","suya","shawarma","pizza","burger","cake","bakery","pastry","catering","recipe","cook","cooking","meal","snack","soup","chicken","grill","barbecue","chef","kitchen","smoothie","small chops","eatery","dish","juice"],
    weak: ["eat","taste","delicious","menu","flavor","flavour","dinner","lunch","breakfast","drink"]
  },
  beauty: {
    strong: ["beauty","skincare","makeup","cosmetic","hair","wig","braid","salon","barber","nail","lash","perfume","fragrance","spa","facial","lipstick","foundation","serum","moisturizer","lace front","hairstyle","grooming","manicure","pedicure"],
    weak: ["glow","skin","care","look"]
  },
  health: {
    strong: ["health","healthy","wellness","fitness","gym","workout","exercise","diet","nutrition","vitamin","supplement","herbal","medicine","pharmacy","doctor","hospital","clinic","malaria","diabetes","hypertension","pregnancy","immunity","immune","therapy","weight loss","cancer","symptom","treatment"],
    weak: ["care","body","sleep","stress","heart","blood","mental","weight"]
  },
  education: {
    strong: ["school","education","student","exam","jamb","waec","neco","scholarship","course","training","tutor","tutorial","university","polytechnic","lecture","curriculum","learning","teacher","classroom","degree","certificate","admission","ielts","study"],
    weak: ["learn","class","book","knowledge","career","skill"]
  },
  automotive: {
    strong: ["car","vehicle","auto","automobile","mechanic","toyota","honda","lexus","mercedes","tyre","tire","engine","spare part","sparepart","car wash","carwash","driving","dealership","suv","truck","motorcycle","okada","keke","petrol","diesel","gearbox","brake"],
    weak: ["road","drive","driver","garage","speed","fuel","bike"]
  },
  real_estate: {
    strong: ["real estate","property","house","apartment","flat","land","rent","rental","lease","landlord","tenant","mortgage","bungalow","duplex","realtor","plot","estate"],
    weak: ["home","building","location","room","accommodation","interior"]
  },
  agriculture: {
    strong: ["farm","farming","farmer","agriculture","agribusiness","crop","poultry","livestock","fishery","fish farming","fertilizer","cassava","maize","yam","cattle","goat","harvest","tractor","irrigation","seedling","plantation","cocoa"],
    weak: ["soil","plant","garden","rain","egg"]
  },
  events: {
    strong: ["event","wedding","party","concert","festival","ticket","dj","mc","decoration","decorator","venue","event planner","planner","birthday","anniversary","conference","expo","entertainment","comedian"],
    weak: ["celebration","guest","invitation","music","show","photography"]
  },
  logistics: {
    strong: ["logistics","delivery","dispatch","courier","shipping","freight","cargo","haulage","shipment","last mile","warehouse","transportation","parcel","supply chain","customs","tracking"],
    weak: ["transport","package","import","export","send","ship"]
  },
  services: {
    strong: ["consulting","consultant","lawyer","legal","attorney","accounting","accountant","tax","audit","plumber","plumbing","electrician","cleaning","cleaner","repair","installation","marketing","advertising","branding","graphic","printing","business registration","cac","insurance","agency","freelance","copywriting","web design","videography"],
    weak: ["professional","business","client","expert","solution","photography"]
  },
  retail: {
    strong: ["shop","store","supermarket","wholesale","retail","provision","grocery","market","mall","vendor","merchandise","online store","ecommerce","e commerce","inventory","bulk"],
    weak: ["buy","price","order","product","deal","cheap","sell","selling","customer","discount","sale"]
  }
};

// ---- text pipeline (shared by the keyword lists and the page text so they always compare like with like) ----

function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function tokens(text) {
  return String(text == null ? "" : text)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t))
    .map(stem);
}

function termSet(text) {
  const t = tokens(text);
  const set = new Set();
  for (let i = 0; i < t.length; i++) {
    set.add(t[i]);
    if (i + 1 < t.length) set.add(t[i] + " " + t[i + 1]);
    if (i + 2 < t.length) set.add(t[i] + " " + t[i + 1] + " " + t[i + 2]);
  }
  return set;
}

function sanitizeContext(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_CONTEXT_CHARS);
}

// ---- lexicon: term -> [{ slug, w }] ----

function addTerm(lexicon, rawTerm, slug, w) {
  const key = tokens(rawTerm).join(" ");
  if (!key) return;
  const list = lexicon.get(key) || [];
  const existing = list.find((h) => h.slug === slug);
  if (existing) existing.w = Math.max(existing.w, w); else list.push({ slug, w });
  lexicon.set(key, list);
}

function buildLexicon(dbCategories) {
  const lexicon = new Map();
  Object.entries(KEYWORDS).forEach(([slug, { strong, weak }]) => {
    strong.forEach((t) => addTerm(lexicon, t, slug, 2));
    weak.forEach((t) => addTerm(lexicon, t, slug, 1));
  });
  // Words from the category's own label (e.g. "Electronics & Gadgets").
  // Weak for built-in categories (labels are often generic), strong for a
  // category that has no keyword list yet, so new categories still work.
  (dbCategories || []).forEach((c) => {
    const known = !!KEYWORDS[c.slug];
    tokens(c.label).forEach((tok) => addTerm(lexicon, tok, c.slug, known ? 1 : 2));
  });
  return lexicon;
}

let modelCache = { at: 0, allowed: null, lexicon: buildLexicon([]) };

async function getModel(env) {
  const now = Date.now();
  if (now - modelCache.at < 300000) return modelCache;
  try {
    const { results } = await env.DB.prepare("SELECT slug, label FROM business_categories WHERE is_allowed = 1").all();
    const cats = (results || []).filter((c) => c && /^[a-z0-9_-]{1,40}$/.test(String(c.slug)));
    modelCache = { at: now, allowed: cats.length ? new Set(cats.map((c) => c.slug)) : null, lexicon: buildLexicon(cats) };
  } catch (e) {
    // Table unavailable: keep working on the built-in list for 5 minutes.
    modelCache = { at: now, allowed: null, lexicon: buildLexicon([]) };
  }
  return modelCache;
}

/**
 * rawText is "labels|headline|description|lead" (any part may be empty).
 * Returns { slug, score, second, scores } when the evidence is clear,
 * otherwise null. Never throws.
 */
export async function inferCategoryFromContext(env, rawText) {
  try {
    const text = sanitizeContext(rawText);
    if (!text) return null;
    const model = await getModel(env);

    // Strong evidence and weak (supporting-only) evidence are tracked
    // separately: a category can never win on generic words alone, and
    // weak words can add at most WEAK_CAP points on top of strong ones.
    const strongScore = {};
    const weakScore = {};
    text.split("|").slice(0, 4).forEach((segment, i) => {
      const weight = SEGMENT_WEIGHTS[i] != null ? SEGMENT_WEIGHTS[i] : 1;
      termSet(segment).forEach((term) => {
        const hits = model.lexicon.get(term);
        if (!hits) return;
        hits.forEach((h) => {
          if (model.allowed && !model.allowed.has(h.slug)) return;
          const bucket = h.w >= 2 ? strongScore : weakScore;
          bucket[h.slug] = (bucket[h.slug] || 0) + weight * h.w;
        });
      });
    });

    const scores = {};
    Object.keys(strongScore).forEach((slug) => {
      scores[slug] = strongScore[slug] + Math.min(weakScore[slug] || 0, WEAK_CAP);
    });

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [topSlug, topScore] = ranked[0];
    const second = ranked[1] || null;
    if (topScore < MIN_TOP_SCORE) return null;
    if (second && topScore < second[1] * MIN_LEAD_RATIO) return null;
    return {
      slug: topSlug,
      score: topScore,
      second: second ? { slug: second[0], score: second[1] } : null,
      scores: Object.fromEntries(ranked.slice(0, 4))
    };
  } catch (err) {
    console.error("Context inference failed (ignored):", err);
    return null;
  }
}

export { sanitizeContext, MAX_CONTEXT_CHARS };
