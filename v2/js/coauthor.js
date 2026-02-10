// coauthor.js — Canvas co-author network view
// Force-directed collaboration graph with author circles sized by influence,
// edge thickness by collaboration weight, hover highlighting, and filter integration.

import { THREAD_COLORS, AUTHOR_COLORS } from './constants.js';
import { getState, on, selectEntity, hoverEntity } from './state.js';
import { getCoauthor } from './data.js';
import {
  setupCanvas, observeResize, findNodeAtPoint, drawCircle, getVisibleNodes,
} from './canvas-utils.js';

let canvas = null;
let ctx = null;
let simulation = null;
let nodes = [];
let links = [];
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
let userInteracted = false;
let autoFitted = false;

// Pre-computed data
let rScale = null;
let linkWidthScale = null;
let top15Set = new Set();
let nodeEdgeIndex = {};

// Zoom behavior reference for programmatic transforms
let zoomBehavior = null;

export function init() {
  if (initialized) return;
  initialized = true;

  const container = document.getElementById('coauthor-view');
  if (!container) return;

  canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const coData = getCoauthor();
  if (!coData) return;

  // Build node array
  const nodeMap = {};
  for (const n of (coData.nodes || [])) {
    const node = {
      ...n,
      x: (Math.random() - 0.5) * 600 + 400,
      y: (Math.random() - 0.5) * 500 + 300,
    };
    nodes.push(node);
    nodeMap[n.id || n.name] = node;
  }

  // Build link array, adjacency index
  for (const e of (coData.edges || [])) {
    const src = nodeMap[e.source];
    const tgt = nodeMap[e.target];
    if (!src || !tgt) continue;
    const link = { ...e, source: src, target: tgt };
    links.push(link);

    const srcId = src.id || src.name;
    const tgtId = tgt.id || tgt.name;
    if (!nodeEdgeIndex[srcId]) nodeEdgeIndex[srcId] = new Set();
    nodeEdgeIndex[srcId].add(tgtId);
    if (!nodeEdgeIndex[tgtId]) nodeEdgeIndex[tgtId] = new Set();
    nodeEdgeIndex[tgtId].add(srcId);
  }

  // Compute scales
  let maxInf = 0;
  for (const n of nodes) {
    const inf = n.inf ?? n.influence ?? 0;
    if (inf > maxInf) maxInf = inf;
  }
  if (maxInf === 0) maxInf = 1;
  rScale = (inf) => Math.max(5, Math.sqrt(inf / maxInf) * 28);

  let maxWeight = 0;
  for (const l of links) {
    if ((l.weight || 1) > maxWeight) maxWeight = l.weight || 1;
  }
  if (maxWeight === 0) maxWeight = 1;
  linkWidthScale = (w) => Math.max(0.5, Math.min(4, (w / maxWeight) * 4));

  // Top 15 authors by influence for persistent labels
  const sorted = [...nodes].sort((a, b) => {
    return (b.inf ?? b.influence ?? 0) - (a.inf ?? a.influence ?? 0);
  });
  top15Set = new Set(sorted.slice(0, 15).map(n => n.id || n.name));

  // Setup canvas
  width = container.clientWidth || 1200;
  height = container.clientHeight || 700;
  ({ ctx } = setupCanvas(canvas, width, height));

  observeResize(container, canvas, (w, h, c) => {
    width = w;
    height = h;
    ctx = c;
    needsRedraw = true;
  });

  // Force simulation
  simulation = d3.forceSimulation(nodes)
    .alphaDecay(0.05)
    .force('charge', d3.forceManyBody().strength(-95))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX(width / 2).strength(0.045))
    .force('y', d3.forceY(height / 2).strength(0.045))
    .force('link', d3.forceLink(links).id(d => d.id || d.name)
      .distance(d => Math.max(26, 88 - (d.weight || 1) * 7))
      .strength(d => 0.2 + ((d.weight || 1) / maxWeight) * 0.3))
    .force('collide', d3.forceCollide().radius(d => {
      return rScale(d.inf ?? d.influence ?? 0) + 3;
    }))
    .on('tick', () => {
      needsRedraw = true;
      quadtreeDirty = true;
    })
    .on('end', () => {
      quadtreeDirty = true;
      if (!autoFitted && !userInteracted) {
        autoFitted = true;
        fitToViewport(true);
      }
    });

  // Backup auto-fit via timeout
  setTimeout(() => {
    if (!autoFitted && !userInteracted) {
      autoFitted = true;
      fitToViewport(true);
    }
  }, 600);

  // Zoom
  zoomBehavior = d3.zoom()
    .scaleExtent([0.2, 5])
    .on('start', () => { userInteracted = true; })
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

  // Drag
  setupDrag();

  // Pointer move — rAF-debounced quadtree hit-test
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
            hoverEntity({ type: 'author', id: found.id || found.name });
            canvas.style.cursor = 'pointer';
            showCoauthorTooltip(lastPointerX, lastPointerY, found);
          } else {
            hoverEntity(null);
            canvas.style.cursor = 'default';
            hideCoauthorTooltip();
          }
        }
      });
    }
  });

  // Click — select author
  canvas.addEventListener('click', (event) => {
    if (dragTarget) return;
    const [mx, my] = transform.invert([event.offsetX, event.offsetY]);
    ensureQuadtree();
    const found = findNodeAtPoint(quadtree, mx, my, 20 / transform.k);
    if (found) {
      selectEntity({ type: 'author', id: found.id || found.name });
    }
  });

  // Listen for state changes
  on('filters:changed', () => { needsRedraw = true; });
  on('selection:changed', () => { needsRedraw = true; });

  // Start render loop
  renderLoop();
}

