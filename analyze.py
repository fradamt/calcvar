#!/usr/bin/env python3
"""Analyze papers-db.json and generate website data files for Calculus of Variations.

Reads papers-db.json (output of build_papers_db.py) and produces:
  v2/data/core.json    — threads, authors, top papers, citation graph
  v2/data/papers.json  — full paper list for paper sidebar/filters
  v2/data/graph.json   — unified citation network for network view
  v2/data/coauthor.json — author collaboration network

Usage:
    python3 analyze.py
    python3 analyze.py --input papers-db.json --output-dir v2/data
"""

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = SCRIPT_DIR / "papers-db.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "v2" / "data"

# Research subfield definitions
THREAD_META = {
    "classical_calcvar": {
        "name": "Classical Methods",
        "description": "Euler-Lagrange equations, necessary conditions, sufficient conditions, Hamilton's principle, and classical variational techniques.",
    },
    "direct_methods": {
        "name": "Direct Methods",
        "description": "Lower semicontinuity, coercivity, weak convergence in Sobolev spaces, existence theorems via minimization.",
    },
    "regularity": {
        "name": "Regularity Theory",
        "description": "Regularity of minimizers, partial regularity, De Giorgi–Nash–Moser theory, Schauder estimates.",
    },
    "geometric": {
        "name": "Geometric Problems",
        "description": "Minimal surfaces, harmonic maps, geodesics, curvature flows, Plateau problem, geometric measure theory.",
    },
    "optimal_control": {
        "name": "Optimal Control",
        "description": "Pontryagin maximum principle, dynamic programming, Hamilton-Jacobi-Bellman equations, viscosity solutions.",
    },
    "convexity": {
        "name": "Convexity & Relaxation",
        "description": "Quasiconvexity, polyconvexity, rank-one convexity, relaxation of variational problems, Young measures.",
    },
    "gamma_convergence": {
        "name": "Γ-Convergence",
        "description": "Gamma-convergence, homogenization, dimension reduction, variational limits of sequences of functionals.",
    },
    "optimal_transport": {
        "name": "Optimal Transport",
        "description": "Monge-Kantorovich problem, Wasserstein distances, Brenier's theorem, displacement convexity, gradient flows.",
    },
    "free_discontinuity": {
        "name": "Free Discontinuity",
        "description": "Mumford-Shah functional, SBV functions, phase field models, Ginzburg-Landau vortices, Allen-Cahn and Cahn-Hilliard equations, sharp and diffuse interface limits.",
    },
}

THREAD_ORDER = list(THREAD_META.keys())

# Priority for thread assignment when a paper has multiple tags
THREAD_PRIORITY = {t: i for i, t in enumerate(THREAD_ORDER)}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def short_openalex_id(oa_id):
    if not oa_id:
        return None
    m = re.search(r"/([AW]\d+)$", oa_id.strip())
    return m.group(1) if m else oa_id.strip()


def assign_thread(paper):
    """Assign primary research thread based on paper tags.

    Prefers specific subfields over the broad 'classical_calcvar' fallback.
    """
    tags = paper.get("tags") or []
    if not tags:
        return "classical_calcvar"

    # Filter to only recognized thread tags
    thread_tags = [t for t in tags if t in THREAD_PRIORITY]
    if not thread_tags:
        return "classical_calcvar"

    # Prefer specific subfields over classical_calcvar
    specific = [t for t in thread_tags if t != "classical_calcvar"]
    if specific:
        # Among specific tags, pick the one with highest priority (lowest index)
        return min(specific, key=lambda t: THREAD_PRIORITY[t])

    return "classical_calcvar"


def compute_influence(paper, in_corpus_citations, max_citations, max_relevance):
    """Compute influence score for a paper.

    Formula:
      40% citation count (log-scaled, normalized)
      30% relevance score (normalized)
      20% in-corpus citation count (log-scaled)
      10% recency bonus
    """
    cited = paper.get("cited_by_count") or 0
    relevance = paper.get("relevance_score") or 0
    in_corpus = in_corpus_citations.get(paper["id"], 0)
    year = paper.get("year") or 1950

    # Normalize citation count (log scale)
    cite_norm = math.log1p(cited) / math.log1p(max(max_citations, 1))

    # Normalize relevance
    rel_norm = relevance / max(max_relevance, 1.0)

    # In-corpus citation (log scale, cap at reasonable value)
    in_corpus_norm = math.log1p(in_corpus) / math.log1p(50)
    in_corpus_norm = min(in_corpus_norm, 1.0)

    # Recency bonus (papers from last 10 years get bonus)
    current_year = 2025
    recency = max(0, min(1.0, (year - (current_year - 30)) / 30))

    inf = 0.4 * cite_norm + 0.3 * rel_norm + 0.2 * in_corpus_norm + 0.1 * recency
    return round(inf, 4)


