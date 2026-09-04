<!-- LLM-PRIMARY: Open if reviewing the 2026-08-09 dp-gnosis SPIKE-2 technical tokenization analysis; it recommends no change to tokenize() despite recall gaps in rare technical tokens. -->

# dp-gnosis SPIKE-2 — technical-token tokenization

> **Finding document, not a change.** No source file was modified. The recommendation below is
> **no change to `tokenize()` at this time**, and the reason is the pre-registered interpretability
> floor of the frozen golden set, not an absence of a defect.

## Provenance

- golden set: `tools/dp-gnosis/golden/golden-set.v1.json`, sha256
  `b03fec2f403b10fda60eafbf8d23ff37caa3d0a20e994e0be990cdc1c71d7910` — verified unchanged
  (`sha256sum tools/dp-gnosis/golden/golden-set.v1.json`), 50 queries, frozen `2026-08-08`
- corpus: `gnosis/atoms`, 702 atoms
- prior benchmark under measurement: `docs/test/2026-08-08-2142-dp-gnosis-retrieval-bench.md`
  and its sidecar `.json` — **still current; this spike does NOT supersede it**
- k = 5 throughout

## 1. Per-axis recall/MRR — the breakdown that did not exist before

The bench harness already records `axis` on every `perQuery` entry (`src/bench/metrics.ts`
`QueryMetric.axis`), but `src/bench/report.ts` renders only the blended aggregate. The per-axis view
is therefore a pure re-aggregation of the **already-persisted** sidecar — no re-run, no new epoch:

```bash
node -e "
const r=require('./docs/test/2026-08-08-2142-dp-gnosis-retrieval-bench.json');
for(const res of r.results){ if(!res.metrics) continue;
  const byAxis={}; for(const q of res.perQuery){ (byAxis[q.axis] ||= []).push(q); }
  const m=a=>a.reduce((s,v)=>s+v,0)/a.length;
  for(const [ax,qs] of Object.entries(byAxis))
    console.log(res.adapter, ax, m(qs.map(q=>q.recall)).toFixed(4), m(qs.map(q=>q.reciprocalRank)).toFixed(4));
}"
```

recall@5 / MRR, seed corpus (702 atoms):

| axis | n | linear-scan | fts5 |
|---|---|---|---|
| exact-keyword | 9 | **1.0000 / 1.0000** | **1.0000 / 1.0000** |
| multi-word-phrase | 8 | 0.8333 / 0.9375 | 0.6458 / 0.8750 |
| domain-filtered | 6 | 0.7222 / 0.8889 | 0.6667 / 0.7639 |
| **rare-technical-token** | **9** | **0.6222 / 0.7778** | **0.6685 / 0.7778** |
| inflected-form | 6 | 0.6111 / 0.6389 | 0.5556 / 0.6389 |
| production-shaped-long-form | 6 | 0.5250 / 1.0000 | 0.4167 / 0.8056 |
| synonym | 6 | 0.1944 / 0.3750 | 0.1944 / 0.3750 |
| **all queries** | 50 | 0.6717 / 0.8183 | 0.6237 / 0.7700 |

**`rare-technical-token` sits 37.8 pts (linear-scan) / 33.2 pts (fts5) below `exact-keyword`.** That
gap is real, and it is the fourth-largest axis gap, not the largest — `synonym` (0.1944, both
adapters) is far worse and is *not* a tokenization problem.

Per-query, the technical axis is bimodal rather than uniformly degraded:

| query | linear-scan recall | fts5 recall | verdict |
|---|---|---|---|
| q-024 `tsc -b` | **0.000** | **0.000** | total miss |
| q-025 `@/features` | **0.000** | **0.000** | total miss |
| q-028 `.agentic-runner/telemetry.sqlite` | 0.500 | 1.000 | partial |
| q-031 `RUNNER_EVAL_CAPTURE` | 0.500 | 1.000 | partial |
| q-026 `useEffect` | 0.600 | 0.600 | partial |
| q-029 `data-testid` | 1.000 | 0.750 | ok |
| q-030 `onnxruntime-web` | 1.000 | 0.667 | ok |
| q-027 `lint:test-shape` | 1.000 | 1.000 | ok |
| q-032 `@impacts` | 1.000 | 1.000 | ok |

**7 of 9 technical queries retrieve a relevant atom at rank 1** (reciprocal rank 1.0). The axis loss
is concentrated in exactly **two queries that return nothing at all**, in **both** adapters.

## 2. Diagnosis — which tokens are destroyed, and by whom

Actual `tokenize()` output on the real corpus, with each fragment's document frequency over the 702
atoms (`df`, higher = less discriminative):

