// src/data/newsModel.js — pure presentation + selection policy for the NEWS
// layer (GDELT). No Cesium, no DOM, no fetch: safe for node unit tests and
// reused by src/data/newsGdelt.js and src/data/news.js.
//
// The layer's honesty contract (brief 2026-09-10): only articles GDELT itself
// geolocated become pins — no city stand-ins, no synthetic coordinates, no
// keyword guessing. Items without a finite lat/lon are dropped before the cap
// is applied, so the cap never silently trades a geolocated headline for a
// non-geolocated one.

export const NEWS_OVERLAY_SOURCE_ID = 'news';
export const NEWS_OVERLAY_COHORT_LIMIT = 40;
export const NEWS_OVERLAY_COLLISION_CAPACITY = 20;
/** Hard ceiling on pins rendered/retained (brief: cap 100). */
export const NEWS_PIN_CAP = 100;

/** Accent for a GDELT theme band. Kept to one family — NEWS is one feed. */
export const NEWS_ACCENT = '#4fc3f7';

/** Entity id for one geolocated article on the globe. */
export function newsEntityId(articleId) {
  return `news:${articleId}`;
}

/** Extract "example.com" from a GDELT/normal URL for the inspect panel. */
export function newsDomainFromUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Build one canonical news record from a raw GDELT article object.
 * Returns null when the article lacks the fields the layer pins on:
 * a title, a URL, and GDELT's own finite coordinates.
 *
 * @param {object} raw Article as normalized from the GDELT DOC 2.0 artlist.
 * @param {number} [index] Fallback ordinal for id stability.
 * @returns {object|null}
 */
export function mapNewsArticle(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!url || !title) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  let seenMs = Number(raw.seenMs);
  if (!Number.isFinite(seenMs) || seenMs <= 0) seenMs = null;
  const id = String(raw.id ?? `gdelt-${index}`);
  return {
    id,
    title,
    url,
    domain: typeof raw.domain === 'string' && raw.domain ? raw.domain : newsDomainFromUrl(url),
    language: typeof raw.language === 'string' ? raw.language : null,
    lat,
    lon,
    seenMs,
  };
}

/**
 * Map raw articles → canonical records: drop non-geolocated, dedupe by URL,
 * newest first, then cap at NEWS_PIN_CAP.
 *
 * @param {object[]} raws
 * @param {number} [cap]
 * @returns {object[]}
 */
export function normalizeNewsArticles(raws, cap = NEWS_PIN_CAP) {
  if (!Array.isArray(raws)) return [];
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : NEWS_PIN_CAP;
  const byUrl = new Map();
  const mapped = [];
  for (const raw of raws) {
    const record = mapNewsArticle(raw, mapped.length);
    if (!record) continue;
    if (byUrl.has(record.url)) continue;
    byUrl.set(record.url, record);
    mapped.push(record);
  }
  mapped.sort((a, b) => (b.seenMs || 0) - (a.seenMs || 0)
    || String(a.id).localeCompare(String(b.id)));
  return mapped.slice(0, limit);
}

/** Marker pixel size — recency band, 7 px floor to 12 px selected. */
export function newsPixelSize(seenMs, selected = false, nowMs = Date.now()) {
  if (selected) return 12;
  const ageHrs = Number.isFinite(seenMs) && seenMs > 0
    ? Math.max(0, (nowMs - seenMs) / 3_600_000)
    : 24;
  if (ageHrs <= 3) return 10;
  if (ageHrs <= 12) return 9;
  return 7;
}

/** One-line label for the inspect panel / banner. */
export function newsHeadlineLabel(record, maxLen = 72) {
  const title = String(record?.title || '').replace(/\s+/g, ' ').trim();
  if (title.length <= maxLen) return title;
  const cut = title.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Human age for an epoch-ms timestamp (matches the rail's vocabulary). */
export function newsAgeText(epochMs, nowMs = Date.now()) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'time unknown';
  const mins = Math.max(0, Math.round((nowMs - epochMs) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round((nowMs - epochMs) / 3_600_000);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Visible rows in the NEWS roster panel (brief 2026-09-10: cap ~40). */
export const NEWS_ROSTER_LIMIT = 40;

/**
 * Rows for the NEWS roster panel: the same geolocated records the globe pins,
 * newest first, capped to `limit`. Pure — the roster renders exactly this and
 * never invents coordinates or headlines.
 *
 * @param {object[]} records Canonical layer records.
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectNewsRosterRecords(records, limit = NEWS_ROSTER_LIMIT) {
  const list = Array.isArray(records) ? records : [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  return list
    .filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon))
    .slice()
    .sort((a, b) => (b.seenMs || 0) - (a.seenMs || 0)
      || String(a.id).localeCompare(String(b.id)))
    .slice(0, cap)
    .map((r) => ({
      id: String(r.id),
      entityId: newsEntityId(r.id),
      title: r.title,
      domain: r.domain || null,
      seenMs: Number.isFinite(r.seenMs) && r.seenMs > 0 ? r.seenMs : null,
      lat: r.lat,
      lon: r.lon,
    }));
}

/**
 * Pick the headline the NEWS chip flies to: newest geolocated record. Pure.
 * @returns {object|null}
 */
export function selectNewsFocusRecord(records, nowMs = Date.now()) {
  const list = Array.isArray(records) ? records : [];
  const geolocated = list.filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon));
  if (!geolocated.length) return null;
  geolocated.sort((a, b) => (b.seenMs || 0) - (a.seenMs || 0)
    || String(a.id).localeCompare(String(b.id)));
  return geolocated[0];
}

/**
 * Source-owned presentation for one ambient news label (same contract as the
 * conflicts/earthquakes ambient labels).
 */
export function createNewsOverlayEntry({ id, position, seenMs, title }) {
  const ageHrs = Number.isFinite(seenMs) && seenMs > 0
    ? Math.max(0, (Date.now() - seenMs) / 3_600_000)
    : null;
  return {
    id: String(id),
    position,
    variant: 'label',
    title: newsHeadlineLabel({ title }, 34),
    accent: NEWS_ACCENT,
    priority: ageHrs === null ? 50 : Math.round(Math.max(0, 2400 - ageHrs * 200)),
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
 * Keep the freshest headlines in the ambient label cohort, stable identity as
 * tie-break (same policy as earthquakes/conflicts).
 */
export function selectNewsOverlayCohort(
  entries,
  limit = NEWS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    NEWS_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}
