# Project usability review – end-user perspective

Date: 2026-08-28

## Scope
Review of README entry points for a first-time user: `README.md` root, `packages/gnosis/README.md`, `packages/gnosis-bench/README.md`, `CONTRIBUTING.md`.

## What users see first

### Install
* Not on npm registry.
* Required path today:
  ```
  git clone <repo> dp-gnosis && cd dp-gnosis && npm install
  cd packages/gnosis && npm pack
  npm install -g ./dp-gnosis-*.tgz
  ```
  Root README:28-37
* Node 22+ required.

### First search
Four commands documented:
```
dp-gnosis init ~/notes ~/work/some-project/docs
dp-gnosis ingest
dp-gnosis index --adapter fts5
dp-gnosis retrieve "bm25 length normalisation"
```
Root README:48-60

`ingest` and `index` are one operation in two commands. The second is frequently forgotten.
> An `ingest` alone leaves the index carrying the old digest, and the next query refuses with exit 3 rather than answering from a stale index.
Root README:70-72

`init` creates `~/.config/dp-gnosis/user.profile.json` and prints next commands, then README says “Then edit that profile.” Configuration schema owned by `packages/gnosis/CONFIGURATION.md`. Root README:62-68

Two gates for a file:
* `corpusRoots` decides what is READ
* path→domain rule decides what is LABELLED
Unlabelled source is refused by name. Root README:74-76

Fresh clone has no corpus. `benchmark-data/vault/atoms/` is gitignored. `index` and `answer` exit 0 with empty knowledge pack deliberately. Root README:132-138

### Query model
Lexical BM25, no embeddings.
> Ask with keywords, not with a question. Rewriting a natural-language question into keywords is the single largest measured lever on result quality.
Root README:121-124

Example mapping:
* Don't ask: `how do I start the e2e tests`
* Ask: `run e2e end-to-end playwright test command spec`
Root README:126-128

Six rules and LLM integration prompt live in `packages/gnosis/README.md` § Query rephrasing.

### Exit codes
* 0 success
* 2 bad input/usage
* 3 partial – real output produced AND something was refused
Packages/gnosis/README.md:39-45

Exit 3 is a correct outcome, not a crash. Must not be retried blindly.
CONTRIBUTING.md:54-61

Common exit 3 cases: indexState mismatched, rephrase/rerank refusal, budget skip, index-empty. Packages/gnosis/README.md:58-59

### Rerank cost
`--rerank` runs cross-encoder over top candidates, RRF fused.
Cost ~12 s per query, requires local llama-swap server with `qwen3-reranker-4b`. Refusal is exit 3, not silent fallback. Root README:102-119

### Documentation sprawl
Root README points to:
* `packages/gnosis/README.md` – CLI reference
* `packages/gnosis/CONFIGURATION.md` – profiles, domains, corpusRoots
* `packages/gnosis/AUTHORING.md` – how to author atoms
* `packages/gnosis/INTEGRATION.md` – MCP/Obsidian
* `handbook/GNOSIS-GUIDE.md` – landmines, served path
Root README:156-164

## Usability findings

* Install friction. No registry package, manual pack.
* Two-step ingest/index is a documented failure mode. Correctness over convenience.
* Profile editing required post-init, no wizard.
* Empty corpus is silent. Fresh clone exits 0 with empty results.
* Query rephrasing burden. Natural questions work poorly by design.
* Partial exit code 3 is non-standard and requires docs to interpret. `doctor` exists but discoverable only after failure.
* Command naming inconsistency: docs show `dp-gnosis <cmd>` but checkout usage is `npm run gnosis -- <cmd>`. Root README:22
* No example data / quick start. User must supply own markdown and understand corpusRoots vs domain rules first.

## Recommendations

* Provide one-liner install, e.g. publish to npm or `npx dp-gnosis init` bootstrap with demo vault.
* Merge ingest+index into default `dp-gnosis sync` with clear progress; keep separate flags for advanced users.
* Make `init` interactive: ask for corpus roots, domain mapping, profile name, write valid profile without manual edit.
* Ship tiny bundled demo corpus so first `retrieve` returns something immediately.
* Surface exit 3 with human-readable remediation in CLI output, suggest `doctor` automatically.
* Add 60-second Getting Started at top of root README: install → init demo → retrieve. Move advanced concepts later.
* Consolidate CLI help into root quick start, link detailed flag table once.
* Consider `--auto` mode that builds missing index with warning for casual users; keep strict refusal opt-in for production.

Engine is measured and correct by design. Usability gap is between correctness guarantees and first-run success for non-contributor users.
