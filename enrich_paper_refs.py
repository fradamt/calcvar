#!/usr/bin/env python3
"""Enrich papers-db.json with referenced_works from OpenAlex and Semantic Scholar.

Multi-pass enrichment pipeline:
  Pass 1: OpenAlex batch by OA ID (papers missing referenced_works)
  Pass 2: OpenAlex DOI-based fallback (preprint -> published version)
  Pass 3: Semantic Scholar batch POST (all papers -- union with OA refs)
  Pass 4: Semantic Scholar per-paper fallback (remaining papers without refs)

Usage:
    python3 enrich_paper_refs.py
    python3 enrich_paper_refs.py --dry-run   # preview without writing
"""

import argparse
import json
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PAPERS_DB_PATH = SCRIPT_DIR / "papers-db.json"
OPENALEX_BASE = "https://api.openalex.org"
SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1"
USER_AGENT = "calcvar-papers-builder/1.0"

# OpenAlex filter supports up to 50 IDs per pipe-separated list
BATCH_SIZE = 50
# SS batch POST supports up to 500 papers per request
SS_BATCH_SIZE = 500
# Semantic Scholar rate limit: 100 requests / 5 min for unauthenticated
SS_PAUSE = 3.2  # seconds between requests (~19/min, safe margin)


def short_openalex_id(openalex_id):
    if not openalex_id:
        return None
    value = openalex_id.strip()
    m = re.search(r"/([AW]\d+)$", value)
    if m:
        return m.group(1)
    return value


