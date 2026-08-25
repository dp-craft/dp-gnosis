# Approaches evaluated — dp-gnosis return format

**Brainstorm:** [gnosis-return-format](../gnosis-return-format.md)
**Type:** approaches
**Date:** 2026-08-20

---

Eight approaches. A1–A7 generated in Explore; A8 derived from the competitive research (MCP `annotations.audience`). Each answers two questions differently: **what is the unit of a result**, and **who is the canonical consumer**.

## A1 — One canonical object, every format a projection — **CHOSEN (base)**

- **What:** the output is ONE JSON object — `query{}`, `search{}` (adapter, mode, indexState, pool, filters that ran), `results[]`, `diagnostics{}`, `nav{}`. `text`, `xml` and the `answer` pack become pure render functions over it.
- **How:** assembly is one module, each renderer another; the testable invariant is that every renderer is a total function of the object, so the formats cannot drift apart.
- **Strength:** a single contract, and it maps 1:1 onto MCP `outputSchema` + `structuredContent` if an MCP surface is ever built.
- **Weakness:** union bloat — the object becomes the sum of every consumer's wish list, and the LLM-facing render then has to DROP most of it, moving the real design into an untested drop policy.
- Complexity **M** · Reversibility **Easy** · Architectural impact **Local**
- Prior art: MCP `structuredContent` + `outputSchema`; Elasticsearch's envelope/hits split.

## A2 — Detail dial (`--detail pointer|snippet|body|context`) — **SUPERSEDED by field selection**

- **What:** one schema whose text-bearing fields fill progressively.
- **Why superseded:** the owner's observation dissolved it — *if the body is just a field you can decline, there is no "level", only a field list*. A dial is a preset over a field list, so the field list is the primitive and the dial is sugar. Kept only as the notion of a **default preset**.
- **Residual value:** the `pointer` preset survives as the default field list.
- Complexity **S** · Reversibility **Easy** · Architectural impact **Local**
- Prior art: Elasticsearch `_source` / `_source_includes` / `fields`; Qdrant `with_payload`; Cohere `return_documents`; Sourcegraph `cm`/`cl`.

## A3 — Two-phase `search` → `resolve` — **ELIMINATED**

- **What:** `retrieve` hands back handles; a separate `resolve <id…>` returns bodies.
- **Why eliminated:** with a selectable field list the body can be requested in the FIRST call, so there is nothing to pick up later. The owner's argument closes it further — a caller holding a pointer can read the file itself; gnosis resolving on its behalf adds a hop and no information.
- **What it nearly cost:** a pure handle-only response is the highest-severity risk found in this brainstorm — an LLM handed `id + title + score` with no grounded text will answer from the title, and because the answer carries a real atom id it is logged by the T7.4 injection telemetry as a *successful* knowledge injection. Mitigated permanently by keeping `snippet` in the default preset.
- Complexity **S** · Reversibility **Easy** · Architectural impact **Local**
- Prior art it would have inherited: MCP `resource_link` + `resources/read`.

## A4 — Origin-span-first (the tracked file is the unit) — **PARTIALLY ADOPTED (as fields, not as the unit)**

- **What:** results are regions of the tracked source document, atoms an implementation detail.
- **Why not the unit:** four assumptions fail — the atom body is not a contiguous slice of the source (heading stripped then re-added, comments stripped, blank edges trimmed); body dedupe means the content also lived in files the atom does not point at; the end line is not derivable from the body; and the heading is dropped entirely when the prefix would exceed `bodyMaxChars`. Every derived-corpus API in the survey refuses to publish file offsets for exactly this reason.
- **What was adopted:** `originPath` + `originStartLine` + `originEndLine` as an explicitly-labelled **source region**, never as "the scored text". The distinction is stated in the schema, because a caller cannot infer it.
- Complexity **M** · Reversibility **Medium** · Architectural impact **Cross-cutting** (chunker + frontmatter + reindex + a measured ranking-neutrality check)
- Prior art: LSP `Location`; ripgrep `line_number` + `absolute_offset`. Counter-precedent: Elastic, GitHub, Anthropic, Vectara.

## A5 — Two deliberately separate contracts — **ELIMINATED**

- **What:** an optimal human surface and an optimal machine surface, no shared schema.
- **Why eliminated:** divergence tax with no offsetting benefit. MCP's convention is the opposite — duplicate ONE truth into two renderings (`structuredContent` plus the same JSON in a text block). This repo already pays for the same property elsewhere (the README flag table asserted equal to `FLAGS` in both directions; CLI and bench defaults asserted equal).
- Complexity **L** · Reversibility **Hard** · Architectural impact **Cross-cutting**

## A6 — Line-oriented / NDJSON — **ELIMINATED as a data model, VIABLE as a later format**

- **What:** a meta line then one JSON object per hit.
- **Why not the model:** nothing to stream — default `k` is 5 and the pool is fully materialised before the slice. `jq` handles one object fine. Document grouping would become a bracketing convention (ripgrep's `begin`/`end` proves it works, so this stays available).
- **Verdict:** a possible `--format ndjson` **on top of** A1 if a streaming surface ever appears.
- Complexity **S** · Reversibility **Easy** · Architectural impact **Local**

## A7 — Quote-first (the citable unit is the quote) — **ELIMINATED**

- **What:** return the smallest quotable passage carrying the matched terms.
- **Why eliminated:** this vault is predominantly markdown tables, rule rows and fenced code — a quoted table row without its header is misleading, not merely thin. It also contradicts the Anthropic precedent, which resolves granularity by chunking smaller rather than quoting inside a block. And the quote layer already ships as `snippet` (≤400 chars, matched-term-density window); promoting that field to a unit is what breaks it.
- Complexity **M** · Reversibility **Easy** · Architectural impact **Local**

## A8 — Audience-tagged single object — **ELIMINATED**

- **What:** each section declares whether it is for the human or the agent (MCP `annotations.audience` / `priority`), and renderers filter on the tag instead of carrying hand-written include lists.
- **Why eliminated:** the owner judged it redundant once the caller already selects its own fields — metadata about metadata, with its own rot surface.
- **Residual risk carried forward:** renderer omission (a field that exists in JSON but no render surfaces). Mitigation adopted instead: **one test asserting every top-level section appears in at least one renderer** — an assertion, not a tagging system, matching the repo's existing bidirectional-lock convention.
- Complexity **M** · Reversibility **Easy** · Architectural impact **Local**

## Comparison matrix

| Dimension | A1 canonical | A2 dial | A3 two-phase | A4 origin-span | A5 two contracts | A6 NDJSON | A7 quote | A8 audience |
|---|---|---|---|---|---|---|---|---|
| Solves the core problem | **Yes** | Partial (subsumed) | Partial | Partial | Yes | No | No | Partial |
| Complexity | M | S | S | M | L | S | M | M |
| Risk level | Med (bloat) | Low | **High** (confabulation) | Med | High | Low | **High** (context loss) | Low |
| Reversible | Yes | Yes | Yes | Medium | **No** | Yes | Yes | Yes |
| Architectural side effects | Local | Local | Local | **Cross-cutting** | Cross-cutting | Local | Local | Local |
| Maintenance burden | Med | Low | Low | Med | **High** | Low | Low | Med |
| Future optionality | **Opens** (MCP) | Neutral | Opens (MCP) | Closes (hard to withdraw coordinates) | Closes | Opens | Neutral | Opens |
| Verdict | **CHOSEN** | SUPERSEDED | ELIMINATED | PARTIAL | ELIMINATED | LATER | ELIMINATED | ELIMINATED |
