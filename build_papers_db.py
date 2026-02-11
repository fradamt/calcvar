#!/usr/bin/env python3
"""Build a broad calculus-of-variations papers database from OpenAlex.

This script discovers candidate papers via:
1. Keyword searches across calculus of variations domains.
2. Works by known/seeded researchers.
3. Existing curated seed entries.

It then applies an explicit relevance score and minimum threshold to keep only
papers with at least a baseline level of calcvar/domain relevance.

Usage:
    python3 build_papers_db.py
    python3 build_papers_db.py --min-score 7 --query-pages 3 --author-pages 2
"""

import argparse
import json
import math
import re
import subprocess
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SEED_PATH = SCRIPT_DIR / "papers-seed.json"
OUTPUT_PATH = SCRIPT_DIR / "papers-db.json"

OPENALEX_BASE = "https://api.openalex.org"
SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1"
USER_AGENT = "calcvar-papers-builder/1.0"

# Calculus of variations search queries.
KEYWORD_QUERIES = [
    "calculus of variations",
    "variational methods",
    "Euler-Lagrange equation",
    "optimal control theory",
    "direct methods calculus of variations",
    "Sobolev spaces variational",
    "Gamma-convergence",
    "minimal surfaces",
    "isoperimetric problems",
    "Hamilton-Jacobi equations",
    "functional analysis variational",
    "regularity theory minimizers",
    "relaxation calculus of variations",
    "Young measures",
    "quasiconvexity",
    "polyconvexity",
    "free boundary problems variational",
    "variational inequalities",
    "mountain pass theorem",
    "critical point theory",
    "Palais-Smale condition",
    "concentration compactness",
    "compensated compactness",
    "microstructure variational",
    "phase transitions variational",
    "shape optimization",
    "optimal transport variational",
    "geodesics variational",
    "harmonic maps",
    "geometric measure theory",
    "free discontinuity problems",
    "Mumford-Shah functional",
    "Ginzburg-Landau vortices",
    "Allen-Cahn equation",
    "BV functions variational",
    "sets of finite perimeter",
    "gradient flows Wasserstein",
    "mean curvature flow",
    "Willmore functional",
    "nonlinear elasticity energy",
    "semicontinuity integrals",
    "Morrey conjecture",
    "Plateau problem surfaces",
    "regularity elliptic systems",
    "singular perturbation variational",
    "phase field models",
    "free boundary regularity",
    "Cahn-Hilliard equation",
    "stochastic optimal control",
    "mean field games",
]

# Researcher seeds: prominent calculus of variations researchers.
AUTHOR_SEEDS = [
    "Lawrence Craig Evans",
    "Ennio De Giorgi",
    "Enrico Giusti",
    "Jürgen Jost",
    "Michael Struwe",
    "Luigi Ambrosio",
    "Gianni Dal Maso",
    "Andrea Braides",
    "Bernard Dacorogna",
    "Mariano Giaquinta",
    "Stefan Müller",
    "Irene Fonseca",
    "Giovanni Leoni",
    "Haim Brezis",
    "Louis Nirenberg",
    "Pierre-Louis Lions",
    "Cédric Villani",
    "Alessio Figalli",
    "Camillo De Lellis",
    "Tristan Rivière",
    "Yann Brenier",
    "Robert McCann",
    "Felix Otto",
    "Barbara Zwicknagl",
    # Classical/Direct
    "Ivar Ekeland",
    "Paul Rabinowitz",
    "Antonio Ambrosetti",
    "Charles Morrey",
    "Luciano Modica",
    "Emanuele Spadaro",
    # Regularity
    "Giuseppe Mingione",
    "Nicola Fusco",
    "Lihe Wang",
    "Jan Kristensen",
    "Frank Duzaar",
    "Klaus Ecker",
    # Geometric
    "Richard Schoen",
    "Shing-Tung Yau",
    "Frederick Almgren",
    "Leon Simon",
    "William Meeks",
    "Gerhard Huisken",
    "Tobias Colding",
    "William Minicozzi",
    # Optimal Control
    "Wendell Fleming",
    "Hitoshi Ishii",
    "Guy Barles",
    "Michael Crandall",
    # Convexity
    "John Ball",
    "Kewei Zhang",
    "Sergio Conti",
    "Georg Dolzmann",
    "Bernd Kirchheim",
    # Gamma-convergence
    "Adriana Garroni",
    "Roberto Alicandro",
    "Marco Cicalese",
    "Matteo Focardi",
    "Anastasija Pešić",
    # Optimal Transport
    "Giuseppe Savaré",
    "Nicola Gigli",
    "Karl-Theodor Sturm",
    "Filippo Santambrogio",
    "Wilfrid Gangbo",
    "Craig Evans",
    # Free discontinuity/Phase field
    "Massimiliano Morini",
    "Antonin Chambolle",
    "Matteo Novaga",
    "Giovanni Alberti",
    "Sylvia Serfaty",
    "Etienne Sandier",
    "Fabrice Bethuel",
    "Guido De Philippis",
    # Additional key researchers
    "Giuseppe Buttazzo",
    "François Murat",
    "Luc Tartar",
    "Luis Caffarelli",
    "Maria Colombo",
    "Vladimir Šverák",
    "Robert V. Kohn",
    "Andrea Malchiodi",
    "Nassif Ghoussoub",
    "Giuseppe Mingione",
    "Enrico Valdinoci",
    "Ovidiu Savin",
    "Xavier Cabré",
    "Henri Berestycki",
    "Luis Silvestre",
    "Tobias Rivière",
    "Filippo Cagnetti",
    "Dorin Bucur",
    "Gilles Francfort",
]

