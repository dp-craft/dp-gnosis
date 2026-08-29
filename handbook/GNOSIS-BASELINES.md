<!-- LLM-PRIMARY: The measured dp-gnosis baselines — real corpora, rerank arms, BEIR Tier-1 against published, and BRIGHT. A SNAPSHOT: it orients, it never gates. Routed from GNOSIS-GUIDE.md § Current measured state. -->

# Gnosis Baselines — the measured snapshot

> **`docs/` paths below are provenance, not links** — that tree is gitignored and does not ship with the repository. `GNOSIS-GUIDE.md` owns the statement of that boundary.

**This file orients; it MUST NOT block or decide anything.** Re-measure before acting on any number here. Every figure is `fts5`, depth 100, BM25-only unless the row says otherwise.

Rules, architecture and landmines live in `GNOSIS-GUIDE.md`. The campaign deliverable `docs/analysis/2026-08-15-0857-dp-gnosis-pre-rerank-full-picture.md` **supersedes this file if the two ever disagree**.

## EXTERNAL SYSTEM — NOT a dp-gnosis baseline

**Everything under this heading was produced by a DIFFERENT retrieval system.** It is kept here because the adopt rule that fired asked for it, and it is fenced off deliberately: an external row MUST NOT be pooled with, subtracted from, or gated against any dp-gnosis figure elsewhere in this file. The rows live in `results/external/`, never in `results/history.jsonl`, and `compare.ts` and the regression gate cannot see them.

### `tobi/qmd` 2.8.3 head-to-head — measured 2026-08-21 at engine `gitSha` e468b2bd

**dp-gnosis re-measured at qmd's OWN operating point — pool 40, `qwen3-reranker-0.6b`, depth 40 — is in `GNOSIS-BASELINES-n40-q06.md`.** It closes the pool, reranker, depth and query-rewriting asymmetries below; the verdict is unchanged and the mechanism splits by language.

Both systems at `qwen3-reranker-0.6b`, both scored by `metrics.ts:scoreTopic` at document level over the qrels topic set at depth 100. qmd ran STRICTLY black-box on stock defaults. Corpus: `vault` 6628 documents / 60 topics, `vault-hu` 454 / 31.

| Arm | `vault` nDCG@10 | `vault-hu` nDCG@10 | `vault` R@≤40 | `vault-hu` R@≤40 | p50 EN | p50 HU |
|---|---|---|---|---|---|---|
| dp-gnosis `fts5` BM25 only | 0.4894 | 0.4868 | — | — | 11 ms | 4 ms |
| dp-gnosis `fts5` + 0.6b, pool 40 | **0.5400** | **0.6931** | 0.7642 | 0.7597 | 2 616 ms | 3 267 ms |
| dp-gnosis `fts5` + 0.6b, pool 100 | **0.5448** | **0.7086** | 0.8493 (R@100) | 0.8903 (R@100) | 6 391 ms | 8 148 ms |
| dp-gnosis `fts5` + 4b, pool 100 — *the SERVED path* | **0.5791** | **0.7699** | 0.8493 (R@100) | 0.8903 (R@100) | — | — |
| **qmd stock (`query`) — run 1** | 0.4025 | 0.4962 | 0.6339 | 0.6968 | — | — |
| **qmd stock (`query`) — run 2** | 0.3995 | 0.4764 | 0.6300 | 0.6710 | 11 857 ms | 3 898 ms |
| **qmd `--no-rerank`** | 0.3265 | 0.4180 | 0.6339 | 0.6968 | 7 168 ms | 3 738 ms |

Paired, at MATCHED pool 40, qmd minus dp-gnosis (negative ⇒ dp-gnosis ahead):

| Corpus | Δ nDCG@10 | p | 95 % CI | Δ MRR@10 | Δ MAP |
|---|---|---|---|---|---|
| `vault` (60 topics) | **−0.1375** | 0.0001 | [−0.1919, −0.0838] | −0.1951 | −0.1402 |
| `vault` (59-topic dedup, L6) | −0.1398 | 0.0001 | [−0.1974, −0.0847] | −0.1900 | −0.1425 |
| `vault-hu` (31 topics) | **−0.1969** | 0.0015 | [−0.3126, −0.0872] | −0.2328 | −0.1995 |

Four facts worth carrying:

- **`-n` is capped.** qmd returns at most **40** documents per query regardless of `-n 100` or `--all`. Its "R@100" is R@≤40 and is labelled so above; nDCG@10 is unaffected. It also bounds plan note N5 empirically: the candidate limit is **40**, not the README architecture section's 30.
- **The pool asymmetry is small here** — re-running our own arm at pool 40 costs only **0.0048 (EN)** and **0.0155 (HU)**. It does not explain the result. The +0.0537 HU figure quoted in older material is an OLD-CORPUS value and MUST NOT be carried forward.
- **qmd's reranker is fine; its pool is not.** `--no-rerank` shows the reranker buying +0.0760 EN / +0.0782 HU. The deficit is first-stage recall (R@40 0.6339 vs our 0.7642 EN).
- **Independent confirmation of § Settled's dense-leg result.** qmd's candidate pool is vector-dominated on our corpora (86 % of RRF contributions on EN, 98 % on HU, read off `--explain`) and still recalls less gold than plain BM25 — reached with a different embedder, fusion and always-on leg-specific rewriting.

- **qmd is NOT run-to-run reproducible.** Two identical invocations reproduced the ranking on only **18 of 31** HU and **7 of 60** EN topics. Aggregate nDCG@10 is stable (EN 0.4025→0.3995, HU 0.4962→0.4764). Mechanism likely its generative query expansion, **unconfirmed** (black-box constraint). **A single qmd arm MUST NOT be quoted as qmd's number.**
- **Latency here is clean-GPU only.** The first arms ran while llama-swap still held a 27B model and recorded 13 078 / 14 262 ms — plausible, and wrong. MUST evict llama-swap and VERIFY VRAM before timing any second engine on this box.

Cost: qmd indexes `vault` in **5 m 29 s** (vs our 3.9 s ingest) into **69 MB** (vs our 5.0 MB), plus ~2.1 GB of auto-downloaded models. Per query the picture is mixed: at matched pool 40 dp-gnosis is cheaper on both corpora; against our pool-100 path qmd wins on Hungarian (3 898 vs 8 148 ms) and loses on English (11 857 vs 6 391 ms).

Full write-up, every landmine that fired, and the scorer gate that proves both systems were scored identically: `docs/analysis/2026-08-21-dp-gnosis-vs-qmd-head-to-head.md`.

---

### CORPUS v2 BOUNDARY — the vault was re-ingested 2026-08-19 (T2.1c / T2.1e)

**Every `vault` / `vault-rephrased` / `vault-autorephrased` row recorded BEFORE this boundary
describes a corpus that no longer exists.** Two independent tables — **MUST NOT be subtracted**.
`vault-hu`, `scifact`, `nfcorpus` and BEIR are UNAFFECTED (different atoms dir / corpora) and their
rows stand.

What changed: `docs/` became a live corpus root (213 authored documents), the CLI ingest became
gold-aware, and two duplicate/machine-output trees were excluded. `atomCount` 11345 -> **14127**.

**Pinned BM25 reference `2026-08-19-151019579` (`gitSha` `f43fb9fe`), regression gate verified exit 0:**

| dataset | nDCG@10 | R@10 | R@100 | MRR@10 | atoms |
|---|---|---|---|---|---|
| `vault` | **0.4119** | 0.4896 | **0.8156** | 0.5107 | 14127 |
| `vault-hu` | 0.4868 | 0.5543 | 0.8903 | 0.6073 | 455 |
| `scifact` | 0.6858 | 0.8249 | 0.9177 | 0.6476 | 5202 |
| `nfcorpus` | 0.3164 | 0.1501 | 0.2449 | 0.5194 | 3605 |

**`vault` 0.4721 -> 0.4119 is NOT a quality regression** and MUST NOT be quoted as one. R@100 ROSE
(+0.0115), 33 of 60 topics are unchanged, and the documents displacing gold are authored on-topic
analysis newly admitted by the `docs/` root — named, not inferred (`07-plan.md` § 6.20).
`rbpResidual` 0.7624 -> 0.7943 sizes the unjudged mass. Whether those documents are RELEVANT is
**unjudged and not claimed**; T5.3 / T5.4 settle it.

**Every reranked champion figure in this file predates this boundary AND the `RERANK_RRF_WEIGHT`
0.5 -> 0.75 adoption.** They are recorded values for a configuration no longer served, on two axes.
**The re-measurement is DISCHARGED — see § Champion at the served config below.**

### SERVING-ALIGNMENT BOUNDARY — the bench now measures only the types the CLI serves (T2.9, 2026-08-19)

**Every `vault` / `vault-rephrased` / `vault-autorephrased` row recorded BEFORE this boundary scored a
corpus of which 53.7 % is invisible to every `retrieve`.** Two independent tables — **MUST NOT be
subtracted**; `atomCount` 14152 -> **6554** is a `SCALE_FIELD`, so `compare.ts` refuses anyway.
`vault-hu`, `scifact`, `nfcorpus` and BEIR are UNAFFECTED and their rows stand — **verified
byte-identical `.trec`, not assumed**.

What changed: the derive subtracts the profile's `defaultExcludedTypes` (`feature-log`, `benchmark`,
`review`, `brainstorm`) before writing `corpus.jsonl`; `--include-history` restores the full corpus;
the effective filter is stamped as the TREATMENT field `typeFilter`. Why the derive and not
`port.retrieve`: `corpus.ts` re-labels every bench atom `vendor-doc` at ingest, so the bench index
carries no type at all and a retrieve-time filter would have matched everything
(`07-plan.md` § 6.34).

**Pinned BM25 reference `2026-08-19-203425629` (`gitSha` `ec47fdb2`):**

| dataset | nDCG@10 | R@10 | R@100 | MRR@10 | atoms | vs pre-alignment |
|---|---|---|---|---|---|---|
| `vault` | **0.4898** | 0.5642 | **0.8493** | 0.6196 | **6554** | new table |
| `vault-hu` | 0.4868 | 0.5543 | 0.8903 | 0.6073 | 455 | `.trec` **byte-identical** |
| `scifact` | 0.6858 | 0.8249 | 0.9177 | 0.6476 | 5202 | `.trec` **byte-identical** |
| `nfcorpus` | 0.3164 | 0.1501 | 0.2449 | 0.5194 | 3605 | `.trec` **byte-identical** |

**`vault` 0.4119 -> 0.4898 is NOT a quality gain and MUST NOT be quoted as one.** Serving already
applied this filter, so not one user-visible rank changed. It is the size of the MEASUREMENT ERROR
the suite carried: it had been UNDERSTATING served English quality by **+0.0778** nDCG@10 and
**+0.1089** MRR@10. An offline forecast from the recorded `.trec` pre-registered **+0.0762 as a lower
bound** before the arm ran; the measured **+0.0778** landed above it, agreeing to **0.0016**.
Per topic: the 51 topics holding an excluded-type atom in their recorded top-10 move **+0.0899**, the
other 9 move +0.0091, and only 2 regress (`q-047` −0.0154, `q-051` −0.0121) — the BM25
collection-statistics cost of filtering at the derive, bounded at **±0.017** per topic and an order of
magnitude below `vault`'s ≈0.015 MDE. `07-plan.md` § 6.33 / § 6.36 / § 6.37.

### Champion at the served config — RE-MEASURED at `RERANK_RRF_WEIGHT` 0.75 (T2.5, 2026-08-19)

Discharges the re-measurement the CORPUS v2 boundary owed on both axes. Served config exactly:
`fts5` + `qwen3-reranker-4b` + pool 100 + `shipped` RRF at **w=0.75**, reranker at `-np 1` /
per-pair window 8192. Run `2026-08-19-203746394`, `gitSha` `e5a45c1e`.

| dataset | nDCG@10 | R@10 | R@100 | MRR@10 | query p50 | atoms |
|---|---|---|---|---|---|---|
| `vault` | **0.5791** | 0.6250 | 0.8493 | 0.7194 | 13 374 ms | 6554 |
| `vault-hu` | **0.7699** | 0.8145 | 0.8903 | 0.8710 | 16 760 ms | 455 |

Rerank gain WITHIN this run — same corpus, same sha, `rerank` is a TREATMENT field, so this is a
legitimate ARM COMPARISON: `vault` 0.4898 -> 0.5791 (**+0.0893**), `vault-hu` 0.4868 -> 0.7699
(**+0.2831**). **R@100 is unchanged on both** (0.8493 / 0.8903), which is the correctness check: the
reranker reorders within the pool and cannot change first-stage recall.

**The `vault-hu` champion reproduces BYTE-IDENTICALLY.** Its `.trec` is identical to
`2026-08-19-114916550` (w=0.75, `gitSha` `de689da1`) across a sha delta AND across the T2.9
alignment — one artefact confirming three things at once: the reranker is deterministic at a fixed
serving config (T1.6b), the alignment is inert on a corpus with no excluded types even through the
rerank path, and the champion arm reproduces a previously recorded one.

**MUST NOT subtract these from any pre-2026-08-19 champion row**: those carry `rerankWeight` 0.5 and,
for `vault`, a different `atomCount` — a TREATMENT and a SCALE change together.

### CORPUS v2 RE-INGEST BOUNDARY — post-boundary rows, and the CURRENT pin (T-base, 2026-08-20)

**Every `vault` row above predates the 2026-08-20 re-ingest and MUST NOT be subtracted from the rows
below.** What moved: the T2.8 summary backfill wrote an `<!-- LLM-PRIMARY: … -->` comment into 915
source documents, and the vault was then re-ingested — bench-visible `vault` **6554 -> 6628**
(`atomCount` is a `SCALE_FIELD`, so `compare.ts` refuses the subtraction anyway). `vault-hu`,
`scifact` and `nfcorpus` are UNAFFECTED and reproduce exactly.

**+74 of that delta is one document**, `docs/research/2026-08-20-0033-qmd-2-8-3-implementation-deep-dive.md`
(type `research`, not an excluded type), which is UNTRACKED owner work present in the vault at
ingest time. It was flagged to the owner and no answer came, so these rows were taken on the corpus
as it stands. **If that document is later removed from the vault, every row in this section is
superseded and the gate MUST be re-pinned** — it is not a rounding-level contribution.

**Pinned BM25 reference `2026-08-20-072023669` (`gitSha` `54c21e7b`) — THIS IS THE CURRENT GATE.**
The previous pin `2026-08-19-203425629` is PRE-boundary and MUST NOT gate this corpus.

| dataset | nDCG@10 | R@10 | R@100 | MRR@10 | atoms | vs pre-boundary |
|---|---|---|---|---|---|---|
| `vault` | **0.4894** | 0.5642 | 0.8493 | 0.6194 | **6628** | new table (0.4898 at 6554) |
| `vault-hu` | 0.4868 | 0.5543 | 0.8903 | 0.6073 | 455 | **bit-identical** (0.4867941345867541) |
| `scifact` | 0.6858 | 0.8249 | 0.9177 | 0.6476 | 5202 | reproduces |
| `nfcorpus` | 0.3164 | 0.1501 | 0.2449 | 0.5194 | 3605 | reproduces |

**Gate validated, not assumed:** `npm run gnosis:bench -- --layer smoke --baseline 2026-08-20-072023669
--fail-under 0.01` -> **exit 0**, all four datasets `ok` at **+0.0000** (p=1.0000, CI [+0.0000, +0.0000]).

