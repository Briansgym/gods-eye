/**
 * Godseye command rail — "Show ships / planes / events" as CONTACTS, not cities.
 *
 * Product law (Brian Spencer, 2026-09 brief): tapping a Show chip must land on
 * a real loaded contact — a named hull, an airborne ADS-B aircraft, a live
 * USGS event — or say honestly that there is nothing. It must NEVER fly to a
 * city, port, or preset as a stand-in for data. Empty means empty. Keys stay
 * server-side; a missing key reads "NEEDS KEY", never a fake fleet.
 *
 * The rail reuses the app's own machinery: layer lifecycle via the data
 * manager, contact selection via trackById/selectById, camera dives via the
 * world-focus request lane, and honesty via each layer's getStats() feed
 * state (source / age / live-vs-missing already live there).
 */
import * as Cesium from 'cesium';
import { flyToLandmark } from './locations.js';
import { requestWorldFocus } from './worldFocus.js';
import { readLayerLifecycleSummary } from './voice/gevActions.js';
import { installCommandBox } from './commandBox.js';
import { conflictDiveBanner, conflictRangeM, resolveConflictDive } from './data/conflictsModel.js';

const RAIL_ID = 'command-rail';
const STATUS_MS = 4200;

/** Rail chip definitions. id doubles as the DOM id suffix. */
const RAIL_CHIPS = [
  { id: 'ships', layerId: 'ais-live-vessels', icon: 'directions_boat', label: 'SHIPS' },
  { id: 'planes', layerId: 'flights', icon: 'flight', label: 'PLANES' },
  { id: 'events', layerId: 'earthquakes', icon: 'bolt', label: 'EVENTS' },
  { id: 'news', layerId: 'news', icon: 'newspaper', label: 'NEWS' },
];

function safeStats(dataManager, layerId) {
  try {
    return dataManager?.layers?.get(layerId)?.module?.getStats?.() || null;
  } catch {
    return null;
  }
}

/**
 * A chip's target layer feed state, in the app's own chip vocabulary.
 * @returns {'live'|'connecting'|'missing-key'|'unavailable'|'disabled'}
 */
function feedStateFor(layerId, dataManager) {
  const lifecycle = readLayerLifecycleSummary(dataManager, layerId);
  if (!lifecycle.enabled) return 'disabled';
  const stats = safeStats(dataManager, layerId);
  const error = String(stats?.error || '').toLowerCase();
  if (error.includes('aisstream_api_key') || error.includes('not set')) return 'missing-key';
  if (error.includes('rejected')) return 'missing-key';
  if (stats?.status === 'unavailable' || error.includes('unavailable')) return 'unavailable';
  if (error && error !== 'none') return 'unavailable';
  if (stats?.loading) return 'connecting';
  if (Number(stats?.count) > 0) return 'live';
  return 'connecting';
}

/** Status banner for the rail. Returns null when the DOM host is absent. */
function chipBanner() {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById('command-rail-status');
  if (!el) return null;
  return {
    show(text, tone = 'neutral') {
      el.textContent = text;
      el.dataset.tone = tone;
      el.hidden = false;
      window.clearTimeout(el._timer);
      el._timer = window.setTimeout(() => { el.hidden = true; }, STATUS_MS);
    },
  };
}

/**
 * Ensure a chip's backing layer is on and freshly polled, then report the
 * honest feed state. The dive itself waits for real contacts.
 */
async function ensureLayerReady(dataManager, layerId) {
  const lifecycle = readLayerLifecycleSummary(dataManager, layerId);
  if (!lifecycle.enabled) {
    try {
      await dataManager.setEnabled(layerId, true, { origin: 'voice' });
    } catch { /* surfaced by feed state below */ }
  }
  try {
    await dataManager.refreshLayer(layerId);
  } catch { /* surfaced by feed state below */ }
  await new Promise((resolve) => setTimeout(resolve, 350));
  return feedStateFor(layerId, dataManager);
}

/** Ground point under the camera — where "nearest" is measured from. */
function currentViewTarget(viewer) {
  try {
    const carto = viewer.camera.positionCartographic;
    if (!carto) return null;
    return Cesium.Cartesian3.fromDegrees(
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    );
  } catch {
    return null;
  }
}

function nearestEntries(module, center, maxCount) {
  try {
    return module?.getNearby?.(center, Number.POSITIVE_INFINITY, maxCount) || [];
  } catch {
    return [];
  }
}

