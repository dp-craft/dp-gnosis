<!-- LLM-PRIMARY: The METHODOLOGY of the dp-gnosis benchmark — suite layers, harness design rules, provenance (scale vs treatment), outputs, datasets, which metric answers which question, and the known harness gaps. The FLAG TABLE is not here: packages/gnosis-bench/README.md owns it. Read together with GNOSIS-GUIDE.md (landmines) before any benchmark work. Measured numbers live in GNOSIS-BASELINES.md. -->

# Gnosis Bench — how to measure, and how to read the result

**`packages/gnosis-bench/README.md` owns HOW to run it** — every flag, the datasets, the artefacts. **This file owns WHAT to measure and whether the answer may be quoted.** The landmines and what is settled stay in `GNOSIS-GUIDE.md` — **read that first**; this file assumes it.

MUST NOT quote a number produced here without the provenance rules in § Provenance and the selection rules in § What to measure, when.

| I want to… | Go to |
|---|---|
| Run a benchmark — the flags, the datasets, the artefacts | `packages/gnosis-bench/README.md` § Run it |
| Choose a suite size | § Layers |
| Know which metric answers my question | § What to measure, when |
| Know whether two rows are comparable | § Provenance — scale vs treatment |
| Know what the harness CANNOT see | § Known harness gaps |
| Read the measured numbers | `GNOSIS-BASELINES.md` — a SNAPSHOT, never a gate |

## Benchmarking

`./packages/gnosis-bench/bench.sh`, or `npm run gnosis:bench -- <flags>` from the repo root.

**The flag table has ONE owner: `packages/gnosis-bench/README.md` § Run it** — every flag, its refusal semantics, and what it stamps on the history row. `run.ts:RUN_HELP` names that same file rather than restating the flags, and so does this one. What THIS file owns is everything the flag list cannot tell you: which suite to run (§ Layers), which metric answers your question (§ What to measure, when), whether two recorded rows may be subtracted at all (§ Provenance), and what the harness structurally cannot see (§ Known harness gaps).

**A missing `scifact` corpus makes the smoke gate exit 1, not 4.** `scifact` is the only `beir-local` entry sourced outside `packages/gnosis-bench/data/` (`../../docs/benchmarks/2026-08-14-external-suite/data/scifact`, gitignored), so a fresh worktree that symlinks only `data/` fails that dataset. The gate then prints `NOT RUN — the run exited 1` and pairs nothing: exit 1 is a MISSING CORPUS, exit 4 is a regression. MUST NOT read one as the other.

**An UNKNOWN `--flag` REFUSES, in every bench parser — and WHY is this file's business, not the README's** (`run.ts`, `sweep.ts`, `pair.ts`; the gate's flags are checked through `run.ts` because `parseGateArgs` reads the same argv). Until 2026-08-18 a typo'd `--rerank-model` was silently dropped **and the run still recorded a model label** — a row naming a cross-encoder that never scored anything, which is the provenance failure this whole file is built around. Each parser declares its flags in one `FlagSpec` beside it, and a test reads the parser's own source to assert every flag it reads is declared, so the list cannot drift. `--flag=value` was never supported and now refuses instead of being ignored; `--` and bare positionals are ignored exactly as before, and a negative value (`--fail-under -0.01`) still parses.

### Layers

Membership is authored per entry in `datasets.json` (`"layers": [...]`) — the dataset list has ONE owner, and npm scripts MUST NOT restate it. `[]` is permitted and means "no layer", authored rather than implied. Measured cost, 2026-08-15: `smoke` ≈20 s · `par` ≈19 min · `full` ≈60 min BM25, more with arms.

`webis-touche2020` is `full`-only on measured grounds: its ingest is **68 % of the layer's whole cost for 1.3 % of its topics** (1.2 topics/min against arguana's 121). It was selected as the rerank-regression control — *"the only BEIR dataset where a cross-encoder degrades the result"* — and **that no longer holds here**: with `qwen3-reranker-4b` at pool 100 it IMPROVES (nDCG@10 0.3403 → 0.3842, p=0.0023; R@10 +0.0249, p=0.0013; R@100 unchanged — BASELINES § External control). The published claim describes the cross-encoders BEIR shipped with, not reranking as such. **MUST NOT quote touché as a rerank-regression control** — the suite has NO dataset in that role.

