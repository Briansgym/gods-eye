// Pins for the Conflicts layer's pure halves — CSV mapping (conflictsCsv.js)
// and presentation/selection policy (conflictsModel.js) — plus registry
// membership. The Cesium-facing layer module is exercised through these same
// pure decisions; nothing here touches network or DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { mapConflictRow, parseConflictCsv, parseCsv } from './conflictsCsv.js';
import {
  CONFLICTS_OVERLAY_COHORT_LIMIT,
  conflictDiveBanner,
  conflictEntityId,
  conflictEntityIdFromOverlayEntryId,
  conflictPixelSize,
  conflictRangeM,
  conflictTypeLabel,
  createConflictOverlayEntry,
  resolveConflictDive,
  selectConflictOverlayCohort,
} from './conflictsModel.js';
import { REGISTERED_LAYER_IDS } from './layerState.js';
import { createConflictsLayer } from './conflicts.js';

const HEADER_ROW = 'id,relid,year,type_of_violence,conflict_name,dyad_name,side_a,side_b,'
  + 'where_coordinates,adm_1,country,region,latitude,longitude,date_start,date_end,'
  + 'deaths_civilians,best,high,low';

function headerIndex() {
  const cols = HEADER_ROW.split(',');
  return new Map(cols.map((name, i) => [name, i]));
}

test('parseConflictCsv keeps quoted commas, drops ungeolocatable rows, dedupes, sorts newest-first', () => {
  const csv = [
    HEADER_ROW,
    // Newest, with a comma inside quoted where_coordinates.
    '2,PAK-2026-1-857-71,2026,1,"Pakistan: Government",Government of Pakistan - TTP,Government of Pakistan,TTP,"Hirat town, Herat",Herat,Pakistan,Asia,34.349991,62.200001,2026-06-04 00:00:00.000,2026-06-04 00:00:00.000,0,2,2,2',
    // Older.
    '1,AFG-2026-1-1-XXX700-5,2026,1,XXX700,XXX700 - XXX700,XXX700,XXX700,Sayghan district,Bamyan,Afghanistan,Asia,35.119273,67.611333,2026-05-05 00:00:00.000,2026-05-05 00:00:00.000,0,1,1,1',
    // Ungeolocatable (latitude not a number) — must be dropped, never faked.
    '3,BAD-ROW,2026,2,x,y,z,w,where,c,r,not-a-lat,10,2026-06-30 00:00:00.000,,0,50,50,50',
    // Duplicate of id 2 — must collapse to one record.
    '2,PAK-2026-1-857-71,2026,1,dup,dup,dup,dup,dup,dup,dup,dup,34.349991,62.200001,2026-06-04 00:00:00.000,,0,2,2,2',
  ].join('\n');

  const records = parseConflictCsv(csv);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 2, 'most recent date_start leads');
  assert.equal(records[0].where, 'Hirat town, Herat', 'quoted comma survives');
  assert.equal(records[1].id, 1);
  assert.equal(records.some((r) => r.id === 3), false, 'row without valid coords is dropped');
});

test('mapConflictRow maps unknown numbers to null, never NaN', () => {
  const index = headerIndex();
  const row = '5,REL,2026,,c,d,a,b,w,adm,co,reg,10.5,20.5,2026-01-02 00:00:00.000,,0,,,,,,,,,'
    .split(',');
  const record = mapConflictRow(row, index);
  assert.ok(record);
  assert.equal(record.type, null, 'type outside 1..3 is null');
  assert.equal(record.best, null, 'empty fatality estimate is null');
  assert.equal(record.deathsCivilians, 0, 'explicit zero is preserved, not nulled');
  assert.equal(record.lat, 10.5);
  assert.equal(record.lon, 20.5);
});

test('mapConflictRow rejects coordinates outside the globe', () => {
  const index = headerIndex();
  const base = '9,REL,2026,1,c,d,a,b,w,adm,co,reg,{lat},{lon},2026-01-02 00:00:00.000,,0,1,1,1';
  for (const [lat, lon] of [[91, 0], [0, 181], ['-91', '0']]) {
    const record = mapConflictRow(base.replace('{lat}', lat).replace('{lon}', lon).split(','), index);
    assert.equal(record, null, `${lat},${lon} must be rejected`);
  }
});

test('parseCsv handles escaped quotes and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x""y",z\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x"y', 'z']]);
});