/**
 * Ships: nearest real AIS contact. No key → honest empty banner, never a fake
 * fleet, never a port fly-to.
 */
async function showShips({ viewer, dataManager }) {
  const banner = chipBanner();
  const state = await ensureLayerReady(dataManager, 'ais-live-vessels');
  if (state !== 'live') {
    banner?.show(state === 'missing-key'
      ? 'NO SHIPS — AIS needs AISSTREAM_API_KEY (server-side). Empty stays empty.'
      : `NO SHIPS — feed ${state === 'connecting' ? 'still loading' : 'not delivering'}.`, 'empty');
    return;
  }
  const module = dataManager.layers.get('ais-live-vessels')?.module;
  const entries = nearestEntries(module, currentViewTarget(viewer), 8);
  if (!entries.length) {
    banner?.show('NO SHIPS — feed live but no contacts loaded.', 'empty');
    return;
  }
  const target = entries[0];
  const mmsi = target.mmsi ?? target.id;
  const position = target.position || target.billboard?.position || null;
  const selected = module.selectById?.(mmsi);
  const flew = requestWorldFocus({
    kind: 'vessel',
    id: String(mmsi),
    label: target.name || String(mmsi),
    position,
  });
  const name = target.name || module.getSelectedInfo?.()?.name || mmsi;
  banner?.show(selected || flew
    ? `Diving to ${name} — AISStream live · ${entries.length} loaded.`
    : 'Feed live but the dive failed.', (selected || flew) ? 'ok' : 'warn');
}

/**
 * Planes: nearest airborne ADS-B contact via the flights layer's getNearby.
 */
async function showPlanes({ viewer, dataManager }) {
  const banner = chipBanner();
  const state = await ensureLayerReady(dataManager, 'flights');
  if (state !== 'live') {
    banner?.show(`NO PLANES — OpenSky feed ${state === 'connecting' ? 'still loading' : 'not delivering'}.`, 'empty');
    return;
  }
  const module = dataManager.layers.get('flights')?.module;
  const entries = nearestEntries(module, currentViewTarget(viewer), 12);
  const airborne = entries.filter((entry) => entry.altitudeM == null || entry.altitudeM > 0);
  if (!airborne.length) {
    banner?.show('NO PLANES — feed live but no airborne contacts near the view.', 'empty');
    return;
  }
  const target = airborne[0];
  const tracked = module.trackById?.(target.icao24, { origin: 'voice' });
  banner?.show(tracked
    ? `Tracking ${target.callsign || target.icao24} — OpenSky live · ${airborne.length} airborne.`
    : 'Feed live but tracking failed.', tracked ? 'ok' : 'warn');
}

