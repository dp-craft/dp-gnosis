<!-- LLM-PRIMARY: The PARITY baseline set — dp-gnosis measured at qmd's OWN operating point (n=40, qwen3-reranker-0.6b, depth 40) so the head-to-head rests on matched settings rather than disclosed asymmetries. dp-gnosis wins both corpora at every level of parity, including one where qmd's own handicap is applied to us. Read GNOSIS-GUIDE.md first; the head-to-head deliverable is docs/analysis/2026-08-21-dp-gnosis-vs-qmd-head-to-head.md. A SNAPSHOT: it orients, it never gates. -->

# Gnosis Baselines — the n=40 / 0.6b PARITY set

Measured 2026-08-21, adapter `fts5`, on a **verified-clean GPU**.

The arms span `gitSha` 7763d9b8 → e1658b24 because an unrelated session committed to this repo while they ran. **No gnosis code moved**: `git diff --stat 7763d9b8..e1658b24 -- tools/dp-gnosis tools/dp-gnosis-bench/src` is empty, and the two headline runs — recorded on either side of one of those commits — produced byte-identical `.trec` files. The sha variation is provenance noise, not a treatment.

**This file exists to remove excuses, not to describe the served path.** `GNOSIS-BASELINES.md` records what dp-gnosis actually ships (`qwen3-reranker-4b`, pool 100). Everything here is dp-gnosis deliberately **handicapped down to qmd 2.8.3's operating point** so that the comparison in `docs/analysis/2026-08-21-dp-gnosis-vs-qmd-head-to-head.md` rests on matched settings instead of disclosed asymmetries.

**It orients; it MUST NOT gate anything.** These are not champion figures and MUST NOT be quoted as dp-gnosis quality. Rules, architecture and landmines: `GNOSIS-GUIDE.md`.

## What was matched, and what was left alone

| Asymmetry | Setting applied | Rationale |
|---|---|---|
| Rerank pool | `--rerank-pool 40` | qmd's stock `--candidate-limit` bounds its whole result set at 40 (L9) |
| Cross-encoder | `--rerank-model qwen3-reranker-0.6b` | same model class as qmd's bundled reranker |
| Reported depth | `--depth 40` | qmd cannot return more than 40, so **our recall column is now censored identically**. Previously this was a labelled caveat (`R@≤40`); it is now a property of both runs. Rankings are unaffected — pool 40 already capped the output, and the `.trec` is byte-identical to the recorded depth-100/pool-40 arm |
| Generative query expansion | separate arm over `vault-autorephrased` / `vault-hu-autorephrased` | qmd rewrites every query with a 1.7B model. That was the one remaining asymmetry favouring **qmd**. These datasets are the shipped `--rephrase` output frozen into the golden file, so the arm re-runs with no chat model and no GPU contention |
| Fusion rule | unchanged — `shipped` (RRF, weight 0.75) | qmd's `--explain` shows it *blends* reranker with first-stage order. `beir-ce` (pure replacement) would be the **less** equal choice, not the more equal one |
| Chunking | unchanged | `atomMaxChars` is a `SCALE_FIELD`; moving it would invalidate every recorded row. Disclosed, not corrected |
| RRF weight | unchanged, NOT swept | sweeping it would be tuning our side against qmd's stock — the opposite of parity |
| Dense leg | **NOT run** | see § Not measured |

## The arms

`vault` 6628 documents / 60 topics · `vault-hu` 454 / 31. All `fts5`, depth 40. qmd rows are the EXTERNAL system, reproduced from `GNOSIS-BASELINES.md` § EXTERNAL SYSTEM for reading convenience only — they live in `results/external/`, never in `results/history.jsonl`.

