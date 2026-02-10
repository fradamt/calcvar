// search.js — Debounced search with dropdown for papers and authors

import { THREAD_COLORS, AUTHOR_COLORS } from './constants.js';
import { getState, selectEntity, hoverEntity } from './state.js';

let coreData = null;
let searchTimeout = null;
let activeIndex = -1;

export function init(core) {
  coreData = core;
  const input = document.getElementById('search-box');
  const dropdown = document.getElementById('search-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = input.value.toLowerCase().trim();
      if (!q) {
        dropdown.style.display = 'none';
        activeIndex = -1;
        return;
      }
      runSearch(q, dropdown);
    }, 150);
  });

  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.search-item');
    if (!items.length || dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActiveItem(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveItem(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < items.length) {
        items[activeIndex].click();
      } else if (items.length > 0) {
        items[0].click();
      }
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
      activeIndex = -1;
      input.blur();
    }
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) {
      runSearch(input.value.toLowerCase().trim(), document.getElementById('search-dropdown'));
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      dropdown.style.display = 'none';
      activeIndex = -1;
    }
  });
}

// --- Text normalization ---

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeSearchText(value) {
  const norm = normalizeSearchText(value);
  if (!norm) return [];
  return norm.split(/\s+/).filter(Boolean);
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Main search logic ---

function runSearch(q, dropdown) {
  const view = getState().view;

  // In coauthor view, only show author results
  if (view === 'coauthor') {
    runCoauthorSearch(q, dropdown);
    return;
  }

  // Collect results from each category
  const authorResults = searchAuthors(q);
  const paperResults = searchPapers(q);

  // Slice to fit in dropdown
  const authorSlice = authorResults.slice(0, 3);
  const paperSlice = paperResults.slice(0, Math.max(5, 8 - authorSlice.length));

  activeIndex = -1;
  dropdown.innerHTML = '';

  const allSlices = [
    ...authorSlice.map(r => renderAuthorItem(r)),
    ...paperSlice.map(r => renderPaperItem(r)),
  ];

  if (allSlices.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  for (const html of allSlices) {
    dropdown.insertAdjacentHTML('beforeend', html);
  }

  wireDropdownHandlers(dropdown);
  dropdown.style.display = 'block';
}

// --- Coauthor view search ---

function runCoauthorSearch(q, dropdown) {
  const results = [];
  for (const a of Object.values(coreData?.authors || {})) {
    if ((a.u || '').toLowerCase().includes(q)) {
      results.push(a);
    }
  }
  results.sort((a, b) => (b.inf || 0) - (a.inf || 0));
  const slice = results.slice(0, 8);

  activeIndex = -1;
  dropdown.innerHTML = '';

  if (slice.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  for (const a of slice) {
    const color = AUTHOR_COLORS[Math.abs(hashStr(a.u)) % AUTHOR_COLORS.length] || '#667';
    dropdown.insertAdjacentHTML('beforeend',
      `<div class="search-item" data-author="${escHtml(a.u)}">
        <div class="si-title"><span style="color:${color}">\u25CF</span> ${escHtml(a.u)}</div>
        <div class="si-meta">${a.pc || 0} papers \u00b7 inf: ${(a.inf || 0).toFixed(2)}</div>
      </div>`
    );
  }

  wireDropdownHandlers(dropdown);
  dropdown.style.display = 'block';
}

// --- Search: authors ---

function searchAuthors(q) {
  const results = [];
  for (const a of Object.values(coreData?.authors || {})) {
    if ((a.u || '').toLowerCase().includes(q)) {
      results.push({ author: a });
    }
  }
  results.sort((a, b) => (b.author.inf || 0) - (a.author.inf || 0));
  return results;
}

// --- Search: Papers (multi-field scoring) ---

function searchPapers(q) {
  const papers = coreData?.papers;
  if (!papers) return [];

  const qNorm = normalizeSearchText(q);
  const qTokens = tokenizeSearchText(qNorm);
  const results = [];

  for (const [pid, p] of Object.entries(papers)) {
    let score = 0;
    const titleNorm = normalizeSearchText(p.t || '');
    const titleTokens = titleNorm ? titleNorm.split(/\s+/).filter(Boolean) : [];
    const authorNames = p.a || [];
    const authorNormRows = authorNames.map(name => normalizeSearchText(name)).filter(Boolean);
    const tagNormRows = (p.tags || []).map(tag => normalizeSearchText(tag)).filter(Boolean);

    // Author matching
    let matchedAuthor = '';
    let authorExact = false;
    let authorTokenMatch = false;
    let authorPrefixMatch = false;
    let authorSubstringMatch = false;

    if (qNorm) {
      for (const name of authorNames) {
        if (matchedAuthor) break;
        const nNorm = normalizeSearchText(name || '');
        if (!nNorm) continue;
        const nTokens = nNorm.split(/\s+/).filter(Boolean);
        if (nNorm === qNorm) {
          matchedAuthor = String(name || '');
          authorExact = true;
          break;
        }
        if (qTokens.length > 0 && qTokens.every(tok => nTokens.indexOf(tok) >= 0)) {
          matchedAuthor = String(name || '');
          authorTokenMatch = true;
          break;
        }
        if (qTokens.length === 1 && qTokens[0].length >= 2 &&
            nTokens.some(tok => tok.indexOf(qTokens[0]) === 0)) {
          matchedAuthor = String(name || '');
          authorPrefixMatch = true;
          break;
        }
        if (nNorm.indexOf(qNorm) >= 0) {
          matchedAuthor = String(name || '');
          authorSubstringMatch = true;
        }
      }
    }

    if (authorExact) score += 8;
    else if (authorTokenMatch) score += 6;
    else if (authorPrefixMatch) score += 4;
    else if (authorSubstringMatch) score += 3;

    // Title matching
    const titleExactTokenMatch = qTokens.length > 0 &&
      qTokens.every(tok => titleTokens.indexOf(tok) >= 0);
    const titlePhraseMatch = qNorm.length >= 4 && titleNorm.indexOf(qNorm) >= 0;
    const titlePrefixMatch = qTokens.length === 1 && qTokens[0].length >= 4 &&
      titleTokens.some(tok => tok.indexOf(qTokens[0]) === 0);
    if (titleExactTokenMatch) score += 3;
    else if (titlePhraseMatch) score += 2;
    else if (titlePrefixMatch) score += 1;

    // Tag matching
    if (qNorm && tagNormRows.some(tag => tag.indexOf(qNorm) >= 0)) score += 1;

    if (score > 0) {
      results.push({
        paper: p, pid, score, matchedAuthor,
        authorStrong: !!(authorExact || authorTokenMatch || authorPrefixMatch),
        authorExact: !!authorExact,
      });
    }
  }

  results.sort((a, b) => {
    if (Number(b.authorExact || 0) !== Number(a.authorExact || 0))
      return Number(b.authorExact || 0) - Number(a.authorExact || 0);
    if (Number(b.authorStrong || 0) !== Number(a.authorStrong || 0))
      return Number(b.authorStrong || 0) - Number(a.authorStrong || 0);
    if (b.score !== a.score) return b.score - a.score;
    const bCc = Number((b.paper || {}).cc || 0);
    const aCc = Number((a.paper || {}).cc || 0);
    if (bCc !== aCc) return bCc - aCc;
    return String((a.paper || {}).t || '').localeCompare(String((b.paper || {}).t || ''));
  });

  return results;
}

// --- Render functions ---

function renderAuthorItem(r) {
  const a = r.author;
  const color = AUTHOR_COLORS[Math.abs(hashStr(a.u)) % AUTHOR_COLORS.length] || '#667';
  return `<div class="search-item" data-author="${escHtml(a.u)}">
    <div class="si-title"><span style="color:${color}">\u25CF</span> ${escHtml(a.u)}</div>
    <div class="si-meta">${a.pc || 0} papers \u00b7 inf: ${(a.inf || 0).toFixed(2)}</div>
  </div>`;
}

function renderPaperItem(r) {
  const p = r.paper || {};
  const year = p.d ? p.d.slice(0, 4) : (p.y ? String(p.y) : '?');
  const authorShort = (p.a || []).slice(0, 2).join(', ');
  let meta = year +
    (authorShort ? ' \u00b7 ' + authorShort : '') +
    (p.cc ? ' \u00b7 cites ' + Number(p.cc).toLocaleString() : '');
  if (r.matchedAuthor) meta += ' \u00b7 author match: ' + r.matchedAuthor;
  return `<div class="search-item search-item-paper" data-paper-id="${escHtml(String(r.pid || p.id || ''))}">
    <div class="si-title"><span style="color:#9cc8ff">\u25C6</span> ${escHtml(p.t || '')}</div>
    <div class="si-meta">${escHtml(meta)}</div>
  </div>`;
}

// --- Dropdown click/hover handlers ---

function wireDropdownHandlers(dropdown) {
  for (const el of dropdown.querySelectorAll('.search-item')) {
    el.addEventListener('click', () => {
      const authorId = el.dataset.author;
      const paperId = el.dataset.paperId;

      if (paperId) {
        selectEntity({ type: 'paper', id: paperId });
      } else if (authorId) {
        selectEntity({ type: 'author', id: authorId });
      }

      dropdown.style.display = 'none';
      activeIndex = -1;
      const input = document.getElementById('search-box');
      if (input) input.value = '';
    });

    el.addEventListener('mouseenter', () => {
      const paperId = el.dataset.paperId;
      if (paperId) {
        hoverEntity({ type: 'paper', id: paperId });
      }
    });

    el.addEventListener('mouseleave', () => {
      hoverEntity(null);
    });
  }
}

// --- Helpers ---

function updateActiveItem(items) {
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === activeIndex);
  }
  if (activeIndex >= 0 && items[activeIndex]) {
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