/** Human age for an epoch-ms timestamp. */
function ageText(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'age unknown';
  const mins = Math.max(0, Math.round((Date.now() - epochMs) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round((Date.now() - epochMs) / 3600000);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Framing range for a quake: bigger magnitude, wider orbit. */
function quakeRangeM(mag) {
  return Math.min(60000, Math.max(12000, Math.pow(2, Number(mag) || 4) * 1500));
}

/**
 * Events: newest significant USGS event, then dive to it.
 */
async function showEvents({ viewer, dataManager }) {
  const banner = chipBanner();
  const state = await ensureLayerReady(dataManager, 'earthquakes');
  if (state !== 'live') {
    banner?.show(`NO EVENTS — USGS feed ${state === 'connecting' ? 'still loading' : 'not delivering'}.`, 'empty');
    return;
  }
  const module = dataManager.layers.get('earthquakes')?.module;
  const records = module?.getAnalystRecords?.(400) || [];
  // Analyst record shape is {magnitude, timeMs, ...} (mapAnalystRecord) — the
  // filter reads those canonical fields, so a live feed with M4.5+ events
  // actually dives instead of reporting a false empty.
  const significant = records
    .filter((r) => Number.isFinite(Number(r.magnitude)) && r.magnitude >= 4.5
      && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
    .sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
  if (!significant.length) {
    banner?.show('NO EVENTS — feed live but no M4.5+ events in the last day.', 'empty');
    return;
  }
  const ev = significant[0];
  flyToLandmark(viewer, ev.lat, ev.lon, {
    range: quakeRangeM(ev.magnitude),
    pitch: -50,
    duration: 2.4,
  });
  banner?.show(`M${Number(ev.magnitude).toFixed(1)} — ${ev.place || 'USGS event'} · USGS live · ${ageText(ev.timeMs)}`, 'ok');
}

const DOT_LABELS = {
  live: 'LIVE',
  connecting: 'LOADING',
  'missing-key': 'NEEDS KEY',
  unavailable: 'EMPTY',
  disabled: 'OFF',
};

/** Paint the tiny state dot on each chip. */
function syncChipDots(dataManager) {
  for (const chip of RAIL_CHIPS) {
    const dot = document.getElementById(`command-chip-${chip.id}-dot`);
    if (!dot) continue;
    const state = feedStateFor(chip.layerId, dataManager);
    dot.dataset.state = state;
    dot.title = `${chip.label}: ${DOT_LABELS[state] || state}`;
  }
}

/**
 * News: newest GDELT-geolocated article. Flies to the pin and selects it, or
 * reports an honest empty (feed down / nothing geolocated in the window).
 */
async function showNews({ viewer, dataManager }) {
  const banner = chipBanner();
  const state = await ensureLayerReady(dataManager, 'news');
  if (state !== 'live') {
    banner?.show(`NO NEWS — GDELT feed ${state === 'connecting' ? 'still loading' : 'not delivering'}.`, 'empty');
    return;
  }
  const module = dataManager.layers.get('news')?.module;
  const focus = module?.getFocusRecord?.();
  if (!focus) {
    banner?.show('NO NEWS — feed live but nothing geolocated in the last hour.', 'empty');
    return;
  }
  module.selectEvent?.(focus.entityId);
  flyToLandmark(viewer, focus.lat, focus.lon, {
    range: 180_000,
    pitch: -55,
    duration: 2.4,
  });
  banner?.show(`${focus.title || focus.domain || 'World news'} — GDELT · ${focus.ageText || ageText(focus.seenMs)}`, 'ok');
}

const CHIP_RUNNERS = { ships: showShips, planes: showPlanes, events: showEvents, news: showNews };

/** Build the rail DOM once. Idempotent. */
function buildRail({ dataManager }) {
  if (document.getElementById(RAIL_ID)) return;
  const rail = document.createElement('nav');
  rail.id = RAIL_ID;
  rail.setAttribute('aria-label', 'Command rail — show live contacts');
  for (const chip of RAIL_CHIPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `command-chip-${chip.id}`;
    btn.className = 'command-chip';
    btn.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${chip.icon}</span>`
      + `<span class="command-chip-label">${chip.label}</span>`
      + `<span class="command-chip-dot" id="command-chip-${chip.id}-dot" data-state="idle" title=""></span>`;
    btn.title = `Show real ${chip.label.toLowerCase()} — nearest live contact, or honest empty`;
    btn.addEventListener('click', () => {
      const viewer = window.__godsEyeView?.viewer;
      if (!viewer || !dataManager) return;
      const run = CHIP_RUNNERS[chip.id];
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      Promise.resolve(run({ viewer, dataManager }))
        .catch(() => chipBanner()?.show('Command failed — see console.', 'warn'))
        .finally(() => {
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          syncChipDots(dataManager);
        });
    });
    rail.appendChild(btn);
  }
  const status = document.createElement('div');
  status.id = 'command-rail-status';
  status.hidden = true;
  rail.appendChild(status);
  const host = document.getElementById('command-rail-host') || document.body;
  host.appendChild(rail);
  // Typed command box rides the rail's banner + chip runners (brief 2026-09-09).
  installCommandBox({
    rail,
    banner: (text, tone) => chipBanner()?.show(text, tone),
    runChip: (chipId) => runRailChip({ chipId, dataManager }),
  });
  window.setInterval(() => syncChipDots(dataManager), 5000);
}

/**
 * Run one rail chip by id (ships/planes/events) for the typed command box —
 * the same runners the buttons use, minus button busy-state.
 * @returns {Promise<boolean>} false when no runner/viewer exists; throws when
 *   the runner itself failed so the caller can say "command failed".
 */
export async function runRailChip({ chipId, dataManager }) {
  const viewer = window.__godsEyeView?.viewer;
  const run = CHIP_RUNNERS[chipId];
  if (!viewer || !dataManager || !run) return false;
  try {
    await run({ viewer, dataManager });
  } finally {
    syncChipDots(dataManager);
  }
  return true;
}

/** Layer families a double-click can dive into, in resolution order. */
const DIVE_FAMILIES = [
  { layerId: 'flights', kind: 'aircraft' },
  { layerId: 'military', kind: 'aircraft' },
  { layerId: 'ais-live-vessels', kind: 'vessel' },
  { layerId: 'satellites', kind: 'satellite' },
];

/** Coerce a scene pick to a string id (mirrors pickRegistry conventions). */
function pickedTextId(picked) {
  const raw = picked?.id ?? picked?.primitive?.id;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    const inner = raw.mmsi ?? raw.id;
    return inner == null ? null : String(inner);
  }
  return String(raw);
}

/** Loose Cesium Property reader — constants and raw values both resolve. */
function readGraphicsValue(value, time) {
  if (!value) return null;
  return typeof value.getValue === 'function' ? value.getValue(time) : value;
}

/** A cartesian is divable only when finite and at Earth-surface scale. */
function usableCartesian(position) {
  if (!position
    || !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || !Number.isFinite(position.z)) return null;
  const magnitude = Cesium.Cartesian3.magnitude(position);
  return magnitude >= Cesium.Ellipsoid.WGS84.minimumRadius * 0.95 ? position : null;
}

/**
 * Resolve a world position from any scene pick, in preference order: local
 * stem base (the dot's true ground anchor, not its 2 km label tip), polyline
 * base, entity position, polygon center, then billboard/point primitive
 * position. Exported for the double-click dive test.
 * @returns {Cesium.Cartesian3|null} Divable position, or null (no-op pick).
 */
export function pickedWorldPosition(picked, time = Cesium.JulianDate.now()) {
  if (!picked) return null;
  const entity = picked.id && typeof picked.id === 'object' ? picked.id : null;
  const candidates = [];
  if (entity) {
    candidates.push(entity.__localBaseCartesian);
    const linePositions = readGraphicsValue(entity.polyline?.positions, time);
    if (Array.isArray(linePositions)) candidates.push(linePositions[0]);
    candidates.push(readGraphicsValue(entity.position, time));
    const hierarchy = readGraphicsValue(entity.polygon?.hierarchy, time);
    if (Array.isArray(hierarchy?.positions) && hierarchy.positions.length) {
      candidates.push(Cesium.BoundingSphere.fromPoints(hierarchy.positions).center);
    }
  }
  candidates.push(picked.primitive?.position);
  candidates.push(picked.position);
  for (const candidate of candidates) {
    const usable = usableCartesian(candidate);
    if (usable) return usable;
  }
  return null;
}

/**
 * One double-click dive attempt. Known families keep their inspect/track/
 * select/banner side effects; EVERY other pick that resolves a world position
 * (dams, datacenters, fires, cables, installations, …) dives via the shared
 * `entity` world-focus framing. Empty pick / no position → no-op.
 *
 * Exported for tests; `focus`/`fly`/`banner` are injectable seams only.
 * @returns {string|null} What dove ('vessel'|'aircraft'|'satellite'|
 *   'earthquake'|'conflict'|'news'|'entity'), or null when nothing did.
 */
export function diveOnPick(gev, picked, {
  banner = chipBanner(),
  focus = requestWorldFocus,
  fly = flyToLandmark,
} = {}) {
  if (!gev?.dataManager || !gev?.viewer || !picked) return null;
  const text = pickedTextId(picked);
  if (text) {
    for (const family of DIVE_FAMILIES) {
      const module = gev.dataManager.layers.get(family.layerId)?.module;
      if (!module) continue;
      try {
        if (family.kind === 'vessel') {
          if (!module.selectById?.(text)) continue;
          const info = module.getSelectedInfo?.();
          focus({
            kind: 'vessel',
            id: String(text),
            label: info?.name || text,
            position: info && Number.isFinite(info.latitude) && Number.isFinite(info.longitude)
              ? Cesium.Cartesian3.fromDegrees(info.longitude, info.latitude)
              : null,
          });
          banner?.show(`Inspecting ${info?.name || text} — AISStream · ${ageText(module.getStats?.()?.lastUpdate)}`, 'ok');
          return 'vessel';
        }
        if (family.kind === 'aircraft') {
          if (!module.trackById?.(text, { origin: 'user' })) continue;
          // Tracking alone can leave the camera at globe scale (notably when
          // the aircraft was already tracked, which only re-publishes the
          // selection) — reapply the canonical follow frame so double-click
          // always lands the close inspect view.
          module.refocusTrackedById?.(text, { origin: 'user' });
          const tracked = module.getTrackedInfo?.();
          banner?.show(`Inspecting ${tracked?.callsign || text} — OpenSky · live`, 'ok');
          return 'aircraft';
        }
        if (Number.isFinite(Number(text)) && module.trackById?.(Number(text), { origin: 'user' })) {
          banner?.show(`Inspecting ${text} — CelesTrak · live orbit`, 'ok');
          return 'satellite';
        }
      } catch { /* sibling mismatch — try next family */ }
    }
    // Earthquake entities carry id "earthquake:<usgsId>"
    if (text.startsWith('earthquake:')) {
      const module = gev.dataManager.layers.get('earthquakes')?.module;
      const records = module?.getAnalystRecords?.(2000) || [];
      const wanted = text.slice('earthquake:'.length);
      const match = records.find((r) => String(r.id) === wanted || String(r.id) === text);
      if (match && Number.isFinite(match.lat) && Number.isFinite(match.lon)) {
        fly(gev.viewer, match.lat, match.lon, {
          range: quakeRangeM(match.magnitude),
          pitch: -50,
          duration: 2.2,
        });
        banner?.show(`M${Number(match.magnitude).toFixed(1)} — ${match.place || 'USGS event'} · USGS · ${ageText(match.timeMs)}`, 'ok');
        return 'earthquake';
      }
    }
    // Conflicts entities carry id "conflict:<ucdpId>" — dive + inspect banner.
    if (text.startsWith('conflict:')) {
      const module = gev.dataManager.layers.get('conflicts')?.module;
      const records = module?.getAnalystRecords?.(2000) || [];
      const match = resolveConflictDive(records, text);
      if (match) {
        fly(gev.viewer, match.lat, match.lon, {
          range: conflictRangeM(match.deathsBest),
          pitch: -50,
          duration: 2.2,
        });
        banner?.show(conflictDiveBanner(match), 'ok');
        return 'conflict';
      }
      banner?.show('CONFLICT — record not geolocated in the UCDP feed.', 'empty');
    }
    // News pins carry id "news:<articleId>" — fly + inspect banner.
    if (text.startsWith('news:')) {
      const module = gev.dataManager.layers.get('news')?.module;
      const records = module?.getAnalystRecords?.(500) || [];
      const wanted = text.slice('news:'.length);
      const match = records.find((r) => String(r.id) === wanted);
      if (match && Number.isFinite(match.lat) && Number.isFinite(match.lon)) {
        fly(gev.viewer, match.lat, match.lon, {
          range: 140000,
          pitch: -50,
          duration: 2.2,
        });
        banner?.show(`${match.title || 'WORLD NEWS'} — ${match.domain || 'GDELT'} · ${ageText(match.seenMs)}`, 'ok');
        return 'news';
      }
    }
  }
  // Generic dive: any other pickable dot (or a prefixed pick whose record was
  // missing above) still zooms — the position comes from the pick itself.
  const position = pickedWorldPosition(picked);
  if (!position) return null;
  const entityName = typeof picked.id === 'object' ? String(picked.id?.name || '').trim() : '';
  const label = entityName || text || 'CONTACT';
  const flew = focus({
    kind: 'entity',
    id: text || label,
    label,
    position,
  });
  if (!flew) return null;
  banner?.show(`Inspecting ${label}`, 'ok');
  return 'entity';
}

/**
 * Double-click a contact dot: dive + inspect via the layer's own select
 * machinery (which also feeds the side tab / readout). Registered once.
 */
function installDoubleClickDive(viewer) {
  if (!viewer || viewer.__gevCommandRailDive) return;
  viewer.__gevCommandRailDive = true;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const gev = window.__godsEyeView;
    if (!gev?.dataManager || !gev?.viewer) return;
    const picked = gev.viewer.scene.pick(click.position);
    if (!picked) return;
    diveOnPick(gev, picked);
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}

export function initCommandRail({ viewer, dataManager }) {
  buildRail({ dataManager });
  installDoubleClickDive(viewer);
  syncChipDots(dataManager);
}

export const COMMAND_RAIL_LAYERS = Object.freeze(RAIL_CHIPS.map((chip) => chip.layerId));

export default initCommandRail;
