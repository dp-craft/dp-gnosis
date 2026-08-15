# dp-gnosis-bench

A retrieval benchmark for `tools/dp-gnosis/`. It drives the SHIPPED path end to
end — `ingest()` → `buildFts5Index()` → `createPort()` → `port.retrieve()` — so
a change anywhere in the engine moves the numbers. Scores are DOCUMENT-level:
retrieved atoms are rolled up to their origin document before scoring, so they
stay comparable across a chunker change.

## Run it

```
./bench.sh                      # every enabled dataset, depth 100
./bench.sh --only nfcorpus      # one dataset (csv for several)
./bench.sh --depth 20           # retrieval depth; R@100 needs depth 100
./bench.sh --rerank             # add the reranker arm (see the caveat below)
./bench.sh --compare            # print the delta against the previous run
./bench.sh --per-topic          # also write per-topic TSVs for a paired test
```

`npm run gnosis:bench -- --only nfcorpus` is the same entry point from the repo
root. Exit 0 means every selected dataset ran and was recorded; non-zero means
at least one failed — the rest are still recorded, because a partial run must
never look complete.

A dataset is fetched on first use and never again: the fetchers key on
`data/<id>/corpus.jsonl`, so re-running costs no network. Delete that directory
to force a refetch. `data/` and `work/` are git-ignored; `results/` is tracked.

## Add a dataset

One entry in `datasets.json`, no code. `domain` / `docShape` / `queryShape` are
REPORT metadata only — they never reach the ingest profile, whose vocabulary is
frozen in `tools/dp-gnosis/src/config.ts`.

| `format` | Needs | What happens |
|---|---|---|
| `beir-zip` | `source` (archive URL), `qrels` (split name) | downloaded to `data/<id>.zip`, unzipped into `data/<id>/` |
| `beir-local` | `source` (path relative to this directory), `qrels` | read in place, nothing fetched |
| `bright` | `split` (BRIGHT domain name) | both HuggingFace configs downloaded as parquet shards (cached under `data/_parquet/<config>/<split>/`) and written into `data/<id>/` in BEIR layout |

