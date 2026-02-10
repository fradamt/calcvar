// network.js — Canvas citation network view
// Papers as primary nodes (circles colored by thread, sized by influence),
// citation edges, force-directed layout, viewport culling, quadtree hit-testing,
// and Shift+click BFS path finding.

import { THREAD_COLORS, NETWORK_ZOOM_EXTENT, PAPER_LAYER_LIMITS } from './constants.js';
import { getState, on, selectEntity, pinEntity, hoverEntity, setPath } from './state.js';
import { getCore, getGraph, getGraphIndexes, loadGraph } from './data.js';
import {
  setupCanvas, observeResize, findNodeAtPoint,
  drawCircle, drawDiamond, drawArrow, getVisibleNodes,
} from './canvas-utils.js';

let canvas = null;
let ctx = null;
let simulation = null;
let nodes = [];
let edges = [];
let transform = d3.zoomIdentity;
let width = 0;
let height = 0;
let needsRedraw = true;
let rafId = null;
let quadtree = null;
let quadtreeDirty = true;
let hoveredNode = null;
let dragTarget = null;
let initialized = false;

// Pre-sorted edge groups for batch rendering
let edgeGroups = {};

// Per-node adjacency for fast connection lookups
const nodeEdgeIndex = {};

// Influence-sorted nodes for label rendering
let labelCandidates = [];

// rScale for node sizing
let rScale = null;
let maxInfluence = 1;

// Edge type rendering config
const EDGE_STYLES = {
  paper_cites:   { color: 'rgba(140, 180, 230, 0.15)', width: 0.5, dash: null },
  paper_related: { color: 'rgba(140, 180, 230, 0.09)', width: 0.3, dash: [2, 2], minZoom: 0.6 },
  _default:      { color: 'rgba(80, 80, 120, 0.1)',     width: 0.4, dash: null },
};

