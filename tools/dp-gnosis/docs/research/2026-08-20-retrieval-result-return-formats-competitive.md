# Competitive Research: Retrieval result RETURN FORMATS (the data contract, not the ranking)

**Date:** 2026-08-20
**Type:** competitive
**Scope:** How six families of established search/retrieval tools shape what they hand back — unit of result, whether text ships by default, what diagnostics the caller gets, and how positions are made stable (or declared unstable).
**Consumer question this serves:** what a dual-purpose tool (human CLI + embedded agent) should copy vs. avoid.

---

## Strategic Summary

Across six unrelated families there is **one strong convergence and one genuine disagreement**. The convergence: *the payload is opt-in, the identity is not* — every machine-facing API returns an id + a score + diagnostics unconditionally, and makes the text an explicit request (`with_payload`, `return_documents`, `_source: false`, `fields`, text-match media type). The disagreement is **what a position means**: file-oriented tools (ripgrep, LSP, Sourcegraph) return real offsets into real files and accept that they perish; document-oriented tools (Elastic, GitHub, Anthropic, Vectara) refuse to hand out whole-file offsets at all and instead return either a *self-contained fragment with offsets relative to the fragment* or *opaque block indices*. The second camp exists precisely because their corpus is derived/reindexed and a whole-file offset would be a lie.

The single most transferable finding for dp-gnosis: **Anthropic's own citation format cites by opaque block index, and the docs state outright that the block is the minimal citable unit — finer granularity is a CHUNKING decision, not an offset decision.**

---

## Problem Being Solved

All six answer the same job: *"I found something; how do I hand it to you so you can (a) trust it, (b) find it again, and (c) not pay for what you don't need?"* They diverge on who the "you" is — a terminal, an editor, a program, or a language model.

---

## Competitors

### 1. ripgrep — `--json` event stream / `--vimgrep`

