# CLAUDE.md — Calculus of Variations Research Map

## Project Overview

Interactive research map visualizing the academic landscape of calculus of variations. Scrapes papers from OpenAlex (primary) and Semantic Scholar (enrichment), then renders an interactive website with timeline, citation network, and co-author views.

**Live site:** https://fradamt.github.io/calcvar/
**Repo:** https://github.com/fradamt/calcvar

## Architecture

### Data Pipeline

```
build_papers_db.py → papers-db.json → enrich_paper_refs.py → papers-db.json (enriched) → analyze.py → v2/data/*.json
```

1. **`build_papers_db.py`** — Discovers papers via keyword search + author seeds on OpenAlex, scores for relevance, expands via citation graph, enriches citation counts from Semantic Scholar. Outputs `papers-db.json`.
2. **`enrich_paper_refs.py`** — Fills in `referenced_works` for papers missing them (OpenAlex batch, DOI fallback, Semantic Scholar batch + per-paper fallback).
3. **`analyze.py`** — Reads `papers-db.json`, assigns subfield threads, computes influence scores, builds citation graph, and writes 4 JSON data files to `v2/data/`.

### Frontend (`v2/`)

Vanilla ES6 modules, HTML5 Canvas rendering, D3.js v7 for force simulation and scales. No build step.

```
v2/
├── index.html
├── css/main.css
├── js/
│   ├── main.js          — App init, view switching, hash routing, keyboard shortcuts
│   ├── state.js         — Centralized state management, event bus
│   ├── data.js          — Progressive data loading, index building
│   ├── constants.js     — Subfield colors, thread order, config
│   ├── timeline-canvas.js — Canvas swim-lane timeline (X=year, Y=subfield)
│   ├── network.js       — D3 force-directed citation network
│   ├── coauthor.js      — D3 force-directed co-author network
│   ├── sidebar.js       — Subfield legend, paper list, filters, author list, tag chips
│   ├── detail.js        — Detail panel for papers/subfields/authors
│   ├── search.js        — Search box with fuzzy matching
│   └── canvas-utils.js  — Shared canvas drawing utilities
└── data/
    ├── core.json        — Top 800 papers + threads + authors + citation subgraph
    ├── papers.json      — All papers (compact format for sidebar/filters)
    ├── graph.json       — Top 600 papers as network nodes + edges
    └── coauthor.json    — Author collaboration network
```

### Deployment

GitHub Pages via `gh-pages` branch containing only the `v2/` directory.

```bash
# Rebuild gh-pages from v2/ and push
git branch -D gh-pages 2>/dev/null
git subtree split --prefix v2 -b gh-pages
git push -f origin gh-pages
```

User must enable Pages in repo settings: Settings > Pages > Deploy from branch: `gh-pages` / `/ (root)`.

## Running the Pipeline

```bash
# Full pipeline (takes ~10 min due to API rate limits)
python3 build_papers_db.py --query-pages 3 --author-pages 2
python3 enrich_paper_refs.py
python3 analyze.py

# Start local dev server
cd v2 && python3 -m http.server 8000
```

### DNS Workaround

OpenAlex DNS may fail with Google DNS (8.8.8.8). The scraper and enrichment scripts include `--resolve api.openalex.org:443:104.20.26.229` in curl calls. If this IP becomes stale, resolve via `nslookup api.openalex.org 1.1.1.1`.

## Data Format

### Compact JSON Keys

Frontend uses short keys for compact JSON:

| Key | Meaning |
|-----|---------|
| `t` | title |
| `a` | authors (list) |
| `d` | date string |
| `y` | year (integer) |
| `c` | cited_by_count |
| `cc` | cited_by_count (in core.json) |
| `inf` | influence score |
| `th` | thread (subfield ID) |
| `ref` | in-corpus reference IDs |
| `icc` | in-corpus citation count |
| `tags` | subfield tags |
| `url` | paper URL |
| `doi` | DOI |
| `arxiv_id` | arXiv ID |

### Subfields (9)

`classical_calcvar`, `direct_methods`, `regularity`, `geometric`, `optimal_control`, `convexity`, `gamma_convergence`, `optimal_transport`, `free_discontinuity`

Thread assignment prefers specific subfields over the `classical_calcvar` catch-all.

## Known Issues

