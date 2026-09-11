// DOUBLE-CLICK DIVE — every pickable dot zooms, not just the four families.
//
// Owner's brief (2026-09-11): double-clicking ANY contact/event/infrastructure
// dot must fly the camera in to a local inspect view. The known families keep
// their select/track side effects; dams, datacenters, fires, cables,
// installations — anything with a resolvable world position — dive through the
// shared `entity` world-focus framing. Empty pick / no position stays a no-op.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { diveOnPick, pickedWorldPosition } from './commandRail.js';
import { WORLD_FOCUS_FRAMING } from './worldFocus.js';

const DAM_BASE = Cesium.Cartesian3.fromDegrees(-114.9817, 36.0161, 220); // Hoover Dam
const DAM_TIP = Cesium.Cartesian3.fromDegrees(-114.9817, 36.0161, 2220);

/** gev stub with an empty (or provided) layer registry. */
function stubGev(layers = new Map()) {
  return { viewer: { name: 'stub-viewer' }, dataManager: { layers } };
}

/** Recorded focus/fly/banner seams for one dive. */
function stubDeps() {
  const calls = { focus: [], fly: [], banner: [] };
  return {
    calls,
    deps: {
      banner: { show: (text, tone) => calls.banner.push({ text, tone }) },
      focus: (detail) => { calls.focus.push(detail); return true; },
      fly: (viewer, lat, lon, options) => calls.fly.push({ viewer, lat, lon, options }),
    },
  };
}

test('a dam pick dives through the generic entity path at its stem base', () => {
  // Shape mirrors localGeojson: a GeoJSON entity tagged with the layer id,
  // carrying its sampled surface base and the stem polyline.
  const damEntity = {
    id: 'dam-42',
    name: 'Hoover Dam',
    __localLayerId: 'local-dams',
    __localBaseCartesian: DAM_BASE,
    position: { getValue: () => DAM_TIP },
    polyline: { positions: { getValue: () => [DAM_BASE, DAM_TIP] } },
  };
  const { calls, deps } = stubDeps();
  const outcome = diveOnPick(stubGev(), { id: damEntity }, deps);
  assert.equal(outcome, 'entity');
  assert.equal(calls.focus.length, 1);
  const detail = calls.focus[0];
  assert.equal(detail.kind, 'entity');
  assert.equal(detail.label, 'Hoover Dam');
  // The dive lands on the dot's true ground anchor, not the 2 km label tip.
  assert.equal(detail.position, DAM_BASE);
  // And the shared framing is a LOCAL inspect view (1–8 km order).
  assert.ok(WORLD_FOCUS_FRAMING.entity.rangeM >= 1000 && WORLD_FOCUS_FRAMING.entity.rangeM <= 8000);
  assert.equal(calls.banner[0].tone, 'ok');
  assert.match(calls.banner[0].text, /Hoover Dam/);
});

test('an earthquake pick still dives through its event handler, not the generic path', () => {
  const layers = new Map([[
    'earthquakes',
    { module: { getAnalystRecords: () => [{ id: 'us7000abcd', lat: 35.4, lon: -117.6, magnitude: 5.2, place: 'Ridgecrest, CA', timeMs: Date.now() }] } },
  ]]);
  const { calls, deps } = stubDeps();
  const outcome = diveOnPick(stubGev(layers), { id: 'earthquake:us7000abcd' }, deps);
  assert.equal(outcome, 'earthquake');
  assert.equal(calls.fly.length, 1);
  assert.equal(calls.fly[0].lat, 35.4);
  assert.equal(calls.fly[0].lon, -117.6);
  assert.equal(calls.focus.length, 0, 'the event keeps its magnitude-scaled framing');
  assert.match(calls.banner[0].text, /M5\.2/);
});

test('a prefixed pick whose record is missing still dives generically off the dot itself', () => {
  const layers = new Map([['earthquakes', { module: { getAnalystRecords: () => [] } }]]);
  const { calls, deps } = stubDeps();
  const picked = { id: 'earthquake:vanished', primitive: { position: DAM_BASE } };
  const outcome = diveOnPick(stubGev(layers), picked, deps);
  assert.equal(outcome, 'entity');
  assert.equal(calls.fly.length, 0);
  assert.equal(calls.focus[0].position, DAM_BASE);
});

