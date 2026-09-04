# Usability review — prospective product user, docs as first-time reader

Scope: end-user usability of the project's documentation, judged as a first-time reader who lands on the GitHub repo and wants to search their own markdown vault via CLI / MCP. Docs only — no code changes, findings only. Research baseline: consensus from awesome-readme (21k★) and README best-practice literature — value prop → trust badges → demo/sample output → copy-pasteable quickstart → features → docs map → honest status.

## Verdict

The root README is unusually strong for a pre-release CLI: honest, specific, and it pre-empts the top first-run failures. The gaps are concentrated in **first-viewport trust signals** (no badges, no sample output) and a **few contradictions between what the READMEs promise and what the code does**.

## What works well

- Value prop in line 5 (`README.md:5`) — concrete, names both jobs (CLI search + citable LLM block).
- Commands-before-concepts table (`README.md:13`), honest install ("not on npm yet", two paths), honest Status section.
- "First search in four commands" plus the three landmines named *before* you hit them (ingest+index, exit 3, empty corpus).
- `doctor` + symptom→cause table (`README.md:93`) — rare and high-value at this project size.
- Measured numbers with comparability caveats (the "two rows are not comparable" note) — credibility most repos fake.
- **All referenced files exist** (SECURITY.md, CONTRIBUTING.md, the standalone-product doc, CONFIGURATION/AUTHORING/INTEGRATION, bench README), and the load-bearing claims verify against code: `init <dir> [dir…]` (`src/cli/help.ts:40`), profile at `~/.config/dp-gnosis/user.profile.json` (`src/paths.ts:230-234`), XDG data root (`src/env.ts:65-70`), `npm pack` builds dist (`packages/gnosis/package.json:38`), bin name, Node ≥ 22.

## Findings, ranked

### P1 — blocks or stalls first success

| # | Finding | Where |
|---|---|---|
| 1 | `git clone <this-repo>` is a placeholder in *both* install paths — the first command a user runs is not runnable as written. The remote is a custom SSH host (`github.com-dp-craft`), so if there's no public HTTPS URL, say that explicitly instead of leaving a template token | `README.md:34, 43` |
| 2 | **No sample output anywhere in the root README.** For a search tool, one real query→result block is the single highest-leverage trust signal. The only worked examples are ~260 lines into the engine README — and two of them contradict it (P2-1) | `README.md` (whole file) |
| 3 | No badges. CI exists (`.github/workflows/ci.yml`) but is not advertised; license appears only as prose on line 176. Users scan the first viewport for a green check + license badge before reading a word | `README.md:1-4` |

### P2 — contradicts itself or the code

| # | Finding | Where |
|---|---|---|
| 4 | Worked example 3 shows `"adapter":"linear"` for a command with no `--adapter`, while the flag table in the same file says the default is `fts5`. Example 1 (`ingest --json` → success) contradicts the same file's § Configuration, which says a bare ingest in this repo exits 2 because the default roots don't exist. A reader following the examples hits exit 2 first | `packages/gnosis/README.md:266-281` vs `:77, :391` |
| 5 | The checkout bullet promises "the data stays inside the repository", but the very next section runs `init`, which writes to `~/.config` + `~/.local/share` — and once that profile exists, **every later bare command resolves against it** (verified: `src/paths.ts:253-256`). A checkout user following both sections silently ends up with two parallel worlds and no warning | `README.md:40` vs `:48-64` |
| 6 | "The six rules" vs the pointed-to section's "The five rules:" (the LLM-prompt block has six, incl. the non-English one; the human section has five). A careful reader following the pointer lands on a different count | `README.md:130` vs `packages/gnosis/README.md:520` |

### P3 — friction / missed opportunity

| # | Finding | Where |
|---|---|---|
| 7 | The engine README is organized by contract surface, not user task. A product user who wants "search one project" or "JSON for my script" wades through ~400 lines of enrichment/PRF/analyzer/profile internals first; there's no short "common recipes" section near the top. (The file is test-locked and accurate — this is an ordering problem, not a correctness one) | `packages/gnosis/README.md` |
| 8 | The biggest quality lever (`--rerank`) depends on "a local llama-swap server" with no link, description, or pointer anywhere in the root README. For an external user that's a dead end — the repo's own skills assume you already know what llama-swap is | `README.md:114-116` |
| 9 | Three names on the first screen: `gnosis` (title), `dp-gnosis` (command), `@dp/gnosis` (package). One clarifying line would remove the "which is which" pause | `README.md:3, :34` |
| 10 | No OS/platform statement. The code supports Linux/macOS/Windows (`src/env.ts:72-90`) but a prospective user gets no signal of where it runs | `README.md:26` |

### P4 — minor

- No "why another X" one-liner (vs ripgrep/grep-based search) — common in well-received CLI projects, optional here.
- The `<!-- LLM-PRIMARY -->` header comments are a nice 2026-era touch: the docs are deliberately dual-audience (human + LLM). Worth keeping, and worth making explicit in the root README since it's a differentiator.

## Suggested priority if acting on this

1 → 2 → 3 are the three that change whether a stranger trusts the repo in the first 30 seconds; 4–6 are correctness fixes a careful reader will find anyway; 7–10 are polish.
