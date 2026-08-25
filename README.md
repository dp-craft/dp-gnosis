<!-- LLM-PRIMARY: Repository entry point. This is the DEVELOPMENT workspace for the gnosis retrieval engine and its benchmark, extracted from AiChatney on 2026-08-24. Read handbook/GNOSIS-GUIDE.md before any engine or benchmark work. The end-user product README does not exist yet — it lands in phase 7. -->

# dp-gnosis

Development workspace for **gnosis**, a lexical retrieval engine over a vault of markdown *atoms*, and for the benchmark that gates every change to it.

**Not yet an installable product.** Turning it into one is the job of `docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md`, which owns the phase plan and its gates. Phases 0 and 1 are done.

## Read this first

`handbook/GNOSIS-GUIDE.md` is the entry point for **all** work here — architecture, the open landmines, the served path, and what is settled. MUST NOT open engine source, launch a benchmark, or hand-roll a test command before routing through it.

| I want to… | Go to |
|---|---|
| Understand the pipeline, or place a change | `handbook/GNOSIS-GUIDE.md`, then `handbook/GNOSIS-DATA-FLOW.md` |
| Run or read a benchmark | `handbook/GNOSIS-BENCH.md` |
| See where quality stands | `handbook/GNOSIS-BASELINES.md` — a snapshot, never a gate |
| Know what has been ruled out | `handbook/GNOSIS-GUIDE.md` § Settled |
| Use the CLI, author an atom | `packages/gnosis/README.md` |
| Ship the product | `docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md` |

## Layout

The directory shape deliberately **mirrors the repository this was extracted from**, so `REPO_ROOT` still resolves and the extraction needed no code change — which is what made its byte-identity gate meaningful. Flattening it is phase 2's job, gated separately.

| Path | Role |
|---|---|
| `packages/gnosis/` | the engine and its CLI |
| `packages/gnosis-bench/` | the benchmark — the gate for every engine change |
| `benchmark-data/` | runtime root: the vault, the atom caches, the built indexes. Gitignored |
| `handbook/` | governance — the six `GNOSIS-*.md`. They travel with the code they govern |

## Commands

```bash
npm install                      # one lockfile, npm workspaces — installs both packages

npm run gnosis -- answer "some keywords"   # query the vault
npm run gnosis -- ingest && npm run gnosis -- index --adapter fts5   # rebuild after editing documents

npm run gnosis:test              # engine suite
npm run bench:test               # benchmark suite
npm run gnosis:bench -- --layer smoke      # the pinned smoke gate
```

**Run the two suites SEQUENTIALLY.** Run concurrently they have produced a false red once already (`handbook/GNOSIS-GUIDE.md` § Landmines).

**`ingest` and `index` are one operation in two commands**, and the second half is the half that gets forgotten. An `ingest` alone leaves the index carrying the old digest, and the next query refuses with exit 3 — correctly, and silently as far as any test suite is concerned.

## Two things that will bite

**The runtime state is not in git.** The vault atoms, the built indexes, the fetched BEIR corpora and `packages/gnosis-bench/results/` are all gitignored. `results/` holds the recorded `.trec` evidence that the byte-identity gates compare against — it is untracked but MUST NOT be deleted.

**`gitSha` changed meaning on 2026-08-24.** Every benchmark row is stamped with this repository's sha. Rows recorded before the extraction name commits that do not exist here. `handbook/GNOSIS-GUIDE.md` § Current measured state carries the boundary and the mapping.
