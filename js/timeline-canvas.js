// timeline-canvas.js — Canvas swim-lane timeline view for papers
// Papers plotted on X=time, Y=subfield swim lanes. Sized by sqrt(influence).

import { THREAD_COLORS, THREAD_ORDER, THREAD_NAMES, TIMELINE_ZOOM_EXTENT, PAPER_LAYER_LIMITS } from './constants.js';
import { getState, on, selectEntity, pinEntity, hoverEntity, setFilters } from './state.js';
import { getCore, getCoreIndexes } from './data.js';
import { setupCanvas, drawDiamond, drawArrow, hexWithAlpha } from './canvas-utils.js';

// --- Module state ---
let initialized = false;
let baseCanvas = null;
let hudCanvas = null;
let baseCtx = null;
let hudCtx = null;
let domOverlay = null;
let containerEl = null;
let canvasW = 0;
let canvasH = 0;
let plotW = 0;
let plotH = 0;
let marginLeft = 0;
let marginTop = 0;
let marginRight = 0;
let marginBottom = 0;
let xScaleOrig = null;
let xScale = null;
let rScale = null;
let laneIdx = {};
let laneH = 0;
let laneOrder = [];
let topicLaneY0 = 0;
let swimH = 0;
let zoomBehavior = null;
let zoomTransform = d3.zoomIdentity;
let paperMap = {};

// RAF
let needsBaseRedraw = true;
let needsHudRedraw = true;
let rafId = null;

// Tween system
let tweens = [];
const TWEEN_DURATION = 200;

// Entity arrays
let paperEntities = [];   // { id, x, y, date, r, color, thread, inf, opacity, targetOpacity, data }
let edgeData = [];         // { source, target, sd, td, sy, ty, opacity }

// Hit-testing: per-lane sorted arrays
let laneBuckets = [];
let entityById = {};

// Hover/pin state
let hoveredIdx = -1;
let hoveredEntity = null;
let hoveredConns = null;
let pinnedConns = null;

// Pin overlay data
let pinOverlayEdges = [];
let pinOverlayLabels = [];

// Labels
let labelSet = new Set();

// --- Constants ---
const TL_MIN_ZOOM = TIMELINE_ZOOM_EXTENT[0];
const TL_MAX_ZOOM = TIMELINE_ZOOM_EXTENT[1];
const TL_EDGE_PAD_FRACTION = 0.05;
const TL_EDGE_PAD_MIN = 40;

function hashCode(n) {
  return ((String(n).split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0) >>> 0)) % 10000;
}

function escHtml(s) {
  const el = document.createElement('span');
  el.textContent = s || '';
  return el.innerHTML;
}

function clampTimelineTransform(t) {
  let k = t && isFinite(t.k) ? t.k : 1;
  k = Math.max(TL_MIN_ZOOM, Math.min(TL_MAX_ZOOM, k));
  if (!plotW || plotW <= 0) return d3.zoomIdentity.translate(0, 0).scale(k);
  const detailPanel = document.getElementById('detail-panel');
  const detailW = (detailPanel && detailPanel.classList.contains('open')) ? detailPanel.offsetWidth : 0;
  const edgePad = Math.max(TL_EDGE_PAD_MIN, plotW * TL_EDGE_PAD_FRACTION);
  const minX = plotW * (1 - k) - edgePad - detailW;
  const maxX = edgePad;
  let x = t && isFinite(t.x) ? t.x : 0;
  if (x < minX) x = minX;
  if (x > maxX) x = maxX;
  return d3.zoomIdentity.translate(x, 0).scale(k);
}

function paperMatchesFilter(p, st) {
  if (st.minInfluence > 0 && (p.inf || 0) < st.minInfluence) return false;
  if (st.activeThread && p.th !== st.activeThread) return false;
  if (st.activeAuthor) {
    const authors = (p.a || []).map(a => (a || '').toLowerCase());
    if (!authors.some(a => a.includes(st.activeAuthor.toLowerCase()))) return false;
  }
  if (st.activeTag && !(p.tags || []).includes(st.activeTag)) return false;
  return true;
}

// --- Tween system ---