**Touché's manifest id is `webis-touche2020`, the ARCHIVE id — `touche2020.zip` is a 404.** `ensureBeirDataset` resolves `<dataDir>/<entry.id>/corpus.jsonl` against the archive's inner directory, so the entry id MUST equal it.

| Command | Purpose |
|---|---|
| `npm run gnosis:pair -- --a <sel> --b <sel> [--metric csv] [--ids file]` | Paired permutation + bootstrap CI between **two named runs**, including different dataset ids — the only way to adjudicate an arm dataset such as `vault-rephrased` against its base. Selectors are unique `perTopicPath` substrings; ambiguous or unmatched fails loudly. Scale-provenance changes refuse to subtract; treatment changes print `ARM COMPARISON` |
| `npm run gnosis:charts` | Regenerate every campaign figure from recorded artefacts, driven by the committed spec `charts.json`. Hand-rolled SVG, no charting dependency |
| `npm run gnosis:forensics -- --run <sel> [--budget <n>] [--served-k <k>]` | **Re-score an ALREADY-RECORDED run offline** — no retrieval, no GPU, no re-run. Reads the row's `runPath` `.trec` and scores it through `metrics.ts:scoreTopic`, so a row recorded before a metric existed can still be given that column (this is what tracking the run files bought). Writes `results/forensics/<instant>-<adapter>-<dataset>.tsv` with the consumer metrics plus the ordering/recall split (`oracleNdcg10`, `orderingLoss`, `recallLoss`, `firstGoldRank`, `recallLimited`) and `goldSurvivesBudget`. **It REFUSES rather than re-scoring silently** when the recomputed value disagrees with the recorded per-topic TSV on any column that TSV carries — a golden set that moved under a recorded run is otherwise invisible. A column ABSENT from a legacy TSV is treated as not recorded, never as `0`. Exit 0 ok · 2 usage/selector · 3 refusal (no `runPath`, drifted qrels, atoms newer than the run) |

Per-topic TSVs and TREC run files are always written, **as each dataset completes**. Exit 0 = every selected dataset ran and was recorded; non-zero = at least one failed and the rest are still recorded — a partial run must never look complete, and since 2026-08-15 that holds when the PROCESS dies too, not only when a dataset fails.

**Exit 4 is the regression gate**, and a gate that CANNOT COMPARE exits 4 as well — a `SCALE_FIELDS` move, a missing per-topic file or a differing topic set all fail it, because a gate that cannot pair MUST NOT report a pass. The message distinguishes the two; the exit code deliberately does not.

**`metrics.ts` is externally attested — for the measures `pytrec_eval` also computes**: nDCG@10, R@100, P@5, P@10 and MAP reproduce on scifact and nfcorpus to floating-point noise (max |diff| 4.4e-16). **Two are NOT attested and MUST NOT be quoted as if they were** — `rbpResidual` has no `pytrec_eval` counterpart at all, and `rPrecision` is attested only where `R ≤ depth`: on nfcorpus **22 of 323 topics** hold more relevant documents than the run retrieved to, so they score `undefined` and the run-level number means over the remaining 301, with that count recorded as `rPrecisionTopics`. Setup: `packages/gnosis-bench/README.md` § Validate the metrics. **Two conventions MUST be matched** or the comparison manufactures a false disagreement: average over the **qrels** topic set (a zero-hit topic has no lines in the run file and `trec_eval` silently omits it — on nfcorpus that alone shifts nDCG@10 by 0.015), and do not re-dedupe ids the run file already holds at document level.

### BM25 k1×b sweep

