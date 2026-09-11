/**
 * Typed command box — one line + Enter, living with the SHIPS · PLANES · EVENTS
 * rail (lower-right).
 *
 * Owner brief (Brian Spencer, 2026-09-09): drive the globe without GEV MIC /
 * OpenAI Realtime. The box parses a handful of local phrases and routes them
 * to machinery that already exists — rail chips (commandRail.js), the geocode
 * fly path (locations.js searchAndFlyTo), CCTV enable/disable
 * (gevActions.js controlCctv), and the context-mode exit. It never invents
 * motion: an unrecognized phrase gets one honest status line and the camera
 * stays put. Empty input does nothing. `sendTextCommand` stays untouched
 * until MIC works.
 */
import { searchAndFlyTo } from './locations.js';
import { controlCctv } from './voice/gevActions.js';

const COMMAND_BOX_ID = 'command-box';
const COMMAND_PLACEHOLDER = 'fly to london · ships · planes · news · cctv on';
const UNKNOWN_HINT = 'try: ships · planes · events · news · fly to <place> · cctv on/off · contacts';

/**
 * Parse one line of typed input into a command the app can already run.
 * Pure — no DOM, no app state — so the vocabulary is pin-testable.
 *
 * @param {string} raw Exactly what was in the box.
 * @returns {null|{kind:'chip',id:string}|{kind:'fly',query:string}|
 *   {kind:'cctv',on:boolean}|{kind:'contacts'}|{kind:'unknown',text:string}}
 *   null means empty/whitespace: the box must do nothing at all.
 */
export function parseCommandBoxInput(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  let match = text.match(/^(?:show|open)\s+(ships|planes|events|news)$/i);
  if (match) return { kind: 'chip', id: match[1].toLowerCase() };
  if (lower === 'ships' || lower === 'planes' || lower === 'events' || lower === 'news') {
    return { kind: 'chip', id: lower };
  }

  match = text.match(/^(?:fly|go)\s+to\s+(.+)$/i);
  if (match) {
    const query = match[1].replace(/[.!?]+$/, '').trim();
    return query
      ? { kind: 'fly', query }
      : { kind: 'unknown', text };
  }

  match = text.match(/^cctv\s+(on|off)$/i);
  if (match) return { kind: 'cctv', on: match[1].toLowerCase() === 'on' };

  if (lower === 'contacts' || lower === 'contact') return { kind: 'contacts' };

  return { kind: 'unknown', text };
}

/**
 * Run a parsed non-chip command against injected dependencies and produce the
 * one honest status line for it. Chips are excluded: the rail's own runners
 * already banner their outcome (dive target or honest empty), and duplicating
 * that here would overwrite their message.
 *
 * @param {object} parsed A parse result other than chip/unknown.
 * @param {{fly?: Function, cctv?: Function, context?: Function}} deps
 * @returns {Promise<{message:string, tone:'ok'|'warn'|'empty'}|null>}
 */
export async function commandBoxOutcome(parsed, deps = {}) {
  if (!parsed || parsed.kind === 'chip' || parsed.kind === 'unknown') return null;

  if (parsed.kind === 'fly') {
    try {
      const result = await deps.fly(parsed.query);
      if (result && result.cancelled) {
        return { message: 'Flight cancelled — camera untouched.', tone: 'warn' };
      }
      if (!result) {
        return { message: `No place matched "${parsed.query}" — nothing moved.`, tone: 'empty' };
      }
      return { message: `Flying to ${result.label || parsed.query}…`, tone: 'ok' };
    } catch (err) {
      return { message: `No flight — ${err?.message || 'geocoding failed'}.`, tone: 'warn' };
    }
  }

  if (parsed.kind === 'cctv') {
    try {
      const result = await deps.cctv(parsed.on);
      if (!result || result.ok === false) {
        return { message: `CCTV ${parsed.on ? 'on' : 'off'} failed — ${result?.error || 'layer unavailable'}.`, tone: 'warn' };
      }
      return { message: result.enabled === false ? 'CCTV off.' : 'CCTV on.', tone: 'ok' };
    } catch (err) {
      return { message: `CCTV failed — ${err?.message || err}.`, tone: 'warn' };
    }
  }

  if (parsed.kind === 'contacts') {
    try {
      const result = await deps.context();
      if (!result || result.ok === false) {
        return { message: `Context: ${result?.error || 'unavailable'}.`, tone: 'warn' };
      }
      return {
        message: result.wasActive === false
          ? 'No context mode was active.'
          : 'CONTEXT OFF — back to contacts view.',
        tone: 'ok',
      };
    } catch (err) {
      return { message: `Context: ${err?.message || err}.`, tone: 'warn' };
    }
  }

  return null;
}

