# Usability review — end-user perspective, entered through the READMEs

Date: 2026-08-28 · Reviewer: Claude Code (Opus 5)
Scope: `README.md`, `packages/gnosis/README.md`, `packages/gnosis-bench/README.md`, plus the docs the root README routes to. Every claim below was checked against the file or the source it describes.

## The bar I am measuring against

A GitHub visitor spends well under a minute on a README before deciding to continue or leave, and the questions they need answered in that window are: what is it, why should I care, how is it different, and can I get a first result in about five minutes. For a CLI specifically: install must be one command or close to it, and there must be a copy-pasteable command *with its output shown*. ([Scientyfic World](https://scientyficworld.org/write-a-great-readme-for-open-source-project/), [jehna/readme-best-practices](https://github.com/jehna/readme-best-practices), [DEV — 14 tips for CLI apps](https://dev.to/wesen/14-great-tips-to-make-amazing-cli-applications-3gp3))

The second frame is Diátaxis: tutorial / how-to / reference / explanation are four different documents and mixing them is what makes docs feel heavy.

## What this project already does better than most

* **The value proposition lands in one line and is honest.** `README.md:5-9` — search your own markdown, or hand it to an LLM as a citable block; no embeddings, no cloud. Followed by *why* it exists: "a retrieval tool that quietly returns nothing is worse than one that fails."
* **A task table before a flag table.** `README.md:13-20` gives six one-line jobs with the command for each. This is exactly the "short command list, not a wall of arguments" that CLI guidance asks for.
* **`doctor` as a first-class command.** `README.md:82-98`, with a symptom→cause table. Most CLIs make the user guess.
* **The failure modes are pre-announced instead of discovered.** Ingest-without-index, the two gates (`corpusRoots` reads, `domainRules` labels), exit 3 as *partial*, and "a fresh clone searches nothing, and that is exit 0" (`README.md:132-136`). This is unusually high-integrity documentation.
* **Query phrasing is called out as the largest measured lever, with a before/after table** (`README.md:121-130`). Users would otherwise blame the engine.
* **The flag table is test-locked.** `tests/readmeFlags.test.ts` asserts the table equals `FLAGS` in both directions (`packages/gnosis/README.md:73-74`), so a flag can neither go undocumented nor be documented into existence. Very few projects can claim that.
* **Community-health files all exist:** `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` (Keep-a-Changelog format), `.github/workflows/ci.yml`.

## Where a first-time user gets stuck

**1. Time-to-first-result is nine commands and a manual file edit.**
Counting from the README: `git clone` → `npm install` → `cd packages/gnosis` → `npm pack` → `npm install -g ./*.tgz` → `init` → *edit the profile by hand* → `ingest` → `index` → `retrieve`. `npm pack` is the step that loses people — a non-Node-packaging user does not know what a tarball is or why they are building one. The five-minute bar is missed, and the honest "It is not on the npm registry yet" (`README.md:28`) does not soften a manual build step.

**2. The README never shows what success looks like.**
There is no sample output anywhere in the root README — no `retrieve` result line, no `answer` pack. The first rendered output in the repository appears at `packages/gnosis/README.md:262` § Worked examples, i.e. 262 lines into a 628-line reference manual. A user cannot picture the payoff before paying nine commands for it. One fenced block showing a real ranked result would be the single highest-value addition to the front page.

**3. There is no tutorial layer, only reference and explanation.**
`packages/gnosis/README.md` is 628 lines (not ~400) of exit-code semantics, a 40-row flag table where single cells run to 200 words, RM3 parameter resolution, and BM25F column weights. `CONFIGURATION.md` (332), `AUTHORING.md` (107), `INTEGRATION.md` (127) are genuine how-to guides. What is missing is the tutorial: one narrow, guaranteed-to-work path with output at each step. Today the root README tries to be tutorial *and* correctness manual on the same scroll, and correctness wins — landmines, exit-3 semantics, and the two-gate rule all appear before the user has run anything.

**4. `--rerank` is sold as the biggest lever, and the README does not say how to obtain the thing it needs.**
`README.md:100-119` quantifies the gain (nDCG 0.4894 → 0.5791 on `vault`) and states the cost — 12 s per query, a local llama-swap server. But **no file in the repository explains how to install, configure or run llama-swap**, which model files to fetch, or that it must listen on `127.0.0.1:9292` (that address only appears at `packages/gnosis/README.md:127`, inside the `--rephrase` section). The headline feature is gated behind an undocumented external dependency. Same for `--rephrase` and `--synthesize`.

**5. Three names for one tool.**
The project is `gnosis`, the binary is `dp-gnosis`, and in a checkout every command becomes `npm run gnosis -- <cmd>`. `README.md:22` handles this in one sentence, but every subsequent code block is written in only one of the two dialects, so a checkout user must mentally translate each block. Pick the checkout form for the quick start (it is the form that works right after `npm install`) and defer the global-install dialect.

**6. `init` refuses relative paths and the README does not say so.**
`initCommand.ts:101,106` rejects a relative corpus root with a good message. The README example uses `~/notes`, which the shell expands, so the rule is invisible until a user types `./docs` and is refused. One clause in the example comment would prevent it.

**7. The `enrich` command is invisible on the front page.**
`ENRICH_COMMAND` exists (`cli.ts:245`) and has a full worked flow at `packages/gnosis/README.md:292-325`, but the string "enrich" does not appear in the root README at all — not in the task table, not in "Under the hood". A whole capability is undiscoverable from the entry point.

**8. Configuration arrives before the first success.**
"**Then edit that profile.**" (`README.md:66-68`) sends the user to a 332-line schema document mid-quick-start, without showing the two or three fields a single-folder user actually has to touch. Show the minimal profile inline; keep the link for the multi-project case.

**9. The MCP selling point is thinner than the table implies.**
"Serve the vault to Claude Desktop, Cursor, Zed or opencode" is a strong hook for the target audience, but the MCP tool exposes only `question`, `k` and `domain` (`INTEGRATION.md`) — no `--rerank`, i.e. the MCP consumer cannot reach the quality lever the front page advertises. Worth stating rather than leaving to discovery.

**10. Small front-page omissions.**
No badges (Node version, license, CI status — the workflow exists). `CHANGELOG.md` and `CODE_OF_CONDUCT.md` are never linked from the README. No FAQ / "where to ask for help" section. No screenshot or asciinema cast. The `<!-- LLM-PRIMARY: … -->` comment at line 1 is invisible to a human reader but is the first thing in the raw file.

## Recommendations, in order of return on effort

| # | Change | Why it is first |
|---|---|---|
| 1 | Add a real output block to the root quick start — one `retrieve` result and one `answer` pack excerpt | Zero risk, removes the "what do I even get" gap |
| 2 | Ship a tiny demo corpus + `dp-gnosis init --demo` (or a `examples/` folder), so a fresh clone can `retrieve` something in two commands | Converts "silence, not a complaint" from a documented surprise into a non-event |
| 3 | Write the llama-swap prerequisite down: install, models, port, or a link | The advertised biggest lever is currently unreachable from the docs |
| 4 | Restructure the root README as happy path → "Common pitfalls" → links; move exit-3 semantics, the two-gate rule and PRF defaults below the first success | Progressive disclosure; keeps every correctness guarantee, just later |
| 5 | Use one command dialect in the quick start (checkout form), and show the minimal profile edit inline | Removes the two most common copy-paste failures |
| 6 | Add `enrich` to the task table; state the `init` absolute-path rule; link `CHANGELOG.md` | Three one-line fixes closing three real gaps |
| 7 | Badges row + a short FAQ ("no results", "exit 3 after ingest", "results from the wrong project") | Standard signals of a maintained project |
| 8 | Split `packages/gnosis/README.md` into a ~60-line quick reference + the full contract | 628 lines is a manual, not a page |

**Bottom line.** The engineering integrity of this documentation is above average for its class — the refusal semantics, the test-locked flag table and the pre-announced landmines are things most projects never get right. The usability gap is not accuracy, it is *sequencing*: the correctness manual is standing in front of the first success. Nothing in the list above weakens a single guarantee; every item moves one of them later on the page or supplies a missing prerequisite.
