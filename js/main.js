// main.js — App init, view switching, hash routing, keyboard shortcuts

import { THREAD_COLORS, THREAD_ORDER } from './constants.js';
import {
  getState, on, setView, setFilters, setHelp,
  setSidebarWidth, setSidebarHidden, resetAll,
  selectEntity, pinEntity, setDetailOpen, setLineage,
} from './state.js';
import { loadCore, loadPapers, loadGraph, loadCoauthor, getCore, getCoreIndexes } from './data.js';

// View modules — lazy imported
let timelineModule = null;
let networkModule = null;
let coauthorModule = null;
let sidebarModule = null;
let detailModule = null;
let searchModule = null;

// --- macOS trackpad swipe-back prevention ---
document.documentElement.style.overscrollBehavior = 'none';
document.body.style.overscrollBehavior = 'none';
document.addEventListener('wheel', function (ev) {
  if (getState().view !== 'timeline') return;
  if (ev.target?.closest?.('#detail-panel')) return;
  if (ev.target?.closest?.('#sidebar')) return;
  if (ev.target?.closest?.('#search-dropdown')) return;
  if (ev.target?.closest?.('#main-area')) {
    ev.preventDefault();
  }
}, { passive: false, capture: true });


// --- View switching ---
function switchView(name) {
  setView(name);
}

on('view:changed', async ({ current }) => {
  const views = { timeline: 'timeline-view', network: 'network-view', coauthor: 'coauthor-view' };
  for (const [key, id] of Object.entries(views)) {
    const el = document.getElementById(id);
    if (el) el.style.display = key === current ? 'block' : 'none';
  }

  for (const btn of document.querySelectorAll('.controls button[data-view]')) {
    btn.classList.toggle('active', btn.dataset.view === current);
  }

  if (current === 'timeline') {
    if (!timelineModule) {
      timelineModule = await import('./timeline-canvas.js');
      timelineModule.init();
    }
    timelineModule.onActivate?.();
  } else if (current === 'network') {
    if (!networkModule) {
      await loadGraph();
      networkModule = await import('./network.js');
      networkModule.init();
    }
    networkModule.onActivate?.();
  } else if (current === 'coauthor') {
    if (!coauthorModule) {
      await loadCoauthor();
      coauthorModule = await import('./coauthor.js');
      coauthorModule.init();
    }
    coauthorModule.onActivate?.();
  }
});


// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  const st = getState();

  if (e.key === '?') {
    e.preventDefault();
    setHelp(!st.helpOpen);
  } else if (e.key === 'Escape') {
    if (st.helpOpen) {
      setHelp(false);
    } else if (st.lineageActive) {
      setLineage(false, new Set(), new Set());
      pinEntity(null);
      selectEntity(null);
    } else if (st.pinnedEntity || st.selectedEntity) {
      pinEntity(null);
      selectEntity(null);
    } else {
      resetAll();
    }
  } else if (e.key === '1') {
    switchView('timeline');
  } else if (e.key === '2') {
    switchView('network');
  } else if (e.key === '3') {
    switchView('coauthor');
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    navigateConnected(e.key === 'ArrowRight' ? 1 : -1);
  }
});

// --- Arrow key navigation between connected papers ---
function navigateConnected(direction) {
  const st = getState();
  if (!st.pinnedPaperId) return;
  const core = getCore();
  const indexes = getCoreIndexes();
  if (!core || !indexes) return;

  const paper = core.papers?.[st.pinnedPaperId];
  if (!paper) return;

  // Gather connected papers (outgoing refs for right, incoming for left)
  const adj = indexes.paperEdgeIndex?.[String(st.pinnedPaperId)];
  if (!adj || adj.size === 0) return;

  const connected = Array.from(adj)
    .map(id => core.papers?.[id])
    .filter(Boolean)
    .sort((a, b) => (a.d || '').localeCompare(b.d || ''));

  if (connected.length === 0) return;

  // Pick highest influence among connected
  const best = connected.reduce((a, b) => (b.inf || 0) > (a.inf || 0) ? b : a);
  selectEntity({ type: 'paper', id: best.id });
}


// --- Help overlay ---
on('help:changed', ({ open }) => {
  const overlay = document.getElementById('help-overlay');
  if (overlay) overlay.classList.toggle('open', open);
});


