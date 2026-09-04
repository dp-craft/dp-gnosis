# Usability Review — End User Perspective

## Strengths (what works well)

**1. Honest about limitations** — The READMEs don't oversell. They explicitly state "not on npm yet", "a fresh clone searches nothing", "exit 3 is not a crash", "ask with keywords, not a question". This builds trust and prevents the #1 user frustration: confusion about why it doesn't work.

**2. Clear four-command onboarding** — `init` → `ingest` → `index` → `retrieve` is a simple mental model. The "Your first search" section in the root README is the right entry point.

**3. `doctor` command** — A diagnostic command that explains what's wrong is excellent UX. Most CLIs leave users guessing.

**4. Exit codes are documented and meaningful** — 0/2/3 with clear semantics. The refusal philosophy ("fails out loud rather than returning plausible empty answers") is a real differentiator.

**5. Multiple output formats** — `text`, `json`, `xml` plus the `answer` knowledge pack format covers human reading, programmatic use, and LLM integration.

**6. MCP integration** — Serving to Claude Desktop, Cursor, Zed, opencode is a strong selling point for the target audience (developers who use AI-assisted tools).

## Concerns (what will confuse or frustrate users)

**1. Installation is non-trivial** — "Not on npm yet" forces a `git clone && npm pack && npm install -g` flow. This is a **significant friction point**. The average GitHub visitor will bounce at this. Consider:
   - A clearer one-liner or install script
   - A prominent "npm publish ETA" or "why not published" explanation
   - The `npm pack` step is unexpected — users don't know what a tarball is

**2. Three-step pipeline before first search** — `init`, then `ingest`, then `index`, then you can search. Most search tools are one step. The README warns about forgetting `index`, which proves it's a real problem. Consider:
   - Could `init` auto-run `ingest` and `index`?
   - Or at minimum, a single `dp-gnosis setup` command?

**3. "Ask with keywords, not questions" is counter-intuitive** — This is the single largest quality lever, yet it goes against natural behavior. Users *will* ask questions. The `--rephrase` flag exists but is off by default and measured net-negative. This is an unresolved tension.

**4. Documentation depth is intimidating** — The `packages/gnosis/README.md` is ~430+ lines of dense technical reference. A user who just wants to search their notes will be overwhelmed. Consider:
   - A "Quick Start" section that's 10 lines max, at the very top
   - Progressive disclosure: simple docs first, deep docs linked
   - The root README is good; the package README is a reference manual, not a tutorial

**5. No example corpus** — "There is no corpus in this repository" means a cloned user has nothing to try. Consider shipping a small example vault (even 5-10 sample docs) so users can immediately test.

**6. `--rerank` requires a local llama-swap server** — The biggest quality improvement requires running another service. This is a hidden dependency that isn't obvious until you try it.

**7. Configuration is complex** — Profiles, domains, `corpusRoots`, `config.json`, environment variables, type rules. The CONFIGURATION.md is thorough but the mental model is steep. A user with a simple `~/notes` folder shouldn't need to understand profiles.

**8. GPL-3.0 licensing** — This may limit adoption in commercial settings. Worth considering if the goal is broad adoption.

## Specific README Improvements

| Issue | Location | Suggestion |
|---|---|---|
| No visual hierarchy | Root README | Add a badge row (Node version, license, status) at top |
| Missing "Why this exists" | Root README | 1-2 sentences on the problem this solves before the feature table |
| Install section is the first wall | Root README L28-44 | Move "Your first search" BEFORE install, so users see value first |
| "Under the hood" is too technical | Root README L148 | Consider moving to a separate "Architecture" doc |
| No screenshots or output examples | All READMEs | A single terminal screenshot showing a real query result would be worth 1000 words |
| Package README too long | `packages/gnosis/README.md` | Split into: Quick Reference (top 20%) + full docs linked |

## Overall Assessment

The project is **well-engineered and honest** — the documentation quality is exceptional for a CLI tool. However, it reads like it was written **by engineers for engineers who already understand the domain**. The gap is between "someone who found this on GitHub and wants to search their markdown notes" and "someone who understands BM25, adapters, and corpus digests."

The biggest single improvement would be: **make the first 5 minutes frictionless**. Right now it takes a git clone, npm install, npm pack, npm install -g, init, ingest, index before a user sees their first result. Each step is a chance to quit.