function addTween(entity, prop, to, duration) {
  tweens = tweens.filter(tw => !(tw.entity === entity && tw.prop === prop));
  const from = entity[prop];
  if (Math.abs(from - to) < 0.001) { entity[prop] = to; return; }
  tweens.push({ entity, prop, from, to, startTime: performance.now(), duration: duration || TWEEN_DURATION });
}

function tickTweens() {
  if (tweens.length === 0) return false;
  const now = performance.now();
  let anyActive = false;
  const remaining = [];
  for (const tw of tweens) {
    const elapsed = now - tw.startTime;
    if (elapsed >= tw.duration) {
      tw.entity[tw.prop] = tw.to;
    } else {
      const t = elapsed / tw.duration;
      tw.entity[tw.prop] = tw.from + (tw.to - tw.from) * t;
      anyActive = true;
      remaining.push(tw);
    }
  }
  tweens = remaining;
  return anyActive || remaining.length < tweens.length;
}

// --- Tooltip functions ---

let hideTooltipTimer = null;
function cancelHideTooltip() { clearTimeout(hideTooltipTimer); }

function hideTooltip() {
  clearTimeout(hideTooltipTimer);
  hideTooltipTimer = setTimeout(() => {
    const tip = document.getElementById('tooltip');
    if (tip) tip.style.display = 'none';
  }, 80);
}

