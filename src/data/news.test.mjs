// Pins for the NEWS layer's pure halves — GDELT GKG GEO parsing (newsGdelt.js)
// and presentation/selection policy (newsModel.js) — plus registry membership.
// Nothing here touches network or DOM; the browser layer (news.js) is
// exercised through these same pure decisions.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyEnglishTitle, parseNewsGdeltGeo } from './newsGdelt.js';
import {
  NEWS_PIN_CAP,
  NEWS_ROSTER_LIMIT,
  mapNewsArticle,
  newsAgeText,
  newsEntityId,
  newsHeadlineLabel,
  newsPixelSize,
  normalizeNewsArticles,
  selectNewsFocusRecord,
  selectNewsOverlayCohort,
  selectNewsRosterRecords,
  createNewsOverlayEntry,
} from './newsModel.js';
import { REGISTERED_LAYER_IDS } from './layerState.js';

function feature({ url = 'https://example.com/news/the-story-slug', lon = -0.12, lat = 51.5,
  date = '2026-09-10T18:45:00Z', name = 'London', tone = -1.5,
  themes = ';PROTEST_;POLICE_;' } = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { url, urlpubtimedate: date, name, urltone: tone, mentionedthemes: themes },
  };
}

test('parseNewsGdeltGeo maps features into raw article records', () => {
  const records = parseNewsGdeltGeo({ type: 'FeatureCollection', features: [feature()] });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.url, 'https://example.com/news/the-story-slug');
  assert.equal(r.title, 'the story slug', 'title derives from the URL slug');
  assert.equal(r.domain, 'example.com');
  assert.equal(r.place, 'London');
  assert.equal(r.tone, -1.5);
  assert.deepEqual(r.themes, ['PROTEST_', 'POLICE_']);
  assert.equal(r.lat, 51.5);
  assert.equal(r.lon, -0.12);
  assert.equal(typeof r.seenMs, 'number', 'urlpubtimedate parses to epoch ms');
});

test('parseNewsGdeltGeo drops ungeolocated, non-http, duplicate, and HTML payloads', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      feature({ url: 'https://a.example.com/the-one' }),
      feature({ url: 'https://a.example.com/the-one' }), // duplicate URL
      feature({ url: 'javascript:alert(1)' }), // non-http scheme
      { geometry: null, properties: { url: 'https://a.example.com/the-two' } }, // no coords
      feature({ lat: 999, lon: 0, url: 'https://a.example.com/the-three' }), // off-globe
    ],
  };
  const records = parseNewsGdeltGeo(payload);
  assert.equal(records.length, 1);
  assert.equal(records[0].url, 'https://a.example.com/the-one');

  assert.deepEqual(parseNewsGdeltGeo('<html>429 Too Many Requests</html>'), [], 'HTML error page → empty, never faked');
  assert.deepEqual(parseNewsGdeltGeo('not json at all'), []);
  assert.deepEqual(parseNewsGdeltGeo(null), []);
});

test('parseNewsGdeltGeo caps features read from a hostile payload', () => {
  const features = Array.from({ length: 30 }, (_, i) => feature({ url: `https://x.example.com/the-story-${i}` }));
  assert.equal(parseNewsGdeltGeo({ features }, 10).length, 10);
});

test('isLikelyEnglishTitle keeps English slugs and drops non-English ones', () => {
  // KEEP: English function words on a common .com domain.
  assert.ok(isLikelyEnglishTitle('president says talks will resume after ceasefire', 'news.example.com'));
  // KEEP: clearly English-press TLD even without a function word.
  assert.ok(isLikelyEnglishTitle('manchester derby ends goalless', 'bbc.co.uk'));
  // DROP: Slovak slug — no English function words.
  assert.ok(!isLikelyEnglishTitle('policajti zasahovali proti demonstrantom', 'spravy.example.com'));
  // DROP: transliterated Ukrainian slug on a .com host.
  assert.ok(!isLikelyEnglishTitle('verkhovna rada ukhvalyla zakon pro mobilizatsiyu', 'novyny.example.com'));
  // DROP: Cyrillic (substantial non-ASCII).
  assert.ok(!isLikelyEnglishTitle('війна на сході триває', 'example.com'));
  // DROP: clearly non-English TLD, even with English-looking words.
  assert.ok(!isLikelyEnglishTitle('the new report on the economy', 'dennik.example.sk'));
  // DROP: empty and one-letter titles.
  assert.ok(!isLikelyEnglishTitle('', 'example.com'));
  assert.ok(!isLikelyEnglishTitle('a', 'example.com'));
});

test('parseNewsGdeltGeo drops non-English records so they never become pins', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      feature({ url: 'https://news.example.com/president-says-talks-resume-after-ceasefire' }), // keep
      feature({ url: 'https://spravy.example.sk/policajti-zasahovali-proti-demonstrantom' }), // .sk drop
      feature({ url: 'https://novyny.example.com/verkhovna-rada-ukhvalyla-zakon-pro-mobilizatsiyu' }), // no function words
    ],
  };
  const records = parseNewsGdeltGeo(payload);
  assert.deepEqual(records.map((r) => r.url), ['https://news.example.com/president-says-talks-resume-after-ceasefire']);
});

test('mapNewsArticle enforces the pin contract: title, url, finite on-globe coords', () => {
  const base = { id: 'gdelt-x-0', title: 'T', url: 'https://e.com/a', lat: 10, lon: 20, seenMs: 1 };
  assert.ok(mapNewsArticle(base));
  assert.equal(mapNewsArticle({ ...base, lat: 'NaN' }), null);
  assert.equal(mapNewsArticle({ ...base, lat: 91 }), null);
  assert.equal(mapNewsArticle({ ...base, title: '  ' }), null);
  assert.equal(mapNewsArticle({ ...base, url: '' }), null);
  const noTime = mapNewsArticle({ ...base, seenMs: undefined });
  assert.equal(noTime.seenMs, null, 'missing time is null, never NaN');
});

