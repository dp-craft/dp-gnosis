# End-user usability review — READMEs and user-facing docs

**Date:** 2026-08-28 · **Scope:** root `README.md`, `packages/gnosis/README.md`, `packages/gnosis-bench/README.md`, `packages/gnosis/CONFIGURATION.md`, `AUTHORING.md`, `INTEGRATION.md` · **Persona:** CLI end user (install → ingest → query) · **Method:** full read of all six docs plus spot-verification of claims against source (`cli.ts:81-82`, `package.json`). Findings only — no files edited as part of the review.

## Framework

Judged on what end users reward in a CLI project's first touch: **first-screen clarity → time-to-first-value (visible output <5 min) → sample output ("what does it print?") → honesty about limits → progressive disclosure/navigation → trust signals**.

## Verdict

Unusually strong doc set — top-decile on honesty, refusal semantics, and measured evidence; the weakness is **onboarding friction**, not content quality. A stranger can understand what gnosis is in 30 seconds but can't *see it work* without already having a corpus, an install that may fail silently late, and zero sample output at first touch.

## What users will like (keep)

| Strength | Where |
|---|---|
| First paragraph nails value + differentiator; "refuses out loud instead of handing back a plausible empty answer" is a memorable hook | README.md:5-9 |
| Honesty as feature: "not on npm yet", "a fresh clone has nothing to search", measured 12 s/query cost, MCP cold-start 34–52 s "so a consumer does not read it as a hang" | README.md:28,132; INTEGRATION.md:75-80 |
| `doctor` symptom table turns exit codes into recovery guidance | README.md:93-98 |
| Test-locked flag table ("a flag can neither go undocumented nor be documented into existence") — rare trust signal | packages/gnosis/README.md:73 |
| Copy-paste LLM integration prompt with measured rephrasing numbers (P@10 0.20→0.80) | packages/gnosis/README.md:540-617 |
| Clear ownership map ("owns / never here") — no rotting duplicated facts | all docs |

## Findings, ranked by end-user impact

**1. No sample output anywhere in the first-touch path.** The quickstart (README.md:48-60) shows four commands but never what success looks like. For a search tool, "what does it print?" is question one; the user can't tell if it worked without reading exit-code semantics. Worked JSON exists only deep in packages/gnosis/README.md:262-288. *Highest-leverage fix: a 5–8 line sample of `retrieve` text output (or the `answer` pack) after step 4.*

**2. Quickstart assumes you already have a corpus.** `init ~/notes ~/work/some-project/docs` — a stranger with nothing to index stalls at step 1, and the explanation ("no corpus in this repo") arrives only four sections later (README.md:132). The clone's own `docs/` is ingestable markdown — "try it on this repo" would be a zero-setup demo. Also no post-install verification step (`dp-gnosis --help` / `doctor`) before the 4-command sequence, so a `better-sqlite3` native-build failure surfaces late.

**3. The CLI reference omits two real commands — including both first-run ones.** `init` and `doctor` are dispatched (packages/gnosis/src/cli/cli.ts:81-82) and the root README's quickstart depends on them, but the Commands table in packages/gnosis/README.md:62-69 lists only ingest/enrich/index/retrieve/answer/bench. A user following root → engine README looking for `init`'s flags or exit codes finds nothing. This is doc drift already realized — exactly what the test-locked flag table prevents, but for commands instead of flags.

**4. Navigation debt in the 628-line reference.** No TOC; "Query rephrasing" — documented as *the* largest quality lever — sits at line 497 after adapters/config/analyzers/profiles, and the LLM prompt at 540. A user asking "how do I get good results" scrolls past ~450 lines of reference first.

**5. CONFIGURATION.md leaves the common case thin.** §7.1 "one project" (the most frequent setup, and where `init` users land) is one sentence; the doc opens with three-layer theory instead of "here's what `init` just wrote you, here are the keys that matter".

**6. INTEGRATION.md nits.** (a) The MCP route appears checkout-only — snippets launch `<REPO>/node_modules/.bin/tsx` on `src/mcp/main.ts`, while `package.json` exports `./mcp` from `dist/`; a tarball-installed user has no documented MCP launch, yet README.md:19 lists `npm run gnosis:mcp` unconditionally. (b) `<NODE_BIN>` is declared as one of "two absolute paths that are the whole configuration" (INTEGRATION.md:47-52) but appears in no snippet.

**7. AUTHORING.md blends universal rules with this repo's history.** The §1 domain table and the 22,808-file `docs/` paragraph (AUTHORING.md:35) describe the shipped default profile; a user with their own profile reads them as applying to themselves — only a parenthetical says otherwise.

Minor: no badges (license appears only at README.md:176); `init`'s positionals ("pass markdown directories") are never explained inline.

## Proposed changes (none applied — each separately approvable)

1. Root README: add sample output + success check after the 4-command quickstart; add a zero-setup "try it on this repo" variant; one-line post-install verify.
2. Engine README: add `init`/`doctor` rows to the Commands table (or scope the table and route first-run readers); add a TOC.
3. INTEGRATION.md: document an installed-user MCP launch or state checkout-only; remove/use `<NODE_BIN>`.
4. CONFIGURATION.md: short "your first profile" section tying `init` output to the schema.
5. AUTHORING.md: visually separate universal rules from the repo-specific worked example.