function positionTooltip(tip, clientX, clientY) {
  let x = clientX + 14;
  let y = clientY - 10;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  if (x + tw > window.innerWidth - 10) x = clientX - tw - 14;
  if (y + th > window.innerHeight - 10) y = window.innerHeight - th - 10;
  if (y < 5) y = 5;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function showPaperTooltip(clientX, clientY, d) {
  cancelHideTooltip();
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  const p = d.data;
  const color = THREAD_COLORS[p.th] || '#2f4f77';
  tip.innerHTML = '<strong style="color:' + color + '">' + escHtml(p.t || '') + '</strong><br>' +
    (p.d ? p.d.slice(0, 4) : '') +
    (p.cc ? ' \u00b7 ' + p.cc + ' citations' : '') +
    ' \u00b7 inf: ' + (p.inf || 0).toFixed(2) +
    (p.a && p.a.length > 0 ? '<br><span style="color:#888">' + escHtml(p.a.slice(0, 3).join(', ')) + (p.a.length > 3 ? ' et al.' : '') + '</span>' : '');
  tip.style.display = 'block';
  positionTooltip(tip, clientX, clientY);
}

// --- Coordinate helpers ---

function screenToPlot(sx, sy) {
  return [sx - marginLeft, sy - marginTop];
}

// --- Hit-testing ---

function buildLaneBuckets() {
  const numLanes = laneOrder.length;
  laneBuckets = new Array(numLanes);
  for (let i = 0; i < numLanes; i++) laneBuckets[i] = [];

  for (let idx = 0; idx < paperEntities.length; idx++) {
    const e = paperEntities[idx];
    const th = (e.data.th && laneIdx[e.data.th] !== undefined) ? e.data.th : '_other';
    const lane = laneIdx[th];
    if (lane !== undefined) laneBuckets[lane].push(idx);
  }

  for (let i = 0; i < numLanes; i++) {
    laneBuckets[i].sort((a, b) => paperEntities[a].date - paperEntities[b].date);
  }
}

function hitTestPaper(sx, sy) {
  const [wx, wy] = screenToPlot(sx, sy);
  const laneFloat = (wy - topicLaneY0) / laneH;
  const laneI = Math.floor(laneFloat);
  if (laneI < 0 || laneI >= laneOrder.length) return -1;

  const bucket = laneBuckets[laneI];
  if (!bucket || bucket.length === 0) return -1;

  const curX = xScale || xScaleOrig;
  let bestIdx = -1;
  let bestDistSq = Infinity;

  for (const idx of bucket) {
    const e = paperEntities[idx];
    if (e.opacity < 0.05) continue;
    const ex = curX(e.date);
    const ey = e.y;
    const dx = wx - ex;
    const dy = wy - ey;
    const distSq = dx * dx + dy * dy;
    const hitR = Math.max(e.r + 2, 6);
    if (distSq < hitR * hitR && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

// --- buildPinnedConnections ---

function buildPinnedConnections(pinned) {
  const connectedPapers = new Set();
  const core = getCore();
  const indexes = getCoreIndexes();

  if (pinned.type === 'paper') {
    connectedPapers.add(pinned.id);
    const adj = indexes?.paperEdgeIndex?.[String(pinned.id)];
    if (adj) adj.forEach(id => connectedPapers.add(id));
  }

  return { connectedPapers };
}

// --- Init ---

export function init() {
  if (initialized) return;
  initialized = true;

  containerEl = document.getElementById('timeline-view');
  if (!containerEl) return;

  const core = getCore();
  if (!core) return;

  paperMap = core.papers || {};

  buildTimeline(core);

  // Event subscriptions
  on('filters:changed', filterTimeline);
  on('selection:changed', onSelectionChanged);
  on('lineage:changed', onLineageChanged);
  on('content:changed', ({ key }) => {
    if (key === 'showPapers') filterTimeline();
  });
  on('reset', onReset);
  on('pin:changed', ({ current }) => {
    if (!current) {
      pinnedConns = null;
      clearPinOverlay();
      filterTimeline();
    }
  });

  // ResizeObserver
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuildTimeline, 200);
  });
  ro.observe(containerEl);

  filterTimeline();
  renderLoop();
}

function onReset() {
  filterTimeline();
}

function rebuildTimeline() {
  if (!containerEl) return;
  const core = getCore();
  if (!core) return;

  containerEl.innerHTML = '';
  baseCanvas = null;
  hudCanvas = null;
  baseCtx = null;
  hudCtx = null;
  domOverlay = null;
  paperEntities = [];
  edgeData = [];
  pinOverlayEdges = [];
  pinOverlayLabels = [];
  labelSet = new Set();
  tweens = [];
  zoomTransform = d3.zoomIdentity;

  buildTimeline(core);
  filterTimeline();
}

function buildTimeline(core) {
  const width = containerEl.clientWidth || 900;
  const height = containerEl.clientHeight || 700;

  const margin = { top: 50, right: 40, bottom: 50, left: 180 };
  plotW = width - margin.left - margin.right;
  plotH = height - margin.top - margin.bottom;
  marginLeft = margin.left;
  marginTop = margin.top;
  marginRight = margin.right;
  marginBottom = margin.bottom;
  swimH = plotH;
  topicLaneY0 = 0;
  canvasW = width;
  canvasH = height;

  // --- Thread lanes ---
  const threadPapers = {};
  THREAD_ORDER.forEach(tid => { threadPapers[tid] = []; });
  threadPapers['_other'] = [];
  Object.values(paperMap).forEach(p => {
    const th = p.th;
    if (th && threadPapers[th]) threadPapers[th].push(p);
    else threadPapers['_other'].push(p);
  });
  laneOrder = [...THREAD_ORDER.filter(t => (threadPapers[t] || []).length > 0)];
  if (threadPapers['_other'].length > 0) laneOrder.push('_other');
  if (laneOrder.length === 0) laneOrder = THREAD_ORDER.slice(0, 4);
  laneH = swimH / laneOrder.length;
  laneIdx = {};
  laneOrder.forEach((tid, i) => { laneIdx[tid] = i; });

  // --- Time scale ---
  const allDates = Object.values(paperMap).map(p => new Date(p.d)).filter(d => !isNaN(d));
  if (allDates.length === 0) return;

  xScaleOrig = d3.scaleTime()
    .domain([d3.min(allDates), d3.max(allDates)])
    .range([0, plotW]);
  xScale = xScaleOrig.copy();

  // --- Size scale ---
  const maxInf = d3.max(Object.values(paperMap), p => p.inf) || 1;
  rScale = d3.scaleSqrt().domain([0, maxInf]).range([2.5, 14]);

  // --- Create wrapper + canvases + DOM overlay ---
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-container';
  wrapper.style.position = 'relative';
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.overflow = 'hidden';
  containerEl.appendChild(wrapper);

  baseCanvas = document.createElement('canvas');
  baseCanvas.style.position = 'absolute';
  baseCanvas.style.left = '0';
  baseCanvas.style.top = '0';
  baseCanvas.style.touchAction = 'none';
  wrapper.appendChild(baseCanvas);
  ({ ctx: baseCtx } = setupCanvas(baseCanvas, width, height));

  hudCanvas = document.createElement('canvas');
  hudCanvas.style.position = 'absolute';
  hudCanvas.style.left = '0';
  hudCanvas.style.top = '0';
  hudCanvas.style.pointerEvents = 'none';
  hudCanvas.style.zIndex = '1';
  wrapper.appendChild(hudCanvas);
  ({ ctx: hudCtx } = setupCanvas(hudCanvas, width, height));

  domOverlay = document.createElement('div');
  domOverlay.style.position = 'absolute';
  domOverlay.style.left = '0';
  domOverlay.style.top = '0';
  domOverlay.style.width = '100%';
  domOverlay.style.height = '100%';
  domOverlay.style.pointerEvents = 'none';
  domOverlay.style.zIndex = '2';
  wrapper.appendChild(domOverlay);

  // --- Pre-compute paper positions ---
  Object.values(paperMap).forEach(p => {
    const th = (p.th && laneIdx[p.th] !== undefined) ? p.th : '_other';
    const lane = laneIdx[th];
    if (lane === undefined) return;
    const yBase = topicLaneY0 + lane * laneH + laneH * 0.12;
    const yRange = laneH * 0.76;
    p._yPos = yBase + (hashCode(p.id) % 100) / 100 * yRange;
    p._date = new Date(p.d);
  });

  // --- Build paper entities ---
  paperEntities = [];
  entityById = {};
  Object.values(paperMap).forEach(p => {
    if (p._yPos === undefined) return;
    const color = p.th ? (THREAD_COLORS[p.th] || '#555') : '#555';
    const entity = {
      id: p.id,
      date: p._date,
      y: p._yPos,
      r: rScale(p.inf || 0),
      color,
      thread: p.th,
      inf: p.inf || 0,
      opacity: 0.65,
      targetOpacity: 0.65,
      visible: true,
      data: p,
    };
    entityById[p.id] = paperEntities.length;
    paperEntities.push(entity);
  });

  buildLaneBuckets();

  // --- Build edge data ---
  edgeData = [];
  const graphEdges = core.graph?.edges || [];
  for (const e of graphEdges) {
    const sP = paperMap[e.source];
    const tP = paperMap[e.target];
    if (sP && tP && sP._yPos !== undefined && tP._yPos !== undefined) {
      edgeData.push({
        source: e.source,
        target: e.target,
        sd: sP._date,
        td: tP._date,
        sy: sP._yPos,
        ty: tP._yPos,
        opacity: 0.06,
        highlighted: false,
      });
    }
  }

  // --- Build label set (top 30 by influence) ---
  const topByInf = Object.values(paperMap)
    .filter(p => p._yPos !== undefined)
    .sort((a, b) => (b.inf || 0) - (a.inf || 0))
    .slice(0, 30);
  labelSet = new Set(topByInf.map(p => p.id));

  // --- DOM lane labels + x-axis ---
  buildDomOverlay();

  // --- Zoom ---
  zoomBehavior = d3.zoom()
    .scaleExtent([TL_MIN_ZOOM, TL_MAX_ZOOM])
    .translateExtent([[0, 0], [plotW, canvasH]])
    .extent([[0, 0], [plotW, canvasH]])
    .constrain(function (transform) { return clampTimelineTransform(transform); })
    .filter(function (ev) {
      if (ev.type === 'wheel') return true;
      if (ev.type === 'dblclick') return false;
      return !ev.button;
    })
    .on('zoom', onZoom);

  d3.select(baseCanvas).call(zoomBehavior);
  baseCanvas.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });

  // --- Pointer events ---
  let pointerRafPending = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

  baseCanvas.addEventListener('pointermove', (event) => {
    lastPointerX = event.offsetX;
    lastPointerY = event.offsetY;
    if (!pointerRafPending) {
      pointerRafPending = true;
      requestAnimationFrame(() => {
        pointerRafPending = false;
        handlePointerMove(lastPointerX, lastPointerY);
      });
    }
  });

  baseCanvas.addEventListener('pointerleave', () => {
    if (hoveredIdx >= 0 || hoveredEntity) {
      hoveredIdx = -1;
      hoveredEntity = null;
      hoverEntity(null);
      hideTooltip();
      if (!getState().pinnedEntity) {
        filterTimeline();
      }
      needsHudRedraw = true;
    }
  });

  // Click handler (single=pin, double=detail)
  let clickTimer = null;
  let clickCount = 0;
  const DBLCLICK_DELAY = 220;

  baseCanvas.addEventListener('click', (event) => {
    const idx = hitTestPaper(event.offsetX, event.offsetY);

    if (idx < 0) {
      const st = getState();
      if (st.pinnedEntity || st.selectedEntity) {
        pinEntity(null);
        selectEntity(null);
        clearPinOverlay();
        hoveredConns = null;
        pinnedConns = null;
        filterTimeline();
      }
      return;
    }

    const entity = paperEntities[idx];
    const entityRef = { type: 'paper', id: entity.data.id };

    event.stopPropagation();
    clickCount++;
    if (clickCount === 1) {
      clickTimer = setTimeout(() => {
        clickCount = 0;
        hoveredConns = null;
        pinEntity(entityRef);
        applyPinnedHighlight();
      }, DBLCLICK_DELAY);
    } else if (clickCount === 2) {
      clearTimeout(clickTimer);
      clickCount = 0;
      hoveredConns = null;
      selectEntity(entityRef);
      applyPinnedHighlight();
    }
  });

  baseCanvas.addEventListener('dblclick', (event) => {
    const idx = hitTestPaper(event.offsetX, event.offsetY);
    if (idx < 0) {
      d3.select(baseCanvas).transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
    }
  });

  needsBaseRedraw = true;
  needsHudRedraw = true;
}

