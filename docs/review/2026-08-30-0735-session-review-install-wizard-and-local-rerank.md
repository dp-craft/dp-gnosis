<!-- LLM-PRIMARY: In-depth review of the 2026-08-28/29 window — the 27 commits that closed the production-readiness and Phase-A install plans, and the UNCOMMITTED `wizard` + in-process rerank backend. Verdict per plan goal, ranked findings with file:line as-found, and the open list. § 9 records the same-day remediation: 16 findings fixed, 3 deferred, gate green. -->

# Session review — 2026-08-28 → 2026-08-29

- **Reviewed:** 2026-08-30 07:35
- **`HEAD`:** `dd32e6c` · branch `fix/init-prefix-and-chat-model-config`
- **Method:** every claim below is anchored to a `file:line` or a command that was run in this
  review. Beliefs carried from a plan document were dropped unless the code confirmed them —
  a plan is accurate only about intent (`CLAUDE.md` § Source of Truth Hierarchy).
- **Remediation followed, same day** — see § 9. Sixteen of the findings were fixed on owner
  instruction ("fix all the issues which are clear, minimalistic, SRP/SoC"); three were deferred
  because they need a decision rather than code. **The `file:line` anchors in §§ 4–6 below are
  as-found, BEFORE those fixes** — they are the evidence for the finding, not a map of the tree
  today. § 9 carries the after state.
- **`docs/` is gitignored**, so this file is provenance in the private tree, not a published document.
  It also sits in `docs/review/`, which is NOT one of `CLAUDE.md`'s five permitted subdirectories —
  written there because the owner named that path.

---

## 0. Scope

| Half | What |
|---|---|
| **Committed** | 27 commits, `7030dd8` → `dd32e6c`. They close `docs/plans/2026-08-27-1549-production-readiness-init-doctor-and-user-docs.md` (its own § 10.5 ledger) and all eight tasks of `docs/plans/2026-08-29-0928-phase-a-install-unblocking.md` |
| **Uncommitted** | 22 modified + 9 new files, **+2 943 / −420**. `src` alone is +569 / −349, plus **2 521 new lines** across `src/cli/wizard/`, `wizardCommand.ts`, `rerankSetup.ts`, `instance.ts`. This is `docs/plans/2026-08-29-2047-interactive-setup-wizard.md` and its § "The `local` backend, no longer deferred" |

Two analysis documents fall in the window and were read as inputs, not as work to verify:
`docs/analysis/2026-08-29-1615-jina-reranker-root-cause-and-qwen-rerank-arms.md` and
`docs/analysis/2026-08-29-2109-node-llama-cpp-status-and-handover.md`.

---

## 1. Gate status — GREEN, with one flake class

Run sequentially, this review's own runs:

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | pass |
| `npm run gnosis:test` | 0 | **1 738 passed, 103 files**, 10.01 s |
| `npm run bench:test` | 0 | **824 passed, 34 files** |

**A first run of `gnosis:test` — taken while two review subagents were reading the tree — exited 1**
with two timeouts: `tests/demoCommand.test.ts:136` and `tests/rerankBackend.test.ts:333`. Both were
re-run in isolation and passed at **751 ms** and **405 ms** against a 5 000 ms budget, and the
clean full-suite run above is green. So the failures were load-induced, not a defect in the change —
but the flake class is real and belongs on the list:

> `demoCommand.test.ts:136` and `rerankBackend.test.ts:333` both drive `runCli` end to end with **no
> explicit timeout**, so they inherit vitest's 5 000 ms default while their siblings in the same
> files carry `120_000`. Under any CI or developer load they are the first two cases to go red, and
> a red gate that is not about the change is exactly what teaches a reader to re-run rather than
> read. Pre-existing for `demoCommand`; `rerankBackend.test.ts:333` is older than this session too.

---

## 2. Goals — plan by plan

### 2.1 `2026-08-27-1549` production readiness — **DONE, one item deliberately open**

Its own § 10.5 ledger lists nine review findings closed by commit; each commit is present in this
window (`600b2d1`, `65e5289`, `f7b746a`, `b54f155`, `5a562f7`, `7030dd8`, `43ce534`, `c46ddd0`).

**Still open by design:** § 7 row **A1** — the `digestRefusal` change — reads *"NOT APPLIED —
proposal, awaiting approval"*, and nothing in the diff applies it. That is the plan working as
written, not a gap; it needs an owner decision, not code.

### 2.2 `2026-08-29-0928` Phase A install unblocking — **A1–A8 all delivered**

Verified against the tree, not against the plan:

| Task | Verdict | Evidence |
|---|---|---|
| A1 rename | done | `packages/gnosis/package.json:2` `"name": "dp-gnosis"` |
| A2 dependency split | done | same file: `minisearch` in `dependencies`, `@lancedb/lancedb` + `apache-arrow` in `devDependencies`; `optionalDependencies` gone, with the reasoning preserved in `comment:devDependencies` |
| A3 MCP bin | done | `package.json:10-13` ships `dp-gnosis-mcp`. The coupled measurement was honoured, not assumed: `INTEGRATION.md:108` now carries **0.07 s / 0.58 s** for the installed path beside the old 34–52 s figure at `:112` |
| A4 `--version` | done | `src/cli/args.ts:126`, `src/cli/cli.ts:221-223` — asked **before** `--help` |
| A5 CI matrix | done | `.github/workflows/ci.yml` — `os: [ubuntu-latest, macos-latest] × node: [22, 24]`, `fail-fast: false`, the two suites kept as sequential steps with the landmine named in a comment |
| A6 repo URL | done | `README.md:65`, `:76` — real clone URL, plus the `better-sqlite3` native-build note at `:90` |
| A7 adapter docs | done | `OPTIONAL.md` § Dense and hybrid research routes |
| A8 command table | done | `packages/gnosis/README.md:62-69` carries `init`, `doctor`, `wizard`; the six-vs-five drift is resolved to **five** (`README.md:312`) |

**Not done, and it was marked optional in the plan itself:** A8's recommended
`readmeFlags.test.ts`-style lock over the **command** table. `tests/` has `readmeFlags.test.ts`,
`rootReadmeLock.test.ts`, `integrationDocLock.test.ts` — none asserts the command table equals
`Object.keys(COMMANDS)`. The `wizard` row was therefore added by hand and nothing stops the next one
being forgotten. This is the same drift class A8 existed to repair.

### 2.3 `2026-08-29-2047` interactive setup wizard — **built, but three of its own contracts do not hold**

Steps 1–3, 4–6 and 9–11 of the § 3 flow exist and are wired. Layering held: `plan.ts` is pure,
`prompts.ts:100` is the only `@inquirer/prompts` import site, and rung A stops at the first passing
probe (`rerankSetup.ts:149`). The download path — resume, `.part`-then-rename, sha256, `HF_TOKEN`,
a 200-not-206 restart — is correct and is the best-tested part of the change
(`tests/wizardDownload.test.ts`, 9 cases).

What does **not** hold is in § 4 below: the "nothing is written before you confirm" promise, the
step-0 preflight, the adapter carried into the build, and the by-name refusal of broken GGUF repos.

### 2.4 `2026-08-29-2109` node-llama-cpp handover — **4 of 5 items closed**

| # | Item | Verdict |
|---|---|---|
| 1 | reinstall as a devDependency | done — `packages/gnosis/package.json` `devDependencies` |
| 2 | update `mcpProtocol.test.ts`'s pinned key list | done — both blocks, each with the reason in a comment |
| 3 | make availability injectable | **partial** — `localReranker.ts:130` takes an `EngineLoader`, but every production consumer hardwires the default (`rerank.ts:544`, `doctorCommand.ts:268`) |
| 4 | implement scoring | done — `localReranker.ts:230 localRerankScores` |
| 5 | measure GPU, leave `RERANK_DEFAULT_BACKEND` alone | done — `config.ts:216` still `http`; the two measured rows are in `OPTIONAL.md` § The in-process backend with the "read against each other and nothing else" caveat the rules require |

### 2.5 `2026-08-29-1615` jina root cause — **routed, not restated**

`handbook/GNOSIS-GUIDE.md`'s reranker table now carries the corrected reading (the GGUF drops
`projector.0/2.weight`; the model is sound; llama.cpp cannot serve it) and cites the analysis file
as provenance. The earlier "rank head absent, no build fixes it" claim is corrected **in place**,
which is what § Volatile facts asks for.

---

## 3. What holds — stated so clean and unmentioned do not look alike

