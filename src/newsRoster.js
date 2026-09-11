// src/newsRoster.js — NEWS roster panel: the readable half of the NEWS layer
// (brief 2026-09-10). Renders the same geolocated GDELT records the globe
// pins — newest first, capped by selectNewsRosterRecords — and flies the
// camera to a row's pin through the layer's own select path.
//
// Honesty contract: one feed (/api/news via the layer), no scraping of
// article bodies, no synthetic coordinates. Empty or failing feed renders
// one honest status line; the last-good rows stay until a refresh replaces
// them. The panel lives in #left-panel-stack (order 3) so the adaptive
// accordion engine owns its height and collisions.

import { flyToLandmark } from './locations.js';
import { newsAgeText } from './data/newsModel.js';

const PANEL_ID = 'news-roster-panel';
const LIST_ID = 'news-roster-list';
const STATUS_ID = 'news-roster-status';
/** Age labels ("3m ago") go stale between refreshes; re-render is cheap. */
const REFRESH_MS = 30_000;
/** Same framing the NEWS chip uses, so a row and the chip land identically. */
const FLY_OPTIONS = { range: 180_000, pitch: -55, duration: 2.4 };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function getViewer() {
  return window.__godsEyeView?.viewer || null;
}

function layerModule(dataManager) {
  return dataManager?.layers?.get?.('news')?.module || null;
}

function renderStatus(el, { loading, error, shown, total }) {
  if (error && !shown) {
    el.textContent = `No headlines — ${error}.`;
    el.dataset.tone = 'error';
    return;
  }
  if (error) {
    el.textContent = `Feed error — ${error}. Last-good list below.`;
    el.dataset.tone = 'error';
    return;
  }
  if (loading && !shown) {
    el.textContent = 'Loading GDELT headlines…';
    el.dataset.tone = 'loading';
    return;
  }
  el.dataset.tone = 'ok';
  el.textContent = shown === 0
    ? 'Feed live — nothing geolocated in the window.'
    : total > shown
      ? `${shown} of ${total} geolocated · newest first`
      : `${shown} geolocated · newest first`;
}

function clickRow(module, entityId, viewer) {
  const record = module?.getRoster?.().find((r) => r.entityId === entityId);
  if (!record || !viewer) return null;
  module.selectEvent?.(record.entityId);
  flyToLandmark(viewer, record.lat, record.lon, { range: 180_000, pitch: -55, duration: 2.4 });
  return record;
}

/**
 * Init the NEWS roster panel: readable headlines while the News layer is ON,
 * click a row → fly to that pin (brief 2026-09-10). One feed — the layer's
 * /api/news records; no scraping, no invented coordinates.
 */
export function initNewsRoster({ dataManager }) {
  const panel = document.getElementById(PANEL_ID);
  const list = document.getElementById(LIST_ID);
  const status = document.getElementById(STATUS_ID);
  if (!panel || !list || !status || !dataManager) return null;

  let selectedEntityId = null;
  let refreshTimer = null;

  const render = () => {
    const module = layerModule(dataManager);
    const rows = module?.getRoster?.() ?? [];
    const stats = module?.getStats?.() ?? {};
    renderStatus(status, {
      loading: Boolean(stats.loading),
      error: stats.error || null,
      shown: rows.length,
      total: Number(stats.count) || rows.length,
    });
    if (selectedEntityId && !rows.some((r) => r.entityId === selectedEntityId)) {
      selectedEntityId = null; // refresh dropped the selected pin
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'news-roster-item';
      btn.dataset.entityId = row.entityId;
      btn.title = `${row.title} — fly to pin`;
      btn.innerHTML = `<span class="news-roster-item-title">${esc(row.title)}</span>`
        + '<span class="news-roster-item-meta">'
        + `<span class="news-roster-item-domain">${esc(row.domain || 'unknown source')}</span>`
        + `<span class="news-roster-item-age">${esc(row.seenMs ? newsAgeText(row.seenMs) : 'time unknown')}</span>`
        + '</span>';
      if (row.entityId === selectedEntityId) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        const record = clickRow(layerModule(dataManager), row.entityId, getViewer());
        if (!record) return;
        selectedEntityId = record.entityId;
        for (const el of list.querySelectorAll('.news-roster-item.selected')) {
          el.classList.remove('selected');
        }
        btn.classList.add('selected');
        flyToLandmark(viewer, record.lat, record.lon, FLY_OPTIONS);
      });
      li.appendChild(btn);
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
  };

  const show = () => {
    panel.hidden = false;
    // Open with the layer (brief: roster should open/stay with the layer).
    // The class flip is observed by the left-stack engine, which re-solves
    // the corridor so DATA LAYERS/CCTV never get covered.
    panel.classList.remove('collapsed');
    render();
    if (!refreshTimer) refreshTimer = window.setInterval(render, REFRESH_MS);
  };

  const hide = () => {
    panel.hidden = true;
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  const unsubscribe = dataManager.subscribe((event) => {
    if (!event || event.layerId !== 'news') return;
    if (event.type === 'visibility') {
      if (event.enabled) show();
      else hide();
      return;
    }
    if (!panel.hidden
      && (event.type === 'refresh'
        || event.type === 'refresh-transition'
        || event.type === 'refresh-cancelled'
        || event.type === 'refresh-failed')) {
      render();
    }
  });

  // Late init: the layer may already be ON (restored share/layer state).
  if (Boolean(dataManager.layers?.get?.('news')?.enabled)) show();
  else hide();

  return {
    destroy() {
      hide();
      unsubscribe?.();
    },
  };
}
