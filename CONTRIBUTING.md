<!-- LLM-PRIMARY: How to build, test and gate a change to dp-gnosis. The two suites run SEQUENTIALLY; `ingest` and `index` are one operation in two commands; a retrieval-quality change is a MEASURED treatment gated by the benchmark. Read handbook/GNOSIS-GUIDE.md before any engine or benchmark work. -->

# Contributing

Thanks for looking at this. Before anything else: **read `handbook/GNOSIS-GUIDE.md`.** It is the entry point for the landmines, the served path, the adapter verdicts and what has already been ruled out (the pipeline itself is `handbook/GNOSIS-DATA-FLOW.md`). Most wasted effort here has been on questions that file already answers.

## Setup

```bash
npm install     # npm workspaces, one lockfile — installs both packages
```

Node **>= 22** (`.nvmrc` pins 22).

## The gates

```bash
npm run typecheck      # both packages
npm run lint           # must exit 0
npm run gnosis:test    # engine suite
npm run bench:test     # benchmark suite
```

`npm test` runs the two suites in sequence and is the shorthand.

A retrieval-quality change carries one more gate, the pinned smoke run:

```bash
npm run gnosis:bench -- --layer smoke
```

### Run the two suites sequentially

Run concurrently they have produced a false red once already — they share a work directory. `npm test` chains them with `&&` for exactly this reason. Do not "speed it up" by running them in parallel.

### Use the exact gate command

A green `npm test` is not evidence that a narrower command passes. Different collection means a different verdict. When you report a result, quote the command you ran beside it.

## Two things that will bite

**`ingest` and `index` are one operation in two commands**, and the second is the half that gets forgotten:

```bash
npm run gnosis -- ingest && npm run gnosis -- index --adapter fts5
```

**In THIS repository a bare `ingest` exits 2**: the shipped `CORPUS_ROOTS` default (`config.ts`) still names `doc/` and `RUNNER-*.md`, which came from the repository gnosis was extracted from and do not exist here. Name the roots you mean — `DP_GNOSIS_CORPUS_ROOTS=docs ...` — or point `--profile` at one that declares its own `corpusRoots`.

An `ingest` alone leaves the index carrying the previous digest, and the next query refuses with exit 3 — correctly, and silently as far as any test suite is concerned.

**The runtime state is not in git.** `benchmark-data/` (vault atoms, caches, corpora), the fetched BEIR corpora, and `packages/gnosis-bench/results/` are all gitignored. `results/` holds the recorded `.trec` evidence that the byte-identity gates compare against — it is untracked but **MUST NOT be deleted**.

## Exit codes carry meaning

The CLI is exit-coded and `3` commonly means *refused / state mismatch*, not *crashed*. `--help` on each command is authoritative.

- Exit 0 — success.
- Exit ≠ 0 — stop and read stderr. Do not silently retry.
- **A refusal is a correct outcome, not a failure to work around.** Suppressing one recreates the failure class this project exists to police.

Never pipe a command's stdout through `tail` / `head` / `grep` before reading it: that masks the exit code *and* truncates the failure context. Redirect to a file, then read the file.

## Changing retrieval quality is a measured treatment

A change to ranking, weights, PRF, fusion, field weights or the rerank pool is not a refactor. It **must** be gated by the benchmark, and the result must name its corpus, its serving config, and the sha it was measured at.

A quality number is a fact only with those three. Do not quote a baseline from memory, do not compare rows recorded under different serving configs, and do not present an estimate as a measurement. `handbook/GNOSIS-BENCH.md` has the protocol; `handbook/GNOSIS-BASELINES.md` is a snapshot, never a gate.

## The failure class this project polices

> A component produced nothing, and the pipeline recorded it as data.

Treat any all-zero metric row, any `p = 1.0000`, and any zero-width confidence interval as a defect until proven otherwise — never as a finding. The worst instance on record failed toward a *plausible* number rather than an obvious zero, which is why it survived a whole campaign. A number that looks reasonable is not evidence that the pipeline is sound.

## Pull requests

- One concern per PR. Every changed line should trace to the stated purpose.
- Match the surrounding style even where you would do it differently.
- If you notice unrelated dead code, mention it — do not delete it.
- `npm run typecheck`, `npm run lint` and both suites must pass. There are no commit hooks; running them is your job.
- If a step was skipped or a test fails, say so with the output. Do not report completion for work that is partly done.

## Layout

| Path | Role |
|---|---|
| `packages/gnosis/` | the engine, its CLI, its MCP server, its library entry |
| `packages/gnosis-bench/` | the benchmark — the gate for every engine change |
| `handbook/` | governance: the seven `GNOSIS-*.md`, which travel with the code they govern |
| `benchmark-data/` | runtime root: vault, atom caches, built indexes. Gitignored |
| `docs/` | plans, research, analysis, benchmark write-ups |

Files under `docs/` are named `YYYY-MM-DD-HHMM-<kebab-slug>.md` and live in a kind subdirectory (`plans/`, `brainstorm/`, `research/`, `analysis/`, `benchmarks/`).

**`packages/gnosis/src/` sits three levels below the repository root**, which is what `paths.ts:repoRoot()` resolves against. That was true of the old `tools/dp-gnosis/src/` too, which is why the flatten of 2026-08-25 was semantically inert and its `.trec` byte-identity gate held across all four smoke datasets. A move that changes that depth changes where every default path resolves.

## Licence

By contributing you agree your work is licensed under **GPL-3.0-or-later**, matching the repository.
