// Finds real-world natural/geographic features (lakes, rivers, beaches,
// mountains, forests, whatever) near a point, primarily using OpenStreetMap's
// Overpass API. Unlike a hardcoded "find lakes" module, the OSM tags to
// search for come from Groq's understanding of the query (see server.js's
// PARSE_SYSTEM_PROMPT) — this module just executes whatever tag query it's
// given and shapes the results into location-like objects the rest of the
// app already knows how to render.
//
// When Overpass finds nothing (even after relaxing the tag set — see
// below), falls back to GeoNames: a separately, independently maintained
// database, not dependent on the same volunteer OSM mapping/mirror
// reliability that's been the recurring problem with Overpass.

const MI_TO_M = 1609.34;

function haversineFt(lat1, lng1, lat2, lng2) {
    const R = 20902231; // Earth radius in feet
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rough "diameter" of an area feature: the larger of its N-S/E-W extents,
// in feet, from its bounding box. Not meaningful for point features (peaks,
// waterfalls) — those are skipped by the size filter automatically since
// point elements have no `bounds`.
function approxDiameterFt(bounds) {
    const h = haversineFt(bounds.minlat, bounds.minlon, bounds.maxlat, bounds.minlon);
    const w = haversineFt(bounds.minlat, bounds.minlon, bounds.minlat, bounds.maxlon);
    return Math.max(h, w);
}

// Builds an Overpass QL query for arbitrary tag(s) and element type(s).
// tags: [{key, value}]. elementTypes: subset of ['node','way','relation'].
function buildOverpassQuery(center, radiusM, tags, elementTypes) {
    const tagFilter = tags.map(t => `["${t.key}"="${t.value}"]`).join('');
    const types = elementTypes && elementTypes.length ? elementTypes : ['node', 'way', 'relation'];
    const clauses = types
        .map(t => `  ${t}${tagFilter}(around:${radiusM},${center.lat},${center.lng});`)
        .join('\n');
    // "geom" (full node-by-node polygon geometry) is never read below — only
    // el.bounds (for size filtering) and el.tags are used — but requesting it
    // anyway multiplies the response size for any densely-tagged, area-heavy
    // feature. That's exactly why a search like "park" (leisure=park —
    // hundreds of parks/playgrounds/gardens in range in most US metros)
    // could time out or get rejected by a mirror while a rarer tag like
    // waterway=river sails through: "bb" gets the bounding box the size
    // filter needs at a fraction of the payload. The trailing limit caps the
    // element count outright so no single dense tag can blow up the query
    // regardless of radius.
    return `[out:json][timeout:25];\n(\n${clauses}\n);\nout body bb 300;`;
}

// A transient client-side network blip (Chrome's ERR_NETWORK_CHANGED, Wi-Fi
// handoff, etc.) surfaces as fetch() itself rejecting — a plain TypeError,
// not an HTTP error response — and is usually gone a moment later, unlike a
// real HTTP error (which the server already retries across Overpass mirrors
// on its own). Worth one quick client retry. Returns [] (not throwing) on
// any unrecoverable failure so a bad natural-feature search never breaks
// the rest of the results.
async function queryOverpass(query) {
    async function postOverpass() {
        const res = await fetch('/api/overpass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            // The server itself bounds its Overpass mirror race to 25s; this
            // must stay above that or the client would abort the connection
            // before the server even finishes, which defeats the point of
            // the server-side timeout entirely. This is purely a defense-in-
            // depth cap for a hung connection to our own server (Render
            // hiccup, etc.), not meant to race the server's own timeout.
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`overpass proxy failed: ${res.status}`);
        return res.json();
    }

    let data;
    try {
        data = await postOverpass();
    } catch (e) {
        if (e instanceof TypeError) {
            console.warn('[naturalFeatures] network error, retrying once:', e.message);
            try {
                await new Promise(r => setTimeout(r, 1000));
                data = await postOverpass();
            } catch (e2) {
                console.warn('[naturalFeatures] Overpass query failed after retry:', e2.message);
                return [];
            }
        } else {
            console.warn('[naturalFeatures] Overpass query failed:', e.message);
            return [];
        }
    }
    return Array.isArray(data.elements) ? data.elements : [];
}

// feature: { label, icon, osmTags: [{key,value}], elementTypes: string[], approxSizeFt: number|null }
// center: {lat,lng}. radiusMi: search radius.
export async function findNaturalFeatures(center, radiusMi, feature) {
    if (!feature || !Array.isArray(feature.osmTags) || !feature.osmTags.length) return [];

    const radiusM = Math.round(radiusMi * MI_TO_M);
    const query = buildOverpassQuery(center, radiusM, feature.osmTags, feature.elementTypes);
    let elements = await queryOverpass(query);

    // Groq sometimes adds an extra qualifying sub-tag beyond the primary
    // one (e.g. natural=water + water=lake) — real-world OSM data is
    // inconsistent about carrying that second tag, so requiring both (every
    // osmTags entry is AND'd together) can quietly return zero real matches
    // even when the area clearly has the feature. Relax to just the primary
    // tag and try once more before giving up.
    if (!elements.length && feature.osmTags.length > 1) {
        console.warn('[naturalFeatures] no matches with full tag set, retrying with primary tag only:', feature.osmTags);
        const relaxedQuery = buildOverpassQuery(center, radiusM, [feature.osmTags[0]], feature.elementTypes);
        elements = await queryOverpass(relaxedQuery);
    }

    const results = [];
    const toleranceFt = 200;

    for (const el of elements) {
        let lat, lng, diameterFt = null;

        if (el.type === 'node' && typeof el.lat === 'number') {
            // point feature — no size concept, always passes any size filter
            lat = el.lat; lng = el.lon;
        } else if (el.bounds) {
            lat = (el.bounds.minlat + el.bounds.maxlat) / 2;
            lng = (el.bounds.minlon + el.bounds.maxlon) / 2;
            diameterFt = approxDiameterFt(el.bounds);
            if (feature.approxSizeFt != null && Math.abs(diameterFt - feature.approxSizeFt) > toleranceFt) continue;
        } else {
            continue; // no usable coordinates
        }

        const name = el.tags?.name || `Unnamed ${feature.label.toLowerCase()}`;
        results.push(toFeatureLocation(el, feature, name, lat, lng, diameterFt));
    }

    if (results.length) return results;

    // Overpass found nothing even after relaxing the tag set — most likely
    // a genuine coverage gap (this exact class of problem is what's caused
    // real, confirmed zero-result searches earlier: a France-only mirror,
    // a mirror with no data for the queried region, ...). Try an entirely
    // separate, independently-maintained data source before giving up.
    console.warn('[naturalFeatures] Overpass found nothing, trying GeoNames fallback');
    return await findViaGeoNames(center, radiusMi, feature);
}

async function findViaGeoNames(center, radiusMi, feature) {
    const params = new URLSearchParams({
        lat: center.lat, lng: center.lng, radiusMi: String(radiusMi), label: feature.label,
    });
    try {
        const res = await fetch(`/api/geonames-search?${params}`, {
            // The server's own GeoNames call is bounded to 10s; this must
            // stay above that, same reasoning as queryOverpass's timeout.
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            console.warn('[naturalFeatures] geonames-search proxy failed:', res.status);
            return [];
        }
        const places = await res.json();
        return places.map(p => toGeoNamesLocation(p, feature));
    } catch (e) {
        console.warn('[naturalFeatures] GeoNames fallback failed:', e.message);
        return [];
    }
}

// Slugify a label into a stable, TYPES-safe key, e.g. "Mountain Peak" -> "mountain-peak".
function slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'feature';
}

// Builds a pseudo-"location" object matching the shape the rest of the app
// expects (rate, sqft, intel, reviews, tags) so existing card/detail
// rendering works without modification, regardless of which source (OSM or
// GeoNames) produced it. type is a dynamic slug rather than one of
// catalog.js's fixed TYPES keys — render()/openDetail() fall back to
// _icon/_label/_color (set below) when TYPES[loc.type] doesn't exist, since
// this feature type was never predefined.
function buildNaturalFeatureLocation({ id, name, lat, lng, neighborhood, wikipedia, sqft, desc, feature }) {
    return {
        id, name,
        type: slugify(feature.label),   // dynamic — not in catalog.js's TYPES
        _icon: feature.icon || '📍',
        _label: feature.label,
        _color: '#4a6fa0',
        lat, lng,
        address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        neighborhood: neighborhood || 'Unincorporated area',
        wikipedia: wikipedia || null,
        sqft: sqft || 0,
        ceilingFt: null,
        rate: 0,
        desc,
        tags: ['natural feature', feature.label.toLowerCase(), 'outdoor', 'verify public access'],
        intel: {
            crewCapacity: null,
            windows: [],
            factors: {
                parking: { score: 50, note: 'Unverified — no data source for this yet' },
                accessibility: { score: 50, note: 'Terrain varies — verify locally' },
                noise: { score: 70, note: 'Likely quiet outdoor setting, unverified' },
                privacy: { score: 30, note: 'Public land — expect other visitors' },
                power: { score: 10, note: 'No power on-site — bring generators/batteries' },
                permit: { score: 40, note: 'Public land may require a shoot permit — check local authority' },
            },
            // Same blend catalog.js's enrich() uses: (parking + accessibility + power + permit) / 4.
            productionFriendliness: 38,
            nearestAirport: { code: '—', mi: '—', name: 'Not calculated for natural features yet' },
            amenities: { equipment: 'Unknown', hotels: 'Unknown', dining: 'Unknown' },
        },
        reviews: {
            rating: 0, count: 0,
            summary: 'No review data available for natural features yet.',
            positives: [],
            considerations: ['Verify public access and permit requirements before scouting a shoot here.'],
        },
    };
}

function toFeatureLocation(el, feature, name, lat, lng, diameterFt) {
    const sizeNote = diameterFt ? `roughly ${Math.round(diameterFt)} ft across` : 'a point feature (no area)';
    return buildNaturalFeatureLocation({
        id: `feat-${slugify(feature.label)}-${el.type}-${el.id}`,
        name, lat, lng,
        neighborhood: el.tags?.['addr:city'],
        // OSM's wikipedia=lang:Title tag, when present, lets /api/place-info
        // fetch the exact matching article instead of guessing by geosearch.
        wikipedia: el.tags?.wikipedia,
        sqft: diameterFt ? Math.round(Math.PI * (diameterFt / 2) ** 2) : 0,
        desc: `A ${feature.label.toLowerCase()}, ${sizeNote}. Sourced from OpenStreetMap — ` +
            `verify public access and any permit requirements before shooting.`,
        feature,
    });
}

// GeoNames doesn't give a bounding box (just a point), so there's no size
// to estimate — unlike OSM's area features, sqft stays 0 for all of these.
function toGeoNamesLocation(g, feature) {
    return buildNaturalFeatureLocation({
        id: `geonames-${slugify(feature.label)}-${g.id}`,
        name: g.name || `Unnamed ${feature.label.toLowerCase()}`,
        lat: g.lat, lng: g.lng,
        neighborhood: g.adminName || g.countryName,
        desc: `A ${feature.label.toLowerCase()}. Sourced from GeoNames — ` +
            `verify public access and any permit requirements before shooting.`,
        feature,
    });
}