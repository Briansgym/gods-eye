import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { registerEntityContext, selectEntityContext } from './contextStore.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  CONFLICTS_OVERLAY_COHORT_LIMIT,
  CONFLICTS_OVERLAY_COLLISION_CAPACITY,
  CONFLICTS_OVERLAY_SOURCE_ID,
  conflictEntityId,
  conflictTypeAccent,
  conflictTypeLabel,
  conflictPixelSize,
  createConflictOverlayEntry,
  selectConflictOverlayCohort,
} from './conflictsModel.js';

/**
 * Global armed-conflict events — UCDP Candidate GED (Uppsala University,
 * CC BY 4.0), served through the local /api/conflicts proxy.
 *
 * Honesty contract (same as every layer here): the feed comes from UCDP's
 * official keyless dataset download — no Google, no ACLED key, no scraping.
 * Upstream trouble surfaces as an error in getStats() and the last-good
 * markers stay; an empty dataset renders an empty layer, never a fake one.
 *
 * Geometry is STATIC: plain point primitives, no per-frame callbacks (see
 * the earthquakes module header for the measured cost of violating that).
 * Density is capped by the proxy (default 300 most-recent events) and the
 * ambient label cohort at 96 — the same order as earthquakes.
 */
const API_URL = '/api/conflicts';
const EVENT_LIMIT = 300;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export function createConflictsLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _dataSource = null;
  let _records = [];
  let _recordById = new Map();
  let _lastPayload = null;
  let _selectedId = null;
  let _count = 0;
  let _total = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _loading = false;
  let _enabled = false;
  let _viewer = null;
  let _clickHandler = null;

  /** Render the current records into entities + ambient labels. */
  function renderRecords() {
    if (!_dataSource) return;
    governorRequestRender('conflicts-render');
    _dataSource.entities.removeAll();
    _recordById = new Map();
    const overlayEntries = [];
    for (const record of _records) {
      const entityId = conflictEntityId(record.id);
      const accent = conflictTypeAccent(record.type);
      const selected = entityId === _selectedId;
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const entity = _dataSource.entities.add({
        id: entityId,
        position,
        point: {
          pixelSize: conflictPixelSize(record.best, selected),
          color: selected ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString(accent),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          ucdpId: record.id,
          type: record.type,
          conflict: record.conflict,
          dyad: record.dyad,
          sideA: record.sideA,
          sideB: record.sideB,
          where: record.where,
          country: record.country,
          region: record.region,
          dateStart: record.dateStart,
          dateEnd: record.dateEnd,
          deathsCivilians: record.deathsCivilians,
          deathsBest: record.best,
          deathsHigh: record.high,
          deathsLow: record.low,
          lat: record.lat,
          lon: record.lon,
        },
      });
      entity.gevTrackedId = entityId;
      entity.gevDisplayPosition = () => position;
      entity.gevLabelModel = {
        title: record.conflict || record.dyad || 'ARMED CONFLICT',
        details: [
          conflictTypeLabel(record.type),
          record.best !== null && record.best !== undefined ? `${record.best} fatalities` : 'fatalities unknown',
          record.dateStart ? String(record.dateStart).slice(0, 10) : null,
          record.country || record.region || null,
        ].filter(Boolean),
        accent,
      };
      registerEntityContext(entity, {
        id: entityId,
        layerId: 'conflicts',
        layerName: 'Conflicts (UCDP GED)',
        source: 'UCDP Candidate GED',
        label: record.conflict || record.dyad || record.where || 'Armed conflict event',
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          type: record.type,
          typeLabel: conflictTypeLabel(record.type),
          conflict: record.conflict,
          dyad: record.dyad,
          sideA: record.sideA,
          sideB: record.sideB,
          where: record.where,
          country: record.country,
          region: record.region,
          dateStart: record.dateStart,
          dateEnd: record.dateEnd,
          deathsCivilians: record.deathsCivilians,
          deathsBest: record.best,
          deathsHigh: record.high,
          deathsLow: record.low,
        },
      });
      _recordById.set(entityId, record);
      overlayEntries.push(createConflictOverlayEntry({
        id: String(record.id),
        position,
        best: record.best,
        accent,
      }));
    }
    const selectedEntity = _selectedId ? _dataSource.entities.getById(_selectedId) : null;
    if (selectedEntity) selectEntityContext(selectedEntity);
    else _selectedId = null;
    if (_enabled) {
      overlayHost.setEntries(
        CONFLICTS_OVERLAY_SOURCE_ID,
        selectConflictOverlayCohort(overlayEntries),
        {
          cohortLimit: CONFLICTS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: CONFLICTS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
  }

  /** Select one conflict marker and surface it in the shared context store. */
  function selectEvent(entityId) {
    const record = _recordById.get(entityId);
    if (!record || !_dataSource) return false;
    _selectedId = entityId;
    renderRecords();
    return _selectedId === entityId;
  }

  function clearSelection() {
    if (!_selectedId) return;
    _selectedId = null;
    renderRecords();
  }

  /** LEFT_CLICK: own picks select; sibling picks are left alone; empty clears. */
  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const pickId = resolvePickId(picked);
      if (pickId && _recordById.has(pickId)) {
        selectEvent(pickId);
        return;
      }
      if (pickId && isOwnedByOtherLayer('conflicts', pickId)) return;
      clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    registerPickOwner('conflicts', (pickedId) => (
      _recordById.has(pickedId) || String(pickedId).startsWith('conflict:')
    ));
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    unregisterPickOwner('conflicts');
  }

  const layer = {
    id: 'conflicts',
    name: 'Conflicts (UCDP)',
    icon: '⚔️',
    source: 'UCDP',
    updateInterval: 3_600_000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('conflicts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _records = [];
      _recordById = new Map();
      _lastPayload = null;
      _selectedId = null;
      _count = 0;
      _total = 0;
      _lastUpdate = null;
      _lastError = null;
      _loading = false;
      _enabled = false;
      overlayHost.setVisible(CONFLICTS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Conflicts] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(CONFLICTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(CONFLICTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CONFLICTS_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      _loading = true;
      try {
        const response = await fetch(`${API_URL}?limit=${EVENT_LIMIT}`);
        if (!response.ok) {
          _lastError = `UCDP proxy HTTP ${response.status}`;
          _loading = false;
          console.warn(`[Data:Conflicts] API returned ${response.status}`);
          return false;
        }
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.events)) {
          _lastError = 'Malformed UCDP response';
          _loading = false;
          return false;
        }
        _lastPayload = payload;
        _records = payload.events;
        _selectedId = _recordById.has(_selectedId) ? _selectedId : null;
        renderRecords();
        _count = payload.events.length;
        _total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : payload.events.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _loading = false;
        console.log(`[Data:Conflicts] Updated: ${_count} events (of ${_total} in dataset)`);
        return true;
      } catch (e) {
        console.warn('[Data:Conflicts] Fetch error:', e);
        _lastError = 'UCDP network error';
        _loading = false;
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      removeClickHandler();
      overlayHost.clearSource(CONFLICTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CONFLICTS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _records = [];
      _recordById = new Map();
      _lastPayload = null;
      _selectedId = null;
      _count = 0;
      _total = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory records as plain JSON for the analyst
     * query engine (same seam as earthquakes). On-demand only; [] when the
     * layer is disabled or empty.
     * @param {number} [maxCount=2000]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      return _records.slice(0, limit).map((record, index) => ({
        id: String(record.id ?? `CONFLICT-${String(index).padStart(4, '0')}`),
        type: record.type,
        conflict: record.conflict,
        country: record.country,
        lat: record.lat,
        lon: record.lon,
        dateStart: record.dateStart,
        deathsBest: record.best,
      }));
    },

    getStats() {
      return {
        count: _count,
        total: _total,
        lastUpdate: _lastUpdate,
        error: _lastError,
        loading: _loading,
      };
    },
  };
  return layer;
}

const conflictsLayer = createConflictsLayer();

export default conflictsLayer;