| query | tokens produced | df of each |
|---|---|---|
| `tsc -b` | `tsc`, `b` | 22, **34** |
| `@/features` | `features` | **49** |
| `lint:test-shape` | `lint`, `test`, `shape` | 41, **133**, 26 |
| `.agentic-runner/telemetry.sqlite` | `agentic`, `runner`, `telemetry`, `sqlite` | 25, **62**, 26, 16 |
| `RUNNER_EVAL_CAPTURE` | `runner`, `eval`, `capture` | **62**, 11, 15 |
| `data-testid` | `data`, `testid` | **90**, 8 |
| `onnxruntime-web` | `onnxruntime`, `web` | 3, 6 |
| `@impacts` | `impacts` | 2 |
| `useEffect` | `useeffect` | 15 |

The mechanism is **not** "the token is lost" — it is **"the token is replaced by its most common
fragment."** `tsc -b` becomes a 22-document term plus a **34-document single letter `b`**; the
query has one relevant atom and the `b` mass outranks it. `@/features` collapses to the bare word
`features`, present in 49 atoms, while the literal string `@/features` occurs in only 3
(`grep -rlo '@/features' gnosis/atoms | wc -l` → 3). The two total misses are precisely the two
queries whose *whole* form is rare and whose *fragments* are common. Where a fragment happens to
stay rare (`onnxruntime` df=3, `impacts` df=2, `testid` df=8) recall is already 1.000 — that is why
7 of 9 survive.

**Ownership split (decision-relevant).** `src/bench.ts` `askPort` passes the golden query string
**verbatim** to `port.retrieve` — `buildQuery` is never invoked by the benchmark. So in this
harness `tokenize()` is exercised by the linear-scan adapter only. The FTS5 adapter splits on
whitespace and hands quoted phrases to SQLite, whose `unicode61` tokenizer performs the *same*
destruction under a *different owner*:

```bash
node -e "const D=require('better-sqlite3');const db=new D(':memory:');
db.exec(\"CREATE VIRTUAL TABLE t USING fts5(body, detail=full)\");
db.prepare('INSERT INTO t(body) VALUES (?)').run('run tsc -b then check data-testid and RUNNER_EVAL_CAPTURE in @/features');
db.exec(\"CREATE VIRTUAL TABLE v USING fts5vocab(t, row)\");
console.log(db.prepare('SELECT term FROM v').all().map(r=>r.term).join(' '))"
# → and b capture check data eval features in run runner testid then tsc
```

`RUNNER_EVAL_CAPTURE` is indexed as `runner eval capture`; `data-testid` as `data testid`;
`@/features` as `features`. **A change to `src/query.ts` cannot move the fts5 column at all** — that
would require the FTS5 `tokenize=` option (e.g. `unicode61 tokenchars '-_./@:'`), a separate change
to `src/adapters/fts5Adapter.ts`'s `CREATE_FTS_SQL` and a full index rebuild.

## 3. Candidate tokenizers, measured

Five variants were scored over all 50 golden queries with a BM25 scorer that reproduces
`linearScanAdapter`'s formula exactly (k1=1.2, b=0.75, smoothing 0.5, `score DESC, id ASC`). The
reimplementation is **validated**: with the baseline tokenizer it reproduces the persisted
linear-scan sidecar numbers to 4 decimals on every axis (0.6717/0.8183 overall; 1.0000, 0.6111,
0.8333, 0.6222, 0.1944, 0.7222, 0.5250 by axis). The variants:

- **v1 keep-tech-trimmed** — keep `_ - + # : / . @` *inside* tokens, trim them off the edges.
- **v1b keep-tech-raw** — same, no edge trimming (`@/features`, `--flag`, `globIgnores:` stay whole).
- **v2 both-forms** — emit the v0 fragments **and** the whole untrimmed technical token.
- **v3 underscore-hyphen-both** — fragments plus whole token, but only `_` and `-` held inside.
- **v4 both-forms-trimmed** — fragments plus whole *edge-trimmed* technical token.

recall@5 / MRR, linear-scan BM25, seed corpus, 50 queries:

| variant | overall | exact-kw | inflected | phrase | **technical** | synonym | domain | long-form | vocab terms |
|---|---|---|---|---|---|---|---|---|---|
| **v0 baseline** | 0.6717/0.8183 | 1.0000 | 0.6111 | 0.8333 | **0.6222** | 0.1944 | 0.7222 | 0.5250 | 5663 |
| v1 keep-tech-trimmed | 0.6148/0.7523 | 0.8889 | 0.4444 | 0.7500 | 0.7611 | 0.1111 | 0.5556 | 0.5375 | 7879 |
| v1b keep-tech-raw | 0.5790/0.7040 | 0.6944 | 0.3889 | 0.7500 | **0.8167** | 0.1111 | 0.5000 | 0.5583 | 9443 |
| **v2 both-forms** | **0.7058/0.8297** | 1.0000 | 0.6111 | 0.8021 | **0.8167** | 0.2500 | 0.7222 | 0.5042 | 10036 |
| v3 underscore-hyphen-both | 0.6917/0.8123 | 1.0000 | 0.5556 | 0.8333 | 0.7333 | 0.2500 | 0.7222 | 0.5250 | 7371 |
| v4 both-forms-trimmed | 0.6958/0.8123 | 1.0000 | 0.6111 | 0.8333 | 0.7333 | 0.2500 | 0.7222 | 0.5042 | 8299 |