| Area | Verdict |
|---|---|
| **Calibration safety under `local`** | **Safe.** Both read sites route through `rerankCalibrationKey` (`retrieveCommand.ts:1384` → `calibratedFloor:444`; `retrieveCommand.ts:1217` guards `calibrate` at `:1218`). `RERANK_CALIBRATION` is unreachable with no key, so `confidence` reads `weak` and `--min-relevance` refuses by name (`retrieveCommand.ts:431`) |
| **One probe standard** | `rerankAtoms`, `probeRerankDiscrimination`, `rerankProbeRefusal` and `rerankHealth` all resolve `scorerOf(resolved(options))` (`rerank.ts:719, 885, 949, 983`) and share `probeScorer:893`. The memo key IS backend-aware — `scorerKey:583` emits `http\0url\0model` vs `local\0modelPath` — so no cross-backend verdict is ever reused |
| **Refusal paths** | Unset path, missing file, absent engine and load failure each refuse **before any I/O** (`rerank.ts:534, 538`, `localReranker.ts:126`), reach `EXIT_PARTIAL`, keep the first-pass ranking, and attempt no HTTP call. Asserted by `tests/rerankBackend.test.ts` |
| **Bench pin** | `engine.ts:81` is the bench's only scorer import and both call sites spread `backend: 'http'` (`:1029`, `:1047`), so an exported `DP_GNOSIS_RERANK_BACKEND` cannot swap the scorer under a recorded row |
| **Docs honesty** | `README.md`, `packages/gnosis/README.md`, `CONFIGURATION.md` § 1.3 and `OPTIONAL.md` all describe the wizard and the local backend qualitatively and route measured figures to `handbook/GNOSIS-BASELINES.md`. No nDCG figure was copied into the wizard, exactly as § 5 of the plan required |
| **Test locks kept honest** | `mcpProtocol.test.ts`'s dependency guard and `rootReadmeLock.test.ts`'s install claim were both updated in the same change as the manifest, so neither passed by being loosened |

---

## 4. Findings — ranked, every one anchored

### CRITICAL

**C1 · `wizardCommand.ts:310` + `:251` — the wizard can adopt an atoms directory it did not create, which is the destructive defect `init` was repaired for on 2026-08-27.**
`runWizard` checks `existingInstance(instancePaths(context.atomsDir, context.indexPath))` at `:310`,
and `commit` calls `writeInstance(...)` at `:251` with **no** `atomFileCount` check — while
`initCommand.ts:161-162` calls both, and `instance.ts:66` exists for exactly this. Two ways it bites:

1. `existingInstance` is evaluated on `context.atomsDir` **before** the data-root question at `:283`,
   so a user who picks a non-default root has the owner-marker half of the check applied to the
   wrong tree.
2. `atomFileCount` is never called at all, so an atoms directory already holding markdown is written
   into and the following `ingest` prunes every one of those files as an orphan.