| Arm | `vault` nDCG@10 | `vault-hu` nDCG@10 | `vault` R@10 | `vault-hu` R@10 | `vault` R@40 | `vault-hu` R@40 |
|---|---|---|---|---|---|---|
| dp-gnosis BM25 only | 0.4894 | 0.4868 | 0.5642 | 0.5543 | — | — |
| **dp-gnosis + 0.6b, pool 40** | **0.5400** | **0.6931** | 0.5989 | 0.7274 | 0.7642 | 0.7597 |
| dp-gnosis + 0.6b, pool 40, auto-rewritten queries | 0.5128 | 0.6836 | 0.5799 | 0.6989 | — | — |
| dp-gnosis BM25 only, auto-rewritten queries | 0.4588 | 0.4953 | 0.5488 | 0.5559 | — | — |
| *qmd `--no-rerank`* | *0.3265* | *0.4180* | *0.3716* | *0.4522* | *0.6339* | *0.6968* |
| *qmd stock, run 1* | *0.4025* | *0.4962* | *0.4896* | *0.5726* | *0.6339* | *0.6968* |
| *qmd stock, run 2* | *0.3995* | *0.4764* | *0.4729* | *0.5145* | *0.6300* | *0.6710* |

`vault` carries the `q-059`/`q-060` collapsing-topic pair (GNOSIS-BENCH.md § Known harness gaps) — one topic counted twice in every macro-average, as in every `vault` run ever recorded.

## Paired, at full parity — qmd minus dp-gnosis

Negative ⇒ dp-gnosis ahead. Paired permutation (10k) + bootstrap CI (10k, 95%), scored by `metrics.ts:scoreTopic` at document level over the qrels topic set.

| Corpus | vs run | Δ nDCG@10 | p | 95 % CI | Δ MRR@10 | Δ MAP |
|---|---|---|---|---|---|---|
| `vault` | run 1 | **−0.1375** | 0.0001 | [−0.1919, −0.0838] | −0.1951 | −0.1402 |
| `vault` | run 2 | **−0.1406** | 0.0001 | [−0.1972, −0.0854] | −0.1797 | −0.1380 |
| `vault-hu` | run 1 | **−0.1969** | 0.0015 | [−0.3126, −0.0872] | −0.2328 | −0.1995 |
| `vault-hu` | run 2 | **−0.2167** | 0.0009 | [−0.3352, −0.1064] | −0.2164 | −0.2019 |

Every metric on both corpora against both qmd runs is significant and favours dp-gnosis. Both deltas exceed each corpus's MDE (≈0.015 `vault`, ≈0.05–0.07 `vault-hu`).

**With qmd's own handicap applied to us** — our auto-rewritten arm against qmd stock run 1:

| Corpus | Δ nDCG@10 | p | 95 % CI | Δ MRR@10 | Δ MAP |
|---|---|---|---|---|---|
| `vault` | **−0.1103** | 0.0002 | [−0.1633, −0.0581] | −0.1466 | −0.1144 |
| `vault-hu` | **−0.1874** | 0.0093 | [−0.3133, −0.0588] | −0.2234 | −0.2088 |

The conclusion survives every asymmetry being matched or turned against us.

## The mechanism splits by LANGUAGE — this set's main finding

Pairing the two first stages directly, with **no reranker on either side** and both censored at 40:

| Corpus | Δ nDCG@10 (qmd − gnosis) | p | 95 % CI | verdict |
|---|---|---|---|---|
| `vault` | **−0.1629** | 0.0001 | [−0.2259, −0.1014] | SIGNIFICANT |
| `vault-hu` | −0.0688 | 0.2362 | [−0.1801, +0.0405] | **ns** |

And what each system's reranker converts, at matched depth 40:

| Corpus | dp-gnosis first→reranked | qmd first→reranked |
|---|---|---|
| `vault` | +0.0506 | **+0.0760** |
| `vault-hu` | **+0.2063** | +0.0782 |

**The English win is first-stage; the Hungarian win is the reranker.** On `vault`, plain BM25 already beats qmd's whole hybrid pool by 0.1629, and qmd's reranker converts *more* than ours — the gap narrows to 0.1375 after both rerank. On `vault-hu` the first stages are indistinguishable (`ns` — "cannot tell" at 31 topics), and the entire margin appears at the rerank step, where our 0.6b extracts +0.2063 from a comparable pool against qmd's +0.0782.