// --- Sidebar ---
function positionSidebarButtons() {
  const sidebar = document.getElementById('sidebar');
  const widthBtn = document.getElementById('sidebar-width-toggle');
  const hideBtn = document.getElementById('sidebar-hide-toggle');
  const st = getState();
  if (sidebar && (widthBtn || hideBtn)) {
    const rect = sidebar.getBoundingClientRect();
    const leftPx = (st.sidebarHidden ? window.innerWidth - 24 : rect.left) + 'px';
    if (widthBtn) {
      widthBtn.style.left = leftPx;
      widthBtn.style.display = st.sidebarHidden ? 'none' : '';
    }
    if (hideBtn) {
      hideBtn.style.left = leftPx;
      hideBtn.textContent = st.sidebarHidden ? '\u25C0' : '\u25B6';
    }
  }
}

on('sidebar:changed', ({ wide, hidden }) => {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('sidebar-wide', wide);
  app.classList.toggle('sidebar-hidden', hidden);
  positionSidebarButtons();
});

window.addEventListener('resize', positionSidebarButtons);


// --- Detail panel close ---
on('detail:changed', ({ open }) => {
  const panel = document.getElementById('detail-panel');
  if (panel) panel.classList.toggle('open', open);
});

on('selection:changed', ({ current }) => {
  if (current && detailModule) {
    detailModule.show(current);
  }
});


// --- Hash routing ---
function parseHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return {};
  const params = {};
  for (const part of hash.split('&')) {
    const [k, v] = part.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

function applyHash() {
  const params = parseHash();
  if (params.view) setView(params.view);
  if (params.thread) setFilters({ activeThread: params.thread });
  if (params.author) setFilters({ activeAuthor: params.author });
  if (params.paper) selectEntity({ type: 'paper', id: params.paper });
  if (params.inf) setFilters({ minInfluence: Number(params.inf) });
  if (params.papers) {
  }
  if (params.tag) setFilters({ activeTag: params.tag });
}

export function updateHash() {
  const st = getState();
  const parts = [];
  if (st.view !== 'timeline') parts.push('view=' + st.view);
  if (st.activeThread) parts.push('thread=' + encodeURIComponent(st.activeThread));
  if (st.activeAuthor) parts.push('author=' + encodeURIComponent(st.activeAuthor));
  if (st.activeTag) parts.push('tag=' + encodeURIComponent(st.activeTag));
  if (st.selectedEntity) {
    const { type, id } = st.selectedEntity;
    parts.push(type + '=' + encodeURIComponent(id));
  }
  if (st.minInfluence > 0) parts.push('inf=' + st.minInfluence.toFixed(4));

  const hash = parts.length ? '#' + parts.join('&') : '';
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash || window.location.pathname);
  }
}

on('view:changed', updateHash);
on('filters:changed', updateHash);
on('selection:changed', updateHash);
on('content:changed', updateHash);

window.addEventListener('hashchange', applyHash);


// --- Toast notifications ---
let toastTimer = null;
export function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}


// --- Expose toggle functions for inline HTML handlers ---
window.showView = switchView;
window.toggleHelp = () => setHelp(!getState().helpOpen);
window.toggleSidebarWidth = () => setSidebarWidth(!getState().sidebarWide);
window.toggleSidebarHidden = () => setSidebarHidden(!getState().sidebarHidden);
window.closeDetail = () => setDetailOpen(false);


// --- App init ---
async function init() {
  const core = await loadCore();

  // Init sidebar, detail, and search modules
  [sidebarModule, detailModule, searchModule] = await Promise.all([
    import('./sidebar.js'),
    import('./detail.js'),
    import('./search.js'),
  ]);
  sidebarModule.init(core);
  detailModule.init();
  searchModule.init(core);

  // Init default view (timeline)
  timelineModule = await import('./timeline-canvas.js');
  timelineModule.init();

  // Apply hash state after everything is ready
  applyHash();

  // Position sidebar buttons on initial load
  positionSidebarButtons();
}

// Boot
init().catch(err => {
  console.error('Failed to initialize app:', err);
  document.getElementById('main-area').innerHTML =
    '<div style="color:#f66;padding:40px;font-size:14px">Failed to load: ' +
    err.message + '</div>';
});