**Champion at the served config, post-boundary.** Run `2026-08-20-072118969`, `gitSha` `54c21e7b`.
Config exactly: `fts5` + `qwen3-reranker-4b` + pool 100 + `shipped` RRF at **w=0.75**, reranker at
`-np 1` / per-pair window 8192. Reranker warmed with one direct `/v1/rerank` call (70 ms) immediately
before the arm; the two datasets ran back-to-back.

| dataset | nDCG@10 | R@10 | R@100 | MRR@10 | query p50 | atoms |
|---|---|---|---|---|---|---|
| `vault` | **0.5791** | 0.6250 | 0.8493 | 0.7194 | 13 403 ms | 6628 |
| `vault-hu` | **0.7699** | 0.8145 | 0.8903 | 0.8710 | 16 759 ms | 455 |

Rerank gain WITHIN this run — same corpus, same sha, `rerank` is a TREATMENT field, so this is a
legitimate ARM COMPARISON: `vault` 0.4894 -> 0.5791 (**+0.0897**), `vault-hu` 0.4868 -> 0.7699
(**+0.2831**). **R@100 is unchanged on both** (0.8493 / 0.8903) — the reranker reorders within the
pool and cannot change first-stage recall.

**The champion nDCG@10 is BIT-IDENTICAL to the pre-boundary run** (`vault` 0.5791179325714902,
`vault-hu` 0.7698537905557956, both matching `e5a45c1e`). That was checked rather than accepted,
because a bit-identical figure across a corpus change is the signature of a cache. It is not one:

- per-topic `ndcg10` is identical on all 60 `vault` topics, but `map` / `rbpResidual` DID move on
  `q-055` and `q-056` — so the arm genuinely re-executed and the deeper ranking changed;
- BM25 moved on exactly two topics, `q-010` (0.7845 -> 0.7737) and `q-019` (0.2893 -> 0.2837) — the
  new atoms displaced a top-10 entry there;
- the reranker demoted those intruders out of the top-10 and restored the identical order, so
  nDCG@10, which sees only the top 10, did not move.

Read as a robustness result, not as "nothing happened": **the cross-encoder absorbed a 74-document
corpus growth at top-10 on every `vault` topic, while the first stage did not.**

**Serving-state correction.** This arm ran in the FAST serving state (a warm single-pair
`/v1/rerank` returned in **67-70 ms**), and its p50 — 13 403 ms / 16 759 ms — is within **0.2 %** of
the pre-boundary 13 374 ms / 16 760 ms. So the ~13 s/query champion cost is the real cost of
scoring 100 pairs and is **NOT** a slow-serving-state artefact. The 12.4x prompt-throughput swing
recorded for the summariser path does not transfer to this one.

### The real corpora — clean, post-decontamination

Every `vault-hu` number recorded before 2026-08-15 was measured against a corpus carrying 114 stale ghost documents (§ Landmines) and is superseded.

| Dataset | adapter | nDCG@10 | R@10 | **R@20** | R@100 | MRR@10 |
|---|---|---|---|---|---|---|
| `vault` (EN, 60 topics) | fts5 | 0.4357 | 0.4860 | **0.6013** | 0.7931 | 0.5484 |
| `vault-hu` (HU, 31 topics) | fts5 | 0.4868 | 0.5543 | **0.6704** | 0.8903 | 0.6073 |
| `vault-hu` | linear | 0.5306 | 0.6113 | **0.6876** | 0.9145 | 0.6452 |
| `vault-hu` | lancedb | 0.5369 | 0.6016 | **0.6849** | 0.9145 | 0.6677 |
| `vault-hu` | minisearch | 0.5455 | 0.6081 | **0.6882** | 0.8919 | 0.6489 |

**Absolute scores across these two corpora are NOT comparable** — `vault-hu` holds 454 documents against `vault`'s 11 345, so its random-ranking floor is far higher (R@100 floor 0.2203 vs 0.0088). Normalized onto each corpus's own random→perfect scale the two are level (nDCG@10 0.435 vs 0.428).

**The adapter ordering does NOT survive adjudication.** On the clean corpus **no pair survives Bonferroni** (α=0.0083 for six pairs), and on **recall@20 — the reranker's objective — no pair is distinguishable at all** (every p ≥ 0.50). The pair that previously survived (linear → lancedb, +0.0240, p=0.0051) is now +0.0063, p=0.5263: it was a contamination artifact. **MUST NOT quote a ranking of the four adapters.**

**Query rephrasing is the largest measured lever in the system.** `vault-hu` → `vault-hu-rephrased` (same topics, same judgments, keyword-rewritten query text): nDCG@10 **+0.2407** (p=0.0002), R@20 **+0.2118** (p=0.0001). On English it is a **recall** lever, not a precision one (R@100 +0.0848, p=0.0009; nDCG@10 −0.0126, n.s.) — Porter stemming already serves English and does nothing for agglutinative Hungarian. Versus **nothing** for BM25 tuning and **nothing** for adapter choice.

### Serving path — measured 2026-08-18 at `gitSha` b64d5bff (T0.4)

**What the CLI serves today, against what the bench calls the champion.** Recorded so the Phase-1 default change has a before. All four arms ran back to back on one machine, one sha, reranker warmed first.

| Arm | adapter | reranker | depth (= rerank pool) | `vault` nDCG@10 | `vault-hu` nDCG@10 |
|---|---|---|---|---|---|
| **A — shipped, at the served `-k 5`** | linear | bge-reranker-v2-m3 | 5 | 0.3614 | 0.5809 |
| **B — shipped, at the CLI's real pool** | linear | bge-reranker-v2-m3 | 20 | 0.4457 | 0.6276 |
| C — champion reranker, shipped pool | fts5 | qwen3-reranker-4b | 20 | 0.4911 | 0.6277 |
| **D — champion** | fts5 | qwen3-reranker-4b | 100 | **0.5040** | **0.6929** |

Full rows: `vault` A `R@10 0.3532 · MRR 0.5942` · B `0.5172 · 0.6112` · C `0.5453 · 0.6451` · D `0.5584 · R@100 0.7931 · MRR 0.6651`. `vault-hu` A `0.5565 · 0.7742` · B `0.6462 · 0.7796` · C `0.6462 · 0.7984` · D `0.7274 · R@100 0.8903 · MRR 0.8355`.

**D reproduces the recorded champion exactly** — `vault` 0.5040 and `vault-hu` 0.6929, independently re-measured five days later at a different sha. Two further sanity checks held: D's `vault` R@100 (0.7931) is identical to the BM25-only row above, as it must be — reranking reorders a pool of 100 and cannot add a document to it; and 12.2 s/query on `vault` matches the plan's forecast for pool 100.

**Correction (2026-08-18, same day).** An earlier version of this section said the bench reranks only 5 candidates at `--depth 5`, making A a lower bound. That was wrong. `firstPassDepth` (`run.ts`) is `rerank ? Math.max(depth, RERANK_K_INIT) : depth` — the bench deliberately mirrors the CLI's floor. At the then-current `RERANK_K_INIT` = 20, arm A reranked a pool of **20** and scored the top **5**, which is exactly what the CLI does at `-k 5`. **A is therefore the most faithful serving arm, not a lower bound**; its R@100 is R@5 because scoring is cut at `depth`, not because the pool was.

**Where the champion's advantage actually is.** At a common pool of 20, B → C is a paired `ARM COMPARISON`:

| Corpus | nDCG@10 | R@10 | MRR@10 |
|---|---|---|---|
| `vault` | **+0.0454, p=0.0011** | **+0.0281, p=0.0286** | +0.0339, n.s. |
| `vault-hu` | +0.0000, n.s. | −0.0000 (p=1.0000, CI [−0.0511, +0.0430]) | +0.0188, n.s. |

So the **reranker model buys English precision and nothing at all on Hungarian**; Hungarian's whole gain (0.6277 → 0.6929) comes from the deeper pool. The `p=1.0000` cell was checked against the § Landmines rule and is a genuine tie, not a defect: the CI is not zero-width and `recall20` on the same pair moves −0.0172. Two rerankers agreeing on the top 10 of a 455-atom corpus is expected.

**C → D cannot be paired, by design.** `depth` is a `SCALE_FIELD`, so `compare.ts` refuses to subtract pool 20 from pool 100 (verified: *"NO PAIRED TEST — the measuring scale moved: depth 5 → 20"*). The pool question is answerable only as an absolute comparison. **`07-plan.md` T0.4's acceptance clause asking for a paired pool-20-vs-100 delta is unsatisfiable with this harness** — and the harness is right, not the plan.

**PROVENANCE BOUNDARY — the three sections that follow were measured BEFORE the W1 merge barrier.**
The rows recorded 2026-08-19 in this session (`gitSha` 528caea6) predate two SCALE changes that
landed at the same barrier from other tracks: `43f62d4f` (T2.1 — ingest `docs/`, drop the mirrors;
the `vault` corpus moves) and `4d8e80d7` (T5.1 — the Hungarian golden set grows 31 -> 61 topics).
Both change the measuring scale, not a treatment. **A G-W1 row MUST NOT be subtracted from anything
measured after this barrier**, and the `vault-hu` rows in particular are 31-topic rows whose MDE
(0.05-0.07) no longer describes the 61-topic set. The re-baseline is already scheduled (T2.5 for the
corpus, T5.5 for the golden boundary); until it runs, these rows stand alone.

### Reranker serving window — 1536 for one day, restored to 8192 on 2026-08-19

**RESOLVED 2026-08-19 by owner decision: `-np 1` on all four reranker entries, restoring parity with `generate.py:241` (the deployed `config.yaml` had been hand-edited against its own `GENERATED` header).** Restore verified by single-document bracket on `qwen3-reranker-4b`: **6382 tokens → HTTP 200 (`prompt_tokens` 6382), 8482 tokens → HTTP 500 `input (8482 tokens) is too large … batch size 8192`**. The per-pair window is the full 8192 again, so **T1.4b is unblocked** and its pre-registration (07-plan § T1.4) stands unchanged.

Two facts the restore does not erase. **(1)** Every arm recorded between 2026-08-18 23:16 and 2026-08-19 was served at 1536 — read those rows under that window. **(2)** Above 8192 the refusal is now a `-b`/`-ub` batch `server_error`, **not** the `exceed_context_size_error` that `singleRerank` bisects on; inert while `ATOM_MAX_CHARS = 4000` (≈2840 tokens worst case) but a real gap above it.

The blocked-state record follows, unchanged, because it is what the 1536 window measured.

**The served per-pair window was 1536 tokens, not 8192.** `~/.config/llama-swap/config.yaml` serves
`qwen3-reranker-4b` with `-c 8192 -np 6`; llama.cpp divides the context across the six slots
(8192/6 = 1365, padded to 1536). The server states it in its own refusal payload —
`{"error":{"type":"exceed_context_size_error","n_ctx":1536}}` — while the llama-swap entry's
display name still reads `ctx=8192, ub=8192`. **That label is now misleading and MUST NOT be read
as the window.** The `-np 6` line landed 2026-08-18 23:16, AFTER the champion arm `b64d5bff` was
recorded at 8192/pair.

**Measured by SINGLE-document probes.** A batch `prompt_tokens` total is not a per-pair
measurement (§ Landmines) and none is used here.

| Corpus | width | probed | max prompt_tokens | oversize |
|---|---|---|---|---|
| `vault` (EN) | 4000 | 200 of 968 with body ≥3000 ch | 1528 | **≥105** |
| `vault` (EN) | **2000 (shipped)** | 200 of 968 with body ≥3000 ch | **1471** | 0 |
| `vault-hu` (HU) | 4000 | 86 of 86 with body ≥2000 ch | 1432 | **5** |
| `vault-hu` (HU) | **2000 (shipped)** | 86 of 86 | 1094 | 0 |

The two `vault` rows are PARTIAL scans, halted once the blocking fact was established; their
oversize counts are lower bounds and their maxima are `>=`, never "the corpus maximum".
`vault-hu` is complete over its ≥2000-char subset.

Three overflows re-probed individually against the server's own payload, to rule out a degraded
server rather than a real cap: `n_prompt` **1772 / 2768 / 2833** at `n_ctx` 1536 — all arXiv-derived
English atoms reaching **~0.71 tokens/char**, against the ~0.26 typical of English prose. Byte
density does NOT predict this: the densest Hungarian atom measured (1.928 bytes/char) passed at 618
tokens because it was short. The driver is tokens/char x length.

**T1.4b cannot be measured at this serving configuration.** The pre-registered primary
(`4000/head` vs `2000/head` nDCG@10 on `vault`) requires the reranker to accept 4000-char documents;
it rejects them on BOTH corpora. This is a REFUSAL, not a null and not a negative result — the
treatment could not be applied. The pre-registration's "4 000 chars is servable; the width is not
capped" (`10ed96df`) was measured at 8192/pair and is **withdrawn**. The adopt rule ("Delta >= 0 and
not significantly negative on either corpus") is undecidable, so **T1.4b MUST NOT adopt**, and no
width number is recorded for or against.

**The shipped width has ~4% margin, and that is a production fact, not a benchmark one.**
At width 2000 the worst English document measured 1471 tokens against a 1536 cap — 65 tokens of
headroom, query already included. Nothing overflowed in the probed sample, but the margin is thin
enough that a longer query or a denser atom could cross it. Two guards do NOT catch this:
`assertDocumentFits` (`bench/reranker.ts`) compares `Buffer.byteLength` against
`MAX_BATCH_TOKENS = 8000`, so a document that the server refuses passes the client check untouched;
and `RERANK_DOC_MAX_CHARS` is a CHARACTER cap with no token relationship. The server is the only
real check, and it fails the whole retrieve.

### Champion reproducibility at the current serving config — measured 2026-08-19 (T1.6)

**The recorded champion does NOT reproduce, and the divergence is localized to the reranker.**
Two arms run back to back at `gitSha` 528caea6 against the live server, champion configuration
(`fts5` + `qwen3-reranker-4b`, `--depth 100`, shipped fusion, shipped 2000/head window):

| Corpus | metric | champion `b64d5bff` | reproduction `528caea6` | Δ |
|---|---|---|---|---|
| `vault` | nDCG@10 | 0.5040 | **0.5012** | **−0.0028** |
| `vault` | MRR@10 | 0.6651 | **0.6611** | **−0.0040** |
| `vault` | R@10 / R@100 | 0.5584 / 0.7931 | 0.5584 / 0.7931 | **0.0000 / 0.0000** |
| `vault-hu` | nDCG@10 | 0.6929 | **0.6924** | **−0.0005** |
| `vault-hu` | R@10 / R@100 / MRR@10 | 0.7274 / 0.8903 / 0.8355 | identical | 0.0000 |

**It is NOT non-determinism.** The arm was run a SECOND time, same sha, same server, same flags:
`runs/2026-08-18-223732823-*` is **byte-identical** to `runs/2026-08-18-221106407-*` on BOTH
corpora (`cmp -s`). The reranker is deterministic at a fixed sha and a fixed serving config, so the
delta against the champion is a real change, not run-to-run noise. This is what T1.6's repeat clause
was for, and it is the first time the repeat has been run.

**Where the change is, stated precisely.** Against the champion `.trec` the rankings differ on
**50 of 60** `vault` topics (1900 of 4778 postings) and **31 of 31** `vault-hu` topics (1172 of
3100). Yet `R@100` is identical — so the FIRST STAGE is bit-identical — and `R@10` is identical too,
so even the top-10 MEMBERSHIP is unchanged. Only the ORDER WITHIN the retrieved set moved, which is
exactly what nDCG@10 and MRR@10 see and what R@k cannot. **The divergence is entirely in the
cross-encoder stage.**