`npm run gnosis:sweep` — flags, grid defaults and run order are owned by `packages/gnosis-bench/README.md` § Sweep BM25 k1 and b. Fixed to the `linear` adapter, the only one that accepts `k1`/`b`.

**A sweep result CANNOT be shipped on `fts5`.** SQLite compiles k1/b in. Treat a winning cell as evidence about how the corpus responds to length normalisation, not as a setting that can be switched on.

### Two load-bearing design rules

| Rule | Why it exists |
|---|---|
| It drives the **REAL engine** — `ingest → index build → createPort → retrieve` (`engine.ts` is the only seam), guarded by a CLI-equivalence test | The prior harness built its own index and its own SQL, so it measured a reimplementation and **could not catch an engine regression** |
| It scores at **DOCUMENT level** — atom → `originPaths[0]` basename → dedupe first-occurrence | Makes scores **chunking-invariant**, so a chunker change is comparable across runs |

`assertIngestSound` (`engine.ts`) FAILS the run on an empty index or below **90% document coverage**. It inspects the fts5 index, NOT the port — so an adapter-blind port assertion runs beside it (`dp-gnosis-bench/port-index-not-ready`, `dp-gnosis-bench/port-retrieved-nothing`; `GNOSIS-HISTORY.md` § Resolved landmines) to catch a measured adapter that retrieved nothing.

### Provenance — scale vs treatment

`compare.ts` splits its provenance fields, and `PROVENANCE_FIELDS` is derived from both lists so a new field cannot land in one only:

| Kind | Fields | On change |
|---|---|---|
| `SCALE_FIELDS` | `atomMaxChars`, `depth`, `rerankPool`, `corpusBytes`, `corpusLines`, `atomCount` | **REFUSES** to subtract, naming the field — even when a treatment moved too. A changed measuring scale can never masquerade as a quality change |

`rerankPool` is the EFFECTIVE pool the reranker scored — `firstPassDepth(depth, rerank, pool)` = `--rerank-pool` when given, else `max(depth, RERANK_K_INIT)`, NOT the requested `depth`. It exists because the two diverged silently once `RERANK_K_INIT` moved to 100: a run asking for `--depth 20` scored a pool of 100 while provenance recorded 20. It is guarded **only between two rows that both reranked** — when `rerank` itself flips, the pool comes into existence rather than moving, and the `rerank` TREATMENT field already labels that, so rerank-on-vs-off stays an `ARM COMPARISON`. A rerank row written before the field existed backfills to `max(depth, 20)`, the floor that held until `92d683e2`.
| `TREATMENT_FIELDS` | `adapter`, `rerank`, `rerankProfile`, `rerankWeight`, `rerankModel`, `rerankDocMaxChars`, `rerankExtract`, `hybridWeight`, `tokenBudget`, `servedK`, `embedModel`, `analyzer`, `fieldWeights`, `enrichment`, `queryAdjacency` | Compared, and **labelled** `ARM COMPARISON` before any number — this IS the experiment |

`rerankDocMaxChars` / `rerankExtract` are WHAT the reranker was shown — `RERANK_DOC_MAX_CHARS` (`config.ts`) and `EXTRACT_STRATEGY` (`rerank.ts`), stamped only on a row that reranked. A row missing them reads as `2000` / `head`, the window that held since the reranker landed, so a rerank-on/off flip stays an `ARM COMPARISON` naming `rerank` alone.

`tokenBudget` / `servedK` are WHAT THE CONSUMER RECEIVED — the token cap `--budget` applied and the `--served-k` window it was charged over — stamped only on a row that named a budget. They have **no backfill and MUST NOT be given one**: an absent pair means no cap was applied, which is a real arm rather than an older value, so a budgeted row against an unbudgeted one is labelled `ARM COMPARISON` on both fields.

`embedModel` is the encoder behind the dense leg — `EMBED_MODEL_ID` (`config.ts`), stamped only on a row whose adapter is a dense route (`DENSE_ROUTES` / `denseRouteOf`, `cli/adapter.ts` — never a hardcoded list). A row missing it reads as `bge-m3`, the value every recorded dense row was measured at, so a lexical row and a dense row still compare equal on it and the `adapter` field alone names that flip.

