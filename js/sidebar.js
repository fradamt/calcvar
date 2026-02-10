// sidebar.js — Thread chips, author list, paper filters, influence slider

import { THREAD_COLORS, THREAD_ORDER, THREAD_NAMES, AUTHOR_COLORS } from './constants.js';
import {
  getState, on, setFilters, selectEntity, pinEntity, setContentToggle,
} from './state.js';
import { getCore, loadPapers, getPapers } from './data.js';

let coreData = null;
let maxDataInf = 1;
let defaultSliderPct = 0;
let defaultInfluenceThreshold = 0;

export function init(core) {
  coreData = core;
  computeInfluenceDefaults();
  buildThreadChips();
  buildAuthorList();
  buildTagChips();
  setupInfluenceSlider();
  setupAuthorSort();
  setupPaperFilters();

  on('filters:changed', () => {
    updateThreadChipsActive();
    updateAuthorListActive();
    updateTagChipsActive();
    updateBreadcrumbs();
  });
  on('reset', () => {
    updateThreadChipsActive();
    updateAuthorListActive();
    updateBreadcrumbs();
    const slider = document.getElementById('inf-slider');
    const label = document.getElementById('inf-slider-label');
    if (slider) slider.value = defaultSliderPct;
    if (label) label.textContent = sliderLabel(defaultSliderPct);
  });
  // Load papers eagerly for sidebar list
  loadPapers().then(() => {
    renderPaperSidebarList();
    populatePaperTagDropdown();
  });
}

function computeInfluenceDefaults() {
  const papers = Object.values(coreData?.papers || {});
  if (papers.length === 0) return;
  const infs = papers.map(p => p.inf || 0);
  maxDataInf = Math.max(...infs, 0.001);
  // Default: show all papers
  defaultInfluenceThreshold = 0;
  defaultSliderPct = 0;
}

function sliderLabel(pct) {
  return pct === 0 ? '0%' : pct + '%';
}

function buildThreadChips() {
  const legend = document.getElementById('thread-legend');
  if (!legend) return;
  legend.innerHTML = '';

  for (const tid of THREAD_ORDER) {
    const th = coreData.threads?.[tid];
    if (!th) continue;
    const color = THREAD_COLORS[tid] || '#666';
    const chip = document.createElement('div');
    chip.className = 'thread-chip';
    chip.dataset.thread = tid;
    chip.style.background = color + '33';
    chip.style.border = '1px solid ' + color + '66';
    chip.style.color = color;
    chip.title = (THREAD_NAMES[tid] || tid) + ' (' + (th.tc || 0) + ' papers)';

    // Activity status based on recent papers
    const qc = th.yc || [];
    let recentCount = 0;
    if (Array.isArray(qc) && qc.length > 0) {
      if (typeof qc[0] === 'object' && qc[0] !== null) {
        recentCount = qc.reduce((sum, d) => sum + (d.y >= 2020 ? d.c : 0), 0);
      } else {
        recentCount = qc.slice(-4).reduce((a, b) => a + b, 0);
      }
    }
    const status = recentCount >= 5 ? 'active' : recentCount >= 2 ? 'moderate' : 'dormant';

    // Sparkline
    let sparkHtml = '';
    if (qc.length > 0) {
      const sparkW = 80, sparkH = 16;
      let values;
      if (typeof qc[0] === 'object' && qc[0] !== null) {
        values = qc.map(d => d.c || 0);
      } else {
        values = qc;
      }
      const max = Math.max(...values, 1);
      const stepX = sparkW / Math.max(1, values.length - 1);
      const points = values.map((v, i) => {
        const x = i * stepX;
        const y = sparkH - (v / max) * (sparkH - 2) - 1;
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      const areaPoints = points.join(' ') + ' ' + sparkW.toFixed(1) + ',' + sparkH + ' 0,' + sparkH;
      sparkHtml = `<span class="sparkline-wrap"><svg width="${sparkW}" height="${sparkH}" viewBox="0 0 ${sparkW} ${sparkH}"><polygon points="${areaPoints}" fill="${color}" opacity="0.3"/><polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1" opacity="0.8"/></svg></span>`;
    }

    chip.innerHTML = `
      <span class="status-dot ${status}" title="${recentCount} papers recently (${status})"></span>
      <span class="thread-label">${THREAD_NAMES[tid] || tid}</span>
      <span class="thread-count">${th.tc || 0}</span>
      ${sparkHtml}
    `;

    // Single click: toggle thread filter; double click: open thread detail
    let clickTimer = null;
    chip.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const st = getState();
        if (st.activeThread === tid) {
          setFilters({ activeThread: null });
        } else {
          setFilters({ activeThread: tid });
        }
      }, 250);
    });
    chip.addEventListener('dblclick', () => {
      setFilters({ activeThread: tid });
      selectEntity({ type: 'thread', id: tid });
    });

    legend.appendChild(chip);
  }
}