Trade-offs, as measured rather than as predicted:

| option | buys | costs |
|---|---|---|
| **v1 / v1b (replace fragments)** | technical 0.62 → 0.76 / 0.82 | **destroys `exact-keyword`** (1.0000 → 0.8889 / 0.6944): `globIgnores`, `passWithNoTests`, `guardRejections` appear in prose as `` `globIgnores:` `` or `vite.config.ts`-adjacent, so the whole-token form no longer equals the query token. Also −0.17/−0.22 on `inflected-form` and −0.17/−0.22 on `domain-filtered`. **Net −0.06 / −0.09 overall.** Rejected outright |
| **v2 (both forms, untrimmed)** | technical 0.62 → **0.8167**; the only variant that fixes `tsc -b` outright (0.000 → 1.000); synonym 0.1944 → 0.2500; `exact-keyword`, `inflected-form`, `domain-filtered` all **unchanged** | vocabulary **+77 %** (5663 → 10036 terms), postings +19 % (66 524 → 79 132) → IDF of every fragment shifts, and every persisted index/report is re-ranked. Regressions: `multi-word-phrase` −0.031 (q-021), `long-form` −0.021 (q-047) |
| **v3 (`_` and `-` only, both forms)** | technical 0.62 → 0.7333, cheapest vocabulary cost (+30 %) | does not fix either total miss (`tsc -b`, `@/features` both still 0.000); costs `inflected-form` −0.056 |
| **v4 (both forms, trimmed)** | technical 0.62 → 0.7333, vocabulary +47 %, no axis regression except long-form −0.021 | trimming turns `-b` back into `b`, so `tsc -b` stays 0.000 — the headline defect survives |
| **do nothing** | zero re-ranking, prior report stays comparable | 2 of 50 queries keep returning nothing |

**No variant fixes q-025 `@/features` (2 relevant atoms).** The literal appears 3 times in the whole
corpus, always as a *longer* string (`@/features/`, `@/features/*/`, `@/features/*/stores/`), so no
whole-token rule makes query and document agree; that needs path-segment emission, which was not in
the option set and would inflate the vocabulary further.

## 4. Does the gain clear the pre-registered bar?

The golden set froze this statement before any adapter was measured
(`minimumMeaningfulDifference.statement`):

> Recall is averaged over 50 queries, so one query flipping moves mean recall by at most 1/50 = 0.02
> … a gap of 2 queries (4 pts) is suggestive but not a result; only a gap of 3 or more queries
> (>=6 pts) is interpretable as a real difference.

The best variant, **v2, gains +0.0341 overall = 1.71 queries-equivalent** (`+1.000` q-024, `+0.500`
q-031, `+0.333` q-037, `+0.250` q-028, `−0.250` q-021, `−0.125` q-047 — 6 queries changed out of 50).
That is **below the pre-registered ≥3-query / ≥0.06 interpretability threshold**, and only slightly
above the 2-query "suggestive but not a result" line. On the `rare-technical-token` axis alone the
gain is +0.1944, which is 1.75 flips out of that axis's 9 queries — again under 3.

Retro-fitting a lower threshold now, having seen the result, is exactly what pre-registration exists
to prevent.

## 5. Recommendation — **no change to `tokenize()`**

**Confidence: medium-high.** Basis:

1. The defect is **real and diagnosed** (§2): two queries return nothing because a rare whole token
   is replaced by its common fragments. This is not speculation — the df values are measured.
2. The best available remedy (**v2 both-forms**) buys **1.71 queries out of 50**, under the frozen
   interpretability floor of 3. Under the golden set's own pre-registered rule this is not a result.
3. The cost is disproportionate to a sub-threshold gain: +77 % vocabulary, an IDF shift across every
   term, and a **new measurement epoch** that voids comparison against
   `docs/test/2026-08-08-2142-dp-gnosis-retrieval-bench.md` — for a change that also cannot move the
   fts5 column at all (§2), so it would leave the two adapters tokenizing differently in the report
   while both still score 0.000 on `tsc -b` in the *fts5* row.
4. The largest quality gap in the corpus is **`synonym` at 0.1944**, three times the technical gap
   and untouchable by any tokenizer. Spending the epoch reset on tokenization spends it on the
   smaller problem.

**If a later change does re-open this**, the evidence says: adopt **v2 (both forms, untrimmed whole
technical token)** — it is the only variant with no regression on `exact-keyword`, `inflected-form`
or `domain-filtered`, and the only one that fixes a total miss. Bundle it in the SAME change as the
FTS5 `tokenize=` option so both adapters move together, re-run the full bench, and state explicitly
that the 2026-08-08-2142 report is superseded. Batching them costs one epoch reset instead of two.

## What was not done

- The golden set was not read for authoring, edited, or regenerated; its sha256 is unchanged.
- No adapter ranking logic was touched. No source file under `tools/dp-gnosis/` was modified.
- The throwaway measurement script was deleted; every number above is reproducible from the two
  inline commands plus the variant definitions in §3.
