// Natural-language query parser. Turns a prompt like "modern industrial
// warehouse with large windows near downtown Chicago under $500/day" into a
// structured intent object that drives the filters and the suitability score.
//
// parseQuery() now calls a Groq-backed /api/parse-query endpoint for real
// language understanding (handles things like "somewhere near water" or
// "moody and cinematic" that the old lexicon-only matcher couldn't). If
// Groq is unavailable (no key, network error, bad response), it falls back
// to the original offline rules parser (parseQueryLocal) so search never
// breaks entirely.

import { TYPES } from './catalog.js';

const TYPE_LEXICON = {
  studio: ['studio', 'sound stage', 'soundstage', 'stage', 'cyc', 'photo studio', 'shooting space'],
  loft: ['loft', 'industrial space', 'brick loft', 'artist loft'],
  warehouse: ['warehouse', 'industrial warehouse', 'factory', 'hangar', 'garage'],
  house: ['house', 'home', 'bungalow', 'craftsman', 'cottage', 'residence', 'residential', 'suburban', 'ranch', 'apartment'],
  rooftop: ['rooftop', 'roof deck', 'terrace', 'roof top', 'penthouse'],
  storefront: ['storefront', 'bar', 'cafe', 'coffee shop', 'coffee', 'diner', 'restaurant', 'shop', 'retail', 'pub', 'saloon'],
  gallery: ['gallery', 'white box', 'white-box', 'art space', 'showroom'],
  estate: ['estate', 'mansion', 'ballroom', 'manor', 'villa', 'chateau', 'palace'],
};

// mood / architectural style vocabulary — matched against tags + descriptions
const STYLE_WORDS = [
  'modern', 'industrial', 'victorian', 'mid-century', 'midcentury', 'rustic', 'vintage',
  'minimalist', 'minimal', 'brick', 'exposed brick', 'concrete', 'wood', 'warm', 'moody',
  'bright', 'airy', 'gothic', 'art deco', 'contemporary', 'period', 'ornate', 'neon',
  'glass', 'brutalist', 'coastal', 'desert', 'bohemian', 'clean', 'grand', 'cozy',
  'elegant', 'raw', 'polished', 'skyline', 'garden', '1920s', '1950s', '1970s', '1980s', '1990s',
];

const LIGHT_ABUNDANT = ['natural light', 'daylight', 'sunny', 'bright', 'sunlight', 'big windows', 'large windows', 'huge windows', 'wall of windows', 'lots of light', 'airy', 'golden hour', 'sun-drenched'];
const LIGHT_CONTROLLED = ['blackout', 'black out', 'controlled light', 'no windows', 'dark', 'night interior', 'light control', 'windowless'];

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// A small offline fallback for the most common natural/geographic features,
// so single-word queries like "lake" or "river" still trigger a live
// OpenStreetMap search even when Groq is unavailable. Groq (parseQuery's
// primary path) covers a far wider vocabulary and infers real OSM tags on
// the fly — this list exists only so search doesn't go completely blind on
// the common cases when no key is configured. Shape matches PARSE_SYSTEM_PROMPT's
// naturalFeature schema in server.js exactly, so NaturalFeatures.js can
// consume either source identically.
const NATURAL_FEATURE_LEXICON = [
  { words: ['lake', 'pond', 'reservoir'], feature: { label: 'Lake', icon: '🏞️', osmTags: [{ key: 'natural', value: 'water' }], elementTypes: ['way', 'relation'] } },
  { words: ['river', 'creek', 'stream'], feature: { label: 'River', icon: '🌊', osmTags: [{ key: 'waterway', value: 'river' }], elementTypes: ['way'] } },
  { words: ['beach', 'shoreline', 'seashore'], feature: { label: 'Beach', icon: '🏖️', osmTags: [{ key: 'natural', value: 'beach' }], elementTypes: ['way', 'node'] } },
  { words: ['mountain', 'peak', 'summit'], feature: { label: 'Mountain Peak', icon: '⛰️', osmTags: [{ key: 'natural', value: 'peak' }], elementTypes: ['node'] } },
  { words: ['forest', 'woods', 'woodland'], feature: { label: 'Forest', icon: '🌲', osmTags: [{ key: 'natural', value: 'wood' }], elementTypes: ['way', 'relation'] } },
  { words: ['waterfall', 'falls'], feature: { label: 'Waterfall', icon: '💧', osmTags: [{ key: 'waterway', value: 'waterfall' }], elementTypes: ['node', 'way'] } },
  { words: ['cliff', 'bluff'], feature: { label: 'Cliff', icon: '🧗', osmTags: [{ key: 'natural', value: 'cliff' }], elementTypes: ['way', 'node'] } },
  { words: ['cave'], feature: { label: 'Cave', icon: '🕳️', osmTags: [{ key: 'natural', value: 'cave_entrance' }], elementTypes: ['node'] } },
  { words: ['park'], feature: { label: 'Park', icon: '🌳', osmTags: [{ key: 'leisure', value: 'park' }], elementTypes: ['way', 'relation'] } },
  { words: ['island'], feature: { label: 'Island', icon: '🏝️', osmTags: [{ key: 'place', value: 'island' }], elementTypes: ['node', 'way'] } },
];

