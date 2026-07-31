// server.js - Geocoding proxy (LocationIQ) + AI query parsing (Groq) with caching
const express = require('express');
const cors = require('cors'); // enable CORS
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

// LocationIQ: free tier, 5,000 requests/day, 2 req/sec.
// Sign up at https://locationiq.com/register to get a key.
const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY || 'YOUR_LOCATIONIQ_KEY_HERE';

// Foursquare Places API: free tier, real-world business search (used for
// building types with no reliable catalog coverage, e.g. real photo
// studios). Sign up at https://foursquare.com/developers to get a key.
const FOURSQUARE_API_KEY = process.env.FOURSQUARE_API_KEY || 'YOUR_FOURSQUARE_KEY_HERE';

// GeoNames: free, independently-maintained global database of named
// geographic features (not just OpenStreetMap's volunteer-mapped data) —
// used as a fallback when Overpass finds nothing for a natural-feature
// search. Free registration (not a real API key, just a username) at
// https://www.geonames.org/login — the shared "demo" username works for
// testing but is aggressively rate-limited; register your own for real use.
const GEONAMES_USERNAME = process.env.GEONAMES_USERNAME || 'demo';

// Groq: free tier, used to parse natural-language location briefs into
// structured filters. Sign up at https://console.groq.com/keys to get a key.
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'YOUR_GROQ_KEY_HERE';
// llama-3.3-70b-versatile was deprecated by Groq on 2026-06-17; this is
// their recommended replacement for that model class.
const GROQ_MODEL = 'openai/gpt-oss-120b';

// Shared courtesy User-Agent for every third-party API this server calls
// (Overpass, Wikipedia, Wikimedia Commons) — all of them ask for one.
const USER_AGENT = 'SceneScout/0.1 (hackathon project; contact: udaya@example.com)';

// In-memory only, intentionally not persisted to disk: this app's typical
// hosts (e.g. Render's free tier) wipe the local filesystem on every
// deploy/restart, so a JSON-file cache was providing zero benefit across
// deploys while still costing disk I/O on every request. Caches still work
// within a single running process, which is what actually matters here —
// short-lived request bursts (e.g. re-rendering the same search).
let cache = {}; // geocode: address -> result

// Serialize all outbound LocationIQ calls through one queue so concurrent
// client requests (e.g. geocoding 20 locations on page load) never exceed
// the free-tier limit of 2 req/sec, no matter how many requests arrive at
// once from the frontend.
let queue = Promise.resolve();
const MIN_INTERVAL = 550; // ms between LocationIQ calls (~1.8/sec, safely under 2/sec)
let lastCall = 0;

function enqueue(fn) {
  const result = queue.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call fails, so one error doesn't
  // stall every request behind it.
  queue = result.catch(() => { });
  return result;
}

app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const address = q.trim();

  // Return cached if available — skips the queue entirely.
  if (cache[address]) return res.json(cache[address]);

  if (!LOCATIONIQ_KEY || LOCATIONIQ_KEY === 'YOUR_KEY_HERE') {
    return res.status(500).json({ error: 'LOCATIONIQ_KEY not set. Get a free key at locationiq.com/register' });
  }

  const url = `https://us1.locationiq.com/v1/search`
    + `?key=${LOCATIONIQ_KEY}`
    + `&format=json&limit=1&countrycodes=us`
    + `&q=${encodeURIComponent(address)}`;

  try {
    const data = await enqueue(async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        // LocationIQ returns 404 for "no match found" — treat that as an
        // empty result, not an error, so the frontend can handle it gracefully.
        if (response.status === 404) return [];
        const err = new Error('LocationIQ error');
        err.status = response.status;
        throw err;
      }
      return response.json();
    });
    cache[address] = data; // cache even empty results
    res.json(data);
  } catch (e) {
    console.error('Geocode proxy error', e);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error' });
  }
});

