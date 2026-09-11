// src/maps/mapsCost.js
/**
 * Google Maps Platform session spend estimation.
 *
 * Pure module (no DOM, no network, no secrets) mirroring the style of
 * `src/voice/voiceCost.js`, so it can be shared by:
 *   1. the browser spend monitor (`mapsSpendMonitor.js`) — fetch/XHR wrapper
 *   2. the always-on spend HUD (`spendHud.js`) — "MAPS ~$0.00" readout
 *   3. unit tests (`mapsCost.test.mjs`)
 *
 * This counts REQUESTS MADE BY THIS BROWSER SESSION and prices them against
 * published list rates. It is a runaway-spend hint, NOT Cloud Billing truth:
 * it knows nothing about free tier, caching discounts, per-session tile
 * bundling, volume pricing, or other tabs/devices on the same key.
 *
 * There is deliberately NO hard cap here (unlike voiceCost): killing the
 * globe over an estimate would break the whole app. Warn color only.
 *
 * @module maps/mapsCost
 */

import { formatCostUsd } from '../voice/voiceCost.js';

export { formatCostUsd };

/* ------------------------------------------------------------------ *
 * SKU RATES
 * ------------------------------------------------------------------ */

/**
 * ⚠️ VERIFY AT RELEASE — PRICES ARE EXTERNAL FACTS THAT DRIFT. ⚠️
 *
 * Rates read from Google's pricing page on 2026-09-11:
 *   https://developers.google.com/maps/billing-and-pricing/pricing
 *   - Map Tiles API, Photorealistic 3D Tiles: $6.00 / 1000 requests
 *   - Geocoding API: $5.00 / 1000 requests
 *   - Places API (Text Search / Nearby ballpark): $32.00 / 1000 requests
 *   - Map Tiles API, 2D Tiles: $0.60 / 1000 requests
 *
 * Cross-check at release time, same policy as VOICE_MODEL_RATES_VERIFIED_ON
 * in voiceCost.js — a stale rate silently mis-sizes the warning threshold.
 *
 * Rates are USD per 1,000 requests.
 */
export const MAPS_RATES_VERIFIED_ON = '2026-09-11';

/** @typedef {'tiles3d'|'geocoding'|'places'|'tiles2d'} MapsSku */

export const MAPS_SKUS = Object.freeze({
  tiles3d: Object.freeze({
    sku: 'tiles3d',
    label: 'Photorealistic 3D Tiles',
    usdPer1000: 6.0,
  }),
  geocoding: Object.freeze({
    sku: 'geocoding',
    label: 'Geocoding',
    usdPer1000: 5.0,
  }),
  places: Object.freeze({
    sku: 'places',
    label: 'Places',
    usdPer1000: 32.0,
  }),
  tiles2d: Object.freeze({
    sku: 'tiles2d',
    label: 'Map Tiles 2D',
    usdPer1000: 0.6,
  }),
});

/**
 * Session spend threshold, in USD. Soft only — an amber readout, never a
 * stop. Maps is the app's substrate; an estimate must not kill the globe.
 */
export const MAPS_COST_LIMITS = Object.freeze({
  warnUsd: 2,
});

/* ------------------------------------------------------------------ *
 * URL → SKU CLASSIFICATION
 * ------------------------------------------------------------------ */

/**
 * Classify one request URL into a billable Maps SKU, or null when the URL is
 * not Google Maps Platform traffic (other hosts, relative app URLs, garbage).
 *
 * Deliberately total: any unparseable/hostile input returns null rather than
 * throwing — this runs inside a global fetch/XHR wrapper where an exception
 * would break every network request in the app.
 *
 * Attribution policy (conservative, mirrors voiceCost's "over-estimate,
 * never under" direction):
 *   - `tile.googleapis.com` is the Photorealistic 3D Tiles endpoint in this
 *     app (Cesium createGooglePhotorealistic3DTileset) → tiles3d, UNLESS the
 *     path clearly says 2D (`/2dtiles`), then tiles2d.
 *   - `maps.googleapis.com` path containing `/geocode` → geocoding.
 *   - `places.googleapis.com`, or `maps.googleapis.com` path containing
 *     `/place` → places.
 *   - any other `maps.googleapis.com` traffic → tiles2d (cheapest known SKU;
 *     it is misc API chatter, not per-request premium billing).
 *
 * @param {unknown} url
 * @returns {MapsSku|null}
 */