def http_get_json(path, params=None, retries=5, pause=0.15):
    params = params or {}
    query = urllib.parse.urlencode(params, doseq=True)
    url = f"{OPENALEX_BASE}{path}"
    if query:
        url = f"{url}?{query}"

    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [
                    "curl", "-fsSL",
                    "--connect-timeout", "10",
                    "--max-time", "30",
                    "-A", USER_AGENT,
                    "--resolve", "api.openalex.org:443:104.20.26.229",
                    url,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(proc.stdout)
        except Exception as err:
            if attempt == retries:
                raise RuntimeError(f"OpenAlex request failed: {url}") from err
            time.sleep(pause * (2 ** attempt))


def ss_get_json(path, retries=3, pause=1.0):
    """GET JSON from Semantic Scholar API via curl."""
    url = f"{SEMANTIC_SCHOLAR_BASE}{path}"
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [
                    "curl", "-fsSL",
                    "--connect-timeout", "10",
                    "--max-time", "30",
                    "-A", USER_AGENT,
                    url,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(proc.stdout)
        except Exception as err:
            if attempt == retries:
                return None  # Soft fail for SS -- don't crash
            time.sleep(pause * (2 ** attempt))


def ss_post_json(path, body, retries=3, pause=1.0):
    """POST JSON to Semantic Scholar API via curl."""
    url = f"{SEMANTIC_SCHOLAR_BASE}{path}"
    body_json = json.dumps(body)
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [
                    "curl", "-fsSL",
                    "--connect-timeout", "10",
                    "--max-time", "60",
                    "-X", "POST",
                    "-H", "Content-Type: application/json",
                    "-A", USER_AGENT,
                    "-d", body_json,
                    url,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(proc.stdout)
        except Exception as err:
            if attempt == retries:
                return None  # Soft fail for SS
            time.sleep(pause * (2 ** attempt))


def ss_paper_id(paper):
    """Build a Semantic Scholar paper identifier from our paper record."""
    # Prefer arXiv ID -- SS handles ARXIV: better than arXiv DOIs
    arxiv = paper.get("arxiv_id")
    if arxiv:
        return f"ARXIV:{arxiv}"
    doi = paper.get("doi")
    if doi:
        # Extract arXiv ID from arXiv DOI (10.48550/arXiv.XXXX.XXXXX)
        m = re.match(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})", doi, re.IGNORECASE)
        if m:
            return f"ARXIV:{m.group(1)}"
        return f"DOI:{doi}"
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    print("Loading papers-db.json...")
    with open(PAPERS_DB_PATH) as f:
        payload = json.load(f)

    papers = payload.get("papers", [])
    print(f"  {len(papers)} papers loaded")

    has_refs_initial = sum(1 for p in papers if p.get("referenced_works"))
    print(f"  {has_refs_initial} already have referenced_works")

    if args.dry_run:
        needs = sum(1 for p in papers if not p.get("referenced_works"))
        print(f"Dry run -- {needs} papers need enrichment.")
        return

    # -----------------------------------------------------------------------
    # Pass 1: OpenAlex batch by OA ID (papers missing referenced_works)
    # -----------------------------------------------------------------------
    needs_refs = []
    for paper in papers:
        oa_id = paper.get("openalex_id")
        if not oa_id:
            continue
        short = short_openalex_id(oa_id)
        if not short:
            continue
        if paper.get("referenced_works"):
            continue
        needs_refs.append((short, paper))

    print(f"\nPass 1: OpenAlex batch by OA ID for {len(needs_refs)} papers...")
    enriched = 0
    total_refs = 0
    batches = [needs_refs[i:i + BATCH_SIZE] for i in range(0, len(needs_refs), BATCH_SIZE)]

    for batch_idx, batch in enumerate(batches, 1):
        ids_filter = "|".join(f"https://openalex.org/{short}" for short, _ in batch)
        print(f"  Batch {batch_idx}/{len(batches)} ({len(batch)} papers)...", flush=True)

        batch_lookup = {short: paper for short, paper in batch}
        cursor = "*"
        while cursor:
            data = http_get_json(
                "/works",
                {
                    "filter": f"openalex:{ids_filter}",
                    "select": "id,referenced_works",
                    "per_page": 200,
                    "cursor": cursor,
                },
            )
            for work in data.get("results", []):
                work_id = short_openalex_id(work.get("id"))
                if work_id and work_id in batch_lookup:
                    refs = []
                    for ref_id in work.get("referenced_works") or []:
                        short_ref = short_openalex_id(ref_id)
                        if short_ref:
                            refs.append(short_ref)
                    batch_lookup[work_id]["referenced_works"] = refs
                    enriched += 1
                    total_refs += len(refs)
            meta = data.get("meta", {})
            cursor = meta.get("next_cursor")
            if not data.get("results"):
                break
        time.sleep(0.2)

    print(f"  Enriched {enriched} papers with {total_refs} total references")

    # -----------------------------------------------------------------------
    # Pass 2: DOI-based fallback for papers still missing referenced_works.
    # -----------------------------------------------------------------------
    still_missing = []
    for paper in papers:
        doi = paper.get("doi")
        if not doi:
            continue
        if paper.get("referenced_works"):
            continue
        still_missing.append(paper)

    if still_missing:
        print(f"\nPass 2: DOI-based fallback for {len(still_missing)} papers...")
        doi_enriched = 0
        doi_total_refs = 0

        doi_batches = [
            still_missing[i:i + BATCH_SIZE]
            for i in range(0, len(still_missing), BATCH_SIZE)
        ]

        for batch_idx, batch in enumerate(doi_batches, 1):
            doi_filter = "|".join(
                f"https://doi.org/{p['doi']}" for p in batch
            )
            print(f"  Batch {batch_idx}/{len(doi_batches)} ({len(batch)} papers)...", flush=True)

            doi_lookup = {}
            for p in batch:
                doi_lookup[p["doi"].lower()] = p

            cursor = "*"
            while cursor:
                data = http_get_json(
                    "/works",
                    {
                        "filter": f"doi:{doi_filter}",
                        "select": "id,doi,referenced_works",
                        "per_page": 200,
                        "cursor": cursor,
                    },
                )
                for work in data.get("results", []):
                    work_refs = work.get("referenced_works") or []
                    if not work_refs:
                        continue
                    work_doi = (work.get("doi") or "").replace("https://doi.org/", "").lower()
                    if work_doi and work_doi in doi_lookup:
                        paper = doi_lookup[work_doi]
                        if len(work_refs) > len(paper.get("referenced_works") or []):
                            refs = []
                            for ref_id in work_refs:
                                short_ref = short_openalex_id(ref_id)
                                if short_ref:
                                    refs.append(short_ref)
                            paper["referenced_works"] = refs
                            new_oa = work.get("id")
                            if new_oa:
                                paper["openalex_id"] = new_oa
                            doi_enriched += 1
                            doi_total_refs += len(refs)
                meta = data.get("meta", {})
                cursor = meta.get("next_cursor")
                if not data.get("results"):
                    break
            time.sleep(0.2)

        print(f"  DOI fallback enriched {doi_enriched} papers with {doi_total_refs} total references")

    # -----------------------------------------------------------------------
    # Pass 3: Semantic Scholar batch POST for ALL papers with a DOI/arXiv ID.
    # Uses POST /paper/batch with references.externalIds field.
    # This UNIONS SS references with any existing OA references.
    # -----------------------------------------------------------------------
    # Build lookup: OA short ID / DOI / arXiv -> paper in our corpus
    oa_by_doi = {}
    oa_by_arxiv = {}
    oa_by_short = {}
    for paper in papers:
        doi = paper.get("doi")
        if doi:
            oa_by_doi[doi.lower()] = short_openalex_id(paper.get("openalex_id"))
        arxiv = paper.get("arxiv_id")
        if arxiv:
            oa_by_arxiv[arxiv.lower()] = short_openalex_id(paper.get("openalex_id"))
        oa_id = short_openalex_id(paper.get("openalex_id"))
        if oa_id:
            oa_by_short[oa_id] = paper

    # Collect SS identifiers for all papers
    ss_id_to_paper = {}
    for paper in papers:
        sid = ss_paper_id(paper)
        if sid:
            ss_id_to_paper[sid] = paper

    ss_ids = list(ss_id_to_paper.keys())
    if ss_ids:
        print(f"\nPass 3: Semantic Scholar batch for {len(ss_ids)} papers (union with OA refs)...")
        ss_batch_enriched = 0
        ss_batch_added_refs = 0

        ss_batches = [ss_ids[i:i + SS_BATCH_SIZE] for i in range(0, len(ss_ids), SS_BATCH_SIZE)]
        for batch_idx, batch in enumerate(ss_batches, 1):
            print(f"  Batch {batch_idx}/{len(ss_batches)} ({len(batch)} papers)...", flush=True)
            data = ss_post_json(
                "/paper/batch?fields=externalIds,references.externalIds",
                {"ids": batch},
            )
            if not data or not isinstance(data, list):
                print(f"  Warning: SS batch returned no data", flush=True)
                time.sleep(SS_PAUSE)
                continue

            for i, entry in enumerate(data):
                if not entry or not isinstance(entry, dict):
                    continue
                sid = batch[i]
                paper = ss_id_to_paper.get(sid)
                if not paper:
                    continue

                ss_refs = entry.get("references") or []
                if not ss_refs:
                    continue

                # Convert SS references to OA short IDs
                existing_refs = set(paper.get("referenced_works") or [])
                new_refs_added = 0
                for ref_entry in ss_refs:
                    if not ref_entry or not isinstance(ref_entry, dict):
                        continue
                    ext = ref_entry.get("externalIds") or {}
                    ref_doi = (ext.get("DOI") or "").lower()
                    ref_arxiv = (ext.get("ArXiv") or "").lower()
                    oa_short = None
                    if ref_doi and ref_doi in oa_by_doi:
                        oa_short = oa_by_doi[ref_doi]
                    elif ref_arxiv and ref_arxiv in oa_by_arxiv:
                        oa_short = oa_by_arxiv[ref_arxiv]
                    if oa_short and oa_short not in existing_refs:
                        existing_refs.add(oa_short)
                        new_refs_added += 1

                if new_refs_added > 0 or not paper.get("referenced_works"):
                    paper["referenced_works"] = sorted(existing_refs)
                    if new_refs_added > 0:
                        ss_batch_enriched += 1
                        ss_batch_added_refs += new_refs_added

            time.sleep(SS_PAUSE)

        print(f"  SS batch added {ss_batch_added_refs} new refs across {ss_batch_enriched} papers")

    # -----------------------------------------------------------------------
    # Pass 4: Semantic Scholar per-paper fallback for papers still without refs.
    # -----------------------------------------------------------------------
    ss_candidates = []
    for paper in papers:
        if paper.get("referenced_works"):
            continue
        sid = ss_paper_id(paper)
        if sid:
            ss_candidates.append((sid, paper))

    if ss_candidates:
        print(f"\nPass 4: Semantic Scholar per-paper fallback for {len(ss_candidates)} papers...")
        ss_enriched = 0
        ss_total_refs = 0

        for idx, (sid, paper) in enumerate(ss_candidates, 1):
            if idx % 20 == 0 or idx == 1:
                print(f"  [{idx}/{len(ss_candidates)}] {paper.get('title', '?')[:50]}...", flush=True)

            data = ss_get_json(
                f"/paper/{sid}/references?fields=externalIds&limit=500"
            )
            if not data or "data" not in data:
                time.sleep(SS_PAUSE)
                continue

            refs = []
            for ref_entry in data.get("data") or []:
                cited = ref_entry.get("citedPaper", {})
                if not cited:
                    continue
                ext = cited.get("externalIds") or {}
                ref_doi = (ext.get("DOI") or "").lower()
                ref_arxiv = (ext.get("ArXiv") or "").lower()
                oa_short = None
                if ref_doi and ref_doi in oa_by_doi:
                    oa_short = oa_by_doi[ref_doi]
                elif ref_arxiv and ref_arxiv in oa_by_arxiv:
                    oa_short = oa_by_arxiv[ref_arxiv]
                if oa_short:
                    refs.append(oa_short)

            if refs:
                paper["referenced_works"] = refs
                ss_enriched += 1
                ss_total_refs += len(refs)

            time.sleep(SS_PAUSE)

        print(f"  SS per-paper enriched {ss_enriched} papers with {ss_total_refs} total references")

    # Summary
    has_refs_final = sum(1 for p in papers if p.get("referenced_works"))
    total_ref_count = sum(len(p.get("referenced_works") or []) for p in papers)
    print(f"\nSummary:")
    print(f"  Papers with refs: {has_refs_initial} -> {has_refs_final}")
    print(f"  Total referenced_works entries: {total_ref_count}")

    # Write back
    print("Writing papers-db.json...")
    with open(PAPERS_DB_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=True)
        f.write("\n")
    print("Done!")


if __name__ == "__main__":
    main()