function setupDrag() {
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
      userInteracted = true;
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

function fitToViewport(animate) {
  if (nodes.length < 2 || !zoomBehavior) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let count = 0;
  for (const n of nodes) {
    if (!isFinite(n.x) || !isFinite(n.y)) continue;
    count++;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  if (count < 2) return;

  const dx = Math.max(1, maxX - minX);
  const dy = Math.max(1, maxY - minY);
  const padding = 90;
  const scale = Math.min(2.4, Math.max(0.7,
    Math.min((width - padding) / dx, (height - padding) / dy)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const t = d3.zoomIdentity
    .translate(width / 2 - scale * cx, height / 2 - scale * cy)
    .scale(scale);

  if (animate) {
    d3.select(canvas).transition().duration(420).call(zoomBehavior.transform, t);
  } else {
    d3.select(canvas).call(zoomBehavior.transform, t);
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

// Get author color based on dominant thread or fallback palette
function getAuthorColor(node, index) {
  const thrs = node.thrs || node.threads;
  if (thrs) {
    let bestThread = null;
    let bestCount = 0;
    for (const tid in thrs) {
      if (thrs[tid] > bestCount) { bestCount = thrs[tid]; bestThread = tid; }
    }
    if (bestThread && THREAD_COLORS[bestThread]) return THREAD_COLORS[bestThread];
  }
  return AUTHOR_COLORS[index % AUTHOR_COLORS.length];
}

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
  const zoom = transform.k;
  const activeAuthor = st.activeAuthor;

  // Determine filter state
  const hasFilter = !!activeAuthor;
  let selectedInGraph = null;
  let connectedToSelected = null;

  if (hasFilter) {
    selectedInGraph = new Set();
    connectedToSelected = new Set();
    for (const n of nodes) {
      const nid = n.id || n.name;
      if (nid === activeAuthor) selectedInGraph.add(nid);
    }
    for (const authorId of selectedInGraph) {
      const connected = nodeEdgeIndex[authorId];
      if (connected) {
        for (const otherId of connected) connectedToSelected.add(otherId);
      }
    }
  }

  // Hovered node connections
  let hoveredConnections = null;
  if (hoveredNode) {
    const hid = hoveredNode.id || hoveredNode.name;
    hoveredConnections = new Set();
    hoveredConnections.add(hid);
    const connected = nodeEdgeIndex[hid];
    if (connected) {
      for (const otherId of connected) hoveredConnections.add(otherId);
    }
  }

  // Visible nodes for viewport culling
  const visibleNodes = getVisibleNodes(nodes, transform, w, h, 100);
  const visibleIdSet = new Set();
  for (const n of visibleNodes) visibleIdSet.add(n.id || n.name);

  // --- Draw links ---
  for (const link of links) {
    const srcId = link.source.id || link.source.name || '';
    const tgtId = link.target.id || link.target.name || '';

    if (!visibleIdSet.has(srcId) && !visibleIdSet.has(tgtId)) continue;

    const lw = linkWidthScale(link.weight || 1);

    let strokeColor = '#445566';
    let strokeAlpha = 0.2;

    if (hoveredConnections) {
      const hid = hoveredNode.id || hoveredNode.name;
      if (srcId === hid || tgtId === hid) {
        strokeColor = '#88aaff';
        strokeAlpha = 0.7;
      } else {
        strokeAlpha = 0.02;
      }
    } else if (hasFilter) {
      if (selectedInGraph.has(srcId) || selectedInGraph.has(tgtId)) {
        strokeAlpha = 0.6;
      } else {
        strokeAlpha = 0.02;
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;

  // --- Draw nodes ---
  for (let i = 0; i < visibleNodes.length; i++) {
    const n = visibleNodes[i];
    const nid = n.id || n.name;
    const inf = n.inf ?? n.influence ?? 0;
    const r = rScale(inf);
    const color = getAuthorColor(n, nodes.indexOf(n));
    const isHovered = n === hoveredNode;

    let alpha = 0.7;
    if (hoveredConnections) {
      alpha = hoveredConnections.has(nid) ? 1 : 0.08;
    } else if (hasFilter) {
      if (selectedInGraph.has(nid)) alpha = 1;
      else if (connectedToSelected.has(nid)) alpha = 0.8;
      else alpha = 0.06;
    }

    const strokeColor = isHovered ? '#fff' : color;
    const strokeWidth = isHovered ? 2 : 1;

    drawCircle(ctx, n.x, n.y, r,
      hexWithAlpha(color, alpha * 0.7),
      hexWithAlpha(strokeColor, alpha),
      strokeWidth);
  }

  // --- Draw labels ---
  if (zoom > 0.5) {
    const fontSize = Math.max(9, Math.min(12, 10 / zoom));
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const n of visibleNodes) {
      const nid = n.id || n.name;
      const inf = n.inf ?? n.influence ?? 0;
      const r = rScale(inf);
      const isTop15 = top15Set.has(nid);
      const isHovered = n === hoveredNode;

      let labelAlpha = 0;
      if (isHovered) {
        labelAlpha = 1;
      } else if (hoveredConnections) {
        if (hoveredConnections.has(nid)) labelAlpha = 1;
        else if (isTop15) labelAlpha = 0.1;
      } else if (hasFilter) {
        if (selectedInGraph.has(nid) || connectedToSelected.has(nid)) {
          labelAlpha = 1;
        } else if (isTop15) {
          labelAlpha = 0.1;
        }
      } else if (isTop15) {
        labelAlpha = 1;
      }

      if (labelAlpha <= 0) continue;

      ctx.fillStyle = hexWithAlpha('#ccc', labelAlpha);
      const label = n.author || nid;
      ctx.fillText(label, n.x, n.y + r + 5);
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

function showCoauthorTooltip(clientX, clientY, node) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  const name = node.id || node.name || '';
  const inf = node.inf ?? node.influence ?? 0;
  const pc = node.pc ?? 0;
  let html = '<strong>' + escapeHtml(name) + '</strong>';
  if (inf > 0) html += '<br>inf: ' + inf.toFixed(2);
  if (pc > 0) html += ' \u00b7 ' + pc + ' papers';
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

function hideCoauthorTooltip() {
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