// --- DOM overlay ---

function buildDomOverlay() {
  if (!domOverlay) return;
  domOverlay.innerHTML = '';

  laneOrder.forEach((tid, i) => {
    const y = marginTop + topicLaneY0 + i * laneH + laneH / 2;
    const name = tid === '_other' ? 'Other' : (THREAD_NAMES[tid] || tid);
    const color = tid === '_other' ? '#555' : (THREAD_COLORS[tid] || '#555');
    const label = document.createElement('div');
    label.style.cssText = `position:absolute;right:${canvasW - marginLeft + 10}px;top:${y}px;transform:translateY(-50%);` +
      `color:${color};font-size:11px;font-weight:500;white-space:nowrap;pointer-events:none;font-family:system-ui,sans-serif;`;
    label.textContent = name.length > 22 ? name.slice(0, 20) + '\u2026' : name;
    domOverlay.appendChild(label);
  });

  const axisSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  axisSvg.style.cssText = `position:absolute;left:${marginLeft}px;top:${marginTop + topicLaneY0 + swimH}px;` +
    `width:${plotW}px;height:30px;overflow:visible;pointer-events:none;`;
  axisSvg.setAttribute('width', plotW);
  axisSvg.setAttribute('height', 30);
  domOverlay.appendChild(axisSvg);
  const axisG = d3.select(axisSvg).append('g');
  const xAxisFn = d3.axisBottom(xScaleOrig).ticks(d3.timeYear.every(10)).tickFormat(d3.timeFormat('%Y'));
  axisG.call(xAxisFn);
  axisG.selectAll('text').attr('fill', '#666').attr('font-size', 12);
  axisG.selectAll('.domain, .tick line').attr('stroke', '#333');
  domOverlay._axisG = axisG;
  domOverlay._axisSvg = axisSvg;
}