export function classifyMapsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null; // relative app URL or garbage — not Maps traffic
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host === 'tile.googleapis.com' || host.endsWith('.tile.googleapis.com')) {
    return path.includes('2dtiles') ? 'tiles2d' : 'tiles3d';
  }
  if (host === 'places.googleapis.com') {
    return 'places';
  }
  if (host === 'maps.googleapis.com') {
    if (path.includes('/geocode')) return 'geocoding';
    if (path.includes('/place')) return 'places';
    return 'tiles2d';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * SESSION COST TRACKER
 * ------------------------------------------------------------------ */

/**
 * Accumulate per-request SKU counts into a running session estimate, with a
 * one-shot warning latch at the soft threshold. No hard cap by design.
 *
 * API mirrors `createVoiceCostTracker` where it makes sense:
 *   - `recordUrl(url)` folds one request in, returns a snapshot
 *   - `usd()` running total
 *   - `counts()` per-SKU request counts
 *   - `state()` snapshot without recording
 *   - `subscribe(fn)` change notifications (for the HUD), returns unsubscribe
 *
 * @param {{limits?: {warnUsd?: number}}} [options]
 */
export function createMapsCostTracker(options = {}) {
  const warnRaw = Number(options.limits?.warnUsd);
  const warnUsd = Number.isFinite(warnRaw) && warnRaw > 0
    ? warnRaw
    : MAPS_COST_LIMITS.warnUsd;

  /** @type {Record<MapsSku, number>} */
  const skuCounts = { tiles3d: 0, geocoding: 0, places: 0, tiles2d: 0 };
  let totalUsd = 0;
  let requests = 0;
  let warned = false;
  const listeners = new Set();

  const snapshot = (warnCrossed = false) => ({
    totalUsd,
    requests,
    counts: { ...skuCounts },
    warnUsd,
    /** 'ok' | 'warn' — monotonic; there is no 'cap' for Maps. */
    level: warned ? 'warn' : 'ok',
    /** True only on the single recordUrl() that crossed the threshold. */
    warnCrossed,
    /** Compact readout text ("~$0.42"). */
    display: formatCostUsd(totalUsd),
  });

  const notify = (state) => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A HUD paint failure must never break the request path.
      }
    }
  };

  return {
    /**
     * Fold one request URL into the session estimate. Non-Maps URLs are
     * ignored. Never throws — this runs inside global fetch/XHR wrappers.
     * @param {unknown} url
     */
    recordUrl(url) {
      const sku = classifyMapsUrl(url);
      if (!sku) return snapshot();
      skuCounts[sku] += 1;
      requests += 1;
      totalUsd += MAPS_SKUS[sku].usdPer1000 / 1000;
      let warnCrossed = false;
      if (!warned && totalUsd >= warnUsd) {
        warned = true;
        warnCrossed = true;
      }
      const state = snapshot(warnCrossed);
      notify(state);
      return state;
    },
    /** Running session estimate in USD. */
    usd: () => totalUsd,
    /** Per-SKU request counts for this session. */
    counts: () => ({ ...skuCounts }),
    /** Current state without recording anything. */
    state: () => snapshot(),
    /**
     * Subscribe to state changes (fired on every recorded Maps request).
     * @param {(state: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reset for a new session (same limits). */
    reset() {
      skuCounts.tiles3d = 0;
      skuCounts.geocoding = 0;
      skuCounts.places = 0;
      skuCounts.tiles2d = 0;
      totalUsd = 0;
      requests = 0;
      warned = false;
      const state = snapshot();
      notify(state);
      return state;
    },
  };
}
