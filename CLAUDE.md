Behavioral guidelines to reduce common LLM coding mistakes. Merge with the gnosis-specific instructions below as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding — don't assume, don't hide confusion, surface tradeoffs

| Situation | Required |
|---|---|
| An assumption is load-bearing | State it explicitly. Uncertain → ask |
| Multiple interpretations exist | Present them — MUST NOT pick silently |
| A simpler approach exists | Say so. Push back when warranted |
| Something is unclear | STOP. Name what is confusing. Ask |

## 2. Simplicity First — minimum code that solves the problem, nothing speculative

MUST NOT add: features beyond what was asked · abstractions for single-use code · "flexibility" or configurability nobody requested · error handling for impossible scenarios.

Write 200 lines that could be 50 → rewrite it. Test: *"would a senior engineer call this overcomplicated?"* If yes, simplify.

## 3. Surgical Changes — touch only what you must, clean up only your own mess

| Editing existing code | Your changes create orphans |
|---|---|
| MUST NOT "improve" adjacent code, comments or formatting | Remove imports / variables / functions that YOUR changes made unused |
| MUST NOT refactor what is not broken | MUST NOT remove pre-existing dead code unless asked |
| Match existing style, even where you would differ | |
| Unrelated dead code → mention it, do not delete it | |

**The test: every changed line traces directly to the user's request.**

## 4. Goal-Driven Execution — define success criteria, loop until verified

| Task as stated | Task as a verifiable goal |
|---|---|
| "Add validation" | Write tests for invalid inputs, then make them pass |
| "Fix the bug" | Write a test that reproduces it, then make it pass |
| "Refactor X" | Ensure tests pass before AND after |

For multi-step work, state a brief plan — `1. [Step] → verify: [check]` per line. Strong criteria let you loop independently; weak criteria ("make it work") force constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites from overcomplication, and clarifying questions arriving before implementation rather than after mistakes.

ALWAYS use claude opus for coding subagents and complex tasks with thinking, and cheap subagents (haiku; unsure → sonnet) for simple tasks like log processing, data filtering, simple web search.
## What This Repository Is

**gnosis** — a lexical retrieval engine (BM25 over a vault of markdown *atoms*) plus the benchmark that gates every change to it. A TypeScript **Node CLI and library**. No browser, no UI, no framework.

| Path | Role |
|---|---|
| `packages/gnosis/` | the engine, its CLI (`src/cli/`), its MCP server (`src/mcp/`), its library entry (`src/index.ts`) |
| `packages/gnosis-bench/` | the benchmark — the gate for every engine change |
| `benchmark-data/` | runtime root: vault, atom caches, built indexes. Gitignored |
| `handbook/` | governance — the seven `GNOSIS-*.md`. They travel with the code they govern |

`packages/gnosis/src/` sits three levels below the repo root, exactly as `tools/dp-gnosis/src/` did, so `paths.ts:repoRoot()` resolves unchanged. The flatten landed 2026-08-25.

The always-binding rules — the failure class every decision is read against, what may be stated as fact, and which facts MUST be routed rather than restated:

@handbook/GNOSIS-RULES.md

## Source of Truth Hierarchy

`handbook/GNOSIS-GUIDE.md` is the single entry point for the landmines, the served path, the adapter verdicts and what is settled. Read it before engine or benchmark work — not this file, and not an older plan.

**Every doc below has ONE owner. A fact stated in two places has already rotted in one of them — route, do not restate.**

| I want to… | Read |
|---|---|
| Orient before ANY engine or benchmark change | `handbook/GNOSIS-GUIDE.md` § Landmines |
| Understand the pipeline, or place a change in a hop | `handbook/GNOSIS-DATA-FLOW.md` — it OWNS the path, the stage contracts and the hop routing table |
| **Run a CLI command — its flags, exit codes, output shape** | `packages/gnosis/README.md` — the WHOLE flag vocabulary, test-locked against `src/cli/args.ts` |
| **Run the benchmark — its flags, datasets, artefacts** | `packages/gnosis-bench/README.md` § Run it — the sole owner of the bench flag table (`run.ts:RUN_HELP` says so too) |
| Choose WHAT to measure, or decide if two rows may be subtracted | `handbook/GNOSIS-BENCH.md` — methodology and provenance, NOT flags |
| Author a document so it becomes a retrievable atom | `packages/gnosis/AUTHORING.md` |
| Serve the vault to an MCP client, Obsidian or another consumer | `packages/gnosis/INTEGRATION.md` |
| See where quality stands | `handbook/GNOSIS-BASELINES.md` — a snapshot, never a gate |
| Know what has been ruled out, or interpret an old run | `handbook/GNOSIS-HISTORY.md` |
| Build, test and gate a change | `CONTRIBUTING.md` |
| Explain the product to a user | `README.md` (repo root) — the product front page |
| Ship the standalone product | `docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md` |