**This refines the head-to-head deliverable § 4**, which attributed the deficit to first-stage recall on both corpora. That holds for English only. It also further weakens H2's premise: Hungarian is where qmd's multilingual embedder was expected to have its best case, and its first stage indeed draws level there — it is the *ordering* that loses.

## Reproducibility — the symmetry qmd could not supply

The headline arm was run **twice, back to back**:

| Corpus | run 1 | run 2 | `.trec` |
|---|---|---|---|
| `vault` | 0.5400 / R@10 0.5989 / MRR 0.6946 | identical | **BYTE-IDENTICAL** |
| `vault-hu` | 0.6931 / R@10 0.7274 / MRR 0.8161 | identical | **BYTE-IDENTICAL** |

qmd, over its own two runs, reproduced **7 of 60** English and **18 of 31** Hungarian topic rankings. dp-gnosis reproduces 100 % of both, measured the same day on the same GPU. This is the reproducibility claim in `GNOSIS-GUIDE.md` demonstrated on this arm rather than cited from another.

## Cost — and why p95 is NOT quotable here

Measured on a verified-clean GPU (VRAM stamped before and after every arm; foreign-process count 0 throughout).

| Arm | `vault` p50 | `vault-hu` p50 |
|---|---|---|
| dp-gnosis BM25 only | **8 ms** | **2 ms** |
| dp-gnosis + 0.6b, pool 40 | **2 694 / 2 704 ms** | **3 276 / 3 286 ms** |
| *qmd stock (clean-GPU re-run)* | *11 857 ms* | *3 898 ms* |
| *qmd `--no-rerank`* | *7 168 ms* | *3 738 ms* |

At matched pool dp-gnosis is cheaper on both corpora, and its BM25-only path is three orders of magnitude cheaper.

**p95 MUST NOT be quoted from these arms.** Across the two identical runs p50 reproduced to within 0.4 % (2694→2704, 3276→3286) while p95 swung 3–10× in **both** directions (`vault` 4554→13777, `vault-hu` 38737→3871). The tail is llama-swap evicting and reloading the reranker between arms — the cold-load landmine — not a property of the retrieval path. This is a measured demonstration of GNOSIS-BENCH.md § What to measure's "use p50" rule.

## EXTERNAL DATA — BEIR, and the verdict SPLITS

Measured 2026-08-21, same parity settings, both systems. `nfcorpus` 3 633 documents / 323 test topics · `scifact` 5 183 / 300. Documents were materialized to `<docid>.md` by this suite's own `corpus.ts:materializeCorpus`, so `basename(file,'.md')` is the docid on both sides by construction. Each dataset got its OWN project-local `.qmd` index — qmd otherwise shares one global SQLite across collections, where a scifact query could reach an nfcorpus document.

**This section exists because the vault corpora are dp-gnosis's own primary tuning targets.** Its analysis chain, chunker and defaults were developed against them; qmd arrived on stock defaults. That home advantage cannot be removed by matching knobs — only by measuring somewhere else.

| Dataset | dp-gnosis BM25 | dp-gnosis parity | **dp-gnosis parity + PRF** | **qmd** | Δ old | **Δ new** | p new | 95 % CI new | winner old → **new** |
|---|---|---|---|---|---|---|---|---|---|
| `nfcorpus` (323) | 0.3164 | 0.3624 | **0.3818** | 0.3820 | +0.0196 | **+0.0002** | 0.9838 | [−0.0160, +0.0164] | qmd → **tie** |
| `scifact` (300) | 0.6858 | 0.7511 | **0.7494** | 0.7129 | −0.0382 | **−0.0364** | 0.0283 | [−0.0683, −0.0036] | dp-gnosis → **dp-gnosis** |
| `vault` (60) † | 0.4858 | 0.5402 | **0.5437** | 0.3754 | −0.1648 | **−0.1683** | 0.0001 | [−0.2294, −0.1096] | dp-gnosis → **dp-gnosis** |
| `vault-hu` (31) | 0.4868 | 0.6931 | **0.7033** | 0.4962 | −0.1969 | **−0.2071** | 0.0005 | [−0.3135, −0.1042] | dp-gnosis → **dp-gnosis** |

