<!-- LLM-PRIMARY: OPEN plan (2026-08-25) — reorganize this repository into an open-source product shape: flatten `tools/` into `packages/`, rename the data root, collect the six GNOSIS-*.md into `handbook/`, add OSS scaffolding, and replace the uncommittable vault with a verified download. STRUCTURE ONLY — no ranking, retrieval or CLI-contract change. Complements docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md (phases 0-1 done); it does NOT supersede it. Read GNOSIS-GUIDE.md first. -->

# Repository reorganization for open source

**Status: OPEN.** Owner directives received 2026-08-25. Scope is **directory structure and filenames**. `.claude/`, `claude-artifacts/` and the existing `docs/` tree are explicitly out of scope.

## Relationship to the standalone-product plan

`docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md` owns the *product* phases (config, packaging, provider seam, local backend). This plan owns the *repository shape* only. Where they touch, this plan defers:

| Overlap | Owner |
|---|---|
| Dropping `REPO_ROOT` for XDG dirs | product plan phase 2 — **not here** |
| Dropping the `bench` verb / golden set from the shipped surface | product plan phase 2 — **not here** |
| `exports` map, `search()`, `bin`, `files` | product plan phase 4 — **already partly landed** |
| Directory names, file names, package layout, OSS scaffolding | **this plan** |

This plan makes the product plan's later phases cheaper by removing the AiChatney-mirroring layout first. It moves no byte of ranking code.

## Owner directives, and three challenges

| # | Directive | Resolution |
|---|---|---|
| 1 | Package name stays `@dp/gnosis` | Accepted. Directory `packages/gnosis` follows the package name's last segment. |
| 2 | Rewrite path references with `sed` | **Accepted with an anchoring contract** — see § The sed contract. A bare `s/dp-gnosis/…/g` is unsafe and is FORBIDDEN by this plan. |
| 3 | Collect governance into `handbook/` | Accepted, **move without renaming** — see challenge C. |
| 4 | Downloadable corpus; gitignore the test vault; rename `dp-gnosis/` to `dp-gnosis-test-data` or similar | Accepted in substance, **with challenges A and B**. |

### Challenge A — `test-data` is the wrong word, and the wrong word is dangerous

`dp-gnosis/` holds three things, and none of them is test data:

| Child | What it is |
|---|---|
| `vault/` | the **measured corpus** — every baseline in `GNOSIS-BASELINES.md` was produced against it |
| `cache/` | derived indexes, atom caches, and the benchmark's scratch corpora |
| `corpus-hu/` | the owner's **private source documents**, not reproducible from any repository |

Naming that tree `*-test-data` invites exactly the deletion the project already guards against elsewhere (`.gitignore` carries a standing "untracked but MUST NOT be deleted" warning over `results/` for the same reason). `tests/` also already means something else in both packages.

**Recommendation: `data/`.** Short, conventional, obviously runtime state, no collision with `tests/`, and short-lived — product-plan phase 2 relocates it to XDG dirs anyway.

**Override cost if you still want `dp-gnosis-test-data/`: one line.** `paths.ts:gnosisRoot()` plus the sed target in step 4. Everything else in this plan is unchanged. The rest of this document writes `data/`; substitute freely.

### Challenge B — `corpus-manifest.json` MUST stay tracked

"Gitignore the current test vault" is already true for everything except one file. `dp-gnosis/vault/corpus-manifest.json` is the **only** tracked file under the data root, and it carries:

```json
{ "profile": "default", "atomCount": 14706,
  "digest": "sha256:3e71ee8ed72ca6a7296ba516300236f97113f08aa371e507c68f68366db22053", … }
```

That is the verification anchor a **downloadable** corpus needs. Untrack it and a user who downloads a corpus has no way to prove it is the corpus the baselines were measured on — the download would produce something, and the pipeline would record it as data. That is this project's named recurring failure class.

**Recommendation: keep it tracked, and make it the download's checksum contract.** Step 7 builds on it.

### Challenge C — move the six governance files, do not rename them

Renaming `GNOSIS-GUIDE.md` → `handbook/GUIDE.md` multiplies churn for no gain:

- **29 tracked files** reference `GNOSIS-*.md` by name, including 11 TypeScript sources, 2 profile JSONs and `eslint.config.mjs`.
- The six files cite **each other** by bare filename constantly. Moved together and unrenamed, every sibling reference keeps resolving with **zero edits**.
- The `<!-- LLM-PRIMARY -->` routing headers name the files explicitly.

**Recommendation: `git mv GNOSIS-*.md handbook/`, filenames unchanged.** Root clutter drops from six entries to one — the whole point of the directive — while the sed surface shrinks from "every cross-reference" to "only references that were repo-root-relative". See step 8.

## The verified invariant that de-risks everything

`paths.ts`:

```ts
const srcDir = () => dirname(fileURLToPath(import.meta.url));
export const repoRoot = () => resolve(srcDir(), '..', '..', '..');
```

`tools/dp-gnosis/src/` is **three levels** below the repo root. `packages/gnosis/src/` is **also three levels**. The flatten is therefore semantically inert for every path the engine derives.

The same holds for the profile JSONs, which resolve `../../../` against their own directory:

| File | Value | Under `packages/gnosis/profiles/` |
|---|---|---|
| `hu-tax.profile.json:22` | `"repoRoot": "../../../dp-gnosis/corpus-hu"` | resolves identically |
| `web-research.profile.json:13` | `"repoRoot": "../../.."` | resolves identically |
| `*.profile.json` | `"goldIdsPath": "../golden"` | package-relative, unaffected |

**Consequence: `.trec` byte-identity remains a valid gate for the flatten.** If identity fails, something other than the move changed — which is precisely what the gate is for.

`default.profile.json:73` — `"summarySidecar": "tools/dp-gnosis/summaries/default.json"` — is repo-root-relative and is the one profile value the flatten **must** rewrite.

## Target layout

```
dp-gnosis/
├── README.md CONTRIBUTING.md CHANGELOG.md SECURITY.md CODE_OF_CONDUCT.md LICENSE
├── package.json            workspaces:["packages/*"], license:"GPL-3.0-or-later"
├── package-lock.json       ← one, not three
├── eslint.config.mjs  .editorconfig  .nvmrc  .gitignore
├── .github/workflows/ci.yml
├── packages/
│   ├── gnosis/             src/ tests/ profiles/ golden/ scripts/ README.md
│   │                       package.json tsconfig.json tsconfig.build.json vitest.config.ts
│   └── gnosis-bench/       src/ tests/ fixtures/ scripts/ README.md
│                           datasets.json charts.json bench.sh sweep.sh
│                           package.json tsconfig.json vitest.config.ts
├── handbook/               the six GNOSIS-*.md, filenames unchanged
├── docs/                   UNCHANGED — out of scope
└── data/                   dev runtime root (was dp-gnosis/), gitignored
    └── vault/corpus-manifest.json    ← the one tracked file
```

`packages/` rather than hoisting the engine to the repo root: a root-level `src/` breaks the three-level `repoRoot()` invariant above **and** demotes the benchmark, which this project treats as the gate, not a subfolder.

## The sed contract (MANDATORY)

Every rewrite in this plan obeys these five rules. They exist because the string `dp-gnosis` is overloaded six ways in this repository: the repo directory, the npm scope member `@dp/gnosis`, the workspace name `dp-gnosis-workspace`, the bench package `dp-gnosis-bench`, the skill `dp-gnosis-search`, the data root `dp-gnosis/`, and the product's prose name.

1. **MUST NOT match bare `dp-gnosis`.** Every expression MUST be anchored on a path prefix (`tools/dp-gnosis`) or a path suffix (`dp-gnosis/vault`, `dp-gnosis/cache`, `dp-gnosis/corpus-hu`).
2. **MUST drive the file list from `git ls-files -z`**, never `find` or `grep -r`. This excludes `node_modules/`, `dist/`, `data/`, `results/`, `work/`, `.venv/` and `.git/` structurally rather than by pattern.
3. **Longest pattern first.** `tools/dp-gnosis-bench` before `tools/dp-gnosis`.
4. **MUST NOT touch `packages/gnosis-bench/fixtures/`.** Those three files are the recorded byte-identity evidence the gates compare against. *Verified 2026-08-25: they contain zero occurrences of any target string, so rule 2 already excludes them by content — rule 4 is belt-and-braces.*
5. **`git diff --stat` after every sed, before every commit.** An unexpected file in the diff means an expression was under-anchored.
6. **Test files are in the blast radius of steps 2, 4 and 6.** `tests/{config,paths,query}.test.ts`, `tests/conformance.ts`, both `vitest.config.ts` files. CLAUDE.md § Test File Ownership routes modification of an existing test file through `ts-test-writer` / `tools-code-logic-writer`. A bulk `sed -i` driven by `git ls-files` sweeps them in silently. **Resolution: run each sed with `':!*test*'` excluded, then hand the test-file rewrites to `ts-test-writer` as a separate task**, or obtain an explicit exemption for mechanical path rewrites. MUST NOT be decided implicitly by the tool.