**Cause NOT established — two candidates, and the honest position is open.** The champion was
recorded at `b64d5bff` AND at a per-pair window of 8192; the reproduction is at `528caea6` AND at
1536 (`-np 6`, § Reranker serving window). Five commits touch the rerank path across that range, and
the two most plausible were examined and largely EXCLUDED: `b9edd5ba` routes the window through a
`DocWindow` whose defaults are the same two constants (bit-identical when unset, and the diff bears
that out), and `92d683e2` moved `RERANK_K_INIT` 20 → 100 while the pool is `max(100, K_INIT)` = 100
on both sides. That leaves **`-np 6` as the leading hypothesis** — six slots change how llama.cpp
batches each pair, which perturbs float scores and swaps near-ties — consistent with "same set,
different order". Confirming it requires serving at `-np 1`, which edits a config outside this repo
and shared with other consumers. **MUST NOT be asserted as the cause until that arm is run.**

**2026-08-19 — the config is now at `-np 1` (§ Reranker serving window), so the deciding arm is runnable and is the FIRST scheduled G-W2 item.** Re-run the champion on `vault` + `vault-hu` at the current tree: back to 0.5040 ⇒ `-np 6` was the cause; still 0.5012 ⇒ the sha delta was. Run it BEFORE T1.4b so the width arm is not paired against an unexplained baseline. The hypothesis stays a hypothesis until that row exists.

**Consequence for every pairing.** The effect is ~0.003 on `vault`, well under that corpus's ~0.015
MDE, so no recorded conclusion flips. But a champion row is no longer bit-reproducible, so
`.trec` byte-identity MUST NOT be used as an acceptance criterion across this boundary (T1.1's
acceptance clause and T6.3's "one champion arm byte-identical" gate both assume it).

**Paired, per topic** (`gnosis:pair`, no `ARM COMPARISON` banner — the champion's unstamped width
fields backfill to 2000/head and equal the reproduction's stamped values, so this is a like-for-like
reproduction check, not a treatment delta):

| Corpus | metric | Δ | p | 95% CI |
|---|---|---|---|---|
| `vault` (n=60) | nDCG@10 | **−0.0028** | 0.1404 | [−0.0077, **+0.0002**] |
| `vault` | MRR@10 | −0.0040 | 0.7451 | [−0.0127, +0.0010] |
| `vault` | R@10 · R@100 | +0.0000 · +0.0000 | 1.0000 | zero-width |
| `vault-hu` (n=31) | nDCG@10 | −0.0005 | 0.7496 | [−0.0030, +0.0017] |
| `vault-hu` | MRR@10 · R@10 · R@100 | +0.0000 | 1.0000 | zero-width |

The `p=1.0000` zero-width rows are **genuine ties, not the § Landmines defect signature**: the
underlying per-topic values are literally identical, which the byte-identical repeat arm and the
unchanged top-10 membership independently corroborate. The `vault` nDCG@10 CI upper bound is
**+0.0002** — the delta is small, not significant, and consistently negative rather than centred on
zero. MUST NOT be reported as "reproduces exactly"; the correct statement is "reproduces to within
0.003, with the first stage and the top-10 membership bit-identical".

**Selector hazard, recorded because it cost a run.** `--a 2026-08-18-...-fts5-vault` is AMBIGUOUS —
it is a substring of the `-vault-hu` per-topic path, and `pair.ts` correctly refuses with exit 2
naming both. Anchor a vault selector with the trailing `.tsv`.


### Fusion arms — the cross-encoder wants MORE authority, and it SUBSTITUTES for rephrasing (T1.5b, 2026-08-19)

**EXPLORATORY — 9 pre-planned arms plus 1 post-hoc cross-dataset comparison, no multiplicity
correction applied, and NO default changed.** The best cell of a grid carries an optimistically
biased p (§ What to measure), so the winner below is a hypothesis to pre-register, not a result to
ship. Champion otherwise: `fts5`, `qwen3-reranker-4b`, depth 100, pool 100, `-np 1` / window 8192.
`beir-ce` is `{kind:'replace'}` — the cross-encoder's order REPLACES the first pass, so no weight
applies to it; that is why this is 9 arms and not a 3×3 grid.

Δ nDCG@10 against each corpus's own `shipped` w0.5 control, paired, n as shown:

| arm | `vault` (n=60) | `vault-hu` (n=31) | `vault-hu-rephrased` (n=31) |
|---|---|---|---|
| control `shipped` w0.5 | 0.5388 | 0.6929 | **0.8091** |
| `--rerank-weight 0.25` | **−0.0379** (p=0.0159) | **−0.0981** (p=0.0002) | **−0.0352** (p=0.0111) |
| `--rerank-weight 0.75` | +0.0129 (p=0.2930) | **+0.0769** (p=0.0001) | +0.0013 (p=0.9488) |
| `beir-ce` (replace) | +0.0205 (p=0.3145) | **+0.1029** (p=0.0008) | −0.0333 (p=0.2382) |

**One direction is unambiguous and it is the only claim here that survives the multiplicity
caveat: DOWN-weighting the cross-encoder HARMS every corpus.** w0.25 is significantly negative on
all three, including the one where nothing else moved. The shipped 0.5 is not a measured optimum —
it is the low end of a monotone response.

**On `vault-hu` the effect is among the largest in the project**: +0.1029 for `beir-ce` and +0.0769
for w0.75, both clearing that corpus's 0.05–0.07 MDE, with R@10 rising too (+0.0763 / +0.0871). On
`vault` the same direction appears but resolves to nothing (+0.0205, +0.0129, both null against a
≈0.015 MDE).

**The finding that changes planning — rephrasing and cross-encoder authority are SUBSTITUTES, not
complements.** On the REPHRASED Hungarian corpus the whole effect vanishes: w0.75 is +0.0013 and
`beir-ce` turns negative. Measured head-to-head across the two datasets (`pair.ts` supports this and
labels it `ARM COMPARISON`):

| | nDCG@10 | Δ | p | 95% CI |
|---|---|---|---|---|
| `vault-hu` + `beir-ce`, queries UNTOUCHED | 0.7958 | — | — | — |
| `vault-hu-rephrased` + `shipped`, queries HAND-REWRITTEN | 0.8091 | +0.0133 | 0.7140 | [−0.0562, +0.0824] |

They land in the same place. **Read this as "cannot tell them apart", never as "proven equal"** —
31 topics and a ±0.07 CI cannot resolve a 0.0133 gap. What it does establish is that the two levers
FIX THE SAME FAILURE: a natural-language Hungarian query whose BM25 order is poor. Once the query is
rewritten into keywords the first stage is already good, and extra cross-encoder authority has
nothing left to recover. **The gains MUST NOT be added** — the best measured Hungarian
configuration is ≈0.81 from either lever, not 0.81 + 0.10 from both.

**Why that matters operationally**: hand-rephrasing costs a human rewrite per query and the in-tool
`--rephrase` is measured net-NEGATIVE (§ Settled), while a fusion weight is a constant. If the
substitution holds under a pre-registered test, most of the Hungarian rephrasing gain is available
for free. **That test does not exist yet and this section is not it.**

### Fusion weight CONFIRMED on held-out data, and "monotone" narrowed (T1.5c, 2026-08-19)

Pre-registered `07-plan.md` § 6.12 **before the arm**, on a corpus that took no part in T1.5b's
selection. `--rerank-weight 0.75` on `scifact`, champion otherwise; control is the recorded
`2026-08-19-085605691` (`shipped` w=0.5, same model, pool and serving config, `atomCount` 5202 both).

| metric | w=0.5 | w=0.75 | Δ | p | 95% CI |
|---|---|---|---|---|---|
| **nDCG@10** (primary) | 0.7395 | 0.7692 | **+0.0297** | **0.0002** | **[+0.0160, +0.0441]** |
| **MRR@10** | 0.7048 | 0.7387 | **+0.0339** | **0.0003** | **[+0.0169, +0.0518]** |
| **MAP** | 0.6964 | 0.7302 | **+0.0337** | **0.0002** | **[+0.0175, +0.0509]** |
| R@10 | 0.8677 | 0.8852 | +0.0175 | 0.1108 | [−0.0017, +0.0383] |
| R@100 | 0.9177 | 0.9177 | 0.0000 | — | same pool, as it must be |

n=300, nothing regressed, and p agrees with the CI on all three significant metrics.

**The T1.5b heading above is now too strong and MUST be read with this.** The response is monotone
across `0.25 → 0.5 → 0.75`; it is **NOT** monotone through to full replacement. `beir-ce` is null on
`scifact` (+0.0056, p=0.5488) while **significantly harming its R@10** (−0.0207, p=0.0373), and is
negative on the project's best configuration. **Blending beats both extremes** — there is an interior
optimum above 0.5 and below replacement. `w=0.75` is the best MEASURED cell, **not a located
optimum**: 0.6 and 0.85 were never run. **SUPERSEDED 2026-08-22 — see the next section**: 0.6, 0.7,
0.8, 0.85, 0.9 and 0.95 have now been run, and the two claims in this paragraph are both narrower
than written. That `beir-ce` pair is `4aeb641d`, whose `rerankModel` is ABSENT — **`bge-reranker-v2-m3`,
not the served `qwen3-reranker-4b`**, so it is an `ARM COMPARISON` on the model axis too and MUST NOT
be read as a property of the served reranker. Adoption of the served constant is the open owner decision
**T1.5c-adopt — ANSWERED 2026-08-19: ADOPTED.** `RERANK_RRF_WEIGHT` is **0.75** in `config.ts`. Every row recorded before that carries 0.5; `compare.ts` backfills an absent `rerankWeight` on an RRF-fused row to 0.5 and labels the pair `ARM COMPARISON`, so a pre-change row can no longer be silently subtracted from a post-change one. The champion figures elsewhere in this file were measured at 0.5 and a re-measurement is owed at T2.5.

### Fusion weight — the full response surface, mapped offline at zero GPU (2026-08-22)

Eleven points on `vault` from **one** 17.3-min run (`2026-08-22T12:19:02.686Z`, `gitSha 43e434a3`,
`fts5` + `qwen3-reranker-4b` + pool 100 + PRF at `SERVED_PRF_PARAMS`), re-fused offline from the
recorded `first_pass_score` / `rerank_score` columns. **`w` enters the arithmetic only after both
orders exist**, so every point sees the SAME cross-encoder output — a paired design no set of
separate GPU arms can match.

Validity, checked before the curve was read: 100 rows/topic on all 60 (whole pool, nothing
truncated); re-fusion at w=0.75 reproduces the four recorded metrics **to the last digit**
(0.5871155848027597 · 0.6235631613756613 · 0.7527777777777778 · 0.8855307539682539); 59/60 topic
orders byte-identical, the one miss being `q-001`'s single tied `first_pass_score` (one adjacent
transposition, moves no metric); and R@100 constant at 0.8855 across all 11 points, as fusion within
a fixed pool must be. Exactness rests on `vault` **atoms/doc = 1.000**.

| w | nDCG@10 | R@10 | MRR@10 | MAP | Δ nDCG@10 vs 0.75 | p | topics win/loss/tie |
|---|---|---|---|---|---|---|---|
| 0 | 0.4869 | 0.5810 | 0.5694 | 0.3982 | −0.1002 | **0.0004** | — |
| 0.25 | 0.5327 | 0.5867 | 0.6918 | 0.4471 | −0.0545 | 0.0096 | — |
| 0.50 | 0.5688 | 0.6092 | 0.7347 | 0.4842 | −0.0183 | 0.0743 | 15 / 26 / 19 |
| 0.60 | 0.5837 | 0.6232 | 0.7436 | 0.4942 | −0.0034 | 0.6806 | 15 / 19 / 26 |
| **0.70** | **0.5912** | 0.6236 | 0.7569 | 0.4992 | +0.0041 | 0.4519 | 9 / 8 / 43 |
| **0.75** (served) | 0.5871 | 0.6236 | 0.7528 | 0.4929 | — | — | — |
| 0.80 | 0.5776 | 0.6118 | 0.7444 | 0.4899 | −0.0095 | 0.0392 | 5 / 14 / 41 |
| **0.85** | 0.5775 | 0.6139 | 0.7436 | 0.4880 | −0.0096 | 0.2256 | 9 / **20** / 31 |
| 0.90 | 0.5752 | 0.6111 | 0.7422 | 0.4854 | −0.0119 | 0.1518 | 11 / 23 / 26 |
| 0.95 | 0.5771 | 0.6125 | 0.7422 | 0.4868 | −0.0100 | 0.3188 | — |
| 1.00 | 0.5791 | 0.6201 | 0.7439 | 0.4866 | −0.0080 | 0.4542 | 13 / 24 / 23 |

n=60, 20 000-permutation paired test per cell.

**0.85 is worse, not better** — all three head metrics down together, 9 win / 20 loss per topic.
**The 0.70 nominal peak is noise**: +0.0041 is a quarter of `vault`'s ≈0.015 MDE, p=0.4519, 43 of 60
topics unmoved. **The plateau is `[0.6, 1.0]`**, every point within 0.012 of served.
**30 tests were run, so Bonferroni α = 0.0017 — only `w=0` survives, and `w=0.8`'s p=0.0392 MUST NOT
be read as a refutation.** Config unchanged: 0.75 stays.

`beir-ce` **IS the w=1 endpoint** — `rrfTerm` collapses to `1/(K + rank_rerank)`, order-identical to
`replace` for every returned candidate; the two differ only in the non-returned tail. The endpoint
was always measured, under another name.

**A between-run comparison reversed sign under pairing**: the `de689da1` rows read 0.75→1.0 as
+0.0076; paired it is −0.0080. **A parameter that enters only AFTER an expensive stage MUST be swept
offline over that stage's recorded output, never by re-running the stage.**

Open: `scifact` at w=1 with `qwen3-reranker-4b` has **never been run** (~75 min, measured 14.9 s/query
× 300). `docs/analysis/2026-08-22-dp-gnosis-fusion-weight-response-surface.md`

### Reranker input WIDTH — 4000/head vs 2000/head, measured 2026-08-19 (T1.4b)

Pre-registered 2026-08-18 (`07-plan` § T1.4), amended 2026-08-19 before the arms returned
(§ 6.8): three arms, because the corpus moved and the champion row can no longer serve as the
`2000/head` cell. `--rerank-doc-max-chars 4000`, champion otherwise (`fts5`, `qwen3-reranker-4b`,
depth 100, pool 100, `shipped`, `-np 1` / window 8192).

**Primary — `vault`, n=60**, control `2026-08-19-101634111` vs treatment `2026-08-19-102707441`:

| metric | 2000/head | 4000/head | Δ | p | 95% CI |
|---|---|---|---|---|---|
| **nDCG@10** | 0.5388 | 0.5463 | **+0.0075** | 0.2907 | [−0.0052, +0.0217] |
| R@10 | 0.5716 | 0.5943 | +0.0228 | 0.1264 | [+0.0000, +0.0506] |
| **MRR@10** | 0.7285 | 0.7140 | **−0.0145** | 0.1232 | **[−0.0384, −0.0003]** |
| P@5 | 0.3300 | 0.3367 | +0.0067 | 0.7235 | [−0.0100, +0.0267] |
| R@100 | 0.8041 | 0.8041 | +0.0000 | 1.0000 | zero-width (same pool) |

