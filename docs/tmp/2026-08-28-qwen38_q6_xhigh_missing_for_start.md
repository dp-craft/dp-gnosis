# dp-gnosis — end-user usability review

- **Date:** 2026-08-28
- **Lens:** GitHub visitor evaluating adoption · hands-on CLI user · agent consumer (recommended-skill path)
- **Scope reviewed:** root `README.md`, `packages/gnosis/README.md` (628 lines), `packages/gnosis-bench/README.md`, `packages/gnosis/CONFIGURATION.md`, `packages/gnosis/AUTHORING.md`, `packages/gnosis/INTEGRATION.md`, `.claude/skills/dp-gnosis-search/SKILL.md`
- **Status:** findings only — no files touched

## Rubric (what users of a CLI project reward)

10-second value prop · quickstart that runs · **visible output** · something to try out-of-the-box · progressive disclosure · honest limits · troubleshooting · discoverable integration paths.

## 1. GitHub visitor evaluating adoption

**Works well:** value prop in one line (README.md:3); scannable command table (:11–20); measured rerank numbers with the "rows not comparable" caveat (:105–112); honesty about "not on npm yet" and "no corpus in this repo" (:28, :132).

**Gaps, ranked:**

| # | Gap | Evidence |
|---|---|---|
| G1 | **No visible output anywhere on the front page.** A visitor never sees what `retrieve` or `answer` prints. The knowledge-pack format exists but only at engine README:162–176 and in the skill file. For a CLI tool this is the single biggest adoption blocker — an input→output transcript belongs above the fold | root README has zero command output |
| G2 | **Nothing to try with.** "A fresh clone searches nothing" (:134) and the quickstart requires the user's own markdown. No sample corpus / demo path means "evaluate" can't become "try now in 30s" | README.md:132–138 |
| G3 | **Install friction + placeholder.** `git clone <this-repo>` needs manual substitution; the `npm pack` → `npm install -g ./dp-gnosis-*.tgz` flow is unusual and sits before any output is seen | README.md:34–37 |
| G4 | No badges (license/CI/node); license appears only at the very bottom (:176) | — |
| G5 | "Under the hood" jargon for a visitor — "three dense/hybrid routes exist as **measurement** routes and are deliberately not shipped" assumes insider context | README.md:146 |

## 2. Hands-on CLI user (install → first query)

Journey: clone → `npm install` → pack → install -g → `init` → edit profile → `ingest` → `index` → `retrieve`.

| # | Finding | Evidence |
|---|---|---|
| H1 | **The quickstart never shows what a profile looks like.** "Then edit that profile" (:66) points to CONFIGURATION.md, whose only worked example is the multi-project one (§7.2). A single-user `user.profile.json` sample inline in the quickstart is missing | README.md:62–68; CONFIGURATION.md:230–275 |
| H2 | **`AUTHORING.md` describes *this repo's* vault, not the user's notes.** Its gate tables are `RUNNER-`, `claude-artifacts/`, `doc/40-code-standards/…`, "22 808 markdown files under docs/" — none of which exist for someone who installed the tool to search their own folder. Universal rules (chunker sizes, `LLM-PRIMARY` summary) are interleaved with repo-specific config, so a fresh user can't tell what applies to them | AUTHORING.md:18–35 vs :59–93 |
| H3 | **llama-swap is assumed knowledge.** `--rerank` (the "largest quality lever") and `--synthesize` both need it, but no link, no one-line "what it is" — a first-time user hits a wall at the best feature | README.md:100–119; engine README:127 |
| H4 | Quickstart's implicit profile loading: after `init`, bare `ingest`/`index` (no `--profile`) suddenly operate on the user instance — never explained in the four commands | README.md:48–60 |

**Works well:** exit-3 education is repeated at every level and genuinely clear; `doctor` + symptom table (:93–98) is exactly what users want when it breaks; the "ingest+index are one operation in two commands" warning is prominent where it matters.

## 3. Agent consumer (the recommended-skill path)

| # | Finding | Evidence |
|---|---|---|
| A1 | **The `dp-gnosis-search` skill is invisible from all user-facing docs.** Grep across the repo: its only mention is in `handbook/GNOSIS-GUIDE.md:47` — a contributor governance file. The root README's "Where to go next" and INTEGRATION.md never link it. If it's the recommended agent path, an outside agent/user has no way to find it | grep for `dp-gnosis-search\|skills/` over `*.md`: 1 match |
| A2 | **MCP tool invites the wrong input.** `gnosis_answer(question)` is documented as "the question, in the words it would be searched with" and INTEGRATION.md states the surface applies *no* rephrasing — so an agent that passes a natural sentence (what the name `question` invites) silently gets suboptimal results. The tool's own description should say "pass keywords, not a sentence" | INTEGRATION.md:26, 71–73 |
| A3 | **The LLM integration prompt hardcodes checkout mode.** The copy-paste block uses `npm run gnosis -- retrieve`; an installed consumer needs `dp-gnosis retrieve`, and the block doesn't note the swap (the root README's :22 note isn't carried into it) | engine README:548 vs root README:22 |
| A4 | MCP first call is **34–52 s cold** — honestly documented (a strength), but no guidance on client timeout settings, so an agent may report a hang | INTEGRATION.md:75–80 |

**Works well:** the LLM integration prompt block (engine README:540–617) is genuinely excellent — when to call, mandatory rewrite rules with measured effect, JSON field guide, exit-code semantics, citation format, and "scores are not confidence." The skill itself encodes the measured policy well (no `--type` guessing, `-k≥5` under rerank, surface skipped atoms).

## Cross-cutting

- **C1 — Progressive disclosure breaks at level 2.** Root README (human-friendly) → "Where to go next" → a 628-line test-locked contract doc. There is no middle tier ("the 10 commands you'll actually use, with examples"). Every second-level file opens `<!-- LLM-PRIMARY: -->` and reads as spec, not guide — right for maintainers/LLMs, heavy for humans.
- **C2 — Product docs and source-repo docs are fused.** The repo is both the product and its biggest user; AUTHORING.md and parts of the engine README can't be read by a standalone user without knowing which rules are universal vs this-repo configuration (see H2).
- **C3 — Honesty is a differentiator, keep it.** Measured claims with p-values, "installable, not yet published," refusal semantics explained instead of hidden — most projects don't do this. It costs some readability but builds exactly the trust a retrieval tool needs ("a tool that quietly returns nothing is worse than one that fails").

## If you fix only five

1. **Show real output on the front page** — one `retrieve` line-render + one `answer` pack transcript (G1).
2. **Ship a tiny sample corpus or demo command** so a fresh clone is tryable in 30 seconds (G2).
3. **Link the `dp-gnosis-search` skill** from root README "Where to go next" and INTEGRATION.md (A1).
4. **Add a minimal single-user profile example** to the quickstart (H1).
5. **One line + link on what llama-swap is** in the rerank section (H3).