**All three expressions were dry-run against the real tree on 2026-08-25** (`sed … | cmp -s -` per tracked file, nothing written):

| Expression | Files it would change | Matches the plan? |
|---|---|---|
| Step 2 (`tools/…` → `packages/…`) | 46 | yes |
| Step 4 (data root, `golden/` excluded) | 18 | yes |
| Step 8 (`GNOSIS-*.md` → `handbook/`) | 29 total − 6 moved = **23** | yes |

**Pre-verified safety facts (2026-08-25):**

| Check | Result |
|---|---|
| Tracked files containing `tools/dp-gnosis` | 46 |
| Tracked files referencing `GNOSIS-*.md` | 29 |
| Occurrences of `tools/dp-gnosis` / `tools/dp-gnosis-bench` | 46 / 21 |
| Occurrences in `fixtures/*.trec`, `*.tsv` | **0** |
| Occurrences in any `package-lock.json` | **0** |
| Tracked binary files | **none** — every tracked file is text |

sed is therefore the right tool here. The risk was never the tool; it was the expression.

## Steps

Each step is one commit, independently revertable, with its own gate. Steps run in order.

### Step 1 — OSS scaffolding (byte-neutral)

| Change | Detail |
|---|---|
| `license` field | `"GPL-3.0-or-later"` in all three `package.json` — **currently absent from every one**, so npm reports UNLICENSED for a GPL project |
| `CONTRIBUTING.md` | build/test/gate workflow; the sequential-suite rule; the `ingest`+`index` pairing rule |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `SECURITY.md` | reporting address; note that the engine makes no network call at query time except opt-in `--rerank`/`--rephrase`/`--synthesize` |
| `CHANGELOG.md` | Keep-a-Changelog; first entry is the AiChatney extraction of 2026-08-24 |
| `.editorconfig`, `.nvmrc` | `node >=22`, matching `engines` |
| `.github/workflows/ci.yml` | `npm ci` → `typecheck` → `lint` → `gnosis:test` → `bench:test`, **sequentially**, in that order |

**Gate:** `npm run typecheck && npm run lint && npm run gnosis:test && npm run bench:test`.
**Risk:** none. No source file changes.

### Step 2 — flatten `tools/` into `packages/`

Two commits, deliberately separated so `git log --follow` sees clean renames:

```bash
# commit 2a — renames only, no content change
mkdir -p packages
git mv tools/dp-gnosis       packages/gnosis
git mv tools/dp-gnosis-bench packages/gnosis-bench
rmdir tools

# commit 2b — path strings, per the sed contract
git ls-files -z | xargs -0 sed -i \
  -e 's#tools/dp-gnosis-bench#packages/gnosis-bench#g' \
  -e 's#tools/dp-gnosis#packages/gnosis#g'
git diff --stat
```

`git mv` on a directory is a filesystem rename, so the untracked children (`node_modules/`, `dist/`, `data/`, `results/`, `work/`, `.venv/`) travel with it. **`results/` moving intact is load-bearing** — it holds the recorded `.trec` evidence this step's own gate compares against.

Then, by hand (not sed — these are structural, not textual):

- `vitest.tools.config.ts` → `packages/gnosis-bench/vitest.config.ts`, `include` becomes package-relative, `root` anchored on the config file exactly as the engine's config already does.
- Root `package.json`: `bench:test` points at the new config path.
- `packages/gnosis/dist/` is stale and references old paths — delete it; step 3 rebuilds.

**Gate:** both suites, `typecheck`, `lint`, then `npm run gnosis:bench` → **`.trec` byte-identity** against `results/`.
**Risk:** low. The three-level invariant makes identity the expected outcome, not a hope.