**Safety — `vault-hu`, n=31**, control `2026-08-19-084608217` (T1.6b's champion re-run) vs
`2026-08-19-103909049`: nDCG@10 0.6929 → 0.6888 (−0.0041, p=0.3868), R@10 −0.0081, MRR@10 −0.0061,
P@5 −0.0065, R@100 tied. **Every metric moved negative**, none significantly.

**Verdict by the pre-registered rule: ADOPT** — Δ ≥ 0 on the primary and not significantly negative
on either corpus. **Two facts qualify it, and both were read off the numbers above, not inferred:**

1. **The primary is a NULL, not a gain.** ±0.013 CI half-width against `vault`'s ≈0.015 MDE: the arm
   could have detected the effect it was designed for and did not. `+0.0075` MUST NOT be quoted as
   a measured improvement.
2. **It trades top-1 quality for depth.** R@10 rises +0.0228 while MRR@10 falls −0.0145, and the
   MRR@10 **bootstrap CI excludes zero** ([−0.0384, −0.0003]) while its permutation p is 0.1232 —
   the two statistics disagree, so neither may be quoted alone. A wider window pushes the right
   document INTO the top 10 slightly more often and to a slightly WORSE rank when it gets there.
   For a serving path whose consumer reads the top few, that is the wrong direction on the metric
   that matters most.

**`vault-hu` says nothing either way, by construction** — 6.9% of its scored postings exceed 2 000
chars (against `vault`'s 25.2%), so the treatment barely applied; its uniform negative sign is
consistent with noise on a near-inert arm, and its 0.05–0.07 MDE cannot resolve −0.0041.

**The predicted 3× cost did NOT materialise, and the prediction is withdrawn.** § Known harness gaps
reasons that a 4 000-char window packs ~1 document per batch against ~3, implying ~3× the round
trips. Measured: `vault` 622 315 ms → 710 962 ms (**1.14×**), and `vault-hu` was *faster* at the wide
window (524 721 → 488 401 ms). Wall-time here is bound by TOTAL TOKENS SCORED, not by round-trip
count — only ~25% of `vault` postings exceed 2 000 chars, so the token growth is far below 2×. The
batching conflation in that gap row is real; its cost projection was not.

**Default UNCHANGED at 2000/head.** `RERANK_DOC_MAX_CHARS` is a quality-affecting served parameter,
so adopting the rule's verdict into the shipped default is an owner decision, not a measurement
consequence (CLAUDE.md § Change Authorization).

**DECIDED 2026-08-19 — the width STAYS 2000, and the rule's PASS is deliberately overridden.** The
primary is a null the arm was powered to resolve; the only CI excluding zero is MRR@10's, and it
excludes it on the harm side; `vault-hu` cleared the safety clause without being able to test it
(6.9 % of postings in range); and 4000 is servable only at `-np 1` / window 8192, a config that has
already flipped silently once, whereas 2000 keeps a ~18 % margin that survives such a flip. **MUST
NOT read the recorded `ADOPT` verdict above as a shipped change** — nothing shipped. The rule's own
defect is recorded with the decision: its "not significantly negative" clause named no statistic, and
p (0.1232) and the bootstrap CI disagreed on MRR@10, so it passed on whichever test was read first.
`07-plan.md` § 6.11.

### BEIR champion arm — scifact with `qwen3-reranker-4b`, measured 2026-08-19 (T1.6, the last open half)

`npm run gnosis:bench -- --only scifact --adapter fts5 --rerank --rerank-model qwen3-reranker-4b` at
`gitSha 8c665cdb`, depth 100, pool 100, profile `shipped`, serving `-np 1` / window 8192.

Paired against the pinned BM25 row `2026-08-19-075145371` (`npm run gnosis:pair`), n=300 — labelled
**ARM COMPARISON** by the tool itself (`rerank false → true`), never a like-for-like delta:

| metric | BM25 | + qwen3-reranker-4b | Δ | p | 95% CI | |
|---|---|---|---|---|---|---|
| nDCG@10 | 0.6858 | **0.7395** | **+0.0537** | 0.0001 | [+0.0391, +0.0691] | significant |
| R@10 | 0.8249 | 0.8677 | +0.0428 | 0.0001 | [+0.0223, +0.0647] | significant |
| MRR@10 | 0.6476 | 0.7048 | +0.0572 | 0.0001 | [+0.0392, +0.0766] | significant |
| P@5 | 0.1627 | 0.1800 | +0.0173 | 0.0001 | [+0.0107, +0.0247] | significant |
| R@100 | 0.9177 | 0.9177 | +0.0000 | 1.0000 | zero-width | genuine tie |

**The zero-width R@100 row is the arithmetic identity, not a defect** (§ Landmines requires stating
which): the reranker reorders a pool of 100 and cannot add a document to it, so recall AT the pool
depth is invariant by construction. Its non-zero R@10 is what shows the reorder actually happened.

**Against published BM25.** Our first stage sits at 0.6858 vs BEIR's published 0.665 for scifact
(§ BEIR Tier-1); the champion reranker takes it to **0.7395**. Read this as an arm on OUR first
stage, not as a published-leaderboard comparison — the BM25 configuration is disclosed rather than
reproduced (decision D7), so the reranked figure inherits that same caveat.

**Cost, and it is the headline non-quality fact.** 300 topics took **4 066 685 ms of query time
(67.8 min)** against 3.6 s for the same datasets' BM25 pass — ≈13.6 s per topic at pool 100. The
project optimises QUALITY FIRST by explicit decision (2026-08-16), so this does not rule the model
out; it is recorded so the tradeoff can be revisited deliberately.

### The `-np` decider — the reproducibility break was the SERVING CONFIG, not the sha (T1.6b, 2026-08-19)

**Pre-registered rule, written before the run** (`13-open-tasks.md` T1.6b): re-run the champion arm
on `vault-hu` and `cmp` the `.trec`. Byte-identical to the champion ⇒ `-np 6` caused the G-W1 break;
byte-identical to the reproduction ⇒ the sha delta did.

`npm run gnosis:bench -- --only vault-hu --adapter fts5 --rerank --rerank-model qwen3-reranker-4b`
at `gitSha 8c665cdb`, serving config `-np 1` / per-pair window 8192:

| Run | `gitSha` | serving | nDCG@10 | R@10 | R@100 | MRR@10 |
|---|---|---|---|---|---|---|
| champion | `b64d5bff` | `-np 1`, 8192 | 0.6929 | 0.7274 | 0.8903 | 0.8355 |
| "reproduction" | `528caea6` | **`-np 6`, real window 1536** | 0.6924 | 0.7274 | 0.8903 | — |
| **this run** | **`8c665cdb`** | `-np 1`, 8192 | **0.6929** | **0.7274** | **0.8903** | **0.8355** |

**`cmp`: byte-identical to the champion `runs/2026-08-18-144212129-fts5-vault-hu.trec`; 1246 lines
differ from the reproduction `runs/2026-08-18-221106407-…`.** The verdict is `-np 6`.

**The serving config was read off the running server, not off a display name** (§ Landmines requires
this): `llama-server … --rerank -c 8192 -b 8192 -ub 8192 -np 1 -ngl 99 -fa on` (process argv during
the arm), so the per-pair window is 8192/1 = **8192**. The pre-arm probe separated correctly —
relevant 0.9953 vs irrelevant 4.39e-06, against the reference qwen3 separation of 0.998 vs ~1e-05.

**What this buys back.** The gap it reproduced across is **60 commits, 12 of them touching
`packages/gnosis/src`** — including T1.x, T2.1, T2.1a and T2.1d. So the cross-encoder is
deterministic across a large code delta at a fixed serving config, and the G-W1 divergence was
never non-determinism and never a code regression. **`.trec` byte-identity is therefore usable
again as an acceptance criterion** — T1.1's clause and T6.3's gate are restored — with the standing
caveat unchanged: it is valid only WITHIN one serving config, and `-np` is part of that config.

**The `vault` half of this decider is permanently unavailable.** The pre-registered form also named
`vault` (0.5040 → 0.5012), but T2.1/T2.1d moved that corpus (11 345 → 11 058 atoms), so no `vault`
run can be byte-compared across the boundary again. `vault-hu` was the right choice precisely
because the dedupe never touched it — 455 atoms on every run in this table.

### External control — touché2020 with the champion reranker, measured 2026-08-19 (T1.6)

**The declared rerank-REGRESSION control does not regress with this reranker.** `webis-touche2020`
is described in `GNOSIS-BENCH.md` § Layers as "the only BEIR dataset where a cross-encoder
*degrades* the result". Measured with the champion `qwen3-reranker-4b` at pool 100, it IMPROVES:

| Arm | gitSha | nDCG@10 | R@10 | R@100 | MRR@10 | p50 |
|---|---|---|---|---|---|---|
| BM25 only | 35c7a546 | 0.3403 | 0.2112 | 0.5545 | 0.5782 | 1 054 ms |
| **+ qwen3-reranker-4b, pool 100** | 528caea6 | **0.3842** | **0.2361** | 0.5545 | **0.6154** | 15 967 ms |
| Δ | | **+0.0439** | +0.0249 | **0.0000** | +0.0372 | 15.1× |

Both rows carry `atomCount` 445 245 / `corpusLines` 382 545, so the corpus is identical and only the
`rerank` treatment flips. R@100 is unchanged to the digit — required, since reranking reorders a
pool of 100 and cannot add a document to it; it is the arithmetic check that the arm did what it
claims.

**What this does and does NOT license.** The published "cross-encoder degrades touché" result is a
property of the cross-encoders BEIR published with, not of reranking as such. It MUST NOT continue
to be quoted as a property of THIS system's rerank path. It also MUST NOT be inverted into "touché
is now a positive control" on one arm: the useful reading is that touché no longer serves as the
rerank-regression control it was selected to be, and the suite currently has NO dataset in that
role. Whether that is the model, the pool, or the fusion rule is unmeasured.

Cost recorded, not editorialised: ingest 1 968 s (32.8 min) and query 776 s (12.9 min) over 49
topics — p50 1 054 ms → 15 967 ms, a 15.1× retrieve-path cost for the arm.

**Paired** (`gnosis:pair`, correctly banner-labelled `ARM COMPARISON — rerank false → true`):

| metric | Δ | p | 95% CI | |
|---|---|---|---|---|
| nDCG@10 | **+0.0439** | **0.0023** | [+0.0180, +0.0701] | **significant** |
| R@10 | **+0.0249** | **0.0013** | [+0.0105, +0.0400] | **significant** |
| MRR@10 | +0.0371 | 0.3308 | [−0.0331, +0.1103] | not significant |
| R@100 | +0.0000 | 1.0000 | zero-width | genuine tie (same pool) |

n=49. The gain is significant on the headline metric and on R@10, and it is a gain, not a
regression. The `p=1.0000` R@100 row is the same arithmetic identity noted above, not a defect.


### W1 post-merge gate — exit 4, and it is NOT a quality regression

**Run at the merge commit `6f87ca08`, after C, I and A landed.** `npm run gnosis:bench -- --layer
smoke --baseline 2026-08-15-13115954 --fail-under 0.01` exits **4**:

| Dataset | verdict | Δ nDCG@10 | p | 95% CI |
|---|---|---|---|---|
| nfcorpus | ok | +0.0000 | 0.9756 | [−0.0019, +0.0023] |
| scifact | ok | +0.0000 | 1.0000 | zero-width |
| **`vault`** | **REGRESSION** | **−0.0921** | **0.0005** | [−0.1468, −0.0453] |
| `vault-hu` | ok | +0.0000 | 1.0000 | zero-width |

**The verdict is a provenance failure, not a finding, and MUST NOT be reported as "vault regressed
0.09".** The indexed corpus MOVED under the comparison, on both English datasets, while every
`SCALE_FIELD` stayed byte-identical:

| Row | atomCount | corpusBytes | corpusLines | nDCG@10 | R@100 |
|---|---|---|---|---|---|
| `vault` baseline `9938be7a` | 11 345 | 14 508 819 | 11 345 | 0.4357 | 0.7931 |
| `vault` now `6f87ca08` | **11 049** | 14 508 819 *(unchanged)* | 11 345 *(unchanged)* | 0.3436 | 0.6038 |
| `nfcorpus` baseline | 3 645 | 6 219 364 | 3 633 | 0.3164 | 0.2463 |
| `nfcorpus` now | **3 605** | 6 219 364 *(unchanged)* | 3 633 *(unchanged)* | 0.3164 | 0.2449 |

**Mechanism.** `corpusBytes` / `corpusLines` describe the SOURCE `corpus.jsonl` — the BEIR projection
INPUT — not the atoms the index actually holds. T2.1's dedupe and mirror-drop (`43f62d4f`, merged at
this barrier) removes 296 `vault` atoms and 40 `nfcorpus` atoms at INGEST, downstream of both fields.
`atomCount` is the field that moved and **`atomCount` is not in `SCALE_FIELDS`**, so `compare.ts` saw
identical scale provenance and subtracted. This is precisely the class § Provenance exists to
prevent — "a changed measuring scale can never masquerade as a quality change" — and here it did.

**Aggravating, and independently disqualifying.** The golden set was NOT re-pointed. I-W1 records
`vault` golden coverage at **93.29 %** with **19 orphaned EN gold ids** and states the re-point
"blocks the first `vault` arm on v2 (T2.5)". So even a correctly-scaled comparison would be scoring a
changed corpus against partially stale gold. The R@100 drop (0.7931 → 0.6038) is consistent with gold
documents that the dedupe re-keyed, not with a retrieval defect — but that is a HYPOTHESIS, and it is
not resolved here.

**APPLIED 2026-08-19 (T2.1b)**: `atomCount` is a `SCALE_FIELD`. The gate no longer subtracts across
an ingest-side corpus change — it exits 4 `cannot compare` and names the field. Every row recorded
BEFORE that commit must still be read under the old rule.

**Consequence for the pinned baseline — RESOLVED 2026-08-19.** `2026-08-15-13115954` is across a
corpus boundary for `vault` and `nfcorpus`, so it was replaced by `2026-08-19-074803484`; see
§ W2 below.

### W2 — the corpus destruction closed, and the gate RE-PINNED (T2.1a / T2.1b / T2.1d, 2026-08-19)

**The W1 `vault` −0.0921 was real corpus destruction, not provenance drift, and it took two fixes.**
The gold-aware dedupe (T2.1a, `ca21ebdb`) kept a judged copy of every byte-identical group, but 10
`vault` groups hold **two** judged documents — a `ts-*` copy and its `60-debugging-*` /
`10-layered-model-*` mirror, judged by different topics — so keep-one still destroyed 9 gold
documents. T2.1d (`663d8dbc`) exempts those groups and moves the exit-3 reachability refusal onto
the INDEXED corpus, where the loss actually happens.

`npm run gnosis:bench -- --layer smoke --fail-under 0.01`, `vault`, all four rows BM25-only `fts5`
depth 100:

| Run | `gitSha` | atomCount | gold docs lost | topics under baseline R@100 | nDCG@10 | R@10 | R@100 |
|---|---|---|---|---|---|---|---|
| pre-T2.1 baseline (old pin) | `9938be7a` | 11 345 | 0 | — | 0.4357 | 0.4860 | 0.7931 |
| gold-blind dedupe | `6f87ca08` | 11 049 | 19+ | 8 | 0.3436 | 0.3755 | 0.6038 |
| gold-aware dedupe (T2.1a) | `afed3bf3` | 11 049 | **9** | **8** | 0.4517 | 0.4844 | 0.7405 |
| **+ double-gold exemption (T2.1d)** | **`663d8dbc`** | **11 058** | **0** | **0** | **0.4721** | **0.5121** | **0.8041** |

`q-014`, zeroed by the dedupe, is back to nDCG@10 0.7039. `q-026` and `q-041` finish ABOVE the
pre-T2.1 baseline recall — that is T2.1's `docs/` root, not the dedupe fix. `nfcorpus` and `scifact`
reproduce their previous figures exactly at identical atom counts, which is what proves the
gold-blind path never moved.

**None of these four rows may be subtracted from another.** They straddle a corpus boundary
(`docs/` root, mirror drop, dedupe rule) — the table is four independent measurements, and T2.1b
now makes `compare.ts` refuse the subtraction rather than print it as a delta.

**Re-pinned: `2026-08-19-075145371`** (`gitSha` 693838fe), replacing `2026-08-15-13115954`. The old
pin is pre-T2.1 for `vault` AND `nfcorpus`, and since `atomCount` became a `SCALE_FIELD` (T2.1b) it
exits 4 `cannot compare` on both — a gate that cannot pair has verified nothing. Consumers updated
in the same commit: `claude-artifacts/speckit/pre-merge.md` step 1c-1 and
`docs/analysis/2026-08-18-dp-gnosis-full-review/12-launch-prompts.md`. This pin is itself
provisional: **T2.1c re-ingests the production vault**, which re-derives the bench's own source
corpus, so a further re-pin is owed at that boundary (T2.5).

**The pin is verified, not just declared, and it is deliberately NOT the first T2.1d run.** The
earlier `2026-08-19-074803484` measured the T2.1d tree while T2.1d was still UNCOMMITTED, so its row
records `gitSha 663d8dbc` — a sha that does not contain the code it measured. The pin is therefore
the re-run `2026-08-19-075145371` at `693838fe`, which carries the same numbers under a sha that
names them: `vault` atomCount 11 058, nDCG@10 0.4721 on both rows, and all four `.trec` files
**byte-identical** between them (`cmp`, nfcorpus / scifact / vault / vault-hu). `npm run gnosis:bench
-- --layer smoke --baseline 2026-08-19-075145371 --fail-under 0.01` exits **0** with every dataset
`ok` at Δ +0.0000; those p=1.0000 zero-width rows are the shape § Landmines says to distrust, and the
byte-identity above is their disproof. BM25-only at a fixed tree reproduces bit-for-bit — the
reranker's serving-config caveat does not apply to this gate.

### Consumer view — what the caller RECEIVES, re-scored offline 2026-08-18 (T0.2 / T0.3a)

**Produced with no benchmark run and no GPU.** `npm run gnosis:forensics -- --run <selector>` re-scores a recorded row's persisted `.trec` ranking through `metrics.ts:scoreTopic`. The two champion rows were recorded BEFORE these metrics existed and carry only 8 per-topic columns; re-scoring is the only way to obtain the rest without re-running the arm. This is what tracking the run files (D4) bought.

| Row | nDCG@10 | P@5 | P@10 | allGoldInTop10 | MAP | R-Prec | RBP residual |
|---|---|---|---|---|---|---|---|
| `vault` champion (`b64d5bff`, qwen3-4b, pool 100) | 0.5040 | 0.2967 | 0.2033 | 0.2833 | 0.4046 | 0.3648 | 0.7446 |
| `vault-hu` champion (`b64d5bff`, qwen3-4b, pool 100) | 0.6929 | 0.4452 | 0.2645 | 0.3871 | 0.6175 | 0.5570 | 0.6377 |
| `vault` BM25 (`64f959db`, gate baseline) | 0.4357 | 0.2333 | 0.1867 | 0.2667 | 0.3556 | 0.3139 | 0.7786 |
| `vault-hu` BM25 (`64f959db`, gate baseline) | 0.4868 | 0.2903 | 0.1968 | 0.2258 | 0.4023 | 0.3489 | 0.7501 |

**These are re-scores, not re-measurements, and they are ATTESTED as such.** The CLI recomputes every metric the recorded per-topic TSV already carries and REFUSES on any disagreement — a golden set that moved under a recorded run would otherwise be re-scored silently. The two gate rows post-date T0.2, so they were checked on **all 11** recorded columns, `map` / `rPrecision` / `rbpResidual` included, across 60 and 31 topics with **zero disagreements**. That is direct evidence the four columns added to the champion rows are computed the same way the harness records them. The champion rows were checked on the 5 columns their legacy TSV carries. A column absent from a legacy TSV is treated as NOT RECORDED and skipped — never as a recorded `0`, which is the exact defect T0.2 fixed in `report.ts`.

**`rPrecision` is measured on every topic of both corpora** — 60/60 and 31/31. Max gold is 36 against depth 100, so the `R > depth` case that makes `rPrecision` `undefined` on nfcorpus (22 of 323 topics) does not arise here. **MUST NOT carry the nfcorpus subset caveat onto a vault row.**

**The presentation cap costs NOTHING at the shipped budget.** `goldSurvivesBudget` — the share of the gold inside the served top-5 window that survives `fitToTokenBudget` — is **1.0000 on all four rows** at the default 64 000 tokens. It only bites when the budget is squeezed: `--budget 3000` drops it to 0.6977 on the `vault` champion. **The token budget is therefore not a live quality constraint on the serving path today**, and MUST NOT be cited as one without naming a budget below the default.

**The deficit is ORDERING, and the number reproduces independently.** The `vault` champion's per-topic split is `orderingLoss 0.3616` against `recallLoss 0.1344` — the 0.1344 matches the recall gap recorded by an entirely separate route in `GNOSIS-GUIDE.md` § Settled. Roughly 73% of what the champion leaves on the table is reachable by reordering documents it ALREADY retrieved.

**RBP residual is high on both corpora** (0.6377–0.7786): most reader-attention mass at p=0.8 sits on UNJUDGED documents. That is a judgment-pool depth measure, NOT a ranking failure — it is the quantitative case for the pooled judge round (T5.4), and it MUST NOT be read as a quality score.


### Consumer — what the caller RECEIVES at the served and the runner configs, CORPUS v2, re-scored 2026-08-22 (R3.1 / M1)

**This is the DoD #3 number** (`17-road-to-production.md` § 1 check 3): over the golden topics, what fraction of gold
survives into the delivered pack, and how much of the pack is noise. It is a NEW section, not an edit of the
`2026-08-18 (T0.2 / T0.3a)` rows above — those predate the **CORPUS v2 boundary** (re-ingest 2026-08-19) and
MUST NOT be subtracted from anything here.

**Produced with no benchmark run and NO GPU, and no reranker was called.** `npm run gnosis:forensics` re-scores an
already-recorded `.trec` through `metrics.ts:scoreTopic`. The `qwen3-reranker-4b` label below is INHERITED from the
recorded run, not a new arm.

| Row | recorded run | retrieval mode |
|---|---|---|
| `vault` / `vault-hu` | `2026-08-20-072118969` (`gitSha` 54c21e7b, 60 / 31 topics) | `fts5` + `--rerank` **`qwen3-reranker-4b`**, pool 100, fusion `shipped` at `RERANK_RRF_WEIGHT` 0.75, depth 100, **PRF off** (the bench calls `port.retrieve` directly and never reads a profile default) |

Three numbers × two corpora × two configs. `allGoldInBudget` and `noiseAtK` are the two columns R3.1 added
(`forensicsCli.ts`); `goldSurvivesBudget` already existed.

| corpus | config | served-k | budget | `allGoldInBudget` | `goldSurvivesBudget` | `noiseAtK` |
|---|---|---|---|---|---|---|
| `vault` | **A — served defaults** | 5 | 64 000 | **0.1833** (60 topics) | **1.0000** (55 topics) | **0.6678** (60 topics) |
| `vault` | **B — the runner** | 8 | 12 000 | **0.2500** (60 topics) | **0.9357** (56 topics) | **0.7308** (60 topics) |
| `vault-hu` | **A — served defaults** | 5 | 64 000 | **0.3226** (31 topics) | **1.0000** (30 topics) | **0.4968** (31 topics) |
| `vault-hu` | **B — the runner** | 8 | 12 000 | **0.4516** (31 topics) | **0.9839** (31 topics) | **0.6371** (31 topics) |

Config A is `DEFAULT_SERVED_K` (`forensicsCli.ts`) × `RETRIEVE_TOKEN_BUDGET` (`config.ts`). Config B is the runner's
own knowledge cell, `k: 8` × `maxTokens: 12000` (`runner.config.json`, the `R0.2-budget` decision).

**What each column means, so none is quoted as another.**

| Column | Definition | Denominator |
|---|---|---|
| `allGoldInBudget` | 1 iff the topic's ENTIRE gold set is inside the served window AND survives the budget | topics with gold and with every served body present |
| `goldSurvivesBudget` | share of the gold **already inside the served window** that survives `fitToTokenBudget` — isolates what the BUDGET costs, and is NOT recall@servedK | topics whose window holds gold |
| `noiseAtK` | `1 − P@servedK` over the delivered window, budget NOT applied — the budget's cost is the other two columns' job | topics with a non-empty window |

**Read them together, in this order.** The three answer different halves and only agree by construction on one
identity: `noiseAtK` at k=5 is exactly `1 − precision5` (`vault` 1 − 0.3300 = 0.6700 vs 0.6678 — they differ because
`noiseAtK`'s denominator is the DELIVERED window length, so a topic that retrieved fewer than 5 documents is charged
on what it actually delivered rather than on 5).

**The honest headline: the window, not the budget, is the binding constraint.** At the served default the budget
costs **nothing** — `goldSurvivesBudget` 1.0000 on both corpora — and yet only **18.3 %** of English topics and
**32.3 %** of Hungarian ones receive their whole gold set. The gap is the top-5 window, not the token cap.

**Widening the window helps more than the tighter budget hurts.** Config B trades 5→8 slots against 64 000→12 000
tokens and `allGoldInBudget` RISES on both corpora (`vault` 0.1833 → 0.2500, `vault-hu` 0.3226 → 0.4516) while
`goldSurvivesBudget` falls off its ceiling (1.0000 → 0.9357 / 0.9839). So the 12 000-token cap **does** now drop
gold — on `vault` roughly one judgment in fifteen inside the window — and it is still the better cell. **This is the
first measured evidence that the R0.2-budget cell binds at all**; `GNOSIS-BASELINES.md` § Consumer view (2026-08-18)
concluded "the token budget is NOT a live quality constraint", and at 64 000 that still holds. At 12 000 it does not.

**Noise rises with the window, as it must.** `noiseAtK` `vault` 0.6678 → 0.7308, `vault-hu` 0.4968 → 0.6371: slots 6–8
hold more non-gold than slots 1–5. Roughly **two of every three** documents the English consumer receives are unjudged
or non-relevant, against **one in two** for Hungarian at the narrow window. MUST NOT read that as a defect rate — an
unjudged document is not a wrong one, and § Consumer view above records the RBP residual that says most reader
attention sits on unjudged documents on both corpora.

**Attestation.** All four re-scores agreed with the recorded per-topic TSV on **all 11** recorded columns, over 60 and
31 topics, with **zero disagreements**, and each exited 0. The two new columns are absent from every recorded TSV, so
they are computed here and drift-checked nowhere — they are DERIVED, and the eleven columns beside them are what
attests the ranking they are derived from.

**This is the BEFORE row for R4.2 (M5).** M5 moves the corpus, which invalidates every `vault` number in this table.
The four commands re-run after it, verbatim:

```
npm run gnosis:forensics -- --run 2026-08-20-072118969-fts5-vault.tsv    --served-k 5 --budget 64000
npm run gnosis:forensics -- --run 2026-08-20-072118969-fts5-vault.tsv    --served-k 8 --budget 12000
npm run gnosis:forensics -- --run 2026-08-20-072118969-fts5-vault-hu.tsv --served-k 5 --budget 64000
npm run gnosis:forensics -- --run 2026-08-20-072118969-fts5-vault-hu.tsv --served-k 8 --budget 12000
```


#### Consumer — the AFTER row, post-boundary at `qwen3-reranker-0.6b`, 2026-08-22

**Why this row exists.** `19` § 4 M5 required M1's four forensics commands to be re-run after the corpus moved. The corpus
did move — but by the **D24 accident and its repair**, not by the sidecar (`07-plan.md` § 6.71). The four commands could
not be re-run verbatim: they re-score a run recorded at the OLD corpus, and `gnosis:forensics` REFUSES when the atoms are
newer than the run. So a NEW arm was measured and re-scored instead.

| | BEFORE | AFTER |
|---|---|---|
| recorded run | `2026-08-20-072118969` | **`2026-08-22-125249802`** |
| cross-encoder | `qwen3-reranker-4b` | **`qwen3-reranker-0.6b`** |
| derived docs | 6 628 | **6 787** |
| nDCG@10 | `vault` 0.5791 · `vault-hu` 0.7699 | `vault` **0.5461** · `vault-hu` **0.7086** |

Everything else is held: `fts5`, `--rerank`, pool **100**, fusion `shipped` at `RERANK_RRF_WEIGHT` **0.75**, depth 100, PRF
off (the bench never reads a profile default).

| corpus | config | `allGoldInBudget` | `goldSurvivesBudget` | `noiseAtK` |
|---|---|---|---|---|
| `vault` | A — k5 / 64 000 | **0.1833** (60) | **1.0000** (55) | **0.6744** (60) |
| `vault` | B — k8 / 12 000 | **0.2500** (60) | **0.9032** (57) | **0.7287** (60) |
| `vault-hu` | A — k5 / 64 000 | **0.3226** (31) | **1.0000** (29) | **0.5484** (31) |
| `vault-hu` | B — k8 / 12 000 | **0.3871** (31) | **0.9933** (30) | **0.6734** (31) |

**These two rows MUST NOT be subtracted.** `atomCount` is a `SCALE_FIELD` and it moved (6 628 → 6 787); `rerankModel` is a
`TREATMENT_FIELD` and it moved (`4b` → `0.6b`). `compare.ts` REFUSES to subtract the first and labels the second
`ARM COMPARISON`. They are two labelled snapshots side by side, and the paragraph below reads them as such.

**The finding, and it is not the one the table was taken to confirm.** nDCG@10 fell on BOTH corpora — `vault` 0.5791 →
0.5461, `vault-hu` 0.7699 → 0.7086 — which is the known 4b→0.6b quality cost (`GNOSIS-BASELINES.md` § Reranker size)
compounded with a corpus change. **`allGoldInBudget` did not follow it.** It is IDENTICAL in three of the four cells
(`vault` A **0.1833**, `vault` B **0.2500**, `vault-hu` A **0.3226**) and moves in one (`vault-hu` B 0.4516 → 0.3871).

**The mechanism is legible, not mysterious.** `allGoldInBudget` asks whether the whole gold SET landed inside the served
window; nDCG@10 asks how that window is ORDERED. The measured 4b-over-0.6b advantage is largely ordering *within* a
window both models fill the same way — which is exactly what `GNOSIS-BASELINES.md` § Reranker size records when it says
the 0.6b costs `vault` **MRR@10** and measures nothing either way on `vault-hu`. **So the consumer-level question "does
the reader receive the whole answer" is far more robust to cross-encoder size than the ranking metric the model is
chosen on.** MUST NOT be read as *"the 0.6b is as good"* — it is not, on the metric the serving path is judged on. It
IS evidence that a cheaper reranker costs the pack's COMPLETENESS very little, which is the tradeoff a latency-bound
consumer actually faces.

**`noiseAtK` moved least of all** (`vault` +0.0066 / −0.0021, `vault-hu` +0.0516 / +0.0363) — the share of the delivered
window that is non-gold is close to a property of the corpus and the window size, not of the reranker.

**Rule 11, discharged:** every number in this subsection is `--rerank`-labelled, names its cross-encoder, and names the
recorded run it was re-scored from. Zero GPU was spent on the re-scores themselves; the arm behind the AFTER row cost
360 754 ms of query time on `vault` (60 topics) and 247 292 ms on `vault-hu` (31 topics). All four re-scores agreed with
their recorded per-topic TSV on all **11** recorded columns with zero disagreements, and each exited 0.

### Reranker size — 4b vs 0.6b at the champion pool, measured 2026-08-18 at `gitSha` 92d683e2

Same pool (100), same adapter (`fts5`), same corpora; only `rerankModel` moves. Paired, `ARM COMPARISON`.

| | `vault` (n=60) | `vault-hu` (n=31) |
|---|---|---|
| nDCG@10 | 0.5040 → 0.4672 · **−0.0368, p=0.0538**, CI [−0.0740, −0.0015] | 0.6929 → 0.6739 · −0.0190, p=0.2372 |
| R@10 | 0.5584 → 0.5489 · −0.0095, n.s. | 0.7274 → 0.7011 · −0.0263, n.s. |
| **MRR@10** | 0.6651 → 0.5882 · **−0.0768, p=0.0210 — significant** | 0.8355 → 0.8423 · +0.0068, n.s. |
| R@100 | 0.7931 → 0.7931 · +0.0000 | 0.8903 → 0.8903 · +0.0000 |
| Mean s/query | 12.25 → **5.52** | 17.65 → **7.94** |

**The conclusion is language-dependent, and that is the point.** On English the 0.6b costs MRR@10 significantly — it is worse at putting the right document FIRST — while nDCG@10 sits on the boundary (permutation p=0.0538, bootstrap CI excluding zero: the two procedures disagree, so this is a borderline result and MUST NOT be read as a clean null). On Hungarian nothing is measurable in either direction. Both buy a **2.2× latency cut**. The 0.6b still beats no reranking at all (`vault` 0.4357 → 0.4672).

**The zero-width R@100 CI is a positive control, not the § Landmines defect.** Both arms rerank the SAME 100 documents, so recall over that set is identical by construction; the exact zero is what proves the two arms saw one pool. Distinguish this from a zero-width CI on a metric that could have moved — that remains a defect until proven otherwise.

**Caveat:** `vault-hu` is n=31 and underpowered. Its CI [−0.0490, +0.0120] does not exclude a real loss of ~0.05 nDCG@10 — "no measured difference" is not "no difference".

**A `--depth 20` arm with the 0.6b was also run and is NOT recorded as a depth-20 measurement.** Post-T1.1 `RERANK_K_INIT` is 100, so `firstPassDepth` made its pool 100 while provenance recorded `depth: 20`. Its top-10 metrics are byte-identical to the depth-100 arm above, which is what exposed it. See GUIDE § Known harness gaps — provenance records the REQUESTED depth, not the effective pool.

### Pool depth on the 0.6b — measured 2026-08-18 at `gitSha` 2081ef44 / 0163b052

The question `--rerank-pool` was built to answer: does the cheap reranker still need the expensive pool? Both arms `fts5` + `qwen3-reranker-0.6b` at `--depth 20`; only the pool moves.

| | pool 20 | pool 100 | delta | s/query |
|---|---|---|---|---|
| `vault` nDCG@10 | 0.4612 | 0.4672 | **−0.0060** | 1.28 → 5.45 |
| `vault` R@10 | 0.5362 | 0.5489 | −0.0127 | |
| `vault` MRR@10 | 0.5798 | 0.5882 | −0.0084 | |
| `vault-hu` nDCG@10 | 0.6203 | 0.6740 | **−0.0537** | 1.61 → 7.84 |
| `vault-hu` R@10 | 0.6489 | 0.7011 | −0.0522 | |
| `vault-hu` MRR@10 | 0.8004 | 0.8423 | −0.0419 | |

**The deep pool earns its cost on Hungarian and almost nothing on English.** English pays −0.0060 nDCG@10 for a **4.2× speedup**; Hungarian pays −0.0537 for 4.9×. This is the same asymmetry the reranker-model comparison found from the other side — Hungarian's gains live in pool depth, English's in the model — and the two results agree, which is the reason to trust either.

**These are absolute numbers, not a paired test, and that is correct.** `rerankPool` is a `SCALE_FIELD`, so `gnosis:pair` refuses: *"NO PAIRED TEST — the measuring scale moved: rerankPool 20 → 100."* **Before `rerankPool` existed both rows carried identical provenance (`depth: 20`) and `compare.ts` would have subtracted them as a like-for-like delta.** That refusal is the field working.

**MUST NOT read the `R@100` column of a `--depth 20` row as R@100.** Scoring is cut at `depth`, so it is R@20 under the wrong name — the pool-100 arm's 0.6695 vs the pool-20 arm's 0.6013 is the reranker pulling documents from ranks 21–100 into the top 20, not deeper recall. T0.2 has since routed `recall10` / `recall100` through `measurableRecallAt`, so a run recorded from that change onward carries `undefined` there instead of a misleading number — **every row above, and every row recorded before it, still carries the misleading column** and MUST be read under this rule.

**Cost.** Seconds per query, mean and p50 (**corrected 2026-08-18**: an earlier revision of this paragraph said "there is no p50; per-topic latency is not instrumented". That was FALSE — `run.ts` has timed each topic and recorded `queryP50Ms` / `queryP95Ms` since 2026-08-14 at `gitSha` 1134d464, on 233 of the 247 history rows, and three other sections of this very file already quoted p50. What is genuinely absent is a per-STAGE split — retrieval, rerank and fusion cannot be separated from a recorded run):

| Arm | `vault` mean | `vault` p50 | `vault-hu` mean | `vault-hu` p50 |
|---|---|---|---|---|
| A | 2.85 | 2.77 | 0.54 | 0.53 |
| B | 2.71 | 2.64 | 0.53 | 0.52 |
| C | 2.79 | 2.63 | 3.63 | 3.72 |
| D | **12.25** | **12.77** | **17.65** | **17.49** |

The `vault` figures for A and B are dominated by `linear`'s full-corpus scan (~2.9 s over 11 345 atoms), which masks the reranker. `vault-hu` is where the reranker cost is visible, because 455 atoms scan in milliseconds: **0.53 s (bge, 20 docs) → 3.63 s (qwen3-4b, 20 docs)**. Inference, not a direct measurement — per-stage timing is not instrumented — but it implies qwen3-reranker-4b costs roughly **7× bge** per document, and that the champion's 12–18 s/query is almost entirely reranker time. Quality-first is the standing choice; this is what it costs.

### Rerank arms — measured 2026-08-15, PAIRED

Depth 100. `shipped` = RRF · `beir-ce` = pure cross-encoder replacement. Both rerank the SAME pool at the same depth; they differ only in fusion. Paired permutation + bootstrap CI, `gnosis:pair`.

| Dataset | BM25 | `shipped` (RRF) | `beir-ce` (replace) | `ce − shipped` nDCG@10 | p |
|---|---|---|---|---|---|
| scifact | 0.6858 | 0.7255 | **0.7311** | +0.0056 | 0.5488 |
| `vault-hu` | 0.4868 | 0.6724 | **0.7424** | **+0.0700** | **0.0229** |
| `vault` | 0.4357 | **0.4550** | 0.4228 | −0.0322 | 0.1255 |

**The sign flips by language and the mechanism is known.** `bge-reranker-v2-m3` is multilingual; BM25-with-English-Porter is the weak leg on Hungarian, so RRF keeping half the score from it DRAGS the good order down — hence `beir-ce` wins there. On English BM25 is strong and fusion helps.

**Reranking is worth +0.186 to +0.256 nDCG@10 on Hungarian** — the same order as the query-rephrasing lever, on the same corpus.

**R@100 is IDENTICAL across every arm** (`vault` 0.7931, `vault-hu` 0.8903): reranking only REORDERS the first-stage pool. It repairs ranking damage; it cannot recover gold the first stage never retrieved.

On scifact the only significant result is a REGRESSION (recall@10 −0.0207, p=0.0373) at +32% query time. Reranking costs ≈2.0–2.2 s p50 per query against 3–14 ms for BM25 alone. **MUST NOT switch the default preset on this evidence** — the winner is language-dependent, and `--rerank` is off by default anyway.

### THE FULL PICTURE — every reranker × corpus × phrasing, one table

`fts5`, depth 100, `shipped` fusion, every rerank arm served at an identical ctx/`-ub` 8192. Cells are **nDCG@10 / R@10**. **R@100 is a COLUMN property, not an arm property** — reranking reorders a fixed pool and mechanically cannot change it — so it is stated once in the header. Best cell per column in bold.

| Arm | EN plain<br>R@100 0.7931 | EN rephrased<br>R@100 0.8779 | HU plain<br>R@100 0.8903 | HU rephrased<br>R@100 0.9919 |
|---|---|---|---|---|
| BM25 only | 0.4357 / 0.4860 | 0.4232 / 0.5290 | 0.4868 / 0.5543 | 0.7275 / 0.7968 |
| `bge-reranker-v2-m3` | 0.4550 / 0.5240 | 0.4305 / 0.5390 | 0.6724 / 0.7210 | 0.7768 / 0.8210 |
| `qwen3-reranker-0.6b` | 0.4672 / 0.5489 | 0.4291 / 0.5258 | 0.6740 / 0.7011 | 0.7882 / 0.8661 |
| **`qwen3-reranker-4b`** | **0.5040 / 0.5584** | **0.4581 / 0.5587** | **0.6929 / 0.7274** | **0.8091 / 0.8715** |
| `ettin-reranker-1b-v1` | 0.3542 / 0.4423 | not run | 0.5172 / 0.5532 | not run |
| `jina-reranker-v3` | NO RESULT | NO RESULT | not attempted | not attempted |
| `jina-reranker-v3.5` | NO RESULT | NO RESULT | not attempted | not attempted |
| `mxbai-rerank-large-v2` | NO RESULT | NO RESULT | not attempted | not attempted |
| `llama-nemotron-rerank-1b-v2` | NO RESULT | NO RESULT | not attempted | not attempted |

**`ettin-reranker-1b-v1` is the first new WORKING reranker since `qwen3` — and it is a measured quality REGRESSION on English** (`vault` nDCG@10 0.3542, below the 0.4357 BM25 baseline it reranks). Adjudicated in § Phases A–C below.

**Four candidate rerankers produce no usable number.** `mxbai` and `nemotron` are blocked by the llama.cpp build (b10375); the two jina models are blocked by the GGUF itself and no build change fixes them. The rerankers that WORK (`bge`, `qwen3`, `ettin`) are classic cross-encoders carrying a real rank head in the GGUF.

| Model | Fails how | Root cause | License |
|---|---|---|---|
| `jina-reranker-v3` / `v3.5` | HTTP 200, near-zero scores that carry no ranking signal | **The GGUF CONVERSION drops the scoring head — the MODEL is sound. CORRECTED 2026-08-29** (`c84d1ca`); the earlier reading here, *"the ranking head is ABSENT FROM THE GGUF ENTIRELY"*, was true of the FILE but was written as a fact about the model, which it is not. The served GGUF holds **310** tensors against **313** in the native checkpoint, and the two missing ones are `projector.0.weight` (512×1024) and `projector.2.weight` (512×512). `modeling.py`'s `JinaForRanking` scores by COSINE SIMILARITY of `projector`-mapped hidden states read at the `<|rerank_token|>` / `<|embed_token|>` positions — not a `cls` rank head — so llama.cpp's `qwen3` conversion has no slot for the layer and drops it silently. Native `transformers` separates the bench's OWN probe pair **+0.5993 / −0.1582**; llama.cpp returns `2.496e-07 / 4.292e-07`, INVERTED. No GGUF and no llama.cpp flag fixes it; a non-llama.cpp `/v1/rerank` sidecar does, with no engine change. Retrieval quality remains UNMEASURED. Also Vulkan device-lost on real arms. Evidence: `docs/analysis/2026-08-29-1615-jina-reranker-root-cause-and-qwen-rerank-arms.md` (supersedes `docs/research/2026-08-16-2123-…` on the root cause) | CC BY-NC 4.0 |
| `mxbai-rerank-large-v2` | HTTP 200, **constant** score (document-invariant) | `arch=qwen2`, `pooling_type` ABSENT — a ProRank/generative reranker scoring via token logits, which `--rerank` cannot drive | apache-2.0 |
| `llama-nemotron-rerank-1b-v2` | **Refuses to load** — `wrong number of tensors; expected 148, got 147` | b10375 predates `LlamaBidirectionalForSequenceClassification` support (llama.cpp PR #24083) | NVIDIA Open + Llama 3.2 |

**Upgrading llama.cpp is the high-leverage action for TWO of the four, not all four** — a build upgrade plausibly unblocks `mxbai` and `nemotron`. It does NOT unblock `jina-v3` / `v3.5`: the weights that compute their score are not in the file being served. MUST NOT record a number from any of the four; `mxbai` in particular would produce a plausible near-BM25 row rather than an obvious failure. `mxbai` is the most interesting on licence grounds (apache-2.0 = shippable, unlike jina's NC).

Topic counts differ — EN 60, HU 31 — so **columns MUST NOT be compared for significance by eye**; the paired contrasts below are the evidence. `jina-reranker-v2-base-multilingual` is RETIRED (1024 trained context, cannot score a full atom); `jina-v3`/`v3.5` are NO RESULT (rank head absent from the GGUF AND Vulkan device-lost) — both detailed below.

What the table shows at a glance:

| Reading | Evidence |
|---|---|
| `qwen3-4b` is the best arm in **every** column | Only significant vs `bge` on EN (+0.0490, p=0.0092); on HU the +0.0205 gap is UNDER the MDE — cannot tell |
| Reranking is worth far more on Hungarian than English | HU plain +0.2062 (p=0.0001) vs EN plain +0.0683 (p=0.0003) — both real, an order of magnitude apart |
| Rephrasing is a RANKING lever on HU, a RECALL-only lever on EN | HU +0.1162 (p=0.0080) on top of rerank; EN −0.0459 (n.s.) |
| The two levers are SUB-ADDITIVE in both languages | Each shrinks the other's headroom — see both 2×2s below |
| Hungarian first-stage recall is effectively solved | R@100 0.9919 with rephrasing alone; English still leaks 12.2% |
| The best cell in the whole grid is HU rephrased + `qwen3-4b` | 0.8091, **+0.3223** over its BM25 baseline |

### Rephrasing × rerank on HUNGARIAN — measured 2026-08-16, PAIRED

`fts5`, `vault-hu` (31 topics), depth 100, `shipped` fusion, `qwen3-reranker-4b`. All four cells measured; every contrast below is significant.

| nDCG@10 | BM25 | + qwen3-4b | Δ rerank |
|---|---|---|---|
| plain | 0.4868 | 0.6929 | **+0.2062** (p=0.0001) |
| rephrased | 0.7275 | **0.8091** | **+0.0816** (p=0.0002) |
| Δ rephrase | **+0.2407** (p=0.0002) | **+0.1162** (p=0.0080) | |

**Both levers are individually large on Hungarian, and they are SUB-ADDITIVE — each shrinks the other's headroom.** Reranking is worth +0.2062 alone but +0.0816 on rephrased queries; rephrasing is worth +0.2407 alone but +0.1162 on reranked ones. Best combination 0.8091, **+0.3223 over BM25**.

**The language split is what rephrasing BUYS, not whether the two compound.** Sub-additivity holds in both languages. What differs:

| | rephrasing → nDCG@10 (on top of rerank) | rephrasing → R@100 |
|---|---|---|
| English `vault` | −0.0459 **n.s.** — recall-only lever | +0.0848 (p=0.0009) |
| Hungarian `vault-hu` | **+0.1162 (p=0.0080)** — a RANKING lever too | +0.1016 (p=0.0034) |

Consistent with the non-English rule in `packages/gnosis/QUERYING.md` (write the STEM the document uses, not the inflected form): on an agglutinative language de-inflection is a genuine lexical-match win, not merely keyword extraction.

**Hungarian recall is effectively solved by rephrasing alone: R@100 0.8903 → 0.9919.** Reranking cannot move R@100 (0.0000, `p=1.0000`, zero-width CI — the mechanical identity, not a defect).

**`bge` → `qwen3-reranker-4b` on Hungarian is +0.0205, p=0.19 — CANNOT TELL, not "no difference".** `vault-hu`'s MDE is ≈0.05–0.07 at 31 topics and this delta sits under it. The English winner is NOT confirmed on Hungarian; it is unmeasurable there until `vault-hu` grows (§ Known harness gaps).

### Rephrasing × rerank on English — measured 2026-08-16, PAIRED

`fts5`, depth 100, `shipped` fusion, `bge-reranker-v2-m3`. `vault-rephrased` shares `vault`'s topic ids and judgments; **20 of its 60 queries are byte-identical by design**, so every whole-set delta is diluted by 33% guaranteed ties. The changed-40 subset is in brackets and is the number to reason from.

| Contrast | Δ nDCG@10 | p | Δ R@10 | p | Δ R@100 | p |
|---|---|---|---|---|---|---|
| plain: BM25 → rerank | +0.0193 [+0.0207] | 0.29 | +0.0380 [+0.0361] | 0.13 | +0.0000 | — |
| rephrased: BM25 → rerank | +0.0073 [**+0.0028**] | 0.68 | +0.0099 [**−0.0059**] | 0.65 | +0.0000 | — |
| under rerank: plain → rephrased | −0.0245 [−0.0368] | 0.39 | +0.0150 [+0.0225] | 0.68 | **+0.0848** [**+0.1272**] | **0.0006** |

**Rephrasing and reranking do NOT compound on English.** The reranker's contribution shrinks toward zero once queries are rephrased — +0.0028 nDCG@10 and slightly NEGATIVE R@10 on the rewritten topics, against +0.0207 / +0.0361 on raw ones. Both deltas are individually non-significant, so the supported claim is **no evidence of compounding, with point estimates running the wrong way** — NOT that rephrasing suppresses the reranker.

**This is the sharpest statement of the ceiling problem.** Rephrasing puts **87.4%** of gold inside the retrieved pool on rewritten topics (R@100 +0.1272, p=0.0006) and NEITHER BM25 NOR the cross-encoder promotes any of it into the top 10. English gold is no longer unreachable — the ranker cannot find it in a pool it already holds.

The `p=1.0000` / zero-width-CI rows on R@100 are the LEGITIMATE instance of that pattern, not the defect § Landmines warns about: reranking reorders a fixed pool, so the delta is mechanically exactly zero.

### Reranker model on English — measured 2026-08-16, PAIRED, 3 models

`fts5`, `vault` (EN, 60 topics), depth 100, `shipped` fusion. All arms served at an identical ctx/`-ub` 8192, so no arm sees a document another truncates. Recovery = fraction of reachable gold (`R@100 − R@10` of BM25 = 0.3071) lifted into the top 10.

| Arm | nDCG@10 | R@10 | Recovery | p50 |
|---|---|---|---|---|
| BM25 only | 0.4357 | 0.4860 | — | 3–14 ms |
| `bge-reranker-v2-m3` | 0.4550 | 0.5240 | 12.4 % | ≈2.0 s |
| `qwen3-reranker-0.6b` | 0.4672 | 0.5489 | 20.5 % | 5.7 s |
| **`qwen3-reranker-4b`** | **0.5040** | **0.5584** | **23.6 %** | 12.3 s |
| `jina-reranker-v3` | **NO RESULT** | — | — | — |
| `jina-reranker-v3.5` | **NO RESULT** | — | — | — |

**The two jina rows are empty because the model produced nothing usable, NOT because they were skipped.** Both fail twice over, and each failure alone disqualifies them on this build:

1. **The rank head is ABSENT from the GGUF** — both served files measured at the header: `arch=qwen3`, `pooling_type` KV absent, 310 tensors, no `cls`/`score`/`rank`/`classifier`/`pooler` tensor. llama.cpp forces RANK onto a bare backbone and returns near-zero scores at HTTP 200 that carry no ranking signal (v3 `4.17e-07` vs `7.28e-07`, v3.5 `1.96e-07` vs `2.94e-07` — both rank a cake recipe above a BM25 passage). The model is also **listwise**, so pairwise `/v1/rerank` is the wrong API shape. Explicit `--embedding --pooling rank --reranking` gives **byte-identical** output — no flag fixes it, and no build does either. See `docs/research/2026-08-16-2123-jina-reranker-v3-score-scale-vs-broken.md` (supersedes `…-1200-jina-rerank-llamacpp-params.md` on this point).
2. **Vulkan device-lost under sustained load** — all 4 attempted dataset arms died with `decode() failed: vk::Queue::submit: ErrorDeviceLost`. This is the RADV failure class that already forces gemma to ROCm-only. The device recovered and `qwen3-4b` re-probed clean afterwards.

A number here would have been noise dressed as a measurement — MUST NOT fill these cells until a patched build passes the discrimination probe AND completes an arm without a device-lost.

`jina-reranker-v2-base-multilingual` is **RETIRED** (2026-08-16) and is deliberately absent: its trained context is 1024, so it cannot score a full-length atom at all.

| Contrast | Δ nDCG@10 | p | Δ R@10 | p | Δ MRR@10 | p |
|---|---|---|---|---|---|---|
| BM25 → qwen3-4b | **+0.0683** | **0.0003** | **+0.0723** | **0.0290** | **+0.1166** | **0.0001** |
| bge → qwen3-4b | **+0.0490** | **0.0092** | +0.0344 | 0.22 | +0.0510 | 0.17 |
| qwen3-06b → qwen3-4b | +0.0368 | 0.0538 | +0.0095 | 0.72 | **+0.0768** | **0.0210** |
| bge → qwen3-06b | +0.0122 | 0.49 | +0.0249 | 0.33 | −0.0258 | 0.39 |

**English weakness was substantially the MODEL, not the approach.** `qwen3-reranker-4b` is the first arm to beat BOTH BM25 and the shipped `bge` significantly on English; both surviving results clear Bonferroni (α=0.0125 for these four contrasts). This REVISES finding F1 — the cross-encoder approach does fit this corpus; `bge` was simply too weak on English.

**It costs ~6× bge's latency** (12.3 s vs ≈2.0 s p50) for +0.049 nDCG@10. A default switch is a quality/latency decision, NOT implied by this table — and `--rerank` is off by default anyway.

**Reranking still cannot raise the ceiling, and rephrasing still does not compound.** Under `qwen3-4b`, plain → rephrased is R@100 **+0.0848 (p=0.0009)** but nDCG@10 **−0.0459 (n.s.)** — the same scissors N1 found under `bge`, so that conclusion survives a materially stronger reranker. Even the best arm recovers only 23.6 % of reachable gold.

### Phases A–C of the LanceDB/reranker campaign — measured 2026-08-16 at `gitSha` b565743a

**This is the A–C picture ONLY. Phase D — the dense leg — has NOT run**, so this table is NOT yet the consolidated deliverable that `docs/plans/2026-08-16-1930-dp-gnosis-lancedb-routes-rerankers-and-harness-gaps.md` § Phase F defines. Depth 100, adapter index built per arm, `shipped` fusion. Every delta is a paired permutation test with a bootstrap 95% CI (`gnosis:pair`) against a named baseline.

**Exactly TWO comparisons were PRE-SPECIFIED PRIMARY** — `ettin` vs `qwen3-4b` on `vault`, and `lancedb` vs `fts5` on `vault`. Both are marked below. **Every other row is EXPLORATORY and MUST be read as such**: this campaign ran many tests, and an uncorrected best-of-N p is optimistically biased. Every `vault-hu` null reads **cannot tell** — 31 topics, MDE 0.05–0.07 — never "no difference".

#### Gate verification (Phase A) — regression checks, not new science

| Check | Result |
|---|---|
| `fts5` `vault-hu` re-run after A1 | nDCG@10 0.48679413458675408 — **bit-identical** to the 2026-08-15 row at `9938be7a`, on all 4 metrics AND all sds |
| `lancedb` `vault-hu` re-run after A3 (`maxTokenLength` now set) | nDCG@10 0.53693155065244891 — **bit-identical** to the `a14e707f` baseline |
| `--rerank --rerank-model mxbai-rerank-large-v2` | Arm FAILS, exit 1, cause `dp-gnosis-bench/rerank-probe-failed`, both probe scores quoted as 0.11378549039363861 |

#### Reranker discrimination probe — live, every served model

Query about BM25 ranking; doc0 = relevant passage, doc1 = chocolate-cake recipe.

| Model | relevant | irrelevant | Verdict |
|---|---|---|---|
| `bge-reranker-v2-m3` | 5.168442726135254 | −10.970276832580566 | PASS |
| `qwen3-reranker-0.6b` | 0.9995161294937134 | 0.00003597568138502538 | PASS |
| `qwen3-reranker-4b` | 0.9994499087333679 | 9.255622330783808e-7 | PASS |
| `ettin-reranker-1b-v1` | 2.281376600265503 | −0.1328788846731186 | PASS |
| `mxbai-rerank-large-v2` | 0.11378549039363861 | 0.11378549039363861 | **NO RESULT — CONSTANT, document-invariant** |
| `llama-nemotron-rerank-1b-v2` | HTTP 500 `upstream command exited prematurely` | — | **NO RESULT — will not load** |
| `jina-reranker-v3` | 7.000250548117037e-7 | 5.459683052322362e-7 | Passes the directional rule, **NO RESULT** — broken by architecture (rank head absent from the GGUF, above) |

Hard-negative ordering, 5 cases, gold-document MRR (random ≈0.47): `bge` 1.000 · `qwen3-4b` 1.000 · `ettin` 0.800 · `jina-v3.5` 0.767 · `jina-v3` 0.640.

**The directional probe alone does NOT clear a model** — `jina-v3` passes it and is still unusable. That is why the gate asserts the scores DIFFER, and why the hard-negative set exists.

#### Phase B — rerankers on `fts5`

nDCG@10 / R@10 / R@100 / MRR@10:

| Arm | `vault` | `vault-hu` |
|---|---|---|
| BM25, no rerank | 0.4357 / 0.4860 / 0.7931 / 0.5484 | 0.4868 / 0.5543 / 0.8903 / 0.6073 |
| + `qwen3-reranker-4b` | **0.5040 / 0.5584** / 0.7931 / **0.6651** | **0.6929 / 0.7274** / 0.8903 / **0.8355** |
| + `ettin-reranker-1b-v1` | 0.3542 / 0.4423 / 0.7931 / 0.4283 | 0.5172 / 0.5532 / 0.8903 / 0.6619 |

| Comparison | Δ nDCG@10 | p | 95% CI | Verdict |
|---|---|---|---|---|
| `ettin` vs `qwen3-4b`, `vault` — **PRE-SPECIFIED PRIMARY** | **−0.1498** | **0.0001** | [−0.1983, −0.0997] | Significant — `ettin` WORSE |
| `ettin` vs BM25, `vault` — exploratory | **−0.0815** | **0.0030** | [−0.1319, −0.0318] | Significant — `ettin` worse than NO reranking |
| `ettin` vs `qwen3-4b`, `vault-hu` — exploratory | **−0.1757** | **0.0001** | [−0.2445, −0.1102] | Significant — `ettin` WORSE |
| `ettin` vs BM25, `vault-hu` — exploratory | +0.0304 | 0.5079 | [−0.0528, +0.1221] | **Cannot tell** |

**`ettin-reranker-1b-v1` is the first new WORKING reranker since `qwen3`, and it is a measured quality REGRESSION on English** — it loses to `qwen3-4b` on the pre-specified primary AND, unusually, to doing no reranking at all. `qwen3-reranker-4b` remains the best measured reranker on both corpora.

R@100 is identical across every rerank arm and its BM25 baseline — reranking reorders a fixed pool at depth 100. **The `p=1.0000` / zero-width CI on R@100 is the expected mechanical invariant here, NOT the defect signature** § Landmines warns about.

#### Phase C — adapter routes, no rerank

nDCG@10:

| Adapter | `vault` | `vault-hu` | scifact | nfcorpus | arguana |
|---|---|---|---|---|---|
| `fts5` (production) | 0.4357 | 0.4868 | 0.6858 | 0.3164 | 0.3634 |
| `linear` | 0.4348 | 0.5306 | not run | not run | not run |
| `lancedb` | 0.4226 | 0.5369 | 0.6825 | 0.3220 | 0.3481 |
| `minisearch` | 0.3871 | 0.5455 | 0.6521 | 0.3049 | 0.2041 |

Δ nDCG@10 vs the named `fts5` baseline:

| Comparison | Δ | p | 95% CI | Verdict |
|---|---|---|---|---|
| `lancedb` vs `fts5`, `vault` — **PRE-SPECIFIED PRIMARY** | −0.0132 | 0.2475 | [−0.0365, +0.0075] | NOT significant |
| `lancedb` vs `fts5`, scifact — exploratory | −0.0032 | 0.6355 | [−0.0163, +0.0098] | Not significant |
| `lancedb` vs `fts5`, nfcorpus — exploratory | +0.0056 | **0.0288** | [+0.0008, +0.0112] | Significant but negligible |
| `lancedb` vs `fts5`, arguana — exploratory | −0.0153 | **0.0001** | [−0.0203, −0.0108] | Significant — `lancedb` worse |
| `linear` vs `fts5`, `vault` — exploratory | −0.0009 | 0.9433 | [−0.0290, +0.0242] | Not significant |
| `minisearch` vs `fts5`, `vault` — exploratory | −0.0486 | **0.0385** | [−0.0942, −0.0047] | Significant — `minisearch` worse |
| `lancedb` vs `fts5`, `vault-hu` — exploratory | +0.0502 | **0.0157** | [+0.0151, +0.0893] | Significant |
| `linear` vs `fts5`, `vault-hu` — exploratory | +0.0439 | **0.0311** | [+0.0092, +0.0842] | Significant |
| `minisearch` vs `fts5`, `vault-hu` — exploratory | +0.0587 | 0.1121 | [−0.0071, +0.1309] | **Cannot tell** |

R@100, `lancedb` vs `fts5`: `vault` +0.0080 (p=0.5227) · scifact +0.0103 (p=0.2155) · nfcorpus +0.0005 (p=0.7179) · arguana −0.0100 (p=0.0012, worse).

**LanceDB's FTS route is quality-EQUIVALENT to `fts5` where the corpora have power.** The pre-specified primary on `vault` (60 topics, MDE 0.015) is null, and the three BEIR deltas are ≤0.016 in either direction. The one exception is arguana, where `lancedb` is significantly but slightly worse on both nDCG@10 and R@100. **MUST NOT read this as "LanceDB is worse"** — and equally MUST NOT read the `vault-hu` +0.0502 as a LanceDB advantage; see C4.

#### Phase C4 — `lancedb` WITH a reranker (first reranked non-`fts5` arm ever recorded)

`lancedb` + `qwen3-reranker-4b`: `vault` 0.4953 / 0.5516 / 0.8011 / 0.6664 · `vault-hu` 0.7023 / 0.7543 / 0.9145 / 0.8412.

| Comparison (all exploratory) | Metric | Δ | p | 95% CI |
|---|---|---|---|---|
| `lancedb`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault` | nDCG@10 | −0.0087 | 0.2388 | [−0.0231, +0.0045] |
| `lancedb`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault` | R@100 | +0.0080 | 0.5227 | [−0.0130, +0.0317] |
| `lancedb`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault-hu` | nDCG@10 | +0.0094 | 0.5198 | [−0.0163, +0.0385] |
| `lancedb`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault-hu` | R@100 | +0.0242 | 0.5102 | [−0.0081, +0.0726] |
| Rerank ON the `lancedb` route, `vault` | nDCG@10 | **+0.0727** | **0.0002** | [+0.0371, +0.1092] |

**LanceDB's apparent `vault-hu` advantage survives NEITHER the powered corpus NOR a reranker.** Its +0.0502 first-stage nDCG@10 gain collapses to +0.0094 once `qwen3-4b` runs, and the binding metric for the reranked branch — R@100 — is +0.0242 at p=0.5102, a cannot-tell. **A first-stage nDCG gain that does not lift the binding recall buys nothing downstream of a reranker** — the standing rule in `GNOSIS-BENCH.md` § What to measure, now measured rather than asserted.

C4 also confirms `rerankIfRequested` is genuinely adapter-agnostic: reranking lifts the `lancedb` route by +0.0727 (p=0.0002), the same order as it lifts `fts5`.

### Phase D — the dense leg and hybrid fusion, measured 2026-08-17 at `gitSha` 8c89dc75

`bge-m3` FP16 (CLS pooling, 1024 dims), depth 100, exhaustive cosine — no ANN index. Full write-up, every open question and the D2 probe evidence: `docs/analysis/2026-08-17-0730-dp-gnosis-phase-d-dense-leg-and-hybrid-fusion.md`.

| Route | Reranker | Rephrased | `vault` nDCG@10 | `vault` R@100 | `vault-hu` nDCG@10 | `vault-hu` R@100 |
|---|---|---|---|---|---|---|
| `fts5` | — | — | 0.4357 | 0.7931 | 0.4868 | 0.8903 |
| `fts5` | qwen3-4b | — | **0.5040** | 0.7931 | 0.6929 | 0.8903 |
| `fts5` | — | yes | 0.4232 | 0.8779 | 0.7275 | 0.9919 |
| `fts5` | qwen3-4b | yes | 0.4581 | 0.8779 | **0.8091** | 0.9919 |
| `lancedb-vec` | — | — | 0.2736 | 0.5796 | 0.5882 | 0.9118 |
| `lancedb-vec` | — | yes | 0.2735 | 0.6370 | 0.5855 | 0.9038 |
| `lancedb-hybrid` | — | — | 0.3965 | 0.8335 | 0.6196 | 0.9694 |
| `lancedb-hybrid` | qwen3-4b | — | 0.4747 | 0.8335 | 0.7554 | 0.9694 |
| `lancedb-hybrid` | — | yes | 0.3793 | 0.8798 | 0.6864 | 0.9919 |
| `lancedb-hybrid` | qwen3-4b | yes | 0.4481 | 0.8798 | 0.7739 | 0.9919 |

**Champions are UNCHANGED by Phase D**: `vault` = `fts5`+`qwen3-4b` (0.5040); `vault-hu` = `fts5`+`qwen3-4b`+rephrased (0.8091). The factorial is complete — **every dense/hybrid arm lands below its corpus champion on nDCG@10.**

| Comparison | Metric | Δ | p | 95% CI |
|---|---|---|---|---|
| **PRIMARY** — `lancedb-hybrid` vs `fts5`, `vault` | nDCG@10 | −0.0393 | 0.1490 | [−0.0924, +0.0127] |
| **PRIMARY** — `lancedb-hybrid` vs `fts5`, `vault` | R@100 | **+0.0404** | **0.0084** | [+0.0120, +0.0743] |
| `lancedb-hybrid` vs `fts5`, `vault-hu` | nDCG@10 | **+0.1328** | **0.0029** | [+0.0524, +0.2083] |
| `lancedb-hybrid` vs `fts5`, `vault-hu` | R@100 | **+0.0790** | **0.0164** | [+0.0242, +0.1371] |
| `lancedb-hybrid` vs `fts5`, `vault-hu` | MRR@10 | **+0.1599** | **0.0139** | [+0.0482, +0.2765] |
| `lancedb-vec` vs `fts5`, `vault` | nDCG@10 | **−0.1621** | **0.0001** | [−0.2425, −0.0838] |
| `lancedb-vec` vs `fts5`, `vault` | R@100 | **−0.2135** | **0.0001** | [−0.3056, −0.1247] |
| `lancedb-hybrid`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault` | nDCG@10 | −0.0293 | 0.0711 | [−0.0604, +0.0011] |
| `lancedb-hybrid`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault` | MRR@10 | **−0.0642** | **0.0393** | [−0.1244, −0.0080] |
| `lancedb-hybrid`+`qwen3-4b` vs `fts5`+`qwen3-4b`, `vault-hu` | nDCG@10 | **+0.0625** | **0.0319** | [+0.0091, +0.1219] |

Only the two PRIMARY rows were pre-specified; the rest are exploratory.

**Rephrasing is INERT on the dense leg** — `lancedb-vec` base vs rephrased is −0.0027 (`vault-hu`) and −0.0001 (`vault`). The project's largest lever is invisible to the encoder.

### Phase D addendum — fusion weight, fusion profile, untruncated pools, measured 2026-08-17

**CORRECTS the Phase D table above**: `lancedb-hybrid` there used `hybridWeight=0.5`, inherited from `RERANK_RRF_WEIGHT` and never measured. Full write-up: `docs/analysis/2026-08-17-1215-dp-gnosis-phase-d-addendum-fusion-weight-profile-and-untruncated-pools.md`.

**Leg-fusion weight sweep** — `lancedb-hybrid`, first stage, no rerank. `w` = dense share.

| w | `vault` nDCG@10 | `vault` R@100 | `vault-hu` nDCG@10 | `vault-hu` R@100 |
|---|---|---|---|---|
| 0.00 | 0.4375 | 0.8011 | 0.5369 | 0.9145 |
| **0.25** | **0.4510** | 0.8204 | 0.6110 | **0.9710** |
| 0.50 *(old default)* | 0.3965 | **0.8335** | **0.6196** | 0.9694 |
| 0.75 | 0.3119 | 0.7709 | 0.6134 | 0.9694 |
| 1.00 | 0.2736 | 0.5796 | 0.5882 | 0.9118 |

`w=0.5` reproduces the recorded `lancedb-hybrid` rows and `w=1.0` the `lancedb-vec` rows, bit-for-bit — the sweep's self-check.

**Reranked arms (qwen3-4b) and the untruncated pool**

| Arm | `vault` nDCG@10 | `vault` R@100 | `vault-hu-reph` nDCG@10 |
|---|---|---|---|
| `fts5` + shipped *(prior champion)* | 0.5040 | 0.7931 | 0.8091 |
| `fts5` + beir-ce | **0.5197** | 0.7931 | 0.7758 |
| `lancedb-hybrid` w=0.5 + shipped | 0.4747 | 0.8335 | 0.7739 |
| `lancedb-hybrid` w=0.5 + beir-ce | 0.5085 | 0.8335 | 0.7727 |
| `lancedb-hybrid` **w=0.25** + shipped | 0.5071 | 0.8204 | **0.7954** |
| `lancedb-hybrid` **w=0.25** + beir-ce | **0.5195** | 0.8204 | — |
| `lancedb-hybrid-full` + shipped | 0.4757 | **0.8484** | 0.7735 |

| Comparison | Δ nDCG@10 | p | 95% CI |
|---|---|---|---|
| `vault` hybrid w=0.5 → 0.25, first stage | **+0.0545** | **0.0008** | [+0.0266, +0.0831] |
| `vault` hybrid w=0.5 → 0.25, reranked | **+0.0324** | **0.0007** | [+0.0154, +0.0503] |
| `vault-hu` hybrid w=0.5 → 0.25 | −0.0085 | 0.7360 | [−0.0526, +0.0417] |
| `vault` `fts5` → hybrid w=0.25 (shipped) | +0.0031 | 0.8169 | [−0.0236, +0.0296] |
| `vault` `fts5` → hybrid w=0.25 (beir-ce) | −0.0002 | 0.9786 | [−0.0184, +0.0176] |
| `vault-hu-reph` `fts5` → hybrid w=0.25 | −0.0137 | 0.6010 | [−0.0626, +0.0289] |
| `vault` `fts5` shipped → beir-ce | +0.0157 | 0.4278 | [−0.0212, +0.0526] |
| `vault` hybrid shipped → beir-ce | +0.0338 | 0.0987 | [−0.0036, +0.0749] |
| `vault` hybrid → **hybrid-full** | +0.0010 | 0.8261 | [−0.0102, +0.0114] |
| `vault-hu` hybrid → **hybrid-full** | +0.0037 | 0.5425 | [−0.0079, +0.0156] |
| `vault-hu-reph` hybrid → **hybrid-full** | −0.0003 | 1.0000 | [−0.0010, +0.0000] |

**A correctly-tuned dense leg is NEUTRAL** — every `fts5`-vs-hybrid comparison at w=0.25 is a null with p ≥ 0.60. **Enlarging the reranked pool is null on all three corpora** at 1.64× cost.

### Analyzer 2×2 — measured 2026-08-15, PAIRED

`fts5`, depth 100, no rerank. Chains from `ANALYZERS` (`query.ts`); the id is stamped into the index and read back at query time.

| Analyzer | `vault` nDCG@10 | `vault` R@100 | `vault-hu` nDCG@10 | `vault-hu` R@100 |
|---|---|---|---|---|
| `porter-fold` (default) | **0.4357** | **0.7931** | 0.4868 | 0.8903 |
| `porter-nofold` | 0.4357 | 0.7931 | **0.4887** | 0.8903 |
| `nostem-fold` | 0.3906 | 0.7407 | 0.4849 | **0.9065** |
| `nostem-nofold` | 0.3906 | 0.7407 | 0.4849 | **0.9065** |

`porter-fold → nostem-fold`, paired:

| Corpus | n | nDCG@10 | p | R@10 | p | R@100 | p |
|---|---|---|---|---|---|---|---|
| `vault` (EN) | 60 | **−0.0451** | **0.0185** | **−0.0676** | **0.0046** | −0.0524 | 0.0991 |
| `vault-hu` | 31 | −0.0018 | 0.8109 | −0.0081 | 0.7516 | +0.0161 | 0.4967 |

**Porter earns its place on English** — removing it is significantly harmful, which is what makes this a working control rather than an inert knob.

**On Hungarian every cell is a null.** Per the standing rule a null on `vault-hu` means *cannot tell* (MDE ≈0.05–0.07), not *no difference* — and the observed ΔR@100 of +0.016 is far below that floor. Porter's MANGLING on Hungarian is therefore small; this does NOT measure de-inflection, which `nostem-*` cannot perform.

**Folding is inert on its own** and matters only in interaction with stemming: `nostem-fold` ≡ `nostem-nofold` exactly on both corpora, because folding is applied symmetrically to corpus and query. It moves a number only via Porter, whose output depends on whether it sees ASCII-folded text (`bevallás` vs `bevallas` stem differently).

**Consequence: an analyzer swap MUST be corpus-scoped, never global** — the same change that is a wash on Hungarian is significantly harmful on English.

### BEIR Tier-1 — measured 2026-08-15 at `gitSha` 35c7a546

Full write-up with deviations and protocol disclosure: `docs/analysis/2026-08-15-1141-dp-gnosis-beir-tier1-baseline.md`.

| Dataset | topics | atoms | nDCG@10 | published BM25 | Δ | R@100 | p50 |
|---|---|---|---|---|---|---|---|
| scifact | 300 | 5,202 | 0.6858 | 0.665 | +0.021 | 0.9177 | 14 ms |
| nfcorpus | 323 | 3,645 | 0.3164 | 0.325 | −0.009 | 0.2463 | 3 ms |
| arguana | 1,406 | 8,699 | 0.3634 | 0.315 | +0.048 | 0.9602 | 491 ms |
| trec-covid | 50 | 171,798 | 0.5683 | 0.656 | **−0.088** | 0.1030 | 501 ms |
| scidocs | 1,000 | 25,963 | 0.1531 | 0.158 | −0.005 | 0.3519 | 46 ms |
| fiqa | 648 | 58,078 | 0.2463 | 0.236 | +0.010 | 0.5521 | 114 ms |
| webis-touche2020 | 49 | 445,245 | 0.3403 | 0.367 | −0.027 | 0.5545 | 1,054 ms |

**No systematic offset** — the deviations alternate in sign and four of seven are inside ±0.03, so the ±0.05 gate (which asks for a deviation *in the same direction as the others*) is not tripped. trec-covid is the lone outlier: its relevance is unusually title-driven and 24.6% of its records are title-only, while our fts5 table is single-column and **cannot weight a title field at all**.

**Our BM25 configuration is disclosed, not reproduced** (decision D7): single-column contentless fts5 with k1=1.2 / b=0.75 compiled into SQLite, against BEIR's Anserini/Lucene at k1=0.9 / b=0.4 with title and passage as **separate fields**. Column weighting is impossible without a schema change, so a published result that depends on it cannot be matched by construction.

**trec-covid's 0.6036 in any older record is superseded** — measured under the rejected title-weighting experiment. **0.5683 is the clean number.** Scores are deterministic and repeat runs reproduce to the last digit; wall-times do not.

### BRIGHT

| Dataset | nDCG@10 | R@100 | atoms |
|---|---|---|---|
| bright-earth_science | 0.3908 | 0.7615 | 13,587 |
| bright-sustainable_living | 0.3749 | 0.7778 | 12,255 |
| bright-economics | 0.3219 | 0.6861 | 10,050 |
| bright-biology | 0.3130 | 0.6764 | 8,930 |
| bright-stackoverflow | 0.2655 | 0.6752 | 99,244 |
| bright-psychology | 0.2380 | 0.5851 | 10,872 |
| bright-robotics | 0.2030 | 0.5941 | 11,031 |
| bright-pony | 0.1995 | 0.7356 | 1,213 |
| bright-biology-passages | 0.1043 | 0.3308 | 55,695 |

**BM25 par gap — an implementation gap, not a data problem.** Our biology 0.1043 against a legitimate BM25 band of 0.175–0.197, protocol verified identical.

**Ingest cost is content-dependent, not size-driven:** bright-robotics ingests in 133 s at 11,031 atoms while bright-economics takes 5 s at 10,050.

