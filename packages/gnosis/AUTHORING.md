<!-- LLM-PRIMARY: How a markdown document becomes a retrievable gnosis atom — the two gates (scope, then labelling), the path→type table, the chunker's size rules, which frontmatter the author actually controls, and the pre-save checklist. Every rule is checkable before the file is saved. The CLI contract is in packages/gnosis/README.md. -->

# Authoring for retrieval — how a document becomes an atom

A document that fails any rule below is not "ranked badly" — it is **unreachable**, usually with no error at query time. This file is the checklist that prevents that.

File paths named here (`src/config.ts`, `src/chunker.ts`, …) are relative to `packages/gnosis/`. The CLI that applies these rules is `packages/gnosis/README.md`.


Every rule below is checkable **before the file is saved**. All of them are derived from `src/config.ts`, `src/chunker.ts`, `src/ingest.ts`, `src/atom.ts`, `src/retrievability.ts` — not from intent.

## 1. Rule zero — location decides everything

A file must clear **two independent gates**, in order. Scope (what `ingest` reads) and labelling (what a read file is tagged) are separate decisions.

| Gate | Owner | Failure |
|---|---|---|
| **Scope** — is the path under a corpus root? | the loaded profile's `corpusRoots` (`DP_GNOSIS_CORPUS_ROOTS` overrides it for one run; with neither, `CORPUS_ROOTS` in `src/config.ts`, which ships EMPTY — a scope is never guessed) | never read, never reported |
| **Label** — does a prefix claim it? | the profile's `domainRules`, longest prefix wins | `x_domain` is `undefined` → the document yields **zero** candidates; reported once in `skipped[]`, run exits 3 |

An unlabelled document is **dropped whole** — never chunked, never indexed, never retrievable. A caller querying for it gets a normal exit 0 and other atoms; there is **no error at query time**.

**Both gates read YOUR profile, not a shipped path table.** `dp-gnosis init <dir…>` writes one: every directory you name becomes a `corpusRoots` entry AND a `domainRules` prefix claiming it, under a domain named after the directory. So a document is in scope and labelled exactly when it sits under one of the directories you declared. `CONFIGURATION.md` § 3 owns the assignment rules and § 4.1 owns what a prefix is matched against.

| Profile key | Decides | Written by `init` as |
|---|---|---|
| `corpusRoots` | which directories `ingest` walks | one entry per directory you named |
| `domains` | the closed domain vocabulary | one label per directory, derived by `domainOf` (`src/instance.ts`) |
| `domainRules` | path prefix → domain | one `{ prefix, domain }` per directory |
| `typeRules` / `segmentRules` | path prefix / path segment → `type` | **empty** — every source falls to `defaultType` until you add rules |
| `excludePaths` | paths dropped BEFORE anything is read | absent unless you declare it |

`excludePaths` is how a generated subtree stays out of the corpus without narrowing the root above it — machine output ingested nowhere and counted nowhere. A DIRECTORY entry MUST carry a trailing slash, because the match is a plain `startsWith` prefix on the source's identity: `docs/benchmarks/` MUST NOT swallow the sibling `docs/benchmarking/`.

## 2. Type table — what the directory says the document is

Types come from the same profile: `typeRules` (path prefix, longest wins) and `segmentRules` (a whole path SEGMENT, checked first and **overriding every prefix rule**). Anything unclaimed falls back to the profile's `defaultType` — `DEFAULT_TYPE` (`src/instance.ts`) is `knowledge`.

The type VOCABULARY is closed, and it is not open by profile the way domains are: `DECLARED_TYPES` (`src/config.ts`) is what every filter, adapter and `--type` flag is typed against, and a profile disagreeing with it is refused at startup. A rule may only name a type from that list:

| `type` | What it is for / what query it answers |
|---|---|
| `knowledge` | fallback prose — the type nobody filters on |
| `adr` | ratified decision |
| `standard` | reference / normative rule |
| `runner-rule` | normative rule for an agentic runner |
| `plan` | intended work — accurate about intent only |
| `research` | prior art, surveys, external investigation |
| `paper` / `vendor-doc` | external paper · external published doc |
| `teaching` | teaching material |
| `meta` | vault conventions |
| `feature-log` | development history |
| `benchmark` | measured run |
| `review` | found defects |
| `lessons-learned` | what a completed piece of work taught |
| `brainstorm` | pre-decisional exploration — **not ratified** |

Four of them — `feature-log`, `benchmark`, `review`, `brainstorm` (`DEFAULT_EXCLUDED_TYPES`, `src/instance.ts`) — are what `init` writes into `defaultExcludedTypes`, so an unfiltered `search` subtracts them. They stay ingested and indexed; it is a presentation default, not a corpus one.