test('a generic billboard primitive (fires/cables/installations shape) dives too', () => {
  const { calls, deps } = stubDeps();
  const picked = { id: 'fires:abc', primitive: { position: DAM_BASE } };
  const outcome = diveOnPick(stubGev(), picked, deps);
  assert.equal(outcome, 'entity');
  assert.equal(calls.focus[0].kind, 'entity');
  assert.equal(calls.focus[0].id, 'fires:abc');
});

test('an aircraft double-click tracks AND reapplies the follow frame', () => {
  const recorded = { track: [], refocus: [] };
  const layers = new Map([[
    'flights',
    {
      module: {
        trackById: (id, opts) => { recorded.track.push({ id, opts }); return id === 'abc123'; },
        refocusTrackedById: (id, opts) => { recorded.refocus.push({ id, opts }); return true; },
        getTrackedInfo: () => ({ callsign: 'UAL1' }),
      },
    },
  ]]);
  const { calls, deps } = stubDeps();
  const outcome = diveOnPick(stubGev(layers), { id: 'abc123' }, deps);
  assert.equal(outcome, 'aircraft');
  assert.deepEqual(recorded.track[0], { id: 'abc123', opts: { origin: 'user' } });
  // Tracking alone can leave the camera at globe scale — the dive must also
  // reapply the canonical follow frame.
  assert.equal(recorded.refocus.length, 1);
  assert.equal(recorded.refocus[0].id, 'abc123');
  assert.match(calls.banner[0].text, /UAL1/);
});

test('empty pick or unresolvable position is a strict no-op', () => {
  const { calls, deps } = stubDeps();
  assert.equal(diveOnPick(stubGev(), null, deps), null);
  assert.equal(diveOnPick(stubGev(), { id: 'mystery-with-no-position' }, deps), null);
  // Origin/garbage cartesians must not release the camera either.
  assert.equal(diveOnPick(stubGev(), { id: 'x', primitive: { position: { x: 0, y: 0, z: 0 } } }, deps), null);
  assert.equal(diveOnPick(stubGev(), { id: 'x', position: { x: NaN, y: 1, z: 1 } }, deps), null);
  assert.equal(calls.focus.length, 0);
  assert.equal(calls.fly.length, 0);
  assert.equal(calls.banner.length, 0);
});

test('pickedWorldPosition resolves every documented pick shape in preference order', () => {
  const polygonPoints = [
    Cesium.Cartesian3.fromDegrees(-114.99, 36.01),
    Cesium.Cartesian3.fromDegrees(-114.97, 36.01),
    Cesium.Cartesian3.fromDegrees(-114.98, 36.02),
  ];
  // Stem base wins over everything else.
  assert.equal(
    pickedWorldPosition({ id: { __localBaseCartesian: DAM_BASE, position: { getValue: () => DAM_TIP } } }),
    DAM_BASE,
  );
  // Polyline base beats the (tip-anchored) entity position.
  assert.equal(
    pickedWorldPosition({ id: { polyline: { positions: [DAM_BASE, DAM_TIP] }, position: DAM_TIP } }),
    DAM_BASE,
  );
  // Plain entity position, constant-property or raw.
  assert.equal(pickedWorldPosition({ id: { position: { getValue: () => DAM_TIP } } }), DAM_TIP);
  // Polygon picks resolve to their center.
  const center = pickedWorldPosition({ id: { polygon: { hierarchy: { positions: polygonPoints } } } });
  const expected = Cesium.BoundingSphere.fromPoints(polygonPoints).center;
  assert.ok(Cesium.Cartesian3.distance(center, expected) < 1);
  // Billboard/point primitives and raw pick positions.
  assert.equal(pickedWorldPosition({ id: 'str-id', primitive: { position: DAM_BASE } }), DAM_BASE);
  assert.equal(pickedWorldPosition({ position: DAM_BASE }), DAM_BASE);
  // Nothing resolvable → null.
  assert.equal(pickedWorldPosition({ id: 'str-id' }), null);
  assert.equal(pickedWorldPosition(null), null);
});
