// TYPED COMMAND BOX — pin the vocabulary and the honesty contract.
//
// The owner's brief (2026-09-09): type ships / fly to london / cctv on next to
// the rail and the globe moves without MIC. Unknown phrases must produce one
// honest status line and NO motion — never a guessed fly. Empty input does
// nothing at all. These tests pin the pure halves (parse + outcome) with stub
// dependencies; DOM install is exercised in the browser. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommandBoxInput,
  commandBoxOutcome,
  COMMAND_BOX_INPUT_ID,
} from './commandBox.js';

test('empty and whitespace input do nothing (null, no command)', () => {
  assert.equal(parseCommandBoxInput(''), null);
  assert.equal(parseCommandBoxInput('   '), null);
  assert.equal(parseCommandBoxInput('\t\n  '), null);
});

test('chip vocabulary: bare and show/open forms', () => {
  assert.deepEqual(parseCommandBoxInput('ships'), { kind: 'chip', id: 'ships' });
  assert.deepEqual(parseCommandBoxInput('Planes'), { kind: 'chip', id: 'planes' });
  assert.deepEqual(parseCommandBoxInput('  SHOW EVENTS '), { kind: 'chip', id: 'events' });
  assert.deepEqual(parseCommandBoxInput('open ships'), { kind: 'chip', id: 'ships' });
  assert.deepEqual(parseCommandBoxInput('news'), { kind: 'chip', id: 'news' });
  assert.deepEqual(parseCommandBoxInput('Show NEWS'), { kind: 'chip', id: 'news' });
});

test('fly vocabulary: fly/go to <place>, punctuation tolerated', () => {
  assert.deepEqual(parseCommandBoxInput('fly to london'), { kind: 'fly', query: 'london' });
  assert.deepEqual(parseCommandBoxInput('GO TO New York'), { kind: 'fly', query: 'New York' });
  assert.deepEqual(parseCommandBoxInput('fly to tokyo.'), { kind: 'fly', query: 'tokyo' });
  assert.deepEqual(parseCommandBoxInput('fly to  '), { kind: 'unknown', text: 'fly to' });
});

test('cctv on/off and contacts exit', () => {
  assert.deepEqual(parseCommandBoxInput('cctv on'), { kind: 'cctv', on: true });
  assert.deepEqual(parseCommandBoxInput('CCTV OFF'), { kind: 'cctv', on: false });
  assert.deepEqual(parseCommandBoxInput('contacts'), { kind: 'contacts' });
});

test('unknown phrases are flagged, not guessed', () => {
  const out = parseCommandBoxInput('find me a sandwich');
  assert.equal(out.kind, 'unknown');
  assert.equal(out.text, 'find me a sandwich');
  assert.equal(parseCommandBoxInput('ships and planes').kind, 'unknown');
  assert.equal(parseCommandBoxInput('fly london').kind, 'unknown');
  assert.equal(parseCommandBoxInput('cctv').kind, 'unknown');
});

test('fly outcome: success reports the geocode label', async () => {
  const outcome = await commandBoxOutcome(
    { kind: 'fly', query: 'london' },
    { fly: async () => ({ label: 'London, UK', navigationMode: 'city-overview', rangeM: null }) },
  );
  assert.deepEqual(outcome, { message: 'Flying to London, UK…', tone: 'ok' });
});

test('fly outcome: null geocode means honest empty, camera untouched', async () => {
  let flew = false;
  const outcome = await commandBoxOutcome(
    { kind: 'fly', query: 'zzzznotaplace' },
    { fly: async () => { flew = true; return null; } },
  );
  assert.ok(flew, 'dependency must be consulted even for a miss');
  assert.equal(outcome.tone, 'empty');
  assert.match(outcome.message, /no place matched/i);
});

test('fly outcome: missing Google key reports honestly, no fake flight', async () => {
  const outcome = await commandBoxOutcome(
    { kind: 'fly', query: 'london' },
    { fly: async () => { throw new Error('No Google Maps API key available for geocoding'); } },
  );
  assert.equal(outcome.tone, 'warn');
  assert.match(outcome.message, /no google maps api key/i);
});

test('fly outcome: cancelled search leaves camera untouched', async () => {
  const outcome = await commandBoxOutcome(
    { kind: 'fly', query: 'london' },
    { fly: async () => ({ cancelled: true }) },
  );
  assert.equal(outcome.tone, 'warn');
  assert.match(outcome.message, /cancelled/i);
});

test('cctv outcome: on/off and failure tones', async () => {
  assert.deepEqual(
    await commandBoxOutcome({ kind: 'cctv', on: true }, { cctv: async () => ({ ok: true, enabled: true }) }),
    { message: 'CCTV on.', tone: 'ok' },
  );
  assert.deepEqual(
    await commandBoxOutcome({ kind: 'cctv', on: false }, { cctv: async () => ({ ok: true, enabled: false }) }),
    { message: 'CCTV off.', tone: 'ok' },
  );
  const failed = await commandBoxOutcome(
    { kind: 'cctv', on: true },
    { cctv: async () => ({ ok: false, error: 'CCTV layer unavailable' }) },
  );
  assert.equal(failed.tone, 'warn');
  assert.match(failed.message, /cctv layer unavailable/i);
});

test('contacts outcome: exit reports context off, or honestly when none active', async () => {
  assert.deepEqual(
    await commandBoxOutcome({ kind: 'contacts' }, { context: async () => ({ ok: true, wasActive: true }) }),
    { message: 'CONTEXT OFF — back to contacts view.', tone: 'ok' },
  );
  assert.deepEqual(
    await commandBoxOutcome({ kind: 'contacts' }, { context: async () => ({ ok: true, wasActive: false }) }),
    { message: 'No context mode was active.', tone: 'ok' },
  );
  const failed = await commandBoxOutcome(
    { kind: 'contacts' },
    { context: async () => ({ ok: false, error: 'Context mode control unavailable' }) },
  );
  assert.equal(failed.tone, 'warn');
});

test('chip and unknown commands produce no box outcome (rail banner owns those)', async () => {
  assert.equal(await commandBoxOutcome({ kind: 'chip', id: 'ships' }, {}), null);
  assert.equal(await commandBoxOutcome({ kind: 'unknown', text: 'x' }, {}), null);
});

test('input id is stable for wiring and CSS', () => {
  assert.equal(COMMAND_BOX_INPUT_ID, 'command-box');
});
