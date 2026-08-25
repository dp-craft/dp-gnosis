# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Measured retrieval-quality numbers are **not** recorded here. They live in `handbook/GNOSIS-BASELINES.md`, where each row carries its corpus, serving config and sha — the three things that make a quality number a fact rather than a recollection.

## [Unreleased]

### Changed

- Flattened `tools/dp-gnosis/` and `tools/dp-gnosis-bench/` into `packages/gnosis/` and `packages/gnosis-bench/`. The AiChatney-mirroring layout is gone. `packages/gnosis/src/` sits three levels below the repo root exactly as the old path did, so `paths.ts:repoRoot()` and the profile JSONs' `../../../` anchors resolve unchanged.
- Adopted npm workspaces with a single root lockfile, replacing three separate installs. Resolved versions of `better-sqlite3` (the FTS5 tokenizer) and `stemmer` (applied via `processTerm` to every adapter) were captured before and after hoisting and are unchanged, so ranking cannot have moved.
- Renamed the runtime data root `dp-gnosis/` to `benchmark-data/`.
- Moved the benchmark suite from colocated `src/*.test.ts` into `tests/`, matching the engine's convention. Same 30 files, same 773 tests.
- Collected the six `GNOSIS-*.md` governance files into `handbook/`, filenames unchanged so their mutual references keep resolving.
- The benchmark's `tsconfig.json` now includes `tests/` and `scripts/`, and `npm run typecheck` runs it. Neither had ever been typechecked by any script.

### Added

- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, this changelog, `.editorconfig`, `.nvmrc`.
- `license: GPL-3.0-or-later` in all three manifests. They previously declared none, so npm reported UNLICENSED for a GPL project.
- GitHub Actions CI running typecheck, lint, and the two suites — sequentially, in that order.

### Fixed

- `npm run lint` exits 0. It failed at 59 errors before.
- `packages/gnosis-bench/scripts/crossPair.ts` and `materialize-beir.ts` imported with `.ts` specifiers (TS5097), against the `.js` convention used everywhere else. Invisible until `scripts/` was typechecked for the first time.

### Removed

- `src/p70-measure.ts`, `src/p70-perk-timing.ts`, `src/p75-measure.ts` (982 lines). One-off campaign artefacts with no CLI, library or MCP entry point, which `files: ["dist"]` had been publishing to npm. Recoverable from history.

## [0.1.0] — 2026-08-24

### Added

- Extracted the engine and its benchmark from AiChatney into a standalone repository, so the quality gate lives beside the code it gates. The directory shape deliberately mirrored the source repository so `REPO_ROOT` still resolved and the extraction needed no code change — which is what made its byte-identity gate meaningful.
- `@dp/gnosis` published surface: `exports` map, `bin`, `files`, and the `./mcp` subpath carrying the MCP argv contract.

### Changed

- **`gitSha` changed meaning on this date.** Every benchmark row is stamped with this repository's sha; rows recorded before the extraction name commits that do not exist here. `handbook/GNOSIS-GUIDE.md` § Current measured state carries the boundary and the mapping.

---

Development history before the extraction — the atom format, chunker, query builder, adapters, the frozen golden set, rerank, PRF, the dense leg, and the measurement campaigns — begins 2026-08-08 in the AiChatney repository and is summarized in `handbook/GNOSIS-HISTORY.md`.