`fieldWeights` / `enrichment` are the INGEST-ENRICHMENT arm — the `bm25()` weight per column the run read its index with, and how many atoms that index carried enrichment text for. They BACKFILL as a pair: a row missing them reads as the canonical `DEFAULT_FIELD_WEIGHTS` string (`body=1,short=0,…`) and `0`, because a body-only index with no sidecar is exactly what every recorded run was measured at — there was no other index the engine could build. So an old row and a new unenriched row compare EQUAL, and only a run that actually named a weight or merged a sidecar flips the `ARM COMPARISON` label.

`gitSha` is **not** a provenance field.

### Outputs

| Path | Contents |
|---|---|
| `results/<YYYY-MM-DD-HHMM>-<sha>.md` / `.json` | One row per dataset — human, then machine-readable |
| `results/per-topic/<instant>-<adapter>-<dataset>.tsv` | Per-topic scores — enables a paired significance test LATER with no re-run. `<instant>` is ISO through **milliseconds** and the adapter is in the name, so two arms in one minute cannot collide. Recorded on the history row as `perTopicPath`; resolution reads **only** that field, so a row can never land on a file another run wrote. A row without it (legacy) yields `not tested`, never a pairing |
| `results/runs/<instant>-<adapter>-<dataset>.trec` | **The per-topic RANKINGS**, TREC run format `qid Q0 docid rank score tag` — what `trec_eval` / `pytrec_eval` read. Written on EVERY run, not behind a flag: an artefact that must be asked for is an analysis that never happens. Recorded as `runPath`, resolved from that field only. **TRACKED, not gitignored** — corrected 2026-08-19: this line read "Gitignored" while § Benchmarking's `gnosis:forensics` row in this same file credited *"what tracking the run files bought"*. Tracking is what lets a recorded run be re-scored offline, so a measuring commit MUST include its `.trec`; 189 were tracked when one arm's file was found missing from its own commit. Score derives from the ORDER and is strictly decreasing — a constant score would let `trec_eval` re-sort by docid and silently score an alphabetical ranking |
| `results/history.jsonl` | Append-only, one line per (run, dataset) — metrics next to provenance. Written as each dataset completes |
| `results/sweep/` | BM25 grid output, one JSON per sweep |
| `docs/analysis/` | Analysis write-ups, and the sweep's generated `.md` + `.svg` |
| `data/`, `work/` | Download + ingest caches, both gitignored |

### Datasets

`datasets.json` is the manifest and its ONLY owner — read it for the current entries, their layers and their enabled state. Three formats, and **adding a domain is ONE entry, no code**:

| `format` | Source |
|---|---|
| `beir-zip` | Archive URL, downloaded and unzipped |
| `beir-local` | Any local BEIR-layout directory — **including a corpus you label yourself**. `derive: {atoms, golden}` projects a local atoms dir + golden-set JSON into BEIR layout on every run |
| `bright` | HuggingFace parquet shards, written into BEIR layout |

`vault` (English, 60 topics) and `vault-hu` (Hungarian, 31 topics) are the REAL corpora and the primary tuning targets. BEIR/BRIGHT entries exist for external comparability. `vault-rephrased` / `vault-hu-rephrased` are disabled **arms** of the two — identical corpus, identical judgments, keyword-rewritten query text — run by name with `--only`. `vault-autorephrased` / `vault-hu-autorephrased` are the same arms with the rewrite produced by the shipped `--rephrase` instead of by hand, frozen into the golden file so the arm re-runs without a model: base → auto measures what the tool buys, auto → hand measures how far it is from the ceiling.

A `559`-atom `vault-hu` in any older record is the contaminated corpus (§ Landmines), not a different chunking; the clean corpus is 454 documents → 455 atoms.

## What to measure, when