`beir-local` is also how you measure YOUR OWN material: point `source` at a
directory holding a hand-labelled corpus in BEIR layout — `corpus.jsonl`
(`_id`, `title`, `text`), `queries.jsonl` (`_id`, `text`) and
`qrels/<split>.tsv` (`query-id`, `corpus-id`, `score`, with the header row).
Document ids must match `/^[A-Za-z0-9._-]{1,200}$/`: the id becomes the corpus
filename, and that filename is how a retrieved atom is mapped back to a qrels
key. Ids that do not (BRIGHT's contain `/`) are mapped to safe surrogates by the
fetcher, which records the mapping in `data/<id>/id-map.json`.

Optional per-entry `atomMaxChars` overrides the engine's chunk cap; the BRIGHT
entries set 4000 because their documents are whole web pages.

### Two BRIGHT granularities: what the gap measures

BRIGHT publishes the SAME 103 queries per domain against two document sizes,
and a `bright` entry picks one with `granularity` (absent means `long`):

| Entry | `granularity` | Corpus config | Gold field | A document is |
|---|---|---|---|---|
| `bright-<domain>` | `long` | `long_documents` | `gold_ids_long` | a whole web page |
| `bright-<domain>-passages` | `passage` | `documents` | `gold_ids` | one gold passage, ~387 chars |

A passage is about one atom long, so at `passage` granularity a document IS a
block and the document-level rollup scores block-level ranking — no second
scoring path, no anchors, no LLM. Both variants run through the same harness
unchanged.

Read the pair together: `bright-biology` and `bright-biology-passages` ask the
same questions of the same material, and the only difference is that the long
variant must first CHUNK a page and then roll its atoms back up. **The score gap
between them is the chunker's cost** — it is what retrieval loses to splitting
and reassembly, isolated from the ranking itself.

Only `bright-biology-passages` ships. The full `documents` config is 1.33M rows
across the eight domains, and one domain is enough to size the gap; a second
domain is one more manifest entry when it is wanted. Each variant caches under
its own `data/<id>/`, so neither overwrites the other, and `documents/biology`
is 57,359 rows (~574 requests) — the fetcher logs progress every 50 pages.

## Read the results

Each run writes five artefacts under `results/`:

| File | For |
|---|---|
| `<stem>-<sha>.md` | one row per dataset, for a human |
| `<stem>-<sha>.json` | the same numbers, machine-readable |
| `per-topic/<instant>-<adapter>-<dataset>.tsv` | per-topic scores, so a paired significance test can run LATER without re-running the benchmark |
| `runs/<instant>-<adapter>-<dataset>.trec` | the per-topic RANKINGS in TREC run format (`qid Q0 docid rank score tag`, rank 1-based), so an external evaluator (`pytrec_eval`) can attest the metrics and a later analysis can fuse or diff rankings without a re-run |
| `history.jsonl` | one append-only line per (run, dataset) — the progress table |

Both per-run files are written UNCONDITIONALLY, and both are recorded on the
history row (`perTopicPath`, `runPath`). A reader resolves ONLY those fields: a
name derived from the row cannot tell two arms recorded in the same minute
apart, so a legacy row lacking the field reads as "not available" rather than
landing on a file another run wrote.

**Retention — `results/runs/` is git-ignored.** A run file carries every
retrieved document for every topic: about **8 MB per arm** at `--depth 100` over
the Tier-1 suite, against a few kilobytes for the whole rest of `results/`. They
are fully regenerable by re-running the arm, and every metric derived from them
is already in `history.jsonl`. Keep the run file an open analysis is reading;
delete the rest.

A `history.jsonl` row carries the four metrics (`ndcg10`, `recall10`,
`recall100`, `mrr10`) next to the PROVENANCE that makes them comparable: `ts`,
`gitSha`, `adapter`, `depth`, `rerank`, `atomMaxChars`, and `corpusBytes` /
`corpusLines` as a cheap corpus checksum. `--compare` subtracts the last two
rows per dataset and REFUSES a delta when any of those changed, naming the
field. That refusal is the point of the file: an earlier commit changed the
measuring scale and the numbers were chained across it anyway, because nothing
recorded what the scale had been.

`atomMaxChars` records the EFFECTIVE value used, never `null` — a run that
inherited the engine default and a run that set the same number explicitly are
the same measurement and must read alike.

## Validate the metrics against `pytrec_eval`

`scripts/validate-metrics.py` re-scores a recorded run with `pytrec_eval` (the
Python binding of `trec_eval`) and diffs nDCG@10 / R@100 against the matching
`history.jsonl` row. It is a **one-off dev-time check, not a CI gate**: it needs
a Python toolchain, and the answer changes only when `src/metrics.ts` changes.

One-time setup, from this directory (`.venv/` is git-ignored):

```bash
python3 -m venv .venv && .venv/bin/pip install pytrec_eval numpy
```

Run it (datasets default to `scifact nfcorpus`):

```bash
.venv/bin/python scripts/validate-metrics.py scifact nfcorpus
```

Exit 0 = agreement within 1e-4 · exit 1 = disagreement · exit 2 = bad input.
It resolves the run file from the row's `runPath` field, never by rebuilding a
path. Two conventions have to be aligned by hand or the check reports a
disagreement that is not a defect, and both are stated in the script's
docstring: the mean is taken over the **qrels** topic set (a zero-hit topic has
no lines in the run file and still counts as 0, as `metrics.ts` does), and the
ids in the run file are already document-level and deduped, so the script
re-maps nothing.

**On a disagreement, do not tune the script.** Characterise which convention
differs and report it — `metrics.ts` being `trec_eval`-equivalent is what every
external comparability claim in this suite rests on.

Measured 2026-08-15 at `gitSha` `35c7a546`, run `2026-08-15-114122694-fts5-*`:

| Dataset | topics | nDCG@10 (`pytrec_eval` / `metrics.ts`) | R@100 (`pytrec_eval` / `metrics.ts`) |
|---|---|---|---|
| scifact | 300 | 0.685766 / 0.685766 | 0.917667 / 0.917667 |
| nfcorpus | 323 | 0.316405 / 0.316405 | 0.246264 / 0.246264 |

Agreement is to floating-point noise (max |diff| 4.4e-16), not merely to 4
decimal places.

## Sweep BM25 k1 and b

```
./sweep.sh                                  # 4 datasets, the 12-point grid + baseline
./sweep.sh --only nfcorpus                  # one dataset (csv for several)
./sweep.sh --k1 1.2,1.0 --b 0.5,0.4         # a narrower grid
./sweep.sh --depth 20                       # retrieval depth; R@100 needs depth 100
```

`npm run gnosis:sweep -- --only nfcorpus` is the same entry point from the repo
root. Defaults: `--only bright-biology-passages,bright-biology,nfcorpus,scifact`,
`--k1 1.2,1.0,0.8`, `--b 0.6,0.5,0.4,0.3`. The shipped operating point
(k1=1.2, b=0.75) is ALWAYS measured as a 13th reference cell, so the grid is
readable against the baseline it has to beat.

Datasets run in the order `--only` STATES, not manifest order, and the default
order is most-informative first rather than cheapest first. A default sweep is
hours long and is expected to be stopped early; artefacts are rewritten after
every cell, so the order decides what has been measured when a run is cut
short. `bright-biology-passages` leads because it carries the BM25 deficit the
study exists to explain.

Three artefacts per sweep:

| File | For |
|---|---|
| `results/sweep/<stem>-<sha>.json` | every cell, machine-readable |
| `docs/analysis/<stem>-bm25-k1-b-sweep.md` | best cell per dataset, baseline delta, every row |
| `docs/analysis/<stem>-bm25-k1-b-sweep.svg` | the nDCG@10 surface, one panel per dataset |

Every cell records `adapter`, `k1` and `b` next to its metrics, for the reason
`history.jsonl` records `adapter`/`depth`/`atomMaxChars`: a number whose
operating point was not recorded cannot be compared with a later one.

### It sweeps the LINEAR adapter, and that is a real limit

`sweep.ts` injects `k1`/`b` into `createLinearScanAdapter` — the same factory
`--adapter linear` builds, verified by an equivalence case in `engine.test.ts`.
SQLite FTS5 computes `bm25()` with k1 and b compiled in and exposes no way to
set them, so **a winning cell cannot be switched on for the `fts5` path**.
Adopting one means either running the linear adapter in production or writing a
custom scoring function over FTS5 term statistics. The sweep is evidence about
BM25's shape on this material, not a setting.

### It is slow, and ingest is NOT the reason

Ingest+index is hoisted: `contextFor` runs once per dataset, OUTSIDE the grid
loop, and a cell only constructs a port (the linear adapter scans nothing at
construction). Measured on a 7-cell nfcorpus run — 1,918 s wall against 1,916 s
of summed `queryMs`, so 99.9% of wall time is inside the query phase and the
one-time ingest is ~2 s. There is no per-cell re-ingest to remove.

The cost is the RETRIEVE path: the linear adapter re-reads and re-tokenizes the
whole corpus on every `retrieve` (its read-at-call-time body rule), so a cell
costs `topics × atoms` reads — 1.18M for nfcorpus — and the grid multiplies that
by 13 even though only `k1`/`b` change between cells. The corpus scan is
identical across all 13 cells; caching it per `atomsDir` inside
`linearScanAdapter` would collapse the grid to roughly one scan plus 13 cheap
scorings. That is a dp-gnosis change, deliberately not made here.

Measured, one cell: **269 s** for nfcorpus (3,645 atoms × 323 topics). Scaling
that model over the default grid:

| Dataset | atoms × topics | per cell | 13 cells |
|---|---|---|---|
| nfcorpus | 3,645 × 323 | ~269 s | ~58 min |
| scifact | 5,202 × 300 | ~357 s | ~77 min |
| bright-biology | 8,930 × 103 | ~210 s | ~46 min |
| bright-biology-passages | 55,695 × 103 | ~1,310 s | **~4.7 h** |

A full default sweep is therefore on the order of **8 hours**. That cost is
accepted — the re-read is a known future optimization and must not shape the
parameter study — but it means a rerun after a chunk-size change is an
overnight job, not an interactive one. Narrow with `--only` when only one
dataset moved. Artefacts are rewritten after EVERY cell, so a crash on the last
cell costs one cell, not the run.

## What `--rerank` measures, honestly

It measures the SHIPPED reranker configuration, and only that. The blend weight
`w`, the rerank depth `K` and the widened first pass `k_init` are constants in
`tools/dp-gnosis/src/config.ts`, not parameters any caller can pass — so this
suite cannot sweep them, and no run here is evidence about a value other than
the one currently compiled in. Changing one means editing that file and taking a
new baseline; `--compare` will refuse the delta only if a recorded provenance
field moved, and these constants are NOT among them.

`--rerank` also FAILS a dataset when the reranker refuses (service down, no
model): falling back to the BM25 order would record a rerank run that never
reranked.
