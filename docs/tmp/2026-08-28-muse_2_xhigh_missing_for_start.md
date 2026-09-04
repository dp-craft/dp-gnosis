# Usability review – end-user perspective, starting at the READMEs

## First impression from the README entry points

**Root `README.md`** is the product front page. First 7 lines give a clear value prop:
* Search your own markdown from CLI / hand to LLM as one citable block
* Point at a folder → atoms → BM25 → no embeddings / cloud
* “A retrieval tool that quietly returns nothing is worse than one that fails”

That is strong. The command table in “What you can do with it” is useful.

First-time friction points that appear before any success:

* **Install is not a normal install.** “It is not on the npm registry yet” → `git clone`, `npm install`, `npm pack`, `npm install -g ./dp-gnosis-*.tgz`. Two honest paths are described, but both are developer-flavoured. Node 22+ is a requirement.
* **Empty corpus by design.** A fresh clone searches nothing and exits 0. That is correct by design, but a new user will see “silence, not a complaint” and may think it is broken.
* **Two-step ingest/index is load-bearing.** The README warns correctly: *ingest* alone leaves the index stale and the next query refuses with exit 3. That concept is explained well, but it is presented up-front together with domain labelling gates, exit 3 semantics and PRF defaults.
* **Profile editing is mandatory.** `init` creates a profile and “Then edit that profile. It is the one file that decides what is read and how it is labelled”. `packages/gnosis/CONFIGURATION.md` owns the schema. That is accurate, but it pushes configuration work into the first run.

**`packages/gnosis/README.md`** is the CLI reference. It is test-locked to `src/cli/args.ts` and contains the whole flag vocabulary, exit codes, JSON key shape, adapters, analyzers, profiles. It is exhaustive and correct, but it is not a getting-started doc – it is a reference manual.

**`packages/gnosis-bench/README.md`** is the benchmark how-to. Clear flag table, but it assumes the user already understands the engine.

Overall the repo follows the Open Source Guides pattern: README = why + quick start, CONTRIBUTING = how to contribute, separate docs for deep topics. The problem is the README mixes product overview, landmines and deep operational rules in the same scroll.

## What users like / expect in open source READMEs

From general open-source usability criteria:
* One clear value proposition in the first screen
* A 30-60 second “try it” with copy-paste commands and visible output
* Install that is one command or a clear script
* Progressive disclosure: happy path first, caveats later
* Examples of input → output
* Explicit “what you will see” and “common problems”

The project already does several of these: value prop, 4-command first search, `doctor` for diagnosis, explicit exit code table, query rephrasing rules.

## README structure, clarity, onboarding

**Strengths**

* Value prop is concise and distinct: lexical BM25, atoms, refusals not silent.
* First search is codified: `init` → `ingest` → `index --adapter fts5` → `retrieve`. `init` prints the exact next commands.
* `doctor` is promoted as read-only diagnosis with a symptom table.
* `--rerank` cost/benefit is quantified with nDCG@10 tables.
* Query rephrasing is called out as the largest measured lever, with a before/after table.
* Exit 3 is explained as *partial*, not crash, and the refusal semantics are consistent across docs.
* “Where to go next” routing table is good: CLI, CONFIGURATION, AUTHORING, INTEGRATION, BENCH, CONTRIBUTING, GUIDE.

**Pain points for a new user**

* **Density before success.** Landmines, ingest/index two-command requirement, domain labelling gates, exit 3 semantics, PRF defaults are all in the first ~80 lines. A user who just wants to try it must read a correctness manual.
* **Install friction.** No npm registry, manual tarball pack, global install. The checkout path `npm run gnosis -- <cmd>` is mentioned, but it is secondary.
* **No visual proof.** No screenshot, no sample output block, no “try with this tiny corpus”. The first successful output a user can imagine is a `retrieve` line with score/id, but it is not shown.
* **Profile editing as a surprise.** `init` is presented as the first step, then “Then edit that profile”. Users do not know what a profile contains until they open `CONFIGURATION.md`.
* **Terminology load.** atoms, corpusRoots, domainRules, indexState, PRF, RRF, rerank pool, analyzer chain – all introduced before the user has run anything.
* **Documentation sprawl.** The user is routed to 7 different docs in the first read. That is correct for maintenance, but the entry point is not a funnel, it is a map.

## Concrete recommendations

**Entry point simplification**

* Add a TL;DR block at the very top after the one-liner: “Try in 2 minutes” with a self-contained command set that uses an example folder shipped in the repo or a tiny demo corpus. Show the expected output snippet.
* Move the landmine warnings to a “Common pitfalls” section after the happy path. Keep the ingest/index warning, but phrase it as “Don’t forget step 3” rather than a correctness lecture.
* Provide a single install script / one-liner for the checkout path. E.g. `npm i && npm run gnosis -- init ./docs` is enough for first try. Defer the tarball global install to an “Install as a CLI tool” subsection.

**Progressive disclosure**

* Keep the root README to product, quick start, 3-4 examples, and links. Move the exit code table, adapter table, analyzer table, PRF details to the package README.
* Make the first search example show output: the `retrieve` line with score, `(i/n)`, id, domain, title, and an `answer` example with the knowledge pack delimiters.
* Add a “What you will see on first run” note: empty results with `indexState: unavailable` vs `ready` vs `mismatched`, and which `doctor` checks to run.

**Onboarding ergonomics**

* Provide a `dp-gnosis demo` or `dp-gnosis init --demo` that creates a tiny atoms corpus in `benchmark-data/demo/` so a fresh clone can actually search something.
* Make the profile edit step less abrupt: show the minimal profile fields a user must change for a simple single-project setup, inline, not just a link to CONFIGURATION.md.
* Add a FAQ for the three most common first-run errors: “No results”, “Exit 3 after ingest”, “Wrong project results”.

**Documentation discoverability**

* The “Where to go next” table is good. Consider a secondary table for end-users only: “I want to search”, “I want to configure”, “I want to author documents”, “I want to serve via MCP”.
* Keep the LLM-PRIMARY comments out of rendered README – they are internal and add noise for a human reader.

These changes keep the correctness guarantees the project is built around, but they separate the *first success* path from the *operational correctness* manual that currently lives in the same page.