// ------------------------------------------------------------- Groq parsing
const PARSE_SYSTEM_PROMPT = `You convert a location-scouting brief into structured filters.
Output ONLY a JSON object, no prose, matching exactly this shape:
{
  "types": string[],        // subset of: studio, loft, warehouse, house, rooftop, storefront, gallery, estate
  "styleWords": string[],   // architectural/mood adjectives mentioned, lowercase, e.g. "modern", "industrial", "brick"
  "light": string | null,   // one of "abundant", "moderate", "controlled", or null if not mentioned
  "minSqft": number | null, // minimum square footage implied, or null
  "maxRate": number | null, // max daily rate in USD implied, or null (rate field is per-day; if user gives per-hour, multiply by 10)
  "radiusMi": number | null,// search radius in miles if explicitly stated, or null
  "locationText": string | null, // a city/neighborhood/place name if mentioned, or null
  "naturalFeature": {       // set ONLY if the brief describes a natural/geographic feature
                             // NOT covered by the "types" list above (lake, river, beach, mountain,
                             // forest, waterfall, cliff, canyon, cave, desert, park, island, etc).
                             // If the brief matches one of the building types above instead, set this to null.
    "label": string,        // human-readable name, e.g. "Lake", "River", "Beach", "Mountain Peak"
    "icon": string,         // one emoji representing it
    "osmTags": [{ "key": string, "value": string }],
      // REAL OpenStreetMap tag(s) that identify this feature in Overpass API data.
      // Use your knowledge of actual OSM tagging conventions. Examples:
      //   lake/pond   -> [{"key":"natural","value":"water"}]
      //   river       -> [{"key":"waterway","value":"river"}]
      //   beach       -> [{"key":"natural","value":"beach"}]
      //   mountain/peak -> [{"key":"natural","value":"peak"}]
      //   forest/woods -> [{"key":"natural","value":"wood"}]
      //   waterfall   -> [{"key":"waterway","value":"waterfall"}]
      //   cliff       -> [{"key":"natural","value":"cliff"}]
      //   cave        -> [{"key":"natural","value":"cave_entrance"}]
      //   park        -> [{"key":"leisure","value":"park"}]
      //   island      -> [{"key":"place","value":"island"}]
      // If you are not confident of a real OSM tag for the feature, still make your
      // best guess using natural=* or landuse=* conventions rather than returning null here.
      // IMPORTANT: every entry in this array is AND'd together in the query — an
      // element must match ALL of them. Real-world OSM data is inconsistent about
      // secondary/subtype tags (e.g. many real lakes carry only natural=water with
      // no water=lake sub-tag), so adding one drastically undercounts real matches.
      // Give ONLY the single tag that primarily identifies the feature (as in the
      // examples above) unless a second tag is truly required to distinguish it
      // from something else entirely (e.g. distinguishing a reservoir from a
      // natural lake when the brief is specific about which one it wants).
    "elementTypes": string[], // which OSM element types typically carry this tag: subset of
                               // ["node","way","relation"]. Point features (peaks, waterfalls,
                               // cave entrances) are usually "node". Areas (lakes, forests, parks)
                               // are usually "way" and "relation". Linear features (rivers) are
                               // usually "way". Include all types that could plausibly apply.
    "approxSizeFt": number | null // a target size in FEET (diameter/width/length) if the brief
                                   // gives one, else null — do not invent one. The brief may give
                                   // the size in feet ("300 ft across", "300 feet") or metric
                                   // ("300 m", "300 meters", "300m lake") — convert meters to feet
                                   // (multiply by 3.28084) before returning; this field is always feet.
  }
}
Only include a "types" entry if it's clearly implied. Do not invent details not present in the brief.
If the brief is vague, empty, or matches nothing specific (e.g. a single unrelated word with no
clear feature or building type), return all nulls, empty arrays, and naturalFeature: null —
do not guess a category that isn't actually implied.
A brief that is JUST one of the building types or natural-feature examples listed above ("park",
"river", "lake", "warehouse", ...) is NOT vague — it's an exact, unambiguous match for that single
category. Treat it accordingly instead of second-guessing it as too short to mean anything (e.g.
"park" always means the natural-feature "Park", never "parking").`;