## 3. Structure rules — the chunker decides where atoms begin

The chunker strips the document's own YAML frontmatter, then splits on **heading boundaries**; a `#` inside a fence never splits. Each chunk becomes one atom.

| Constant | Value | Effect on a section |
|---|---|---|
| `ATOM_MIN_CHARS` | 200 | under-floor body is **merged into a neighbour in the same heading branch** — it loses its own atom and its own title |
| `ATOM_CHUNK_TARGET_CHARS` | 3200 | packing target when a section must be sub-split |
| `ATOM_MAX_CHARS` | 4000 | over-cap section is sub-split into parts titled ` (i/n)` |
| `ATOM_FENCE_MAX_CHARS` | 8000 | `bodyMaxChars` returns this **only when the body's first content line opens a fence** (one leading `# chain` line is skipped first) — otherwise 4000. Above 8000 even a fenced block is split |

The body of every atom is prefixed with `# <heading chain joined by " > ">`; the prefix is dropped when it would push the body over its cap. Content preceding the first heading becomes a chunk whose chunk-title is `(preamble)`.

Author rules that follow mechanically:

| MUST | Why |
|---|---|
| Give every section a heading | a heading boundary is the only place an atom can begin |
| Keep a section at or under ~3200 characters | over 4000 it is cut into ` (i/n)` parts that each stand alone |
| Give a section at or over 200 characters of prose | under the floor it is absorbed and its heading text may survive only inside another atom's body |
| Put an oversize indivisible figure in ONE fenced block | a fence-opening body gets the 8000 cap; unfenced, it is cut at 4000 |
| Give a section prose of its own | a section whose body is empty once HTML comments are stripped is **refused** with a reason (it would index nothing) |

## 4. Metadata the author actually controls

| Atom field | Where it comes from | Author-settable? |
|---|---|---|
| `title` | the chunk's **leaf heading**; promoted to the full `>`-joined chain only when that leaf heading is ambiguous across source files; ` (i/n)` appended for a split section. An empty resolution falls back to the **document title** = source frontmatter `title:` → else first H1 → else filename stem (hyphens → spaces) | via headings |
| `summary` | the **first** `<!-- LLM-PRIMARY: … -->` comment anywhere in the document, whitespace-collapsed; copied onto **every** atom of that document; omitted when absent | yes |
| `x_domain` / `type` | path alone (§1, §2) | by location only |
| `sources` | the repo-relative source path | no |
| `status` | ingest writes `stable` for **every** atom, unconditionally | **no** |
| `stale_after` | ingest never emits it | **no** |

`isRetrievable` excludes an atom only when `status` is `deprecated` or `stale_after` is strictly past. Ingest produces neither, so **writing a `status:` or `stale_after:` field into a source document does nothing** — the source frontmatter is stripped by the chunker, and only its `title:` is read. Measured: 0 atoms in the vault carry a non-`stable` status. Lifecycle control is a Wave-2 concern; MUST NOT be authored today expecting effect.

## 5. Pre-save checklist

1. Is the path under one of the profile's `corpusRoots`, and outside every `excludePaths` prefix?
2. Does a `domainRules` prefix claim it, so `x_domain` resolves?
3. Does the directory give the `type` a caller would filter on, or does it silently fall back to `knowledge`?
4. Does every block of prose sit under a heading?
5. Is every section between 200 and ~3200 characters, with any oversize figure inside a single fence?
6. Does the document carry an `<!-- LLM-PRIMARY: … -->` line as its summary?
7. Is any section's whole body an HTML comment (it would be refused)?

**Consolidation is proposed, not implemented.** `docs/benchmarks/2026-08-13-dp-gnosis-hu-en-measurement-results.md` §9.5 proposes collapsing the 12 types into **7** (`feature-log`, `record`, `reference`, `explanation`, `brainstorm`, `decision`, `tutorial`; origin moved to a separate `project` axis) — the revision that supersedes the earlier 12 → 6 form in the same section on measured grounds. Nothing of it is in the code; `DECLARED_TYPES` above is what runs.

**The measured stake.** A `type` filter carrying the *correct* type is the single largest quality lever measured: recall@10 0.5353 → 0.6552, **+12 recall points** on the 11k English repo corpus (oracle ceiling, §4 of the same report). A *wrong* type returns **0.0000 recall in 1 498 of 1 498 cells** (M1, §9.5). A misfiled document is therefore not mislabelled — it is unreachable under any type-filtered query.
