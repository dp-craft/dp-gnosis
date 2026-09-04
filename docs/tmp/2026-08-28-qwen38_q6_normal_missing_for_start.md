# dp-gnosis — end-user usability review (first-time human user)

Date: 2026-08-28 · Scope: full first-run chain — root `README.md` → `packages/gnosis/README.md` (628 lines) → `CONFIGURATION.md` / `AUTHORING.md` / `INTEGRATION.md`, traced as a new user would follow them. Command claims verified against `src/cli/`. Includes web research on what makes OSS dev-tools land with first-time users (changelog.com top-ten, standard-readme spec, awesome-readme, thoughtbot). Findings only — no files changed.

## Verdict

The docs are unusually honest and internally consistent — rare for a GitHub project — but they are written for an LLM reader and the maintainer of *this* vault, not for a stranger on GitHub. A first-timer can understand what gnosis is in 30 seconds, but has **no path to a first non-empty result**, and the reference doc omits two commands the front page depends on.

## What works (users will like this)

- Clear value proposition, no hype: "Search your own markdown… No embeddings, no cloud" (README.md:5-7).
- The refusal philosophy is explained as a feature, with a symptom→cause table (README.md:93-98) — strong troubleshooting UX.
- Measured claims with honest caveats ("the two rows are not comparable", "--rephrase does NOT reproduce the rules", "p=0.0727 — not significant"). This evidence culture builds trust with technical users.
- Clean doc routing: every file opens with "I want to… | Read" ownership tables; no fact is restated in two places.
- INTEGRATION.md disclosing measured first-call latency (34–52 s) preempts the #1 MCP complaint ("is it hung?").

## Friction points, ranked by bounce risk

**1. No path to a first non-empty result — the top OSS bounce point.**
Fresh clone searches nothing (README.md:132), and the quickstart's `~/notes` / `~/work/some-project/docs` don't exist on a new machine. There is no sample corpus, no `init --sample`, and **no command in the entire root README shows expected output** — a user who runs all four commands cannot tell success from failure. Research consensus: the quickstart must end with visible results in <2 min (changelog.com "top ten reasons I won't use your OSS project"; awesome-readme). This is the single biggest gap.

**2. The CLI reference omits `init` and `doctor`.**
Both exist (`src/cli/cli.ts:81-82`, `help.ts:40-41`) and the root README depends on both — `init` is step 1 of first search, `doctor` has its own section. But the engine README's Commands table (packages/gnosis/README.md:62-69) lists only ingest/enrich/index/retrieve/answer/bench; "init" and "doctor" appear nowhere in that file. The flag table is test-locked against `args.ts`, but command-level coverage is not — exactly the drift class the lock was built to prevent.

**3. Install friction, honestly stated but still real.**
Not on npm + 4-step pack install (README.md:33-37), a literal `git clone <this-repo>` placeholder (README.md:34), no verification step after global install (`dp-gnosis --version` would be one line), and no note that `better-sqlite3` is a native build that can fail on mismatched Node.

**4. Register mismatch: product docs in governance register.**
User-facing READMEs are full of MUST/MUST NOT/FORBIDDEN obligations ("Callers MUST branch on the code"), internal plan refs (`16` § 5 C7/C9 at engine README:119, `17` DoD #5 at INTEGRATION.md:44, T2.1 in AUTHORING.md), and commit hashes (`31c9523`, `9ee408d`). Every doc opens with an invisible `<!-- LLM-PRIMARY: -->` comment — an honest signal that the primary reader is an agent. The refusal semantics are the product's identity and should stay, but phrased as "what you will see", not as obligations to a stranger.

**5. Depth before value in the engine README.**
Opens with *this repo's* data layout (benchmark-data/…, gitignored paths) that don't exist on an installed machine (engine README:17-29); then a flat 40-flag wall with no "the 5 flags you need" tier; p-values and CIs before the reader's second query. Meanwhile the single largest quality lever — keyword rephrasing, ×4 precision — sits at line 497 of 628.

**6. Examples live in the author's world.**
`llama-swap model swap local server`, `run e2e playwright…` (README.md:15-16) — a newcomer searching their own notes recognizes none of it. Same in AUTHORING.md: its two-gate tables list *this repo's* prefixes (`RUNNER-`, `claude-artifacts/standards/`), so a user with their own profile from `init` can't map the rules onto their files.

**7. Small drifts.**
Root README says "The **six** rules" (README.md:130); the section it points to says "The **five** rules:" (engine README:520) — the 6-item list exists only in the LLM prompt block. License appears only at line 176; no badges, version, or help/issues pointer anywhere.

## Suggested priorities (proposed, not applied)

1. Quickstart ends with a real result: ship a tiny sample corpus (or `init --sample`), show actual `retrieve` output in the root README, swap llama-swap examples for generic ones.
2. Add `init` + `doctor` rows to the engine README Commands table; fix six/five.
3. Install block: real clone URL, a `--version` check line, one native-build troubleshooting note.
4. Register pass on the three user-facing docs: move plan/commit refs and MUST-language out (the handbook already owns that register).
5. Reorder engine README: happy path + everyday flags first, expert flags and statistics after.
