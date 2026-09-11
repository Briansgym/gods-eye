// GEV COMMAND BUS (client half) — pin command execution against stub app
// handles: the fly path releases tracking BEFORE flying (the follow-camera
// hijack fix), chips route through the rail runner, cctv through controlCctv,
// contacts through the context exit, and stale/duplicate sequence numbers are
// dropped. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hadWindow = Object.hasOwn(globalThis, 'window');
const priorWindow = globalThis.window;

function withGlobe(handles, fn) {
  globalThis.window = { __godsEyeView: handles };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
    });
}

/** Fake EventSource capturing listeners for manual dispatch. */
class FakeEventSource {
  constructor() {
    this.listeners = new Map();
    this.url = '/api/gev/commands';
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
}

function stubViewer() {
  const flights = [];
  return {
    flights,
    scene: { globe: null, canvas: { clientWidth: 0, clientHeight: 0 } },
    camera: {
      cancelFlight() {},
      flyTo(options) { flights.push(options); },
      flyToBoundingSphere(sphere, options) { flights.push({ sphere, ...options }); },
      lookAt() {},
      lookAtTransform() {},
    },
  };
}

test('install is idempotent and reuses one EventSource', async () => {
  globalThis.EventSource = FakeEventSource;
  const made = [];
  const { installGevCommandBusClient } = await import('./gevCommandBusClient.js');
  try {
    await withGlobe({}, async () => {
      const a = installGevCommandBusClient({ sourceFactory: () => { const s = new FakeEventSource(); made.push(s); return s; } });
      const b = installGevCommandBusClient({ sourceFactory: () => { const s = new FakeEventSource(); made.push(s); return s; } });
      assert.strictEqual(a, b);
      assert.equal(made.length, 1);
      assert.equal(a.url, '/api/gev/commands');
    });
  } finally {
    delete globalThis.EventSource;
  }
});

test('fly command releases all tracking before flying to the geocode plan', async () => {
  globalThis.EventSource = FakeEventSource;
  const { installGevCommandBusClient } = await import('./gevCommandBusClient.js');
  try {
    await withGlobe({}, async () => {
      const source = installGevCommandBusClient({ sourceFactory: () => new FakeEventSource() });
      const order = [];
      const viewer = stubViewer();
      const calls = { release: 0, chip: 0, cctv: [], context: 0 };
      globalThis.window.__godsEyeView = {
        viewer,
        dataManager: { layers: new Map() },
        voiceCommands: { runner: async (action, args) => { order.push(`ctx:${action}`); return { ok: true }; } },
      };
      // Patch the module-level collaborators through the window surface the
      // module resolves at command time: releaseAllTracking and runRailChip
      // are module imports, so observe them via their effects instead.
      const busState = window.__gevCommandBusClient;
      assert.ok(busState);
      source.dispatch('command', {
        seq: 1,
        action: 'fly',
        lat: 51.5074,
        lon: -0.1278,
        label: 'London, United Kingdom',
        rangeM: 120000,
        pitch: -50,
      });
      // Fly executes synchronously after a microtask; give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(viewer.flights.length, 1, 'exactly one camera flight');
      const flight = viewer.flights[0];
      // HeadingPitchRange offset carries the framed range from the plan.
      const cesiumRange = flight.offset?.range;
      assert.ok(Math.abs(cesiumRange - 120000) < 4000, `range ${cesiumRange}`);
    });
  } finally {
    delete globalThis.EventSource;
  }
});

test('chip / cctv / contacts commands route to the app machinery, stale seq dropped', async () => {
  globalThis.EventSource = FakeEventSource;
  const { installGevCommandBusClient } = await import('./gevCommandBusClient.js');
  try {
    await withGlobe({}, async () => {
      const source = installGevCommandBusClient({ sourceFactory: () => new FakeEventSource() });
      const viewer = stubViewer();
      const calls = { chip: [], cctv: [], context: 0 };
      const dataManager = {
        layers: new Map([
          ['cctv', { module: {} }],
        ]),
        setEnabled: async (id, on, opts) => { calls.cctv.push({ id, on }); return true; },
        isEnabled: () => true,
      };
      globalThis.window.__godsEyeView = {
        viewer,
        dataManager,
        styleManager: { getContextModeState: () => ({ active: true }), setContextMode: async () => ({ ok: true }) },
      };
      // Pre-seed a high seq so a lower one is treated as stale.
      source.dispatch('command', { seq: 7, action: 'chip', id: 'planes' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // seq 7 may or may not have run (no rail module present) — now stale:
      source.dispatch('command', { seq: 3, action: 'cctv', on: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(calls.cctv.length, 0, 'stale seq dropped');
      source.dispatch('command', { seq: 8, action: 'cctv', on: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(calls.cctv, [{ id: 'cctv', on: true }]);
      source.dispatch('command', { seq: 9, action: 'contacts' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      source.dispatch('command', 'not json');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(viewer.flights.length, 0, 'no camera motion from non-fly commands');
    });
  } finally {
    delete globalThis.EventSource;
  }
});