test('normalizeNewsArticles drops, dedupes by URL, sorts newest-first, and caps', () => {
  const raws = [
    { id: 'a', title: 'old', url: 'https://e.com/old', lat: 1, lon: 1, seenMs: 1000 },
    { id: 'b', title: 'new', url: 'https://e.com/new', lat: 2, lon: 2, seenMs: 9000 },
    { id: 'b2', title: 'new dup', url: 'https://e.com/new', lat: 2, lon: 2, seenMs: 9500 },
    { id: 'c', title: 'no coords', url: 'https://e.com/nc' },
    { id: 'd', title: 'no time', url: 'https://e.com/nt', lat: 3, lon: 3 },
  ];
  const records = normalizeNewsArticles(raws);
  assert.deepEqual(records.map((r) => r.id), ['b', 'a', 'd'], 'newest first, dup collapsed, coordinateless dropped; unknown time last');
  assert.equal(normalizeNewsArticles(null).length, 0);
  const big = Array.from({ length: NEWS_PIN_CAP + 40 }, (_, i) => ({
    id: `r${i}`, title: 't', url: `https://e.com/${i}`, lat: 1, lon: 1, seenMs: i,
  }));
  assert.equal(normalizeNewsArticles(big).length, NEWS_PIN_CAP, 'pin cap enforced');
  assert.equal(NEWS_PIN_CAP, 100);
});

test('focus selection returns the newest geolocated record, or honest null', () => {
  const records = [
    { id: 'a', lat: 1, lon: 1, seenMs: 5000 },
    { id: 'b', lat: 2, lon: 2, seenMs: 7000 },
    { id: 'c', lat: 3, lon: 3, seenMs: null },
  ];
  assert.equal(selectNewsFocusRecord(records).id, 'b');
  assert.equal(selectNewsFocusRecord([]), null);
  assert.equal(selectNewsFocusRecord(null), null);
});

test('marker size bands by age and selection wins', () => {
  const now = Date.now();
  assert.equal(newsPixelSize(now - 60_000, false, now), 10, '<3h → 10px');
  assert.equal(newsPixelSize(now - 6 * 3_600_000, false, now), 9, '<12h → 9px');
  assert.equal(newsPixelSize(now - 48 * 3_600_000, false, now), 7, 'older → 7px');
  assert.equal(newsPixelSize(null, true, now), 12, 'selected → 12px');
});

test('age text and headline labels use the app vocabulary', () => {
  const now = Date.parse('2026-09-10T20:00:00Z');
  assert.equal(newsAgeText(now - 5 * 60_000, now), '5m ago');
  assert.equal(newsAgeText(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(newsAgeText(null, now), 'time unknown');
  assert.equal(newsHeadlineLabel({ title: 'short' }), 'short');
  assert.ok(newsHeadlineLabel({ title: 'x'.repeat(120) }).length <= 73);
  assert.equal(newsHeadlineLabel({}), '');
});

test('overlay cohort ranks by priority with stable id tiebreak and caps', () => {
  const entries = [
    createNewsOverlayEntry({ id: '10', position: {}, seenMs: Date.now() - 1000, title: 'fresh' }),
    createNewsOverlayEntry({ id: '2', position: {}, seenMs: Date.now() - 1000, title: 'fresh too' }),
    createNewsOverlayEntry({ id: '9', position: {}, seenMs: Date.now() - 26 * 3_600_000, title: 'old' }),
    createNewsOverlayEntry({ id: '7', position: {}, seenMs: null, title: 'no time' }),
  ];
  const cohort = selectNewsOverlayCohort(entries, 3);
  assert.deepEqual(cohort.map((e) => e.id), ['10', '2', '7'], 'freshest first; unknown time (50) outranks a day-old (0)');
  assert.equal(selectNewsOverlayCohort(entries, 0).length, 0);
  assert.equal(selectNewsOverlayCohort(null).length, 0);
});

test('selectNewsRosterRecords builds fly-ready rows, newest first, capped at the roster limit', () => {
  const raws = Array.from({ length: 60 }, (_, i) => ({
    id: `a-${String(i).padStart(2, '0')}`,
    title: `Headline ${i}`,
    url: `https://e.example.com/${i}`,
    domain: 'e.example.com',
    lat: 10 + i,
    lon: 20,
    seenMs: 1_000 + i, // ascending: later index = newer
  }));
  const rows = selectNewsRosterRecords(raws);
  assert.equal(rows.length, NEWS_ROSTER_LIMIT);
  assert.equal(rows[0].title, 'Headline 59', 'newest first');
  assert.equal(rows[rows.length - 1].title, `Headline ${60 - NEWS_ROSTER_LIMIT}`);
  assert.equal(rows[0].entityId, 'news:a-59');
  assert.ok(rows.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)), 'every row is flyable');
  assert.deepEqual(selectNewsRosterRecords([]), [], 'empty feed → empty roster, never faked');
  assert.deepEqual(selectNewsRosterRecords(null), []);
  const noCoords = selectNewsRosterRecords([{ id: 'x', title: 'T', url: 'https://e.com/x', lat: 'NaN', lon: 0, seenMs: 1 }]);
  assert.deepEqual(noCoords, [], 'ungeolocated record is not a roster row');
});

test('entity ids are stable vocabulary', () => {
  assert.equal(newsEntityId('gdelt-example.com-0'), 'news:gdelt-example.com-0');
});

test('the news layer is registered in the sealed layer-state registry', () => {
  assert.ok(REGISTERED_LAYER_IDS.includes('news'));
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, REGISTERED_LAYER_IDS.length);
});