function updateDomAxis() {
  if (!domOverlay?._axisG) return;
  const k = zoomTransform.k;
  const newX = zoomTransform.rescaleX(xScaleOrig);
  let axisFn;
  if (k > 4) {
    axisFn = d3.axisBottom(newX).ticks(d3.timeYear.every(1)).tickFormat(d3.timeFormat('%Y'));
  } else if (k > 2) {
    axisFn = d3.axisBottom(newX).ticks(d3.timeYear.every(2)).tickFormat(d3.timeFormat('%Y'));
  } else {
    axisFn = d3.axisBottom(newX).ticks(d3.timeYear.every(10)).tickFormat(d3.timeFormat('%Y'));
  }
  domOverlay._axisG.call(axisFn);
  domOverlay._axisG.selectAll('text').attr('fill', '#666').attr('font-size', 12);
  domOverlay._axisG.selectAll('.domain, .tick line').attr('stroke', '#333');
}

// --- Zoom handler ---

function onZoom(ev) {
  zoomTransform = ev.transform;
  xScale = zoomTransform.rescaleX(xScaleOrig);
  updateLabelsForZoom(zoomTransform.k);
  updateDomAxis();
  needsBaseRedraw = true;
  needsHudRedraw = true;
}

function updateLabelsForZoom(zoomK) {
  const baseCount = 30;
  const targetCount = Math.min(200, Math.round(baseCount + (zoomK - 1) * 15));
  const sorted = Object.values(paperMap)
    .filter(p => p._yPos !== undefined && (p.inf || 0) > 0)
    .sort((a, b) => (b.inf || 0) - (a.inf || 0));
  labelSet = new Set(sorted.slice(0, targetCount).map(p => p.id));
}

