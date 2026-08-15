#!/usr/bin/env python3
"""External validation of `src/metrics.ts` against `pytrec_eval` (trec_eval).

One-off, dev-time only — NOT a CI gate. It needs a Python toolchain and answers
a question that changes only when `metrics.ts` changes.

What it does: for each named dataset it reads the LATEST `results/history.jsonl`
row that carries a `runPath`, resolves the `.trec` run file from THAT FIELD (never
by reconstructing a path — a reconstructed path can land on a file another run
wrote), scores it against the dataset's official qrels with `pytrec_eval`, and
diffs nDCG@10 / R@100 against the metrics recorded on the row.

Conventions aligned with `metrics.ts` (`metrics.ts:1-33`), and why each matters:

1. TOPIC SET — `run.ts:topicsOf` scores every qrels topic that has query text,
   INCLUDING a topic that retrieved nothing (it contributes 0 to the mean).
   `pytrec_eval` averages only over topics present in the run, so this script
   builds the same topic set from qrels x queries and scores a missing topic as
   0.0 explicitly. Averaging over the run's topics instead would manufacture a
   disagreement that is not a defect.
2. GAIN — trec_eval's `ndcg_cut_10` uses LINEAR gain (`gain = rel`), which is
   what `ndcgAt` implements, and its ideal DCG is the top-k of the ideal ranking
   rather than the whole qrels list. `pytrec_eval` wraps trec_eval, so no flag is
   needed; this is stated because it is the assumption under the comparison.
3. UNJUDGED = 0 — identical on both sides (trec_eval's treatment).
4. DOCUMENT IDS — the suite scores at DOCUMENT level (atom -> `originPaths[0]`
   basename -> dedupe first occurrence), so the run file already holds deduped
   document ids. This script does no de-duplication and no id remapping. The
   qrels ids go through no `safeDocId` here either: that mapping is MEASURED
   identity on scifact and nfcorpus (`src/docId.ts` docstring), so applying it
   would be a no-op, and not applying it keeps this validator independent of
   suite code.
5. GRADED QRELS — nfcorpus grades are 1..3; a grade <= 0 is non-relevant on both
   sides (`relevantCount` filters `gain > 0`; trec_eval likewise).

Setup (one-off), from `tools/dp-gnosis-bench`:

    python3 -m venv .venv && .venv/bin/pip install pytrec_eval numpy

Run:

    .venv/bin/python scripts/validate-metrics.py scifact nfcorpus

Exit 0 = every dataset agrees within 1e-4. Exit 1 = a disagreement (the finding).
Exit 2 = an input problem (missing row, missing run file, missing qrels).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytrec_eval

SUITE_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = SUITE_ROOT / "results"
HISTORY = RESULTS_DIR / "history.jsonl"
DATA_DIR = SUITE_ROOT / "data"
MANIFEST = SUITE_ROOT / "datasets.json"

TOLERANCE = 1e-4
QRELS_HEADER_ID = "query-id"


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"validate-metrics: {message}", file=sys.stderr)
    raise SystemExit(2)


def manifest_entry(dataset: str) -> dict:
    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))["datasets"]
    for entry in entries:
        if entry["id"] == dataset:
            return entry
    fail(f"{dataset}: not in datasets.json")


def dataset_dir(entry: dict) -> Path:
    """Mirrors `run.ts:datasetDir` — `beir-local` resolves its own `source`."""
    if entry["format"] == "beir-local":
        return (SUITE_ROOT / entry["source"]).resolve()
    return DATA_DIR / entry["id"]


def latest_row(dataset: str) -> dict:
    rows = [json.loads(line) for line in HISTORY.read_text(encoding="utf-8").splitlines() if line.strip()]
    withrun = [r for r in rows if r.get("dataset") == dataset and r.get("runPath")]
    if not withrun:
        fail(f"{dataset}: no history row carries a runPath (legacy rows are not validatable)")
    return withrun[-1]


def read_qrels(directory: Path, split: str) -> dict[str, dict[str, int]]:
    path = directory / "qrels" / f"{split}.tsv"
    if not path.exists():
        fail(f"qrels not found: {path}")
    qrels: dict[str, dict[str, int]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if len(cols) < 3 or cols[0] == QRELS_HEADER_ID:
            continue
        qrels.setdefault(cols[0], {})[cols[1]] = int(float(cols[2]))
    return qrels


def query_ids(directory: Path) -> set[str]:
    path = directory / "queries.jsonl"
    if not path.exists():
        fail(f"queries not found: {path}")
    ids = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if str(row.get("text", "")):
            ids.add(str(row["_id"]))
    return ids


def read_run(path: Path) -> dict[str, dict[str, float]]:
    if not path.exists():
        fail(f"run file not found: {path}")
    run: dict[str, dict[str, float]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        run.setdefault(cols[0], {})[cols[2]] = float(cols[4])
    return run


def validate(dataset: str) -> bool:
    entry = manifest_entry(dataset)
    row = latest_row(dataset)
    directory = dataset_dir(entry)
    split = "test" if entry["format"] == "bright" else entry["qrels"]

    qrels = read_qrels(directory, split)
    run = read_run(RESULTS_DIR / row["runPath"])
    # Convention 1: the scored topic set is qrels x (queries with text), NOT the
    # run's topic set. A zero-hit topic has no run lines and still counts as 0.
    topics = sorted(set(qrels) & query_ids(directory))

    evaluator = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut_10", "recall_100"})
    scored = evaluator.evaluate(run)
    ndcg = sum(scored.get(t, {}).get("ndcg_cut_10", 0.0) for t in topics) / len(topics)
    recall = sum(scored.get(t, {}).get("recall_100", 0.0) for t in topics) / len(topics)

    d_ndcg = abs(ndcg - row["ndcg10"])
    d_recall = abs(recall - row["recall100"])
    ok = d_ndcg <= TOLERANCE and d_recall <= TOLERANCE and len(topics) == row["topics"]

    print(f"{dataset}: {'AGREE' if ok else 'DISAGREE'}  (topics {len(topics)} vs recorded {row['topics']}, run {row['runPath']})")
    print(f"  nDCG@10   pytrec_eval {ndcg:.6f}  metrics.ts {row['ndcg10']:.6f}  |diff| {d_ndcg:.2e}")
    print(f"  R@100     pytrec_eval {recall:.6f}  metrics.ts {row['recall100']:.6f}  |diff| {d_recall:.2e}")
    return ok


def main(argv: list[str]) -> int:
    datasets = argv or ["scifact", "nfcorpus"]
    results = [validate(dataset) for dataset in datasets]
    if all(results):
        print(f"all {len(results)} dataset(s) agree within {TOLERANCE}")
        return 0
    print("DISAGREEMENT — do not tune this script; characterise the convention that differs", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
