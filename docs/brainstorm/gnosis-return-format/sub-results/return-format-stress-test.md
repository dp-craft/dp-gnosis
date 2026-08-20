# Stress-test — dp-gnosis return format approaches

**Brainstorm:** [gnosis-return-format](../gnosis-return-format.md)
**Type:** stress-test
**Date:** 2026-08-20

---

Eight approaches (A1–A7 from Explore, A8 derived from the competitive research) put through five lenses: assumptions audit, failure modes, architectural ripple, second-order consequences, opportunity cost.

## A1 — One canonical object, every format a projection

**Assumptions**
- *All consumers want the same CONTENT and differ only in rendering.* Mostly true — human wants navigation topology, runner wants budget + citations, but both are subsets of one union.
- *A renderer can be written as a total function of the object.* True today (text/xml/pack all derive from the same retrieve result), and testable.

**Failure modes**
- **Renderer omission.** A field exists in the JSON, no render surfaces it → a dead producer. This repo already has a rule for exactly that (R-033: every new non-symbol producer names a consuming file or records an explicit `pending`/`claude-facing` disposition). Blast radius: small but silent, and it accumulates.
- **Union bloat.** The object becomes the sum of every consumer's wish list; the LLM-facing render then has to DROP most of it, so the real design decision migrates into the drop policy, where it is invisible and untested.

**Architectural ripple**
- `retrieveCommand.ts` is already ~1557 lines. An envelope splits the render path; the assembly and the three renderers want to be separate modules (COMMON.md §II would demand it).
- `bench` reads `--json` bytes; free hand was granted, so bench migrates. `tests/readmeFlags.test.ts` locks the flag table in both directions — a new flag vocabulary means that test moves with it.

**Second-order**
- Opens the MCP surface almost free: a canonical object + a JSON Schema *is* `outputSchema` + `structuredContent`.
- Freezes "one truth" as the architecture. That is the constraint you want frozen.

**Opportunity cost:** essentially none — this is the base that A2/A3/A8 sit on. The 80 % version is "keep today's flat shape, add fields", which buys speed and pays with a schema nobody can navigate in a year.

**Severity:** TRADEOFF (bloat is real and manageable) + RISK (renderer omission).

---

## A2 — Detail dial (`--detail pointer|snippet|body|context`)

**Assumptions**
- *The caller knows the detail it wants before seeing results.* **Partly false.** Mitigated only if size + score ship at every level so the caller can re-ask precisely.
- *Levels are ordered and nested.* True for pointer ⊂ snippet ⊂ body, **false for `context`** — context needs the ORIGIN file, which is A4's problem set in disguise.

**Failure modes**
- **Combinatorial conflict surface.** detail (4) × format (3) × grouping (flat/grouped) = 24 combinations, most of which need an explicit verdict. `--detail pointer --format xml` and `--detail pointer` on `answer` are *meaningless* — a pack with no bodies is not a pack — so each becomes another exit-2 rule in a CLI that already refuses `--flat` on `answer`, `--json` with `--format xml`, `--type` with `--exclude-type`.
- **Silent under-delivery.** A caller that asks `pointer` and forgets to resolve gets a confident-looking answer with no evidence in it.

**Architectural ripple:** `args.ts` + the README flag table (test-locked both directions) + every format renderer. Contained, but wide.

**Second-order:** the dial is the mechanism that makes both target audiences one contract instead of two. Without it, A5 becomes tempting again.

**Opportunity cost:** the 80 % version is TWO levels (`pointer` and `full`), not four. `snippet` already exists as a field; `context` is A4 work. Two levels cost almost nothing and kill most of the conflict matrix.

**Severity:** TRADEOFF, downgraded to NOTE if the dial ships with 2 levels instead of 4.

---

## A3 — Two-phase `search` → `resolve`

**Assumptions**
- *The second call is cheap.* **True, and cheaper than expected** — the handle is the atom id, atoms are one file each, so `resolve` is a read plus a guard check. No index open, no ranking.
- *The caller will actually make the second call.* **This is the dangerous one.**

