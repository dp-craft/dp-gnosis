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
./bench.sh --rerank-model <id>  # which cross-encoder to call; requires --rerank
./bench.sh --rerank --rerank-pool 20   # EXPLICIT candidate pool; bypasses the engine floor
./bench.sh --rerank --rerank-doc-max-chars 4000 --rerank-extract headtail   # WHAT the reranker is shown
./bench.sh --analyzer <id>      # which analysis chain builds AND queries; fts5 only
./bench.sh --query-adjacency    # add the phrase disjunct to multi-term query tokens; fts5 only
./bench.sh --include-history    # measure the FULL vault, unservable types included
./bench.sh --adapter lancedb-hybrid --hybrid-weight 0.25   # dense leg's share of the LEG fusion
./bench.sh --budget 16000 --served-k 5   # cap what the CONSUMER receives, after ranking
./bench.sh --compare            # print the delta against the previous run
./bench.sh --baseline <sel> --fail-under 0.01   # regression gate; exits 4 on a drop past the tolerance
```

Per-topic TSVs are written on every run, so there is no flag for them. An
unknown flag now REFUSES rather than being ignored, so a stale one fails loudly.

`npm run gnosis:bench -- --only nfcorpus` is the same entry point from the repo
root. `--help` prints the exit codes; the flags are documented here, once.

| Exit | Meaning |
|---|---|
| 0 | every selected dataset ran and was recorded |
| 1 | at least one dataset failed — the rest are still recorded, because a partial run must never look complete |
| 4 | the regression gate failed: a drop past `--fail-under`, or a pair it could not compare |

**`--baseline <perTopicPath substring>` + `--fail-under <Δ nDCG@10>`** are the regression gate, and they are given TOGETHER or not at all — a baseline with no tolerance gates nothing, and a tolerance with no baseline has nothing to compare, so half a pair REFUSES naming both. The selector follows `gnosis:pair` semantics (a unique substring of a recorded run's `perTopicPath`) but is resolved **per dataset**: one `--layer smoke` invocation measures several, and a selector that matches no run — or two — of the dataset just measured fails naming BOTH the selector and the dataset. The pairing is `significance.ts`, so the number is the same statistic `--compare` and `gnosis:pair` print.

The gate decides on the **point estimate**: it fails when the paired mean nDCG@10 difference falls below `-failUnder`. The permutation p and the bootstrap CI are printed beside it but are **not** the gate — `vault-hu`'s MDE is 0.05–0.07 (`GNOSIS-BENCH.md` § Known harness gaps), so requiring significance would let a real regression through on the corpus least able to detect one. A pairing the harness REFUSES — a `SCALE_FIELDS` move, a missing per-topic file, differing topic sets — exits 4 as well, with the refusal's own reason: a gate that cannot compare has verified nothing, and reporting that as a pass is the failure class the suite exists to prevent. Absent both flags, a run is byte-identical to one before they existed.

**`--query-adjacency`** is OFF by default and applies to `fts5` only — no other adapter reads the option, so naming it elsewhere REFUSES rather than recording a treatment the run never applied. On, a raw query token that analyzes to two or more terms contributes its multi-term phrase as an EXTRA disjunct beside its individual terms: additive scoring, never a filter, so a document lacking the phrase still matches on the terms. Recorded as `queryAdjacency`, a **TREATMENT** field, so `--compare` labels it `ARM COMPARISON` rather than subtracting it.

**`--include-history`** is OFF by default, and OFF means the derived vault holds only the types the CLI SERVES: the profile's `defaultExcludedTypes` are subtracted in `fetch/vault.ts` before `corpus.jsonl` is written, because the BEIR projection carries `{id,title,text}` alone and the atom's type exists nowhere downstream of that step. On the real vault those types were 7584 of 14127 atoms and 0 of 283 gold, so every top-10 slot they held could never be correct. On, the full corpus is projected — byte-identical to every run recorded before the alignment. Same name and same meaning as the CLI's flag, and it touches vault-derived datasets ONLY: BEIR and BRIGHT never enter `ensureVaultDataset`. Recorded as `typeFilter` (the excluded types, sorted and comma-joined, or `none`), a **TREATMENT** field, so `--compare` labels an aligned run against a full-corpus one `ARM COMPARISON` rather than subtracting it. It is NOT bit-equivalent to serving: BM25 collection statistics are computed over the servable subset here, where the CLI computes them over the full index and filters during the scan.

**`--rerank-pool <n>`** sets the reranker's candidate pool EXPLICITLY, bypassing the engine's `RERANK_K_INIT` floor — the only way to measure a pool below that constant. Omitted, the pool stays `max(depth, RERANK_K_INIT)`, so every already-recorded arm re-runs bit-identical. A non-integer, zero or negative value FAILS loudly naming the constraint; it is never clamped. Without `--rerank` it REFUSES, naming both flags. The effective pool is stamped on `rerankPool`, a **SCALE** field, so `--compare` refuses to subtract across a pool change. A pool below `--depth` WARNS (`dp-gnosis-bench/rerank-pool-below-depth`) rather than refusing: the arm is legitimate, but every metric whose cut is above the pool is capped by it — R@100 from a pool of 20 is R@20 under another name.


**`--rerank-doc-max-chars <n>`** and **`--rerank-extract <head|headtail>`** set WHAT the reranker is shown — how much of an atom body reaches it, and which part. Omitted, both fall back to the engine's shipped `RERANK_DOC_MAX_CHARS` (2000) and `EXTRACT_STRATEGY` (`head`), so an unflagged arm re-runs bit-identical. A non-integer, zero or negative width FAILS loudly naming the constraint; it is never clamped. An unknown extraction FAILS naming the valid ones. Either without `--rerank` REFUSES, naming both flags — nothing would rerank, yet the row would carry a width label no cross-encoder ever read. Both are stamped EFFECTIVE as **TREATMENT** fields (`rerankDocMaxChars`, `rerankExtract`), so `--compare` labels a width change `ARM COMPARISON` rather than subtracting it.

**`--budget <n>`** applies the engine's own `fitToTokenBudget` (`tools/dp-gnosis/src/budget.ts`, imported — never re-implemented) to the ranking a consumer would actually receive: it is charged AFTER the rerank and immediately before the atom→document rollup, so it caps the PRESENTATION and never the reranker's candidate pool. **`--served-k <k>`** narrows the window the budget is charged over; omitted, it is `--depth`, so `--budget` alone caps by tokens and by nothing else. A non-integer, zero or negative value of either FAILS loudly naming the constraint; neither is ever clamped. `--served-k` without `--budget` REFUSES, naming both flags — nothing would be capped, yet the row would carry a served window no presentation applied. Both are stamped as **TREATMENT** fields (`tokenBudget`, `servedK`), so `--compare` labels a budget change `ARM COMPARISON`. Absent, no cap is applied and the run is byte-identical to one before the flags existed.

**`--hybrid-weight <w>`** applies to `lancedb-hybrid` / `lancedb-hybrid-full` only — `0` pure lexical, `1` pure dense. An out-of-range or non-numeric value FAILS loudly naming the range; it is never clamped. It is recorded as a **TREATMENT** field, so `--compare` labels a weight change `ARM COMPARISON` rather than subtracting it. It is **NOT** `--rerank-weight`: those are two different fusions (leg↔leg vs reranker↔first-pass), and conflating them confounds any sweep.

**Its default (0.5) is measured-suboptimal on English** — `w=0.25` scored +0.0545 nDCG@10 first-stage (p=0.0008, selection-uncorrected) and +0.0324 reranked (p=0.0007). The default is deliberately unchanged because every recorded `lancedb-hybrid` row was measured at 0.5. Pass the flag explicitly. `GNOSIS-BASELINES.md` § Phase D addendum.

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

A `history.jsonl` row carries the metrics next to the PROVENANCE that makes them
comparable. Only `ndcg10`, `mrr10`, `map` and `rbpResidual` are always present: a
CUTOFF the run never retrieved to (`recall10` on a `--depth 5` run, `recall100`
on a `--depth 20` one, `rPrecision` on a topic with more gold than the depth)
writes NO key at all, which reads as "not measured" rather than as a number taken
at the truncation point. The consumer metrics (`precision5`, `precision10`,
`allGoldInTop10`, `map`, `rPrecision`, `rbpResidual`, and the `rPrecisionTopics`
denominator) are absent from every row recorded before they existed. The
provenance: `ts`,
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
Python binding of `trec_eval`) and diffs six measures. It is a **one-off dev-time
check, not a CI gate**: it needs a Python toolchain, and the answer changes only
when `src/metrics.ts` changes.

| Measure | `pytrec_eval` | Diffed against |
|---|---|---|
| nDCG@10 | `ndcg_cut_10` | the `history.jsonl` row |
| R@100 | `recall_100` | the row — skipped, and said so, when the run's depth is below 100 |
| P@5 / P@10 | `P_5` / `P_10` | `metrics.ts` itself |
| MAP | `map` | `metrics.ts` itself |
| R-Prec | `Rprec` | `metrics.ts` itself, and ONLY when every topic's `R` fits inside the run depth |

The last four landed after every recorded row was written, so no row carries a
value to diff. The script pipes the parsed run and qrels into the suite's OWN
`scoreTopic` / `meanMetrics` through `npx tsx` and diffs that — nothing is
re-implemented in Python, which could otherwise agree with `pytrec_eval` while
the shipped scorer drifts.

R-Prec is reported as **NOT ATTESTED** on a run where any topic has more gold
documents than the depth: `metrics.ts` records that topic's `rPrecision` as
unmeasurable (the ranking was truncated before rank R) and means over the
measured subset, while `pytrec_eval` means over all topics. Measured 2026-08-18:
attestable on scifact, not on nfcorpus (22 of 323 topics). `rbpResidual` has no
`pytrec_eval` counterpart and is not attested at all.

One-time setup, from this directory (`.venv/` is git-ignored):

```bash
python3 -m venv .venv && .venv/bin/pip install pytrec_eval numpy
```

Run it (datasets default to `scifact nfcorpus`):

```bash
.venv/bin/python scripts/validate-metrics.py scifact nfcorpus
```

Exit 0 = agreement within 1e-4 · exit 1 = disagreement · exit 2 = bad input (a
missing row / run file / qrels, or the `npx tsx` bridge failing to run).
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

Measured 2026-08-18 over the latest recorded rows (`2026-08-16-193455040-minisearch-*`,
depth 100), for the four measures diffed against `metrics.ts` directly:

| Dataset | topics | P@5 | P@10 | MAP | R-Prec |
|---|---|---|---|---|---|
| scifact | 300 | 4e-16 | 2e-16 | 3e-16 | 0 |
| nfcorpus | 323 | 4e-16 | 1e-16 | 0 | NOT ATTESTED (R > depth on 22 topics) |

Cells are max \|diff\| against `pytrec_eval`.

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