export function init() {
  if (initialized) return;
  initialized = true;

  const container = document.getElementById('network-view');
  if (!container) return;

  canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const graph = getGraph();
  if (!graph?.unifiedGraph) return;

  // Build node array
  const nodeMap = {};
  for (const n of (graph.unifiedGraph.nodes || [])) {
    const node = {
      ...n,
      x: (Math.random() - 0.5) * 800 + 500,
      y: (Math.random() - 0.5) * 600 + 350,
    };
    nodes.push(node);
    nodeMap[String(n.id)] = node;
  }

  // Build edges, resolve endpoints, build adjacency index
  for (const e of (graph.unifiedGraph.edges || [])) {
    const srcKey = String(e.source);
    const tgtKey = String(e.target);
    const src = nodeMap[srcKey];
    const tgt = nodeMap[tgtKey];
    if (!src || !tgt) continue;

    const edge = { ...e, source: src, target: tgt };
    edges.push(edge);

    if (!nodeEdgeIndex[srcKey]) nodeEdgeIndex[srcKey] = [];
    nodeEdgeIndex[srcKey].push(edge);
    if (!nodeEdgeIndex[tgtKey]) nodeEdgeIndex[tgtKey] = [];
    nodeEdgeIndex[tgtKey].push(edge);
  }

  // Pre-sort edges into type groups for batch drawing
  rebuildEdgeGroups();

  // Compute scales
  maxInfluence = 0;
  for (const n of nodes) {
    if ((n.inf || 0) > maxInfluence) maxInfluence = n.inf;
  }
  if (maxInfluence === 0) maxInfluence = 1;
  rScale = (inf) => Math.max(4, Math.sqrt(inf / maxInfluence) * 16);

  // Pre-compute label candidates (top 30 nodes by influence)
  labelCandidates = nodes
    .filter(n => n.inf)
    .sort((a, b) => (b.inf || 0) - (a.inf || 0))
    .slice(0, 30);

  // Setup canvas
  width = container.clientWidth || 1200;
  height = container.clientHeight || 700;
  ({ ctx } = setupCanvas(canvas, width, height));

  // ResizeObserver
  observeResize(container, canvas, (w, h, c) => {
    width = w;
    height = h;
    ctx = c;
    needsRedraw = true;
  });

  // Force simulation
  simulation = d3.forceSimulation(nodes)
    .alphaDecay(0.05)
    .force('charge', d3.forceManyBody().strength(-30).distanceMax(300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('link', d3.forceLink(edges).id(d => String(d.id)).distance(60).strength(0.1))
    .force('collide', d3.forceCollide().radius(d => {
      return rScale(d.inf || 0) + 2;
    }))
    .on('tick', () => {
      needsRedraw = true;
      quadtreeDirty = true;
    })
    .on('end', () => {
      quadtreeDirty = true;
    });

  // Zoom
  const zoomBehavior = d3.zoom()
    .scaleExtent(NETWORK_ZOOM_EXTENT)
    .on('zoom', (event) => {
      transform = event.transform;
      needsRedraw = true;
    });

  d3.select(canvas)
    .call(zoomBehavior)
    .on('dblclick.zoom', null);

  // Prevent macOS swipe-back
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });
  canvas.style.touchAction = 'none';

  // Drag behavior
  setupDrag(zoomBehavior);

  // Pointer move — debounced quadtree hit-test
  let pointerRafPending = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

  canvas.addEventListener('pointermove', (event) => {
    lastPointerX = event.offsetX;
    lastPointerY = event.offsetY;
    if (!pointerRafPending && !dragTarget) {
      pointerRafPending = true;
      requestAnimationFrame(() => {
        pointerRafPending = false;
        if (dragTarget) return;
        const [mx, my] = transform.invert([lastPointerX, lastPointerY]);
        ensureQuadtree();
        const found = findNodeAtPoint(quadtree, mx, my, 20 / transform.k);
        if (found !== hoveredNode) {
          hoveredNode = found;
          needsRedraw = true;
          if (found) {
            hoverEntity({ type: 'paper', id: found.id });
            canvas.style.cursor = 'pointer';
            showNetworkTooltip(lastPointerX, lastPointerY, found);
          } else {
            hoverEntity(null);
            canvas.style.cursor = 'default';
            hideNetworkTooltip();
          }
        }
      });
    }
  });

  // Click — single-click pins, double-click opens detail, Shift+click path finding
  let clickTimer = null;
  let clickCount = 0;
  const DBLCLICK_DELAY = 220;

  canvas.addEventListener('click', (event) => {
    if (dragTarget) return;
    const [mx, my] = transform.invert([event.offsetX, event.offsetY]);
    ensureQuadtree();
    const found = findNodeAtPoint(quadtree, mx, my, 20 / transform.k);

    if (!found) {
      const st = getState();
      if (st.pinnedEntity || st.selectedEntity) {
        pinEntity(null);
        selectEntity(null);
        needsRedraw = true;
      }
      return;
    }

    if (event.shiftKey) {
      const st = getState();
      const startId = st.pinnedPaperId;
      if (startId && String(found.id) !== String(startId)) {
        const pathResult = bfsPath(String(startId), String(found.id), 8);
        if (pathResult) {
          setPath(true, startId, pathResult.nodeSet, pathResult.edgeSet);
        }
      }
      return;
    }

    clickCount++;
    if (clickCount === 1) {
      clickTimer = setTimeout(() => {
        pinEntity({ type: 'paper', id: found.id });
        needsRedraw = true;
        clickCount = 0;
      }, DBLCLICK_DELAY);
    } else if (clickCount === 2) {
      clearTimeout(clickTimer);
      clickCount = 0;
      selectEntity({ type: 'paper', id: found.id });
      needsRedraw = true;
    }
  });

  // Listen for state changes
  on('filters:changed', () => { needsRedraw = true; });
  on('selection:changed', () => { needsRedraw = true; });
  on('pin:changed', () => { needsRedraw = true; });
  on('content:changed', () => { needsRedraw = true; });
  on('path:changed', () => { needsRedraw = true; });
  on('lineage:changed', () => { needsRedraw = true; });

  // Start render loop
  renderLoop();
}

function setupDrag(zoomBehavior) {
  const drag = d3.drag()
    .container(canvas)
    .subject((event) => {
      const [mx, my] = transform.invert([event.x, event.y]);
      ensureQuadtree();
      const found = findNodeAtPoint(quadtree, mx, my, 20 / transform.k);
      if (found) {
        found.x = transform.applyX(found.x);
        found.y = transform.applyY(found.y);
        return found;
      }
      return null;
    })
    .on('start', (event) => {
      if (!event.subject) return;
      dragTarget = event.subject;
      simulation.alphaTarget(0.3).restart();
      const [wx, wy] = transform.invert([event.x, event.y]);
      dragTarget.fx = wx;
      dragTarget.fy = wy;
    })
    .on('drag', (event) => {
      if (!dragTarget) return;
      const [wx, wy] = transform.invert([event.x, event.y]);
      dragTarget.fx = wx;
      dragTarget.fy = wy;
    })
    .on('end', () => {
      if (!dragTarget) return;
      simulation.alphaTarget(0);
      dragTarget.fx = null;
      dragTarget.fy = null;
      dragTarget = null;
      quadtreeDirty = true;
    });

  d3.select(canvas).call(drag).call(zoomBehavior);
}

function rebuildEdgeGroups() {
  edgeGroups = {};
  for (const edge of edges) {
    const type = edge.type || '_default';
    if (!edgeGroups[type]) edgeGroups[type] = [];
    edgeGroups[type].push(edge);
  }
}

