#!/usr/bin/env python3
"""External validation of `src/metrics.ts` against `pytrec_eval` (trec_eval).

One-off, dev-time only — NOT a CI gate. It needs a Python toolchain and answers
a question that changes only when `metrics.ts` changes.

What it does: for each named dataset it reads the LATEST `results/history.jsonl`
row that carries a `runPath`, resolves the `.trec` run file from THAT FIELD (never
by reconstructing a path — a reconstructed path can land on a file another run
wrote), scores it against the dataset's official qrels with `pytrec_eval`, and
diffs nDCG@10 / R@100 against the metrics recorded on the row.

It then diffs FOUR MORE measures — `P_5`, `P_10`, `map`, `Rprec` — against
`metrics.ts` itself rather than against the row: those columns landed after every
recorded row was written, so a row carries no value to diff. The script pipes the
parsed run and qrels into the suite's OWN `scoreTopic`/`meanMetrics` through
`npx tsx` (see `metrics_ts_means`) and diffs that. Nothing is re-implemented in
Python — a second implementation here could agree with `pytrec_eval` while the
shipped one drifts.

`Rprec` is attested only when EVERY topic has `R <= depth`. `metrics.ts` records
`rPrecision` as unmeasurable for a topic whose gold count exceeds the run depth
(the ranking was truncated before rank R) and means over the measured subset,
while `pytrec_eval` means over all topics; on a run where any topic is truncated
the two denominators differ and the comparison is REPORTED AS NOT ATTESTED rather
than silently made. `rbpResidual` has no `pytrec_eval` counterpart and is not
attested here at all.

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

Setup (one-off), from `packages/gnosis-bench`:

    python3 -m venv .venv && .venv/bin/pip install pytrec_eval numpy

Run:

    .venv/bin/python scripts/validate-metrics.py scifact nfcorpus

Exit 0 = every dataset agrees within 1e-4. Exit 1 = a disagreement (the finding).
Exit 2 = an input problem (missing row, missing run file, missing qrels, or the
`npx tsx` bridge to `metrics.ts` failing to run).
"""

from __future__ import annotations

import json
import subprocess
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


# The suite's OWN scorer, called over stdin. Kept to reading a payload and
# printing means: every formula stays in `metrics.ts`, which is the module under
# attestation.
BRIDGE = """
import { readFileSync } from 'node:fs';
import { meanMetrics, rPrecisionTopics, scoreTopic } from './src/metrics.ts';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const perTopic = payload.topics.map((t) => scoreTopic(t.ranking, new Map(t.qrel), payload.depth));
process.stdout.write(
  JSON.stringify({ mean: meanMetrics(perTopic), rPrecisionTopics: rPrecisionTopics(perTopic) })
);
"""


def ranked_docs(run: dict[str, dict[str, float]], topic: str) -> list[str]:
    """Rank order = descending score, ties by doc id — trec_eval's own ordering."""
    scored = run.get(topic, {})
    return [doc for doc, _ in sorted(scored.items(), key=lambda kv: (-kv[1], kv[0]))]


def metrics_ts_means(
    run: dict[str, dict[str, float]],
    qrels: dict[str, dict[str, int]],
    topics: list[str],
    depth: int,
) -> dict:
    """`metrics.ts` scored over the SAME topic set, through the shipped code."""
    payload = {
        "depth": depth,
        "topics": [
            {"ranking": ranked_docs(run, topic), "qrel": list(qrels.get(topic, {}).items())}
            for topic in topics
        ],
    }
    completed = subprocess.run(
        ["npx", "tsx", "-e", BRIDGE],
        cwd=SUITE_ROOT,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        fail(f"metrics.ts bridge failed (npx tsx): {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def mean_over(scored: dict, topics: list[str], measure: str) -> float:
    return sum(scored.get(t, {}).get(measure, 0.0) for t in topics) / len(topics)


# pytrec_eval measure -> the `metrics.ts` field it must equal.
CONSUMER_MEASURES = (("P_5", "precision5"), ("P_10", "precision10"), ("map", "map"))


def diff_line(label: str, external: float, ours: float) -> tuple[float, str]:
    delta = abs(external - ours)
    return delta, f"  {label:<9} pytrec_eval {external:.6f}  metrics.ts {ours:.6f}  |diff| {delta:.2e}"


def consumer_diffs(scored: dict, topics: list[str], ours: dict) -> tuple[bool, list[str]]:
    """P@5 / P@10 / MAP, plus R-Prec when every topic's R fits inside the depth."""
    rows = [
        diff_line(measure, mean_over(scored, topics, measure), ours["mean"][field])
        for measure, field in CONSUMER_MEASURES
    ]
    if ours["rPrecisionTopics"] == len(topics):
        rows.append(diff_line("Rprec", mean_over(scored, topics, "Rprec"), ours["mean"]["rPrecision"]))
    else:
        measured = ours["rPrecisionTopics"]
        rows.append((0.0, f"  Rprec     NOT ATTESTED — R > depth on {len(topics) - measured} of {len(topics)} topics"))
    return all(delta <= TOLERANCE for delta, _ in rows), [text for _, text in rows]


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

    measures = {"ndcg_cut_10", "recall_100", "P_5", "P_10", "map", "Rprec"}
    evaluator = pytrec_eval.RelevanceEvaluator(qrels, measures)
    scored = evaluator.evaluate(run)
    ndcg = mean_over(scored, topics, "ndcg_cut_10")
    recall = mean_over(scored, topics, "recall_100")

    d_ndcg = abs(ndcg - row["ndcg10"])
    # A row recorded below depth 100 has no recall100 to diff — that is the point
    # of the cutoff being unmeasurable, not a missing number.
    recorded_recall = row.get("recall100")
    d_recall = None if recorded_recall is None else abs(recall - recorded_recall)

    ours = metrics_ts_means(run, qrels, topics, row["depth"])
    consumer_ok, consumer_rows = consumer_diffs(scored, topics, ours)
    ok = (
        d_ndcg <= TOLERANCE
        and (d_recall is None or d_recall <= TOLERANCE)
        and consumer_ok
        and len(topics) == row["topics"]
    )

    print(f"{dataset}: {'AGREE' if ok else 'DISAGREE'}  (topics {len(topics)} vs recorded {row['topics']}, run {row['runPath']}, depth {row['depth']})")
    print(f"  nDCG@10   pytrec_eval {ndcg:.6f}  metrics.ts {row['ndcg10']:.6f}  |diff| {d_ndcg:.2e}")
    if d_recall is None:
        print(f"  R@100     pytrec_eval {recall:.6f}  metrics.ts —  (depth {row['depth']} < 100: not measurable)")
    else:
        print(f"  R@100     pytrec_eval {recall:.6f}  metrics.ts {recorded_recall:.6f}  |diff| {d_recall:.2e}")
    for line in consumer_rows:
        print(line)
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