**Failure modes**
- **BLOCKER-grade: confabulation from handles.** An LLM caller handed `id + title + domain + score` and no body will, under pressure, answer from the *title*. The output looks cited (it carries a real atom id), so the failure is invisible downstream — and T7.4 already records injected atom ids with citation counts, so a fabricated answer would be logged as a *successful* knowledge injection. Blast radius: wrong runner output with a credible provenance trail.
  - **Mitigation that actually works:** the pointer level must carry a `snippet`, not nothing. A grounded fragment makes fabrication visibly wrong. This collapses A3's pure-pointer level into A2's `snippet` level — which is why the two belong together.
- **Handle staleness between the calls.** Exactly what the accepted guard exists for.

**Architectural ripple:** a new command (or MCP tool) + the guard verification path. Small. `paths.ts` already owns the atoms root.

**Second-order:** this IS the MCP-native shape (a search tool returning `resource_link`s + a resource read). Adopting it buys the MCP surface later for near-zero design cost.

**Opportunity cost:** if the dial (A2) already offers `pointer`, the separate `resolve` command adds one round-trip ergonomics win for agents and nothing for humans.

**Severity:** BLOCKER for *pure* pointer-with-no-text; TRADEOFF once the pointer level carries a snippet.

---

## A4 — Origin-span-first (the tracked file is the unit)

**Assumptions — all four fail**
1. *The atom body is a slice of the origin file.* **False.** The heading is stripped by the chunker then RE-ADDED (`withHeading` → `bodyWithHeading`); comments are stripped; blank edge lines are trimmed. The scored text is not any contiguous region of the source.
2. *One atom has one origin.* **False.** Body dedupe (`bodyKey`/`firstByBody`) keeps the FIRST atom by sorted source path and drops mirrors — so the surviving atom's content also lives in files it does not point at, and `sources` is a list for exactly that reason.
3. *The end line is derivable from the body.* **False.** Comment-stripping and blank-trim mean the body's line count ≠ the source region's line count. Capturing the end requires a chunker change, not arithmetic.
4. *The heading is always in the region.* **False** in one documented case: when the heading prefix would push the body over `bodyMaxChars`, the heading is dropped.

**Failure mode:** the caller opens `docs/x.md:120-186`, reads text that is *close to but not* what was scored, and cannot tell. This is the silent-wrong-answer class the codebase elsewhere refuses outright (`indexState: mismatched` declines to answer rather than answer wrong).

**Architectural ripple (large):** `MarkdownChunk` gains an end position; `AtomFrontmatter` gains two fields → **every atom file is rewritten** → new corpus digest → mandatory reindex. Ranking impact looks nil for `fts5` (it indexes `atom.body` only) but `linear` tokenizes `frontmatter.title`, so the claim needs a measured byte-identical check, not an assumption.

**Second-order:** publishing file coordinates is a promise that is hard to withdraw; every consumer that builds a jump-to feature on it becomes a migration blocker.

**Opportunity cost:** the 80 % version is an *approximate navigation span* explicitly labelled as approximate — good enough to open a file at roughly the right place, never presented as the scored text.

**Severity:** BLOCKER as the result UNIT. TRADEOFF as an additional, honestly-labelled navigation field.

---

## A5 — Two deliberately separate contracts

**Assumptions**
- *The two consumers' needs diverge enough to justify two truths.* Weakly supported. The competitive survey found the opposite convention: MCP duplicates ONE truth into two renderings (`structuredContent` plus the same JSON serialized into a text block) rather than maintaining two contracts.

**Failure mode:** divergence — the two surfaces answer the same question differently, and the discrepancy surfaces as a bug report months later. This codebase spends real money preventing exactly this (the README flag table is asserted equal to `FLAGS` in *both* directions; CLI and bench defaults are asserted equal by `defaults.test.ts`).

**Architectural ripple:** two schemas, two test suites, two docs. Permanent tax.

**Second-order:** hard to undo — once a consumer depends on the lean machine contract, unifying means breaking it.

**Opportunity cost:** A1 + A8 delivers ~90 % of the benefit (each audience gets what it needs) at a fraction of the maintenance.

**Severity:** RISK (high maintenance, contradicts local and industry convention). ELIMINATE unless a measured need appears.

---

## A6 — Line-oriented / NDJSON

