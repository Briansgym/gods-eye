// src/data/conflictsModel.js — pure presentation decisions for the Conflicts
// layer. No Cesium, no DOM: safe for node unit tests and reused by
// src/data/conflicts.js.
//
// UCDP type_of_violence coding (Candidate GED codebook):
//   1 = state-based armed conflict
//   2 = non-state conflict
//   3 = one-sided violence against civilians

export const CONFLICTS_OVERLAY_SOURCE_ID = 'conflicts';
export const CONFLICTS_OVERLAY_COHORT_LIMIT = 96;
export const CONFLICTS_OVERLAY_COLLISION_CAPACITY = 48;

/** UCDP type_of_violence code → analyst label. */
export const CONFLICT_TYPE_LABELS = Object.freeze({
  1: 'STATE-BASED',
  2: 'NON-STATE',
  3: 'ONE-SIDED',
});

/** UCDP type_of_violence code → accent color (same band palette as quakes). */
export const CONFLICT_TYPE_ACCENTS = Object.freeze({
  1: '#ff5252',
  2: '#ffa726',
  3: '#ffee58',
});

/** @param {number|null} type @returns {string} */
export function conflictTypeLabel(type) {
  return CONFLICT_TYPE_LABELS[type] || 'ARMED CONFLICT';
}

/** @param {number|null} type @returns {string} css color string */
export function conflictTypeAccent(type) {
  return CONFLICT_TYPE_ACCENTS[type] || '#ff5252';
}

/** Entity id for one UCDP event on the globe. */
export function conflictEntityId(recordId) {
  return `conflict:${recordId}`;
}

/**
 * Camera range for a conflict dive: 18 km floor, 90 km ceiling, sqrt-scaled by
 * fatalities in between (deadlier event → wider framing, same shape as the
 * marker-size curve).
 * @param {number|null} deaths Fatality best estimate.
 * @returns {number}
 */
export function conflictRangeM(deaths) {
  const fatal = Number.isFinite(Number(deaths)) ? Math.max(0, Number(deaths)) : 0;
  return Math.round(Math.min(90000, 18000 + Math.sqrt(fatal) * 7200));
}

/**
 * Banner text for a conflict dive. Accepts either record shape — raw layer
 * records expose `best`, analyst records expose `deathsBest`.
 * @param {object} record Conflict record (raw or analyst shape).
 * @returns {string}
 */
export function conflictDiveBanner(record) {
  const r = record || {};
  const title = r.conflict || r.dyad || 'ARMED CONFLICT';
  const raw = r.deathsBest ?? r.best;
  // null/undefined are unknown; an explicit 0 is a real count (UCDP semantics).
  const toll = (raw === null || raw === undefined || raw === '')
    ? 'fatalities unknown'
    : `${Number(raw)} fatalities`;
  const place = r.country || r.region || null;
  const date = r.dateStart ? String(r.dateStart).slice(0, 10) : null;
  return [
    `${title} — ${conflictTypeLabel(r.type)}`,
    toll,
    place,
    date,
    'UCDP GED',
  ].filter(Boolean).join(' · ');
}

/**
 * Resolve a `conflict:<id>` scene pick against the layer's analyst records.
 * Never dives on an ungeolocatable match — empty stays empty, no fake coords.
 * @param {object[]|null} records Analyst records from getAnalystRecords().
 * @param {string|null} pickedId Canonical pick id from the dive handler.
 * @returns {object|null} The matched record, or null.
 */
export function resolveConflictDive(records, pickedId) {
  const prefix = 'conflict:';
  if (!Array.isArray(records) || typeof pickedId !== 'string' || !pickedId.startsWith(prefix)) {
    return null;
  }
  const wanted = pickedId.slice(prefix.length);
  const match = records.find((r) => String(r.id) === wanted || String(r.id) === pickedId);
  // Number(null) is 0, so reject nullish coords BEFORE numeric coercion.
  const geolocated = match != null
    && match.lat != null && match.lon != null
    && Number.isFinite(Number(match.lat)) && Number.isFinite(Number(match.lon));
  return geolocated ? match : null;
}

/**
 * Marker pixel size from the UCDP `best` fatality estimate — 7 px floor,
 * 13 px ceiling, sqrt-scaled in between (25 dead ≈ 12 px, 50+ caps).
 * @param {number|null} best Fatality best estimate.
 * @param {boolean} [selected=false]
 * @returns {number}
 */
export function conflictPixelSize(best, selected = false) {
  if (selected) return 13;
  const deaths = Number.isFinite(Number(best)) ? Math.max(0, Number(best)) : 0;
  return Math.min(13, Math.round(7 + Math.sqrt(deaths) * 0.9));
}

/**
 * Source-owned presentation for one ambient fatality label (same contract as
 * the earthquakes layer's ambient magnitude labels).
 * @param {object} input
 * @param {string} input.id Stable id (UCDP event id).
 * @param {object} input.position Ground anchor (Cesium Cartesian3).
 * @param {number|null} input.best UCDP best fatality estimate.
 * @param {string} input.accent Accent color for the type band.
 * @returns {object}
 */
export function createConflictOverlayEntry({ id, position, best, accent }) {
  const deaths = Number.isFinite(Number(best)) ? Math.max(0, Number(best)) : 0;
  return {
    id: String(id),
    position,
    variant: 'label',
    title: deaths > 0 ? `${deaths} fat.` : 'conflict',
    accent,
    priority: Math.round(deaths * 100 + 50),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Keep the deadliest events in the ambient label cohort, with stable identity
 * as the tie-break (same policy as earthquakes).
 * @param {object[]} entries
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectConflictOverlayCohort(
  entries,
  limit = CONFLICTS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    CONFLICTS_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}