function updateThreadChipsActive() {
  const st = getState();
  for (const chip of document.querySelectorAll('.thread-chip')) {
    chip.classList.toggle('active', chip.dataset.thread === st.activeThread);
  }
}

function buildAuthorList(sortKey) {
  const container = document.getElementById('author-list');
  if (!container || !coreData) return;
  container.innerHTML = '';

  const key = sortKey || 'inf';
  const authors = Object.values(coreData.authors || {});
  authors.sort((a, b) => (b[key] || 0) - (a[key] || 0));

  const st = getState();

  const top = authors.slice(0, 25);
  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    const item = document.createElement('div');
    item.className = 'author-item';
    item.dataset.author = a.u;
    const color = AUTHOR_COLORS[i] || '#555';
    const valLabel = key === 'inf' ? (a.inf || 0).toFixed(1)
      : key === 'pc' ? (a.pc || 0)
      : key === 'cc' ? (a.cc || 0)
      : (a[key] || 0);
    item.innerHTML = `
      <span class="author-dot" style="background:${color}"></span>
      <span class="author-name">${escText(a.u)}</span>
      <span class="author-count">${valLabel}</span>
    `;

    let clickTimer = null;
    item.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const st2 = getState();
        if (st2.activeAuthor === a.u) {
          setFilters({ activeAuthor: null });
        } else {
          setFilters({ activeAuthor: a.u });
        }
      }, 250);
    });
    item.addEventListener('dblclick', () => {
      setFilters({ activeAuthor: a.u });
      selectEntity({ type: 'author', id: a.u });
    });
    if (st.activeAuthor === a.u) item.classList.add('active');
    container.appendChild(item);
  }
}

function updateAuthorListActive() {
  const st = getState();
  for (const item of document.querySelectorAll('.author-item')) {
    if (item.dataset.author) {
      item.classList.toggle('active', item.dataset.author === st.activeAuthor);
    }
  }
}

function updateTagChipsActive() {
  const st = getState();
  for (const chip of document.querySelectorAll('.tag-chip')) {
    chip.classList.toggle('active', chip.dataset.tag === st.activeTag);
  }
}

function buildTagChips() {
  const container = document.getElementById('tag-chips');
  if (!container || !coreData) return;
  container.innerHTML = '';

  const counts = {};
  for (const p of Object.values(coreData.papers || {})) {
    for (const tag of (p.tags || [])) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sorted.slice(0, 15)) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.tag = tag;
    chip.innerHTML = `${escText(tag)} <span class="chip-count">${count}</span>`;
    chip.title = tag + ' (' + count + ' papers)';
    chip.addEventListener('click', () => {
      const st = getState();
      if (st.activeTag === tag) {
        setFilters({ activeTag: null });
      } else {
        setFilters({ activeTag: tag });
      }
    });
    container.appendChild(chip);
  }
}

function setupInfluenceSlider() {
  const slider = document.getElementById('inf-slider');
  const label = document.getElementById('inf-slider-label');
  if (!slider) return;

  slider.value = defaultSliderPct;
  if (label) label.textContent = sliderLabel(defaultSliderPct);
  setFilters({ minInfluence: defaultInfluenceThreshold });

  slider.addEventListener('input', () => {
    const pct = Number(slider.value);
    const threshold = pct / 100 * maxDataInf;
    if (label) label.textContent = sliderLabel(pct);
    setFilters({ minInfluence: threshold });
  });
}

function setupAuthorSort() {
  const sortEl = document.getElementById('author-sort');
  if (sortEl) {
    sortEl.addEventListener('change', () => buildAuthorList(sortEl.value));
  }
}