| Metric | Answers |
|---|---|
| **nDCG@10** | The headline — ranking quality at the depth a caller reads |
| **P@5 / P@10 · `allGoldInTop10` · MAP · R-Precision · RBP residual** | What the CONSUMER receives, not what the ranking scores. Recorded in the per-topic TSV and the JSON summary, deliberately NOT in the markdown run table — a nine-metric row is unreadable. `allGoldInTop10` SATURATES at `min(R, 10)`, so a topic with more gold than the window can carry is not scored 0 for a shortfall no ranking can avoid; the RBP residual is the reader-attention mass sitting on UNJUDGED documents, which is a judgment-pool measure, not a ranking one |
| **R@10 / R@100** | Candidate quality — is the right document even in the pool? |
| **MRR@10** | How fast the first correct document arrives |
| Per-topic **sd** | Whether a delta is distinguishable from noise |
| **p50 / p95 query latency** | Cost of the retrieve path. Use p50 — total `queryMs` is contaminated by concurrency and has varied **11.9×** across identical arguana runs |
| **Ingest wall-time** | Cost of the index path — content-dependent, not size-driven. **`ingestMs` changed meaning at `fc1dee7b`**: every non-`fts5` row recorded BEFORE it also carries an unrelated fts5 probe build, so a `linear` / `minisearch` / `lancedb` `ingestMs` MUST NOT be compared across that commit — the drop reads as a speed-up that never happened. `fts5` rows are unaffected (its builder is a no-op, so the probe IS its measured index) |

**Know which consumer you are optimising for, and at which `k`.** A human reads the top ~10 (nDCG@10). The reranker reads `max(k, RERANK_K_INIT)` — so the binding first-stage constraint is **recall@k for the `k` that caller passes**, not a fixed recall@20:

| Caller | Effective rerank pool | Binding first-stage metric |
|---|---|---|
| CLI `retrieve -k 5 --rerank` | **100** (the floor, since `92d683e2`) | **recall@100** |
| CLI `retrieve -k 5 --rerank --rerank-pool 20` | 20 (explicit, bypasses the floor) | recall@20 |
| the bench at `--depth 100 --rerank` | 100 | recall@100 |

**Corrected 2026-08-18** — this table read "20 (the floor) · recall@20" for the CLI row, which stopped being true when `92d683e2` raised `RERANK_K_INIT` 20 → 100. It contradicted § Rerank in this same file. **Both CLI and bench now bind on recall@100 by default**, so the split this table was drawn to illustrate only exists when a caller passes `--rerank-pool` explicitly.

An nDCG@10 gain that does not raise the binding recall buys nothing downstream — but WHICH recall that is depends on `k`. **MUST NOT quote a serving-path (`k`≤20) conclusion as a benchmark result, or the reverse.** Measured on scifact at depth 100: reranking moved R@20 0.8546 → 0.8847, which a fixed top-20 reorder cannot do — evidence that the pool was 100.

| Trigger | Requirement |
|---|---|
| Any retrieval, chunker, tokenizer or scoring change | MUST run the suite |
| Any chunk-size change | MUST re-sweep BM25 params — `b` is the length-normalization term, so its optimum moves with document length |
| Quoting the winning cell of a grid | MUST NOT quote its per-cell p-value as if pre-specified — it is the max of N correlated cells and is optimistically biased. Pre-specify the cell, split topics tune/test, or use a max-statistic null |

## Known harness gaps