### Step 3 — npm workspaces, one lockfile

```jsonc
{ "name": "dp-gnosis", "workspaces": ["packages/*"] }
```

Delete the two package-level lockfiles; regenerate one at root. `README.md` drops the three-`npm install` instruction.

**⚠ Load-bearing side effect.** The engine's adapter-gated optional dependencies (`@lancedb/lancedb`, `apache-arrow`, `minisearch`) currently resolve **only** from `packages/gnosis/node_modules` — root has none of them (verified 2026-08-25). Workspaces hoist them to the root. Resolution still succeeds, but the "optional dependency absent ⇒ skip its adapter, never fail the suite" path stops being exercised incidentally by a plain install.

**Required before this step lands:** confirm that `tests/{lanceDbAdapter,miniSearchAdapter,bench}.test.ts` **force** the absent case (mocked/failed dynamic import) rather than merely observing it when the package happens to be missing. If none does, that test is a prerequisite and is written first, via `ts-test-writer`.

**⚠ Second side effect, found during review: hoisting can move ranking.** `better-sqlite3` is declared at both the root and in the engine, and `stemmer` only in the engine. Two `node_modules` trees can hold two different resolved versions of the same range; hoisting collapses them to one. `better-sqlite3` **is** the FTS5 tokenizer and `stemmer` is applied via `processTerm` to every adapter — the engine's own manifest records that a change there "would silently change ranking rather than skip a leg". A version shift is therefore a ranking change wearing an install-step disguise.

**Required:** capture resolved versions before and after.

```bash
npm ls better-sqlite3 stemmer --all > /tmp/deps-before.txt   # before
npm ls better-sqlite3 stemmer --all > /tmp/deps-after.txt    # after
diff /tmp/deps-before.txt /tmp/deps-after.txt
```

**Gate:** `rm -rf node_modules packages/*/node_modules && npm ci` → both suites → `typecheck` → `lint`, **plus** the version diff above. If any resolved version of `better-sqlite3` or `stemmer` changed, the `.trec` byte-identity gate becomes mandatory for this step — my earlier "no benchmark gate needed" was wrong.
**Risk:** medium, concentrated in the optional-dependency skip path **and** in dependency-version collapse.

### Step 4 — `dp-gnosis/` → `data/`

```bash
git mv dp-gnosis data                       # carries the tracked manifest
                                            # untracked vault/, cache/, corpus-hu/ follow
git ls-files -z | xargs -0 sed -i \
  -e 's#dp-gnosis/vault#data/vault#g' \
  -e 's#dp-gnosis/cache#data/cache#g' \
  -e 's#dp-gnosis/corpus-hu#data/corpus-hu#g'
```

Then by hand: `paths.ts:gnosisRoot()` — `resolve(root, 'dp-gnosis')` → `resolve(root, 'data')`. One line.

**Two exclusions, both deliberate:**

1. **`packages/gnosis/golden/*.json` `"frozenAt"` fields MUST NOT be rewritten.** *Corrected during review:* **13** golden files carry a `frozenAt` field; **7** of them name the data root — `"frozenAt": "dp-gnosis/vault/atoms"`, `"dp-gnosis/cache/atoms-hu"`, `"dp-gnosis/cache/bench/vault-hu/atoms"`. The rest carry a date. That records where the set **was** frozen — a historical fact about a past measurement. Rewriting it edits the measuring instrument to agree with the present, which is the same class of error as re-stamping an old benchmark row with a new `gitSha`. The rename is instead recorded as a **provenance boundary** in `handbook/GNOSIS-GUIDE.md`, following the precedent already set there for the 2026-08-24 `gitSha` boundary.

   Implementation: run step 4's sed with `git ls-files -z ':!packages/gnosis/golden'`.

2. **`hu-tax.profile.json:21` `comment:locations`** is a dated correction note describing a past defect. Leave the historical narrative; update only the live `repoRoot` / `atomsDir` / `indexPath` values on lines 22–25.

**Byte-identity holds — verified, not assumed.** Atom frontmatter stores `sources:` **profile-root-relative** (`doc/90-history/…`) and `origin_index` / `origin_count` as integers. No atom body embeds an absolute path, so a consistently-updated `repoRoot` re-ingests byte-identical atoms, the digest is unchanged, and the `.trec` output is unchanged.

