<!-- Cross-cutting production-readiness review of dp-gnosis: packaging, configuration, external-service coupling, exit codes, gate infrastructure, security, docs-as-product. Read-only analysis at commit 146bbb2, 2026-08-31. Per-module code review is owned by the sibling reviews in this directory. -->

# dp-gnosis — production-readiness review

**Scope.** Cross-cutting shippability only. Engine-core, CLI/MCP/wizard and bench-package code review are owned by sibling documents in this directory and are not repeated here.

**Method.** Read of the two `package.json` files, `env.ts`, `userConfig.ts`, `paths.ts`, `instance.ts`, `cli/locations.ts`, `cli/main.ts`, `mcp/server.ts`, `rerank.ts` (refusal path), both `vitest.config.ts`, `.github/workflows/ci.yml`, `eslint.config.mjs`, `.gitignore`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, the root `README.md` and `CONFIGURATION.md`; greps for hardcoded paths/hosts, `child_process`, `fetch`, `process.exit`; two delegated sweeps (exit-code contract end to end; doc set as a product). Two gates were executed: `npm run typecheck` (exit 0) and `npm run lint` (exit 0, 306 warnings). Neither test suite nor the benchmark was run — no measured retrieval number is asserted anywhere below.

Base commit: `146bbb2`.

---

## 1. Verdict by area

| # | Area | Verdict | One-line justification |
|---|---|---|---|
| 1 | Packaging & distribution | **adequate** | `files`/`exports`/`bin`/`engines`/`os` are all deliberate and commented; optional-dependency handling is exemplary; but the package is unpublished, untagged, and one shipped invariant (`DEMO_CORPUS_ROOTS` ⊆ `files`) is prose-only |
| 2 | Configuration system | **strong** | Layering is centralized in `env.ts` + `userConfig.ts` + `paths.ts`, every tier is a function not a constant, precedence is documented AND introspectable (`dataRootFact`, `locationOrigins`), and every malformed value refuses by name |
| 3 | External-service coupling | **strong** | Default path makes no network call; every remote hop is opt-in; refusals name address, cause, remedy and escape hatch. One unbounded-hang path on a non-loopback URL |
| 4 | Error handling & exit codes | **adequate** | The 0/2/3 vocabulary is real, tested (55 `toBe(2)` / 56 `toBe(3)` assertions) and consistently produced — but nothing catches an escaped throw, and on the MCP transport that kills the session |
| 5 | Test/gate infrastructure | **adequate** | Real CI matrix, sequential suites, `npm pack --dry-run` gate; weakened by a lint gate that cannot fail on 306 warnings and two stale references to a config file that does not exist |
| 6 | Security & robustness | **strong** | No credentials in code, no shell interpolation, sha256-verified model downloads, honest `SECURITY.md`; no dependency-audit automation |
| 7 | Docs-as-product | **adequate** | Root README is genuinely product-grade; `AUTHORING.md` and `CONFIGURATION.md` § 7.2 still document the author's private repo, and two docs contradict each other on the absent reranker |

---

## 2. Findings by severity

### HIGH

#### H-1 — An escaped throw kills the MCP session with no response

`packages/gnosis/src/mcp/server.ts:onLine` → `void emit(streams.output, line, run)`.

`emit` is `async` and its result is discarded with `void`, with no `.catch`. `handleLine` → `runAnswer` → `runCli`, and `runCli` catches only `isVocabularyError` and `isUserConfigError`. Any other throw — a corrupt SQLite index (`new Database(indexPath)` in `fts5Adapter`), an EACCES on the atoms directory, a JSON parse of a hand-edited artefact — rejects the discarded promise. Under Node 22's default `--unhandled-rejections=throw` that terminates the process; before it does, **no JSON-RPC response is ever written for that request id**.

Why it matters: `protocol.ts:parsedLine`'s own comment anticipates "a throw from the runner" and nothing catches it. No human reads an MCP session, so the client sees a hang or a dead server rather than a diagnosis. This is the project's stated failure class on the one surface with no human in the loop.

**Recommendation.** Wrap the `emit` body (or attach `.catch` at the `onLine` call site) and answer the originating id with a JSON-RPC error object carrying the thrown message. The id is already in scope in `handleLine`. Add one test that makes `run` reject and asserts a response line is still written.

