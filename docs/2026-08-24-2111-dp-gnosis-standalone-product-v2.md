<!-- LLM-PRIMARY: OPEN plan (2026-08-24) — SUPERSEDES docs/plans/2026-08-22-1354-dp-gnosis-standalone-product.md. Turn packages/gnosis into `gnosis`, a standalone npm-installable product, IN A SEPARATE REPOSITORY at ../dp-gnosis. Three owner directives revise the v1 plan: (1) llama-swap STAYS as a parametrizable backend — local node-llama-cpp is ADDITIVE, not a replacement; (2) every phase re-verifies its premises against the tree before touching it — v1 drifted in 2 days; (3) extraction happens FIRST, not after phase 5. 9 phases. Read GNOSIS-GUIDE.md first. -->

# dp-gnosis → `gnosis` — the standalone product plan, v2

**Status: OPEN.** Supersedes `docs/plans/2026-08-22-1354-dp-gnosis-standalone-product.md` (v1), which remains readable for its pitfall analysis (§ 7) and its model-preset table — both carried forward here unchanged unless noted.

## What changed from v1, and why

Three owner directives (2026-08-24), each of which moves a load-bearing part of v1:

| # | Directive | What it overturns in v1 |
|---|---|---|
| 1 | **llama-swap stays, parametrizable** | v1 § 1 was titled *"replacing llama-swap"* and framed `httpProvider` as the legacy path. Wrong. The two backends are **peers**. |
| 2 | **Investigate the code before working on any part** | v1 asserted a code state that was already stale on the day it was written, and is more stale now. |
| 3 | **Extract to a standalone repo at `../dp-gnosis`** | v1 § 2 explicitly refused this — *"publish in place; do NOT extract before phase 5"*. |

Plus one hazard neither v1 nor the directives named, found by audit: **the benchmark's two headline corpora are untracked local state**, and **the bench stamps every result with the AiChatney git sha**. Both are extraction blockers. § Phase 1 handles them.

### Directive 1 — llama-swap is a peer backend, forever

`models.backend: llama-swap | local` is a supported, documented, first-class choice. Consequences that differ from v1:

- `httpProvider` is **not** a compatibility shim being kept alive out of politeness. It is the **currently measured path** — every recorded baseline in `GNOSIS-BASELINES.md` lives on it — and it stays the **default** until, and unless, phase 6's paired gate passes for `local`.
- `local` exists to serve the non-technical user who cannot administer a model server. It is **additive**.
- `RERANK_CALIBRATION` must be re-keyed per **backend** — `Record<'llama-swap' | 'local', Record<string, RerankCalibration>>` — precisely *because* both backends persist side by side. v1 reached the same conclusion from the assumption that `local` would take over; it is more urgent when both are live, because a single-keyed table silently applies one backend's measured scale to the other's raw scores.
- Documentation must present the choice as a **tradeoff**, not a migration: llama-swap = you already run a server, you get the measured champion; local = zero setup, models auto-downloaded, quality gated separately.

### Directive 2 — verified drift since v1 (2 days)

Audited at `33535caf`. v1 premises that **still hold**: `private: true`, no `bin`/`files`/`engines`, `noEmit: true`; `REPO_ROOT` in `paths.ts`; `expectVocabulary` still element-by-element over a 15-member `DECLARED_TYPES`; module-level `DEFAULT_INGEST_PROFILE = loadIngestProfile(...)` at import time; `CORPUS_ROOTS` still AiChatney-specific; `bench` verb and golden set still shipped; `ADAPTER_NAMES` still exactly the seven the guide names.

v1 premises that are **stale**:

