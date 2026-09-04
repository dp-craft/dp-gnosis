<!-- LLM-PRIMARY: Open this retrieval benchmark report to compare adapter performance across cold and warm regimes, noting that results require human judgment and regime-specific analysis rather than a single winner. -->

# dp-gnosis retrieval benchmark

> **No winner is picked here.** This harness reports numbers; the choice of adapter
> is a human judgement made from them, and it depends on which regime the caller runs in.

> **Two regimes, never one headline number.** `cold-per-query` opens the index for every
> query; `warm-shared-index` loads it once and then queries it, and also reports the cost of
> serving an already-cached answer. Regime (b) largely neutralizes the main handicap of a
> load-heavy adapter, so **which regime you measure can change which adapter wins.** The two
> MUST NOT be merged or averaged.

## Provenance

- generated at: `2026-08-09T09:29:49.594Z`
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
- minisearch
- lancedb

## Skipped adapters

None — every declared adapter ran.

## Corpora

| corpus | atoms | recall/MRR scored |
|---|---|---|
| seed | 13846 | yes |
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
| linear-scan | seed | 0.3882 | 0.5717 | 50 | 0 |
| fts5 | seed | 0.3905 | 0.4980 | 50 | 0 |
| minisearch | seed | 0.3848 | 0.5207 | 50 | 0 |
| lancedb | seed | 0.3598 | 0.4800 | 50 | 0 |

## Cost

| adapter | corpus | cold start ms | index build ms | index KiB | single-atom update ms |
|---|---|---|---|---|---|
| linear-scan | seed | 2047.874 | 0.019 | 0.0 | 0.017 |
| linear-scan | synthetic-1000 | 68.732 | 0.019 | 0.0 | 0.477 |
| linear-scan | synthetic-10000 | 738.765 | 0.005 | 0.0 | 0.005 |
| fts5 | seed | 253.800 | 1813.342 | 6912.0 | 1804.471 |
| fts5 | synthetic-1000 | 14.530 | 77.285 | 196.0 | 74.321 |
| fts5 | synthetic-10000 | 146.847 | 582.319 | 1628.0 | 584.552 |
| minisearch | seed | 497.678 | 3014.194 | 11386.9 | 2986.146 |
| minisearch | synthetic-1000 | 17.505 | 74.490 | 286.6 | 67.528 |
| minisearch | synthetic-10000 | 205.099 | 701.840 | 3153.4 | 702.886 |
| lancedb | seed | 248.391 | 2004.732 | 11676.7 | 1984.356 |
| lancedb | synthetic-1000 | 16.840 | 79.204 | 124.7 | 76.616 |
| lancedb | synthetic-10000 | 152.794 | 713.271 | 878.4 | 693.810 |

## Latency by regime (reported side by side — never merged)

- `cold-per-query` — a port is opened (index loaded) for every single query — models a short-lived process
- `warm-shared-index` — index loaded once, then every query runs against it — models a longer-lived caller

| regime | adapter | corpus | p50 ms | p95 ms | samples | peak heap KiB | cache hit p50 ms |
|---|---|---|---|---|---|---|---|
| cold-per-query | linear-scan | seed | 2052.513 | 2239.043 | 250 | 604713.0 | n/a |
| warm-shared-index | linear-scan | seed | 2029.275 | 2161.331 | 250 | 788505.1 | 0.000 |
| cold-per-query | linear-scan | synthetic-1000 | 71.489 | 77.144 | 250 | 268342.3 | n/a |
| warm-shared-index | linear-scan | synthetic-1000 | 71.733 | 77.291 | 250 | 268597.4 | 0.000 |
| cold-per-query | linear-scan | synthetic-10000 | 765.768 | 839.761 | 250 | 391262.7 | n/a |
| warm-shared-index | linear-scan | synthetic-10000 | 758.695 | 828.503 | 250 | 390947.1 | 0.000 |
| cold-per-query | fts5 | seed | 294.955 | 755.945 | 250 | 296506.6 | n/a |
| warm-shared-index | fts5 | seed | 290.999 | 763.388 | 250 | 304510.4 | 0.000 |
| cold-per-query | fts5 | synthetic-1000 | 14.325 | 31.722 | 250 | 118729.3 | n/a |
| warm-shared-index | fts5 | synthetic-1000 | 13.942 | 31.094 | 250 | 119161.4 | 0.000 |
| cold-per-query | fts5 | synthetic-10000 | 151.145 | 324.018 | 250 | 310627.1 | n/a |
| warm-shared-index | fts5 | synthetic-10000 | 149.511 | 321.290 | 250 | 200606.7 | 0.000 |
| cold-per-query | minisearch | seed | 576.558 | 1014.382 | 250 | 659219.5 | n/a |
| warm-shared-index | minisearch | seed | 308.713 | 757.273 | 250 | 839633.8 | 0.000 |
| cold-per-query | minisearch | synthetic-1000 | 18.152 | 32.037 | 250 | 688613.9 | n/a |
| warm-shared-index | minisearch | synthetic-1000 | 14.447 | 28.273 | 250 | 743239.6 | 0.000 |
| cold-per-query | minisearch | synthetic-10000 | 193.013 | 339.693 | 250 | 278128.3 | n/a |
| warm-shared-index | minisearch | synthetic-10000 | 148.110 | 297.227 | 250 | 296572.1 | 0.000 |
| cold-per-query | lancedb | seed | 239.602 | 255.809 | 250 | 134685.4 | n/a |
| warm-shared-index | lancedb | seed | 236.728 | 246.688 | 250 | 81822.5 | 0.000 |
| cold-per-query | lancedb | synthetic-1000 | 16.852 | 19.161 | 250 | 86211.4 | n/a |
| warm-shared-index | lancedb | synthetic-1000 | 15.688 | 17.647 | 250 | 81083.4 | 0.000 |
| cold-per-query | lancedb | synthetic-10000 | 150.849 | 161.892 | 250 | 88413.4 | n/a |
| warm-shared-index | lancedb | synthetic-10000 | 149.533 | 152.249 | 250 | 92960.4 | 0.000 |
