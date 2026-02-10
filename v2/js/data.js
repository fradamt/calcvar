// data.js — Progressive data loading + index building

const cache = {};
const BASE = import.meta.url.includes('/js/')
  ? new URL('..', import.meta.url).href
  : './';
const DATA_DIR = BASE + 'data/';

async function fetchJSON(filename) {
  if (cache[filename]) return cache[filename];
  const resp = await fetch(DATA_DIR + filename);
  if (!resp.ok) throw new Error(`Failed to load ${filename}: ${resp.status}`);
  const data = await resp.json();
  cache[filename] = data;
  return data;
}

// --- Core data (papers, threads, authors, graph) ---
let coreData = null;
let coreIndexes = null;

export async function loadCore() {
  if (coreData) return coreData;
  coreData = await fetchJSON('core.json');
  coreIndexes = buildCoreIndexes(coreData);
  return coreData;
}

export function getCore() { return coreData; }
export function getCoreIndexes() { return coreIndexes; }

function buildCoreIndexes(data) {
  const paperEdgeIndex = {};
  const tagToPapers = {};

  // Build paper edge adjacency from graph
  for (const e of (data.graph?.edges || [])) {
    const s = String(e.source), t = String(e.target);
    if (!paperEdgeIndex[s]) paperEdgeIndex[s] = new Set();
    if (!paperEdgeIndex[t]) paperEdgeIndex[t] = new Set();
    paperEdgeIndex[s].add(String(e.target));
    paperEdgeIndex[t].add(String(e.source));
  }

  // Build tag -> paper index
  for (const paper of Object.values(data.papers || {})) {
    for (const tag of (paper.tags || [])) {
      if (!tagToPapers[tag]) tagToPapers[tag] = new Set();
      tagToPapers[tag].add(paper.id);
    }
  }

  return { paperEdgeIndex, tagToPapers };
}


// --- Paper data (extended) ---
let paperData = null;

export async function loadPapers() {
  if (paperData) return paperData;
  paperData = await fetchJSON('papers.json');
  return paperData;
}

export function getPapers() { return paperData; }


// --- Unified graph data (for network view) ---
let graphData = null;
let graphIndexes = null;

export async function loadGraph() {
  if (graphData) return graphData;
  graphData = await fetchJSON('graph.json');
  graphIndexes = buildGraphIndexes(graphData);
  return graphData;
}

export function getGraph() { return graphData; }
export function getGraphIndexes() { return graphIndexes; }

function buildGraphIndexes(data) {
  // Per-node adjacency sets for viewport culling
  const nodeAdjacency = {};
  for (const edge of (data.unifiedGraph?.edges || [])) {
    const s = String(edge.source), t = String(edge.target);
    if (!nodeAdjacency[s]) nodeAdjacency[s] = [];
    nodeAdjacency[s].push(edge);
    if (!nodeAdjacency[t]) nodeAdjacency[t] = [];
    nodeAdjacency[t].push(edge);
  }

  // Sort edges by type for batch rendering
  const edgesByType = {};
  for (const edge of (data.unifiedGraph?.edges || [])) {
    const type = edge.type || 'unknown';
    if (!edgesByType[type]) edgesByType[type] = [];
    edgesByType[type].push(edge);
  }

  return { nodeAdjacency, edgesByType };
}


// --- Co-author graph ---
let coauthorData = null;

export async function loadCoauthor() {
  if (coauthorData) return coauthorData;
  coauthorData = await fetchJSON('coauthor.json');
  return coauthorData;
}

export function getCoauthor() { return coauthorData; }


// --- Utility: check if a dataset is loaded ---
export function isLoaded(name) {
  return cache[name + '.json'] !== undefined;
}