| Drift | Detail |
|---|---|
| **`fts5` is no longer single-column** | `FTS_COLUMNS` = `body, short, long, doc_desc, keywords, entities, questions`, with BM25F weighting via `DEFAULT_FIELD_WEIGHTS` + `--field-weights`. `GNOSIS-GUIDE.md` still says *"single-column … column weighting is impossible without a schema change"* — **that guide row is now stale and must be corrected** (a third correction, alongside v1's two). |
| **An enrichment pipeline landed** (`1e987316`) | `src/enrich.ts`, `src/enrichment.ts`, `src/chat.ts`, `src/cli/enrichCommand.ts`, and a 6th CLI verb `enrich`. One model call per atom → JSONL sidecar. It is a **model-backed ingest-side hop**, so it belongs to the provider seam (phase 5) that v1 scoped to four clients. |
| **A provider abstraction already exists** | `src/chat.ts` exports `ChatProvider` + `createHttpChatProvider`, already shared by rephrase / synthesize / enrich. Only `rerank` and `embed` still carry private `Endpoint` structs. v1's `src/model/` work is **partly pre-built**; phase 5 extends `ChatProvider`, it does not invent it. |
| **`src/api.d.ts` exists** | A zero-dependency leaf consumer contract — `GnosisExitCode`, `GnosisRequest`, `GnosisSkippedAtom`, `GnosisAtom`, `GnosisAnswer` — guarded by `tests/apiContract.test.ts`. Its docblock states it is a leaf *so a consumer package can compile it under its own `rootDir`*. **That design anticipated this extraction.** |
| **MCP already ships** | `src/mcp/{main,protocol,server}.ts`, tool `gnosis_answer`, routed through `runCli` as one code path (asserted, not assumed). v1's "demote MCP to advanced" is a docs change only. |
| Other modules the guide never mentions | `summarySidecar.ts`, `cli/grouping.ts` (`--max-per-doc`), `cli/pack.ts` (`DENIED_MARKERS` / `neutralise`), `prf.ts`, `embedCache.ts`, `retrievability.ts`, `footnotes.ts`, `cli/explain.ts`, `cli/counting.ts`, `ABSTAIN_FLOOR`. A third profile ships (`web-research`). |

**Standing rule for every phase below: re-verify the phase's premises against the tree before the first edit, and record what moved.** No phase may cite this plan as evidence about code.

### Directive 3 — extraction, and how v1's objection is discharged

v1 refused extraction with a real argument: *"every phase is gated on a benchmark re-measurement, and the benchmark lives beside the vault the champions were measured on. Splitting the repo first would put the gate in a different repo from the change it gates."*

That objection is **discharged, not overruled**, by moving the gate with the code: the new repository carries **the engine, the benchmark, and all six `GNOSIS-*.md` governance files together**. What remains is the corpus problem, which is real and is the substance of phase 1.

## The extraction hazards — measured, not assumed

### H1. The corpora are untracked local state

| Asset | Path | Tracked? |
|---|---|---|
| `vault` atoms | `dp-gnosis/vault/atoms/` | **No** — only `corpus-manifest.json` is tracked |
| `vault-hu` atoms | `dp-gnosis/cache/atoms-hu/` | **No** — it is a *cache*, and the guide records that the repo ingest never writes it |
| `corpus-hu` sources | `dp-gnosis/corpus-hu/` | **No** |
| `scifact` | `docs/benchmarks/2026-08-14-external-suite/data/scifact` | **No** — and its absence makes the smoke gate exit **1**, not 4 |
| bench `data/` `results/` `work/` | `packages/gnosis-bench/` | **No** |
| golden sets | `packages/gnosis/golden/*.json` | **Yes** (10 files) |

A git-only move therefore produces a benchmark **with no corpora** — and, per the project's own recurring failure class, one that would report that as data rather than as an error. `vault-hu` is the worst case: it is reproducible from no repository at all and exists solely as a local cache directory. **Phase 1 copies these directories physically and verifies atom counts against `corpus-manifest.json` before anything else runs.**

### H2. Extraction is a PROVENANCE BOUNDARY

`run.ts:currentGitSha(SUITE_ROOT)` stamps every recorded result with the **AiChatney** git sha; `report.ts` persists it and `compare.ts` prints it. After extraction the sha names a different repository with a different history, so every pre-extraction row's `gitSha` becomes uninterpretable in the new repo's terms.

This is the same class as the documented corpus boundary, and it gets the same treatment: **recorded in `GNOSIS-GUIDE.md` as a boundary, with the mapping `<last AiChatney sha> → <extraction commit>`**, and a standing rule that a pre-boundary sha MUST NOT be read as a commit in the new repo.

### H3. Hoisted dependencies

Neither package is an npm workspace member; both have their own `package.json`, lockfile and `node_modules`. But `tsx`, `vitest`, `better-sqlite3` and `@types/better-sqlite3` currently resolve from the **root** `devDependencies`. `better-sqlite3` is already declared in `packages/gnosis/package.json`; **`tsx` and `vitest` are not** and must be added, or the extracted repo's own test command finds nothing.

### H4. In-flight campaign work

Active worktrees `gnosis-a`, `gnosis-c`, `gnosis-g`, `gnosis-i` sit on `050-gnosis-*` branches, plus `.claude/worktrees/050-dp-gnosis*`, `gnosis-wave2-safe`, `gnosis-wave4`. Extraction MUST NOT strand them. **Phase 1 is additive**: the new repo is created and verified while `packages/gnosis/` stays in place; removal from AiChatney is a separate, later step (phase 4), after the package consumption path is proven.

## The API surface — what must survive, exactly

The audit narrowed this considerably. **The runner does not touch dp-gnosis at all.** `tools/agentic-code-runner/` neither imports nor spawns it; it consumes the pack second-hand from the task-dag nav bundle (`taskSpec.ts` `TaskSpec.knowledge` → `navBlocks.ts`, which *wraps* the pack and never re-renders it). So the contract is three things:

| # | Surface | Owner |
|---|---|---|
| 1 | the `answer --json` wire shape | `src/api.d.ts` |
| 2 | the exit vocabulary `0 \| 2 \| 3` | `src/cli/outcome.ts` |
| 3 | the `GNOSIS-KNOWLEDGE-PACK` delimiters | `src/cli/pack.ts` |

And there is exactly **one** TypeScript importer in the whole repository:

- `tools/task-dag/src/nav/knowledge.ts` — `import type { GnosisAnswer, GnosisAtom } from '../../../gnosis/src/api.js'`
- `tools/task-dag/tests/nav-knowledge.test.ts` — `await import('../../gnosis/src/mcp/protocol.js')` for `answerArgv`

Everything else is a CLI shell-out: the root `gnosis*` scripts, the `dp-gnosis-search` skill (`npm run gnosis -- answer …`), and `runner.config.json`'s `knowledge.command` (currently `enabled: false`).

**Decision — one package, an `exports` map, a stable subpath.**

```jsonc
"exports": {
  ".":     { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./api": { "types": "./dist/api.d.ts" }          // types-only, zero runtime
}
```

`tools/task-dag` then imports `@dp/gnosis/api` instead of a relative path. AiChatney already carries `better-sqlite3`, so depending on the full package costs it nothing new. *Escape hatch if that ever changes:* split a types-only `@dp/gnosis-api` package — `api.d.ts` is already engineered as a hard leaf with a test enforcing it, so the split is mechanical.

**Decision — implement the programmatic entry that was designed and never built.** `GnosisRequest` exists in `api.d.ts` and has **zero usages**. Add:

```ts
export const search = (req: GnosisRequest): Promise<GnosisAnswer>
```

`runCli(argv)` stays as the **process** binding. `search()` and `runCli()` must share one code path — the MCP server already proves the pattern by reading the pack out of `runCli`'s own payload rather than re-rendering it, and `tests/mcpProtocol.test.ts` asserts the byte-identity. The same assertion shape covers `search()`.

**Zero-churn rule for AiChatney consumers:** keep the root npm script *names*. `npm run gnosis -- answer …` keeps working; only its right-hand side changes. The `dp-gnosis-search` skill then needs no edit at all.

## Phases

Phase order changes from v1: **extraction moves to the front** (directive 3), and the provider seam splits into `httpProvider` (phase 5) and `localProvider` (phase 6) exactly as v1 had it, but with llama-swap framed as a peer.

| # | Work | Exit criterion | Benchmark gate |
|---|---|---|---|
| **0** | Relax `expectVocabulary` to a **subset** of `DECLARED_TYPES`, order-independent, still refusing an unknown member and still **returning `declared`** (the full tuple — `ATOM_TYPES` is consumed as *"every valid label"*, so returning a subset would make `AtomType` lie). Correct the now-stale `fts5` single-column row in `GNOSIS-GUIDE.md` | `hu-tax.profile.json` loads as `DEFAULT_INGEST_PROFILE`; both suites green | No — behaviour-neutral on the shipped profile |
| **1** | **EXTRACT** to `../dp-gnosis` via `git subtree split` (history preserved; `git-filter-repo` is not installed). Carries engine + bench + all six `GNOSIS-*.md`. Physically copy the untracked corpora (H1) and verify atom counts against `corpus-manifest.json`. Add `tsx` + `vitest` as devDeps (H3). Own eslint + vitest configs. Record the **provenance boundary** (H2). **Additive — `packages/gnosis/` stays in AiChatney** (H4) | Both suites green *in the new repo*; `npm run gnosis:bench` runs there and produces the vault + vault-hu champion arms | **Yes — `.trec` byte-identity.** Same serving config, so identity is the valid criterion |
| **2** | Decouple from repo layout: `src/env.ts` (XDG + `~/Library` + `%APPDATA%`); delete `REPO_ROOT` / `GNOSIS_ROOT` / `DOCS_TEST_DIR`; split `config.ts` → constants + `src/vocabulary.ts` (profile-derived, resolved from the active topic, **not** eagerly at import); `CORPUS_ROOTS` default `['.']`; `sourceRoot` gets **no default** (absent ⇒ refuse, naming the topic — never `process.cwd()`); drop `p70`/`p75`/`bench` verb/golden set from the *shipped* surface (they stay in the bench package); per-domain index-empty diagnostic | `gnosis retrieve` runs under `HOME=$(mktemp -d)` from a directory with no repo above it; the bench still reproduces the champion arms | **Yes — `.trec` byte-identity** |
| **3** | YAML config + `loadTopicsConfig`; `--topic`; `gnosis topic add/list/show/rm/rename`; `update`; `status`; `migrate <profile.json>`; ingest **0-file refusal** (exit 3, reporting what *is* there). Reuse `parseIngestProfile` — do not replace it | A YAML topic and the equivalent `--profile` JSON produce **identical output** | Yes — `.trec` byte-identity |
| **4** | Packaging: drop `private`, add `bin` / `engines` / `files`, `tsconfig.build.json` with `tsc` emit (**not** a bundler — it would fight native resolution and break the lazy-optional-import gating), shebang; `init`, `doctor`, `cleanup`; `install.sh` / `install.ps1`; message catalog (EN filled). **Publish the API surface** (`exports` map + `search()`), re-point `tools/task-dag` to `@dp/gnosis/api`, re-point `runner.config.json`, rewrite the root `gnosis*` scripts as wrappers, rewrite `CLAUDE.md`'s routing row. **Then remove `packages/gnosis*` from AiChatney** | On a clean container: `npm i -g <tarball>` → `init` → `topic add` → `update` → `search` returns atoms, no repo present, **llama-swap backend**. AiChatney's `taskdag:test` and the `dp-gnosis-search` skill still pass unchanged | No ranking code moves — phases 1–3 arms are the regression check |
| **5** | `src/model/` seam, **`httpProvider` only**. Extend the existing `ChatProvider` rather than inventing one; fold `rerank` + `embed`'s private `Endpoint` structs and the **enrichment** hop into it. Re-key `RERANK_CALIBRATION` per backend | Suites green; a champion arm is **byte-identical** to phase 4's | **Yes, and identity IS the criterion** — a pure refactor that moves a byte is a defect |
| **6** | `localProvider` + node-llama-cpp (`optionalDependencies`, lazy import catching **all** errors) + `hf:` download/cache + the three presets + `--offline` + GPU detection + **the local calibration probe**. llama-swap remains the default | Local backend returns atoms; `RERANK_CALIBRATION.local` either measured or deliberately empty; the preset table's VRAM column **measured**, not estimated | **Yes, and identity is FORBIDDEN** — serving-config change. Paired permutation + bootstrap CI against the 2026-08-22 champions (`vault` 0.5871 / `vault-hu` 0.8021) at a **pre-registered** tolerance, plus BEIR Tier-1 par. **Only on pass may the default flip** |
| **7** | HU message catalog + HU config template; **English README** (install, converter recommendations); the `gnosis` skill; `gnosis mcp` subcommand; publish | `npm i -g @dp/gnosis && gnosis init && gnosis doctor` green on three OSes | No |
| **8** *(optional)* | `gnosis ui` — one static HTML + a small HTTP handler on `127.0.0.1` | A topic can be searched and reindexed from the UI | No |

### Carried forward from v1 unchanged

- **§ 7 end-user pitfalls** (19 rows, each a hard exit-coded check rather than a doc sentence) — still correct, still the right shape. Pitfall 9 ("my folder has 412 PDFs and I get 0 hits") moves from v1's phase 2 to phase 3 here; pitfall 12 moves to phase 2.
- **The three model presets** (`minimal` / `balanced` / `quality`) and the rule that the peak-VRAM column is an **estimate** until phase 6 measures it on the local backend.
- **The YAML config shape** and the rule that each topic block is handed **unchanged** to `parseIngestProfile`.
- **What the plan refuses:** flipping the default backend before phase 6's gate; shipping the `bench` verb or the golden set to end users; defaulting the reranker to 0.6b for speed; bundling the CLI; and above all assuming node-llama-cpp's `rank()` inherits the HTTP path's calibration — a guessed scale presented as a measurement poisons `--min-relevance` and the `ok` verdict in both directions.

## Verification

**The two suites, run SEQUENTIALLY** (concurrently they have produced a false red once already):

```bash
npm run gnosis:test                                                   # engine
npx vitest run --config vitest.tools.config.ts packages/gnosis-bench  # bench
```

After phase 1 these become the new repo's own `npm test` / `npm run bench:test`.

**Benchmark gates (phases 1, 2, 3, 5, 6):**

```bash
npm run gnosis:bench    # vault + vault-hu champion arm: fts5 + PRF + 4b + pool 100
```

- Phases 1, 2, 3, 5: `.trec` **byte-identity**, valid because the serving config does not move.
- Phase 6: identity is **forbidden**; paired permutation + bootstrap CI at a pre-registered tolerance.
- **Warm the reranker** with one direct `/v1/rerank` call before every arm — a cold load fails the whole arm — and keep arms back-to-back so the model cannot idle out.

**Extraction acceptance (phase 1), in order:**

1. `git subtree split` produces `../dp-gnosis` with the history of both paths.
2. Untracked corpora copied; `vault` and `vault-hu` atom counts match `corpus-manifest.json`.
3. `npm ci` in the new repo resolves without the root hoist.
4. Both suites green **in the new repo**.
5. Champion arms reproduce **byte-identically** against the AiChatney-recorded `.trec`.
6. Provenance boundary recorded in `GNOSIS-GUIDE.md`.
7. AiChatney is **untouched** and still green.

**Isolation test (phase 2):** `HOME=$(mktemp -d) node dist/cli/main.js retrieve …` from a directory with no repo above it. If it finds anything by walking upward, the decoupling is not done.

**Install smoke (phase 4, three OSes):** `npm pack` → `docker run --rm -it node:22` → `npm i -g /mnt/*.tgz` → `init` / `topic add` / `update` / `search` / `doctor`. A non-zero `doctor` exit is a failure.

**Consumer regression (phase 4):** AiChatney's `npm run taskdag:test` and one real `npm run gnosis -- answer` through the `dp-gnosis-search` skill must pass with **no edit to the skill**.