app.post('/api/parse-query', async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Missing query' });
  }

  if (!GROQ_API_KEY || GROQ_API_KEY === 'YOUR_GROQ_KEY_HERE') {
    return res.status(500).json({ error: 'GROQ_API_KEY not set. Get a free key at console.groq.com/keys' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: PARSE_SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
      // Without this, a hung connection to Groq left the client's "Reading…"
      // state stuck forever — nothing ever rejected, so the frontend's own
      // try/finally never ran.
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Groq API error', response.status, errText);
      return res.status(response.status).json({ error: 'Groq API error' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'Empty Groq response' });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error('Failed to parse Groq JSON output', content);
      return res.status(500).json({ error: 'Groq returned invalid JSON' });
    }

    res.json(parsed);
  } catch (e) {
    console.error('Groq proxy error', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------------------------------------- Overpass (lakes)
let overpassCache = {}; // query hash -> parsed result, in-memory only (see note above)
// Two truly concurrent requests for the same query (e.g. a double-click)
// arrive before either has populated the cache — without this, both would
// independently race all four mirrors. Sharing the in-flight promise
// dedupes that without serializing requests for *different* queries.
const overpassInFlight = new Map(); // query hash -> Promise

// Simple hash so we don't store the full query text as a JSON key.
function hashQuery(q) {
  let h = 0;
  for (let i = 0; i < q.length; i++) { h = (h * 31 + q.charCodeAt(i)) | 0; }
  return String(h);
}

// overpass-ts (even at its latest published version, 4.3.8) sends a
// malformed `Accept: *` header instead of `*/*`, which overpass-api.de now
// rejects outright with 406 Not Acceptable. Rather than depend on a small,
// seemingly unmaintained wrapper for what's just a POST endpoint, call it
// directly so we control the headers.
//
// overpass-api.de alone is a single shared free instance that times out
// (504) under its own load. These are meant to be independent, free,
// community-run mirrors of the same full-planet dataset, so racing across
// them means one overloaded mirror can't stall the whole search — but two
// entries that looked like reasonable full-planet mirrors turned out not to
// be, and BOTH were deliberately excluded after being confirmed live:
//   - overpass.openstreetmap.fr serves a France-only regional extract.
//   - overpass.osm.ch returned zero elements for a Los Angeles
//     "natural=water" query AND a plain "amenity=cafe" sanity check near
//     the same point — it has no usable data for that region at all.
// Racing either of these against a full-planet query doesn't error for an
// out-of-region search — they return a valid, successful, silently-empty
// result, and Promise.any happily accepts that as "the" answer, discarding
// whatever a real mirror would have found. overpass.kumi.systems was
// confirmed live to return real results (606 elements) for the same query
// that these two came back empty on.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// 400 (bad query) and 406 fail identically on every mirror — if every mirror
// fails, prefer reporting one of these as the cause over a timeout, since
// it points at the actual problem instead of an incidental slow mirror.
function isOverpassNonRetryable(status) {
  return status === 400 || status === 406;
}

async function fetchOverpassMirror(endpoint, query, timeoutMs) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Overpass (${endpoint}) ${resp.status} ${resp.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Races every mirror in parallel instead of trying them one at a time with
// pauses in between — a sequential retry's worst case was the *sum* of all
// mirrors' timeouts (tens of seconds), which is exactly what made
// natural-feature searches feel broken. Racing bounds the worst case to a
// single timeoutMs, whichever mirror answers first wins, and Overpass's
// "one request at a time" fair-use limit is per-mirror — one request each
// to independent mirrors doesn't violate it.
//
// timeoutMs was originally 9s, tuned back when 4 mirrors were racing and
// only needed one fast responder. Down to 2 confirmed-real mirrors now
// (see OVERPASS_ENDPOINTS' history — two others were dropped for silently
// returning empty results, not for being slow), 9s was too tight and
// caused a live, confirmed timeout on a legitimate query against
// overpass.kumi.systems — the exact mirror a manual test showed returns
// real, correct data given a bit more time. 25s matches the query's own
// [timeout:25] directive, so we're not cutting it off earlier than
// Overpass itself would.
async function overpassJsonWithRetry(query, timeoutMs = 25000) {
  const attempts = OVERPASS_ENDPOINTS.map(endpoint => fetchOverpassMirror(endpoint, query, timeoutMs));
  try {
    return await Promise.any(attempts);
  } catch (e) {
    // AggregateError — every mirror failed. Surface a non-retryable status
    // (bad query, identical everywhere) if any mirror reported one;
    // otherwise report the first failure as representative.
    const errors = e.errors || [e];
    const nonRetryable = errors.find(err => isOverpassNonRetryable(err.status));
    throw nonRetryable || errors[0];
  }
}

// ------------------------------------------------------------ places search
// Real-world businesses (e.g. photo studios) via Foursquare's Places API —
// unlike OpenStreetMap, this is an actual maintained business directory
// with consistent nationwide coverage, not dependent on volunteer mapping
// or fragile community-run query mirrors.
let placesCache = {}; // query hash -> parsed result, in-memory only (see note above)

app.get('/api/places-search', async (req, res) => {
  const { lat, lng, radiusMi, query } = req.query;
  if (!lat || !lng || !query) return res.status(400).json({ error: 'Missing lat/lng/query' });
  if (!FOURSQUARE_API_KEY || FOURSQUARE_API_KEY === 'YOUR_FOURSQUARE_KEY_HERE') {
    return res.status(500).json({ error: 'FOURSQUARE_API_KEY not set. Get a free key at foursquare.com/developers' });
  }

  // Foursquare caps radius at 100,000m; clamp rather than error on a wide search.
  const radiusM = Math.min(100000, Math.round((+radiusMi || 15) * 1609.34));
  const key = 'places:' + hashQuery(`${query}|${(+lat).toFixed(3)},${(+lng).toFixed(3)},${radiusM}`);
  if (placesCache[key]) return res.json(placesCache[key]);

  const url = 'https://api.foursquare.com/v3/places/search?' + new URLSearchParams({
    ll: `${lat},${lng}`,
    radius: String(radiusM),
    query,
    limit: '50',
    // Explicit fields — v3's default response set doesn't reliably include
    // contact info, and we want it for the detail view.
    fields: 'fsq_id,name,geocodes,location,tel,website,categories',
  });

  try {
    const response = await fetch(url, {
      headers: {
        // v3 takes the raw key in this header — no "Bearer" prefix.
        'Authorization': FOURSQUARE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Foursquare ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    const results = (data.results || [])
      .map(p => ({
        id: p.fsq_id,
        name: p.name,
        lat: p.geocodes?.main?.latitude,
        lng: p.geocodes?.main?.longitude,
        address: p.location?.formatted_address || null,
        neighborhood: p.location?.locality || p.location?.region || null,
        phone: p.tel || null,
        website: p.website || null,
      }))
      .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
    placesCache[key] = results;
    res.json(results);
  } catch (e) {
    console.error('Places search error:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error' });
  }
});

// ------------------------------------------------------------- photo search
// Real photos of a location. Two free, official, keyless sources — no
// scraping: Wikimedia Commons first (great hit rate for actual real-world
// places, e.g. natural features, since it's the same project as the
// Wikipedia lookup below), falling back to Openverse (an aggregated
// Creative-Commons-media search covering Flickr/museums/etc.) for the
// fictional curated catalog, where Commons won't have a real match.
let photoCache = {}; // query -> results, in-memory only (see note above)

async function searchCommonsPhotos(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrnamespace: '6', gsrsearch: query, gsrlimit: '12',
    prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: '480',
  });
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  return pages
    .filter(p => p.imageinfo?.[0]?.url)
    .map(p => {
      const info = p.imageinfo[0];
      const title = p.title.replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' ');
      return {
        image: info.url,
        thumbnail: info.thumburl || info.url,
        title,
        source: 'Wikimedia Commons',
        width: info.width, height: info.height,
        url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      };
    });
}

async function searchOpenversePhotos(query) {
  const url = 'https://api.openverse.org/v1/images/?' + new URLSearchParams({
    q: query, page_size: '12', license_type: 'commercial,modification',
  });
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || [])
    .filter(r => r.url)
    .map(r => ({
      image: r.url,
      thumbnail: r.thumbnail || r.url,
      title: r.title || '',
      source: r.source || 'Openverse',
      width: r.width, height: r.height,
      url: r.foreign_landing_url || r.url,
    }));
}

app.get('/api/location-photos', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const trimmed = q.trim();
  // Real natural features (lakes, mountains, ...) skip the Openverse
  // fallback: Openverse is a broad, noisy CC-media aggregator (stock
  // photos, museum/library scans) that's only a reasonable fallback for
  // the fictional catalog, where Commons has zero chance of a real match
  // anyway. For a real place, a generic/unnamed query with no Commons hit
  // has surfaced things like a random digitized library book cover —
  // worse than just showing no photos.
  const natural = req.query.natural === '1';
  const key = 'photos:' + (natural ? 'nat:' : '') + hashQuery(trimmed);
  if (photoCache[key]) return res.json(photoCache[key]);

  try {
    let results = await searchCommonsPhotos(trimmed);
    if (!results.length && !natural) results = await searchOpenversePhotos(trimmed);
    photoCache[key] = results;
    res.json(results);
  } catch (e) {
    console.error('Photo search error', e.message);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

// -------------------------------------------------------------- place info
// Real-world background for natural/geographic features (lakes, parks,
// mountains, ...) via Wikipedia — free, no API key. If the OSM element
// carried a wikipedia=lang:Title tag we fetch that article directly;
// otherwise fall back to a geosearch by coordinates for the nearest
// plausibly-matching article.
let placeInfoCache = {}; // in-memory only (see note above)

async function fetchWikiSummary(lang, title) {
  const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.type === 'disambiguation' || !data.extract) return null;
  return {
    title: data.title,
    extract: data.extract,
    thumbnail: data.thumbnail?.source || null,
    url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

// Finds the nearest Wikipedia article to a coordinate, preferring one whose
// title resembles the feature's OSM name over just taking the closest hit —
// geosearch radius can easily include an unrelated nearby article otherwise.
async function geosearchWikiTitle(lat, lng, name) {
  const res = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json` +
    `&gscoord=${lat}|${lng}&gsradius=8000&gslimit=5`,
    { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const hits = data.query?.geosearch || [];
  if (!hits.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const named = name ? hits.find(h => norm(h.title).includes(norm(name)) || norm(name).includes(norm(h.title))) : null;
  return (named || hits[0]).title;
}

app.get('/api/place-info', async (req, res) => {
  const { lat, lng, name, wikipedia } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const key = 'place:' + hashQuery(`${wikipedia || ''}|${lat}|${lng}|${name || ''}`);
  if (placeInfoCache[key]) return res.json(placeInfoCache[key]);

  try {
    let result = null;
    if (wikipedia && wikipedia.includes(':')) {
      const sep = wikipedia.indexOf(':');
      result = await fetchWikiSummary(wikipedia.slice(0, sep), wikipedia.slice(sep + 1));
    }
    if (!result) {
      const title = await geosearchWikiTitle(+lat, +lng, name);
      if (title) result = await fetchWikiSummary('en', title);
    }
    const payload = result || { found: false };
    placeInfoCache[key] = payload;
    res.json(payload);
  } catch (e) {
    console.error('Place-info lookup failed:', e.message);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

// ---------------------------------------------------------- reverse geocode
// Used by the "explore the globe" click handler — turns a lat/lng the user
// clicked into a human-readable place name. Shares LocationIQ's existing
// cache/queue with the forward-geocode endpoint above.
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });
  if (!LOCATIONIQ_KEY || LOCATIONIQ_KEY === 'YOUR_KEY_HERE') {
    return res.status(500).json({ error: 'LOCATIONIQ_KEY not set' });
  }
  const key = `rev:${(+lat).toFixed(4)},${(+lng).toFixed(4)}`;
  if (cache[key]) return res.json(cache[key]);

  const url = `https://us1.locationiq.com/v1/reverse?key=${LOCATIONIQ_KEY}&lat=${lat}&lon=${lng}&format=json`;
  try {
    const data = await enqueue(async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        if (response.status === 404) return null;
        const err = new Error('LocationIQ reverse error');
        err.status = response.status;
        throw err;
      }
      return response.json();
    });
    cache[key] = data;
    res.json(data);
  } catch (e) {
    console.error('Reverse geocode error', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error' });
  }
});

app.post('/api/overpass', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const key = hashQuery(query);
  if (overpassCache[key]) return res.json(overpassCache[key]);

  try {
    let promise = overpassInFlight.get(key);
    if (!promise) {
      promise = overpassJsonWithRetry(query);
      overpassInFlight.set(key, promise);
      // .finally() here creates its own promise chain, separate from the
      // `promise` variable awaited below — without a .catch(), a rejection
      // would be unhandled on *this* chain and crash the process even
      // though the real error is properly handled where `promise` is
      // awaited further down.
      promise.finally(() => overpassInFlight.delete(key)).catch(() => {});
    }
    const data = await promise;
    overpassCache[key] = data;
    res.json(data);
  } catch (e) {
    console.error('Overpass query failed:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error' });
  }
});

// -------------------------------------------------------------- GeoNames
// Fallback natural-feature source for when Overpass finds nothing (see
// findNaturalFeatures's fallback logic in NaturalFeatures.js). GeoNames
// classifies features into broad classes (H = hydrographic, T = terrain,
// V = vegetation, L = parks/areas, S = spot features) rather than OSM's
// tag system, so there's no exact tag mapping — this guesses a class from
// the feature's label instead, which is good enough to narrow the search
// without excluding a genuine match on a label wording we didn't predict.
let geonamesCache = {}; // query hash -> parsed result, in-memory only (see note above)

function guessGeoNamesFeatureClass(label) {
  const l = (label || '').toLowerCase();
  if (/lake|river|pond|waterfall|stream|beach|bay|reservoir|creek/.test(l)) return 'H';
  if (/mountain|peak|hill|cliff|canyon|ridge|volcano/.test(l)) return 'T';
  if (/forest|wood/.test(l)) return 'V';
  if (/park/.test(l)) return 'L';
  if (/cave/.test(l)) return 'S';
  return null; // no confident mapping — search without restricting by class
}

app.get('/api/geonames-search', async (req, res) => {
  const { lat, lng, radiusMi, label } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  // GeoNames caps findNearby's radius at 300km.
  const radiusKm = Math.min(300, Math.round((+radiusMi || 15) * 1.60934));
  const featureClass = guessGeoNamesFeatureClass(label);
  const key = 'geonames:' + hashQuery(`${label || ''}|${(+lat).toFixed(3)},${(+lng).toFixed(3)},${radiusKm}`);
  if (geonamesCache[key]) return res.json(geonamesCache[key]);

  const params = new URLSearchParams({
    lat, lng, radius: String(radiusKm), maxRows: '50', username: GEONAMES_USERNAME,
  });
  if (featureClass) params.set('featureClass', featureClass);

  try {
    const response = await fetch(`http://api.geonames.org/findNearbyJSON?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const err = new Error(`GeoNames ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    // GeoNames returns 200 OK with a {status:{message,value}} body on its
    // own errors (bad/rate-limited username, etc.) instead of an HTTP
    // error status — has to be checked explicitly.
    if (data.status) throw new Error(`GeoNames: ${data.status.message}`);
    const results = (data.geonames || []).map(g => ({
      id: String(g.geonameId), name: g.name || null,
      lat: +g.lat, lng: +g.lng,
      countryName: g.countryName || null,
      adminName: g.adminName1 || null,
    })).filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lng));
    geonamesCache[key] = results;
    res.json(results);
  } catch (e) {
    console.error('GeoNames search error:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error' });
  }
});