// --- Pointer move ---

function handlePointerMove(sx, sy) {
  const st = getState();
  const idx = hitTestPaper(sx, sy);
  const oldHovered = hoveredEntity;

  if (idx >= 0) {
    const entity = paperEntities[idx];
    const ref = { type: 'paper', id: entity.data.id };
    if (ref.type !== oldHovered?.type || ref.id !== oldHovered?.id) {
      hoveredEntity = ref;
      hoverEntity(ref);
      baseCanvas.style.cursor = 'pointer';

      if (st.pinnedEntity && pinnedConns) {
        const isPinnedSelf = ref.type === st.pinnedEntity.type && ref.id === st.pinnedEntity.id;
        const isConnected = pinnedConns.connectedPapers.has(ref.id);
        if (!isPinnedSelf && !isConnected) {
          hideTooltip();
          baseCanvas.style.cursor = 'default';
          needsHudRedraw = true;
          return;
        }
      }

      const rect = baseCanvas.getBoundingClientRect();
      const clientX = rect.left + sx;
      const clientY = rect.top + sy;
      showPaperTooltip(clientX, clientY, entity);

      if (st.pinnedEntity) {
        needsHudRedraw = true;
        return;
      }

      hoveredConns = buildPinnedConnections(ref);
      needsHudRedraw = true;
    }
  } else if (oldHovered) {
    hoveredEntity = null;
    hoverEntity(null);
    baseCanvas.style.cursor = 'default';
    hideTooltip();
    hoveredConns = null;
    needsHudRedraw = true;
  }
}

// --- Filtering ---

function filterTimeline() {
  const pinSt = getState();
  if (pinSt.pinnedEntity) {
    applyPinnedHighlight();
    return;
  }

  clearPinOverlay();
  const st = getState();

  if (st.lineageActive && st.lineageSet.size > 0) {
    applyLineageTimeline();
    return;
  }

  const hasActiveFilter = st.activeThread || st.activeAuthor || st.activeTag;
  const showPapers = st.showPapers;
  const mode = st.paperLayerMode || 'focus';
  const limit = PAPER_LAYER_LIMITS[mode] || 200;

  // Two-phase: filter then top-N selection
  const passing = [];
  for (const e of paperEntities) {
    if (!showPapers) { e.targetOpacity = 0; continue; }
    if (paperMatchesFilter(e.data, st)) {
      passing.push(e);
    }
  }
  passing.sort((a, b) => (b.inf || 0) - (a.inf || 0));
  const visibleIds = new Set(passing.slice(0, limit).map(e => e.data.id));

  for (const e of paperEntities) {
    if (!showPapers) { e.targetOpacity = 0; continue; }
    if (visibleIds.has(e.data.id)) {
      e.targetOpacity = hasActiveFilter && !paperMatchesFilter(e.data, st) ? 0.05 : 0.65;
    } else {
      e.targetOpacity = 0.04;
    }
  }

  for (const e of paperEntities) {
    addTween(e, 'opacity', e.targetOpacity, TWEEN_DURATION);
  }

  // Edge opacities
  for (const edge of edgeData) {
    if (!showPapers) { edge.opacity = 0; edge.highlighted = false; continue; }
    const sVisible = visibleIds.has(edge.source);
    const tVisible = visibleIds.has(edge.target);
    edge.opacity = (sVisible && tVisible) ? 0.12 : 0.01;
    edge.highlighted = false;
  }

  needsBaseRedraw = true;
  needsHudRedraw = true;
}