test('cohort selection ranks by fatalities with stable id tiebreak and caps', () => {
  const entries = [
    createConflictOverlayEntry({ id: '10', position: {}, best: 3, accent: '#fff' }),
    createConflictOverlayEntry({ id: '2', position: {}, best: 30, accent: '#fff' }),
    createConflictOverlayEntry({ id: '7', position: {}, best: 30, accent: '#fff' }),
    createConflictOverlayEntry({ id: '9', position: {}, best: 0, accent: '#fff' }),
  ];
  const cohort = selectConflictOverlayCohort(entries, 3);
  assert.deepEqual(cohort.map((e) => e.id), ['2', '7', '10']);
  assert.equal(selectConflictOverlayCohort(entries, 0).length, 0);
  assert.equal(selectConflictOverlayCohort(null).length, 0);
  assert.ok(CONFLICTS_OVERLAY_COHORT_LIMIT > 0);
});

test('marker size scales with fatalities inside a 7..13 band and selection wins', () => {
  assert.equal(conflictPixelSize(null), 7);
  assert.equal(conflictPixelSize(0), 7);
  assert.equal(conflictPixelSize(25) >= 7 && conflictPixelSize(25) <= 13, true);
  assert.equal(conflictPixelSize(5000), 13);
  assert.equal(conflictPixelSize(0, true), 13);
});

test('overlay entries are interactive so label clicks enter the hit rects', () => {
  const entry = createConflictOverlayEntry({ id: '628272', position: {}, best: 5, accent: '#ffee58' });
  assert.equal(entry.interactive, true);
});

test('overlay entry ids map back to conflict entity ids', () => {
  assert.equal(conflictEntityIdFromOverlayEntryId('628272'), 'conflict:628272');
  assert.equal(conflictEntityIdFromOverlayEntryId('conflict:628272'), 'conflict:628272');
  assert.equal(conflictEntityIdFromOverlayEntryId(null), null);
  assert.equal(conflictEntityIdFromOverlayEntryId(''), null);
});

test('entity ids and type labels are stable vocabulary', () => {
  assert.equal(conflictEntityId(628272), 'conflict:628272');
  assert.equal(conflictTypeLabel(1), 'STATE-BASED');
  assert.equal(conflictTypeLabel(2), 'NON-STATE');
  assert.equal(conflictTypeLabel(3), 'ONE-SIDED');
  assert.equal(conflictTypeLabel(null), 'ARMED CONFLICT');
});

test('the layer object exposes selectEvent, same seam as news (voice/dive call it)', () => {
  const layer = createConflictsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {}, hitTest: () => null },
  });
  assert.equal(typeof layer.selectEvent, 'function');
  // Unknown / unloaded ids report an honest false, never a throw.
  assert.equal(layer.selectEvent('conflict:never-loaded'), false);
});

// SELECTION MUST NOT REBUILD OVERLAY ENTRIES (live-reproduced 2026-09-12):
// Cesium fires LEFT_CLICK then LEFT_DOUBLE_CLICK. The click's selectEvent used
// to renderRecords() → overlayHost.setEntries() → the world overlay wiped its
// painted hit rects — so the double-click of the SAME gesture hit-tested empty
// rects and the dive died. Selection restyles the point in place instead.
test('selectEvent restyles the point in place and never rebuilds overlay entries', async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  // contextStore hangs its store + selection events off window; the click
  // handler install path wants a document for Cesium's event plumbing.
  globalThis.window = { dispatchEvent() {} };
  globalThis.document = originalDocument || { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      total: 2,
      events: [
        {
          id: 628272, type: 3, conflict: 'Sahel insurgency', dyad: 'd', sideA: 'a', sideB: 'b',
          where: 'w', country: 'Mali', region: 'Africa', lat: 14.5, lon: -1.5,
          dateStart: '2026-06-04 00:00:00.000', dateEnd: '2026-06-04 00:00:00.000',
          deathsCivilians: 0, best: 12, high: 12, low: 12,
        },
        {
          id: 999001, type: 1, conflict: 'Second front', dyad: 'd2', sideA: 'a', sideB: 'b',
          where: 'w2', country: 'Afghanistan', region: 'Asia', lat: 35.1, lon: 67.6,
          dateStart: '2026-05-05 00:00:00.000', dateEnd: '2026-05-05 00:00:00.000',
          deathsCivilians: 0, best: 2, high: 2, low: 2,
        },
      ],
    }),
  });
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });

  let setEntriesCalls = 0;
  const layer = createConflictsLayer({
    overlayHost: {
      setEntries() { setEntriesCalls += 1; },
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
  });
  let dataSource = null;
  const viewer = {
    dataSources: { add(ds) { dataSource = ds; }, remove() {} },
    scene: {
      canvas: {
        addEventListener() {},
        removeEventListener() {},
        disableRootEvents: true,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      },
    },
  };
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  assert.equal(setEntriesCalls, 1, 'the data load paints the overlay exactly once');
  assert.equal(layer.getSelectedId(), null);

  // First click of the double-click gesture: label hit → selectEvent.
  assert.equal(layer.selectEvent('conflict:628272'), true);
  assert.equal(layer.getSelectedId(), 'conflict:628272');
  assert.equal(setEntriesCalls, 1, 'selection must not call overlayHost.setEntries (wipes hit rects)');
  const time = Cesium.JulianDate.now();
  const selectedPoint = dataSource.entities.getById('conflict:628272').point;
  assert.equal(selectedPoint.pixelSize.getValue(time), conflictPixelSize(12, true));
  assert.ok(Cesium.Color.WHITE.equals(selectedPoint.color.getValue(time)));

  // Second overlay hitTest-shaped click of the same gesture: same seam.
  assert.equal(layer.selectEvent('conflict:628272'), true);
  assert.equal(setEntriesCalls, 1, 'call count unchanged from the initial render');

  // Moving the selection restyles both points in place — still no rebuild.
  assert.equal(layer.selectEvent('conflict:999001'), true);
  assert.equal(layer.getSelectedId(), 'conflict:999001');
  assert.equal(setEntriesCalls, 1);
  assert.equal(selectedPoint.pixelSize.getValue(time), conflictPixelSize(12, false));
  assert.ok(!Cesium.Color.WHITE.equals(selectedPoint.color.getValue(time)));
});