A plan file is accurate only about intent. It MUST NOT be cited as evidence about code — investigate the code.

## Docs Directory (MANDATORY)

Every file under `docs/` MUST be named `YYYY-MM-DD-HHMM-<kebab-slug>.md` (local time of authoring). No date-time prefix → MUST NOT be created.

| Document kind | Directory |
|---|---|
| Plan, design, implementation strategy | `docs/plans/` |
| Brainstorm, ideation, option exploration | `docs/brainstorm/` |
| Research, prior art, tool/library survey | `docs/research/` |
| Analysis, investigation, post-mortem | `docs/analysis/` |
| Benchmark run write-up, sweep result | `docs/benchmarks/` |

- A new doc MUST land in one of these subdirectories — `docs/` root is FORBIDDEN for new files.
- Sidecar assets (`.svg`, `.json`) MUST carry the same `YYYY-MM-DD-HHMM-<slug>` stem as their document.
- Kind unclear → ASK. MUST NOT pick a directory by guess.

## Coding Principles

@claude-artifacts/principles/COMMON.md
@claude-artifacts/principles/TYPESCRIPT.md

## Change Authorization (MANDATORY)

Investigation MUST NOT auto-convert into remediation. Finding a cause does not authorize fixing it.

| Situation | Required action |
|---|---|
| Question asked ("what can be the issue?", "why X?") | Answer with findings only. MUST NOT edit files |
| Goal stated without naming the change ("X should be restricted") | Propose the specific edits + expected effect, then STOP for approval |
| Requested change appears to need an adjacent change | Apply ONLY the requested one; list the adjacent as a recommendation |
| A value the user did not specify is needed | ASK. MUST NOT pick a default |
| Investigation surfaces unrelated defects | Report them. MUST NOT fix |

FORBIDDEN without explicit per-change approval:

- Quality/accuracy-affecting params — model precision, quantization, sampling, context size, timeouts, limits, `RERANK_*`, `SERVED_PRF_PARAMS`, field weights, adapter defaults
- Any file not named by the user and not required by the requested change
- "While I was in there" cleanups, refactors, added flags

Every applied edit MUST be traceable to a verbatim user instruction. Not quotable → MUST NOT apply. When multiple edits are proposed together, each MUST be separately approvable — bundling an unrequested change with a requested one is FORBIDDEN.

**Facts only.** Evidence and measurement rules are owned by `handbook/GNOSIS-RULES.md` (auto-loaded). One reporting rule is local to a delivered result: MUST NOT append unsolicited tips or alternatives to it.

## Token Discipline (MANDATORY)

| Rule | Saves | Trigger |
|---|---|---|
| **One file = one edit-pass.** Batch all changes to a single file into ONE Write/Edit at the end of a task, not 3-5 sequential Edits. Each edit → reformat → "file modified" reinjection (5-15k each). | 20-30k | Multi-edit session |
| **Subagent prompt cap: 1k tokens.** Pre-delegation context = `<navigation_context>` (exports + line numbers + 1-paragraph behavior), NOT full file dumps. | 10-20k | Subagent invocation |
| **LSP before Read.** Structure questions → exports: `grep -n "^export"` (depth-0, zero noise); types: `hover`; callers/blast-radius: `findReferences` (~200 tokens/call). Read only for behavior (logic, control flow). Re-reading after Edit is FORBIDDEN — Edit/Write would have errored if it failed. | 8-15k | Files >200 lines |
| **LSP query selection** (per `claude-artifacts/LSP.md`). Name known → `hover`. Export list → `grep -n "^export"`. Position → `workspaceSymbol`. `documentSymbol` dumps the full tree with no filter param → OK only on barrel/`types.ts`/tests (or ranges-only), FORBIDDEN elsewhere. | 4-6k per call | `documentSymbol` impulse |
| **Tool-result caching.** Same LSP query, same `Read`, same diagnostic Bash MUST NOT be re-run in the same session unless the file was Edit-ed in between. Re-running buries the prior result deeper in context and inflates total prompt size. | 2-10k | Same-query re-runs |
| **Don't `Read`/`cat`/`grep` `@-imported` files.** Bare `@path/to/file.md` at line start = auto-loaded into the system prompt; re-reading doubles the cost. **Scope**: main session only. Subagents do NOT inherit `@`-imports — they DO need a real Read. Backticked `` `@path` `` = textual ref, not an import. | 3-15k | Session start |
| **Subagent return cap.** Pass `report in under 500 words` (or ≤300 for trivial verifications). Default returns are 2-8k; capped returns are 1-2k. | 5-10k | Read-heavy subagent |
| **Never tail a benchmark log into context.** Redirect to a file, then read the summary rows. A full sweep log is tens of thousands of tokens. | 10-50k | `gnosis:bench` / `gnosis:sweep` |