def build_citation_graph(papers, oa_id_to_paper_id):
    """Build citation edges between papers in the corpus."""
    edges = []
    paper_ids = {p["id"] for p in papers}

    for paper in papers:
        source_id = paper["id"]
        for ref_oa in paper.get("referenced_works") or []:
            target_id = oa_id_to_paper_id.get(ref_oa)
            if target_id and target_id in paper_ids and target_id != source_id:
                edges.append({"source": source_id, "target": target_id})

    return edges


def build_coauthor_network(papers, author_influence):
    """Build author co-authorship network from papers."""
    coauthor_weights = Counter()
    author_set = set()

    for paper in papers:
        authors = paper.get("authors") or []
        for a in authors:
            author_set.add(a)
        # All pairs of authors on a paper
        for i in range(len(authors)):
            for j in range(i + 1, len(authors)):
                pair = tuple(sorted([authors[i], authors[j]]))
                coauthor_weights[pair] += 1

    # Build nodes (only authors with at least some influence)
    nodes = []
    for author in sorted(author_set):
        inf = author_influence.get(author, 0)
        if inf > 0:
            nodes.append({
                "id": author.lower().replace(" ", "_"),
                "author": author,
                "inf": round(inf, 4),
            })

    # Build edges (only between authors that both appear as nodes)
    node_ids = {n["author"]: n["id"] for n in nodes}
    edges = []
    for (a1, a2), weight in coauthor_weights.most_common():
        if a1 in node_ids and a2 in node_ids and weight >= 1:
            edges.append({
                "source": node_ids[a1],
                "target": node_ids[a2],
                "weight": weight,
            })

    return {"nodes": nodes, "edges": edges}