// --- Pinned highlight ---

function applyPinnedHighlight() {
  const st = getState();
  const pinned = st.pinnedEntity;
  if (!pinned) { pinnedConns = null; clearPinOverlay(); filterTimeline(); return; }

  const conns = buildPinnedConnections(pinned);
  pinnedConns = conns;

  for (const e of paperEntities) {
    const isPinned = pinned.type === 'paper' && e.data.id === pinned.id;
    const isConnected = conns.connectedPapers.has(e.data.id);
    e.opacity = isPinned ? 0.9 : isConnected ? 0.7 : 0.05;
    e.targetOpacity = e.opacity;
  }

  for (const edge of edgeData) {
    const direct = (pinned.type === 'paper') && (edge.source === pinned.id || edge.target === pinned.id);
    const touching = conns.connectedPapers.has(edge.source) && conns.connectedPapers.has(edge.target);
    edge.opacity = direct ? 0.5 : touching ? 0.08 : 0.01;
    edge.highlighted = direct;
  }

  buildPinOverlay(pinned, conns);
  needsBaseRedraw = true;
  needsHudRedraw = true;
}

// --- Pin overlay ---

function clearPinOverlay() {
  pinOverlayEdges = [];
  pinOverlayLabels = [];
  needsHudRedraw = true;
}

function buildPinOverlay(pinned, conns) {
  clearPinOverlay();
  const curX = xScale || xScaleOrig;

  let pinnedPos = null;
  if (pinned.type === 'paper') {
    const p = paperMap[pinned.id];
    if (p) pinnedPos = { x: curX(p._date), y: p._yPos, title: p.t, date: p._date, r: rScale(p.inf || 0) };
  }
  if (!pinnedPos) return;

  const labelEntries = [];
  labelEntries.push({ x: pinnedPos.x, y: pinnedPos.y, r: pinnedPos.r || 5, title: pinnedPos.title, isPinned: true, date: pinnedPos.date });

  const paperLabels = [];
  for (const e of paperEntities) {
    if (!conns.connectedPapers.has(e.data.id)) continue;
    if (pinned.type === 'paper' && e.data.id === pinned.id) continue;
    paperLabels.push({ x: curX(e.date), y: e.y, r: e.r, title: e.data.t || '', inf: e.inf, date: e.date });
  }
  paperLabels.sort((a, b) => b.inf - a.inf);
  for (const pl of paperLabels.slice(0, 10)) labelEntries.push({ ...pl, isPinned: false });

  const placed = [];
  const MIN_DIST_SQ = 35 * 35;
  for (const entry of labelEntries) {
    const tooClose = placed.some(p => {
      const dx = entry.x - p.x, dy = entry.y - p.y;
      return dx * dx + dy * dy < MIN_DIST_SQ;
    });
    if (tooClose && !entry.isPinned) continue;
    placed.push(entry);
    pinOverlayLabels.push(entry);
  }

  needsHudRedraw = true;
}

// --- Lineage ---

function onLineageChanged({ active, nodeSet }) {
  if (active && nodeSet.size > 0) {
    applyLineageTimeline();
  } else {
    filterTimeline();
  }
}

function applyLineageTimeline() {
  const st = getState();
  const lineageSet = st.lineageSet;
  const lineageEdgeSet = st.lineageEdgeSet;

  for (const e of paperEntities) {
    const inLineage = lineageSet.has(e.data.id);
    e.opacity = inLineage ? 0.9 : 0.04;
    e.targetOpacity = e.opacity;
  }

  for (const edge of edgeData) {
    const key = edge.source + '->' + edge.target;
    const keyR = edge.target + '->' + edge.source;
    const inLineage = lineageEdgeSet.has(key) || lineageEdgeSet.has(keyR);
    edge.opacity = inLineage ? 0.6 : 0.01;
    edge.highlighted = inLineage;
  }

  needsBaseRedraw = true;
  needsHudRedraw = true;
}