**Pre-flight, in this order:**
1. `data/vault/corpus-manifest.json` reports `atomCount: 14706`, `digest: sha256:3e71ee8…`.
2. Re-ingest → re-index → manifest digest **unchanged**.
3. Only then run the benchmark gate.

**Gate:** manifest digest identity, then both suites, then `.trec` byte-identity.
**Risk:** medium — the only step that moves untracked, partly irreproducible data (`corpus-hu/` exists on one machine and in no repository). Back up `data/corpus-hu/` before running.

### Step 5 — stop shipping dev-only campaign code

`src/p70-measure.ts`, `src/p70-perk-timing.ts`, `src/p75-measure.ts` (982 lines) sit under `src/**`, which `tsconfig.build.json` includes and `files: ["dist"]` publishes. **Verified: `dist/p70-measure.js`, `dist/p75-measure.js`, `dist/p70-perk-timing.js` are in the built tarball today.** They are one-off campaign artifacts with no CLI, library or MCP entry point.

Action: `git rm` all three. They are recoverable from history; the product plan's phase 2 already lists dropping them.

**Explicitly deferred to product-plan phase 2:** `src/bench.ts`, `src/bench/` and `src/cli/benchCommand.ts`. Removing them changes the **CLI contract** (a documented verb disappears), which is a product decision, not a reorganization. They stay exactly where they are.

**Gate:** engine suite; `npm pack --dry-run` shows no `p7*` in the tarball.
**Risk:** low. `p75-measure.ts:402` and `p70-measure.ts:331` hard-code `tools/dp-gnosis/golden/golden-set.v1.json`. *Corrected during review:* step 2 runs first and rewrites those strings, then step 5 deletes the files — harmless churn. Running step 5 **before** step 2 removes 3 files from the sed surface and is the marginally better order; either is acceptable.

### Step 6 — one test convention

The engine uses `tests/*.test.ts` (70 files, plus three non-test helpers: `conformance.ts`, `conformanceChild.ts`, `flagDocsLock.ts`). The benchmark colocates `src/*.test.ts` (17 files).

**Align on the engine's convention**, not the benchmark's — three reasons, in order of weight:

1. It is the smaller move: 17 files rather than 70.
2. `tsconfig.build.json` already excludes `tests/`, and the engine's `files` array depends on that separation. Colocating would put test files inside the published `rootDir`.
3. Engine test names are behavioural (`abstainFloor`, `indexEmptyGate`, `typeExclusion`) and do not map 1:1 onto source modules, so colocation would be arbitrary for the majority of them.

```bash
mkdir -p packages/gnosis-bench/tests
git mv packages/gnosis-bench/src/*.test.ts        packages/gnosis-bench/tests/
git mv packages/gnosis-bench/src/fetch/*.test.ts  packages/gnosis-bench/tests/fetch/
git mv packages/gnosis-bench/scripts/inventory-artefacts.test.ts packages/gnosis-bench/tests/
```

Every moved file's relative imports gain one `../`. Update `vitest.config.ts` `include`, the bench `tsconfig.json` `include`, and the `eslint.config.mjs` test-override globs.

**Ownership:** the `git mv` is the orchestrator's. The **import-path edits inside the moved test files are edits to test files** and MUST go through `ts-test-writer` per CLAUDE.md § Test File Ownership. Noted because a bulk `sed -i` over `tests/` would quietly violate that rule.

**Gate:** bench suite green with the **same test count** as before the move. A drop means a file stopped being collected — the exact false-green this repo has already recorded once.
**Risk:** low, but the test-count assertion is mandatory, not optional.

### Step 7 — downloadable corpus + honest quickstart

Today `git clone && npm i && npm run gnosis -- answer "…"` returns nothing: `data/vault/atoms/` is gitignored and only the manifest is tracked. For an OSS front door that is the project's own named failure class, sitting on the README's first command.