test('the conflicts layer is registered in the sealed layer-state registry', () => {
  assert.ok(REGISTERED_LAYER_IDS.includes('conflicts'));
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, REGISTERED_LAYER_IDS.length);
});

test('dive framing widens with fatalities inside a bounded band', () => {
  const min = conflictRangeM(null);
  assert.ok(min >= 15000 && min <= 90000, `floor in band (${min})`);
  assert.ok(conflictRangeM(0) <= conflictRangeM(25), 'more deaths never narrows');
  assert.ok(conflictRangeM(25) <= conflictRangeM(100), 'monotone up to the cap');
  assert.equal(conflictRangeM(100), conflictRangeM(5000), 'ceiling caps');
});

test('dive banner names the conflict, its type, toll, place, and source', () => {
  const banner = conflictDiveBanner({
    conflict: 'Myanmar: Military vs. Arakan Army',
    type: 1,
    deathsBest: 34,
    country: 'Myanmar',
    dateStart: '2026-06-04T00:00:00.000',
  });
  assert.equal(
    banner,
    'Myanmar: Military vs. Arakan Army — STATE-BASED · 34 fatalities · Myanmar · 2026-06-04 · UCDP GED',
  );
  // Analyst records expose deathsBest; raw layer records expose best — both work.
  assert.equal(
    conflictDiveBanner({ type: 3, best: null, country: 'Sudan' }),
    'ARMED CONFLICT — ONE-SIDED · fatalities unknown · Sudan · UCDP GED',
  );
  // An explicit zero is a real count, same vocabulary as the layer's label model.
  assert.equal(
    conflictDiveBanner({ type: 3, best: 0, country: 'Sudan' }),
    'ARMED CONFLICT — ONE-SIDED · 0 fatalities · Sudan · UCDP GED',
  );
  const bare = conflictDiveBanner({ type: null, deathsBest: null });
  assert.match(bare, /^ARMED CONFLICT — ARMED CONFLICT · fatalities unknown · UCDP GED$/);
});

test('resolveConflictDive matches "conflict:<id>" picks against analyst records', () => {
  const records = [
    { id: '628272', type: 1, conflict: 'Sahel insurgency', lat: 14.5, lon: -1.5 },
    { id: 'nogeoloc', type: 2, conflict: 'Unmapped', lat: null, lon: 3 },
  ];
  assert.equal(resolveConflictDive(records, 'conflict:628272')?.conflict, 'Sahel insurgency');
  // Ungeolocatable match must not dive (empty stays empty — never fake coords).
  assert.equal(resolveConflictDive(records, 'conflict:nogeoloc'), null);
  // Wrong vocabulary / missing inputs.
  assert.equal(resolveConflictDive(records, 'earthquake:us7000abcd'), null);
  assert.equal(resolveConflictDive(records, 'conflict:missing'), null);
  assert.equal(resolveConflictDive(null, 'conflict:628272'), null);
  assert.equal(resolveConflictDive(records, null), null);
});
