// SceneScout — AI search, nationwide discovery, suitability scoring, production
// intelligence, review summaries, and the 2D / 3D map toggle. Orchestration
// only; the heavy lifting lives in the focused modules it imports.

// LOCATIONS is populated at startup by loadCatalog() from /api/locations,
// which serves data/locations.json — real US property records from the Zillow
// US House Listings 2023 Kaggle dataset. It starts empty; the app shows the
// "search to see locations" placeholder until the fetch resolves.
let LOCATIONS = [];
import { TYPES, CENTERS, LIGHT_LABELS } from './catalog.js';
import { initMap, updateMap, flyToListing, fitToRadius, setSelectedMarker, clearSelectedMarker, setSatellite, isSatellite } from './map.js';
import { drawPlanThumb, drawIsoHero } from './thumbs.js';
import { openTour } from './tour.js';
import { DEBUG_LOCATIONS } from './floorplanGen.js';
import { parseQuery } from './nlp.js';
import { computeSuitability } from './score.js';
import { sunTimes, sunPosition, fmtTime, fmtTimeAt, tzAbbr, compass, geocode, forecast, weatherText, fetchLocationPhotos, fetchPlaceInfo, reverseGeocode } from './intel.js';
import { ensure3D, resize3D, update3D, flyHome3D, flyToListing3D, setGlobeMode, flyToGlobalView, startGlobeSpin, stopGlobeSpin, showStarfield, hideStarfield } from './map3d.js';
import { findNaturalFeatures } from './NaturalFeatures.js';
import { findRealPlaces } from './RealPlaces.js';

// Building types for which real-world results can be pulled from
// Foursquare's Places API in addition to the curated catalog. Not every
// catalog type maps cleanly onto a real, searchable business category
// (there's no real-world equivalent of "rentable film/production space" as
// its own business type), so this starts with just the ones that do.
const REAL_SEARCHABLE_TYPES = {
  studio: { label: 'Studio', searchQuery: 'photography studio' },
};

const KEY_STORAGE = 'scenescout-gmaps-key';
// Free public client token — register at mapillary.com/dashboard.
// This is a client-side public token by design, unlike the Groq/LocationIQ
// keys which stay server-side only.
const MAPILLARY_TOKEN = 'YOUR_MAPILLARY_CLIENT_TOKEN';
let mapillaryViewer = null; // tracks the active viewer instance so we can tear it down cleanly

// This project has no bundler — app.js and its sibling modules are loaded as
// plain browser ES modules (see the relative './xyz.js' imports throughout).
// A bare `import ... from 'mapillary-js'` can't resolve here the way it
// would with Vite/webpack. Instead, lazy-load the library from a CDN the
// same way map3d.js already does for MapLibre GL — script/link tags, then
// use the global `mapillary` object the UMD build attaches to `window`.
const MAPILLARY_JS = 'https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.js';
const MAPILLARY_CSS = 'https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.css';
let mapillaryLoadPromise = null;

function loadMapillaryLib() {
  if (window.mapillary) return Promise.resolve();
  if (mapillaryLoadPromise) return mapillaryLoadPromise;
  mapillaryLoadPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = MAPILLARY_CSS;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = MAPILLARY_JS;
    s.onload = resolve;
    s.onerror = () => reject(new Error('mapillary-js load failed'));
    document.head.appendChild(s);
  });
  return mapillaryLoadPromise;
}

// Dynamic natural-feature results (lakes, rivers, mountains, whatever Groq
// identifies) live outside LOCATIONS since they're fetched live from
// OpenStreetMap per search, not part of the curated catalog.
let dynamicLocations = [];
let dynamicSearchKey = ''; // dedupe: avoid re-fetching for an unchanged view

// Same idea as dynamicLocations/dynamicSearchKey above, but for real
// businesses matching a selected building-type filter (see
// REAL_SEARCHABLE_TYPES) rather than a Groq-detected natural feature.
let dynamicTypeLocations = [];
let dynamicTypeSearchKey = '';

const state = {
  center: { lat: CENTERS[0].lat, lng: CENTERS[0].lng },
  centerName: CENTERS[0].name,
  radiusMi: 15,
  types: new Set(),
  minSqft: 0,
  maxRate: Infinity,
  light: 'any',
  sort: 'match',
  query: null,     // parsed NLP intent, feeds the suitability score
  dynamicFeature: null, // Groq-detected natural feature spec (lake/river/etc), or null
  view: '2d',
  hasSearched: false, // true once the user runs an AI search or picks a type filter — the map/results start empty, not pre-loaded with the full catalog
};

const EXAMPLES = [
  'Modern industrial warehouse with large windows near downtown Chicago',
  'Victorian mansion with formal gardens, under $800/day',
  'Coffee shop with warm lighting and exposed brick in Austin',
  'Blackout sound stage that fits a crew of 40 in Atlanta',
  'Bright mid-century house with walls of glass in Seattle',
];

// -------------------------------------------------------- immersive modes
// Retracts the letterbox bars when the user enters any full-viewport or
// on-location viewing mode (3D map, street view, the 3D tour) — several
// of these can be active independently, so track reasons in a set rather
// than a single flag.
const immersiveReasons = new Set();
function setImmersive(reason, active) {
  if (active) immersiveReasons.add(reason); else immersiveReasons.delete(reason);
  const on = immersiveReasons.size > 0;
  document.getElementById('letterbox-top')?.classList.toggle('retracted', on);
  document.getElementById('letterbox-bottom')?.classList.toggle('retracted', on);
}

// -------------------------------------------------------- iris transition
// The one deliberate motion moment on search submit — plays over the map
// viewport, decoupled from the actual search timing so a slow network
// call never leaves the shutter hanging closed.
function playIrisTransition() {
  const el = document.getElementById('iris-transition');
  if (!el) return;
  el.classList.remove('play');
  void el.offsetWidth; // restart the animation if it's still mid-play
  el.classList.add('play');
}

// ------------------------------------------------------------- search core
function haversineMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// computeSuitability was written for curated catalog locations; wrap it so
// a lake (or any future non-standard location shape) can't crash search —
// falls back to a neutral score instead of throwing.
function safeSuitability(loc, st, query) {
  try {
    return computeSuitability(loc, st, query);
  } catch (e) {
    console.warn('[score] computeSuitability failed for', loc.id, e.message);
    return { overall: 50, confidence: 'low', breakdown: [] };
  }
}