#### H-2 — No top-level error boundary on the CLI; exit 1 is undocumented and unreachable by design

`packages/gnosis/src/cli/main.ts:main` — `await main()` at module top level, no `try`/`catch`; `process.exitCode = result.exitCode` is only reached on the non-throwing path.

The delegated sweep mapped every numeric code: `EXIT_OK`/`EXIT_USAGE`/`EXIT_PARTIAL` are produced in `cli/outcome.ts` and its callers, and **code 1 is produced nowhere in the source**. It is reachable only as an uncaught exception. `packages/gnosis/README.md` § Exit codes documents 0/2/3 and says "Callers MUST branch on the code"; a caller that branches on that table has no arm for 1, and what it gets instead is a raw stack trace naming a `dist/` path.

**Recommendation.** Catch at `main`, print the message (not the stack) on stderr, and set a documented code. Either add a `1 = unexpected internal error` row to the README table, or map it onto the existing vocabulary — the former is more honest. This is the same treatment `userConfig.ts` already gives its own refusals via `isUserConfigError`.

### MEDIUM

#### M-1 — The shipped `CORPUS_ROOTS` default is the author's previous repository

`packages/gnosis/src/config.ts:CORPUS_ROOTS = ['doc', 'docs', 'claude-artifacts', 'RUNNER-*.md']`.

`doc/`, `claude-artifacts/` and `RUNNER-*.md` are AiChatney's layout. `CONTRIBUTING.md` already concedes the consequence: *"In THIS repository a bare `ingest` exits 2: the shipped `CORPUS_ROOTS` default … came from the repository gnosis was extracted from and do not exist here."* A refusal is the correct behaviour, but the default that produces it is a leaked private-repo fact sitting in a shipped constant, and `claude-artifacts/` is gitignored so no reader can even see what it named.

**Recommendation.** Reduce the default to `['docs']`, or to the empty list with a refusal that names `init` / `--profile` / `DP_GNOSIS_CORPUS_ROOTS` as the three ways to state a scope. Either is a one-line change to a constant plus its test; the second is more in keeping with "a source under no prefix is refused, never guessed" (`instance.ts:PROFILE_EDITING_COMMENT`).

#### M-2 — `DEMO_CORPUS_ROOTS` ⊆ `package.json` `files` is enforced by prose only

`packages/gnosis/src/paths.ts:DEMO_CORPUS_ROOTS` states: *"which is why `package.json`'s `files` ships every one of them … A new sibling document MUST be added to BOTH lists or the demo corpus silently drops it."*

`packages/gnosis/tests/demoCommand.test.ts` enforces the **other** half of the invariant in both directions (roots ↔ `demo.profile.json` `domainRules`). Nothing asserts roots ↔ `files`. Grepping the engine tests for a read of the `files` field returns nothing. CI runs `npm pack --dry-run` but asserts nothing about the tarball's contents.

Consequence: a doc added to `DEMO_CORPUS_ROOTS` and forgotten in `files` makes `dp-gnosis demo` — explicitly "the command a stranger runs first" — ingest a subset in an install while passing every gate in the checkout. The `CHANGELOG.md` `[Unreleased]` entry for the README split shows the two lists were kept in sync by hand.

**Recommendation.** Extend `demoCommand.test.ts` with a third case reading `packages/gnosis/package.json` and asserting every `DEMO_CORPUS_ROOTS` entry appears in `files`. Roughly ten lines, same shape as the two cases already there.

#### M-3 — The lint gate cannot fail

`package.json:scripts.lint = "eslint ."`, run unconditionally in CI. Measured this session: **exit 0, 306 problems, 0 errors, 306 warnings**, distributed over 55 non-test files (30 in `packages/gnosis`, 25 in `packages/gnosis-bench`, 3 in tests). By rule: `no-magic-numbers` 154, `complexity` 46, `max-params` 38, `max-lines-per-function` 33, `explicit-function-return-type` 18, `no-restricted-syntax` 12.

The rules encode `claude-artifacts/principles/TYPESCRIPT.md` and the COMMON.md quality metrics, so these are the project's own declared standards, warning silently. `CONTRIBUTING.md` says `npm run lint` "must exit 0" — it always will.