- **OpenAlex metadata quality:** Author names on books can be wrong (e.g., Federer's "Geometric Measure Theory" lists incorrect authors). The SS enrichment only fetches citation counts, not author metadata, so OpenAlex errors persist. A future improvement would be to also pull SS author data to cross-check.
- **Citation expansion relevance:** Papers pulled in via citation expansion (cited by >=3 corpus papers) are now filtered: must mention calcvar explicitly OR match >=2 domain terms. Single domain-term matches (e.g., just "dynamic programming") are excluded to avoid loosely related papers.
- **Influence score formula:** 40% citations (log-scaled), 30% relevance score, 20% in-corpus citations, 10% recency. The relevance score from OpenAlex keyword search may not be available for citation-expanded papers.

## Expanding Coverage

- **Add authors:** Add names to `AUTHOR_SEEDS` in `build_papers_db.py`, organized by subfield
- **Add keywords:** Add search queries to `KEYWORD_QUERIES`
- **Add domain terms:** Add discriminating terms to `DOMAIN_TERMS` dict (used for both scoring and subfield classification)
- **Add subfields:** Add to `DOMAIN_TERMS` in build script, `THREAD_META` in analyze.py, and `THREAD_COLORS`/`THREAD_ORDER`/`THREAD_NAMES` in constants.js
- **`expansion_data.py`**: Contains additional author/keyword/term recommendations from a research agent, not yet incorporated

## Interaction Model

### Click Behavior

All views use a consistent single-click / double-click pattern:

| Element | Single Click | Double Click |
|---------|-------------|--------------|
| Timeline paper node | Pin (highlight + first-degree citation edges) | Open detail panel |
| Sidebar paper item | Pin in current view | Open detail panel |
| Sidebar author item | Toggle author filter | Filter + open detail panel |
| Sidebar thread chip | Toggle thread filter | Filter + open detail panel |
| Search result (paper) | Open detail panel + pin in view | — |
| Search result (author) | Open detail panel + highlight author's papers | — |
| Empty canvas area | Clear pin/selection | Reset zoom |

### Pin vs Select vs Filter

- **Pin** (`pinEntity`): Highlights a paper and its first-degree citation edges in the timeline. Dims everything else. Shows overlay labels on connected papers. Does NOT open the detail panel. Cleared by clicking empty space or pressing Escape.
- **Select** (`selectEntity`): Pins the entity AND opens the detail panel. Used by double-click and search result clicks.
- **Filter** (`setFilters`): Sets persistent filters (thread, author, tag, influence threshold). Shows matching papers at normal opacity, dims non-matching. Shown as breadcrumbs. Cleared individually or via Escape/reset.

### Cross-View Highlighting

When an author is pinned/selected (from search or sidebar), all their papers are highlighted in both the timeline and network views:
- **Timeline:** `buildPinnedConnections` finds author's papers from `core.papers`, highlights them at 0.7 opacity with overlay labels on top papers.
- **Network:** Connected set is built by looking up author names from `core.papers` (since `graph.json` nodes don't carry author arrays).

### Pinned Edge Visibility

When a paper is pinned, only **first-degree edges** (direct citations to/from the pinned paper) are shown. All other edges are fully hidden (opacity 0) to avoid visual clutter from dense second-degree connections.

## Key Design Decisions

- **Canvas over SVG:** Performance with thousands of papers. All three views use HTML5 Canvas.
- **Event-driven state:** `state.js` is the single source of truth. Actions (`pinEntity`, `selectEntity`, `setFilters`) mutate state and emit events (`pin:changed`, `selection:changed`, `filters:changed`). Views subscribe to events and re-render. This allows cross-module communication (e.g., sidebar pin → timeline highlight) without direct imports between view modules.
- **OpenAlex primary, SS secondary:** OpenAlex has broader coverage (especially older works/books) and no rate limits. SS has better metadata quality but strict limits. We use OA for discovery and SS for citation count enrichment.
- **Influence-only visibility:** Paper visibility controlled solely by the influence slider — no layer modes. The influence score balances citation impact, relevance, in-corpus citations, and recency.
- **Citation expansion with relevance gate:** Papers cited by >=3 corpus papers are auto-included only if they pass a relevance check (must mention calcvar terms or match >=2 domain terms). The threshold was raised from 1 to 2 domain terms to filter out loosely related books (e.g., Bellman's generic "Dynamic Programming").