function setupPaperFilters() {
  const minCites = document.getElementById('paper-min-cites');
  const minCitesLabel = document.getElementById('paper-min-cites-label');
  if (minCites) {
    minCites.addEventListener('input', () => {
      if (minCitesLabel) minCitesLabel.textContent = minCites.value;
    });
    minCites.addEventListener('change', () => {
      if (minCitesLabel) minCitesLabel.textContent = minCites.value;
      setFilters({ paperFilterMinCitations: Number(minCites.value) });
      renderPaperSidebarList();
    });
  }

  const yearMin = document.getElementById('paper-year-min');
  const yearMax = document.getElementById('paper-year-max');
  if (yearMin) {
    yearMin.addEventListener('change', () => {
      setFilters({ paperFilterYearMin: Number(yearMin.value) || null });
      renderPaperSidebarList();
    });
  }
  if (yearMax) {
    yearMax.addEventListener('change', () => {
      setFilters({ paperFilterYearMax: Number(yearMax.value) || null });
      renderPaperSidebarList();
    });
  }

  const tagSelect = document.getElementById('paper-tag-filter');
  if (tagSelect) {
    tagSelect.addEventListener('change', () => {
      setFilters({ paperFilterTag: tagSelect.value || '' });
      renderPaperSidebarList();
    });
  }

  const resetBtn = document.getElementById('paper-filter-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      setFilters({
        paperFilterYearMin: null,
        paperFilterYearMax: null,
        paperFilterMinCitations: 0,
        paperFilterTag: '',
        paperSidebarSort: 'influence',
      });
      if (minCites) minCites.value = 0;
      if (minCitesLabel) minCitesLabel.textContent = '0';
      if (yearMin) yearMin.value = yearMin.min || '';
      if (yearMax) yearMax.value = yearMax.max || '';
      if (tagSelect) tagSelect.value = '';
      const sortFilter = document.getElementById('paper-sort-filter');
      if (sortFilter) sortFilter.value = 'influence';
      renderPaperSidebarList();
    });
  }

  const sortFilter = document.getElementById('paper-sort-filter');
  if (sortFilter) {
    sortFilter.addEventListener('change', () => {
      setFilters({ paperSidebarSort: sortFilter.value });
      renderPaperSidebarList();
    });
  }
}

function populatePaperTagDropdown() {
  const tagSelect = document.getElementById('paper-tag-filter');
  if (!tagSelect) return;
  const papers = getPapers();
  if (!papers?.papers) return;

  const tagCounts = {};
  for (const paper of Object.values(papers.papers)) {
    for (const tag of (paper.tg || paper.tags || [])) {
      const key = String(tag || '').trim();
      if (key) tagCounts[key] = (tagCounts[key] || 0) + 1;
    }
  }
  const entries = Object.entries(tagCounts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  tagSelect.innerHTML = '<option value="">All tags</option>' +
    entries.slice(0, 40).map(([tag, count]) =>
      `<option value="${escText(tag)}">${escText(tag + ' (' + count + ')')}</option>`
    ).join('');

  // Setup year range inputs from paper data
  const years = Object.values(papers.papers)
    .map(p => p.y || null)
    .filter(y => y !== null);
  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const yearMinEl = document.getElementById('paper-year-min');
    const yearMaxEl = document.getElementById('paper-year-max');
    if (yearMinEl) { yearMinEl.min = minYear; yearMinEl.max = maxYear; yearMinEl.value = minYear; }
    if (yearMaxEl) { yearMaxEl.min = minYear; yearMaxEl.max = maxYear; yearMaxEl.value = maxYear; }
  }

  // Setup citation slider max
  const maxCites = Math.max(50, ...Object.values(papers.papers).map(p => p.c || p.cc || 0));
  const minCites = document.getElementById('paper-min-cites');
  if (minCites) {
    minCites.max = String(Math.ceil(maxCites / 50) * 50);
  }
}