**Recommendation.** Add `--max-warnings <N>` with `N` pinned at the current count, so the number can only go down. That converts a decorative gate into a ratchet without demanding a 306-warning cleanup.

#### M-4 — Two stale references to a vitest config that does not exist

`handbook/GNOSIS-GUIDE.md` § Landmines, row *"Wrong vitest config finds zero tests"*, prescribes: *"Bench: `npx vitest run --config vitest.tools.config.ts packages/gnosis-bench`"*. `packages/gnosis/vitest.config.ts`'s header comment says the suite is *"ALSO collected by `vitest.tools.config.ts` so `npm run test:tools` covers this package"*.

Verified: there is **no** `vitest.tools.config.ts` anywhere in the repository, and no `test:tools` script in either `package.json`. There is also no root vitest config at all, so the landmine's stated mechanism ("the root vitest config collects neither suite") no longer exists either — the hazard is now the plain `vitest` default resolution.

The remedy the landmine prescribes would fail with a missing-config error. Both remaining configs correctly anchor `root` on their own directory, which is the real fix for the underlying hazard.

**Recommendation.** Rewrite the landmine row to name the two commands that exist (`npm run gnosis:test`, `npm run bench:test`) and state the surviving hazard — a bare `vitest packages/...` prints "No test files found" and exits 0. Delete the `vitest.tools.config.ts` sentence from the engine config header. Per `GNOSIS-RULES.md`, a superseded claim is corrected in place.

#### M-5 — `AUTHORING.md` and `CONFIGURATION.md` § 7.2 document the author's machine

From the delegated doc sweep, verified quotations:

- `AUTHORING.md` gate tables are AiChatney layout (`RUNNER-*.md`, `doc/40-code-standards/90-decisions/`, `tools/agentic-code-runner/`); it prints `CORPUS_ROOTS` **by value** (which `CONFIGURATION.md`'s own header rule forbids); it asserts *"`docs/` holds 22 808 markdown files … `docs/tmp` 12 211"* — a count of a tree no reader has. Its named gate owners `SOURCE_ROOT_DOMAINS` / `SOURCE_ROOT_TYPES` no longer exist in `src/` (only a comment at `config.ts:543`).
- `CONFIGURATION.md` § 7.2, the headline worked setup, uses `"/home/dev/work/aichatney/doc"` with domain `"aichatney"` — the private repo gnosis was extracted from. § 1.3's `config.json` example likewise uses `/home/dev/vaults/work`.

These ship: both files are in `package.json` `files` and in `DEMO_CORPUS_ROOTS`, so `dp-gnosis demo` retrieves them.

**Recommendation.** Replace the worked examples with neutral paths (`~/notes`, `~/work/some-project/docs` — the ones the root README already uses), and rewrite `AUTHORING.md`'s gate tables against the `init`-written profile rather than a repository the reader does not have. Route `CORPUS_ROOTS` by name.

#### M-6 — Two docs contradict each other on the absent reranker

Root `README.md` § *Is `--rerank` worth it?*: *"If the server is absent the query is **refused**, not silently answered from the unreranked order."*
`packages/gnosis/README.md` § Exit codes: a refused `--rerank` returns the *"first-pass ranking … `mode` keeps NO `+rerank` suffix, refusal in `note`"*. `OPTIONAL.md` and `INTEGRATION.md` agree with the second.

The second is the implemented behaviour (`rerank.ts:catalogueRefusal` → a refusal string carried alongside a delivered first-pass ranking, exit 3). Both readings are defensible English for "exit 3 = partial", but the front page's word is *refused*, and a user who read only it will not expect results.

**Recommendation.** Restate the front-page sentence as the exit-3 contract: results are still returned, unreranked, with the refusal attached and exit 3. One doc owns this — make it `packages/gnosis/README.md` § Exit codes and have the front page route to it.

### LOW

#### L-1 — Unbounded hang on a non-loopback rerank URL

`packages/gnosis/src/rerank.ts:catalogueRefusal` is called on the serving path with `timeoutMs` undefined, so `catalogueInit` returns `{}` and the `fetch` carries no `AbortSignal`. The comment on `CATALOGUE_TIMEOUT_MS` states the reasoning deliberately: the 5 s ceiling is for `doctor` and `setup`, and *"The serving path passes none — a slow catalogue there is worth waiting for."*

That is right for a loopback llama-swap loading a model on demand (the guide records a 1 m 59 s cold load). It is wrong for a `DP_GNOSIS_RERANK_URL` pointing at a filtered host, where the connect never completes and `search --rerank` hangs with no output.

**Recommendation.** Keep the unbounded wait for a loopback host; apply a generous ceiling (a minute or more, above the recorded cold-load time) when the resolved host is not loopback. The loopback test already exists in `cli/wizard/backend.ts:LOOPBACK_HOST`.

#### L-2 — `REPO_ROOT` is `@deprecated` and still on the live path

`paths.ts` carries 17 module-level `@deprecated` path constants, each documented as *"resolved against `repoRoot()`, so it is NOT config- or install-aware"* and frozen at import. Two live call sites still read one: `cli/locations.ts:resolveLocations` (`repoRoot: pick(flag, profile.repoRoot, REPO_ROOT)`) and `ingest.ts` (`options.repoRoot ?? REPO_ROOT`).

The installed case is guarded — `locations.ts:undeclaredRepoRoot` returns true when installed with no flag and no profile key, and `cli.ts:198` refuses on it for every non-`ROOTLESS_COMMANDS` command. So the deprecated constant is only reached where it is correct. The finding is surface, not behaviour: 17 deprecated constants remain reachable from a published package, and none is in the `exports` map's public surface only by virtue of `index.ts` not re-exporting them.

**Recommendation.** No behaviour change. Before 1.0, delete the 15 unused constants and inline `repoRoot()` at the two remaining call sites — a deprecated symbol that survives a major release is a compatibility promise nobody meant to make.

#### L-3 — `os: ["linux","darwin"]` blocks an install the code supports

`packages/gnosis/package.json` sets `os: ["linux","darwin"]`, and the root README says *"Windows is not supported"*. Meanwhile `env.ts` carries a complete win32 branch (`WIN_VARS`, `WIN_FALLBACKS`, `APPDATA`/`LOCALAPPDATA`), `userConfig.ts` and `localReranker.ts` reason about `npm.cmd on Windows`, and `CONFIGURATION.md` § 1.2 documents the Windows directory conventions to a reader who cannot install.

Not a defect — the `os` field is the honest position given `better-sqlite3` needs an FTS5-capable native build — but three files carry unreachable code and one doc carries unreachable guidance.

**Recommendation.** Pick one. Either state in `CONFIGURATION.md` § 1.2 that the Windows rows are anticipatory, or drop the Windows branch until the platform is actually supported.

#### L-4 — No dependency-audit automation, no release automation

`.github/` contains exactly one file, `workflows/ci.yml`. There is no `dependabot.yml`, no `npm audit` / `audit-signatures` step, no `CODEOWNERS`, no issue or PR template, and no release/publish workflow. `git tag` returns nothing and the whole `CHANGELOG.md` sits under `[Unreleased]`, while `packages/gnosis/package.json` reads `version: 0.1.0`.

`SECURITY.md` is present, accurate and specific (private vulnerability reporting; an honest inventory of the three opt-in egress flags; an explicit prompt-injection caveat on `ask`) — the process side is what is missing, not the policy.

**Recommendation.** Add `dependabot.yml` for `npm` + `github-actions`, and an `npm audit --omit=dev` step to the existing job. Tag `v0.1.0` when the release is cut so `CHANGELOG.md` has a boundary to close.

#### L-5 — The bench reaches into engine internals by relative path

`packages/gnosis-bench/src/engine.ts` imports 15+ engine modules as `../../gnosis/src/adapters/fts5Adapter.js`, `../../gnosis/src/ingest.js`, etc. — never through `dp-gnosis`'s `exports` map or `src/index.ts`.

This is deliberate and named in the guide (*"`packages/gnosis-bench/src/engine.ts` — THE SEAM"*), and it is the right call for a gate that must measure the real engine rather than its published surface. Two consequences worth recording: the benchmark cannot be run against an installed package, and `COMMON.md` § Module Encapsulation ("cross-feature imports MUST use the public API") is violated by design here.

**Recommendation.** None to the code. Add one sentence to the seam's own header stating the exemption and why, so it is not read as drift.

#### L-6 — `setup` names two different things

`package.json:scripts.setup` runs `wizard`; `dp-gnosis setup` is the reranker-probe command. The root README states *"every `dp-gnosis <cmd>` reads `npm run gnosis -- <cmd>`"*, which makes `npm run setup` the one exception to its own rule.

**Recommendation.** Rename the npm script to `wizard`, or note the exception where the equivalence is stated.

#### L-7 — Governance material leaks into user-facing docs

`packages/gnosis/README.md` and siblings carry p-values, confidence intervals, an index sha256, and internal plan citations (*"`17` DoD #5"*, *"Corrected 2026-08-22 (`16` § 5 C7/C9)"*). Those bracketed numerals reference plan files under `docs/`, which `.gitignore` excludes — a public reader gets a citation to nothing. The guide states this boundary once for `handbook/`; the shipped package docs are outside that statement and are the ones a `demo` retrieves.

**Recommendation.** Strip plan-number citations and inferential statistics from the five shipped `packages/gnosis/*.md`, routing to `handbook/GNOSIS-BASELINES.md` for measured numbers.

#### L-8 — Model-download integrity is trust-on-first-use

`cli/wizard/download.ts` is well built: download to a temp path, verify size and sha256 (from the HF API tree's `lfs.oid`), then move; a repo serving a non-LFS file yields `sha256: undefined` and the size check *"stands alone — an honest weaker guarantee, not a silent one"*. `HF_TOKEN` is read from the environment and never persisted.

The residual point is that the digest comes from the same API that serves the bytes, so it defends against corruption and truncation, not against a compromised or renamed repository. The default GGUFs come from community repos (`gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp`, `Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp`), not the model author's org.

**Recommendation.** State the TOFU boundary in `SECURITY.md` alongside the existing egress table. Pinning a known-good digest per shipped model in `wizard/models.ts` would close it properly.

#### L-9 — Silent drop paths inside index builds

From the delegated sweep, unverified by me directly but consistent with the code's own structure: the adapters' `toEntry`/`collectEntries` drop an atom `parseAtom` refuses **without counting it**. Guarded only at the extremes — all-zero reaches `indexCommand:emptyOutcome` (exit 3), a whole-domain zero reaches `dropWarning`. A partial drop inside a populated domain is visible only by diffing the domain census's `files` against `indexed`, and moves no exit code.

**Recommendation.** Have the index build report `droppedAtoms` alongside the existing `emptyBodyAtoms` and `enrichmentRecords` stamps, as a warning that does not move the exit code — the pattern `--body-source` and `--enrichment` already use.

---

## 3. What stands between this and shipping

Ordered. The first two are the only ones I would call blocking.

1. **Catch the escaped throw on both process bindings** (H-1, H-2). The MCP transport must answer the request id with a JSON-RPC error instead of dying; the CLI must print a message instead of a stack. Both are small and both are the project's own failure class on the surfaces where it is least observable.
2. **Fix the shipped `CORPUS_ROOTS` default** (M-1). A first-run `ingest` in a fresh install refuses on paths from a repository the user has never seen.
3. **De-personalize the shipped docs** (M-5, and the `/home/dev/...` examples). `AUTHORING.md` and `CONFIGURATION.md` § 7.2 are in the published tarball and in the demo corpus.
4. **Reconcile the `--rerank`-refused contract across the two READMEs** (M-6) — it is the single most likely first surprise for a user without a model server.
5. **Test the `DEMO_CORPUS_ROOTS` ⊆ `files` invariant** (M-2). Ten lines; it protects the command a stranger runs first, in the install where nobody is watching.
6. **Make the lint gate a ratchet** (M-3) and **correct the stale vitest landmine** (M-4) — both are gate-credibility items, not code.
7. **Decide the release**: tag `v0.1.0`, close the `[Unreleased]` block, add Dependabot and an audit step, publish or state that it will not be (L-4). The README's *"It is not on the npm registry yet"* is honest but is the last sentence a prospective user reads before deciding.

Nothing in areas 2, 3 or 6 blocks a release.

---

## 4. Strengths

These are unusual enough to name explicitly.

- **The configuration system is the best part of the codebase.** Four directories resolved cross-platform through pure functions (`env.ts`), a documented three-tier precedence (`DP_GNOSIS_*` → `config.json` → default) implemented once in `paths.ts:dataRoot`, and — the rare part — the precedence is *introspectable*: `paths.ts:dataRootFact` and `cli/locations.ts:locationOrigins` return the resolved value **plus the tier that supplied it plus what lost**, so a diagnostic reports the order the code actually applies rather than a second reading of it. Every export is a function, never a module constant, with the reason stated: a constant freezes the layout at import time.
- **Refusals are actionable in a way most tools never manage.** `rerank.ts:unreachableMessage` names the model requested, the address, the exact endpoint that did not answer, the cause, the remedy (*"start llama-swap on that address, or point `DP_GNOSIS_RERANK_URL` at the host that serves it"*) and the escape hatch (*", or drop `--rerank` to retrieve without reranking."*). `notServedMessage` additionally lists what the server *does* serve. `userConfig.ts` refuses every malformed key by name with a correction, tagged `isUserConfigError` so it renders as exit 2 rather than a stack trace.
- **The optional-dependency decision is correct and was made for the stated reason.** `@lancedb/lancedb` (313 MB) and `apache-arrow` sit in `devDependencies`, not `optionalDependencies`, with the reasoning recorded in `comment:devDependencies`: npm installs `optionalDependencies` by default, so *"a tool whose front page says 'no embeddings, no cloud' was downloading a vector database on every install."* The lazy dynamic loader catches **all** import errors, not just `MODULE_NOT_FOUND`, because a native binding failure is a real platform outcome. No skip guard was introduced in the adapter suites, on the grounds that a silently skipped suite is this repository's own failure class.
- **CI is small and correctly shaped.** A 2×2 matrix (ubuntu/macos × Node 22/24) with `fail-fast: false`, the two suites as **sequential steps within one job** — with the reason in a comment, that splitting them across parallel jobs reintroduces the shared-work-directory flake — plus `npm run build -w dp-gnosis` and `npm pack --dry-run` so the published surface is exercised on every PR. The deliberate omission of the benchmark is documented at the top of the file with its justification.
- **No shell interpolation anywhere.** Every subprocess goes through `execFile`/`spawn` with an argv array: `npm` (`localReranker.ts`), `llama-server` (`wizard/backend.ts`), `nvidia-smi` (`wizard/hardware.ts`), `unzip` and `git` (bench). No `exec` with a constructed string, no `shell: true`. No credential is stored: `HF_TOKEN` is read from the environment at call time.
- **`SECURITY.md` is honest rather than boilerplate.** It states plainly that query-time retrieval makes no network call, tabulates the three opt-in flags with what each contacts, notes that the reranker URL *"can point anywhere, so treat it as an egress decision"*, distinguishes the benchmark's fetches, and carries an explicit prompt-injection caveat on the `ask` knowledge pack — described as *"a mitigation … not a guarantee."*
- **The root README is product-grade.** It leads with the differentiator rather than the architecture, states where the tool is the *wrong* choice, gives both install paths honestly (including *"It is not on the npm registry yet"*), and pre-diagnoses three real failure modes — a deleted cwd, a glob that matched no tarball, a `better-sqlite3` source build — each with the literal error text and the actual cause.
- **The `demo` command is the right first-run answer.** It ingests the package's own shipped documentation into a fixed `demo/` subtree that cannot reach the default atoms or index paths, so a stranger gets a working search with no corpus, no config and no risk to an existing vault. The invariant tying its roots to its profile is enforced by a test in both directions.
- **The self-correction discipline is visible in the artefacts.** `paths.ts`, `userConfig.ts` and `env.ts` carry docblocks that name the defect each design avoids — a frozen import-time constant, a shared `XDG_DATA_HOME` silently relocating a checkout's vault while `ingest` prunes, a blank env var resolving to `/dp-gnosis`. `handbook/GNOSIS-GUIDE.md` corrects superseded claims in place with dates. M-4 above is a case where that discipline lapsed, which is notable precisely because it is the exception.