# Domain tags and lexical signals for calculus of variations subfields.
DOMAIN_TERMS = {
    "classical_calcvar": [
        "euler-lagrange",
        "euler lagrange",
        "first variation",
        "second variation",
        "legendre condition",
        "weierstrass",
        "calculus of variations",
        "variational problem",
        "variational principle",
    ],
    "direct_methods": [
        "lower semicontinuity",
        "coercivity",
        "weak convergence",
        "sobolev",
        "reflexive",
        "direct method",
        "minimizing sequence",
        "weak lower semicontinuity",
        "existence theorem",
        "compactness",
        "weak topology",
        "functional analysis",
        "banach space",
        "morrey",
        "growth condition",
    ],
    "regularity": [
        "partial regularity",
        "hölder continuity",
        "holder continuity",
        "de giorgi",
        "moser",
        "nash",
        "regularity of minimizers",
        "elliptic regularity",
        "schauder",
        "hölder",
        "lipschitz",
        "harnack",
        "a priori estimates",
        "bootstrap",
        "blow-up",
        "singular set",
        "hausdorff dimension",
        "almgren",
        "regularity elliptic",
        "mingione",
    ],
    "geometric": [
        "minimal surfaces",
        "minimal surface",
        "harmonic maps",
        "harmonic map",
        "geodesics",
        "geodesic",
        "curvature flow",
        "plateau problem",
        "area functional",
        "willmore",
        "mean curvature",
        "ricci flow",
        "varifold",
        "current",
        "rectifiable",
        "geometric measure",
        "area minimizing",
        "stationary varifold",
        "constant mean curvature",
    ],
    "optimal_control": [
        "pontryagin",
        "bellman",
        "hamilton-jacobi",
        "hamilton jacobi",
        "viscosity solutions",
        "viscosity solution",
        "optimal control",
        "dynamic programming",
    ],
    "convexity": [
        "quasiconvexity",
        "quasiconvex",
        "polyconvexity",
        "polyconvex",
        "rank-one convexity",
        "rank one convexity",
        "relaxation",
        "young measures",
        "young measure",
        "convex integration",
        "nonlinear elasticity",
        "martensitic",
        "shape memory",
        "laminates",
        "rank-one connection",
        "tartar conjecture",
        "morrey conjecture",
        "differential inclusion",
        "rigidity estimate",
    ],
    "gamma_convergence": [
        "gamma-convergence",
        "gamma convergence",
        "homogenization",
        "thin structures",
        "dimension reduction",
        "asymptotic analysis",
        "energy scaling",
        "scaling law",
        "microstructure",
        "thin film",
        "epitaxial",
        "mosco convergence",
        "epi-convergence",
        "variational limit",
        "effective energy",
        "continuum limit",
        "discrete to continuum",
        "stochastic homogenization",
    ],
    "optimal_transport": [
        "wasserstein",
        "monge-kantorovich",
        "monge kantorovich",
        "brenier",
        "displacement convexity",
        "optimal transport",
        "mass transport",
        "kantorovich",
        "gradient flow",
        "jko scheme",
        "benamou-brenier",
        "entropic regularization",
        "sinkhorn",
        "wasserstein gradient",
        "otto calculus",
    ],
    "free_discontinuity": [
        "mumford-shah",
        "free discontinuity",
        "sbv",
        "special functions of bounded variation",
        "segmentation",
        "crack propagation",
        "fracture mechanics variational",
        "phase field",
        "ginzburg-landau",
        "allen-cahn",
        "cahn-hilliard",
        "sharp interface limit",
        "diffuse interface",
        "modica-mortola",
    ],
}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_space(text):
    return re.sub(r"\s+", " ", text or "").strip()


def normalize_quotes(text):
    """Replace curly/smart quotes with ASCII equivalents."""
    if not text:
        return text
    return text.replace("\u2018", "'").replace("\u2019", "'").replace(
        "\u201c", '"').replace("\u201d", '"').replace("`", "'")


def normalize_doi(doi):
    if not doi:
        return None
    value = doi.strip()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
    value = value.strip().lower()
    return value or None


def normalize_arxiv(arxiv_id):
    if not arxiv_id:
        return None
    value = arxiv_id.strip()
    value = re.sub(r"^https?://arxiv\.org/abs/", "", value, flags=re.IGNORECASE)
    value = value.lower()
    return value or None


def short_openalex_id(openalex_id):
    if not openalex_id:
        return None
    value = openalex_id.strip()
    m = re.search(r"/([AW]\d+)$", value)
    if m:
        return m.group(1)
    return value


def invert_abstract(idx):
    """Convert OpenAlex abstract_inverted_index to plain text."""
    if not isinstance(idx, dict) or not idx:
        return ""
    max_pos = -1
    for positions in idx.values():
        if not positions:
            continue
        max_pos = max(max_pos, max(positions))
    if max_pos < 0:
        return ""
    words = [""] * (max_pos + 1)
    for token, positions in idx.items():
        for pos in positions:
            if 0 <= pos < len(words) and not words[pos]:
                words[pos] = token
    return normalize_space(" ".join(words))