function paperPassesSidebarFilters(paper) {
  if (!paper) return false;
  const st = getState();
  const year = paper.y || null;
  if (st.paperFilterYearMin && year !== null && year < st.paperFilterYearMin) return false;
  if (st.paperFilterYearMax && year !== null && year > st.paperFilterYearMax) return false;
  if (st.paperFilterMinCitations > 0 && (paper.c || paper.cc || 0) < st.paperFilterMinCitations) return false;
  if (st.paperFilterTag) {
    const tags = (paper.tg || paper.tags || []).map(t => String(t));
    if (!tags.includes(st.paperFilterTag)) return false;
  }
  return true;
}

function paperSidebarRankScore(paper) {
  const st = getState();
  const inf = Number(paper.inf || 0);
  const cites = Number(paper.c || paper.cc || 0);
  const year = paper.y || 0;
  if (st.paperSidebarSort === 'citations') return cites * 100 + inf * 10 + year * 0.001;
  if (st.paperSidebarSort === 'recent') return year * 100 + inf * 10 + Math.log1p(cites);
  // Default: influence
  return inf * 160 + Math.log1p(cites) * 18 + year * 0.01;
}

function renderPaperSidebarList() {
  const listEl = document.getElementById('paper-sidebar-list');
  const summaryEl = document.getElementById('paper-sidebar-summary');
  if (!listEl) return;

  const papers = getPapers();
  if (!papers?.papers) {
    if (listEl) listEl.innerHTML = '<div style="color:#666;padding:8px;font-size:11px">Papers not loaded yet</div>';
    return;
  }

  const all = Object.values(papers.papers);
  const filtered = all.filter(p => paperPassesSidebarFilters(p));
  filtered.sort((a, b) => {
    const diff = paperSidebarRankScore(b) - paperSidebarRankScore(a);
    if (diff !== 0) return diff;
    return String(a.t || '').localeCompare(String(b.t || ''));
  });

  if (summaryEl) summaryEl.textContent = filtered.length + ' / ' + all.length + ' papers';

  const topRows = filtered.slice(0, 40);
  listEl.innerHTML = topRows.map(paper => {
    const title = escText(paper.t || 'Untitled paper');
    const year = paper.y;
    const cites = paper.c || paper.cc || 0;
    const inf = Number(paper.inf || 0);
    const authors = (paper.a || []).slice(0, 2).join(', ');
    const metaParts = [];
    if (year) metaParts.push(String(year));
    if (authors) metaParts.push(authors);
    metaParts.push('cites ' + cites.toLocaleString());
    metaParts.push('inf ' + inf.toFixed(2));
    return `<div class="paper-sidebar-item" data-paper-id="${escText(String(paper.id || ''))}">
      <div class="paper-title">${title}</div>
      <div class="paper-meta">${escText(metaParts.join(' - '))}</div>
    </div>`;
  }).join('');

  for (const el of listEl.querySelectorAll('.paper-sidebar-item')) {
    let clickTimer = null;
    el.addEventListener('click', () => {
      const pid = el.getAttribute('data-paper-id') || '';
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        pinEntity({ type: 'paper', id: pid });
      }, 250);
    });
    el.addEventListener('dblclick', () => {
      const pid = el.getAttribute('data-paper-id') || '';
      selectEntity({ type: 'paper', id: pid });
    });
  }
}

function updateBreadcrumbs() {
  const container = document.getElementById('filter-breadcrumb');
  if (!container) return;
  container.innerHTML = '';

  const st = getState();
  if (st.activeThread) {
    addBreadcrumb(container, 'Thread: ' + (THREAD_NAMES[st.activeThread] || st.activeThread),
      THREAD_COLORS[st.activeThread], () => setFilters({ activeThread: null }));
  }
  if (st.activeAuthor) {
    addBreadcrumb(container, 'Author: ' + st.activeAuthor, null,
      () => setFilters({ activeAuthor: null }));
  }
  if (st.activeTag) {
    addBreadcrumb(container, 'Tag: ' + st.activeTag, null,
      () => setFilters({ activeTag: null }));
  }
}

function addBreadcrumb(container, text, color, onRemove) {
  const tag = document.createElement('span');
  tag.className = 'bc-tag';
  if (color) tag.style.borderColor = color;
  tag.innerHTML = `${escText(text)} <span class="bc-close">&times;</span>`;
  tag.querySelector('.bc-close').addEventListener('click', onRemove);
  container.appendChild(tag);
}

function escText(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
