// src/data/newsGdelt.js — GDELT GKG GEO API (v1 gkg_geojson) parser: GeoJSON
// FeatureCollection → raw article records with GDELT's own coordinates.
// Pure — no fetch, no DOM. Used by the /api/news proxy (vite.config.js) and
// pinned by unit tests (news.test.mjs). The browser-side layer module
// (news.js) consumes the proxy's normalized payload.
//
// Honesty contract: coordinates come from GDELT's own geolocation of the
// coverage (geometry.coordinates), never from a city-name lookup or keyword
// guess. The article link is the API's own per-article `url` field; the title
// is derived deterministically from that URL's slug — payload parsing only,
// never an article fetch. Points without a parseable article link or finite
// coordinates are dropped.
//
// Upstream shape (default OUTPUTFIELDS):
//   { "type": "FeatureCollection", "features": [
//     { "type": "Feature", "geometry": { "type": "Point", "coordinates": [lon, lat] },
//       "properties": { "urlpubtimedate": "2026-09-10T18:45:00Z", "name": "Peru",
//                       "urltone": 1.67, "url": "https://…", "mentionedthemes": ";…;" } } ] }

/** Take the last path segment of an article URL and turn it into a headline. */
function slugTitleFromUrl(rawUrl, maxLen = 140) {
  let path;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return '';
  }
  const segments = path.split('/').filter(Boolean);
  let slug = segments[segments.length - 1] || segments[segments.length - 2] || '';
  // Strip common trailing artifacts: extension, long digit ids, trailing id-…-slug
  slug = slug
    .replace(/\.(?:html?|php|aspx?|jsp)$/i, '')
    .replace(/^[0-9]+[-_]/, '')
    .replace(/[-_][0-9]{3,}$/, '');
  const words = decodeURIComponent(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  return words.length <= maxLen ? words : `${words.slice(0, maxLen).trim()}…`;
}

/** ISO-8601 like "2026-09-10T18:45:00Z" → epoch ms; null when unparseable. */
function parseGdeltIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derive the display title: prefer an explicit title-bearing field (future
 * OUTPUTFIELDS additions), else the URL slug.
 * @returns {string}
 */
function featureTitle(properties) {
  const explicit = typeof properties?.title === 'string' ? properties.title.trim() : '';
  if (explicit) return explicit.slice(0, 200);
  return slugTitleFromUrl(properties?.url || '');
}

// English-only heuristic (Brian's rule): no translation, no scraping — a pure
// title/domain check so non-English records never become pins or roster rows.
const ENGLISH_FUNCTION_WORDS = new Set([
  'the', 'and', 'of', 'in', 'to', 'for', 'on', 'with', 'from', 'after', 'new',
  'says', 'over', 'into', 'as', 'at', 'by', 'is', 'are', 'was', 'a', 'an',
]);

// TLDs that clearly signal English-language press.
const ENGLISH_TLDS = new Set(['uk', 'us', 'au', 'ie', 'nz']);

// TLDs that clearly signal non-English-language press.
const NON_ENGLISH_TLDS = new Set([
  'ru', 'cn', 'jp', 'kr', 'br', 'mx', 'de', 'it', 'sk', 'fi', 'gr', 'ua', 'pl',
  'cz', 'tr', 'fr', 'es', 'pt', 'nl', 'se', 'no', 'dk', 'hu', 'ro', 'bg', 'rs',
  'hr', 'si', 'at', 'ch', 'be', 'id', 'th', 'vn', 'tw', 'ir', 'sa', 'eg', 'ar',
  'cl', 'pe', 've', 'co',
]);

/**
 * Pure heuristic: is this slug-derived title likely English? KEEP when the
 * title is mostly ASCII letters and either contains an English function word
 * or the domain's TLD is clearly English press. DROP on substantial
 * non-ASCII, one-letter titles, or clearly non-English TLDs.
 *
 * @param {string} title
 * @param {?string} [domain] Hostname (no scheme), e.g. "bbc.co.uk".
 * @returns {boolean}
 */
export function isLikelyEnglishTitle(title, domain = null) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (text.length < 2) return false; // empty or one letter

  const chars = [...text];
  const nonAscii = chars.filter((c) => c.codePointAt(0) > 127).length;
  if (nonAscii / chars.length > 0.1) return false; // substantial non-ASCII

  const nonSpace = chars.filter((c) => !/\s/.test(c)).length;
  const asciiLetters = (text.match(/[a-z]/gi) || []).length;
  if (nonSpace === 0 || asciiLetters / nonSpace < 0.5) return false; // not mostly ASCII letters

  const host = typeof domain === 'string' ? domain.toLowerCase().trim() : '';
  const labels = host.split('.').filter(Boolean);
  const tld = labels[labels.length - 1] || '';
  if (NON_ENGLISH_TLDS.has(tld)) return false; // clearly non-English press

  const words = text.toLowerCase().split(/[^a-z']+/);
  if (words.some((w) => ENGLISH_FUNCTION_WORDS.has(w))) return true;
  return ENGLISH_TLDS.has(tld); // clearly English press even without function words
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Parse a GDELT GKG GEO GeoJSON payload into raw article records (pre-pin
 * normalization — newsModel.mapNewsArticle enforces the pin contract).
 * Dedupes by URL, drops ungeolocated features and features without a
 * parseable article link.
 *
 * @param {string|object} payload Raw response body (text or parsed object).
 * @param {number} [maxFeatures] Hard ceiling on features read (default 2500).
 * @returns {Array<{id:string,title:string,url:string,lat:number,lon:number,domain:?string,language:?string,place:?string,themes:?string[],tone:?number,seenMs:?number}>}
 */
export function parseNewsGdeltGeo(payload, maxFeatures = 2500) {
  let parsed = payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed || trimmed.startsWith('<')) return []; // HTML error page
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  const cap = Number.isFinite(maxFeatures) && maxFeatures > 0 ? Math.floor(maxFeatures) : 2500;
  const seen = new Set();
  const records = [];
  for (const feature of features.slice(0, cap)) {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const properties = feature?.properties || {};
    const url = safeHttpUrl(properties.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = featureTitle(properties);
    if (!title) continue;
    let domain = null;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
    if (!isLikelyEnglishTitle(title, domain)) continue; // English-only feed; dropped here so it never pins
    const themes = typeof properties.mentionedthemes === 'string' && properties.mentionedthemes.trim()
      ? properties.mentionedthemes.split(';').map((t) => t.trim()).filter(Boolean).slice(0, 12)
      : [];
    records.push({
      id: `gdelt-${domain || 'x'}-${records.length}`,
      title,
      url,
      domain,
      language: null,
      place: typeof properties.name === 'string' && properties.name.trim() ? properties.name.trim().slice(0, 90) : null,
      themes,
      tone: Number.isFinite(Number(properties.urltone)) ? Number(properties.urltone) : null,
      lat,
      lon,
      seenMs: parseGdeltIsoMs(properties.urlpubtimedate),
    });
  }
  return records;
}
