// AI suitability scoring. Blends the user's prompt + filters with each
// location's attributes and modeled production intelligence into an overall
// match percentage and a nine-factor breakdown, each with a short
// explanation and a confidence level. Deterministic and explainable — no black
// box — so a scout can see exactly why a place scored the way it did.

import { TYPES } from './catalog.js';

const FACTORS = [
  { key: 'visual',   label: 'Visual Match',           weight: 26 },
  { key: 'lighting', label: 'Lighting',               weight: 16 },
  { key: 'space',    label: 'Space & Scale',          weight: 12 },
  { key: 'parking',  label: 'Parking',                weight: 9  },
  { key: 'access',   label: 'Accessibility',          weight: 9  },
  { key: 'noise',    label: 'Noise Level',            weight: 9  },
  { key: 'privacy',  label: 'Privacy',                weight: 8  },
  { key: 'prod',     label: 'Production Friendliness', weight: 7 },
  { key: 'permit',   label: 'Permit Complexity',      weight: 4  },
];

function visualMatch(loc, state, q) {
  const wantedTypes = new Set([...state.types, ...(q ? q.types : [])]);
  let score = 70, conf = 'medium', bits = [];

  if (wantedTypes.size) {
    // Dynamic natural-feature results (lakes, rivers, ...) carry a type slug
    // that isn't one of catalog.js's fixed TYPES keys — fall back to their
    // own _label, same convention app.js's typeInfo() uses.
    const t = TYPES[loc.type];
    const typeLabel = (t ? t.label : loc._label || 'location').toLowerCase();
    if (wantedTypes.has(loc.type)) { score = 92; conf = 'high'; bits.push(`is a ${typeLabel}`); }
    else { score = 34; conf = 'high'; bits.push(`is a ${typeLabel}, not the requested type`); }
  }

  // style / mood keyword overlap against tags + description
  if (q && q.styleWords.length) {
    const hay = (loc.tags.join(' ') + ' ' + loc.desc + ' ' + loc.name).toLowerCase();
    const hits = q.styleWords.filter(w => hay.includes(w.replace('exposed brick', 'brick')));
    if (hits.length) {
      score = Math.min(100, score + hits.length * 8);
      conf = 'high';
      bits.push(`matches “${hits.slice(0, 3).join('”, “')}”`);
    } else if (wantedTypes.has(loc.type)) {
      score = Math.max(40, score - 12);
      bits.push(`no strong match on style cues`);
    }
  }
  const note = bits.length ? cap(bits.join('; ')) + '.' : 'General fit for the brief.';
  return { score: clamp(score), note, confidence: conf };
}

function lightingMatch(loc, state, q) {
  // Natural-feature results have no modeled light condition at all.
  if (!loc.light) return { score: 60, note: 'Natural light not modeled for this feature.', confidence: 'low' };
  const desired = (q && q.light) || (state.light !== 'any' ? state.light : null);
  const rank = { controlled: 0, moderate: 1, abundant: 2 };
  if (!desired) return { score: 78, note: `${cap(loc.light)} natural light.`, confidence: 'low' };
  if (loc.light === desired) return { score: 95, note: `Exactly the ${desired} light you asked for.`, confidence: 'high' };
  const diff = Math.abs(rank[loc.light] - rank[desired]);
  const score = diff === 1 ? 66 : 40;
  return { score, note: `Has ${loc.light} light; you wanted ${desired}.`, confidence: 'high' };
}

function spaceMatch(loc, state, q) {
  const min = Math.max(state.minSqft || 0, (q && q.minSqft) || 0);
  if (!min) {
    const crewNote = loc.intel.crewCapacity != null ? ` · fits ~${loc.intel.crewCapacity} crew` : '';
    return { score: 82, note: `${loc.sqft.toLocaleString()} ft²${crewNote}.`, confidence: 'medium' };
  }
  if (loc.sqft >= min) return { score: 94, note: `${loc.sqft.toLocaleString()} ft² clears your ${min.toLocaleString()} ft² floor.`, confidence: 'high' };
  const ratio = loc.sqft / min;
  return { score: clamp(ratio * 70), note: `${loc.sqft.toLocaleString()} ft² is under your ${min.toLocaleString()} ft² target.`, confidence: 'high' };
}

const fromIntel = (loc, key) => {
  const f = loc.intel.factors[key];
  return { score: f.score, note: f.note, confidence: 'medium' };
};

export function computeSuitability(loc, state, q) {
  const parts = {
    visual:  visualMatch(loc, state, q),
    lighting: lightingMatch(loc, state, q),
    space:   spaceMatch(loc, state, q),
    parking: fromIntel(loc, 'parking'),
    access:  fromIntel(loc, 'accessibility'),
    noise:   fromIntel(loc, 'noise'),
    privacy: fromIntel(loc, 'privacy'),
    prod:    { score: loc.intel.productionFriendliness, note: 'Blend of power, load-in, parking and permits.', confidence: 'medium' },
    permit:  fromIntel(loc, 'permit'),
  };

  let total = 0, wsum = 0;
  const breakdown = FACTORS.map(f => {
    const p = parts[f.key];
    total += p.score * f.weight; wsum += f.weight;
    return { ...f, score: p.score, note: p.note, confidence: p.confidence };
  });
  let overall = total / wsum;

  // hard-constraint nudges from explicit budget
  const maxRate = Math.min(state.maxRate ?? Infinity, (q && q.maxRate) || Infinity);
  if (isFinite(maxRate) && loc.rate > maxRate) overall -= Math.min(18, (loc.rate - maxRate) / maxRate * 40);

  overall = clamp(overall);
  const strong = breakdown.filter(b => b.confidence === 'high').length;
  const confidence = q && q.raw && strong >= 2 ? 'high' : strong >= 1 ? 'medium' : 'low';

  return { overall, confidence, breakdown };
}

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