/** Dependencies resolved live from the booted app at submit time. */
function liveDeps() {
  const gev = () => window.__godsEyeView || {};
  return {
    fly: (query) => searchAndFlyTo(gev().viewer, query),
    cctv: (on) => controlCctv(
      gev().dataManager,
      { action: on ? 'enable' : 'disable' },
      gev().styleManager || null,
    ),
    context: async () => {
      const styleManager = gev().styleManager;
      let wasActive = true;
      try {
        wasActive = Boolean(styleManager?.getContextModeState?.()?.active);
      } catch { /* assume active — the exit below still reports honestly */ }
      const runner = gev().voiceCommands?.runner;
      let result = null;
      if (typeof runner === 'function') {
        result = await runner('set_context_mode', { mode: 'off' });
      } else if (styleManager && typeof styleManager.setContextMode === 'function') {
        result = await styleManager.setContextMode(null);
      } else {
        return { ok: false, error: 'Context mode control unavailable' };
      }
      return { ok: result?.ok !== false, wasActive, error: result?.error || null };
    },
  };
}

/**
 * Handle one submit of the box. Empty input returns immediately (brief: empty
 * does nothing). Chip commands run through the rail's own runners, whose
 * banners are the source of truth for what happened.
 */
async function handleSubmit({ input, banner, runChip }) {
  const parsed = parseCommandBoxInput(input.value);
  input.value = '';
  const show = (message, tone) => banner?.(message, tone);

  if (parsed === null) return;
  if (parsed.kind === 'unknown') {
    show(`Unrecognized: "${parsed.text}" — ${UNKNOWN_HINT}`, 'warn');
    return;
  }
  if (parsed.kind === 'chip') {
    try {
      const ran = await runChip(parsed.id);
      if (ran === false) show('Command rail unavailable.', 'warn');
    } catch {
      show('Command failed — see console.', 'warn');
    }
    return;
  }

  input.dataset.busy = 'true';
  try {
    const outcome = await commandBoxOutcome(parsed, liveDeps());
    if (outcome?.message) show(outcome.message, outcome.tone);
  } catch (err) {
    show(`Command failed: ${err?.message || err}`, 'warn');
  } finally {
    delete input.dataset.busy;
  }
}

/**
 * Build the command box inside the rail. Idempotent. The rail owns placement
 * (top of the lower-right stack, above the chips); this module owns behavior.
 *
 * @param {object} options
 * @param {HTMLElement} options.rail The #command-rail nav element.
 * @param {Function} options.banner (text, tone) => void — rail status banner.
 * @param {Function} options.runChip (chipId) => Promise<boolean|void> rail runner.
 */
export function installCommandBox({ rail, banner, runChip }) {
  if (document.getElementById(COMMAND_BOX_ID)) return;
  const form = document.createElement('form');
  form.id = 'command-box-form';
  form.noValidate = true;
  const input = document.createElement('input');
  input.id = COMMAND_BOX_ID;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = COMMAND_PLACEHOLDER;
  input.setAttribute('aria-label', 'Command box — type a command and press Enter');
  input.title = 'Type a command and press Enter';
  form.appendChild(input);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit({ input, banner, runChip });
  });
  rail.prepend(form);
}

export const COMMAND_BOX_INPUT_ID = COMMAND_BOX_ID;

export default installCommandBox;