function runSearch() {
  if (!state.hasSearched) return [];
  const results = [];
  // Dynamic feature results (from Groq's natural-feature detection) are
  // included whenever one is active — independent of the building-type chips,
  // since "lake" or "mountain" isn't a concept those chips represent.
  // dynamicTypeLocations (real businesses for a selected type filter, e.g.
  // real photo studios) already carries a proper TYPES key, so the type
  // filter below applies to them exactly like the curated catalog.
  const candidates = [
    ...LOCATIONS,
    ...(state.dynamicFeature ? dynamicLocations : []),
    ...dynamicTypeLocations,
  ];
  const wantedTypes = new Set([...state.types, ...(state.query ? state.query.types : [])]);

  for (const loc of candidates) {
    const distMi = haversineMi(state.center.lat, state.center.lng, loc.lat, loc.lng);
    if (distMi > state.radiusMi) continue;
    // Type/size/budget are hard filters — a location that doesn't clear them
    // isn't shown at all, not just ranked lower. (Light stays a soft
    // ranking signal in score.js; it's more a preference than a pass/fail.)
    // A dynamic feature (lake, mountain, ...) has no building type to match
    // against, so a type filter doesn't apply to it — only to the catalog.
    if (wantedTypes.size && TYPES[loc.type] && !wantedTypes.has(loc.type)) continue;
    if (state.minSqft && loc.sqft < state.minSqft) continue;
    if (isFinite(state.maxRate) && loc.rate > state.maxRate) continue;
    const suit = safeSuitability(loc, state, state.query);
    results.push({ ...loc, distMi, score: suit.overall, suit });
  }
  const sorters = {
    match: (a, b) => b.score - a.score || a.distMi - b.distMi,
    distance: (a, b) => a.distMi - b.distMi,
    price: (a, b) => a.rate - b.rate,
    size: (a, b) => b.sqft - a.sqft,
  };
  results.sort(sorters[state.sort]);
  return results;
}

// Of the current results, which ones actually match what was specifically
// searched for (an explicit building type — from a chip or the AI parse —
// or a detected natural feature like "river")? runSearch()'s type filter
// only excludes non-matching *building* types when a type is wanted; a
// feature search like "river" leaves wantedTypes empty, so every catalog
// building within radius still comes back as a "result" even though the
// user only asked about rivers. This narrows that down so the map can light
// up just the on-topic pins and dim the rest — for every kind of search,
// not just building-type ones.
function computeSearchTargetIds(results) {
  const wantedTypes = new Set([...state.types, ...(state.query ? state.query.types : [])]);
  const hasFeature = !!state.dynamicFeature;
  // Nothing specific was asked for (a purely descriptive/style/budget query)
  // — there's no on-topic subset to narrow to, so every result counts.
  if (!wantedTypes.size && !hasFeature) return new Set(results.map(r => r.id));

  const ids = new Set();
  for (const r of results) {
    if (hasFeature && !TYPES[r.type]) ids.add(r.id); // matches the searched-for natural feature
    else if (wantedTypes.size && TYPES[r.type] && wantedTypes.has(r.type)) ids.add(r.id);
  }
  return ids;
}

// Fetches results for the current dynamic feature (if any) + center/radius,
// unless we've already fetched for this exact view. Fire-and-forget from
// render() — re-renders once results land rather than blocking the current
// render on a network call.
let dynamicFetchInFlight = false;

async function refreshDynamicFeatureIfNeeded() {
  if (!state.dynamicFeature) { dynamicLocations = []; dynamicSearchKey = ''; dynamicFetchInFlight = false; return; }

  const key = JSON.stringify(state.dynamicFeature) +
    `|${state.center.lat.toFixed(3)},${state.center.lng.toFixed(3)},${state.radiusMi}`;
  if (key === dynamicSearchKey) return; // already fetched for this view
  dynamicSearchKey = key;

  // Setting this (and dynamicSearchKey above) runs synchronously before the
  // await below yields, so the render() call that triggered this — still
  // unwinding its own call stack — already sees dynamicFetchInFlight=true.
  dynamicFetchInFlight = true;
  const found = await findNaturalFeatures(state.center, state.radiusMi, state.dynamicFeature);
  dynamicFetchInFlight = false;
  // Guard against a stale response landing after the user changed the query
  // or moved again — only apply if we're still looking at the same view.
  if (dynamicSearchKey === key) {
    dynamicLocations = found;
    render();
  }
}

// Same fetch-if-view-changed pattern as refreshDynamicFeatureIfNeeded, for
// real-world businesses (via Foursquare) matching whichever selected type
// filters have a real, searchable business category (see
// REAL_SEARCHABLE_TYPES). Multiple such types could be selected at once,
// so this fetches each independently and merges.
let dynamicTypeFetchInFlight = false;

async function refreshDynamicTypesIfNeeded() {
  const activeTypes = [...state.types].filter(t => REAL_SEARCHABLE_TYPES[t]).sort();
  if (!activeTypes.length) { dynamicTypeLocations = []; dynamicTypeSearchKey = ''; dynamicTypeFetchInFlight = false; return; }

  const key = JSON.stringify(activeTypes) +
    `|${state.center.lat.toFixed(3)},${state.center.lng.toFixed(3)},${state.radiusMi}`;
  if (key === dynamicTypeSearchKey) return; // already fetched for this view
  dynamicTypeSearchKey = key;

  dynamicTypeFetchInFlight = true;
  const batches = await Promise.all(
    activeTypes.map(t => findRealPlaces(state.center, state.radiusMi, t, REAL_SEARCHABLE_TYPES[t]))
  );
  dynamicTypeFetchInFlight = false;
  if (dynamicTypeSearchKey === key) {
    dynamicTypeLocations = batches.flat();
    render();
  }
}

// TYPES only covers curated building categories; dynamic features (lake,
// river, mountain, ...) carry their own display info on the object itself.
// Every place that needs a type's icon/label/color should go through this.
function typeInfo(loc) {
  return TYPES[loc.type] || { icon: loc._icon || '📍', label: loc._label || 'Location', color: loc._color || '#7a8a99' };
}

