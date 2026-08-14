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

Each run writes four artefacts under `results/`:

| File | For |
|---|---|
| `<stem>-<sha>.md` | one row per dataset, for a human |
| `<stem>-<sha>.json` | the same numbers, machine-readable |
| `per-topic/<stem>-<dataset>.tsv` | per-topic scores, so a paired significance test can run LATER without re-running the benchmark |
| `history.jsonl` | one append-only line per (run, dataset) — the progress table |

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
