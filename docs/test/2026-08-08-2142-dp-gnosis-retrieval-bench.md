<!-- LLM-PRIMARY: Open this retrieval benchmark when choosing between linear-scan and fts5 adapters, noting that results depend on whether you use cold-per-query or warm-shared-index regimes and that only differences of 6+ percentage points are significant. -->

# dp-gnosis retrieval benchmark

> **No winner is picked here.** This harness reports numbers; the choice of adapter
> is a human judgement made from them, and it depends on which regime the caller runs in.

> **Two regimes, never one headline number.** `cold-per-query` opens the index for every
> query; `warm-shared-index` loads it once and then queries it, and also reports the cost of
> serving an already-cached answer. Regime (b) largely neutralizes the main handicap of a
> load-heavy adapter, so **which regime you measure can change which adapter wins.** The two
> MUST NOT be merged or averaged.

## Provenance

- generated at: `2026-08-08T21:42:27.923Z`
- golden set: `/home/dev/work/dippe/AiChatney/.claude/worktrees/050-dp-gnosis/tools/dp-gnosis/golden/golden-set.v1.json`
- golden set sha256: `b03fec2f403b10fda60eafbf8d23ff37caa3d0a20e994e0be990cdc1c71d7910`
- golden set frozen at: `2026-08-08`, 50 queries
- k: 5

## Pre-registered minimum meaningful difference

- queries: 50
- recall resolution: 0.02
- Recall is averaged over 50 queries, so one query flipping moves mean recall by at most 1/50 = 0.02 (2 percentage points). A gap of 1 query (2 pts) between two adapters is indistinguishable from a single judgement call and MUST be read as noise; a gap of 2 queries (4 pts) is suggestive but not a result; only a gap of 3 or more queries (>=6 pts) is interpretable as a real difference. Any claim that adapter A beats adapter B MUST quote the query-count delta, not only the percentage.

## Adapters measured

- linear-scan
- fts5

## Skipped adapters

None — every declared adapter ran.

## Corpora

| corpus | atoms | recall/MRR scored |
|---|---|---|
| seed | 702 | yes |
| synthetic-1000 | 1000 | no — synthetic, latency/size ceiling only |
| synthetic-10000 | 10000 | no — synthetic, latency/size ceiling only |

## Measurement methodology

- warmup passes (discarded): 2
- measured passes: 5; one pass runs every golden query once
- p50/p95 are nearest-rank percentiles over EVERY measured call, not over pass averages
- peak heap is `process.memoryUsage().heapUsed` sampled immediately after each measured call
  — a peak over discrete samples, not a continuous profile, and not GC-controlled
- cold start is one open + first query IN PROCESS: module load and V8 warmup are already
  paid, so it bounds the index-load component from below, not whole-process startup
- the warm regime reuses the PORT. An adapter that reopens its index inside `retrieve`
  rather than at open time shows no gap between the two regimes — read equal p50s as a
  statement about that adapter, not as evidence that the regime distinction does not matter

## Quality (recall@5, MRR)

| adapter | corpus | recall@k | MRR | scored queries | unscorable queries |
|---|---|---|---|---|---|
| linear-scan | seed | 0.6717 | 0.8183 | 50 | 0 |
| fts5 | seed | 0.6237 | 0.7700 | 50 | 0 |

## Cost

| adapter | corpus | cold start ms | index build ms | index KiB | single-atom update ms |
|---|---|---|---|---|---|
| linear-scan | seed | 105.133 | 0.017 | 0.0 | 0.020 |
| linear-scan | synthetic-1000 | 53.811 | 0.004 | 0.0 | 0.008 |
| linear-scan | synthetic-10000 | 454.971 | 0.004 | 0.0 | 0.004 |
| fts5 | seed | 15.063 | 145.867 | 356.0 | 47.550 |
| fts5 | synthetic-1000 | 14.667 | 83.918 | 196.0 | 44.170 |
| fts5 | synthetic-10000 | 146.803 | 290.656 | 1628.0 | 294.528 |

## Latency by regime (reported side by side — never merged)

- `cold-per-query` — a port is opened (index loaded) for every single query — models a short-lived process
- `warm-shared-index` — index loaded once, then every query runs against it — models a longer-lived caller

| regime | adapter | corpus | p50 ms | p95 ms | samples | peak heap KiB | cache hit p50 ms |
|---|---|---|---|---|---|---|---|
| cold-per-query | linear-scan | seed | 52.616 | 63.765 | 250 | 75664.9 | n/a |
| warm-shared-index | linear-scan | seed | 52.208 | 60.544 | 250 | 76072.6 | 0.001 |
| cold-per-query | linear-scan | synthetic-1000 | 44.003 | 53.517 | 250 | 75257.2 | n/a |
| warm-shared-index | linear-scan | synthetic-1000 | 44.162 | 52.935 | 250 | 75612.3 | 0.001 |
| cold-per-query | linear-scan | synthetic-10000 | 516.760 | 662.315 | 250 | 325699.4 | n/a |
| warm-shared-index | linear-scan | synthetic-10000 | 471.423 | 520.717 | 250 | 325486.8 | 0.000 |
| cold-per-query | fts5 | seed | 13.544 | 36.446 | 250 | 166143.3 | n/a |
| warm-shared-index | fts5 | seed | 13.014 | 36.222 | 250 | 166237.7 | 0.000 |
| cold-per-query | fts5 | synthetic-1000 | 14.132 | 30.834 | 250 | 169949.5 | n/a |
| warm-shared-index | fts5 | synthetic-1000 | 13.898 | 30.341 | 250 | 170197.5 | 0.000 |
| cold-per-query | fts5 | synthetic-10000 | 148.880 | 310.857 | 250 | 380034.8 | n/a |
| warm-shared-index | fts5 | synthetic-10000 | 147.184 | 312.631 | 250 | 157367.6 | 0.000 |
