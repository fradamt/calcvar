// state.js — Centralized state with granular events + locked action API

const listeners = new Map();

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, detail) {
  const fns = listeners.get(event);
  if (fns) fns.forEach(fn => fn(detail));
}

// --- State ---
const state = {
  view: 'timeline',

  // Selection — entity types: 'paper', 'author', 'thread'
  selectedEntity: null,
  hoveredEntity: null,
  pinnedEntity: null,
  pinnedPaperId: null,

  // Filters
  activeThread: null,
  activeAuthor: null,
  activeTag: null,
  minInfluence: 0,

  // Content toggles
  showPapers: true,

  // Paper filters
  paperFilterYearMin: null,
  paperFilterYearMax: null,
  paperFilterMinCitations: 0,
  paperFilterTag: '',
  paperSidebarSort: 'influence',

  // UI state
  sidebarWide: false,
  sidebarHidden: false,

  // Lineage
  lineageActive: false,
  lineageSet: new Set(),
  lineageEdgeSet: new Set(),

  // Path finding
  pathMode: false,
  pathStart: null,
  pathSet: new Set(),
  pathEdgeSet: new Set(),

  // Detail panel open
  detailOpen: false,

  // Help overlay
  helpOpen: false,
};

// --- Locked Action API ---

export function pinEntity(entity) {
  const prev = state.pinnedEntity;
  state.pinnedEntity = entity;
  state.pinnedPaperId = entity?.type === 'paper' ? entity.id : null;
  state.detailOpen = false;
  state.selectedEntity = null;
  emit('pin:changed', { prev, current: entity });
}

export function selectEntity(entity) {
  const prev = state.selectedEntity;
  state.selectedEntity = entity;
  state.detailOpen = !!entity;
  state.pinnedEntity = entity;
  if (entity?.type === 'paper') state.pinnedPaperId = entity.id;
  emit('selection:changed', { prev, current: entity });
}

export function hoverEntity(entity) {
  state.hoveredEntity = entity;
  emit('hover:changed', entity);
}

export function setView(name) {
  const prev = state.view;
  state.view = name;
  emit('view:changed', { prev, current: name });
}

export function setFilters(updates) {
  const changed = {};
  for (const [key, value] of Object.entries(updates)) {
    if (state[key] !== value) {
      changed[key] = { from: state[key], to: value };
      state[key] = value;
    }
  }
  if (Object.keys(changed).length > 0) {
    emit('filters:changed', changed);
  }
}

export function setContentToggle(key, value) {
  if (state[key] !== value) {
    state[key] = value;
    emit('content:changed', { key, value });
  }
}

export function setLineage(active, nodeSet, edgeSet) {
  state.lineageActive = active;
  state.lineageSet = nodeSet || new Set();
  state.lineageEdgeSet = edgeSet || new Set();
  emit('lineage:changed', { active, nodeSet: state.lineageSet, edgeSet: state.lineageEdgeSet });
}

export function setPath(active, start, nodeSet, edgeSet) {
  state.pathMode = active;
  state.pathStart = start;
  state.pathSet = nodeSet || new Set();
  state.pathEdgeSet = edgeSet || new Set();
  emit('path:changed', { active, start, nodeSet: state.pathSet, edgeSet: state.pathEdgeSet });
}

export function setDetailOpen(open) {
  state.detailOpen = open;
  if (!open) {
    state.selectedEntity = null;
  }
  emit('detail:changed', { open });
}

export function setHelp(open) {
  state.helpOpen = open;
  emit('help:changed', { open });
}

export function setSidebarWidth(wide) {
  state.sidebarWide = wide;
  emit('sidebar:changed', { wide, hidden: state.sidebarHidden });
}

export function setSidebarHidden(hidden) {
  state.sidebarHidden = hidden;
  emit('sidebar:changed', { wide: state.sidebarWide, hidden });
}

export function resetAll() {
  state.selectedEntity = null;
  state.hoveredEntity = null;
  state.pinnedEntity = null;
  state.pinnedPaperId = null;
  state.activeThread = null;
  state.activeAuthor = null;
  state.activeTag = null;
  state.minInfluence = 0;
  state.showPapers = true;
  state.lineageActive = false;
  state.lineageSet = new Set();
  state.lineageEdgeSet = new Set();
  state.pathMode = false;
  state.pathStart = null;
  state.pathSet = new Set();
  state.pathEdgeSet = new Set();
  state.detailOpen = false;
  emit('reset', {});
  emit('filters:changed', {});
  emit('selection:changed', { prev: null, current: null });
  emit('detail:changed', { open: false });
}

// Read-only access
export function getState() {
  return state;
}

export { on, emit };
