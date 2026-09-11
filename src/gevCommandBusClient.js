/**
 * Command-bus client — the OPEN tab's ear for Hermes MCP.
 *
 * One EventSource to /api/gev/commands, installed at boot, idempotent. Every
 * `command` event is executed by the app's own machinery — rail runners
 * (commandRail.js), controlCctv (voice/gevActions.js), the context-mode exit,
 * and flyToLandmark (locations.js) after releaseAllTracking so a fly command
 * can never be hijacked by a lingering follow camera. No Google, no OpenAI:
 * the server geocodes via Nominatim and hands the tab a ready flight plan.
 *
 * Failures stay quiet on purpose — the SSE stream is a local control plane,
 * not a feature surface. A dropped stream reconnects (EventSource retry);
 * a dev server without the middleware simply never answers.
 */
import { flyToLandmark } from './locations.js';
import { controlCctv, releaseAllTracking } from './voice/gevActions.js';
import { runRailChip } from './commandRail.js';

const INSTALL_FLAG = '__gevCommandBusClient';

/** Live app handles, resolved at command time. */
function gev() {
  return window.__godsEyeView || {};
}

/** Exit Space Missions / Contacts — the command box's context-off twin. */
async function exitContextMode() {
  const styleManager = gev().styleManager;
  let wasActive = true;
  try {
    wasActive = Boolean(styleManager?.getContextModeState?.()?.active);
  } catch { /* assume active — the exit below still reports honestly */ }
  const runner = gev().voiceCommands?.runner;
  if (typeof runner === 'function') {
    const result = await runner('set_context_mode', { mode: 'off' });
    return { ok: result?.ok !== false, wasActive, error: result?.error || null };
  }
  if (styleManager && typeof styleManager.setContextMode === 'function') {
    const result = await styleManager.setContextMode(null);
    return { ok: result?.ok !== false, wasActive, error: result?.error || null };
  }
  return { ok: false, wasActive, error: 'Context mode control unavailable' };
}

/** Execute one command object from the stream. Never throws. */
async function executeBusCommand(command) {
  const viewer = gev().viewer;
  const dataManager = gev().dataManager;
  if (!viewer || !dataManager) return;

  if (command.action === 'fly') {
    const lat = Number(command.lat);
    const lon = Number(command.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    // A tracked entity owns the camera — drop every hold before flying, or
    // the fly command is silently hijacked by the follow camera.
    try {
      releaseAllTracking(viewer, dataManager);
    } catch { /* flight proceeds regardless */ }
    const rangeM = Number(command.rangeM);
    const pitch = Number(command.pitch);
    flyToLandmark(viewer, lat, lon, {
      range: Number.isFinite(rangeM) && rangeM > 0 ? rangeM : 25_000,
      pitch: Number.isFinite(pitch) && pitch >= -90 && pitch <= 0 ? pitch : -50,
      duration: 3.0,
    });
    return;
  }

  if (command.action === 'chip') {
    try {
      await runRailChip({ chipId: command.id, dataManager });
    } catch (err) {
      console.warn('[CommandBus] chip failed:', err?.message || err);
    }
    return;
  }

  if (command.action === 'cctv') {
    try {
      const result = await controlCctv(
        dataManager,
        { action: command.on ? 'enable' : 'disable' },
        gev().styleManager || null,
      );
      if (!result || result.ok === false) {
        console.warn('[CommandBus] cctv:', result?.error || 'unavailable');
      }
    } catch (err) {
      console.warn('[CommandBus] cctv failed:', err?.message || err);
    }
    return;
  }

  if (command.action === 'contacts') {
    try {
      await exitContextMode();
    } catch (err) {
      console.warn('[CommandBus] contacts failed:', err?.message || err);
    }
  }
}

/**
 * Install the command-bus listener. Idempotent; safe to call before the app
 * finishes booting (commands resolve their own handles at execution time).
 *
 * @param {{sourceFactory?: () => EventSource}} options Test seam.
 * @returns {EventSource|null} The live source, or null when EventSource is
 *   unavailable (old browser / non-HTTP context).
 */
export function installGevCommandBusClient(options = {}) {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return null;
  if (window[INSTALL_FLAG]) return window[INSTALL_FLAG].source instanceof EventSource
    ? window[INSTALL_FLAG].source
    : null;
  const state = { source: null, lastSeq: 0 };
  window[INSTALL_FLAG] = state;

  const makeSource = typeof options.sourceFactory === 'function'
    ? options.sourceFactory
    : () => new EventSource('/api/gev/commands');
  const source = makeSource();
  state.source = source;

  source.addEventListener('command', (event) => {
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }
    // Sequence guard: a reconnect replays nothing (Last-Event-ID is not sent
    // by this server), but a stale duplicate would re-run a flight.
    const seq = Number(command?.seq);
    if (Number.isFinite(seq) && seq <= state.lastSeq) return;
    if (Number.isFinite(seq)) state.lastSeq = seq;
    void executeBusCommand(command);
  });
  // Keep the stream honest: an error/close with no auto-retry left running
  // would silently deafen the tab. EventSource retries by default; nothing
  // else to do on error.
  return source;
}

export default installGevCommandBusClient;