| Change | Detail |
|---|---|
| `scripts/fetch-corpus.sh` + npm script `corpus:fetch` | downloads a published corpus tarball into `data/vault/atoms/`. **A script, deliberately not a CLI verb** — *corrected during review:* adding `gnosis corpus fetch` would be a CLI-contract change, which § What this plan refuses forbids. The verb form belongs to the product plan |
| **Verification is mandatory** | after unpacking, re-ingest and compare against the tracked `corpus-manifest.json` — `atomCount` **and** `digest`. Mismatch ⇒ **exit 3**, naming both values. MUST NOT warn and continue |
| Absent corpus | **Already correct** — `tests/indexEmptyGate.test.ts` asserts exit 3 with reason `index-empty` and a file count. *Corrected during review:* this is not new behaviour to build. The only change is the remediation **message**, which should name `npm run corpus:fetch` |
| README quickstart | fetch → ingest → index → answer, in that order |
| Hosting | GitHub Release asset on this repo. **Decision required — see Open questions** |

**Gate:** on a clean clone in a container: clone → `npm ci` → fetch → ingest → index → `answer` returns atoms; and a deliberately corrupted tarball exits 3.
**Risk:** low in code, but it is the step that decides whether a stranger can use this project at all. It is the highest-value step in the plan.

### Step 8 — `handbook/`

```bash
mkdir -p handbook
git mv GNOSIS-BASELINES.md GNOSIS-BASELINES-n40-q06.md GNOSIS-BENCH.md \
       GNOSIS-DATA-FLOW.md GNOSIS-GUIDE.md GNOSIS-HISTORY.md handbook/
```

Filenames unchanged (challenge C), so the six files' mutual references — bare filenames resolving as siblings — need **no edit at all**. Only references that were repo-root-relative change:

```bash
git ls-files -z ':!handbook' | xargs -0 sed -i -E 's#(^|[^/])(GNOSIS-[A-Za-z0-9-]+\.md)#\1handbook/\2#g'
git diff --stat   # expect ~23 files
```

**The character class MUST be `[A-Za-z0-9-]`, not `[A-Z0-9-]`.** *Caught during review by running the expression:* `GNOSIS-BASELINES-n40-q06.md` contains lowercase `n` and `q`, so the upper-case-only class matches no part of it and that file's references would have been silently left behind — a broken link in the one file whose whole purpose is to warn against misquoting it.

Then by hand:

- `README.md` — routing table points into `handbook/`.
- `CLAUDE.md` — its § Source of Truth Hierarchy and § Engine and Benchmark Work tables name these files by root-relative path and MUST be updated. *(Out of the user's stated scope as a subject, but a forced consequence of the move; it is edited only to keep existing references resolving.)*
- `.gitignore` — the standing "MUST NOT delete `results/`" comment cites `GNOSIS-BENCH.md`.
- `packages/gnosis/docs/` — six files in a second docs tree, two of them violating the repo's own `YYYY-MM-DD-HHMM-` rule (`docs/test/2026-08-11T16-22-v2-m3/`, and `docs/brainstorm/gnosis-return-format/sub-results/` which carries no date at all). **Fold into the root `docs/` tree under the mandated naming rule.** Root `docs/` is out of scope as a *subject*; receiving these six files is the minimum that removes the duplicate tree.

**Verified during review: the six files contain _zero_ markdown links** (`](path)`) — every path reference is backticked prose read as repo-relative by a human, not resolved by a link checker. Moving them therefore breaks no link, which makes challenge C safer than argued above. It also means a link-checker gate would be **vacuous here** and MUST NOT be quoted as evidence that the move was clean; the real gate is the two suites, because the filenames live in engine and bench error strings.

**Not in this step:** `handbook/GNOSIS-BASELINES.md` is **107 KB** — a data table, not a document. Splitting it into a short baselines page plus a machine-readable rows file is content work with a real risk of transcription error, and it is deliberately excluded here. Recorded as follow-up.

**Gate:** both suites green — **15** TypeScript sources and 2 profile JSONs cite these filenames in error strings, and `tests/readmeFlags.test.ts` / `tests/flagDocsLock.ts` assert doc/flag agreement.
**Risk:** zero code risk, highest reference churn. Run it last for that reason.

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | An under-anchored sed rewrites `@dp/gnosis`, `dp-gnosis-workspace`, `dp-gnosis-bench`, `dp-gnosis-search` or prose | § The sed contract rules 1 and 5; `git diff --stat` before every commit |
| R2 | Step 4 loses `data/corpus-hu/` — private, on one machine, in no repository | Back it up before the step; `git mv` of the parent is a rename, not a copy |
| R3 | Workspace hoisting silently ends optional-dependency skip coverage | Step 3 prerequisite: a test that **forces** the absent case |
| R4 | Step 6 stops collecting a test file — a false green | Assert identical test count before and after |
| R5 | Rewriting `frozenAt` corrupts the measuring instrument | Step 4 excludes `packages/gnosis/golden/` from sed; boundary recorded in the guide instead |
| R6 | Stale `packages/gnosis/dist/` referencing old paths survives the move | Deleted in step 2, rebuilt in step 3 |
| R7 | `.idea/` run configurations point at `tools/…` | Untracked and out of scope; noted so the owner can re-point them |
| R8 | The benchmark gate needs a reranker at `127.0.0.1:9292` and warm models | Warm with one direct `/v1/rerank` call before each arm; keep arms back-to-back (`GNOSIS-BENCH.md`) |
| R9 | This plan is cited later as evidence about code | Standing repo rule: a plan is accurate only about intent. Re-verify against the tree |
| R10 | **Tracked golden files leak local absolute paths.** `"frozenAt": "/home/dev/.claude/jobs/fe152fe7/tmp/atoms-fix1"` appears in `golden/`, which is in the engine's `files` array and therefore **published to npm and to the repository**. Found during review; not previously known | Out of this plan's scope to rewrite (see step 4 exclusion 1 — it is frozen provenance). **Raise as a separate decision before first publish.** The choice is between leaking a machine path and editing the measuring instrument, and it is the owner's |
| R11 | Step 4's untracked data move is not git-revertable | See § Rollback |

## Rollback

Steps 1, 2, 3, 5, 6, 7 and 8 are ordinary commits: `git revert` restores the tree, and `npm ci` restores `node_modules`.

**Step 4 is different and needs a manual reversal**, because it moves untracked, partly irreproducible data:

```bash
git revert <step-4-commit>      # restores paths.ts, profiles, .gitignore
mv data dp-gnosis               # the filesystem half git does not own
```

`data/corpus-hu/` exists on one machine and in no repository. **Back it up before step 4 runs**, and verify the backup is readable — not merely that the command exited 0.

## Verification

Per-step gates are listed above. The whole-plan acceptance, in order:

```bash
rm -rf node_modules packages/*/node_modules && npm ci
npm run typecheck && npm run lint
npm run gnosis:test          # engine — SEQUENTIALLY
npm run bench:test           # benchmark — SEQUENTIALLY
npm run gnosis:bench         # vault + vault-hu champion arm
```

1. Both suites green, **run sequentially** — concurrently they have produced a false red once already.
2. `.trec` **byte-identical** to the pre-reorganization recording. Valid criterion for every step here: the serving config does not move, and no ranking code is touched.
3. `data/vault/corpus-manifest.json` digest unchanged.
4. Clean-container smoke: clone → `npm ci` → fetch corpus → ingest → index → `answer` returns atoms.
5. `npm pack --dry-run` in `packages/gnosis`: no `p7*`, no `tests/`, no `scripts/`.
6. Every markdown link in a tracked file resolves.

## What this plan refuses

- Renaming the six governance files (challenge C) — churn without benefit.
- Rewriting `frozenAt` provenance in the golden sets (step 4).
- Removing the `bench` verb, `src/bench.ts` or `src/bench/` — a CLI-contract change owned by the product plan.
- Touching `.claude/`, `claude-artifacts/`, or the root `docs/` tree beyond receiving `packages/gnosis/docs/`'s six files.
- Splitting `GNOSIS-BASELINES.md` — recorded as follow-up, not done here.
- Any change to ranking, weights, PRF, fusion, the rerank pool, or field weights. **This plan moves no byte of retrieval behaviour, and its gate is byte-identity precisely so that claim is checkable rather than asserted.**

## Open questions

1. **Data-root name** — `data/` (recommended, challenge A) or `dp-gnosis-test-data/`? One-line difference.
2. **Corpus hosting** — GitHub Release asset on this repo, or elsewhere? Step 7 needs a URL, and the corpus is derived from AiChatney documents whose publication the owner must approve.
3. **Which corpus ships** — `vault` (14 706 atoms) is the measured one. `corpus-hu` is private and MUST NOT be published.
4. **`SECURITY.md` reporting address.**