def compute_warm_positions(papers, thread_order):
    """Compute initial x/y positions for network graph nodes based on year and thread."""
    thread_y = {t: i * 100 for i, t in enumerate(thread_order)}
    year_min = min((p.get("year") or 2000) for p in papers)
    year_max = max((p.get("year") or 2000) for p in papers)
    year_range = max(year_max - year_min, 1)

    positions = {}
    for paper in papers:
        year = paper.get("year") or 2000
        thread = paper.get("_thread", "classical_calcvar")
        x = ((year - year_min) / year_range) * 800 - 400
        y = thread_y.get(thread, 0) + (hash(paper["id"]) % 60 - 30)
        positions[paper["id"]] = (round(x, 1), round(y, 1))

    return positions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="Input papers-db.json")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Output directory")
    parser.add_argument("--top-papers", type=int, default=800, help="Max papers in core.json")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {input_path}...")
    with open(input_path) as f:
        db = json.load(f)

    papers = db.get("papers", [])
    print(f"  {len(papers)} papers loaded")

    if not papers:
        print("No papers found. Run build_papers_db.py first.")
        return

    # --- Build OpenAlex ID → paper ID lookup ---
    oa_id_to_paper_id = {}
    for p in papers:
        oa = p.get("openalex_id")
        if oa:
            short = short_openalex_id(oa)
            if short:
                oa_id_to_paper_id[short] = p["id"]
            oa_id_to_paper_id[oa] = p["id"]
        # Also map aliases
        for alias in p.get("aliases") or []:
            if alias.startswith("openalex:"):
                oa_short = short_openalex_id(alias.replace("openalex:", ""))
                if oa_short:
                    oa_id_to_paper_id[oa_short] = p["id"]

    # --- Assign threads ---
    for paper in papers:
        paper["_thread"] = assign_thread(paper)

    # --- Compute in-corpus citations and refs ---
    paper_ids = {p["id"] for p in papers}
    in_corpus_citations = Counter()
    in_corpus_refs = defaultdict(list)
    for paper in papers:
        for ref_oa in paper.get("referenced_works") or []:
            target_id = oa_id_to_paper_id.get(ref_oa)
            if target_id and target_id in paper_ids and target_id != paper["id"]:
                in_corpus_citations[target_id] += 1
                in_corpus_refs[paper["id"]].append(target_id)

    # --- Compute influence ---
    max_citations = max((p.get("cited_by_count") or 0) for p in papers) if papers else 1
    max_relevance = max((p.get("relevance_score") or 0) for p in papers) if papers else 1.0

    for paper in papers:
        paper["_influence"] = compute_influence(
            paper, in_corpus_citations, max_citations, max_relevance
        )

    # Sort by influence descending
    papers.sort(key=lambda p: -p["_influence"])

    # --- Build thread stats ---
    thread_stats = {}
    for tid in THREAD_ORDER:
        meta = THREAD_META[tid]
        thread_papers = [p for p in papers if p["_thread"] == tid]

        # Yearly counts
        yearly = Counter()
        for p in thread_papers:
            y = p.get("year")
            if y:
                yearly[y] += 1

        year_min = min(yearly.keys()) if yearly else 1950
        year_max = max(yearly.keys()) if yearly else 2025
        yc = []
        for y in range(year_min, year_max + 1):
            yc.append({"y": y, "c": yearly.get(y, 0)})

        # Thread authors and key authors
        thread_author_counts = Counter()
        for p in thread_papers:
            for a in p.get("authors") or []:
                thread_author_counts[a] += 1

        # Top papers by influence
        thread_top_papers = sorted(thread_papers, key=lambda x: -x["_influence"])

        thread_stats[tid] = {
            "n": meta["name"],
            "d": meta["description"],
            "tc": len(thread_papers),
            "yc": yc,
            "py": max(yearly, key=yearly.get) if yearly else None,
            "ac": len(thread_author_counts),
            "ka": dict(thread_author_counts.most_common(15)),
            "tops": [p["id"] for p in thread_top_papers[:15]],
        }

    # --- Build author stats ---
    author_papers = defaultdict(list)
    author_citations = Counter()
    author_influence = defaultdict(float)
    author_years = defaultdict(set)
    author_threads = defaultdict(Counter)
    author_coauthors = defaultdict(Counter)

    for paper in papers:
        year = paper.get("year")
        thread = paper["_thread"]
        authors_list = paper.get("authors") or []
        for author in authors_list:
            author_papers[author].append(paper["id"])
            author_citations[author] += paper.get("cited_by_count") or 0
            author_influence[author] += paper["_influence"]
            if year:
                author_years[author].add(year)
            author_threads[author][thread] += 1
            for coauthor in authors_list:
                if coauthor != author:
                    author_coauthors[author][coauthor] += 1

    # Build author top papers (papers already sorted by influence desc)
    author_top_papers = defaultdict(list)
    for paper in papers:
        for author in paper.get("authors") or []:
            if len(author_top_papers[author]) < 10:
                author_top_papers[author].append(paper["id"])

    authors_data = {}
    for author in sorted(author_papers.keys()):
        authors_data[author] = {
            "u": author,
            "pc": len(author_papers[author]),
            "inf": round(author_influence[author], 4),
            "cc": author_citations[author],
            "yrs": sorted(author_years.get(author, [])),
            "ths": dict(author_threads.get(author, {})),
            "tops": author_top_papers.get(author, []),
            "co": dict(author_coauthors.get(author, Counter()).most_common(20)),
        }

    # --- Build citation graph ---
    print("Building citation graph...")
    citation_edges = build_citation_graph(papers, oa_id_to_paper_id)
    print(f"  {len(citation_edges)} citation edges")

    # --- Top papers for core.json ---
    top_papers = papers[:args.top_papers]
    core_papers = {}
    for p in top_papers:
        pid = p["id"]
        year = p.get("year")
        date_str = f"{year}-01-01" if year else "2000-01-01"
        core_papers[pid] = {
            "id": pid,
            "t": p.get("title", ""),
            "a": (p.get("authors") or [])[:10],  # cap authors
            "d": date_str,
            "inf": p["_influence"],
            "th": p["_thread"],
            "cc": p.get("cited_by_count") or 0,
            "ref": in_corpus_refs.get(pid, []),
            "tags": p.get("tags") or [],
            "icc": in_corpus_citations.get(pid, 0),
        }

    # Graph nodes/edges for core.json (subset of top papers)
    top_ids = set(core_papers.keys())
    core_graph_edges = [
        e for e in citation_edges
        if e["source"] in top_ids and e["target"] in top_ids
    ]
    core_graph_nodes = [
        {"id": pid, "type": "paper"}
        for pid in top_ids
    ]

    # --- Write core.json ---
    core_data = {
        "metadata": {
            "generated_at": now_iso(),
            "total_papers": len(papers),
            "top_papers": len(core_papers),
            "citation_edges": len(core_graph_edges),
            "authors": len(authors_data),
        },
        "threads": thread_stats,
        "authors": authors_data,
        "papers": core_papers,
        "graph": {
            "nodes": core_graph_nodes,
            "edges": core_graph_edges,
        },
    }

    core_path = output_dir / "core.json"
    with open(core_path, "w") as f:
        json.dump(core_data, f, separators=(",", ":"), ensure_ascii=True)
        f.write("\n")
    print(f"Written: {core_path} ({len(core_papers)} papers, {len(core_graph_edges)} edges)")

    # --- Write papers.json ---
    papers_dict = {}
    for p in papers:
        pid = p["id"]
        papers_dict[pid] = {
            "id": pid,
            "t": p.get("title", ""),
            "a": (p.get("authors") or [])[:10],
            "y": p.get("year"),
            "c": p.get("cited_by_count") or 0,
            "inf": p["_influence"],
            "rel": p.get("relevance_score") or 0,
            "th": p["_thread"],
            "tags": p.get("tags") or [],
            "doi": p.get("doi"),
            "arxiv_id": p.get("arxiv_id"),
            "url": p.get("url"),
            "venue": p.get("venue"),
        }

    papers_data = {
        "metadata": {
            "generated_at": now_iso(),
            "total": len(papers_dict),
        },
        "papers": papers_dict,
    }

    papers_path = output_dir / "papers.json"
    with open(papers_path, "w") as f:
        json.dump(papers_data, f, separators=(",", ":"), ensure_ascii=True)
        f.write("\n")
    print(f"Written: {papers_path} ({len(papers_dict)} papers)")

    # --- Write graph.json (unified network) ---
    warm_positions = compute_warm_positions(papers[:600], THREAD_ORDER)

    graph_nodes = []
    for p in papers[:600]:  # cap at 600 for performance
        pid = p["id"]
        wx, wy = warm_positions.get(pid, (0, 0))
        graph_nodes.append({
            "id": pid,
            "type": "paper",
            "t": p.get("title", ""),
            "inf": p["_influence"],
            "th": p["_thread"],
            "x": wx,
            "y": wy,
        })

    graph_node_ids = {n["id"] for n in graph_nodes}
    graph_edges = [
        {"source": e["source"], "target": e["target"], "type": "paper_cites"}
        for e in citation_edges
        if e["source"] in graph_node_ids and e["target"] in graph_node_ids
    ]

    graph_data = {
        "metadata": {
            "generated_at": now_iso(),
            "nodes": len(graph_nodes),
            "edges": len(graph_edges),
        },
        "unifiedGraph": {
            "nodes": graph_nodes,
            "edges": graph_edges,
        },
    }

    graph_path = output_dir / "graph.json"
    with open(graph_path, "w") as f:
        json.dump(graph_data, f, separators=(",", ":"), ensure_ascii=True)
        f.write("\n")
    print(f"Written: {graph_path} ({len(graph_nodes)} nodes, {len(graph_edges)} edges)")

    # --- Write coauthor.json ---
    print("Building co-author network...")
    coauthor_data = build_coauthor_network(papers, author_influence)
    print(f"  {len(coauthor_data['nodes'])} authors, {len(coauthor_data['edges'])} edges")

    coauthor_path = output_dir / "coauthor.json"
    with open(coauthor_path, "w") as f:
        json.dump(coauthor_data, f, separators=(",", ":"), ensure_ascii=True)
        f.write("\n")
    print(f"Written: {coauthor_path}")

    # --- Summary ---
    print("\n--- Summary ---")
    print(f"Total papers: {len(papers)}")
    print(f"Top papers (core): {len(core_papers)}")
    print(f"Citation edges: {len(citation_edges)}")
    print(f"Authors: {len(authors_data)}")
    print(f"Co-author edges: {len(coauthor_data['edges'])}")
    print("Thread breakdown:")
    for tid in THREAD_ORDER:
        ts = thread_stats[tid]
        print(f"  {ts['n']}: {ts['tc']} papers")


if __name__ == "__main__":
    main()