| Gap | Consequence |
|---|---|
| **Exact-body dedupe DESTROYS gold documents, and an atom-id coverage check cannot see it** — root-caused 2026-08-19 | The post-T2.1 smoke gate's `vault` −0.0921 (p=0.0005) is **not** a provenance artefact and **not** ranking drift: per-topic, 21 of 60 topics moved, **9 zeroed**, and **8 of those lost `recall@100` outright** — the gold document left the corpus. Mechanism, read off the `.trec`: for a mirrored document the dedupe keeps ONE copy, and on `q-004/008/013/014/032/042/047/050` it kept the mirror and dropped the copy the golden set judges (`ts-debugging-rules-…` dropped, `60-debugging-…` kept). **Which copy survives depends on the corpus ROOT SET** — the I-lane measured the opposite direction on corpus v2 (with the `docs/` root) and recorded a 19-id re-point that does not touch a single one of the 8 damaged topics. Why review missed it: `fetch/vault.ts` **warns** on unreachable gold (`describeDerivation` prints the count and the recall ceiling) and does NOT refuse, and the 93.29 % coverage figure was measured on the I-lane's own corpus, never on the one the gate scored. Rules: a dedupe MUST be gold-aware and root-set-stable; unreachable gold above a declared floor MUST REFUSE (exit 3), not print; a coverage figure MUST be quoted with the corpus it was measured on, and one measured elsewhere MUST NOT be carried across; a re-point computed on one root set MUST NOT be applied to another. Separately (and still open): `atomCount` moves but is **not a `SCALE_FIELD`**, so `compare.ts` will subtract across any ingest-rule change — after ANY such change a pre-change baseline MUST NOT gate the post-change corpus. Detail: `docs/analysis/2026-08-18-dp-gnosis-full-review/07-plan.md` § 6; remedy T2.1a in `13-open-tasks.md` |
| **The bench applies NO `domain` / `type` filter, though the golden sets author them** — now WARNED | `engine.ts` retrieves with `{ k: depth }` only, while `golden-set.v2.json` sets a filter on **7 of 60** English topics and `golden-set-hu.v1.json` on **4 of 31** Hungarian ones. Two consequences. (1) `q-059` (no filter) and `q-060` (`type: "adr"`) carry identical query text AND identical 36-document gold sets, so under the retrieval actually performed they are ONE topic counted TWICE in every macro-average `vault` and `vault-rephrased` have ever recorded — `vault-hu` has none. `collapsingTopicGroups` (`run.ts`) now detects this and `runDataset` emits a `dp-gnosis-bench/collapsing-topics` **warning**, deliberately NOT a refusal: the pair is authored on purpose and refusing would block every `vault` run. (2) The filtered path has **no benchmark coverage at all**, so the G4 filter-before-truncate fix (E3) has no measured regression guard. MUST NOT read a filtered topic's recorded score as evidence about the filtered path |
| **Depth beyond 100 is unmeasured on BRIGHT** | Every recorded `bright-biology-passages` run is `depth=100`, and `metrics.ts` computes no rank percentile and no pool-oracle score — so R@300/@1000, first-gold-rank and oracle-pool nDCG **cannot be produced by the suite as it stands**. An earlier revision of this file quoted such a curve as fact; it traced to no recorded run and is **withdrawn**. Re-run at depth and record it before quoting any of it |
| **No per-STAGE latency split** — narrowed 2026-08-18, the p50 half was FALSE | **WITHDRAWN** — this row read *"no per-topic latency is recorded… MUST NOT quote a p50"*. `run.ts` has timed every topic and recorded `queryP50Ms` / `queryP95Ms` per dataset since 2026-08-14 (`gitSha` 1134d464), present on **233 of 247** history rows, so **p50 and p95 MAY be quoted from any row carrying them**. What is genuinely missing: retrieval, rerank and fusion cannot be separated, so the qwen3-4b-vs-bge cost RATIO in BASELINES § Serving path remains an INFERENCE from two arms; and the individual per-topic timings are not persisted, only their p50/p95 summary, so a recorded run cannot be re-analysed for tail shape |
| **The bench never exercises a query builder** | It sends RAW query text — there is no query builder any more (the dead `buildQuery` and `QUERY_MAX_TERMS` were DELETED 2026-08-31, owner decision D3). Partly mitigated: the phrasing lever is measurable via the committed rephrased arms, which vary query TEXT |
| **`linear` vs `fts5` disagree by a sign-flipping offset** | Both leading hypotheses (IDF formula; the `title` field) were tested by direct experiment and **refuted**. A third mechanism dominates on long-atom corpora. Every cross-adapter claim carries an unexplained term |
| **BEIR does NOT cover the chunker** | BEIR documents are short — scifact's 5,183 documents yield 5,202 atoms — so chunking is near a no-op across all seven Tier-1 datasets. A chunker regression would pass the entire external suite unnoticed. **The vault corpora remain the only chunker signal.** The suite covers the scorer, tokenizer and index layer |
| **`vault-hu` is underpowered** | Smallest detectable Δ nDCG@10 ≈**0.05–0.07** at 31 topics, against ≈**0.015** for `vault` at 60 — both derived from observed paired-CI width in the campaign analysis §8. Topic count explains only √(60/31) ≈ 1.4× of that 4.8× gap; the rest is a smaller per-topic difference sd. A null on `vault-hu` means "cannot tell", not "no difference". **MUST NOT quote any other MDE figure for these corpora** |
| **`packages/gnosis-bench/scripts/` is type-checked by NO project** | The repo's `tsconfig.scripts.json` excludes it and the package's own `tsconfig.json` includes `src/**` only, so `validate-metrics.py`'s TS siblings — `inventory-artefacts.ts` today — are outside the commit gate's `tsc -b`. They break silently against a `src/` change and only a hand-run reveals it. Owner decision 2026-08-18: recorded, not fixed |
| **A rerank batch is accounted in BYTES against a TOKEN cap** | `chunkDocuments` (`packages/gnosis/src/bench/reranker.ts` — ENGINE code on the serving path, not bench-owned) sizes batches with `estimateTokens` = `Buffer.byteLength(text,'utf8')` against `MAX_BATCH_TOKENS = 8000`, while the server's `-ub` cap is per query-document pair in real tokens. No overflow today, but the conflation sets batch size by byte length: at pool 100 a 2000-char window packs 3 docs/batch (34 requests) and a 4000-char window packs 1 (100 requests), a **~3× round-trip cost that is a batching artefact, not a model cost**. MUST NOT report a width arm's wall-time as a property of the reranker. Headroom is thinner than it looks — a corpus averaging ≥2 bytes/char would trip `RerankOversizeError` on a single 4000-char document |
| **The golden set cannot adjudicate an identifier-SPLIT lever** — measured 2026-08-29 | `porter-fold` splits on non-alphanumerics only (`NON_WORD_SPLIT_RE`), so `useChatStore` is ONE token (`usechatstor`); `ident-porter-fold` ADDS the unstemmed whole token beside it and splits nothing. A camelCase-splitting chain is therefore an UNBUILT treatment, and `golden-set.v2.json` cannot adjudicate one. Over spans of 2-5 words exactly **2 of 60** topics (`q-002` "no verdict" -> `noVerdict`, `q-049` "per attempt" -> `perAttempt`) would newly match a corpus identifier through a split, while **8** carry a camelCase identifier as the query term itself and already match it exactly. The set's own `minimumMeaningfulDifference` requires **>=3 topics (>=5.0 pts)** to be interpretable, so the benefit population sits BELOW its floor: such an arm can return only "no interpretable difference" or measurable harm, and neither changes the decision. This is a COVERAGE gap, NOT a verdict on the lever - the corpus holds **4 432** distinct camelCase identifiers, so the behaviour is real and simply untested. Measuring it needs split-form topics judged by reading atom bodies (never from retriever output), which re-opens the comparability caveat the set already carries for `q-051..q-060`. Identifier count read off the CURRENT 14 706-atom vault; the golden set is frozen at `corpusAtomCount` 11 522 |
| No skip-reason breakdown | Benign drops read as unexplained attrition |
| Grid winners are selection-uncorrected | A best-of-N cell's p-value is optimistically biased — see § What to measure |
| Sweep is `linear`-only | By necessity — no other adapter accepts k1/b — but it means sweep results never describe production |

**Resolved gaps** (kept for provenance when re-reading an older run): `GNOSIS-HISTORY.md` § Closed harness gaps.