// --- Selection ---

function onSelectionChanged({ current }) {
  if (current) applyPinnedHighlight();
  needsBaseRedraw = true;
}

// --- Render loop ---

function renderLoop() {
  const tweenActive = tickTweens();
  if (tweenActive) needsBaseRedraw = true;

  if (needsBaseRedraw) {
    needsBaseRedraw = false;
    drawBase();
  }
  if (needsHudRedraw) {
    needsHudRedraw = false;
    drawHud();
  }
  rafId = requestAnimationFrame(renderLoop);
}

// --- Draw base canvas ---

function drawBase() {
  if (!baseCtx) return;
  const ctx = baseCtx;
  ctx.save();
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Translate to plot area
  ctx.translate(marginLeft, marginTop);

  const curX = xScale || xScaleOrig;

  // Lane separators
  ctx.strokeStyle = '#1a1a2a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= laneOrder.length; i++) {
    const y = topicLaneY0 + i * laneH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
  }

  // Edges
  for (const edge of edgeData) {
    if (edge.opacity < 0.005) continue;
    const x1 = curX(edge.sd);
    const x2 = curX(edge.td);
    ctx.strokeStyle = edge.highlighted
      ? hexWithAlpha('#88aaff', edge.opacity)
      : hexWithAlpha('#556', edge.opacity);
    ctx.lineWidth = edge.highlighted ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.moveTo(x1, edge.sy);
    ctx.lineTo(x2, edge.ty);
    ctx.stroke();

    if (edge.highlighted) {
      drawArrow(ctx, x1, edge.sy, x2, edge.ty, 5, hexWithAlpha('#88aaff', edge.opacity));
    }
  }

  // Papers as diamonds
  for (const e of paperEntities) {
    if (e.opacity < 0.01) continue;
    const px = curX(e.date);
    if (px < -50 || px > plotW + 50) continue;
    const fillColor = hexWithAlpha(e.color, e.opacity * 0.7);
    const strokeColor = hexWithAlpha(e.color, e.opacity);
    drawDiamond(ctx, px, e.y, e.r * 2, fillColor, strokeColor, 0.8);
  }

  // Labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
  for (const e of paperEntities) {
    if (!labelSet.has(e.data.id)) continue;
    if (e.opacity < 0.15) continue;
    const px = curX(e.date);
    if (px < -50 || px > plotW + 50) continue;
    ctx.fillStyle = hexWithAlpha('#bbb', e.opacity);
    const title = e.data.t || '';
    const label = title.length > 30 ? title.slice(0, 28) + '\u2026' : title;
    ctx.fillText(label, px, e.y + e.r + 4);
  }

  ctx.restore();
}

// --- Draw HUD canvas ---

function drawHud() {
  if (!hudCtx) return;
  const ctx = hudCtx;
  ctx.save();
  ctx.clearRect(0, 0, canvasW, canvasH);

  ctx.translate(marginLeft, marginTop);
  const curX = xScale || xScaleOrig;

  // Draw hover/pin connection highlights
  const conns = hoveredConns || pinnedConns;
  if (conns) {
    // Highlight connected nodes with white contour
    for (const e of paperEntities) {
      if (!conns.connectedPapers.has(e.data.id)) continue;
      const px = curX(e.date);
      if (px < -50 || px > plotW + 50) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const half = e.r;
      ctx.moveTo(px, e.y - half);
      ctx.lineTo(px + half, e.y);
      ctx.lineTo(px, e.y + half);
      ctx.lineTo(px - half, e.y);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Pin overlay labels
  if (pinOverlayLabels.length > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
    for (const l of pinOverlayLabels) {
      const px = curX(l.date);
      ctx.fillStyle = l.isPinned ? '#fff' : '#ccc';
      const title = l.title || '';
      const label = title.length > 35 ? title.slice(0, 33) + '\u2026' : title;
      ctx.fillText(label, px, l.y - (l.r || 5) - 3);
    }
  }

  ctx.restore();
}

export function onActivate() {
  needsBaseRedraw = true;
  needsHudRedraw = true;
}