function ensureQuadtree() {
  if (quadtreeDirty || !quadtree) {
    quadtree = d3.quadtree()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(nodes);
    quadtreeDirty = false;
  }
}

function renderLoop() {
  if (needsRedraw) {
    needsRedraw = false;
    draw();
  }
  rafId = requestAnimationFrame(renderLoop);
}

// --- BFS path finding (max depth hops) ---
function bfsPath(startId, endId, maxDepth) {
  const visited = new Set();
  const parent = {};
  const parentEdge = {};
  const queue = [{ id: startId, depth: 0 }];
  visited.add(startId);

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (id === endId) {
      const nodeSet = new Set();
      const edgeSet = new Set();
      let cur = endId;
      while (cur) {
        nodeSet.add(cur);
        if (parentEdge[cur]) edgeSet.add(parentEdge[cur]);
        cur = parent[cur];
      }
      return { nodeSet, edgeSet };
    }
    if (depth >= maxDepth) continue;

    const neighbors = nodeEdgeIndex[id] || [];
    for (const edge of neighbors) {
      const srcId = String(edge.source.id ?? edge.source);
      const tgtId = String(edge.target.id ?? edge.target);
      const neighborId = srcId === id ? tgtId : srcId;
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        parent[neighborId] = id;
        parentEdge[neighborId] = edge;
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }
  }
  return null;
}

// --- Visibility helpers ---
function nodeMatchesFilter(node, st) {
  if (!st.showPapers) return false;
  if (st.activeThread && node.th && node.th !== st.activeThread) return false;
  if (st.minInfluence > 0 && (node.inf || 0) < st.minInfluence) return false;
  return true;
}

function getNodeRadius(node) {
  return rScale(node.inf || 0);
}

function getNodeColor(node) {
  return THREAD_COLORS[node.th] || '#4477aa';
}