// ---------------------------------------------------------------- results
function render() {
  refreshDynamicFeatureIfNeeded(); // fire-and-forget; re-renders itself once data lands
  refreshDynamicTypesIfNeeded();   // same, for real-business type searches (e.g. real studios)
  const results = runSearch();

  // Natural features (lakes, mountains, ...) still come from OpenStreetMap;
  // type searches (e.g. real studios) come from Foursquare — say whichever
  // is actually true rather than a source name for both.
  const loadingSource = dynamicFetchInFlight ? 'OpenStreetMap' : 'Foursquare';
  const loadingLabel = dynamicFetchInFlight
    ? `“${state.dynamicFeature.label}”`
    : [...state.types].filter(t => REAL_SEARCHABLE_TYPES[t]).map(t => `“${TYPES[t].label}”`).join(' + ');
  const anyFetchInFlight = dynamicFetchInFlight || dynamicTypeFetchInFlight;

  document.getElementById('results-meta').innerHTML = anyFetchInFlight
    ? `Searching ${loadingSource} for ${escapeHtml(loadingLabel)} nearby…`
    : !state.hasSearched
    ? `Search to see locations near ${escapeHtml(state.centerName)}`
    : `<b>${results.length}</b> of ${LOCATIONS.length + dynamicLocations.length + dynamicTypeLocations.length} real locations within ${state.radiusMi} mi of ${escapeHtml(state.centerName)}`;

  const list = document.getElementById('results');
  list.innerHTML = '';
  if (anyFetchInFlight) {
    list.innerHTML = `<div class="loading-state">
      <div class="spinner"></div>
      Searching ${loadingSource} for ${escapeHtml(loadingLabel)} nearby…
    </div>`;
  } else if (!results.length) {
    list.innerHTML = !state.hasSearched
      ? `<div class="empty">Describe the location you need above, or pick a location type below, to start searching.</div>`
      : state.dynamicFeature
      ? `<div class="empty">No ${escapeHtml(state.dynamicFeature.label.toLowerCase())} found within ${state.radiusMi} mi.<br>Widen the radius, search another city above, or try a different feature.</div>`
      : `<div class="empty">No locations in this radius.<br>Widen the radius, search another city above, or click the map to move the center.</div>`;
  } else {
    for (const loc of results) {
      const t = typeInfo(loc);
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <canvas width="300" height="150"></canvas>
        <div class="card-body">
          <div class="card-top">
            <h3>${escapeHtml(loc.name)}</h3>
            <span class="match" style="--pct:${loc.score}">${loc.score}%</span>
          </div>
          <div class="card-sub">${t.icon} ${t.label} · ${escapeHtml(loc.neighborhood)}</div>
          <div class="card-stats">
            <span>${loc.sqft.toLocaleString()} ft²</span>
            <span>${loc.ceilingFt ? loc.ceilingFt + ' ft ceil' : 'open air'}</span>
            <span>$${loc.rate}/day</span>
            <span>${loc.distMi.toFixed(1)} mi</span>
          </div>
        </div>`;
      // thumbs.js was written for curated floor-plan locations; guard so a
      // dynamic feature (no floor plan) can't crash the whole results render.
      try {
        drawPlanThumb(loc, card.querySelector('canvas'));
      } catch (e) {
        console.warn('[thumbs] drawPlanThumb failed for', loc.id, e.message);
      }
      card.onclick = () => openDetail(loc);
      list.appendChild(card);
    }
  }

  // Before the first search, no markers should be on the map at all — not
  // even dimmed ones — so pass an empty set rather than the full catalog.
  const allLocations = state.hasSearched ? [...LOCATIONS, ...dynamicLocations, ...dynamicTypeLocations] : [];
  updateMap(state, results, allLocations, computeSearchTargetIds(results));
  if (state.view === '3d') update3D(state.center, results);

  // exposure-style HUD readout, top-left of the map viewport
  document.getElementById('hud-radius').textContent = `${state.radiusMi} MI`;
  document.getElementById('hud-count').textContent = `${results.length} RESULT${results.length === 1 ? '' : 'S'}`;
}

// --------------------------------------------------------------- AI search
function applyParsedToState(q) {
  state.query = q;
  // Every field here is fully replaced by the current parse (defaulting to
  // "not specified" when absent) except this one used to be an exception —
  // it only overwrote state.types when the new query mentioned a building
  // type, silently leaving a stale type filter from an earlier search (or
  // an earlier manual chip click) active for a query that has nothing to
  // do with it, e.g. a pure natural-feature search like "300 m lake".
  state.types = new Set(q.types);
  state.light = q.light || 'any';
  state.minSqft = q.minSqft || 0;
  state.maxRate = q.maxRate ?? Infinity;
  if (q.radiusMi) state.radiusMi = q.radiusMi;
  state.dynamicFeature = q.naturalFeature || null;
  syncFilterControls();
}

function syncFilterControls() {
  document.querySelectorAll('#type-chips .chip').forEach(chip => {
    chip.classList.toggle('active', state.types.has(chip.dataset.type));
  });
  const sq = document.getElementById('sqft-range');
  sq.value = Math.min(10000, state.minSqft || 0);
  document.getElementById('sqft-label').textContent = state.minSqft ? `${state.minSqft.toLocaleString()}+ ft²` : 'Any';
  const rt = document.getElementById('rate-range');
  rt.value = isFinite(state.maxRate) ? Math.min(700, state.maxRate) : 700;
  document.getElementById('rate-label').textContent = isFinite(state.maxRate) ? `≤ ${state.maxRate}/day` : 'Any';
  document.getElementById('light-select').value = state.light;
  const rr = document.getElementById('radius-range');
  rr.value = state.radiusMi; document.getElementById('radius-label').textContent = `${state.radiusMi} mi`;
}

function renderInterpreted(q) {
  const box = document.getElementById('ai-interpreted');
  if (!q.raw) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const chips = q.interpreted.length
    ? q.interpreted.map(c => `<span>${escapeHtml(c)}</span>`).join('')
    : `<span class="dim">no specific filters detected — showing best overall matches</span>`;
  box.innerHTML = `<div class="ai-interpreted-head">AI read your brief as</div><div class="ai-chips">${chips}</div>`;
}

// Visible feedback while the AI-parse/geocode round-trip is in flight — with
// no indicator at all, a slow network call reads as the app being stuck
// rather than working.
function setSearching(on) {
  const btn = document.getElementById('ai-go');
  btn.disabled = on;
  btn.textContent = on ? 'Reading…' : 'Search ✨';
}

async function runAISearch(text) {
  setSearching(true);
  state.hasSearched = true;
  try {
    const q = await parseQuery(text);
    applyParsedToState(q);
    renderInterpreted(q);

    // If a location is specified, geocode and move the map center
    if (q.locationText) {
      setGeoStatus(`Locating “${q.locationText}”…`);
      const hit = await geocode(q.locationText);
      if (hit) moveCenter(hit.lat, hit.lng, hit.label);
      else setGeoStatus(`Couldn't find “${q.locationText}” — showing ${state.centerName}.`, true);
    }
    render();
    if (state.view === '3d') flyHome3D(state.center);
  } finally {
    setSearching(false);
  }
}