The 08-27 plan § 10.1 reproduced this end to end (*"`ingest: written 1, pruned 1` — and the atom was
gone"*) and closed it in `init`. The wizard is a second writer of the same instance and did not
inherit the guard.

**C2 · `wizardCommand.ts:285-291` — "Nothing is written until you confirm" is printed and is not true.**
`WELCOME` (`:259-262`) says *"Nothing is written until you confirm a summary at the end, so Ctrl-C at
any point leaves this machine exactly as it is"*, and `CANCELLED_TEXT` (`:248`) says *"cancelled —
nothing was written"*. But `askRerank` runs at `:285`, **before** the summary at `:296`, and it can
(a) create `modelsDir` and download a GGUF of up to several GB, and (b) spawn a **detached,
`unref`ed** `llama-server` plus a log file (`backend.ts:100`). Plan § 3 conceded the download as the
one exception; the detached server is a new one, and neither is reflected in what the user is told.
An abort therefore leaves a process holding the GPU while the tool reports that nothing happened.

**C3 · `wizardCommand.ts:149`, `:184`, `:192` — choosing any adapter but `fts5` yields an instance that cannot answer.**
`buildSteps` passes `--adapter` to `index` only (`:149`); `verify()` runs `search … --json` with no
`--adapter` (`:184`), and `cli.ts:200` resolves the adapter from flags alone (`?? DEFAULT_ADAPTER`).
`plan.ts:155-177` writes **no adapter key into the profile**, so nothing carries the choice. The
menu offers all seven (`advice.ts:44-95`, reached at `flow.ts:220`), so a user picking
`minisearch` / `linear` / `lancedb*` gets an index built by one adapter and opened by another —
the `openPort` refusal the guide names — surfaced as a non-`ready` `indexState` and exit 3. The
`Next:` lines at `:192` omit `--adapter` too, so the instance stays unusable after the wizard exits.
Every wizard test pins `adapter: 'fts5'` (`tests/wizardFlow.test.ts:97`, `:125`), so nothing catches it.

### MAJOR

**M1 · `rerank.ts:561-581` — the local scorer runs with no timeout at all.**
`scorerRefusal` forwards `timeoutMs` only to `catalogueRefusal`; `localRefusal:542` accepts none, and
`scoreWith:576` drops `request.timeoutMs`. `TIMEOUT_MS = 60000` and `PROBE_TIMEOUT_MS = 300000` bind
HTTP only, and `rerankHealth:985` budgets `CATALOGUE_TIMEOUT_MS = 5000` for a question the local path
answers unbounded. At this change's own measured CPU figure (1 708 ms/doc, `OPTIONAL.md`), a pool-100
rerank runs ~170 s and `doctor` can block on a model load with nothing to cancel it.

**M2 · `rerank.ts:183` — the absolute-path guarantee is enforced on one tier out of two, and the unenforced one wins.**
`userConfig.ts:readRerankModelPath` refuses a relative `rerank.modelPath` and documents why. But
`resolveRerankModelPath` returns `statedVar(env, RERANK_MODEL_PATH_ENV_VAR)` **unchecked**, and that
tier outranks `config.json` (`CONFIGURATION.md` § 1.3's precedence table). So
`DP_GNOSIS_RERANK_MODEL_PATH=models/r.gguf` resolves against a working directory nobody chose —
under MCP, a different file per client — which is the exact failure the config-side refusal exists
to prevent.

**M3 · `rerankFlow.ts:378-382` + `backend.ts:131` — a failing probe against a live server falls
through to starting a second one on the same port, and the readiness poll then reads the OLD server
as proof it worked.** `startServer` cannot see an "address in use" exit (`backend.ts:97-108` returns
a pid immediately), and `waitForServer` gets HTTP 200 from the pre-existing server. A component
produced nothing and the poll recorded it as data — `GNOSIS-RULES.md` § The failure class. Only the
subsequent `rerankHealth` stops a wrong pair being written.

**M4 · `wizardCommand.ts:310` — step 0 preflight is one check of five.**
Plan § 3 step 0 requires node ≥ 22, platform, checkout-vs-install, a `better-sqlite3` load and free
disk on the data root. None of those exist anywhere in `src/cli/wizard/`; only the instance check
does. On the machine this is aimed at — a fresh clone whose native build may not have compiled —
that is the check most likely to have been the whole reason the user ran the wizard.

**M5 · `models.ts:118-127` — the by-name refusal of broken GGUF repositories has no caller.**
`REJECTED_REPO_MARKS`, `rejectionReason` and `isRejectedRepo` are referenced nowhere in `src/` or
`tests/`. Plan § 4 makes this refusal a headline property (*"the BROKEN repos are listed and refused
by name"*) and `README.md`/`OPTIONAL.md` both now tell the reader it happens. It does not. The
wizard only ever offers `WORKING_MODELS`, which is a safe default but not the same guarantee — a
guard that is documented and unreachable is worse than one that was never claimed.

**M6 · `download.ts:263` — no free-disk check before a multi-gigabyte download.**
Plan § 4: *"Check free disk BEFORE starting."* `hardware.ts` reads free disk and `models.ts:148`
uses it only to bias a default quantisation; a user may still select F16 (~8 GB, `models.ts:88`) on
any disk and learns the truth as an ENOSPC stream error at `download.ts:242`, after the transfer.

**M7 · `plan.ts:155-177` vs `initCommand.ts:52-71` — two owners of the profile template, which is precisely what the plan's own extraction table said it was preventing.**
Plan § 1 lists *"`profileFor` + `writeInstance` + the two refusals → `instance.ts`"* with the reason
*"a wizard writing its own profile template would be a second owner of the profile schema."*
`writeInstance` moved; `profileFor` did **not**. There are now two near-identical 17-key literals
that already differ (`init` writes no `defaultAnalyzer`; the wizard does), and the next key added to
one will silently miss the other. `flow.ts:27` reaching into `initCommand.js` for `DEFAULT_TYPE` /
`DEFAULT_EXCLUDED_TYPES` is the same seam showing through.

### MINOR

**m1 · `rerank.ts:544`, `doctorCommand.ts:268` — the injectable loader is never injected.**
Handover item 3 is done at the module and not at its consumers, so the engine-**absent** branch —
the consumer's state, and the one the ADR requires green — survives only in one unit test
(`tests/rerankBackend.test.ts:118-125`). The doctor case was inverted to assert the checkout state
(`:337-352`), which is honest about what the code does but leaves the shipped state uncovered.

**m2 · `instance.ts:26-32` and `rerankSetup.ts` — the extractions promoted private helpers to public API.**
`instance.ts` exports `FALLBACK_DOMAIN`, `MD_SUFFIX`, `NON_LABEL`, `EDGE_DASHES` — **no importer
anywhere** in `src/` or `tests/`; all four were file-private `const`s in `initCommand.ts` before the
move. `rerankSetup.ts` exports ten symbols with no consumer outside itself: `RERANKER_MARK`,
`NOT_A_RERANKER`, `BEYOND_CAP`, `ServerResult`, `askServer`, `skippedFor`, `restrictedSummary`,
`namedCandidates`, `filteredCandidates`, `readRaw`. COMMON.md § II asks a module to hide its
internals; a move is the moment that is cheapest to get right.
*Related and pre-existing — reported, not fixed:* `MD_SUFFIX = '.md'` is now defined three times
(`instance.ts:29`, `validate.ts:20`, `ingest.ts:49`).

**m3 · `advice.ts:31, 35, 69-90` — `needsPackages` / `DENSE_PACKAGES` are written and never read.**
Plan § 3 step 5 requires the dense choice to explain its ≈323 MB dependency cost and offer the
install. The data to do it is assembled and dropped; the user finds out when `index` fails.

**m4 · `localReranker.ts:240-241` — a ranking context leaks when the shape check fails.**
`createRankingContext()` succeeded, the `isRankingContext` false branch returns without `dispose()`.
Once per call, in a process (`dp-gnosis-mcp`) designed to be long-lived.

**m5 · `config.ts:223` — a routed name that does not resolve.** The docblock says
`RERANK_MODEL_PATH_ENV_VAR` is *"read in `rerankModelPathFact` alone"*; no such symbol exists — the
reader is `rerank.ts:178`. Its sibling at `:218` names `rerankBackendFact` correctly.

**m6 · `wizardCommand.ts:230` — `STATE_REMEDY[state as IndexState]` asserts an unvalidated string.**
`indexStateOf:172` can return `'unreported'` or `'unreadable'`, neither an `IndexState`.
TYPESCRIPT.md forbids the assertion; a `state in STATE_REMEDY` guard is one line, and the `??`
fallback at `:238` already proves the author knew the value may be absent.

**m7 · `wizardCommand.ts:184` — `verify()` discards the search exit code**, so a refusal the tool
already explained degrades to the generic remedy.

**m8 · minimalism, one-caller and impossible-state.** `download.ts:175 hfFileFacts` (+`FactsOutcome:64`,
`entryFacts:111`) has no production caller — only `tests/wizardDownload.test.ts:99` — and duplicates
`treeOf`/`hfGgufFiles`. `flow.ts:195, 228` sets `CorpusAnswers.poolK` and nothing reads it.
`rerankFlow.ts:378`'s `winner !== undefined && server.ok` cannot be false on the second term.
`rerank.ts:159 resolveRerankBackend` lost its last production caller when `retrieveCommand` stopped
using it (reported, not to be deleted).

**m9 · `plan.ts:166-167` writes `typeRules` and `segmentRules` empty**, though plan § 3 step 3 lists
them as interview outputs; and step 11's `doctor` is printed as advice (`wizardCommand.ts:193`)
rather than run, though the flow table says the wizard runs it.

**m10 · `backend.ts:34, 47, 90` — detection is wider than its use.** `llama-swap` and `ollama` are
detected, `DetectedBackend.path` is never read, and `serveCommand` hardcodes `'llama-server'`
(`rerankFlow.ts:187` accepts only that kind). A llama-swap-only machine — the one every recorded
baseline was measured on — gets the "no backend" text at `rerankFlow.ts:169`, though plan § 4 rung B
names llama-swap explicitly.

---

## 5. Test coverage — where the change is thin

29 new cases across four files. What they do **not** reach:

| Uncovered | Why it matters |
|---|---|
| Any adapter but `fts5` through the wizard | C3 is invisible to the suite by construction |
| `backend.ts` entirely — `detectBackends`, `serveCommand`, `startServer`, `waitForServer` | M3 and C2's detached-process side effect live here |
| `askRerank`'s ladder (`rerankFlow.ts:363`) | rungs B–D are the half of § 4 that touches the machine |
| The four non-`ready` `IndexState` remedies and `failed()` (`wizardCommand.ts:202-224`) | the plan's own § 10 "corrected" item — the vocabulary it went back to fix |
| A CLI-level `search --rerank --min-relevance 0.5` under `DP_GNOSIS_RERANK_BACKEND=local` | the calibration gate is the safety property of the whole local backend, and it is asserted only at function level (`tests/wizardRerankLocal.test.ts:131`) plus a terminal run recorded in the plan |
| `models.ts:131, 148` | the recommendation rule that decides which multi-GB file a user downloads |

---

## 6. Six seats

| Seat | Verdict |
|---|---|
| **Goals** | Every changed line traces to one of the three plans; no orphan edits found, including the two easy-to-miss ones (`adapter.ts:126`'s optional `root` and `engine.ts`'s `backend:'http'` pin, both required by the wizard and the local backend respectively). The reverse direction fails in five places: C2, C3, M4, M5, M6 are plan promises the code does not keep, and three of them are now also promised in shipped documentation |
| **Consistency** | Naming, refusal wording, exit-code vocabulary and docblock style match the surrounding CLI closely — `wizard`'s exit codes read like `init`'s and `setup`'s. Two breaks: M2 (one tier enforces absoluteness, the other does not, for the same key) and m2 (the extractions publish what the originals kept private) |
| **Minimalism** | The wizard composes `init`/`setup`/`ingest`/`index`/`doctor` rather than re-implementing them, which is the right shape. Against that: M7's second profile template, m2's 14 unused exports, m3's unread `needsPackages`, m8's `hfFileFacts` / `poolK` / impossible-state guard. Roughly 150 lines delete with nothing lost |
| **Logic + side effects** | The seat that found the most. C1 (a second writer of one instance without the guard the first writer earned), C2 (side effects before the commit point the UI promises), M3 (a poll that reads someone else's server as its own success), M1 (an unbounded call inside a bounded budget) are all observer/ordering defects, not local bugs |
| **Data flow + user flow** | One datum end to end — the adapter choice — is dropped between `flow.ts:220` and the closing `search`, which is C3. One user path end to end — decline the summary after the reranker rung — reports "nothing was written" over a downloaded model and a running server, which is C2. The happy `fts5` path with no reranker is clean and is what the tests drive |
| **SRP + SoC** | Delete `src/cli/wizard/` on paper and: `cli.ts`, `help.ts` and the two READMEs lose a row each (expected); `instance.ts` and `rerankSetup.ts` become sole-consumer modules that would fold back into `initCommand.ts` / `setupCommand.ts`; `adapter.ts:126`'s `root` parameter loses its only caller. That is a clean boundary. The leak is the other direction: `flow.ts:27` imports two constants **from a sibling command**, which is the seam M7 describes |

---

## 7. What is missing — the open list

**Blocking, if the wizard is meant to be the front door (§ 4 CRITICAL):** C1, C2, C3.

**Should be closed before the wizard is committed:** M1, M2, M4, M5, M6, M7, plus a test for the
adapter path and one for the calibration gate at CLI level.

**Carried openly by the plans themselves, needing an owner decision rather than code:**

| Open | Named in |
|---|---|
| A GGUF already on disk cannot be pointed at — the in-process rung is reachable only after a download | wizard plan § "Still open, deliberately" |
| `doctor`'s engine-absent branch has no seam | same; and m1 above |
| `RERANK_DEFAULT_BACKEND` stays `http`; promoting `local` needs its own paired arm and approval | handover § 7 item 5 |
| The `digestRefusal` change (A1 of the 08-27 plan) is still a proposal | 08-27 plan § 7 |
| A command-table lock test | Phase A § A8, marked "recommended, separately approvable" |
| Retrieval quality of a jina sidecar is UNMEASURED (9 min/query on CPU) | jina analysis; already recorded in the handbook |

---

## 8. Questions asked at review time

1. **The adapter menu (C3).** Restrict `wizard` to `fts5`, or carry `--adapter` into `verify()`, the
   `Next:` lines, and a profile key? The second is more work and needs a profile-schema decision;
   the first matches "every default the wizard writes is the shipped one".
2. **The reranker rung's side effects (C2).** Move the download and the server start **after** the
   confirmation, or amend the two on-screen promises to name both? The plan chose the second for the
   download alone; the detached server was not foreseen.
3. **`profileFor` (M7).** Complete the extraction into `instance.ts` as the plan specified, or accept
   two templates and add a test asserting their key sets agree?
4. **`DP_GNOSIS_RERANK_MODEL_PATH` (M2).** Refuse a relative value by env-var name, matching the
   config key — or is there a caller that relies on a relative one?

Answered by the owner as *"start fixing all the issues which are clear, but do not overengineer, be
minimalistic, take care of SRP SoC"* — so each was resolved by its smallest correct form: (1) carry
the adapter, do NOT add a profile key; (2) make the printed promises true rather than restructure
the flow; (3) complete the extraction the plan already specified; (4) refuse the relative env value.

---

## 9. Remediation — 2026-08-30, same session

Working tree after the fixes: **+3 010 / −441** across 22 tracked files plus 2 651 new lines in the
untracked wizard tree. Gate re-run **sequentially, with nothing else in flight**:

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | pass |
| `npm run gnosis:test` | 0 | **1 740 passed, 103 files** (was 1 738: +5 new cases, −3 deleted with `hfFileFacts`) |
| `npm run bench:test` | 0 | **824 passed, 34 files** |

### Fixed

| # | Fix | Where |
|---|---|---|
| **C1** | The instance guard now runs against the **chosen** data root, after the root question rather than before it, and adds `init`'s second refusal — an atoms directory already holding markdown is refused at exit 3 instead of being adopted and pruned | `wizardCommand.ts` — `instanceRefusal(root)` over `atomsDirOf(root)`, calling both `existingInstance` and `atomFileCount` |
| **C2** | The three false promises now say what is true: no profile and no config is written before the confirmation, and a downloaded model file **or a started server** outlives an abort | `wizardCommand.ts` `WELCOME`, `CANCELLED_TEXT` and the module docblock; `backend.ts` docblock |
| **C3** | The adapter choice is carried into the closing `search` and into the printed `Next:` line, so a non-`fts5` instance answers. **No profile key was added** — the adapter stays a flag, as it is for every other command | `wizardCommand.ts` `verify(plan, adapter)`, `nextSteps(profilePath, adapter)` |
| **M2** | A relative `DP_GNOSIS_RERANK_MODEL_PATH` is refused by **env-var name**, matching what `userConfig.ts` already does for the config key. Placed in `scorerOf` rather than in `resolveRerankModelPath`: a throw from the resolver would escape `withContext` (which catches only `isVocabularyError`) as an unhandled error instead of the exit-3 refusal, and would also break `doctorCommand.ts:modelPathLines`, which calls the resolver unguarded | `rerank.ts` `relativeModelPathMessage` + the `scorerOf` gate |
| **M3** | `startServer` probes the port **before** spawning and reports `alreadyServing`; a bound port can no longer be proven by the pre-existing server's own 200 | `backend.ts` `StartOutcome`, `localBaseUrl`; `rerankFlow.ts` `startedLines` |
| **M5** | The unreachable by-name refusal of broken repositories is **deleted**, and the two documents that promised it now say what the code does — it offers only the verified repositories. `OPTIONAL.md`'s broken-repo table stays: it is reference for a reader, not a code claim | `models.ts`; `packages/gnosis/README.md:88`; `OPTIONAL.md:41` |
| **M6** | A download refuses before opening the body when free disk is below the file size, naming both numbers. `hardware.ts:readFreeDisk` reused rather than re-implemented; no configurable margin added | `download.ts` `diskCheck` |
| **M7** | **`src/instance.ts` is now the single owner of the profile schema** — `profileTemplate`, `ProfileRoot`, `DEFAULT_TYPE`, `DEFAULT_EXCLUDED_TYPES`, one `comment:editing`. Both `init` and the wizard call it; `init`'s serialised bytes are unchanged (key order preserved), and the optional keys keep their omit-when-absent behaviour. `initCommand.ts` exports only `runInitCommand` again, and `flow.ts` no longer reaches into a sibling command for two constants | `instance.ts`, `initCommand.ts`, `wizard/plan.ts`, `wizard/flow.ts` |
| **m2** | 16 symbols that the two extractions had promoted to public API with no importer are private again — 4 in `instance.ts`, 10 in `rerankSetup.ts` (`rerankSetup.ts` 24 → 14 exports), plus `POOL_SHIPPED` and `POOL_FAST`. Nothing renamed, nothing deleted, every docblock kept | `instance.ts`, `rerankSetup.ts`, `wizard/advice.ts` |
| **m3** | `needsPackages` / `DENSE_PACKAGES` deleted — the four dense entries' `con` text already names the dependency cost | `wizard/advice.ts` |
| **m4** | The ranking context is disposed on the failed-shape branch | `localReranker.ts` `noRankAll` |
| **m5** | The `RERANK_MODEL_PATH_ENV_VAR` docblock routes to `resolveRerankModelPath`, the symbol that actually reads it | `config.ts` |
| **m6** | `state as IndexState` replaced by an `in` guard; exhaustiveness over `IndexState` kept via `satisfies` | `wizardCommand.ts` `remedyFor` |
| **m7** | An unparseable stdout with a non-zero exit now reports `search exited <code>` instead of `unreadable` | `wizardCommand.ts` `verify` |
| **m8** | `hfFileFacts` + `FactsOutcome` + `entryFacts` deleted (test-only, and duplicating what `hfGgufFiles` returns — `RemoteFile` already carries `sizeBytes` and `sha256`), with their test block; `CorpusAnswers.poolK` deleted (the pool actually used comes from `RerankAnswer.poolK`) | `wizard/download.ts`, `wizard/flow.ts`, `tests/wizardDownload.test.ts` |

**Tests added: 5** — the chosen-root occupied-atoms refusal, the whole wizard driven on `minisearch`
(RED first: it failed inside `fts5Adapter.ts:openIndex`, the closing search opening an index that was
never built), `startServer` against an already-bound port, the free-disk refusal, and the relative
`DP_GNOSIS_RERANK_MODEL_PATH` refusal. Every fix was reproduced RED before it was made GREEN.

### Not fixed — each needs a decision, not code

| # | Why it was left |
|---|---|
| **M1** — the local scorer runs with no timeout (`rerank.ts:561-581`) | A native in-process `rankAll` cannot be cancelled. A `Promise.race` would return control while the call kept running and the model stayed loaded — a leak dressed as a timeout. The honest options are a worker with a kill, or a documented "local reranking is unbounded on this machine". **The second was taken on owner instruction the same day** (§ 10): the absence is now stated in `OPTIONAL.md`, both READMEs, and by the wizard itself past a one-minute projected pool cost. The code is unchanged, so the finding stands as OPEN — it is disclosed, not fixed |
| **M4** — step-0 preflight is 1 check of 5 (node ≥ 22, platform, `better-sqlite3` load, free disk) | Four checks that do not exist yet. That is missing plan scope, not a defect in written code, and building them uninstructed would be the scope creep the instruction ruled out |
| **m1** — the injectable `EngineLoader` is never injected (`rerank.ts:544`, `doctorCommand.ts:268`) | Threading a loader through `RerankOptions` and `scanLocalReranker` widens two public shapes to buy one test seam. The wizard plan already recorded it as "not asked for" |

### Reported, not touched (pre-existing)

- `MD_SUFFIX = '.md'` is defined four times across the package — `instance.ts`, `validate.ts:20`,
  `ingest.ts:49`, and `wizard/flow.ts:33` as `MD`.
- `rerank.ts:159 resolveRerankBackend` has no production caller (only its test); it predates this
  session.
- `demoCommand.test.ts:136` and `rerankBackend.test.ts` drive `runCli` end to end with no explicit
  timeout, inheriting vitest's 5 000 ms default while their siblings carry `120_000` — the flake
  class § 1 recorded.
- `tests/wizardDownload.test.ts` still carries a `state.treeBody` fixture field that no remaining
  test writes, left by the `hfFileFacts` removal.
- `rerankFlow.ts:393`'s `winner !== undefined && server.ok` reads as an impossible-state guard but
  the second term is load-bearing for TypeScript narrowing — `findServer`'s union only carries
  `baseUrl` on the `ok` arm. **Correction to § 4 m8:** that item was wrong, and the line stands.

---

## 10. Disclosure pass — the in-process backend, 2026-08-30

Owner question: *"is the embedded engine working or not? can the user use CPU/GPU reranking without
external services?"* Answered by running it, then written into the places a user reads.

**Verified end to end in this checkout**, engine installed, **nothing answering at `127.0.0.1:9292`**
(`curl` → no answer, `pgrep -x llama-server` → 0):

```bash
DP_GNOSIS_RERANK_BACKEND=local \
DP_GNOSIS_RERANK_MODEL_PATH=/home/dev/models/gguf/rerankers/qwen3-reranker-0.6b-q8_0.gguf \
  npx tsx packages/gnosis/src/cli/main.ts search "atom ingest prune orphan" -k 3 --rerank --json
```

→ exit 0, `"mode":"fts5+rerank"`, `"poolSize":100`, `"indexState":"ready"`, `"confidence":"weak"`,
**10.5 s wall** including process start and model load. The same invocation with
`--min-relevance 0.5` refuses at **exit 2** naming the uncalibrated backend. This is proof the path
RUNS; it is not a quality measurement, and MUST NOT be read as one.

**`EngineLoader` is a test seam, not a gate.** `localRerankerAvailability(load?)` and
`localRerankScores(..., load?)` default to the real dynamic import; § 9's `m1` is about the fake
never being injected in production, which leaves one branch thinly tested and gates nothing.

Three facts were true of the code and stated nowhere. `packages/gnosis/OPTIONAL.md` § The in-process
backend is the owner and carries them in full; the two READMEs carry one clause each and route.

| Fact | Where it now appears |
|---|---|
| **The engine picks the hardware, the user does not.** `getLlama()` is called with no options, so the engine uses whatever GPU backend the installed `node-llama-cpp` was built with and the CPU when it finds none — hence no `rerank.gpu` key, and no way to hold a run on the CPU while a card is there | `OPTIONAL.md`; `README.md`; `packages/gnosis/README.md`; wizard `LOCAL_ENGINE_ADVICE.gpu` / `.cpu` |
| **On a CPU the run is long and nothing cancels it** (M1, disclosed not fixed) | the three documents, and `rerankFlow.ts:NO_TIMEOUT_WARNING` — printed beside the per-machine projection only once that projection reaches `LONG_PROJECTION_MS` (60 s), because below that the missing bound is trivia and above it the user is waiting |
| **Ranking QUALITY under `local` is UNMEASURED** — distinct from the calibration point: that one is about the PROBABILITY, this is about the ORDERING | the three documents, and wizard `RUN_MODE_CHOICES` `local.con` |

**No backend is named to the user.** Only Vulkan was observed here; whether a given
`node-llama-cpp` build carries CUDA or Metal is that package's property, and `GNOSIS-RULES.md`
§ Evidence forbids stating it from recollection. No millisecond figure entered any wizard string —
the wizard times the machine in front of it and labels the projection as a projection.

**Gate after the pass**, run sequentially: `typecheck` 0 · `gnosis:test` **1 742 passed, 103 files** ·
`bench:test` **824 passed, 34 files**.
