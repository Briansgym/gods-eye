// src/maps/mapsCost.test.mjs
// Run: node --test src/maps/mapsCost.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAPS_SKUS,
  MAPS_COST_LIMITS,
  classifyMapsUrl,
  createMapsCostTracker,
  formatCostUsd,
} from './mapsCost.js';

const TILE_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json?session=abc';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json?address=Reno';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

test('1000 tile.googleapis.com requests ≈ $6 (Photorealistic 3D Tiles)', () => {
  const tracker = createMapsCostTracker();
  for (let i = 0; i < 1000; i++) tracker.recordUrl(TILE_URL);
  assert.ok(Math.abs(tracker.usd() - 6) < 1e-9, `expected ≈6, got ${tracker.usd()}`);
  assert.equal(tracker.counts().tiles3d, 1000);
  assert.equal(tracker.state().display, '~$6.00');
});

test('geocode URL bills at the Geocoding rate ($5/1000)', () => {
  const tracker = createMapsCostTracker();
  const state = tracker.recordUrl(GEOCODE_URL);
  assert.equal(classifyMapsUrl(GEOCODE_URL), 'geocoding');
  assert.equal(state.counts.geocoding, 1);
  assert.ok(Math.abs(tracker.usd() - MAPS_SKUS.geocoding.usdPer1000 / 1000) < 1e-12);
});

test('places hosts and /place paths bill at the Places rate', () => {
  const tracker = createMapsCostTracker();
  tracker.recordUrl(PLACES_URL);
  tracker.recordUrl('https://maps.googleapis.com/maps/api/place/textsearch/json?query=x');
  assert.equal(tracker.counts().places, 2);
  assert.ok(Math.abs(tracker.usd() - (2 * MAPS_SKUS.places.usdPer1000) / 1000) < 1e-12);
});

test('other maps.googleapis.com traffic falls back to Map Tiles 2D rate', () => {
  const tracker = createMapsCostTracker();
  tracker.recordUrl('https://maps.googleapis.com/maps/api/js?v=weekly');
  assert.equal(tracker.counts().tiles2d, 1);
  assert.ok(Math.abs(tracker.usd() - MAPS_SKUS.tiles2d.usdPer1000 / 1000) < 1e-12);
});

test('unknown / hostile URLs never crash and never bill', () => {
  const tracker = createMapsCostTracker();
  const junk = [
    'https://example.com/geocode', // wrong host, geocode-looking path
    '/api/openai/hud-summary', // relative app URL
    '',
    null,
    undefined,
    42,
    {},
    'not a url at all %%%',
  ];
  for (const url of junk) {
    assert.doesNotThrow(() => tracker.recordUrl(url));
  }
  assert.equal(tracker.usd(), 0);
  assert.equal(tracker.state().requests, 0);
  assert.equal(tracker.state().level, 'ok');
});

test('warn latches once at $2 and there is no cap level', () => {
  const tracker = createMapsCostTracker();
  assert.equal(MAPS_COST_LIMITS.warnUsd, 2);
  // 333 tile requests = $1.998 — still ok.
  for (let i = 0; i < 333; i++) tracker.recordUrl(TILE_URL);
  assert.equal(tracker.state().level, 'ok');
  // Request 334 crosses $2: warnCrossed fires exactly once, then latches.
  const crossing = tracker.recordUrl(TILE_URL);
  assert.equal(crossing.level, 'warn');
  assert.equal(crossing.warnCrossed, true);
  const after = tracker.recordUrl(TILE_URL);
  assert.equal(after.level, 'warn');
  assert.equal(after.warnCrossed, false);
  // No hard-kill semantics for Maps — level never becomes 'cap'.
  for (let i = 0; i < 2000; i++) tracker.recordUrl(TILE_URL);
  assert.equal(tracker.state().level, 'warn');
});

test('subscribe notifies on record and unsubscribe stops it', () => {
  const tracker = createMapsCostTracker();
  const seen = [];
  const off = tracker.subscribe((state) => seen.push(state.requests));
  tracker.recordUrl(TILE_URL);
  tracker.recordUrl('https://example.com/ignored'); // not Maps → no notify
  assert.deepEqual(seen, [1]);
  off();
  tracker.recordUrl(TILE_URL);
  assert.deepEqual(seen, [1]);
});

test('reset zeroes the meter but keeps the formatter contract', () => {
  const tracker = createMapsCostTracker();
  tracker.recordUrl(TILE_URL);
  const state = tracker.reset();
  assert.equal(state.totalUsd, 0);
  assert.equal(state.display, formatCostUsd(0));
});