**The `parity + PRF` column and the `new` columns were measured 2026-08-22**, after RM3 pseudo-relevance feedback became a served profile default (`SERVED_PRF_PARAMS` = `fbDocs 10 · fbTerms 40 · α 0.5`). It is a single-treatment change — `compare.ts` labels every pairing `ARM COMPARISON — prf false → true` and nothing else — and the two other BEIR datasets in the head-to-head move the same way (`scidocs` 0.1930 → 0.1985, tie → dp-gnosis win; `arguana` 0.4675 → 0.4746, still qmd's but narrowed +0.0311 → +0.0241) — so the four-dataset external verdict flips to **dp-gnosis two, qmd one, one tie**. **† `vault` is re-baselined**: its corpus moved 6 628 → 6 787 documents, so both gnosis columns are post-boundary arms and **qmd's index was rebuilt on the same corpus** — the qmd column there is 0.3754, not the retired 0.4025. Full decomposition and the reading rules: `docs/analysis/2026-08-21-dp-gnosis-vs-qmd-head-to-head.md` § 11.1, § 11.2 and § 14, which supersede this snapshot on any disagreement.

nDCG@10. **As measured on 2026-08-21 both BEIR CIs excluded zero — the nfcorpus loss was real, not noise.** On nfcorpus qmd also won R@10 (+0.0217, p=0.0002), P@10 (+0.0297, p=0.0002) and MAP (+0.0151, p=0.0017), with MRR@10 null; on scifact dp-gnosis won MRR@10 (−0.0473, p=0.0119) and MAP (−0.0477, p=0.0089), with R@10 and P@10 exactly null. **At the served PRF cell the nfcorpus loss is gone** — all five metrics null (nDCG@10 +0.0002 p=0.9838, R@10 +0.0052, MRR@10 −0.0011, P@10 +0.0130, MAP −0.0040) — while scifact keeps MRR@10 (−0.0467, p=0.0103) and MAP (−0.0439, p=0.0136).

**The honest reading, and it moved once.** On 2026-08-21 the two systems **split one–one on this pair** by small margins (0.02–0.04); at the served PRF cell nfcorpus is a tie and scifact still ours. On dp-gnosis's own corpora dp-gnosis wins by 0.17–0.21 — **five to ten times larger**. The size of the home-corpus margin is therefore not a general property of the engine, and MUST NOT be quoted as one. What survives as a general claim: dp-gnosis is *at least even with* a well-built hybrid+rerank system on this external pair, and *decisively better* on the corpus it serves. The four-dataset picture, which is the one to quote, is in the head-to-head § 14.

What each system's reranker converts, at matched depth 40:

| Dataset | first→reranked, BM25 pool | **first→reranked, PRF pool** |
|---|---|---|
| `nfcorpus` | +0.0460 | +0.0391 |
| `scifact` | +0.0653 | +0.0694 |
| `vault` † | +0.0544 | +0.0604 |
| `vault-hu` | +0.2063 | +0.1734 |

**Conversion is not constant and its sign is corpus-dependent** — the enriched PRF pool converts *less* on `nfcorpus` and `vault-hu` and *more* on `scifact` and `vault`, while the reranked result still rises on three of the four. This is the quantified form of the settled rule that a first-stage gain MUST NOT be projected through the reranker at a constant rate (`GNOSIS-GUIDE.md` § Settled). † `vault` rows are the post-boundary 6 787-document corpus on both columns (BM25 0.4858 → 0.5402; PRF 0.4833 → 0.5437), so they are comparable to each other and NOT to the +0.0506 this table previously carried.

### Cost on BEIR — and a correction that does NOT flip it

| Quantity | dp-gnosis | qmd |
|---|---|---|
| Index build, `nfcorpus` | **1.6 s** | 51.9 s (32×) |
| Index build, `scifact` | **2.1 s** | 71.4 s (34×) |
| qmd index on disk | — | 35 MB / 49 MB |
| p50, `nfcorpus` | **2 296 ms** (BM25 only: **2 ms**) | 11 590 ms |
| p50, `scifact` | **2 357 ms** (BM25 only: **11 ms**) | 12 125 ms |

**Every qmd latency in this repository is inflated by ~3.7 s of per-invocation model loading**, and that is measured, not assumed: on an identical pipeline (vector-only search, same query, same index) a resident-model HTTP daemon answered in **0.024 s** where the CLI took **3.73 s**. qmd's CLI reloads ~2.1 GB of models on every call; its own README offers `qmd mcp --http --daemon` expressly to avoid "repeated model loading".

Correcting for it, qmd's BEIR p50 becomes ~7.9 s / ~8.4 s — **still ~3.5× dp-gnosis's parity path**, so the cost verdict holds here. It does **not** hold everywhere: on `vault-hu` the same correction takes qmd from 3 898 ms to ~200 ms against our 3 276 ms, which likely **reverses** that row. See `docs/analysis/2026-08-21-dp-gnosis-vs-qmd-head-to-head.md` § 6, where the figures are recorded uncorrected.

### Why the resident-model path was NOT used for quality

`POST /query` takes **typed** sub-queries (`lex`/`vec`/`hyde`) and does not run qmd's generative query expansion — the raw question sent as `lex` returned **0 results**. Driving it that way would measure qmd stripped of its main mechanism, so the arms used the CLI and paid the loading tax. `qmd bench` was rejected for a different reason: it emits only aggregate precision/recall/MRR/F1, never rankings, so it cannot feed this suite's scorer.

### Reading the recall columns

Depth 40 on both sides. `nfcorpus` averages ~38 relevant documents per topic, so its recall is **depth-limited for both systems** and is not comparable to a published R@100. nDCG@10 is unaffected.

## What this set does NOT show

- **Not the served path.** dp-gnosis ships `qwen3-reranker-4b` at pool 100: `vault` 0.5791, `vault-hu` 0.7699. The 0.6b/pool-40 constraint understates dp-gnosis by ~0.039 EN / ~0.077 HU. MUST NOT quote a figure here as dp-gnosis quality.
- **Not a scorer comparison.** One scorer ran over both systems; this set varies the *system*, not the measure.
- **R@100 does not exist here.** Depth 40 on both sides by construction. The `R@40` column is the deepest recall this set can carry.

## Not measured — the architecture-parity arm

The deepest form of parity would run dp-gnosis on `lancedb-hybrid` at `--hybrid-weight 0.25`, matching qmd's dense⊕lexical *architecture* rather than only its knobs. **It was not run**: `@lancedb/lancedb` and `apache-arrow` are declared `optionalDependencies` of `tools/dp-gnosis` but are not installed in this tree, so the arm needs an install plus a full `bge-m3` embedding pass over 6628 atoms. `GNOSIS-GUIDE.md` § Settled already records the dense leg as neutral at best on these corpora, and qmd's own dense-dominated pool reaching a *worse* first stage (above) is independent evidence in the same direction — so the arm is expected to confirm rather than discover. Recorded as deliberately skipped, not overlooked.

## Provenance

- dp-gnosis rows: `results/history.jsonl` (tracked), per-topic TSVs and `.trec` under `results/per-topic/` and `results/runs/`.
- Arms recorded under shas 7763d9b8 (first-stage + autorephrased first-stage), acc4c932 (headline + repeat) and e1658b24 (autorephrased reranked); none of the three intervening commits touched gnosis source.
- qmd rows: `results/external/` **only** — 0 qmd rows in the tracked history; `compare.ts` and the regression gate cannot see them (F7).
- Cross-system pairings deliberately bypass `pair.ts`'s provenance guard — `depth` and `atomCount` are `SCALE_FIELDS` and the two systems genuinely chunk differently, but every metric is scored at DOCUMENT level over the same documents, topics and qrels, so an internal chunk count cannot move it. The statistic is `significance.ts:pairedScores`, the same one every gnosis pairing uses.
