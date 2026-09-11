// GEV COMMAND BUS (server half) — pin the vocabulary, the fly plan, and the
// loopback gate.
//
// The brief (2026-09-09): POST /api/gev/command drives the OPEN browser tab
// via SSE; no tab connected answers honest no_open_globe; fly geocodes through
// Nominatim OSM — never Google, never OpenAI. These tests pin the pure halves
// (parse, fly plan, admission, route registration) without a live server; the
// live curl contract is exercised in the browser. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGevCommandRequest,
  nominatimFlyPlan,
  admitGevCommandBusRequest,
} from '../vite.config.js';

// --- parseGevCommandRequest -------------------------------------------------

test('parse: fly requires a non-empty query, whitespace-normalized, length-capped', () => {
  assert.deepEqual(parseGevCommandRequest({ action: 'fly', query: '  london  ' }), {
    ok: true,
    command: { action: 'fly', query: 'london' },
  });
  assert.equal(parseGevCommandRequest({ action: 'fly', query: '   ' }).ok, false);
  assert.equal(parseGevCommandRequest({ action: 'fly' }).ok, false);
  const capped = parseGevCommandRequest({ action: 'fly', query: 'x'.repeat(500) });
  assert.equal(capped.ok, true);
  assert.equal(capped.command.query.length, 200);
});

test('parse: chip vocabulary is exactly ships|planes|events', () => {
  assert.deepEqual(parseGevCommandRequest({ action: 'chip', id: 'planes' }), {
    ok: true,
    command: { action: 'chip', id: 'planes' },
  });
  assert.deepEqual(parseGevCommandRequest({ action: 'CHIP', id: 'SHIPS' }), {
    ok: true,
    command: { action: 'chip', id: 'ships' },
  });
  for (const bad of ['cctv', 'satellites', '', undefined]) {
    assert.equal(parseGevCommandRequest({ action: 'chip', id: bad }).ok, false, `chip ${bad}`);
  }
});

test('parse: cctv accepts real booleans and string booleans only', () => {
  assert.deepEqual(parseGevCommandRequest({ action: 'cctv', on: true }).command, { action: 'cctv', on: true });
  assert.deepEqual(parseGevCommandRequest({ action: 'cctv', on: false }).command, { action: 'cctv', on: false });
  assert.deepEqual(parseGevCommandRequest({ action: 'cctv', on: 'true' }).command, { action: 'cctv', on: true });
  assert.equal(parseGevCommandRequest({ action: 'cctv', on: 'yes' }).ok, false);
  assert.equal(parseGevCommandRequest({ action: 'cctv' }).ok, false);
  assert.equal(parseGevCommandRequest({ action: 'cctv', on: 1 }).ok, false);
});

test('parse: contacts takes no arguments; unknown actions and shapes are refused', () => {
  assert.deepEqual(parseGevCommandRequest({ action: 'contacts' }), {
    ok: true,
    command: { action: 'contacts' },
  });
  assert.equal(parseGevCommandRequest({ action: 'self-destruct' }).ok, false);
  assert.equal(parseGevCommandRequest({}).ok, false);
  assert.equal(parseGevCommandRequest(null).ok, false);
  assert.equal(parseGevCommandRequest('fly').ok, false);
  assert.equal(parseGevCommandRequest([{ action: 'fly', query: 'x' }]).ok, false);
});

// --- nominatimFlyPlan --------------------------------------------------------

test('fly plan: a Nominatim city hit frames its bbox diagonal', () => {
  const plan = nominatimFlyPlan({
    lat: '51.5074',
    lon: '-0.1278',
    display_name: 'London, Greater London, England, United Kingdom',
    boundingbox: ['51.2867', '51.6919', '-0.5103', '0.3340'],
  });
  assert.equal(plan.lat, 51.5074);
  assert.equal(plan.lon, -0.1278);
  assert.equal(plan.label, 'London, Greater London, England, United Kingdom');
  assert.equal(plan.pitch, -50);
  // ~0.4° lat x ~0.84° lon diag ≈ 100 km → framed at 1.35x, not a city default
  assert.ok(plan.rangeM > 80_000 && plan.rangeM < 160_000, `range ${plan.rangeM}`);
});

test('fly plan: huge bboxes clamp to orbit-scale, tiny ones to close range, none to city default', () => {
  const country = nominatimFlyPlan({
    lat: '54.0', lon: '-2.0', display_name: 'United Kingdom',
    boundingbox: ['-90', '90', '-180', '180'],
  });
  assert.equal(country.rangeM, 9_000_000);
  const spot = nominatimFlyPlan({
    lat: '48.8584', lon: '2.2945', display_name: 'Eiffel Tower',
    boundingbox: ['48.8583', '48.8585', '2.2944', '2.2946'],
  });
  assert.equal(spot.rangeM, 2_000);
  const bare = nominatimFlyPlan({ lat: '35.68', lon: '139.69' });
  assert.equal(bare.rangeM, 25_000);
  assert.equal(bare.label, null);
});

