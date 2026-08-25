<!-- LLM-PRIMARY: Repository entry point. This is the DEVELOPMENT workspace for the gnosis retrieval engine and its benchmark, extracted from AiChatney on 2026-08-24. Read handbook/GNOSIS-GUIDE.md before any engine or benchmark work. There is NO corpus in this repository: a fresh clone searches nothing, and that is exit 0 by design. The end-user product README does not exist yet. -->

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

`packages/gnosis/src/` sits three levels below the repository root, which is what `paths.ts:repoRoot()` resolves against. That was true of the old `tools/dp-gnosis/src/` too, which is why the flatten of 2026-08-25 was semantically inert and its `.trec` byte-identity gate held across all four smoke datasets.

| Path | Role |
|---|---|
| `packages/gnosis/` | the engine and its CLI |
| `packages/gnosis-bench/` | the benchmark — the gate for every engine change |
| `benchmark-data/` | runtime root: the vault, the atom caches, the built indexes. Gitignored |
| `handbook/` | governance — the six `GNOSIS-*.md`. They travel with the code they govern |

## Quickstart — there is no corpus in this repository

**A fresh clone has nothing to search.** `benchmark-data/vault/atoms/` is gitignored, and the documents the measured vault was built from live in the private repository this was extracted from. Only `corpus-manifest.json` is tracked, as the digest anchor for the vault the baselines were measured against.

That matters because of how the engine treats an empty corpus: **a genuinely empty atoms directory is not an error.** `index` and `answer` both exit 0 and hand back an empty knowledge pack, deliberately — an empty index over an empty corpus is the correct answer, and the `index-empty` refusal (exit 3) is reserved for the real defect, where markdown files *are* present and none of them reached the index. So on a fresh clone you get silence, not a complaint.

Point it at your own markdown instead:

```bash
npm install

# 1. Chunk your documents into atoms. DP_GNOSIS_CORPUS_ROOTS names the trees to walk.
DP_GNOSIS_CORPUS_ROOTS=docs,handbook \
  npm run gnosis -- ingest --atoms-dir /tmp/my-atoms

# 2. Build the index. NEVER skip this — see below.
npm run gnosis -- index --adapter fts5 \
  --atoms-dir /tmp/my-atoms --index-path /tmp/my-atoms.db

# 3. Ask.
npm run gnosis -- answer "some keywords" --adapter fts5 \
  --atoms-dir /tmp/my-atoms --index-path /tmp/my-atoms.db
```

Those exact commands, run against this repository's own `docs/` and `handbook/`, produce 3141 atoms and answer queries over them.

Query with **keywords, not a question** — it is the largest measured lever on retrieval quality here.

## Benchmark corpora fetch themselves

The benchmark's datasets are public and are downloaded on demand from the URLs declared in `packages/gnosis-bench/datasets.json` — BEIR (nfcorpus, scifact, arguana, …) and Hungarian [SzegedAI/MILQA](https://huggingface.co/datasets/SzegedAI/MILQA), CC-BY-SA-4.0. No corpus is republished by this project.

```bash
npm run gnosis:bench -- --layer smoke   # fetches what it needs, then measures
```

The `vault` and `vault-hu` datasets in that run are derived from the private vault and will be skipped without it.

## Commands

```bash
npm install                      # one lockfile, npm workspaces — installs both packages

npm run gnosis -- answer "some keywords"   # query the vault
npm run gnosis -- ingest && npm run gnosis -- index --adapter fts5   # rebuild after editing documents

npm run typecheck                # both packages
npm run lint
npm run gnosis:test              # engine suite
npm run bench:test               # benchmark suite
npm test                         # the two suites, sequentially
npm run gnosis:bench -- --layer smoke      # the pinned smoke gate
```

**Run the two suites SEQUENTIALLY.** Run concurrently they have produced a false red once already (`handbook/GNOSIS-GUIDE.md` § Landmines).

**`ingest` and `index` are one operation in two commands**, and the second half is the half that gets forgotten. An `ingest` alone leaves the index carrying the old digest, and the next query refuses with exit 3 — correctly, and silently as far as any test suite is concerned.

## Two things that will bite

**The runtime state is not in git.** The vault atoms, the built indexes, the fetched BEIR corpora and `packages/gnosis-bench/results/` are all gitignored. `results/` holds the recorded `.trec` evidence that the byte-identity gates compare against — it is untracked but MUST NOT be deleted.

**`gitSha` changed meaning on 2026-08-24.** Every benchmark row is stamped with this repository's sha. Rows recorded before the extraction name commits that do not exist here. `handbook/GNOSIS-GUIDE.md` § Current measured state carries the boundary and the mapping.