function matchAny(text, phrases) {
  for (const p of phrases) if (text.includes(p)) return p;
  return null;
}

const M_TO_FT = 3.28084;

// Pulls a size like "300 ft", "300ft", "300 feet", "300 m", "300 meters"
// out of a natural-feature query, converting meters to feet since that's
// what NaturalFeatures.js's toleranceFt comparison expects. Returns null if
// no size is mentioned — do not invent one.
function parseApproxSizeFt(text) {
  const m = text.match(/(\d{2,6})\s?(ft|feet|foot|m|meters?|metres?)\b/);
  if (!m) return null;
  const amt = +m[1];
  const isMetric = /^m(eters?|etres?)?$/.test(m[2]);
  return isMetric ? Math.round(amt * M_TO_FT) : amt;
}

// The original rules-based parser — kept as a synchronous fallback for when
// Groq is unavailable (no key set, network error, rate limit, bad JSON, etc).
function parseQueryLocal(raw) {
  const text = ' ' + raw.toLowerCase().trim() + ' ';
  const out = {
    raw: raw.trim(),
    types: new Set(),
    styleWords: [],
    light: null,          // 'abundant' | 'moderate' | 'controlled' | null
    minSqft: null,
    maxRate: null,        // hourly
    radiusMi: null,
    locationText: null,
    naturalFeature: null, // set below from NATURAL_FEATURE_LEXICON if matched; Groq covers far more
    interpreted: [],      // human-readable chips
  };
  if (!out.raw) return out;

  // ---- types
  for (const [key, words] of Object.entries(TYPE_LEXICON)) {
    if (matchAny(text, words.map(w => ' ' + w))) out.types.add(key);
  }

  // ---- style / mood words
  for (const s of STYLE_WORDS) if (text.includes(s)) out.styleWords.push(s);
  out.styleWords = [...new Set(out.styleWords)];

  // ---- natural feature (offline fallback lexicon — only used when Groq is
  // unavailable; a building-type match above still takes precedence for
  // compound queries like "lake house" since types isn't cleared here)
  if (!out.types.size) {
    for (const entry of NATURAL_FEATURE_LEXICON) {
      if (matchAny(text, entry.words.map(w => ' ' + w))) {
        // Clone — entry.feature is a shared constant, and approxSizeFt below
        // is per-query, so mutating it directly would leak across searches.
        out.naturalFeature = { ...entry.feature, approxSizeFt: parseApproxSizeFt(text) };
        break;
      }
    }
  }

  // ---- natural light
  if (matchAny(text, LIGHT_CONTROLLED)) out.light = 'controlled';
  else if (matchAny(text, LIGHT_ABUNDANT)) out.light = 'abundant';
  else if (text.includes('moody') || text.includes('warm light') || text.includes('soft light')) out.light = 'moderate';

  // ---- budget:  "$800/day", "under $500", "$300 an hour", "budget", "cheap"
  let m = text.match(/\$?\s?(\d{2,5})\s?(?:\/|\s?(?:per\s)?)?\s?(day|d\b|hour|hr|h\b)/);
  if (m) {
    const amt = +m[1];
    out.maxRate = /d/.test(m[2]) ? Math.round(amt / 10) : amt;   // ~10 shoot-hours/day
  } else if ((m = text.match(/(?:under|below|less than|max|budget of|up to)\s+\$?\s?(\d{2,5})/))) {
    out.maxRate = Math.round(+m[1] / 10 > 60 ? +m[1] / 10 : +m[1]); // assume /day if large
  } else if (/\b(cheap|affordable|budget|inexpensive|low[- ]cost)\b/.test(text)) {
    out.maxRate = 200;
  } else if (/\b(premium|high[- ]end|luxury|top[- ]tier)\b/.test(text)) {
    out.maxRate = null;
  }

  // ---- size
  m = text.match(/(\d{3,6})\s?(?:sq\.?\s?ft|square\s?f(?:ee|oo)t|sf)\b/);
  if (m) out.minSqft = +m[1];
  else if (/\b(huge|massive|enormous|cavernous|expansive|very large|large scale)\b/.test(text)) out.minSqft = 5000;
  else if (/\b(large|spacious|big|roomy)\b/.test(text)) out.minSqft = 3500;
  else if (/\b(small|intimate|cozy|compact|tiny)\b/.test(text)) out.minSqft = null; // no lower bound

  // crew size -> implied square footage
  m = text.match(/(?:crew of|fits?|hold[s]?|up to)\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)/);
  if (m) {
    const n = NUM_WORDS[m[1]] || +m[1];
    if (n) out.minSqft = Math.max(out.minSqft || 0, n * 45);
  }

  // ---- radius:  "within 10 miles", "5 mi radius"
  m = text.match(/(?:within|inside|radius of|within a)\s+(\d{1,3})\s?(?:mi|mile)/) || text.match(/(\d{1,3})\s?(?:mi|mile)s?\s+(?:radius|of)/);
  if (m) out.radiusMi = Math.min(60, +m[1]);

  // ---- location:  "near/in/around/close to <place>"
  m = raw.match(/\b(?:near|in|around|close to|by|outside|downtown|within .* of)\s+([A-Za-z][A-Za-z .,'-]{2,40})/i);
  if (m) {
    let place = m[1].trim().replace(/\b(under|with|that|and|for|the space|a space)\b.*$/i, '').trim();
    place = place.replace(/[.,]+$/, '').trim();
    // "downtown X" geocodes unreliably (Nominatim can match a street named X in
    // another city), so resolve on the city/place itself.
    place = place.replace(/^downtown\s+/i, '').trim();
    if (place.length >= 3 && !/^(a|an|the)$/i.test(place)) {
      out.locationText = place;
    }
  }

  // ---- build the "interpreted as" chips
  out.interpreted = buildInterpretedChips(out);

  return out;
}

// Builds the "interpreted as" chips array from a parsed-filter object,
// regardless of whether it came from Groq or the local rules parser.
function buildInterpretedChips(out) {
  const chips = [];
  for (const t of out.types) if (TYPES[t]) chips.push(`${TYPES[t].icon} ${TYPES[t].label}`);
  if (out.naturalFeature) {
    chips.push(`${out.naturalFeature.icon || '📍'} ${out.naturalFeature.label}`);
    if (out.naturalFeature.approxSizeFt) chips.push(`📏 ~${out.naturalFeature.approxSizeFt.toLocaleString()} ft across`);
  }
  if (out.light) chips.push(`💡 ${out.light} light`);
  if (out.minSqft) chips.push(`📐 ${out.minSqft.toLocaleString()}+ ft²`);
  if (out.maxRate) chips.push(`💵 ≤ $${out.maxRate}/hr`);
  if (out.radiusMi) chips.push(`📍 ${out.radiusMi} mi radius`);
  if (out.locationText) chips.push(`🗺 ${out.locationText}`);
  for (const s of out.styleWords.slice(0, 4)) chips.push(`✨ ${s}`);
  return chips;
}

// Public entry point. Tries Groq first (real language understanding — "a
// place near water", "somewhere moody and cinematic" work, not just exact
// lexicon matches). Falls back to the offline rules parser on any failure
// (no key set, network error, rate limit, malformed response) so search
// never breaks entirely if Groq is down or unconfigured.
export async function parseQuery(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return parseQueryLocal(raw || '');

  try {
    const res = await fetch('/api/parse-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: trimmed }),
      // The server already bounds its own Groq call to 15s; this is
      // defense in depth so a hung connection to our own server can't
      // leave the search button stuck on "Reading…" forever.
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`parse-query failed: ${res.status}`);
    const data = await res.json();

    const out = {
      raw: trimmed,
      types: new Set(Array.isArray(data.types) ? data.types.filter(t => TYPES[t]) : []),
      styleWords: Array.isArray(data.styleWords) ? data.styleWords : [],
      light: data.light || null,
      minSqft: typeof data.minSqft === 'number' ? data.minSqft : null,
      maxRate: typeof data.maxRate === 'number' ? data.maxRate : null,
      radiusMi: typeof data.radiusMi === 'number' ? data.radiusMi : null,
      locationText: data.locationText || null,
      naturalFeature: (data.naturalFeature && Array.isArray(data.naturalFeature.osmTags) && data.naturalFeature.osmTags.length)
        ? data.naturalFeature
        : null,
      interpreted: [],
    };

    // Groq sometimes plays it safe on a short, single-word brief ("park",
    // "river", ...) and returns everything null/empty even though it's an
    // exact hit in NATURAL_FEATURE_LEXICON/TYPE_LEXICON below — e.g. "park"
    // read as ambiguous (parking?) rather than the natural-feature example
    // the system prompt explicitly lists. Only step in when Groq truly found
    // nothing to work with; a real Groq match (even a partial one) is never
    // second-guessed.
    if (!out.types.size && !out.naturalFeature) {
      const local = parseQueryLocal(raw);
      if (local.types.size) out.types = local.types;
      if (local.naturalFeature) out.naturalFeature = local.naturalFeature;
    }

    out.interpreted = buildInterpretedChips(out);
    return out;
  } catch (e) {
    console.warn('[nlp] Groq parse failed, falling back to local parser:', e.message);
    return parseQueryLocal(raw);
  }
}