// src/spendHud.js
/**
 * Always-on bottom-left session spend HUD — VOICE + MAPS.
 *
 * A compact two-line cluster:
 *
 *     VOICE ~$0.00
 *     MAPS  ~$0.00
 *
 * Independent of the military intel HUD (`#intel-hud` only exists in
 * NVG/FLIR/CRT modes) — this element is its own fixed `#gev-spend-hud`
 * surface, visible in every mode, mic on or off, Maps key or not.
 * Positioned ABOVE `#cesium-credits`: the Google attribution line is a ToS
 * requirement and must never be covered.
 *
 * Both numbers are SESSION ESTIMATES, not billing truth:
 *   - VOICE mirrors the one existing voice cost tracker (gevRealtime's
 *     `syncCostUi` rebroadcasts its state as `gev:voice-cost-update`);
 *     no second estimate is ever computed.
 *   - MAPS comes from the fetch/XHR spend monitor's `gev:maps-cost-update`.
 *
 * @module spendHud
 */

import { MAPS_COST_EVENT, getMapsSpendTracker } from './maps/mapsSpendMonitor.js';

/** Window event gevRealtime dispatches with each voice cost state. */
export const VOICE_COST_EVENT = 'gev:voice-cost-update';

const ESTIMATE_NOTE = 'Session estimate, not Cloud Billing / OpenAI invoice';

/**
 * Build the spend HUD and subscribe it to both cost streams. Idempotent.
 * @returns {{el: HTMLElement}|null} handle, or null when the DOM is absent.
 */
export function initSpendHud() {
  const existing = document.getElementById('gev-spend-hud');
  if (existing) return { el: existing };
  if (!document.body) return null;

  const el = document.createElement('div');
  el.id = 'gev-spend-hud';
  el.setAttribute('aria-label', 'Session API spend estimate');
  el.innerHTML = `
    <div class="gev-spend-row" title="OpenAI Realtime voice. ${ESTIMATE_NOTE}">
      <span class="gev-spend-label">VOICE</span>
      <span id="gev-spend-voice" class="gev-spend-value" data-level="ok">~$0.00</span>
    </div>
    <div class="gev-spend-row" title="Google Maps Platform (3D tiles, geocoding, places). ${ESTIMATE_NOTE}">
      <span class="gev-spend-label">MAPS</span>
      <span id="gev-spend-maps" class="gev-spend-value" data-level="ok">~$0.00</span>
    </div>
  `;
  document.body.appendChild(el);

  const voiceValue = el.querySelector('#gev-spend-voice');
  const mapsValue = el.querySelector('#gev-spend-maps');

  // Voice levels are ok|warn|cap (cap = the $5 session kill in voiceCost);
  // Maps levels are ok|warn only — no hard kill for Maps, ever.
  const paint = (target, state) => {
    if (!target || !state) return;
    target.textContent = state.display ?? '~$0.00';
    target.dataset.level = state.level ?? 'ok';
  };

  window.addEventListener(VOICE_COST_EVENT, (event) => paint(voiceValue, event.detail));
  window.addEventListener(MAPS_COST_EVENT, (event) => paint(mapsValue, event.detail));

  // Initial Maps paint: the monitor installs before this HUD, so tiles
  // requested during boot are already on the meter.
  paint(mapsValue, getMapsSpendTracker()?.state());

  return { el };
}