// --- Main draw ---
function draw() {
  if (!ctx) return;
  const w = width;
  const h = height;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, w, h);

  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const st = getState();
  const selectedId = st.selectedEntity?.id;
  const pinnedId = st.pinnedEntity?.id;
  const zoom = transform.k;

  // Path highlight state
  const pathActive = st.pathMode;
  const pathNodeSet = st.pathSet;
  const pathEdgeSet = st.pathEdgeSet;

  // Lineage state
  const lineageActive = st.lineageActive;
  const lineageSet = st.lineageSet;

  // Get visible nodes for viewport culling
  const visibleNodes = getVisibleNodes(nodes, transform, w, h, 100);
  const visibleIdSet = new Set();
  for (const n of visibleNodes) visibleIdSet.add(String(n.id));

  // Determine connected set for hover/selection/pin highlighting
  const focusId = hoveredNode ? String(hoveredNode.id)
    : (selectedId ? String(selectedId)
    : (pinnedId ? String(pinnedId) : null));
  let connectedSet = null;
  if (focusId) {
    connectedSet = new Set();
    connectedSet.add(focusId);
    const adj = nodeEdgeIndex[focusId] || [];
    for (const edge of adj) {
      const srcId = String(edge.source.id ?? edge.source);
      const tgtId = String(edge.target.id ?? edge.target);
      connectedSet.add(srcId);
      connectedSet.add(tgtId);
    }
  }

  // --- Draw edges (batched by type) ---
  for (const [type, group] of Object.entries(edgeGroups)) {
    const style = EDGE_STYLES[type] || EDGE_STYLES._default;

    if (style.minZoom && zoom < style.minZoom) continue;

    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.dash) {
      ctx.setLineDash(style.dash);
    } else {
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    for (const edge of group) {
      const src = edge.source;
      const tgt = edge.target;
      const srcId = String(src.id ?? src);
      const tgtId = String(tgt.id ?? tgt);

      if (!visibleIdSet.has(srcId) && !visibleIdSet.has(tgtId)) continue;
      if (pathActive && !pathEdgeSet.has(edge)) continue;

      ctx.moveTo(src.x || 0, src.y || 0);
      ctx.lineTo(tgt.x || 0, tgt.y || 0);
    }
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // --- Draw highlighted edges for hovered/selected node ---
  if (focusId && !pathActive) {
    const adj = nodeEdgeIndex[focusId] || [];
    if (adj.length > 0 && adj.length < 200) {
      ctx.strokeStyle = 'rgba(136, 170, 255, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const edge of adj) {
        ctx.moveTo(edge.source.x || 0, edge.source.y || 0);
        ctx.lineTo(edge.target.x || 0, edge.target.y || 0);
      }
      ctx.stroke();

      const arrowEdges = adj.length > 50 ? adj.slice(0, 50) : adj;
      for (const edge of arrowEdges) {
        drawArrow(ctx,
          edge.source.x || 0, edge.source.y || 0,
          edge.target.x || 0, edge.target.y || 0,
          6, '#88aaff');
      }
    }
  }

  // --- Draw path edges highlighted ---
  if (pathActive && pathEdgeSet.size > 0) {
    ctx.strokeStyle = 'rgba(255, 200, 80, 0.7)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const edge of pathEdgeSet) {
      ctx.moveTo(edge.source?.x || 0, edge.source?.y || 0);
      ctx.lineTo(edge.target?.x || 0, edge.target?.y || 0);
    }
    ctx.stroke();

    for (const edge of pathEdgeSet) {
      drawArrow(ctx,
        edge.source?.x || 0, edge.source?.y || 0,
        edge.target?.x || 0, edge.target?.y || 0,
        7, '#ffc850');
    }
  }

  // --- Draw nodes ---
  for (const node of visibleNodes) {
    const color = getNodeColor(node);
    const nid = String(node.id);
    const isSelected = nid === String(selectedId);
    const isPinned = nid === String(pinnedId);
    const isHovered = node === hoveredNode;

    let alpha = 1;
    if (pathActive) {
      alpha = pathNodeSet.has(nid) ? 1 : 0.06;
    } else if (lineageActive) {
      alpha = lineageSet.has(nid) ? 1 : 0.06;
    } else if (connectedSet) {
      alpha = connectedSet.has(nid) ? 1 : 0.25;
    } else if (!nodeMatchesFilter(node, st)) {
      alpha = 0.05;
    } else {
      alpha = 0.7;
    }

    const isFocused = isSelected || isPinned || isHovered;
    const strokeColor = isFocused ? '#fff' : color;
    const strokeWidth = isSelected ? 2.5 : (isPinned ? 2.2 : (isHovered ? 2 : 0.5));

    const r = rScale(node.inf || 0);
    drawCircle(ctx, node.x, node.y, r,
      hexWithAlpha(color, alpha * 0.7),
      hexWithAlpha(strokeColor, alpha),
      strokeWidth);
  }

  // --- Draw labels for top nodes ---
  if (zoom > 0.4) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fontSize = Math.max(8, Math.min(11, 8 / zoom));
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;

    for (const node of labelCandidates) {
      if (!visibleIdSet.has(String(node.id))) continue;

      let labelAlpha = 0.8;
      if (connectedSet && !connectedSet.has(String(node.id))) labelAlpha = 0.1;
      if (pathActive && !pathNodeSet.has(String(node.id))) labelAlpha = 0;

      if (labelAlpha <= 0) continue;

      ctx.fillStyle = hexWithAlpha('#bbb', labelAlpha);
      const title = node.t || '';
      const label = title.length > 24 ? title.slice(0, 23) + '\u2026' : title;
      const r = rScale(node.inf || 0);
      ctx.fillText(label, node.x, node.y + r + 4);
    }

    // Hovered node label (always visible)
    if (hoveredNode && hoveredNode.t) {
      ctx.fillStyle = '#fff';
      const title = hoveredNode.t;
      const label = title.length > 40 ? title.slice(0, 39) + '\u2026' : title;
      const r = getNodeRadius(hoveredNode);
      ctx.fillText(label, hoveredNode.x, hoveredNode.y + r + 4);
    }
  }

  ctx.restore();
}

// Helper: apply alpha to a hex color
function hexWithAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  const alphaHex = a.toString(16).padStart(2, '0');
  if (hex.length === 4) {
    const r = hex[1], g = hex[2], b = hex[3];
    return '#' + r + r + g + g + b + b + alphaHex;
  }
  if (hex.length === 7) return hex + alphaHex;
  if (hex.length === 9) return hex.slice(0, 7) + alphaHex;
  return hex + alphaHex;
}

function showNetworkTooltip(clientX, clientY, node) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  let html = '<strong>' + escapeHtml(node.t || node.id || '') + '</strong>';
  if (node.th) {
    const core = getCore();
    const threadName = core?.threads?.[node.th]?.n || node.th;
    html += '<br>' + escapeHtml(threadName);
  }
  if (node.inf) html += '<br>inf: ' + node.inf.toFixed(2);
  tip.innerHTML = html;
  tip.style.display = 'block';
  const rect = canvas.getBoundingClientRect();
  let x = rect.left + clientX + 14;
  let y = rect.top + clientY - 10;
  if (x + tip.offsetWidth > window.innerWidth - 10) x = rect.left + clientX - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > window.innerHeight - 10) y = window.innerHeight - tip.offsetHeight - 10;
  if (y < 5) y = 5;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideNetworkTooltip() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.style.display = 'none';
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text || '';
  return el.innerHTML;
}

export function onActivate() {
  needsRedraw = true;
  if (simulation) simulation.alpha(0.1).restart();
}