def normalize_title_key(title):
    text = (title or "").lower()
    # Strip literal escape sequences from OpenAlex titles (e.g. literal \n, \t).
    text = re.sub(r"\\[nrt]", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def term_in_text(term, text):
    """Phrase/term matching with word boundaries to avoid substring false positives."""
    escaped = re.escape(term.lower())
    escaped = escaped.replace(r"\ ", r"[\s\-]+")
    if re.fullmatch(r"[a-z0-9]{1,4}", term.lower()):
        pattern = rf"\b{escaped}\b"
    else:
        pattern = rf"(?<![a-z0-9]){escaped}(?![a-z0-9])"
    return re.search(pattern, text) is not None


def http_get_json(path, params=None, retries=5, pause=0.15):
    params = params or {}
    query = urllib.parse.urlencode(params, doseq=True)
    url = f"{OPENALEX_BASE}{path}"
    if query:
        url = f"{url}?{query}"
    last_err = None

    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [
                    "curl",
                    "-fsSL",
                    "--connect-timeout",
                    "10",
                    "--max-time",
                    "30",
                    "-A",
                    USER_AGENT,
                    "--resolve",
                    "api.openalex.org:443:104.20.26.229",
                    url,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(proc.stdout)
        except Exception as err:  # noqa: BLE001
            last_err = err
            if attempt == retries:
                break
            backoff = pause * (2 ** attempt)
            time.sleep(backoff)
    raise RuntimeError(f"OpenAlex request failed after retries: {url}") from last_err


def http_post_json(url, body, retries=5, pause=1.0):
    """POST JSON to a URL via curl, with retries and exponential backoff."""
    payload_str = json.dumps(body)
    last_err = None

    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [
                    "curl",
                    "-fsSL",
                    "--connect-timeout",
                    "10",
                    "--max-time",
                    "60",
                    "-A",
                    USER_AGENT,
                    "-H",
                    "Content-Type: application/json",
                    "--data",
                    "@-",
                    url,
                ],
                input=payload_str,
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(proc.stdout)
        except Exception as err:  # noqa: BLE001
            last_err = err
            if attempt == retries:
                break
            backoff = pause * (2 ** attempt)
            time.sleep(backoff)
    raise RuntimeError(f"POST request failed after retries: {url}") from last_err


def paper_id_to_ss_id(paper):
    """Convert a paper's canonical ID to Semantic Scholar format.

    Returns an SS-compatible ID string, or None if no usable identifier.
    SS accepts: DOI:xxx, ARXIV:xxx, CorpusId:xxx
    """
    doi = paper.get("doi")
    arxiv_id = paper.get("arxiv_id")

    # For arxiv DOIs (10.48550/arxiv.XXXX), extract the arXiv ID directly.
    if doi and re.match(r"10\.48550/arxiv\.", doi, re.IGNORECASE):
        extracted = re.sub(r"^10\.48550/arxiv\.", "", doi, flags=re.IGNORECASE)
        return f"ARXIV:{extracted}"

    if arxiv_id:
        return f"ARXIV:{arxiv_id}"

    if doi:
        return f"DOI:{doi}"

    return None


def _all_ss_ids_for_paper(paper):
    """Return all possible SS IDs for a paper (primary ID + aliases).

    This handles merged papers where the canonical ID might use a published DOI
    but the arXiv version (in aliases) is what SS knows.
    """
    ids = set()

    # From primary fields.
    primary = paper_id_to_ss_id(paper)
    if primary:
        ids.add(primary)

    # From aliases — extract DOI/arXiv from doi:xxx or arxiv:xxx format.
    for alias in paper.get("aliases") or []:
        if alias.startswith("doi:"):
            doi = alias[4:]
            if re.match(r"10\.48550/arxiv\.", doi, re.IGNORECASE):
                extracted = re.sub(r"^10\.48550/arxiv\.", "", doi, flags=re.IGNORECASE)
                ids.add(f"ARXIV:{extracted}")
            else:
                ids.add(f"DOI:{doi}")
        elif alias.startswith("arxiv:"):
            ids.add(f"ARXIV:{alias[6:]}")

    return ids


def ss_batch_citations(papers):
    """Query Semantic Scholar batch endpoint for citation counts.

    Returns dict mapping our canonical paper ID to SS result dict.
    Queries all known IDs (primary + aliases) and keeps the best result.
    """
    # Build mapping: SS ID -> our paper ID
    ss_to_ours = {}
    for paper in papers:
        for ss_id in _all_ss_ids_for_paper(paper):
            ss_to_ours[ss_id] = paper["id"]

    if not ss_to_ours:
        return {}

    ss_ids = list(ss_to_ours.keys())
    results = {}
    batch_size = 500
    url = f"{SEMANTIC_SCHOLAR_BASE}/paper/batch"

    for i in range(0, len(ss_ids), batch_size):
        chunk = ss_ids[i : i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(ss_ids) + batch_size - 1) // batch_size
        print(
            f"  SS batch {batch_num}/{total_batches}: {len(chunk)} papers...",
            flush=True,
        )

        try:
            response = http_post_json(
                f"{url}?fields=citationCount,externalIds",
                {"ids": chunk},
            )
        except RuntimeError as err:
            print(f"  WARNING: SS batch {batch_num} failed: {err}", flush=True)
            continue

        if not isinstance(response, list):
            print(f"  WARNING: SS batch {batch_num} unexpected response type", flush=True)
            continue

        for ss_id, result in zip(chunk, response):
            our_id = ss_to_ours[ss_id]
            if result is None:
                continue
            existing = results.get(our_id)
            if existing is None or (result.get("citationCount") or 0) > (existing.get("citationCount") or 0):
                results[our_id] = result

        # Rate limit between batches.
        if i + batch_size < len(ss_ids):
            time.sleep(1.0)

    return results


def enrich_with_semantic_scholar(papers):
    """Enrich papers with Semantic Scholar citation counts.

    For each paper, stores `ss_cited_by_count` and updates `cited_by_count`
    to max(openalex, semantic_scholar).

    Returns (enriched_count, not_found_count).
    """
    print("Querying Semantic Scholar for citation counts...", flush=True)

    ss_results = ss_batch_citations(papers)

    enriched = 0
    not_found = 0

    for paper in papers:
        pid = paper["id"]
        ss_data = ss_results.get(pid)
        if ss_data is None:
            not_found += 1
            paper["ss_cited_by_count"] = 0
            continue

        ss_count = ss_data.get("citationCount") or 0
        paper["ss_cited_by_count"] = ss_count

        oa_count = paper.get("cited_by_count") or 0
        if ss_count > oa_count:
            paper["cited_by_count"] = ss_count
            enriched += 1

    print(
        f"  Semantic Scholar: {enriched} papers updated, "
        f"{not_found} not found, "
        f"{len(papers) - enriched - not_found} unchanged",
        flush=True,
    )
    return enriched, not_found


def author_name_tokens(name):
    return [t for t in re.findall(r"[a-z0-9]+", (name or "").lower()) if t]


def resolve_author(author_name):
    payload = http_get_json(
        "/authors",
        {
            "search": author_name,
            "per-page": 10,
            "select": "id,display_name,works_count,cited_by_count",
        },
    )
    candidates = payload.get("results", [])
    if not candidates:
        return None

    target_tokens = set(author_name_tokens(author_name))
    best = None
    best_score = float("-inf")
    for cand in candidates:
        display = cand.get("display_name", "")
        cand_tokens = set(author_name_tokens(display))
        overlap = len(target_tokens & cand_tokens)
        exact = 1 if display.strip().lower() == author_name.strip().lower() else 0
        starts = 1 if display.strip().lower().startswith(author_name.strip().lower()) else 0
        score = (
            exact * 100
            + starts * 20
            + overlap * 8
            + math.log1p(cand.get("works_count", 0))
            + math.log1p(cand.get("cited_by_count", 0)) * 0.2
        )
        if score > best_score:
            best_score = score
            best = cand
    return best


def canonical_paper_id(doi, arxiv_id, openalex_id, title, year):
    if doi:
        return f"doi:{doi}"
    if arxiv_id:
        return f"arxiv:{arxiv_id}"
    if openalex_id:
        return f"openalex:{short_openalex_id(openalex_id)}"
    title_key = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return f"title:{title_key}:{year or 'na'}"


def paper_from_openalex(work):
    title = normalize_space(work.get("title") or work.get("display_name") or "")
    if not title:
        return None

    ids = work.get("ids") or {}
    doi = normalize_doi(work.get("doi") or ids.get("doi"))
    arxiv_id = normalize_arxiv(ids.get("arxiv"))
    # Fallback: extract arXiv ID from arXiv DOI (10.48550/arXiv.XXXX.XXXXX)
    if not arxiv_id and doi:
        m = re.match(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})", doi, re.IGNORECASE)
        if m:
            arxiv_id = m.group(1)
    openalex_id = work.get("id") or ids.get("openalex")

    primary_location = work.get("primary_location") or {}
    source_obj = primary_location.get("source") or {}
    venue = normalize_space(source_obj.get("display_name") or "")
    url = primary_location.get("landing_page_url")
    if not url and doi:
        url = f"https://doi.org/{doi}"
    if not url:
        url = openalex_id

    authorships = work.get("authorships") or []
    authors = []
    for a in authorships:
        author = (a or {}).get("author") or {}
        name = normalize_quotes(normalize_space(author.get("display_name") or ""))
        if name:
            authors.append(name)

    abstract_text = invert_abstract(work.get("abstract_inverted_index"))
    concept_terms = []
    for c in (work.get("concepts") or [])[:15]:
        name = normalize_space((c or {}).get("display_name") or "")
        if name:
            concept_terms.append(name.lower())
    keyword_terms = []
    for k in (work.get("keywords") or [])[:20]:
        name = normalize_space((k or {}).get("display_name") or "")
        if name:
            keyword_terms.append(name.lower())

    year = work.get("publication_year")
    try:
        year = int(year) if year is not None else None
    except (TypeError, ValueError):
        year = None

    cited_by_count = work.get("cited_by_count")
    try:
        cited_by_count = int(cited_by_count) if cited_by_count is not None else 0
    except (TypeError, ValueError):
        cited_by_count = 0

    # Extract referenced OpenAlex work IDs (short form) for citation graph.
    referenced_works = []
    for ref_id in work.get("referenced_works") or []:
        short = short_openalex_id(ref_id)
        if short:
            referenced_works.append(short)

    return {
        "id": canonical_paper_id(doi, arxiv_id, openalex_id, title, year),
        "title": title,
        "year": year,
        "authors": authors,
        "venue": venue or None,
        "doi": doi,
        "arxiv_id": arxiv_id,
        "eprint_id": None,
        "url": url,
        "openalex_id": openalex_id,
        "cited_by_count": cited_by_count,
        "referenced_works": referenced_works,
        "type": work.get("type"),
        "abstract_text": abstract_text,
        "concept_terms": concept_terms,
        "keyword_terms": keyword_terms,
    }


def score_paper(paper, known_researchers, min_year):
    title = (paper.get("title") or "").lower()
    abstract = (paper.get("abstract_text") or "").lower()
    concepts = " ".join(paper.get("concept_terms") or [])
    keywords = " ".join(paper.get("keyword_terms") or [])
    text = " ".join([title, abstract, concepts, keywords])
    score = 0.0
    reasons = []
    tags = set()

    year = paper.get("year")
    if year is None or year < min_year:
        reasons.append("below_min_year")
        return -999.0, reasons, sorted(tags), 0

    # Core calculus of variations terms in title/abstract.
    has_calcvar = (
        term_in_text("calculus of variations", text)
        or term_in_text("variational method", text)
        or term_in_text("variational problem", text)
        or term_in_text("euler-lagrange", text)
        or term_in_text("euler lagrange", text)
    )
    if has_calcvar:
        score += 6.0
        reasons.append("mentions_calcvar(+6)")
        tags.add("classical_calcvar")

    # Additional core variational terms boost.
    core_variational = [
        "variational inequality",
        "variational formulation",
        "variational principle",
        "minimization problem",
        "energy functional",
        "functional minimization",
    ]
    core_matches = sum(1 for t in core_variational if term_in_text(t, text))
    if core_matches > 0:
        core_pts = min(4.0, 1.5 * core_matches)
        score += core_pts
        reasons.append(f"core_variational(+{core_pts:.1f})")
        tags.add("classical_calcvar")

    # Domain-specific term matching.
    matched_domains = 0
    for domain, terms in DOMAIN_TERMS.items():
        matches = []
        for term in terms:
            if term_in_text(term, text):
                matches.append(term)
        if matches:
            matched_domains += 1
            tags.add(domain)
            domain_points = min(3.0, 0.8 * len(set(matches)))
            score += domain_points
            reasons.append(f"domain_{domain}(+{domain_points:.1f})")

    # Known researcher boost.
    matched_authors = []
    for author in paper.get("authors", []):
        if author.lower() in known_researchers:
            matched_authors.append(author)
    if matched_authors:
        author_points = min(6.0, 2.0 * len(set(matched_authors)))
        score += author_points
        reasons.append(f"known_researcher(+{author_points:.1f})")
        tags.add("known-authors")

    # Citation count boost.
    cited_by = paper.get("cited_by_count") or 0
    if cited_by >= 200:
        score += 2.0
        reasons.append("high_citations_200(+2)")
    elif cited_by >= 50:
        score += 1.0
        reasons.append("citations_50(+1)")

    # Guardrail: generic math papers should still have clear calcvar relevance.
    if not has_calcvar and matched_domains < 2 and not matched_authors:
        score -= 4.0
        reasons.append("weak_calcvar_signal(-4)")

    # Small boost for landmark older papers (pre-1980) that are highly cited.
    if year and year < 1980 and cited_by >= 100:
        score += 1.5
        reasons.append("landmark_classic(+1.5)")

    return score, reasons, sorted(tags), matched_domains


def merge_seed(seed_path):
    if not seed_path.exists():
        return {}
    with open(seed_path) as f:
        raw = json.load(f)
    rows = raw.get("papers", []) if isinstance(raw, dict) else []

    out = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        doi = normalize_doi(row.get("doi"))
        arxiv_id = normalize_arxiv(row.get("arxiv_id"))
        pid = row.get("id")
        if not pid:
            pid = canonical_paper_id(doi, arxiv_id, row.get("openalex_id"), row.get("title"), row.get("year"))
        out[pid] = {
            "id": pid,
            "title": normalize_space(row.get("title") or ""),
            "year": row.get("year"),
            "authors": [normalize_space(a) for a in (row.get("authors") or []) if normalize_space(a)],
            "venue": normalize_space(row.get("venue") or "") or None,
            "doi": doi,
            "arxiv_id": arxiv_id,
            "eprint_id": normalize_space(row.get("eprint_id") or "") or None,
            "url": row.get("url"),
            "openalex_id": row.get("openalex_id"),
            "cited_by_count": row.get("cited_by_count") or 0,
            "source": row.get("source") or "seed",
            "tags": sorted({(t or "").strip().lower() for t in (row.get("tags") or []) if (t or "").strip()}),
            "seed": True,
        }
    return out


def _is_arxiv_doi(doi):
    """True if the DOI is an arXiv preprint DOI (10.48550/arxiv.xxx)."""
    return bool(doi and re.match(r"10\.48550/arxiv\.", doi, re.IGNORECASE))


def merge_paper_rows(existing, incoming):
    # Collect both DOIs/years before the base swap can clobber them.
    both_dois = [d for d in (existing.get("doi"), incoming.get("doi")) if d]
    both_years = [y for y in (existing.get("year"), incoming.get("year")) if y]
    both_arxiv = [a for a in (existing.get("arxiv_id"), incoming.get("arxiv_id")) if a]
    both_openalex = [o for o in (existing.get("openalex_id"), incoming.get("openalex_id")) if o]
    both_urls = [u for u in (existing.get("url"), incoming.get("url")) if u]
    both_venues = [v for v in (existing.get("venue"), incoming.get("venue")) if v]

    if (incoming.get("relevance_score") or 0) > (existing.get("relevance_score") or 0):
        # Keep stronger row as base but preserve existing id aliases.
        base = dict(incoming)
        aliases = set(existing.get("aliases") or [])
        aliases.add(existing.get("id"))
        aliases.update(incoming.get("aliases") or [])
        base["aliases"] = sorted(a for a in aliases if a and a != base.get("id"))
        existing.clear()
        existing.update(base)
    else:
        aliases = set(existing.get("aliases") or [])
        aliases.add(incoming.get("id"))
        aliases.update(incoming.get("aliases") or [])
        existing["aliases"] = sorted(a for a in aliases if a and a != existing.get("id"))

    existing["cited_by_count"] = max(existing.get("cited_by_count") or 0, incoming.get("cited_by_count") or 0)
    existing["ss_cited_by_count"] = max(existing.get("ss_cited_by_count") or 0, incoming.get("ss_cited_by_count") or 0)
    existing["relevance_score"] = max(existing.get("relevance_score") or 0, incoming.get("relevance_score") or 0)

    # Keep richer referenced_works list
    if len(incoming.get("referenced_works") or []) > len(existing.get("referenced_works") or []):
        existing["referenced_works"] = incoming["referenced_works"]

    for k in ("authors", "tags", "relevance_reasons", "matched_queries", "source_types"):
        vals = set(existing.get(k) or [])
        vals.update(incoming.get(k) or [])
        existing[k] = sorted(v for v in vals if v)

    # Prefer the published (non-arXiv) DOI when merging preprint + published.
    published_dois = [d for d in both_dois if not _is_arxiv_doi(d)]
    if published_dois:
        existing["doi"] = published_dois[0]
    elif both_dois:
        existing["doi"] = both_dois[0]

    if not existing.get("arxiv_id") and both_arxiv:
        existing["arxiv_id"] = both_arxiv[0]
    if not existing.get("openalex_id") and both_openalex:
        existing["openalex_id"] = both_openalex[0]
    if not existing.get("url") and both_urls:
        existing["url"] = both_urls[0]
    if not existing.get("venue") and both_venues:
        existing["venue"] = both_venues[0]

    # Prefer the later year (published version) and update the canonical ID
    # to use the published DOI.
    if both_years:
        existing["year"] = max(both_years)
    new_doi = existing.get("doi")
    new_arxiv = existing.get("arxiv_id")
    new_oa = existing.get("openalex_id")
    new_id = canonical_paper_id(new_doi, new_arxiv, new_oa, existing.get("title"), existing.get("year"))
    if new_id != existing.get("id"):
        aliases = set(existing.get("aliases") or [])
        aliases.add(existing["id"])
        aliases.discard(new_id)
        existing["aliases"] = sorted(a for a in aliases if a)
        existing["id"] = new_id

    return existing


def dedupe_accepted_papers(papers):
    deduped = {}
    for paper in papers:
        key = normalize_title_key(paper.get("title") or "")
        if key not in deduped:
            deduped[key] = paper
        else:
            deduped[key] = merge_paper_rows(deduped[key], paper)
    return list(deduped.values())


def build_database(min_score, min_year, query_pages, author_pages, per_page):
    known_researchers = set()
    for name in AUTHOR_SEEDS:
        known_researchers.add(name.lower())

    # Include researchers from seed authors to widen coverage.
    seed_rows = merge_seed(SEED_PATH)
    for p in seed_rows.values():
        for name in p.get("authors", []):
            known_researchers.add(name.lower())

    work_candidates = {}

    def upsert_candidate(paper, source_type, source_label):
        if not paper:
            return
        pid = paper["id"]
        entry = work_candidates.get(pid)
        if not entry:
            work_candidates[pid] = {
                "paper": paper,
                "source_types": {source_type},
                "source_labels": {source_label},
            }
            return

        entry["source_types"].add(source_type)
        entry["source_labels"].add(source_label)

        # Keep better metadata when available.
        existing = entry["paper"]
        if (paper.get("cited_by_count") or 0) > (existing.get("cited_by_count") or 0):
            existing["cited_by_count"] = paper.get("cited_by_count")
        if not existing.get("abstract_text") and paper.get("abstract_text"):
            existing["abstract_text"] = paper["abstract_text"]
        # Keep richer referenced_works list
        if len(paper.get("referenced_works") or []) > len(existing.get("referenced_works") or []):
            existing["referenced_works"] = paper["referenced_works"]
        if not existing.get("venue") and paper.get("venue"):
            existing["venue"] = paper["venue"]
        if not existing.get("url") and paper.get("url"):
            existing["url"] = paper["url"]
        if not existing.get("openalex_id") and paper.get("openalex_id"):
            existing["openalex_id"] = paper["openalex_id"]

        existing_authors = set(existing.get("authors") or [])
        for a in paper.get("authors") or []:
            if a not in existing_authors:
                existing.setdefault("authors", []).append(a)
                existing_authors.add(a)

        existing_concepts = set(existing.get("concept_terms") or [])
        for c in paper.get("concept_terms") or []:
            if c not in existing_concepts:
                existing.setdefault("concept_terms", []).append(c)
                existing_concepts.add(c)

        existing_keywords = set(existing.get("keyword_terms") or [])
        for k in paper.get("keyword_terms") or []:
            if k not in existing_keywords:
                existing.setdefault("keyword_terms", []).append(k)
                existing_keywords.add(k)

    work_select = ",".join([
        "id",
        "doi",
        "title",
        "display_name",
        "publication_year",
        "cited_by_count",
        "type",
        "ids",
        "authorships",
        "primary_location",
        "abstract_inverted_index",
        "concepts",
        "keywords",
        "referenced_works",
    ])

    print("Fetching keyword-based candidates from OpenAlex...", flush=True)
    keyword_requests = 0
    for q_idx, query in enumerate(KEYWORD_QUERIES, start=1):
        print(f"  query {q_idx}/{len(KEYWORD_QUERIES)}: {query}", flush=True)
        for page in range(1, query_pages + 1):
            payload = http_get_json(
                "/works",
                {
                    "search": query,
                    "page": page,
                    "per-page": per_page,
                    "filter": f"from_publication_date:{min_year}-01-01",
                    "select": work_select,
                },
            )
            keyword_requests += 1
            for raw_work in payload.get("results", []):
                paper = paper_from_openalex(raw_work)
                upsert_candidate(paper, "keyword", query)
            if not payload.get("results"):
                break
            time.sleep(0.12)

    print(f"  Keyword requests: {keyword_requests}", flush=True)
    print(f"  Candidates after keyword phase: {len(work_candidates)}", flush=True)

    # Author discovery starts with explicit seeds plus seed-paper authors.
    # Normalize quotes so e.g. D'Amato and D\u2019Amato don't create duplicates.
    author_names = set(normalize_quotes(n) for n in AUTHOR_SEEDS)
    for p in seed_rows.values():
        for a in p.get("authors", []):
            if a:
                author_names.add(normalize_quotes(a))

    print("Resolving author seeds...", flush=True)
    resolved_authors = {}
    seen_author_ids = {}  # OpenAlex author ID -> first seed name
    for name in sorted(author_names):
        resolved = resolve_author(name)
        if not resolved:
            continue
        author_id = short_openalex_id(resolved.get("id"))
        if not author_id:
            continue
        # Skip if we already resolved this OpenAlex author under a different name.
        if author_id in seen_author_ids:
            continue
        seen_author_ids[author_id] = name
        resolved_authors[name] = {
            "id": author_id,
            "display_name": resolved.get("display_name"),
        }
        time.sleep(0.08)

    print(f"  Resolved authors: {len(resolved_authors)}", flush=True)

    print("Fetching author-based candidates from OpenAlex...", flush=True)
    author_requests = 0
    for a_idx, (seed_name, author) in enumerate(resolved_authors.items(), start=1):
        print(f"  author {a_idx}/{len(resolved_authors)}: {seed_name}", flush=True)
        author_id = author["id"]
        for page in range(1, author_pages + 1):
            payload = http_get_json(
                "/works",
                {
                    "filter": f"authorships.author.id:{author_id},from_publication_date:{min_year}-01-01",
                    "sort": "cited_by_count:desc",
                    "page": page,
                    "per-page": per_page,
                    "select": work_select,
                },
            )
            author_requests += 1
            for raw_work in payload.get("results", []):
                paper = paper_from_openalex(raw_work)
                upsert_candidate(paper, "author", seed_name)
            if not payload.get("results"):
                break
            time.sleep(0.12)

    print(f"  Author requests: {author_requests}", flush=True)
    print(f"  Candidates after author phase: {len(work_candidates)}", flush=True)

    print("Scoring and filtering candidates...", flush=True)
    accepted = []
    rejected = 0
    domain_counter = Counter()
    source_counter = Counter()

    for entry in work_candidates.values():
        paper = entry["paper"]
        score, reasons, tags, matched_domains = score_paper(paper, known_researchers, min_year=min_year)
        paper["relevance_score"] = round(score, 3)
        paper["relevance_reasons"] = reasons
        paper["tags"] = sorted(set(tags))
        paper["matched_queries"] = sorted(entry["source_labels"])
        paper["source_types"] = sorted(entry["source_types"])
        paper["source"] = "openalex"
        paper.pop("abstract_text", None)
        paper.pop("concept_terms", None)
        paper.pop("keyword_terms", None)

        # Keep only papers with meaningful calcvar/domain evidence.
        # Seed authors are trusted — accept with lower score threshold.
        is_known_author = "known-authors" in paper["tags"]
        effective_min = min_score * 0.5 if is_known_author else min_score
        if score < effective_min:
            rejected += 1
            continue

        if (
            "mentions_calcvar(+6)" not in reasons
            and matched_domains < 2
            and not (is_known_author and matched_domains >= 0)
        ):
            rejected += 1
            continue

        accepted.append(paper)
        source_counter.update(paper.get("source_types") or [])
        domain_counter.update(t for t in paper.get("tags", []) if t in DOMAIN_TERMS)

    # Merge curated seed rows unconditionally.
    for seed_pid, seed_paper in seed_rows.items():
        existing = None
        for p in accepted:
            if p["id"] == seed_pid:
                existing = p
                break
        if existing:
            existing_tags = set(existing.get("tags") or [])
            existing_tags.update(seed_paper.get("tags") or [])
            existing["tags"] = sorted(existing_tags)
            existing["seed"] = True
            existing["source"] = "seed+openalex"
            reasons = set(existing.get("relevance_reasons") or [])
            reasons.add("curated_seed")
            existing["relevance_reasons"] = sorted(reasons)
            # Preserve useful seed metadata that OA might lack
            if not existing.get("arxiv_id") and seed_paper.get("arxiv_id"):
                existing["arxiv_id"] = seed_paper["arxiv_id"]
            if not existing.get("venue") and seed_paper.get("venue"):
                existing["venue"] = seed_paper["venue"]
            continue

        seeded = dict(seed_paper)
        seeded["relevance_score"] = max(float(min_score), 10.0)
        seeded["relevance_reasons"] = ["curated_seed"]
        seeded["matched_queries"] = []
        seeded["source_types"] = ["seed"]
        accepted.append(seeded)
        source_counter.update(["seed"])
        domain_counter.update(t for t in seeded.get("tags", []) if t in DOMAIN_TERMS)

    accepted = dedupe_accepted_papers(accepted)

    # ------------------------------------------------------------------
    # Citation expansion: discover papers our corpus cites frequently
    # but that weren't found by keyword/author search.
    # ------------------------------------------------------------------
    print("Citation expansion: finding frequently-cited missing papers...", flush=True)
    accepted_oa_ids = set()
    for p in accepted:
        oa = p.get("openalex_id", "")
        if oa:
            short = short_openalex_id(oa)
            if short:
                accepted_oa_ids.add(short)
            accepted_oa_ids.add(oa)

    # Count how many corpus papers cite each external paper
    external_ref_counts = Counter()
    for p in accepted:
        for ref_oa_id in p.get("referenced_works") or []:
            if ref_oa_id not in accepted_oa_ids:
                external_ref_counts[ref_oa_id] += 1

    # Papers cited by >= CITATION_EXPANSION_MIN corpus papers get auto-added
    CITATION_EXPANSION_MIN = 3
    expansion_ids = [
        oa_id for oa_id, count in external_ref_counts.most_common()
        if count >= CITATION_EXPANSION_MIN
    ]
    print(f"  {len(expansion_ids)} external papers cited by >={CITATION_EXPANSION_MIN} corpus papers", flush=True)

    if expansion_ids:
        expansion_added = 0
        # Batch-fetch from OpenAlex in chunks of 50
        for chunk_start in range(0, len(expansion_ids), 50):
            chunk = expansion_ids[chunk_start:chunk_start + 50]
            ids_filter = "|".join(f"https://openalex.org/{oid}" for oid in chunk)
            try:
                cursor = "*"
                while cursor:
                    data = http_get_json(
                        "/works",
                        {
                            "filter": f"openalex:{ids_filter}",
                            "select": work_select,
                            "per_page": 200,
                            "cursor": cursor,
                        },
                    )
                    for work in data.get("results", []):
                        paper = paper_from_openalex(work)
                        if not paper:
                            continue
                        # Check if already in accepted by ID
                        if any(a["id"] == paper["id"] for a in accepted):
                            continue
                        # Relevance gate: must have some calcvar signal
                        score, reasons, tags, matched_domains = score_paper(
                            paper, known_researchers, min_year,
                        )
                        has_calcvar = any("mentions_calcvar" in r for r in reasons)
                        if not has_calcvar and matched_domains < 2:
                            continue  # skip weakly related papers
                        cite_count = external_ref_counts.get(
                            short_openalex_id(work.get("id")), 0
                        )
                        paper["relevance_score"] = max(
                            float(min_score),
                            min(30.0, cite_count * 2.0),
                        )
                        paper["relevance_reasons"] = [
                            f"citation_expansion(cited_by={cite_count})"
                        ] + reasons
                        paper["tags"] = sorted(
                            set(tags) | {"citation-expanded"}
                        )
                        paper["matched_queries"] = []
                        paper["source_types"] = ["citation_expansion"]
                        paper["source"] = "citation_expansion"
                        paper.pop("abstract_text", None)
                        paper.pop("concept_terms", None)
                        paper.pop("keyword_terms", None)
                        accepted.append(paper)
                        expansion_added += 1
                        # Track the new OA ID to avoid re-fetching
                        new_short = short_openalex_id(work.get("id"))
                        if new_short:
                            accepted_oa_ids.add(new_short)
                    cursor = (data.get("meta") or {}).get("next_cursor")
                    if not data.get("results"):
                        break
            except Exception as err:
                print(f"  Warning: expansion batch failed: {err}", flush=True)

        accepted = dedupe_accepted_papers(accepted)
        print(f"  Added {expansion_added} papers via citation expansion", flush=True)
        source_counter.update({"citation_expansion": expansion_added})

    accepted.sort(
        key=lambda p: (
            -(p.get("relevance_score") or 0),
            -(p.get("cited_by_count") or 0),
            -(p.get("year") or 0),
            p.get("title", "").lower(),
        )
    )

    stats = {
        "candidate_count": len(work_candidates),
        "accepted_count": len(accepted),
        "rejected_count": rejected,
        "min_relevance_score": min_score,
        "min_year": min_year,
        "keyword_queries": len(KEYWORD_QUERIES),
        "resolved_authors": len(resolved_authors),
        "source_breakdown": dict(source_counter),
        "domain_breakdown": dict(domain_counter),
    }

    payload = {
        "version": 1,
        "generated_at": now_iso(),
        "description": (
            "Broad calculus of variations paper corpus from OpenAlex, filtered by "
            "explicit minimum relevance threshold."
        ),
        "config": {
            "min_relevance_score": min_score,
            "min_year": min_year,
            "query_pages": query_pages,
            "author_pages": author_pages,
            "per_page": per_page,
        },
        "queries": KEYWORD_QUERIES,
        "author_seeds": sorted(author_names),
        "stats": stats,
        "papers": accepted,
    }

    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(OUTPUT_PATH), help="Output JSON path")
    parser.add_argument("--min-score", type=float, default=8.0, help="Minimum relevance score")
    parser.add_argument("--min-year", type=int, default=1950, help="Minimum publication year")
    parser.add_argument("--query-pages", type=int, default=2, help="Pages per keyword query")
    parser.add_argument("--author-pages", type=int, default=1, help="Pages per author")
    parser.add_argument("--per-page", type=int, default=100, help="OpenAlex page size (<=200)")
    parser.add_argument(
        "--skip-ss",
        action="store_true",
        help="Skip Semantic Scholar citation enrichment",
    )
    args = parser.parse_args()

    output_path = Path(args.output)
    payload = build_database(
        min_score=args.min_score,
        min_year=args.min_year,
        query_pages=args.query_pages,
        author_pages=args.author_pages,
        per_page=max(1, min(200, args.per_page)),
    )

    # Semantic Scholar enrichment (after all OpenAlex collection and dedup).
    if not args.skip_ss:
        ss_enriched, ss_not_found = enrich_with_semantic_scholar(payload["papers"])
        payload["config"]["semantic_scholar"] = True
        payload["stats"]["ss_enriched"] = ss_enriched
        payload["stats"]["ss_not_found"] = ss_not_found
    else:
        print("Skipping Semantic Scholar enrichment (--skip-ss)", flush=True)

    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=True)
        f.write("\n")

    stats = payload["stats"]
    print(f"Written: {output_path}")
    print(
        "  "
        f"candidates={stats['candidate_count']}, accepted={stats['accepted_count']}, "
        f"rejected={stats['rejected_count']}"
    )
    print(f"  sources={stats['source_breakdown']}")
    print(f"  domains={stats['domain_breakdown']}")
    if "ss_enriched" in stats:
        print(
            f"  semantic_scholar: {stats['ss_enriched']} enriched, "
            f"{stats['ss_not_found']} not found"
        )


if __name__ == "__main__":
    main()