## Codebase Research Protocol

**REQUIRED sequence** when exploring or understanding code — applies to ALL tasks:

1. **Orient** — `handbook/GNOSIS-GUIDE.md` (landmines + served path + what is settled), then `handbook/GNOSIS-DATA-FLOW.md` for the pipeline and where a stage lives in it.
2. **Structure (LSP)** — exports via `grep -n "^export" <file>`; `hover` for signatures/types, `findReferences` for dependents, `outgoingCalls` for deps. <100ms per query.
3. **Read source** — only for logic/control-flow the above cannot answer. Read the minimum files needed.

**FORBIDDEN**: Using Glob, Grep, or Read more than 3 times before reading `handbook/GNOSIS-GUIDE.md`. Structure questions → LSP. Behavior questions → guide, then Read.

**FORBIDDEN — Bash source-file discovery**: `find packages/...`, `ls packages/...`, `tree packages/...` for file listing in main context. Use `Glob` (no token cost on output), `workspaceSymbol` for a symbol's defining file, or `Read`/`Glob` with an exact path for existence. Bash `find`/`ls`/`tree` are acceptable ONLY for non-source paths (`benchmark-data/`, `logs/`, `results/`, `node_modules/.bin/`) AND when piped through `wc -l`/`head` before reaching the model.

## Web Research Tool Priority

`text-webfetch` subagent → Context7 → WebFetch → WebSearch. Skip unavailable tools.

## Subagents

**Use the Task tool with `subagent_type`. One task per subagent.**

| Task | subagent_type |
|---|---|
| Engine/CLI/benchmark logic, utilities, data transforms | `tools-code-logic-writer` (owns BOTH the failing test and the implementation, red→green) |
| Unit/integration tests | `ts-test-writer` |
| Run tests | `ts-test-runner` |
| Refactor code | `code-refactorer` |
| Code review | `code-reviewer` |
| Anything else (research, multi-step, broad search) | `general-purpose`, `Explore`, `Plan` |

### Pre-Delegation Protocol

Follow **claude-artifacts/LSP.md § Pre-Delegation Protocol**. Pass a `<navigation_context>` block with exports, types, references, and line numbers gathered via LSP. The orchestrator is a delegator, not a researcher.

A subagent does NOT inherit this file's `@`-imports. A prompt that depends on `handbook/GNOSIS-GUIDE.md` MUST say "read handbook/GNOSIS-GUIDE.md first".

### Rules

1. **ALWAYS use subagents for their specialized tasks** — don't write tests/code directly when a subagent exists
2. **Dependency installs are orchestrator-only** — subagents MUST NOT run `npm install` for new packages. A subagent needing one reports back; the orchestrator runs the §IX Dependency Governance protocol
3. **Minimize token usage** — every output for the end user should use short bullet lists with minimal details

### Escalation Protocol

1. Read the subagent's error output
2. Error is clear (wrong path, missing import, syntax error) → fix, re-invoke
3. Error unclear or results wrong → ask the user: "Subagent {name} failed: {summary}. How to proceed?"
4. Never silently skip a workflow step
5. Never retry the same subagent with identical input

## Exit-Code Contract (MANDATORY)

The gnosis CLI and its scripts are exit-coded, and the codes carry meaning (`--help` on each command is authoritative; `3` is commonly "refused / state mismatch", not "crashed").

