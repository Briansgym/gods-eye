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
  NEWS_ACCENT,
  NEWS_OVERLAY_COHORT_LIMIT,
  NEWS_OVERLAY_COLLISION_CAPACITY,
  NEWS_OVERLAY_SOURCE_ID,
  newsAgeText,
  newsEntityId,
  newsPixelSize,
  createNewsOverlayEntry,
  selectNewsFocusRecord,
  selectNewsOverlayCohort,
  selectNewsRosterRecords,
  normalizeNewsArticles,
} from './newsModel.js';

/**
 * Global news coverage — GDELT GKG GEO (api.gdeltproject.org, keyless),
 * served through the local /api/news proxy.
 *
 * Honesty contract (brief 2026-09-10): only articles GDELT itself geolocated
 * become pins — no city stand-ins, no synthetic coordinates, no keyword
 * guessing, no Google News expansion, no ACLED, no World Monitor feeds, no
 * scraping of article bodies. Upstream trouble surfaces as an error in
 * getStats() and the last-good pins stay; an empty feed renders an empty
 * layer, never a fake one.
 *
 * Geometry is STATIC: plain point primitives, no per-frame callbacks. The
 * proxy caps upstream refresh (TTL 10 min); pins are capped at 100 by
 * normalizeNewsArticles.
 */
const API_URL = '/api/news';

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export function createNewsLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _dataSource = null;
  let _records = [];
  let _recordById = new Map();
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
    governorRequestRender('news-render');
    _dataSource.entities.removeAll();
    _recordById = new Map();
    const overlayEntries = [];
    for (const record of _records) {
      const entityId = newsEntityId(record.id);
      const selected = entityId === _selectedId;
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const entity = _dataSource.entities.add({
        id: entityId,
        position,
        point: {
          pixelSize: newsPixelSize(record.seenMs, selected),
          color: selected ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString(NEWS_ACCENT),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          title: record.title,
          url: record.url,
          domain: record.domain,
          place: record.place,
          themes: record.themes,
          tone: record.tone,
          seenMs: record.seenMs,
          lat: record.lat,
          lon: record.lon,
        },
      });
      entity.gevTrackedId = entityId;
      entity.gevDisplayPosition = () => position;
      entity.gevLabelModel = {
        title: record.title || 'WORLD NEWS',
        details: [
          record.domain,
          record.place,
          newsAgeText(record.seenMs),
        ].filter(Boolean),
        accent: NEWS_ACCENT,
      };
      registerEntityContext(entity, {
        id: entityId,
        layerId: 'news',
        layerName: 'News (GDELT)',
        source: 'GDELT GKG GEO',
        label: record.title || record.domain || 'News coverage',
        url: record.url,
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          title: record.title,
          url: record.url,
          domain: record.domain,
          place: record.place,
          themes: record.themes,
          tone: record.tone,
          seenMs: record.seenMs,
        },
      });
      _recordById.set(entityId, record);
      overlayEntries.push(createNewsOverlayEntry({
        id: String(record.id),
        position,
        seenMs: record.seenMs,
        title: record.title,
      }));
    }
    const selectedEntity = _selectedId ? _dataSource.entities.getById(_selectedId) : null;
    if (selectedEntity) selectEntityContext(selectedEntity);
    else _selectedId = null;
    if (_enabled) {
      overlayHost.setEntries(
        NEWS_OVERLAY_SOURCE_ID,
        selectNewsOverlayCohort(overlayEntries),
        {
          cohortLimit: NEWS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: NEWS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
  }

  /** Select one news marker and surface it in the shared context store. */
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
      if (pickId && isOwnedByOtherLayer('news', pickId)) return;
      clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    registerPickOwner('news', (pickedId) => (
      _recordById.has(pickedId) || String(pickedId).startsWith('news:')
    ));
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    unregisterPickOwner('news');
  }

  const layer = {
    id: 'news',
    name: 'News (GDELT)',
    icon: '📰',
    source: 'GDELT',
    updateInterval: 10 * 60_000, // matches the proxy TTL

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('news');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _records = [];
      _recordById = new Map();
      _selectedId = null;
      _count = 0;
      _total = 0;
      _lastUpdate = null;
      _lastError = null;
      _loading = false;
      _enabled = false;
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:News] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(NEWS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      _loading = true;
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          _lastError = `GDELT proxy HTTP ${response.status}`;
          _loading = false;
          console.warn(`[Data:News] API returned ${response.status}`);
          return false;
        }
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.articles)) {
          _lastError = 'Malformed GDELT response';
          _loading = false;
          return false;
        }
        _records = normalizeNewsArticles(payload.articles);
        _selectedId = _recordById.has(_selectedId) ? _selectedId : null;
        renderRecords();
        _count = _records.length;
        _total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : _records.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _loading = false;
        console.log(`[Data:News] Updated: ${_count} pins (of ${_total} geolocated articles)`);
        return true;
      } catch (e) {
        console.warn('[Data:News] Fetch error:', e);
        _lastError = 'GDELT network error';
        _loading = false;
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      removeClickHandler();
      overlayHost.clearSource(NEWS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _records = [];
      _recordById = new Map();
      _selectedId = null;
      _count = 0;
      _total = 0;
      _lastUpdate = null;
      _lastError = null;
      _loading = false;
    },

    /**
     * Newest geolocated record for the NEWS rail chip to fly to (or null →
     * honest empty). Pure selection over the loaded records.
     */
    getFocusRecord() {
      const record = selectNewsFocusRecord(_records);
      if (!record) return null;
      return {
        ...record,
        entityId: newsEntityId(record.id),
        ageText: newsAgeText(record.seenMs),
      };
    },

    /**
     * Rows for the NEWS roster panel: the same geolocated records as the
     * pins, newest first, capped by selectNewsRosterRecords. Pure view —
     * the roster adds no feed of its own.
     */
    getRoster() {
      return selectNewsRosterRecords(_records);
    },

    /** Select one pin by entity id (roster rows and the NEWS chip share it). */
    selectEvent,

    /**
     * Snapshot the loaded geolocated articles as plain JSON (same seam as
     * conflicts.getAnalystRecords) so the double-click `news:` dive and the
     * voice inspect-dive read the SAME records. On-demand only; [] when the
     * layer is disabled or empty. No new network — these are the loaded pins.
     * @param {number} [maxCount=500]
     * @returns {Array<{id:string,title:string|null,domain:string|null,url:string|null,lat:number,lon:number,seenMs:number|null}>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 500;
      return _records.slice(0, limit).map((record) => ({
        id: String(record.id),
        title: record.title ?? null,
        domain: record.domain ?? null,
        url: record.url ?? null,
        lat: record.lat,
        lon: record.lon,
        seenMs: record.seenMs ?? null,
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

const newsLayer = createNewsLayer();

export default newsLayer;