- **Unit returned:** a **line-group** (`match` / `context` message), scoped inside `begin`/`end` messages that bracket one file.
- **Text by default:** **yes, always** — the `lines` field carries the matched text; `submatches` carry the matched substring.
- **Position model:** dual, and deliberately so. `line_number` (1-based, "if available") *and* `absolute_offset` — the byte position in the searched data where `lines` begins. `submatches[].start`/`end` are a **half-open byte interval relative to `lines`**, not to the file. So there are three coordinate systems and each is explicitly scoped.
- **Encoding honesty:** every text-carrying field is either `{"text": "..."}` (valid UTF-8) or `{"bytes": "<base64>"}` (invalid UTF-8). The format refuses to lie about encoding rather than lossily coercing.
- **Diagnostics:** the `end` message carries a `stats` object — `elapsed` (secs/nanos/**human**), `searches`, `searches_with_match`, `bytes_searched`, `bytes_printed`, `matched_lines`, `matches`.
- **Stability:** never claimed. It is a streaming scan of a filesystem at an instant; the contract is "act now".
- **Strengths:** JSON Lines means it streams and composes with `head`/`jq` without a parser. The begin/end bracketing gives grouping *without* nesting. Statistics are separated from results by message type, so a consumer that only wants matches filters on `type`.
- **Weaknesses:** no notion of relevance at all (it is a matcher, not a ranker), and the three coordinate systems are a documented footgun.

### 2. LSP — `Location` / `LocationLink`

- **Unit returned:** a **range in a document** (`{uri, range:{start:{line,character}, end:{...}}}`). No text at all, ever.
- **Text by default:** **never.** The client already has the buffer; shipping text would be redundant and would race the editor's own state.
- **Position model:** zero-based `line` + `character`. Since 3.17 the *encoding of `character`* is negotiated (`PositionEncodingKind`: `utf-8` = bytes, `utf-16` = code units and the backwards-compatible default, `utf-32` = code points). The spec's own rationale: "conversion from one encoding into another requires the content of the file / line" — i.e. an un-negotiated offset is not resolvable without re-reading the file, which defeats the point.
- **The two-range idea (`LocationLink`):** `targetRange` = the whole scope of the thing (full declaration + surrounding context); `targetSelectionRange` = the sub-range to actually put the cursor on (usually just the identifier), and it **must** lie inside `targetRange`. Both exist because *the region a human needs to see and the point a machine should jump to are different questions.*
- **Diagnostics:** none in the result — errors are JSON-RPC level.
- **Stability:** guaranteed only against a **specific document version** the client and server both know (the `textDocument/didChange` version counter). Outside that, void.
- **Strengths:** the cheapest possible payload; the `targetRange`/`targetSelectionRange` split is the single most reusable idea in this whole survey.
- **Weaknesses:** utterly dependent on the caller holding the source. Useless to a caller that cannot read the file.

### 3. MCP — tool result conventions

- **Unit returned:** a list of **content blocks**, plus optional `structuredContent`.
- **The two ways to return a found thing:**
  - `resource_link` — `{type, uri, name, description, mimeType, annotations}`. **A pointer.** The client may fetch or subscribe. The spec warns these are *not guaranteed* to appear in `resources/list`.
  - embedded `resource` — `{type:"resource", resource:{uri, mimeType, text, annotations}}`. **The content, inline.**
- **Text by default:** the server chooses per block; the protocol supports both and takes no position.
- **`structuredContent` + `outputSchema`:** a tool MAY declare an `outputSchema`; if it does, the server **MUST** return conforming `structuredContent` and clients **SHOULD** validate it. For backwards compatibility a tool returning structured content **SHOULD also** serialize the same JSON into a `text` block. → *one truth, two renderings, and the duplication is explicit protocol policy rather than an accident.*
- **Annotations (the underrated part):** every content type supports `audience` (`["user"]` / `["assistant"]` / both), `priority` (0–1), and `lastModified`. This is a first-class way to say **"this field is for the human, that one is for the model"** inside a single payload.
- **Diagnostics:** `isError: true` for *tool-execution* failures, kept deliberately distinct from JSON-RPC protocol errors — a business-logic failure is a *result*, not a transport error.
- **Stability:** a `resource_link` URI is as stable as the server says; `lastModified` is the freshness signal.
- **Strengths:** the pointer-vs-inline choice is a first-class protocol concept, not a flag hack. `audience`/`priority` solve the dual-consumer problem head-on.
- **Weaknesses:** takes no position on *when* to link vs. embed, so every server invents its own policy.

### 4. Elasticsearch / OpenSearch — `_search`

- **Unit returned:** a **document** (`hits.hits[]`), optionally with `highlight` fragments as sub-units.
- **Text by default:** `_source` **is** returned by default, but suppressing/filtering it is first-class: `_source: false`, `_source_includes`, and the separate `fields` parameter (stored/computed field representations, distinct from filtering the original JSON).
- **Position model:** none. There are no offsets. Locality is expressed as **`highlight` fragments** — self-contained excerpts with the matched terms wrapped in markers. The excerpt *is* the position.
- **Diagnostics (the richest in the survey):**
  - `took` (ms), `timed_out` (bool)
  - `_shards {total, successful, skipped, failed}` — **partial-coverage reporting**
  - `hits.total {value, relation}` where `relation` ∈ `eq` | `gte` — *the count is explicitly typed as exact-or-lower-bound*
  - `hits.max_score`
  - per-hit `_score`, `sort`, and `_explanation` (only when `explain: true`)
  - `terminate_after` → the caller *asked* for early exit and knows results are partial
- **Stability:** `_id` is stable; nothing else is.
- **Strengths:** `hits.total.relation` is the honest-count pattern — never claim a total you didn't compute. The `_explanation`-behind-a-flag pattern keeps the expensive answer out of the default payload.
- **Weaknesses:** the response is enormous by default; the highlight fragment has no coordinates at all, so you cannot map it back into the document programmatically.

### 5. Code search — GitHub REST + Sourcegraph

**GitHub code search:**
- **Unit:** a **file** (`items[]`: name, path, sha, url, repository, score).
- **Text by default:** **no.** Match text arrives only if you request the `application/vnd.github.text-match+json` media type, which adds `text_matches[]`.
- **Position model — the key move:** a `text_matches` entry is `{object_url, property, fragment, matches:[{text, indices}]}`, and **`indices` are character offsets *relative to the `fragment`*, not to the file.** GitHub deliberately does not hand out file coordinates. The fragment is self-contained; the file is identified by `sha`.
- **Diagnostics:** `total_count`, **`incomplete_results`** (the query hit GitHub's time limit — results are partial).
- **Stability:** via the commit `sha` on each item — the *content version* is named, so the caller can resolve deterministically or detect drift.

**Sourcegraph (streaming search):**
- **Unit:** typed matches — `content`, `path`, `commit`, `diff`, `symbol`, `repo`.
- **Two granularities, selectable:** `lineMatches` (`preview`, `lineNumber`, `offsetAndLengths`) or, with `cm=true`, **`chunkMatches`** — larger multi-line segments with configurable context lines (`cl`), carrying ranges rather than per-line previews.
- **Diagnostics:** progress events with match count, repo count, duration, done/incomplete status, and **`skipped` entries carrying a reason AND a suggestion** — i.e. the API tells you how to fix your own query.
- **Also emits:** `filters` (suggested narrowings) and `alerts` as separate event types.
- **Stability:** named by repository + commit.
- **Strengths:** the line-vs-chunk **selectable granularity** is exactly the "detail dial" idea; `skipped{reason, suggestion}` is machine-actionable next-step guidance.

### 6. Vector DB / RAG citation APIs

**Qdrant** — unit is a **point**. `ScoredPoint {id, version, score, payload?, vector?, shard_key?, order_value?}`. **`payload` and `vector` are NOT returned by default** — `with_payload` / `with_vector` must be passed. Top-level: `time`, `status`, `usage` (CPU, I/O, inference tokens). *The purest expression of "identity + score always, content on request".*

**Cohere Rerank** — unit is an **index into the caller's own input list**. Each result is `{index, relevance_score}`; **the document text is not returned** unless `return_documents` is set. `relevance_score` is normalized 0–1 and the docs explicitly warn it is **not ratio-comparable** ("a score of 0.9 does not mean 2× more relevant than 0.45"). Meta carries `api_version`, `billed_units` (search_units, input/output tokens), `tokens`, `cached_tokens`, `warnings`. *The API returns a permutation, not content — the caller already has the truth.*

**Anthropic `search_result` blocks + citations** — the most directly relevant precedent:
- A search result is `{type:"search_result", source, title, content:[{type:"text", text}...], citations:{enabled}}`.
- The citation Claude emits is `{type:"search_result_location", source, title, cited_text, search_result_index, start_block_index, end_block_index}`.
- **All three positional fields are opaque indices, not offsets:** `search_result_index` = which result among all supplied, `start_block_index`/`end_block_index` = a half-open slice of that result's `content` array. `cited_text` is the concatenated text of that slice — and it is **not counted toward output tokens**.
- The docs state the rule explicitly: *"The text block is the minimal citable unit: Claude cites whole blocks, not substrings within a block. To get finer-grained citations, split your search result content into smaller blocks."*

---

## Comparison Matrix

| Aspect | ripgrep | LSP | MCP | Elastic | GitHub CS | Sourcegraph | Qdrant | Cohere Rerank | Anthropic citations |
|---|---|---|---|---|---|---|---|---|---|
| Unit returned | line-group in file | range in doc | content block | document | file | line **or** chunk (selectable) | point | index into input | block-slice of a result |
| Text shipped by default | **yes** | **never** | server's choice | yes (suppressible) | **no** (media type) | yes (preview) | **no** | **no** | n/a (caller supplied it) |
| File/doc coordinates given | yes (line + byte offset) | yes (line/char, encoding-negotiated) | URI only | **none** | **fragment-relative only** | yes (line + offset) | none | none | **opaque indices only** |
| Position stability claimed | no | only vs. doc version | via `lastModified` | n/a | via commit `sha` | via commit | n/a | n/a | within the one request |
| Partial-result signal | — | — | `isError` | `timed_out`, `_shards.failed`, `terminate_after`, `total.relation` | `incomplete_results` | `skipped{reason,suggestion}`, done/incomplete | `status` | `warnings` | — |
| Cost/usage reported | `bytes_searched`, `elapsed` | — | — | `took` | — | `elapsedMs` | `usage`{cpu,io,tokens} | `billed_units`, `tokens` | tokens (cited_text free) |
| Score returned | — (no ranking) | — | — | `_score`, `max_score` | `score` | — | `score` | `relevance_score` (0–1, non-ratio) | — |
| Explanation available | — | — | — | `_explanation` behind `explain:true` | — | — | — | — | `cited_text` |
| Human/machine split in payload | separate `human` elapsed string | — | **`annotations.audience`** | — | — | separate event types | — | — | — |

---

## Patterns (table stakes)

1. **Identity + score always; payload on request.** Qdrant, Cohere, GitHub and Elastic all default to or make trivial the "no text" mode. Only ripgrep — which has no id to give — always ships text.
2. **The count is typed, not asserted.** `hits.total.relation: eq|gte`, `incomplete_results`, `limitHit`, `terminate_after`. Nobody returns a bare number and calls it the truth.
3. **Partial results are a first-class value, not an error.** Every one of them distinguishes "I finished and found N" from "I stopped early". (dp-gnosis already does this correctly with exit 3.)
4. **Diagnostics live in an envelope, separate from results.** `stats` on the `end` message, `took`/`_shards`, `meta`/`billed_units`, `usage`. Never interleaved into hits.
5. **Expensive explanations sit behind a flag.** `explain: true`, `return_documents`, `with_payload`, the text-match media type.
6. **Scores are published with a warning label or not at all.** Cohere ships the anti-ratio warning in the reference docs itself.

---

## Where they genuinely disagree

| Question | Camp A | Camp B |
|---|---|---|
| **Do you hand out file coordinates?** | **Yes** — ripgrep, LSP, Sourcegraph. Their corpus *is* the file, the caller can read it, and the offset is the cheapest possible payload | **No** — Elastic, GitHub, Anthropic, Vectara. Their corpus is *derived* (analyzed, chunked, embedded), so a file offset would describe something they did not actually search. They return a **self-contained fragment** or an **opaque index** instead |
| **What is the citable unit?** | The span you computed (LSP `targetSelectionRange`) | The chunk you indexed (Anthropic: "the block is the minimal citable unit") |
| **Is the fragment's coordinate system the file or itself?** | The file (ripgrep `absolute_offset`) | **Itself** (GitHub `indices` relative to `fragment`; ripgrep's own `submatches` are also fragment-relative — ripgrep is in *both* camps and says so) |
| **One payload for both audiences, or two?** | One, tagged (`MCP annotations.audience`/`priority`) | Two renderings of one truth (`structuredContent` + a serialized `text` block; ripgrep `elapsed.human` beside `elapsed.secs`) |

**The camp split is not aesthetic — it tracks whether the returned text is byte-identical to a slice of a tracked file.** Everyone whose pipeline transforms the text before indexing it refuses to publish file offsets.

---

## Gaps & Opportunities

- **Nobody solves the dual-consumer problem well except MCP, and MCP only names it.** `audience`/`priority` annotations are a declared mechanism with no convention for using them. A tool that ships *one* object with per-field audience tagging, and derives both the human render and the agent payload from it, would be ahead of all six.
- **Nobody pairs a perishable position with a cheap validity guard.** GitHub gets closest (commit `sha` on the item) and Elastic/LSP simply scope validity to a version. A retrieval tool that returns `line span + a short content hash of that span`, so a stale resolve **fails loudly instead of reading the wrong lines**, is unoccupied ground and cheap to build.
- **Only Sourcegraph makes the "what should I do next" signal machine-actionable** (`skipped{reason, suggestion}`). Everyone else leaves the caller to infer it. A `note` that is a typed object rather than prose is a small, high-leverage differentiator for an agent consumer.
- **Only LSP separates "the region to show" from "the point to jump to".** Every retrieval tool collapses them. For a chunk-based retriever the equivalent pair — *the chunk you scored* vs. *the sentence that earned the score* — is exactly the snippet/body relationship, and treating it as a coordinate pair rather than two independent strings is unclaimed.

---

## Differentiation Options

1. **Ship a typed detail dial (Sourcegraph's `cm`/`cl`, generalized).** Tradeoff: the caller must choose before seeing results; mitigated by always returning size + score so it can re-ask.
2. **Adopt "identity always, text on request" as the DEFAULT for the machine surface (Qdrant/Cohere).** Tradeoff: breaks the one-round-trip ergonomics humans expect from a CLI — so the default must differ per surface, which needs one contract with two defaults, not two contracts.
3. **Publish positions in the *derived* coordinate system, not the file's, plus a validity guard (GitHub + a hash).** Tradeoff: the caller cannot `sed -n` the origin file blindly; it must resolve through the tool or verify. That is the price of not lying.
4. **Tag every field with an audience (MCP annotations) and derive both renders.** Tradeoff: a heavier schema and a discipline to maintain; buys immunity from human/machine divergence.

---

## Implementation Context

<claude_context>
<insights>
- table_stakes: envelope-separated diagnostics; typed/qualified result counts (exact vs lower-bound); explicit partial-result signalling distinct from failure; score published with an interpretation caveat; expensive fields behind explicit request.
- differentiators: per-field audience tagging (MCP-style) with derived human + agent renders; perishable position paired with a cheap content-hash guard that fails loudly; typed machine-actionable next-step object instead of prose notes; explicit `region-to-show` vs `point-that-matched` coordinate pair (LSP LocationLink, generalized to chunk vs snippet).
- avoid: publishing whole-file offsets for text that was transformed before indexing (every derived-corpus API in the survey refuses to); shipping a bare total with no exactness qualifier; two independently-maintained contracts for human and machine (MCP explicitly duplicates ONE truth instead).
</insights>
<technical>
- common_patterns: JSON-Lines streaming with typed messages (ripgrep, Sourcegraph SSE); half-open intervals for every range (ripgrep submatches, Anthropic block indices, LSP); fragment-relative offsets for self-contained excerpts (GitHub, ripgrep submatches); content-version anchoring (GitHub sha, LSP document version).
- opportunities: content-hash-guarded perishable spans (nobody does it); one canonical object + audience-tagged projections (MCP names the mechanism, nobody has a convention); typed `skipped`/`next-action` objects (only Sourcegraph, and only as prose suggestions).
- integrations: MCP resource_link is the natural wire form for a pointer-mode result; MCP outputSchema + structuredContent is the natural wire form for a canonical JSON object; LSP Location is the natural wire form for an origin-span result.
</technical>
<positioning>
- underserved: callers that must decide what to READ before paying to read it (only Qdrant/Cohere serve this, and neither is a document retriever); callers that store a citation and resolve it later (only GitHub's sha and Anthropic's within-request indices address it, from opposite ends).
- overserved: rich highlight/snippet rendering — every one of the six has an excerpt mechanism and they are all roughly equivalent.
</positioning>
</claude_context>

## Sources

- grep-printer `JSON` printer (ripgrep JSON Lines format): https://docs.rs/grep-printer/latest/grep_printer/struct.JSON.html — accessed 2026-08-20
- LSP 3.17 specification, Location / LocationLink / PositionEncodingKind: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#location — accessed 2026-08-20
- MCP specification 2025-06-18, Server / Tools (tool results, resource links, structuredContent, annotations): https://modelcontextprotocol.io/specification/2025-06-18/server/tools — accessed 2026-08-20
- Elasticsearch Search API response body: https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html — accessed 2026-08-20
- Sourcegraph streaming search API result shape: https://sourcegraph.com/docs/api/graphql/search — accessed 2026-08-20
- GitHub REST search API (code search, text-match media type): https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28 — accessed 2026-08-20
- Anthropic search result content blocks + citations: https://platform.claude.com/docs/en/build-with-claude/search-results — accessed 2026-08-20
- Cohere Rerank API reference: https://docs.cohere.com/reference/rerank — accessed 2026-08-20
- Qdrant Query Points API reference: https://api.qdrant.tech/api-reference/search/query-points — accessed 2026-08-20
