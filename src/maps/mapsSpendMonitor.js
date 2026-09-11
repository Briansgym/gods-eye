// src/maps/mapsSpendMonitor.js
/**
 * Session-wide Google Maps spend monitor — instrument, don't intercept.
 *
 * Installs ONE wrapper around `window.fetch` and ONE around
 * `XMLHttpRequest.prototype.open` (Cesium 1.138 loads 3D tiles over XHR, so
 * fetch alone misses the dominant cost), records every Maps-platform URL into
 * a shared `mapsCost` tracker, and rebroadcasts throttled state as a
 * `gev:maps-cost-update` window CustomEvent for the spend HUD.
 *
 * Guarantees:
 *   - Requests are never blocked, delayed, or altered — the wrappers call the
 *     originals with untouched arguments, and any accounting error is
 *     swallowed. Killing the globe over an estimate is explicitly forbidden.
 *   - No key material is read, stored, or logged. URLs are classified by
 *     host/path only (see `classifyMapsUrl`), never persisted.
 *   - Idempotent: repeated install calls return the same tracker and never
 *     double-wrap.
 *
 * @module maps/mapsSpendMonitor
 */

import { createMapsCostTracker } from './mapsCost.js';

/** Window event fired (throttled) whenever the Maps estimate changes. */
export const MAPS_COST_EVENT = 'gev:maps-cost-update';

/**
 * Trailing-edge throttle for HUD event dispatch. A tileset load fires
 * hundreds of requests per second; the HUD needs ~2 paints/second, and the
 * trailing timer guarantees the final total always lands.
 */
const DISPATCH_THROTTLE_MS = 400;

let installedTracker = null;

/**
 * The shared session tracker, or null before {@link installMapsSpendMonitor}
 * runs. The HUD uses this for its initial paint.
 */
export function getMapsSpendTracker() {
  return installedTracker;
}

/**
 * Resolve a request URL string from any `fetch(input)` shape.
 * @param {unknown} input - string | URL | Request | anything
 * @returns {string}
 */
function urlOfFetchInput(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  // Request (or Request-alike) — `.url` is already absolute.
  if (input && typeof input === 'object' && typeof input.url === 'string') {
    return input.url;
  }
  return String(input ?? '');
}

/**
 * Install the fetch + XHR instrumentation once. Call at boot, BEFORE the
 * Google 3D tileset starts loading, so the first tile is already metered.
 *
 * @returns {ReturnType<typeof createMapsCostTracker>} the shared tracker
 */
export function installMapsSpendMonitor() {
  if (installedTracker) return installedTracker;
  const tracker = createMapsCostTracker();
  installedTracker = tracker;

  // Throttled rebroadcast → spend HUD. Leading paint for responsiveness,
  // trailing paint so the settled total is never stale by one burst.
  let dispatchTimer = null;
  let lastDispatchAt = 0;
  const dispatchState = (state) => {
    try {
      window.dispatchEvent(new CustomEvent(MAPS_COST_EVENT, { detail: state }));
    } catch {
      // Event dispatch failure must never reach the request path.
    }
  };
  tracker.subscribe((state) => {
    const now = Date.now();
    if (now - lastDispatchAt >= DISPATCH_THROTTLE_MS) {
      lastDispatchAt = now;
      dispatchState(state);
      return;
    }
    if (dispatchTimer) return;
    dispatchTimer = setTimeout(() => {
      dispatchTimer = null;
      lastDispatchAt = Date.now();
      dispatchState(tracker.state());
    }, DISPATCH_THROTTLE_MS);
  });

  // ── window.fetch ──────────────────────────────────────────────────
  const originalFetch = window.fetch.bind(window);
  window.fetch = function gevMeteredFetch(input, init) {
    try {
      tracker.recordUrl(urlOfFetchInput(input));
    } catch {
      // Accounting must never break a request.
    }
    return originalFetch(input, init);
  };

  // ── XMLHttpRequest ────────────────────────────────────────────────
  // Cesium 1.138's Resource layer issues tile requests through XHR, not
  // fetch. Wrapping `open` (not `send`) is enough: Cesium never opens a
  // request it does not send, and `open` is where the URL is visible.
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function gevMeteredOpen(method, url, ...rest) {
    try {
      tracker.recordUrl(url);
    } catch {
      // Accounting must never break a request.
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  return tracker;
}