- **Exit 0**: success.
- **Exit ≠ 0**: STOP and surface stderr to the user. MUST NOT silently retry.
- MUST NOT pipe a command's stdout through `| tail` / `| head` / `| grep` before reading it — those mask exit codes AND truncate failure context. Redirect to a file, then read the file.
- A refusal is a correct outcome, not a failure to work around. Suppressing it recreates the failure class this project exists to police.

## Test Execution

Orchestrator MUST use the `ts-test-runner` subagent for test runs.

| Suite | Command | Covers |
|---|---|---|
| Engine | `npm run gnosis:test` | `packages/gnosis/**` (own vitest config) |
| Benchmark | `npm run bench:test` | `packages/gnosis-bench/**` (`packages/gnosis-bench/vitest.config.ts`) |
| Both | `npm test` | runs the two **sequentially** |
| Types | `npm run typecheck` | `tsc -p packages/gnosis/tsconfig.json --noEmit` |

**Run the two suites SEQUENTIALLY.** Run concurrently they have produced a false red once already (`handbook/GNOSIS-GUIDE.md` § Landmines) — they share a work directory.

MUST use the suite's EXACT command, never a broader superset: a green `npm test` is not evidence that the narrower gate command passes. Different collection = different verdict. Quote the command run alongside the result.

After ANY test-writer subagent returns "GREEN", the orchestrator MUST independently verify BEFORE committing: `git diff --stat <testfile>` (edits persisted) + re-run that file (actually green).

No commit hooks or gate scripts are installed in this repo. `npm test` and `npm run typecheck` MUST pass before a commit; running them is the orchestrator's job, not a hook's.

## Engine and Benchmark Work

| Trigger | Action |
|---|---|
| **Any work on `packages/gnosis/` or `packages/gnosis-bench/`** — develop, debug, investigate, tune, review | MUST read `handbook/GNOSIS-GUIDE.md` FIRST → § Landmines (an `ingest` that never got its `index`, shared work dir, wrong vitest config). MUST NOT name a landmine from memory — the frozen-`ATOM_DOMAINS` row this line used to cite has been DEAD since T6.2. MUST NOT open engine source, launch a benchmark, or hand-roll an `npx vitest` / `grep -rn` pipeline before that read |
| Benchmark / measurement work | ALSO read `handbook/GNOSIS-BENCH.md` (what to measure, provenance-guarded `--compare`, known harness gaps) before launching anything. The FLAGS are in `packages/gnosis-bench/README.md` § Run it |
| Interpreting an older run, or planning research | `handbook/GNOSIS-HISTORY.md` — resolved defects + research index |
| Changing retrieval quality | A change to ranking, weights, PRF, fusion, or the rerank pool is a **measured treatment**. It MUST be gated by the benchmark, and the result MUST name corpus, serving config, and sha |
| `ingest` and `index` | One operation in two commands. An `ingest` alone leaves the index carrying the old digest and the next query refuses — silently, as far as any test suite is concerned |

## Code Navigation

@claude-artifacts/LSP.md

## Test File Ownership

- **MODIFICATION of an existing test file** MUST go through `ts-test-writer` or `tools-code-logic-writer`. Orchestrator and `code-refactorer`: hands off.
- **CREATION of a NEW test file alongside a new source file** (first-test exception): the source writer MAY create the first failing test in the same task — ONLY when no test file exists at the target path yet (verify via Glob/Read). Subsequent edits go through the test-writer subagents.
- The orchestrator MUST NOT write or edit test files directly — always delegate.
- `code-refactorer` MUST NOT modify test files.

## Parallel Execution

**Max Parallel Agents**: 2

## Markdown File Editing (MANDATORY)

BEFORE every edit to `.md` files in `.claude/`, `claude-artifacts/`, or `CLAUDE*.md`:

1. **Read** `claude-artifacts/standards/MARKDOWN-AUTHORING.md`
2. **Apply** — key constraints (full rules in that file):
   - Token-efficient format: tables > prose, no filler
   - Keywords: `MUST` / `MUST NOT` / `FORBIDDEN` only — not `NEVER` / `ALWAYS` / `Do NOT`
   - Match the target file's existing heading hierarchy, list style, table format

The `GNOSIS-*.md` governance files are not covered by that standard's pre-edit protocol, but the same rule holds: a claim in them MUST carry its evidence, and a superseded claim MUST be corrected in place rather than appended to.
