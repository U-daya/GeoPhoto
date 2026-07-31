// Leaflet map: dark basemap (with a satellite toggle), search-radius circle,
// listing markers. Click anywhere on the map to move the search center.

import { TYPES } from './data.js';

const AMBER = '#5aa7e8';
const TEAL = '#4a6fa0';

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const DARK_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
// Esri World Imagery: free, keyless satellite tiles — lets a scout actually
// see real rooftops/lots under the pins, not just a stylized vector map.
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SAT_ATTR = '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

let map, radiusCircle, centerMarker, tileLayer;
let satellite = false;
const markers = new Map(); // listing id -> L.marker
let selectedId = null;

// A teardrop pin colored per location type (matching the 3D view's markers)
// with the type's emoji upright inside it — lets a scout tell building types
// apart on the map itself, not just by hovering or opening the sidebar list.
function pinIcon(t, { selected } = {}) {
  // --c must live on the wrapper div itself: custom properties only cascade
  // downward, so setting it on the inner <span> would leave .pin2d's own
  // `background: var(--c, ...)` unable to see it and always fall back.
  return L.divIcon({
    className: 'pin2d' + (selected ? ' selected' : ''),
    html: `<span>${t.icon}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

export function initMap({ onCenterChange, onMarkerClick }) {
  // zoomControl lives bottom-left so it never collides with the top-left
  // exposure-style HUD readout the design brief calls for.
  map = L.map('map2d', { zoomControl: false, attributionControl: true })
    .setView([34.04, -118.25], 10);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  tileLayer = L.tileLayer(DARK_TILES, { maxZoom: 19, attribution: DARK_ATTR }).addTo(map);

  map.on('click', (e) => onCenterChange(e.latlng.lat, e.latlng.lng));

  // the map lives in an absolutely-positioned container; make sure Leaflet
  // measures it once layout settles so tiles fill the pane on first paint.
  setTimeout(() => map.invalidateSize(), 120);

  map._onMarkerClick = onMarkerClick;
  return map;
}

// Swaps the base tile layer between the cinematic dark map and real
// satellite imagery. Returns the new state so callers can sync a toggle UI.
export function setSatellite(on) {
  if (!map || on === satellite) return satellite;
  satellite = on;
  tileLayer.remove();
  tileLayer = L.tileLayer(satellite ? SAT_TILES : DARK_TILES, {
    maxZoom: 19,
    attribution: satellite ? SAT_ATTR : DARK_ATTR,
  }).addTo(map);
  tileLayer.bringToBack();
  return satellite;
}
export function isSatellite() { return satellite; }

// Rack-focus: on hovering one pin, softly blur every other pin instead of
// glowing the hovered one — the one other deliberate motion moment the
// brief calls for, beyond the search-submit iris wipe.
function blurOtherMarkers(hoveredId) {
  for (const [id, m] of markers) {
    const el = m.getElement();
    if (!el) continue;
    el.style.filter = id === hoveredId ? '' : 'blur(1.5px)';
    el.style.transition = 'filter 0.15s ease';
  }
}
function clearBlur() {
  for (const [, m] of markers) {
    const el = m.getElement();
    if (el) el.style.filter = '';
  }
}

function typeInfo(loc) {
  return TYPES[loc.type] || { icon: loc._icon || '📍', label: loc._label || 'Location', color: loc._color || TEAL };
}

export function updateMap(state, results, allLocations) {
  // Guard: if initMap crashed or hasn't finished, map is undefined — bail
  // instead of throwing on addTo/addLayer.
  if (!map) {
    console.warn('updateMap called before map was initialized — skipping.');
    return;
  }

  const { center, radiusMi } = state;
  const radiusM = radiusMi * 1609.34;

  if (!radiusCircle) {
    radiusCircle = L.circle([center.lat, center.lng], {
      radius: radiusM, color: AMBER, weight: 1.5, opacity: 0.7,
      fillColor: AMBER, fillOpacity: 0.06, interactive: false,
    }).addTo(map);
    centerMarker = L.circleMarker([center.lat, center.lng], {
      radius: 6, color: '#fff', weight: 2, fillColor: AMBER, fillOpacity: 1, interactive: false,
    }).addTo(map);
  } else {
    radiusCircle.setLatLng([center.lat, center.lng]).setRadius(radiusM);
    centerMarker.setLatLng([center.lat, center.lng]);
  }

  const allLocationIds = new Set(allLocations.map(l => l.id));
  for (const loc of allLocations) {
    const t = typeInfo(loc);
    const selected = loc.id === selectedId;
    let m = markers.get(loc.id);
    if (!m) {
      m = L.marker([loc.lat, loc.lng], { icon: pinIcon(t) }).addTo(map);
      m.bindTooltip(`${t.icon} ${t.label} — ${loc.name}`, { direction: 'top', offset: [0, -22] });
      m.on('click', () => map._onMarkerClick(loc.id));
      m.on('mouseover', () => blurOtherMarkers(loc.id));
      m.on('mouseout', clearBlur);
      markers.set(loc.id, m);
    }
    m.setIcon(pinIcon(t, { selected }));
    const el = m.getElement();
    if (el) {
      el.style.setProperty('--c', t.color || TEAL);
      // Only the searched-for/selected pin stays fully lit — every other
      // pin dims, whether or not it still matches the active search filters.
      el.classList.toggle('dim', !selected);
    }
  }

  // Dynamic locations (natural features, real-business type searches) get
  // fresh ids on every search — without this, a marker from an earlier
  // search whose location isn't part of the current view at all (not even
  // dimmed) stays on the map forever, piling up across every search made
  // in the session.
  for (const [id, m] of markers) {
    if (!allLocationIds.has(id)) {
      map.removeLayer(m);
      markers.delete(id);
    }
  }
}

// Marks a location's pin as the active selection (amber) — called when its
// detail view opens; cleared when it closes. Applied here (not just left to
// the next updateMap() call) so the searched-for pin lights up — and every
// other pin dims — the instant a marker/card is clicked, not on the next search.
function applySelectionStyling() {
  for (const [id, m] of markers) {
    const el = m.getElement();
    if (!el) continue;
    const isSelected = id === selectedId;
    el.classList.toggle('selected', isSelected);
    el.classList.toggle('dim', !isSelected);
  }
}
export function setSelectedMarker(id) {
  selectedId = id;
  applySelectionStyling();
}
export function clearSelectedMarker() {
  selectedId = null;
  applySelectionStyling();
}

export function flyToListing(loc) {
  if (!map) return;
  map.flyTo([loc.lat, loc.lng], 14, { duration: 0.8 });
}

export function fitToRadius(state) {
  if (!map) return;
  const r = state.radiusMi * 1609.34;
  map.fitBounds(L.latLng(state.center.lat, state.center.lng).toBounds(r * 2), { padding: [20, 20] });
}