// ----------------------------------------------------------- bundled catalog
// Locations derived from the Zillow US House Listings 2023 Kaggle dataset
// (febinphilips/us-house-listings-2023). Processed once by
// scripts/build-catalog.js and committed as data/locations.json — zero
// runtime dependency on Kaggle or any external property API.
//
// Floor plans are stored as 8 type-keyed templates (not repeated per-location
// in the JSON) and injected server-side so the client always gets fully-formed
// location objects identical in shape to the old catalog.js output.
const CATALOG_PATH = path.join(__dirname, 'data', 'locations.json');

const FLOOR_PLAN_TEMPLATES = {
  studio: {
    rooms: [
      { name: 'Stage',        x: 0,  z: 0,   w: 18, d: 14,  h: 6,   style: 'studio' },
      { name: 'Control Room', x: 18, z: 0,   w: 6,  d: 5,   h: 3,   style: 'control', win: { e: 1 } },
      { name: 'Makeup',       x: 18, z: 5,   w: 6,  d: 4.5, h: 3,   style: 'makeup',  win: { e: 1 } },
      { name: 'Lounge',       x: 18, z: 9.5, w: 6,  d: 4.5, h: 3,   style: 'lounge',  win: { e: 1, s: 1 } },
    ],
    doors: [
      { x: 18, z: 2.5, dir: 'v', width: 1.6 },
      { x: 18, z: 7.2, dir: 'v', width: 1.4 },
      { x: 21, z: 5,   dir: 'h', width: 1.2 },
    ],
  },
  warehouse: {
    rooms: [
      { name: 'Main Floor', x: 0,  z: 0, w: 30, d: 24, h: 7,   style: 'warehouse', win: { n: 3 }, sky: 4 },
      { name: 'Office',     x: 30, z: 0, w: 8,  d: 6,  h: 3,   style: 'office',    win: { e: 2, n: 1 } },
      { name: 'Workshop',   x: 30, z: 6, w: 8,  d: 9,  h: 3.5, style: 'shop',      win: { e: 2 } },
    ],
    doors: [
      { x: 30, z: 3,  dir: 'v', width: 1.8 },
      { x: 30, z: 10, dir: 'v', width: 2.4 },
      { x: 34, z: 6,  dir: 'h', width: 1.4 },
    ],
  },
  loft: {
    rooms: [
      { name: 'Main Loft',   x: 0,  z: 0, w: 15, d: 12, h: 4.3, style: 'loft',    win: { n: 4, w: 3 }, sky: 2 },
      { name: 'Kitchenette', x: 15, z: 0, w: 5,  d: 6,  h: 3.2, style: 'kitchen', win: { n: 1, e: 1 } },
      { name: 'Green Room',  x: 15, z: 6, w: 5,  d: 6,  h: 3.2, style: 'lounge',  win: { e: 1, s: 1 } },
    ],
    doors: [
      { x: 15, z: 3,   dir: 'v', width: 1.6 },
      { x: 15, z: 9,   dir: 'v', width: 1.6 },
      { x: 17.5, z: 6, dir: 'h', width: 1.2 },
    ],
  },
  house: {
    rooms: [
      { name: 'Living Room', x: 0, z: 0,   w: 6, d: 5,   h: 2.9, style: 'living',  win: { n: 2, w: 1 } },
      { name: 'Kitchen',     x: 6, z: 0,   w: 5, d: 5,   h: 2.9, style: 'kitchen', win: { n: 1, e: 1 } },
      { name: 'Bedroom',     x: 0, z: 5,   w: 6, d: 4.5, h: 2.9, style: 'bed',     win: { w: 1, s: 2 } },
      { name: 'Studio Room', x: 6, z: 5,   w: 5, d: 4.5, h: 2.9, style: 'office',  win: { s: 1, e: 1 } },
    ],
    doors: [
      { x: 6,   z: 2.2, dir: 'v', width: 1.3 },
      { x: 2.8, z: 5,   dir: 'h', width: 1.2 },
      { x: 8.6, z: 5,   dir: 'h', width: 1.2 },
    ],
  },
  estate: {
    rooms: [
      { name: 'Ballroom',     x: 0,  z: 0, w: 12, d: 9, h: 4.6, style: 'ballroom',     win: { n: 4, w: 2 } },
      { name: 'Foyer',        x: 12, z: 0, w: 6,  d: 9, h: 4.6, style: 'foyer',        win: { n: 2 } },
      { name: 'Library',      x: 18, z: 0, w: 6,  d: 5, h: 3.4, style: 'library',      win: { n: 1, e: 1 } },
      { name: 'Dining Room',  x: 18, z: 5, w: 6,  d: 4, h: 3.4, style: 'dining',       win: { e: 1, s: 1 } },
      { name: 'Conservatory', x: 12, z: 9, w: 6,  d: 5, h: 3.6, style: 'conservatory', win: { s: 2, e: 2 }, sky: 2 },
    ],
    doors: [
      { x: 12, z: 4.5, dir: 'v', width: 2.2 },
      { x: 18, z: 2.5, dir: 'v', width: 1.5 },
      { x: 21, z: 5,   dir: 'h', width: 1.3 },
      { x: 18, z: 7,   dir: 'v', width: 1.4 },
      { x: 15, z: 9,   dir: 'h', width: 1.8 },
    ],
  },
  rooftop: {
    rooms: [
      { name: 'Main Deck',        x: 0,  z: 0, w: 14, d: 9, h: 1.1, style: 'deck',   open: true },
      { name: 'West Deck',        x: 14, z: 4, w: 6,  d: 5, h: 1.1, style: 'deck',   open: true },
      { name: 'Penthouse Lounge', x: 14, z: 0, w: 6,  d: 4, h: 3,   style: 'lounge', win: { n: 2, e: 1 } },
    ],
    doors: [
      { x: 14, z: 2,   dir: 'v', width: 1.6 },
      { x: 14, z: 6.5, dir: 'v', width: 5   },
      { x: 17, z: 4,   dir: 'h', width: 1.4 },
    ],
  },
  storefront: {
    rooms: [
      { name: 'Bar Room',    x: 0, z: 0, w: 12, d: 8, h: 3.6, style: 'bar',     win: { n: 3 } },
      { name: 'Back Lounge', x: 0, z: 8, w: 7,  d: 6, h: 3.2, style: 'lounge',  win: { w: 1 } },
      { name: 'Kitchen',     x: 7, z: 8, w: 5,  d: 6, h: 3.2, style: 'kitchen', win: { s: 1, e: 1 } },
    ],
    doors: [
      { x: 3.5, z: 8, dir: 'h', width: 1.6 },
      { x: 9,   z: 8, dir: 'h', width: 1.4 },
      { x: 7,   z: 11, dir: 'v', width: 1.2 },
    ],
  },
  gallery: {
    rooms: [
      { name: 'Gallery A',    x: 0,  z: 0, w: 12, d: 9, h: 4.2, style: 'gallery', win: { n: 1 }, sky: 3 },
      { name: 'Gallery B',    x: 12, z: 0, w: 8,  d: 9, h: 4.2, style: 'gallery', sky: 2 },
      { name: 'Project Room', x: 0,  z: 9, w: 6,  d: 5, h: 3.2, style: 'office',  win: { s: 1, w: 1 } },
    ],
    doors: [
      { x: 12, z: 4.5, dir: 'v', width: 2.6 },
      { x: 3,  z: 9,   dir: 'h', width: 1.8 },
    ],
  },
};

// Load and augment the catalog once at startup — no per-request I/O.
let CATALOG = null;
function loadCatalog() {
  if (CATALOG) return CATALOG;
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    // Inject floor plans by type (they were stripped from the JSON to save size)
    CATALOG = raw.map(loc => {
      if (!loc.floorplan && FLOOR_PLAN_TEMPLATES[loc.type]) {
        return { ...loc, floorplan: FLOOR_PLAN_TEMPLATES[loc.type] };
      }
      return loc;
    });
    console.log(`[catalog] Loaded ${CATALOG.length} locations from ${CATALOG_PATH}`);
  } catch (e) {
    console.error('[catalog] Failed to load locations.json:', e.message);
    CATALOG = [];
  }
  return CATALOG;
}

app.get('/api/locations', (req, res) => {
  res.json(loadCatalog());
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '')));

const server = app.listen(PORT, () =>
  console.log(`Geocode proxy listening on http://localhost:${PORT}`)
);

// Ensure Ctrl+C actually releases the port (avoids EADDRINUSE on restart)
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});