test('fly plan: a hit without finite lat/lon is a null — never a fake flight', () => {
  assert.equal(nominatimFlyPlan(null), null);
  assert.equal(nominatimFlyPlan({}), null);
  assert.equal(nominatimFlyPlan({ lat: 'NaN', lon: '0' }), null);
  assert.equal(nominatimFlyPlan({ lat: '91', lon: '0' }), null);
  assert.equal(nominatimFlyPlan({ lat: '0', lon: '181' }), null);
});

// --- admitGevCommandBusRequest ----------------------------------------------

const TAILSCALE = [
  'localhost', '127.0.0.1', '.local',
  'athenas-mac-mini.tail1b56bd.ts.net',
  '.tail1b56bd.ts.net',
];

test('POST gate: loopback socket + local Host header required', () => {
  const base = { channel: 'post', method: 'POST', hostHeader: 'localhost:4173', contentType: 'application/json' };
  assert.deepEqual(admitGevCommandBusRequest({ ...base, remoteAddress: '127.0.0.1' }), { ok: true });
  assert.deepEqual(admitGevCommandBusRequest({ ...base, remoteAddress: '::1' }), { ok: true });
  assert.deepEqual(admitGevCommandBusRequest({ ...base, remoteAddress: '::ffff:127.0.0.1' }), { ok: true });
  // LAN peers refused even when the server is bound wide.
  const lan = admitGevCommandBusRequest({ ...base, remoteAddress: '192.168.1.44' });
  assert.equal(lan.ok, false);
  assert.equal(lan.status, 403);
  // Foreign Host (DNS rebinding) refused even from loopback.
  const rebind = admitGevCommandBusRequest({ ...base, remoteAddress: '127.0.0.1', hostHeader: 'evil.example:4173' });
  assert.equal(rebind.ok, false);
  assert.equal(rebind.status, 403);
  // Tailscale serves the tab but never carries the POST — loopback only.
  const ts = admitGevCommandBusRequest({
    ...base, remoteAddress: '127.0.0.1',
    hostHeader: 'athenas-mac-mini.tail1b56bd.ts.net:4173',
    allowedHosts: TAILSCALE,
  });
  assert.equal(ts.ok, false);
});

test('POST gate: method, content-type, and cross-origin Origin checks', () => {
  const base = { channel: 'post', method: 'POST', remoteAddress: '127.0.0.1', hostHeader: '127.0.0.1:4173' };
  assert.equal(admitGevCommandBusRequest({ ...base, contentType: 'text/plain' }).status, 415);
  assert.equal(admitGevCommandBusRequest({ ...base, method: 'GET', contentType: 'application/json' }).status, 405);
  // A browser Origin must match exactly; curl/node omit it and pass.
  assert.deepEqual(
    admitGevCommandBusRequest({ ...base, contentType: 'application/json', origin: 'http://127.0.0.1:4173' }),
    { ok: true },
  );
  const foreign = admitGevCommandBusRequest({
    ...base, contentType: 'application/json', origin: 'https://evil.example',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 403);
});

test('SSE gate: GET + any locally-served hostname (Tailscale and .local included)', () => {
  const ok = (over) => admitGevCommandBusRequest({
    channel: 'sse', method: 'GET', remoteAddress: '192.168.1.44', allowedHosts: TAILSCALE, ...over,
  });
  assert.deepEqual(ok({ hostHeader: 'localhost:4173' }), { ok: true });
  assert.deepEqual(ok({ hostHeader: 'athenas-mac-mini.tail1b56bd.ts.net' }), { ok: true });
  assert.deepEqual(ok({ hostHeader: 'something.tail1b56bd.ts.net:443' }), { ok: true });
  assert.deepEqual(ok({ hostHeader: 'imac.local:4173' }), { ok: true });
  const foreign = ok({ hostHeader: 'evil.example' });
  assert.equal(foreign.ok, false);
  assert.equal(ok({ method: 'POST', hostHeader: 'localhost:4173' }).status, 405);
});

// --- plugin wiring -----------------------------------------------------------

test('plugin registers both endpoints on dev and preview servers', async () => {
  // The factory takes ({ mode }); pull the plugin straight from a built config.
  const { default: defineViteConfig } = await import('../vite.config.js');
  const config = await defineViteConfig({ mode: 'development', command: 'serve' });
  const plugin = config.plugins.find((p) => p && p.name === 'gev-command-bus');
  assert.ok(plugin, 'gev-command-bus plugin registered');
  const registered = [];
  const fakeServer = { middlewares: { use: (p, fn) => registered.push(p) } };
  plugin.configureServer(fakeServer);
  plugin.configurePreviewServer(fakeServer);
  assert.deepEqual(registered.sort(), ['/api/gev/command', '/api/gev/command', '/api/gev/commands', '/api/gev/commands']);
});