**Assumptions**
- *Streaming matters.* **Not today.** Default `k` is 5; the pool is 100 and fully materialised before the slice. There is nothing to stream.
- *`jq` composability needs NDJSON.* False — `jq` handles one object fine.

**Failure mode:** none serious; the cost is that grouping-by-document (today's default arrangement) becomes a bracketing convention rather than nesting. ripgrep proves it works (`begin`/`end` messages), so this is a real option, just not a foundation.

**Severity:** NOTE. Correct verdict: a possible `--format ndjson` *on top of* A1 later, never the data model.

---

## A7 — Quote-first (the citable unit is the quote)

**Assumptions**
- *A quote carries its own meaning.* **False for this corpus.** These atoms are predominantly markdown TABLES, rule rows and fenced code. A quoted table row without its header row is not merely thin — it is misleading. The 3.2k chunk target exists because a smaller unit under-informs.

**Failure mode:** systematic context stripping that the caller cannot see, on exactly the content type this vault is made of.

**Second-order:** it also contradicts the Anthropic precedent, which resolves granularity by chunking smaller rather than by quoting inside a block.

**Opportunity cost:** zero — the quote layer already ships as `snippet` (≤400 chars, matched-term-density window). A7 is not a new approach; it is an existing field promoted to a unit, and the promotion is what breaks it.

**Severity:** BLOCKER as a unit. ELIMINATE (already present as a field).

---

## A8 — Audience-tagged single object (derived from MCP `annotations.audience` / `priority`)

**Assumptions**
- *Audience can be assigned reliably per field.* Risky at FIELD level — every new field needs a tag decision and the tags rot.
- *…per SECTION.* Cheap and stable: `diagnostics` = both, `nav` = human, `citations` = agent, `results[].body` = both.

**Failure mode:** metadata-about-metadata rot if applied at field granularity; a mis-tagged field silently disappears from one audience's render.

**Second-order:** it is the mechanism that lets A1 refuse A5 — each audience gets its subset from one truth, and the subset rule is data, not code buried in a renderer. It also maps 1:1 onto MCP annotations if an MCP surface is built.

**Severity:** TRADEOFF at section granularity; RISK at field granularity.

---

## Cross-cutting findings (independent of which approach wins)

| # | Finding | Severity |
|---|---|---|
| X1 | **The guard must be computed at INGEST, not at retrieve.** Hashing a span at retrieve time means reading the origin file per delivered hit. Hashing at ingest and storing it in frontmatter makes retrieve free and turns `resolve` into a comparison. It also detects a change to *this span* specifically, where the corpus digest only detects "something, somewhere, changed" | NOTE (design constraint, not a risk) |
| X2 | **The guard partially duplicates `corpus_digest`.** The digest already refuses a drifted index outright (`indexState: mismatched`, no search at all). The per-span guard only earns its keep in the two-phase / pointer flows, where time passes between handing out a handle and resolving it | TRADEOFF — scope the guard to the resolve path, do not add a second global drift check |
| X3 | **R-033 applies to every new field.** This repo's own rule: a new schema field with no named consumer must record an explicit `pending`/`claude-facing` disposition. A v2 schema adds many fields at once, so the consumer table is part of the design, not follow-up work | RISK if skipped — it is the mechanism that stops union bloat (A1's main failure mode) |
| X4 | **`snippet` and `body` are already an LSP `targetSelectionRange` / `targetRange` pair, unrecognised.** Today they are two independent strings; the snippet's OFFSET WITHIN the body is not reported, so a caller cannot highlight the match inside the body it was given. One integer pair closes that | NOTE — cheap, unclaimed, and it is the fragment-relative convention both ripgrep and GitHub use |
| X5 | **Free hand on the schema does not extend to the corpus.** A frontmatter change rewrites every atom, changes the corpus digest and forces a reindex; `linear` tokenizes `frontmatter.title`, so ranking neutrality must be MEASURED, not assumed. Every recorded baseline is stated against the current corpus | RISK — gate any frontmatter change behind a byte-identical ranking check |
| X6 | **The confabulation risk (A3) is the highest-severity finding in this brainstorm** and it is not a format problem — it is a *policy* problem the format can either enable or prevent. Any level that returns identity without grounded text creates it | BLOCKER — the pointer level must carry a snippet |
