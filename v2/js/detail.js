// detail.js — Right panel: paper/author/thread detail

import { THREAD_COLORS, THREAD_NAMES, AUTHOR_COLORS } from './constants.js';
import { getState, on, selectEntity, setFilters, setDetailOpen, setLineage } from './state.js';
import { getCore, getCoreIndexes, getPapers, loadPapers } from './data.js';

export function init() {
  on('selection:changed', ({ current }) => {
    if (current) show(current);
  });
  on('detail:changed', ({ open }) => {
    if (!open) {
      const panel = document.getElementById('detail-panel');
      if (panel) panel.classList.remove('open');
    }
  });
}

export function show({ type, id }) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');
  if (!panel || !content) return;

  panel.classList.add('open');
  content.innerHTML = '';

  switch (type) {
    case 'paper': showPaperDetail(content, id); break;
    case 'author': showAuthorDetail(content, id); break;
    case 'thread': showThreadDetail(content, id); break;
    default: content.innerHTML = `<p style="color:#888">Unknown entity type: ${type}</p>`;
  }
}

function h(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// --- PAPER DETAIL ---
function showPaperDetail(el, id) {
  const core = getCore();
  const p = core?.papers?.[id];
  if (!p) {
    // Try extended papers
    loadPapers().then(() => {
      const papers = getPapers();
      const extended = papers?.papers?.[id];
      if (extended) renderPaperDetail(el, extended, id);
      else el.innerHTML = `<p style="color:#888">Paper not found</p>`;
    });
    return;
  }
  renderPaperDetail(el, p, id);
}

function renderPaperDetail(el, p, id) {
  const core = getCore();
  const pid = String(p.id || id).trim();

  // Build URL from DOI or arXiv
  const url = p.url || (p.doi ? 'https://doi.org/' + p.doi : (p.arxiv_id ? 'https://arxiv.org/abs/' + p.arxiv_id : ''));

  const threadColor = THREAD_COLORS[p.th] || '#666';
  const threadName = THREAD_NAMES[p.th] || p.th || 'Unknown';

  let html = `<h2>${h(p.t || 'Untitled')}</h2>`;
  html += `<div class="meta">`;
  if (p.a?.length > 0) {
    html += p.a.map(name =>
      `<span style="cursor:pointer;color:#7788cc" data-author="${h(name)}">${h(name)}</span>`
    ).join(', ');
    html += ' \u00b7 ';
  }
  const year = p.y || (p.d ? p.d.slice(0, 4) : '?');
  html += year;
  html += ' \u00b7 ';
  if (url) html += `<a href="${h(url)}" target="_blank">Open paper \u2192</a>`;
  else html += 'No canonical URL';
  html += `</div>`;

  // Stats
  html += `<div class="detail-stat"><span class="label">Subfield</span><span class="value" style="color:${threadColor};cursor:pointer" data-thread="${h(p.th || '')}">${h(threadName)}</span></div>`;
  html += `<div class="detail-stat"><span class="label">Influence</span><span class="value">${(p.inf || 0).toFixed(3)}</span></div>`;
  html += `<div class="detail-stat"><span class="label">Citations</span><span class="value">${Number(p.cc || p.c || 0).toLocaleString()}</span></div>`;
  if (p.doi) html += `<div class="detail-stat"><span class="label">DOI</span><span class="value"><a href="https://doi.org/${h(p.doi)}" target="_blank">${h(p.doi)}</a></span></div>`;
  if (p.arxiv_id) html += `<div class="detail-stat"><span class="label">arXiv</span><span class="value"><a href="https://arxiv.org/abs/${h(p.arxiv_id)}" target="_blank">${h(p.arxiv_id)}</a></span></div>`;

  // Action buttons
  const st = getState();
  const lineageActive = st.lineageActive && st.lineageSet.has(pid);
  html += `<div style="margin:10px 0 6px;display:flex;gap:6px">`;
  html += `<button class="action-btn" id="lineage-btn" style="border-color:${lineageActive ? '#88aaff' : '#5566aa'};color:${lineageActive ? '#88aaff' : '#8899cc'}">${lineageActive ? 'Clear Lineage (' + st.lineageSet.size + ')' : 'Trace Citations'}</button>`;
  html += `<button class="action-btn" id="similar-btn" style="border-color:#44aa88;color:#66bbaa">Find Similar</button>`;
  html += `</div>`;

  // Tags
  if (p.tags?.length > 0 || p.tg?.length > 0) {
    const tags = p.tags || p.tg || [];
    html += `<div style="margin:8px 0"><strong style="font-size:11px;color:#666">Tags</strong> `;
    html += tags.slice(0, 8).map(t => `<span class="tag-badge" style="display:inline-block;font-size:10px;margin:2px 3px 2px 0;padding:1px 6px;background:#1a2a3a;border:1px solid #3a4f6c;border-radius:3px;color:#9cc8ff">${h(t)}</span>`).join(' ');
    html += `</div>`;
  }

  // References
  if (p.ref?.length > 0) {
    html += `<div class="detail-refs"><h4>References (${p.ref.length})</h4>`;
    for (const refId of p.ref.slice(0, 10)) {
      const refPaper = core?.papers?.[refId];
      const refTitle = refPaper ? refPaper.t : `Paper ${refId}`;
      const refYear = refPaper?.d ? refPaper.d.slice(0, 4) : '';
      html += `<div class="ref-item"><a data-paper="${h(refId)}">${h(refTitle)}</a>${refYear ? ` <span style="color:#666;font-size:10px">(${refYear})</span>` : ''}</div>`;
    }
    if (p.ref.length > 10) html += `<div style="color:#666;font-size:10px">+${p.ref.length - 10} more</div>`;
    html += `</div>`;
  }

  // Cited by (look up from core graph)
  const indexes = getCoreIndexes();
  const adj = indexes?.paperEdgeIndex?.[pid];
  if (adj && adj.size > 0) {
    const citedBy = Array.from(adj)
      .filter(otherId => otherId !== pid)
      .map(otherId => core?.papers?.[otherId])
      .filter(Boolean)
      .sort((a, b) => (b.inf || 0) - (a.inf || 0));

    if (citedBy.length > 0) {
      html += `<div class="detail-refs"><h4>Connected Papers (${citedBy.length})</h4>`;
      for (const op of citedBy.slice(0, 10)) {
        const label = (op.t || 'Untitled').slice(0, 60) + ((op.t || '').length > 60 ? '\u2026' : '');
        const opYear = op.d ? op.d.slice(0, 4) : '';
        html += `<div class="ref-item"><a data-paper="${h(op.id)}">${h(label)}</a>${opYear ? ` <span style="color:#666;font-size:10px">(${opYear})</span>` : ''}</div>`;
      }
      if (citedBy.length > 10) html += `<div style="color:#666;font-size:10px">+${citedBy.length - 10} more</div>`;
      html += `</div>`;
    }
  }

  el.innerHTML = html;
  wireUpDetailLinks(el);
  wireUpActionButtons(el, pid, core);
}

// --- AUTHOR DETAIL ---
function showAuthorDetail(el, id) {
  const core = getCore();
  const a = core?.authors?.[id];
  if (!a) {
    el.innerHTML = `<p style="color:#888">Author "${h(id)}" not found</p>`;
    return;
  }

  const authorList = Object.values(core.authors || {}).sort((x, y) => (y.inf || 0) - (x.inf || 0));
  const rank = authorList.findIndex(x => (x.u || '') === id);
  const color = rank >= 0 && rank < 15 ? AUTHOR_COLORS[rank] : '#667';

  let html = `<h2 style="color:${color}">${h(a.u || id)}</h2>`;
  html += `<div class="meta">Researcher</div>`;

  html += `<div class="detail-stat"><span class="label">Papers</span><span class="value">${a.pc || 0}</span></div>`;
  html += `<div class="detail-stat"><span class="label">Total Citations</span><span class="value">${(a.cc || 0).toLocaleString()}</span></div>`;
  html += `<div class="detail-stat"><span class="label">Influence Score</span><span class="value">${(a.inf || 0).toFixed(3)}</span></div>`;
  if (a.yrs?.length > 0) {
    html += `<div class="detail-stat"><span class="label">Active Years</span><span class="value">${a.yrs[0]}\u2013${a.yrs[a.yrs.length - 1]}</span></div>`;
  }

  // Thread distribution bars
  if (a.ths && Object.keys(a.ths).length > 0) {
    html += `<div style="margin-top:12px"><strong style="font-size:11px;color:#888">Subfield Distribution</strong><div style="margin-top:6px">`;
    const total = Object.values(a.ths).reduce((s, v) => s + v, 0) || 1;
    const sorted = Object.entries(a.ths).sort((x, y) => y[1] - x[1]);
    for (const [tid, count] of sorted.slice(0, 6)) {
      const pct = Math.round(count / total * 100);
      const tColor = THREAD_COLORS[tid] || '#555';
      html += `<div class="thread-bar-row">
        <span class="thread-bar-label" style="color:${tColor}">${THREAD_NAMES[tid] || tid}</span>
        <span class="thread-bar-track"><span class="thread-bar-fill" style="width:${pct}%;background:${tColor}"></span></span>
        <span class="thread-bar-pct">${pct}%</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  // Top papers
  if (a.tops?.length > 0) {
    html += `<div class="detail-refs" style="margin-top:12px"><h4>Top Papers</h4>`;
    for (const pid of a.tops) {
      const paper = core.papers?.[pid];
      if (paper) {
        const yearStr = paper.d ? paper.d.slice(0, 4) : '';
        html += `<div class="ref-item"><a data-paper="${h(pid)}">${h(paper.t)}</a> <span style="color:#666;font-size:10px">(${yearStr}${yearStr ? ', ' : ''}inf ${(paper.inf || 0).toFixed(2)})</span></div>`;
      }
    }
    html += `</div>`;
  }

  // Co-researchers
  if (a.co && Object.keys(a.co).length > 0) {
    html += `<div style="margin-top:12px"><strong style="font-size:11px;color:#888">Co-Authors</strong><div style="margin-top:6px">`;
    const coEntries = Object.entries(a.co).sort((x, y) => y[1] - x[1]);
    for (const [coName, coCount] of coEntries.slice(0, 20)) {
      const coRank = authorList.findIndex(x => (x.u || '') === coName);
      const coColor = coRank >= 0 && coRank < 15 ? AUTHOR_COLORS[coRank] : '#667';
      html += `<span style="display:inline-block;font-size:11px;margin:2px 4px 2px 0;padding:1px 6px;background:${coColor}22;border:1px solid ${coColor}44;border-radius:3px;color:${coColor};cursor:pointer" data-author="${h(coName)}">${h(coName)} <span style="color:#666;font-size:9px">(${coCount})</span></span>`;
    }
    html += `</div></div>`;
  }

  el.innerHTML = html;
  wireUpDetailLinks(el);
}

// --- THREAD DETAIL ---
function showThreadDetail(el, id) {
  const core = getCore();
  const th = core?.threads?.[id];
  if (!th) {
    el.innerHTML = `<p style="color:#888">Subfield "${h(id)}" not found</p>`;
    return;
  }

  const color = THREAD_COLORS[id] || '#666';
  let html = `<h2 style="color:${color}">${THREAD_NAMES[id] || id}</h2>`;
  if (th.d) html += `<div class="meta">${h(th.d)}</div>`;

  html += `<div class="thread-stat-grid">
    <div class="thread-stat-box"><div class="tsb-val">${th.tc || 0}</div><div class="tsb-lbl">Papers</div></div>
    <div class="thread-stat-box"><div class="tsb-val">${th.ac || 0}</div><div class="tsb-lbl">Authors</div></div>
    <div class="thread-stat-box"><div class="tsb-val">${th.py || '\u2014'}</div><div class="tsb-lbl">Peak Year</div></div>
  </div>`;

  // Key authors
  if (th.ka && Object.keys(th.ka).length > 0) {
    html += `<div style="margin:8px 0"><strong style="font-size:11px;color:#888">Key Authors</strong><div style="margin-top:4px">`;
    for (const [name, count] of Object.entries(th.ka)) {
      html += `<span style="display:inline-block;font-size:11px;margin:2px 4px 2px 0;padding:1px 6px;background:#33334422;border:1px solid #44445544;border-radius:3px;color:#8899cc;cursor:pointer" data-author="${h(name)}">${h(name)} <span style="color:#666;font-size:9px">(${count})</span></span>`;
    }
    html += `</div></div>`;
  }

  // Key papers
  if (th.tops?.length > 0) {
    html += `<div class="detail-refs"><h4>Key Papers</h4>`;
    for (const pid of th.tops.slice(0, 15)) {
      const paper = core.papers?.[pid];
      if (paper) {
        const yearStr = paper.d ? paper.d.slice(0, 4) : '';
        html += `<div class="ref-item"><a data-paper="${h(pid)}">${h(paper.t)}</a> <span style="color:#666;font-size:10px">(${yearStr})</span></div>`;
      }
    }
    html += `</div>`;
  }

  el.innerHTML = html;
  wireUpDetailLinks(el);
}

// --- WIRE UP ALL CLICKABLE LINKS ---
function wireUpDetailLinks(container) {
  for (const tag of container.querySelectorAll('[data-paper]')) {
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      selectEntity({ type: 'paper', id: tag.dataset.paper });
    });
  }
  for (const tag of container.querySelectorAll('[data-author]')) {
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      selectEntity({ type: 'author', id: tag.dataset.author });
    });
  }
  for (const tag of container.querySelectorAll('[data-thread]')) {
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      setFilters({ activeThread: tag.dataset.thread });
    });
  }
}

function wireUpActionButtons(container, paperId, core) {
  const lineageBtn = container.querySelector('#lineage-btn');
  if (lineageBtn) {
    lineageBtn.addEventListener('click', () => {
      const st = getState();
      if (st.lineageActive && st.lineageSet.has(paperId)) {
        setLineage(false, new Set(), new Set());
      } else {
        traceLineage(paperId, core);
      }
    });
  }
  const similarBtn = container.querySelector('#similar-btn');
  if (similarBtn) {
    similarBtn.addEventListener('click', () => {
      findSimilar(paperId, core, container);
    });
  }
}

function traceLineage(paperId, core) {
  const papers = core?.papers || {};
  const p = papers[paperId];
  if (!p) return;

  const nodeSet = new Set([paperId]);
  const edgeSet = new Set();

  // BFS through references, capped at 2 hops
  const upQueue = [{ id: paperId, depth: 0 }];
  const upVisited = new Set([paperId]);
  while (upQueue.length > 0) {
    const cur = upQueue.shift();
    if (cur.depth >= 2) continue;
    const cp = papers[cur.id];
    if (!cp) continue;
    for (const ref of (cp.ref || [])) {
      const refId = String(ref);
      nodeSet.add(refId);
      edgeSet.add(cur.id + '->' + refId);
      if (!upVisited.has(refId)) {
        upVisited.add(refId);
        upQueue.push({ id: refId, depth: cur.depth + 1 });
      }
    }
  }

  // BFS through citations (incoming), capped at 2 hops
  const indexes = getCoreIndexes();
  const downQueue = [{ id: paperId, depth: 0 }];
  const downVisited = new Set([paperId]);
  while (downQueue.length > 0) {
    const cur = downQueue.shift();
    if (cur.depth >= 2) continue;
    const adj = indexes?.paperEdgeIndex?.[cur.id];
    if (!adj) continue;
    for (const otherId of adj) {
      if (otherId === cur.id) continue;
      nodeSet.add(otherId);
      edgeSet.add(otherId + '->' + cur.id);
      if (!downVisited.has(otherId)) {
        downVisited.add(otherId);
        downQueue.push({ id: otherId, depth: cur.depth + 1 });
      }
    }
  }

  setLineage(true, nodeSet, edgeSet);
}

function findSimilar(paperId, core, container) {
  const papers = core?.papers || {};
  const p = papers[paperId];
  if (!p) return;

  const pTags = new Set(p.tags || []);
  const pAuthors = new Set(p.a || []);
  const scores = [];

  for (const [oid, other] of Object.entries(papers)) {
    if (oid === paperId) continue;
    let score = 0;

    // Thread match
    if (p.th && other.th === p.th) score += 1;
    // Tag overlap
    const oTags = new Set(other.tags || []);
    for (const tag of pTags) { if (oTags.has(tag)) score += 0.5; }
    // Author overlap
    const oAuthors = new Set(other.a || []);
    for (const author of pAuthors) { if (oAuthors.has(author)) score += 1; }
    // Influence boost
    score += Math.min(0.3, (other.inf || 0) / 3);

    if (score >= 1.5) scores.push({ id: oid, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, 10);

  let listEl = container.querySelector('#similar-list');
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.id = 'similar-list';
    listEl.className = 'detail-refs';
    container.appendChild(listEl);
  }

  if (top.length === 0) {
    listEl.innerHTML = '<h4>Similar Papers</h4><p style="color:#888;font-size:11px">No similar papers found</p>';
    return;
  }

  let html = `<h4>Similar Papers (${top.length})</h4>`;
  for (const { id, score } of top) {
    const sp = papers[id];
    if (!sp) continue;
    const yearStr = sp.d ? sp.d.slice(0, 4) : '';
    html += `<div class="ref-item"><a data-paper="${h(id)}">${h(sp.t)}</a> <span style="color:#666;font-size:10px">(${yearStr}${yearStr ? ', ' : ''}score ${score.toFixed(1)})</span></div>`;
  }
  listEl.innerHTML = html;
  wireUpDetailLinks(listEl);
}