// --------------------------------------------------------------- geocoding
function moveCenter(lat, lng, label) {
  state.center = { lat, lng };
  state.centerName = label || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  const sel = document.getElementById('center-select');
  const match = CENTERS.find(c => c.name === label);
  sel.value = match ? match.name : '';
  fitToRadius(state);
  setGeoStatus('');
}

function setGeoStatus(msg, warn) {
  const el = document.getElementById('geo-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'geo-status' + (warn ? ' warn' : '');
}

async function runGeoSearch(text) {
  if (!text.trim()) return;
  setGeoStatus(`Searching “${text}”…`);
  const hit = await geocode(text);
  if (hit) { moveCenter(hit.lat, hit.lng, hit.label); render(); if (state.view === '3d') flyHome3D(state.center); }
  else setGeoStatus(`No match for “${text}”.`, true);
}

// ------------------------------------------------------------ detail modal
let currentLoc = null;

function openDetail(loc) {
  currentLoc = loc;
  const t = typeInfo(loc);
  document.getElementById('detail').classList.remove('hidden');
  flyToListing(loc);
  if (state.view === '3d') flyToListing3D(loc);
  setSelectedMarker(loc.id);

  document.getElementById('detail-title').textContent = loc.name;
  document.getElementById('detail-sub').innerHTML =
    `${t.icon} ${t.label} · ${escapeHtml(loc.address)}${loc.distMi != null ? ' · ' + loc.distMi.toFixed(1) + ' mi away' : ''}`;
  document.getElementById('detail-desc').textContent = loc.desc;

  document.getElementById('detail-stats').innerHTML = `
    <div><b id="stat-sqft">0</b><span>sq ft</span></div>
    <div><b id="stat-ceil">${loc.ceilingFt ? '0' : '—'}</b><span>ft ceilings</span></div>
    <div><b id="stat-rate">$0</b><span>est. per day</span></div>
    <div><b id="stat-crew">${loc.intel.crewCapacity != null ? '~0' : '—'}</b><span>crew capacity</span></div>`;
  animateCount('stat-sqft', loc.sqft);
  if (loc.ceilingFt) animateCount('stat-ceil', loc.ceilingFt);
  animateCount('stat-rate', loc.rate, { prefix: '$' });
  if (loc.intel.crewCapacity != null) animateCount('stat-crew', loc.intel.crewCapacity, { prefix: '~' });

  document.getElementById('detail-tags').innerHTML =
    `<div class="section-h">Features</div>` + loc.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('');

  const suit = loc.suit || safeSuitability(loc, state, state.query);
  document.getElementById('hero-badge').innerHTML =
    `<b>${suit.overall}%</b><span>match · ${suit.confidence} confidence</span>`;
  renderSuitability(suit);
  renderIntel(loc);
  renderReviews(loc);

  try {
    drawIsoHero(loc, document.getElementById('hero-canvas'));
  } catch (e) {
    console.warn('[thumbs] drawIsoHero failed for', loc.id, e.message);
  }
  renderPhotos(loc);
  renderPlaceInfo(loc);
  const sv = document.getElementById('sv-panel');
  sv.classList.add('hidden'); sv.innerHTML = '';
  document.querySelector('.modal').scrollTop = 0;
}

function renderSuitability(suit) {
  const rows = suit.breakdown.map(f => `
    <div class="suit-row">
      <div class="suit-top">
        <span class="suit-label">${f.label}</span>
        <span class="suit-score">${f.score}<i class="conf conf-${f.confidence}" title="${f.confidence} confidence"></i></span>
      </div>
      <div class="suit-bar"><div style="width:${f.score}%;--c:${barColor(f.score)}"></div></div>
      <div class="suit-note">${escapeHtml(f.note)}</div>
    </div>`).join('');
  document.getElementById('detail-suit').innerHTML = `
    <div class="section-h">AI suitability · ${suit.overall}% overall
      <span class="section-sub">${suit.confidence} confidence</span></div>
    <div class="suit-grid">${rows}</div>`;
}

function renderIntel(loc) {
  const now = new Date();
  const s = sunTimes(now, loc.lat, loc.lng);
  const p = sunPosition(now, loc.lat, loc.lng);
  const sunNow = p.altitude > 0
    ? `${p.altitude.toFixed(0)}° up, bearing ${compass(p.azimuth)}`
    : 'below horizon';
  const f = loc.intel.factors;
  const win = loc.intel.windows.length ? loc.intel.windows.join(' · ') : 'interior / no exterior windows';
  const lightWhen = loc.intel.windows.map(w => windowLight(w)).filter(Boolean).join(' · ') || '—';
  const ft = (d) => fmtTimeAt(d, loc.lng);
  const tz = tzAbbr(now, loc.lng);

  document.getElementById('detail-intel').innerHTML = `
    <div class="section-h">Production intelligence <span class="section-sub">local time · ${tz}</span></div>
    <div class="intel-sun">
      <div class="sun-track" id="sun-track"></div>
      <div class="sun-times">
        <div><b>${ft(s.sunrise)}</b><span>sunrise</span></div>
        <div class="gold"><b>${ft(s.goldenEveningStart)}–${ft(s.sunset)}</b><span>golden hour</span></div>
        <div class="blue"><b>${ft(s.sunset)}–${ft(s.dusk)}</b><span>blue hour</span></div>
        <div><b>${ft(s.sunset)}</b><span>sunset</span></div>
      </div>
      <div class="sun-now">☀️ Sun now: ${sunNow} · computed for today at this exact location</div>
    </div>
    <div class="intel-grid">
      ${intelCell('🪟 Window light', win, lightWhen)}
      ${intelCell('👥 Crew capacity', `~${loc.intel.crewCapacity} people`, `${loc.sqft.toLocaleString()} ft² usable`)}
      ${meterCell('🚗 Parking', f.parking)}
      ${meterCell('♿ Accessibility', f.accessibility)}
      ${meterCell('🔊 Noise (quiet)', f.noise)}
      ${meterCell('🔒 Privacy', f.privacy)}
      ${meterCell('⚡ Power', f.power)}
      ${meterCell('📋 Permit (simple)', f.permit)}
      ${intelCell('✈️ Nearest airport', `${loc.intel.nearestAirport.code} · ${loc.intel.nearestAirport.mi} mi`, loc.intel.nearestAirport.name)}
      ${intelCell('🎥 Equipment rental', loc.intel.amenities.equipment, '')}
      ${intelCell('🏨 Lodging', loc.intel.amenities.hotels, '')}
      ${intelCell('🍽 Dining', loc.intel.amenities.dining, '')}
    </div>
    <div class="intel-weather" id="intel-weather">Loading local forecast…</div>`;

  drawSunTrack(document.getElementById('sun-track'), loc, now, s, p);
  loadWeather(loc);
}

function intelCell(label, value, sub) {
  return `<div class="intel-cell"><div class="ic-label">${label}</div>
    <div class="ic-value">${escapeHtml(value)}</div>${sub ? `<div class="ic-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}
function meterCell(label, factor) {
  return `<div class="intel-cell"><div class="ic-label">${label}</div>
    <div class="ic-meter"><div style="width:${factor.score}%;--c:${barColor(factor.score)}"></div></div>
    <div class="ic-sub">${escapeHtml(factor.note)}</div></div>`;
}

function windowLight(w) {
  const dir = w.split(' ')[0];
  return {
    North: 'N: soft, even all day', South: 'S: strong midday sun',
    East: 'E: direct AM light', West: 'W: direct PM / golden hour',
  }[dir] || '';
}

async function loadWeather(loc) {
  const el = document.getElementById('intel-weather');
  const data = await forecast(loc.lat, loc.lng);
  if (!el || currentLoc !== loc) return;
  if (!data || !data.current) { el.textContent = 'Local forecast unavailable offline.'; return; }
  const [txt, emoji] = weatherText(data.current.weather_code);
  const days = (data.daily?.time || []).slice(0, 3).map((t, i) => {
    const [dtxt, demoji] = weatherText(data.daily.weather_code[i]);
    const day = new Date(t + 'T12:00').toLocaleDateString([], { weekday: 'short' });
    return `<span>${demoji} ${day} ${Math.round(data.daily.temperature_2m_max[i])}°/${Math.round(data.daily.temperature_2m_min[i])}° · ${data.daily.precipitation_probability_max[i] ?? 0}%💧</span>`;
  }).join('');
  el.innerHTML = `<b>${emoji} ${Math.round(data.current.temperature_2m)}° ${txt}</b>
    · ${data.current.cloud_cover}% cloud · ${Math.round(data.current.wind_speed_10m)} mph wind
    <div class="wx-days">${days}</div>
    <div class="ic-sub">Live via Open-Meteo</div>`;
}

function renderReviews(loc) {
  const r = loc.reviews;
  const stars = '★'.repeat(Math.round(r.rating)) + '☆'.repeat(5 - Math.round(r.rating));
  document.getElementById('detail-reviews').innerHTML = `
    <div class="section-h">Review intelligence
      <span class="section-sub">AI summary · modeled signals</span></div>
    <div class="rev-head"><span class="rev-stars">${stars}</span>
      <b>${r.rating.toFixed(1)}</b> <span class="dim">from ${r.count} reviews</span></div>
    <p class="rev-summary">${escapeHtml(r.summary)}</p>
    <div class="rev-cols">
      <div><div class="rev-h up">Strengths</div><ul>${r.positives.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div><div class="rev-h down">Consider</div><ul>${r.considerations.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>`;
}

// Real photos of the location via DuckDuckGo image search. This section
// isn't part of the original HTML markup, so it's created on first use and
// reused afterward rather than assuming a container id already exists.
function getOrCreatePhotosContainer() {
  let el = document.getElementById('detail-photos');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'detail-photos';
  el.className = 'detail-photos';
  // Insert right after the reviews section so it reads naturally in the
  // existing modal flow; falls back to appending to the modal body if that
  // anchor isn't found for some reason.
  const reviews = document.getElementById('detail-reviews');
  if (reviews && reviews.parentNode) {
    reviews.parentNode.insertBefore(el, reviews.nextSibling);
  } else {
    document.querySelector('.modal')?.appendChild(el);
  }
  return el;
}

async function renderPhotos(loc) {
  const el = getOrCreatePhotosContainer();
  el.innerHTML = `<div class="section-h">Photos</div><div class="photos-loading">Searching for real photos…</div>`;

  // Query by name + neighborhood/city for better hit rate than the bare name alone.
  const query = `${loc.name} ${loc.neighborhood || ''}`.trim();
  // Dynamic natural-feature locations carry a slug type that isn't one of
  // catalog.js's TYPES keys — see typeInfo()'s fallback for the same check.
  const natural = !TYPES[loc.type];
  const photos = await fetchLocationPhotos(query, natural);

  // Guard against a stale response landing after the user closed/switched
  // to a different location's detail view.
  if (currentLoc !== loc) return;

  if (!photos.length) {
    el.innerHTML = `<div class="section-h">Photos</div><div class="photos-empty">No photos found for this location.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="section-h">Photos <span class="section-sub">via web image search</span></div>
    <div class="photos-grid">
      ${photos.map(p => `
        <a class="photo-tile" href="${escapeHtml(p.url || p.image)}" target="_blank" rel="noopener" title="${escapeHtml(p.title || '')}">
          <img src="${escapeHtml(p.thumbnail || p.image)}" alt="${escapeHtml(p.title || loc.name)}" loading="lazy" />
        </a>`).join('')}
    </div>`;
}

// Real-world background for a natural/geographic feature (lake, park,
// mountain, ...) via Wikipedia. Only meaningful for dynamic feature results
// — the curated soundstage/loft/etc. catalog is fictional and already has
// hand-authored descriptions, so a Wikipedia lookup for those would just
// return an unrelated real-world match or nothing at all.
function getOrCreatePlaceInfoContainer() {
  let el = document.getElementById('detail-place-info');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'detail-place-info';
  el.className = 'detail-place-info';
  const desc = document.getElementById('detail-desc');
  if (desc && desc.parentNode) {
    desc.parentNode.insertBefore(el, desc.nextSibling);
  } else {
    document.querySelector('.modal')?.appendChild(el);
  }
  return el;
}

async function renderPlaceInfo(loc) {
  if (loc.floorplan) {
    const existing = document.getElementById('detail-place-info');
    if (existing) existing.innerHTML = '';
    return;
  }

  const el = getOrCreatePlaceInfoContainer();
  el.innerHTML = `<div class="place-info-loading">Looking up ${escapeHtml(loc._label || 'this place')} on Wikipedia…</div>`;

  const info = await fetchPlaceInfo({ lat: loc.lat, lng: loc.lng, name: loc.name, wikipedia: loc.wikipedia });

  // Guard against a stale response landing after the user closed/switched
  // to a different location's detail view — same pattern as renderPhotos.
  if (currentLoc !== loc) return;

  if (!info) {
    el.innerHTML = `<div class="place-info-empty">No Wikipedia article found for this location.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="section-h">About <span class="section-sub">via Wikipedia</span></div>
    <div class="place-info-body">
      ${info.thumbnail ? `<img class="place-info-thumb" src="${escapeHtml(info.thumbnail)}" alt="${escapeHtml(info.title)}" loading="lazy">` : ''}
      <div>
        <p>${escapeHtml(info.extract)}</p>
        <a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">Read more on Wikipedia ↗</a>
      </div>
    </div>`;
}


function drawSunTrack(el, loc, now, s, p) {
  if (!el) return;
  const W = 320, H = 60;
  const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2;
  c.style.width = '100%'; c.style.height = H + 'px';
  const g = c.getContext('2d'); g.scale(2, 2);
  // arc
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(8, H - 10);
  for (let i = 0; i <= 40; i++) { const x = 8 + (W - 16) * i / 40; const y = (H - 10) - Math.sin(Math.PI * i / 40) * (H - 22); g.lineTo(x, y); }
  g.stroke();
  const dayLen = s.sunset - s.sunrise;
  const frac = Math.max(0, Math.min(1, (now - s.sunrise) / dayLen));
  const gx = 8 + (W - 16) * frac, gy = (H - 10) - Math.sin(Math.PI * frac) * (H - 22);
  // golden zones
  g.fillStyle = 'rgba(232,180,90,0.9)';
  g.beginPath(); g.arc(gx, gy, p.altitude > 0 ? 5 : 3, 0, 7); g.fill();
  el.innerHTML = ''; el.appendChild(c);
}

// ---------------------------------------------------------------- street view
// Three-tier fallback:
//  1. Mapillary — free, no key required from the user, but coverage is
//     patchy (crowdsourced, dense in some cities, empty elsewhere).
//  2. Google Street View embed — only if the user added their own Maps key
//     in Settings (their key, their billing).
//  3. External "open in Google Maps / Google Earth" links — always works,
//     just leaves the app.
async function toggleStreetView() {
  if (!currentLoc) return;
  const panel = document.getElementById('sv-panel');

  if (!panel.classList.contains('hidden')) {
    teardownMapillary();
    panel.classList.add('hidden');
    panel.innerHTML = '';
    setImmersive('streetview', false);
    return;
  }

  panel.classList.remove('hidden');
  setImmersive('streetview', true);
  const { lat, lng } = currentLoc;

  panel.innerHTML = `<div class="sv-loading">Looking for street-level imagery…</div>`;

  const imageId = await findNearestMapillaryImage(lat, lng).catch(() => null);

  if (imageId) {
    panel.innerHTML = `<div id="mly-viewer" style="width:100%;height:100%"></div>
      <div class="sv-note">Street-level imagery via Mapillary (crowdsourced, free) — drag to look around.</div>`;
    try {
      await loadMapillaryLib();
      teardownMapillary(); // in case one is somehow still alive
      const { Viewer } = window.mapillary;
      mapillaryViewer = new Viewer({
        accessToken: MAPILLARY_TOKEN,
        container: 'mly-viewer',
        imageId,
      });
      return;
    } catch (e) {
      console.warn('[streetview] Mapillary viewer failed to init:', e.message);
      // fall through to the next tier below
    }
  }

  // Tier 2: user's own Google Maps key, if they've added one in Settings
  const googleKey = localStorage.getItem(KEY_STORAGE);
  if (googleKey) {
    panel.innerHTML = `
      <iframe src="https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(googleKey)}&location=${lat},${lng}&fov=90"
        allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <div class="sv-note">No Mapillary coverage here — showing Google Street View instead.</div>`;
    return;
  }

  // Tier 3: no free imagery found, no Google key on file — hand off links
  panel.innerHTML = `
    <div class="sv-fallback">
      <p>No free street-level imagery found at this location. Add a Google Maps API key in
         <b>⚙ Settings</b> for embedded Street View, or open one of these instead:</p>
      <div class="sv-links">
        <a class="btn" target="_blank" rel="noopener"
           href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}">Open Street View ↗</a>
        <a class="btn" target="_blank" rel="noopener"
           href="https://earth.google.com/web/search/${lat},${lng}">Open Google Earth ↗</a>
      </div>
    </div>`;
}

async function findNearestMapillaryImage(lat, lng) {
  if (!MAPILLARY_TOKEN || MAPILLARY_TOKEN === 'YOUR_MAPILLARY_CLIENT_TOKEN') return null;
  const res = await fetch(
    `https://graph.mapillary.com/images?access_token=${MAPILLARY_TOKEN}` +
    `&fields=id&closeto=${lng},${lat}&radius=100`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Mapillary API error: ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

function teardownMapillary() {
  if (mapillaryViewer) {
    try { mapillaryViewer.remove(); } catch { /* already gone */ }
    mapillaryViewer = null;
  }
}

function closeDetail() {
  teardownMapillary();
  document.getElementById('detail').classList.add('hidden');
  currentLoc = null;
  clearSelectedMarker();
  setImmersive('streetview', false);
}

// ---------------------------------------------------------------- settings
function openSettings() {
  document.getElementById('settings').classList.remove('hidden');
  document.getElementById('api-key-input').value = localStorage.getItem(KEY_STORAGE) || '';
}
function saveSettings() {
  const v = document.getElementById('api-key-input').value.trim();
  if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE);
  document.getElementById('settings').classList.add('hidden');
}

// ---------------------------------------------------------------- 2D / 3D
let exploreMode = false; // true when "Explore Globe" is active — map clicks discover a place instead of doing nothing

// force: skip the no-op guard even if `view` already matches state.view.
// Explore Globe needs this — entering it while already on the "3D" tab
// (state.view is already '3d' from an earlier click) must still show the
// 3D container and (re-)run ensure3D/flyHome3D, not silently no-op just
// because the *tab* didn't change.
async function setView(view, { force = false } = {}) {
  if (view === state.view && !force) return;
  state.view = view;
  setImmersive('3d', view === '3d');
  // [data-view] here too — #explore-toggle also lives inside #map-toggle
  // but isn't a 2D/3D toggle button; without this filter this was stripping
  // its 'active' class the instant enterExploreMode's own setView('3d')
  // call ran, undoing the class it had just added two lines earlier.
  document.querySelectorAll('#map-toggle button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const el3d = document.getElementById('map3d');
  const el2d = document.getElementById('map2d');
  if (view === '3d') {
    el3d.style.display = 'block'; el2d.style.visibility = 'hidden';
    const ok = await ensure3D(el3d, (id) => {
      const loc = LOCATIONS.find(l => l.id === id) || dynamicLocations.find(l => l.id === id);
      if (loc) openDetail(loc);
    }, (lat, lng) => {
      if (exploreMode) handleGlobeClick(lat, lng);
    });
    if (ok) { resize3D(); flyHome3D(state.center); update3D(state.center, runSearch()); }
  } else {
    el3d.style.display = 'none'; el2d.style.visibility = 'visible';
  }
}

// --------------------------------------------------------- explore globe
// Free-roam mode: pulls the 3D camera out to a whole-Earth globe view and
// lets the user click anywhere, independent of the curated search radius.
// A click reverse-geocodes the point and shows real photos of wherever was
// clicked — separate from the curated-location detail modal, since a random
// point on Earth has none of that modal's expected data (rate, floor plan,
// suitability score, etc).
async function enterExploreMode() {
  exploreMode = true;
  document.getElementById('explore-toggle')?.classList.add('active');
  await setView('3d', { force: true });
  // Wait for the globe projection to actually be applied before flying out
  // and starting rotation — setGlobeMode defers until style.load if the
  // style isn't ready yet (fixes "Style is not done loading" error).
  await setGlobeMode(true);
  showStarfield();
  flyToGlobalView();
  startGlobeSpin();
}

function exitExploreMode() {
  exploreMode = false;
  document.getElementById('explore-toggle')?.classList.remove('active');
  hideStarfield();
  stopGlobeSpin();
  setGlobeMode(false);
  closeDiscoverPanel();
  if (state.view === '3d') flyHome3D(state.center);
}

function getOrCreateExploreButton() {
  let btn = document.getElementById('explore-toggle');
  if (btn) return btn;
  const toggle = document.getElementById('map-toggle');
  if (!toggle) return null;
  btn = document.createElement('button');
  btn.id = 'explore-toggle';
  btn.type = 'button';
  btn.textContent = '🌐 Explore Globe';
  btn.onclick = () => { exploreMode ? exitExploreMode() : enterExploreMode(); };
  toggle.appendChild(btn);
  return btn;
}

function getOrCreateDiscoverPanel() {
  let el = document.getElementById('discover-panel');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'discover-panel';
  el.className = 'discover-panel hidden';
  document.body.appendChild(el);
  return el;
}

function closeDiscoverPanel() {
  const el = document.getElementById('discover-panel');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

async function handleGlobeClick(lat, lng) {
  const panel = getOrCreateDiscoverPanel();
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="discover-loading">Looking up ${lat.toFixed(3)}, ${lng.toFixed(3)}…</div>`;

  const place = await reverseGeocode(lat, lng);
  const label = place?.label || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  // Explore-the-globe is always a real place, same reasoning as renderPhotos.
  const photos = await fetchLocationPhotos(label, true);

  panel.innerHTML = `
    <div class="discover-head">
      <h3>${escapeHtml(label)}</h3>
      <button class="discover-close" id="discover-close">✕</button>
    </div>
    <div class="discover-coords">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
    ${photos.length ? `
      <div class="photos-grid">
        ${photos.slice(0, 6).map(p => `
          <a class="photo-tile" href="${escapeHtml(p.url || p.image)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(p.thumbnail || p.image)}" alt="${escapeHtml(p.title || label)}" loading="lazy" />
          </a>`).join('')}
      </div>` : `<div class="photos-empty">No photos found for this spot.</div>`}
    <button class="btn" id="discover-search-here">Search near here</button>`;

  document.getElementById('discover-close').onclick = closeDiscoverPanel;
  document.getElementById('discover-search-here').onclick = () => {
    moveCenter(lat, lng, label);
    exitExploreMode();
    render();
  };
}

// -------------------------------------------------------------------- init
function initAISearch() {
  const input = document.getElementById('ai-input');
  const go = () => { playIrisTransition(); runAISearch(input.value); };
  document.getElementById('ai-go').onclick = go;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
  const ex = document.getElementById('ai-examples');
  for (const text of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'ex-chip'; b.textContent = text;
    b.onclick = () => { input.value = text; playIrisTransition(); runAISearch(text); };
    ex.appendChild(b);
  }
}

function initFilters() {
  const sel = document.getElementById('center-select');
  for (const c of CENTERS) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name; sel.appendChild(o);
  }
  sel.onchange = () => {
    const c = CENTERS.find(c2 => c2.name === sel.value);
    if (c) { moveCenter(c.lat, c.lng, c.name); render(); if (state.view === '3d') flyHome3D(state.center); }
  };

  const chipWrap = document.getElementById('type-chips');
  for (const [key, t] of Object.entries(TYPES)) {
    const chip = document.createElement('button');
    chip.className = 'chip'; chip.dataset.type = key;
    chip.innerHTML = `${t.icon} ${t.label}`;
    chip.onclick = () => {
      if (state.types.has(key)) state.types.delete(key); else state.types.add(key);
      chip.classList.toggle('active');
      state.hasSearched = true;
      render();
    };
    chipWrap.appendChild(chip);
  }

  const bindRange = (id, labelId, fmt, apply) => {
    const el = document.getElementById(id);
    const lbl = document.getElementById(labelId);
    el.oninput = () => { lbl.textContent = fmt(+el.value); apply(+el.value); render(); };
    lbl.textContent = fmt(+el.value);
  };
  bindRange('radius-range', 'radius-label', v => `${v} mi`, v => { state.radiusMi = v; });
  bindRange('sqft-range', 'sqft-label', v => v ? `${v.toLocaleString()}+ ft²` : 'Any', v => { state.minSqft = v; });
  bindRange('rate-range', 'rate-label', v => v >= 600 ? 'Any' : `≤ ${v}/day`, v => { state.maxRate = v >= 600 ? Infinity : v; });

  document.getElementById('light-select').onchange = (e) => { state.light = e.target.value; render(); };
  document.getElementById('sort-select').onchange = (e) => { state.sort = e.target.value; render(); };

  const geoInput = document.getElementById('geo-input');
  document.getElementById('geo-go').onclick = () => runGeoSearch(geoInput.value);
  geoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runGeoSearch(geoInput.value); });
  // status line lives just under the geo box
  const status = document.createElement('div');
  status.id = 'geo-status'; status.className = 'geo-status';
  geoInput.closest('.filter-row').appendChild(status);
}

// Fetches the bundled catalog from /api/locations once at startup and
// populates the module-level LOCATIONS array. Fires a render() after the
// fetch resolves so the map shows the full set the moment data is ready.
// Failures are non-fatal — the app still works for natural-feature and
// Foursquare searches; the catalog just stays empty.
async function loadCatalog() {
  try {
    const res = await fetch('/api/locations', { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`/api/locations returned ${res.status}`);
    LOCATIONS = await res.json();
    console.log(`[catalog] Loaded ${LOCATIONS.length} real locations`);
    render(); // re-render now that we have data
  } catch (e) {
    console.warn('[catalog] Failed to load locations:', e.message);
  }
}

async function init() {
  initAISearch();
  initFilters();
  getOrCreateExploreButton();
  syncFilterControls();
  loadCatalog(); // fire-and-forget — renders again when data lands
  await initMap({
    onCenterChange: (lat, lng) => { moveCenter(lat, lng); render(); },
    onMarkerClick: (id) => {
      const results = runSearch();
      const loc = results.find(r => r.id === id)
        || wrapLoc(LOCATIONS.find(l => l.id === id) || dynamicLocations.find(l => l.id === id));
      if (loc) openDetail(loc);
    },
  });

  document.getElementById('detail-close').onclick = closeDetail;
  document.getElementById('detail').onclick = (e) => { if (e.target.id === 'detail') closeDetail(); };
  document.getElementById('enter-tour').onclick = () => { if (currentLoc) { const l = currentLoc; closeDetail(); setImmersive('tour', true); openTour(l); } };
  document.getElementById('fly-tour').onclick = () => { if (currentLoc) { const l = currentLoc; closeDetail(); setImmersive('tour', true); openTour(l, { mode: 'fly' }); } };
  // tour.js owns #tour-close's primary handler via .onclick — addEventListener
  // here so this doesn't clobber it, just observes the same click to
  // restore the letterbox bars.
  document.getElementById('tour-close').addEventListener('click', () => setImmersive('tour', false));
  document.getElementById('toggle-sv').onclick = toggleStreetView;
  document.getElementById('open-earth').onclick = () => {
    if (currentLoc) window.open(`https://earth.google.com/web/search/${currentLoc.lat},${currentLoc.lng}`, '_blank');
  };
  document.getElementById('open-directions').onclick = () => {
    if (currentLoc) window.open(`https://www.google.com/maps/dir/?api=1&destination=${currentLoc.lat},${currentLoc.lng}`, '_blank');
  };

  // #explore-toggle also lives inside #map-toggle (getOrCreateExploreButton
  // appends it there) but isn't a 2D/3D toggle — it has no data-view and
  // wires its own enter/exitExploreMode handler. Without this guard, this
  // loop was overwriting that handler with setView(undefined), silently
  // breaking Explore Globe (setView(undefined) falls into the "hide 3D"
  // branch instead of ever entering explore mode).
  document.querySelectorAll('#map-toggle button[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view); });

  document.getElementById('basemap-toggle').onclick = (e) => {
    const on = setSatellite(!isSatellite());
    e.target.classList.toggle('active', on);
  };

  document.getElementById('settings-btn').onclick = openSettings;
  document.getElementById('settings-save').onclick = saveSettings;
  document.getElementById('settings-close').onclick = () => document.getElementById('settings').classList.add('hidden');
  document.getElementById('settings').onclick = (e) => { if (e.target.id === 'settings') e.target.classList.add('hidden'); };

  // Debug route: ?debugTour=studio|large|irregular|windowless opens the
  // digital twin directly against a synthetic location, bypassing search —
  // lets the floor-plan generator's edge cases (1 room, many rooms, an
  // irregular footprint, zero windows) be checked without real data.
  const debugTour = new URLSearchParams(window.location.search).get('debugTour');
  if (debugTour && DEBUG_LOCATIONS[debugTour]) {
    setImmersive('tour', true);
    openTour(DEBUG_LOCATIONS[debugTour]);
  }

  render();
  fitToRadius(state);
}

function wrapLoc(loc) {
  if (!loc) return null;
  const suit = safeSuitability(loc, state, state.query);
  return { ...loc, distMi: haversineMi(state.center.lat, state.center.lng, loc.lat, loc.lng), score: suit.overall, suit };
}

function barColor(v) { return v >= 75 ? '#7aa874' : v >= 50 ? '#c9962b' : '#b5533a'; }

const PREFERS_REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Counts a stat up from 0 to its real value (ease-out cubic) instead of
// just printing the final number — a small dashboard-style flourish for
// the detail view's headline stats. Skips straight to the final value
// under prefers-reduced-motion.
function animateCount(elId, target, { prefix = '', duration = 700 } = {}) {
  const el = document.getElementById(elId);
  if (!el || typeof target !== 'number' || !isFinite(target)) return;
  if (PREFERS_REDUCED_MOTION) { el.textContent = prefix + target.toLocaleString(); return; }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = prefix + Math.round(target * eased).toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

init();