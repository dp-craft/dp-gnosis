<!-- LLM-PRIMARY: The dp-gnosis retrieval path typed hop by hop, plus where the stemmer, tokenizer, BM25 and each index artifact actually live — read this to decide WHICH hop and WHICH file a change belongs to. Routed from GNOSIS-GUIDE.md § Architecture. -->

# Gnosis Data Flow — the path, typed

Read this to locate WHICH hop a change belongs to. The prose data flow and the stage contracts are in `GNOSIS-GUIDE.md` § Architecture; this file types the same path and names where each concern is implemented.

## 1. The hops

| # | Hop | Symbol (file) | In → Out |
|---|---|---|---|
| 1 | read source | `ingest` (`ingest.ts`) | path → `string` |
| 2 | chunk | `chunkMarkdown` (`chunker.ts`) | `string` → `readonly MarkdownChunk[]` |
| 3 | re-add heading | `bodyWithHeading` (`ingest.ts`) | `MarkdownChunk` → `string` |
| 4 | serialize | `serializeAtom` (`atom.ts`) | `AtomFrontmatter × string` → `string` |
| 5 | write + guard | `writeAtom` (`ingest.ts`), gated by `roundTripError` (`validate.ts`) | `string` → file on disk. The ONLY I/O hop, which is why it is absent from the all-`string` list below |
| 6 | parse | `parseAtom` (`atom.ts`) | `string` → `ParseAtomResult` → `Atom` |
| **7** | **analyze — INDEX side** | § 2 — four implementations | `string` → `string` \| `readonly string[]` |
| 8 | build index | § 4 — four artifacts | → `.db` \| Lance table \| JSON \| `CorpusScan` |
| 9 | CLI query | `runRetrieveCommand` (`cli/retrieveCommand.ts`) | → `string` (RAW; `buildQuery` has NO caller) |
| **10** | **port** | `KnowledgePort.retrieve` (`port.ts`) | `string × RetrieveOptions` → `RetrievalResult` |
| **11** | **analyze — QUERY side** | § 2 — same four, again | `string` → adapter-specific |
| 12 | score | § 3 — four BM25 implementations | → `readonly RetrievedAtom[]` |
| 13 | result | per adapter | → `RetrievalResult {atoms, mode, indexState}` |
| 14 | rerank (opt) | `rerankAtoms` (`rerank.ts`) | RAW query again × atoms → `RerankOutcome` |
| 15 | fuse | `fuseRanking` (`rerank.ts`) | → `readonly FusedItem<T>[]` |
| 16 | budget | `applyBudget` (`cli/retrieveCommand.ts`) | → `BudgetedResult` |
| 17 | render | text \| json \| xml | → `CommandOutcome` |

**Hops 1, 3, 4, 6, 7, 9, 10, 11 are ALL `string`.** No type distinguishes raw markdown / atom body / analyzed text, nor raw query / analyzed query. Branding that state: `claude-artifacts/standards/TS-BRANDED-TYPES.md`.

**Hops 7 and 11 are ONE operation at two points, implemented FOUR times** — because hop 10 passes `string`, so every adapter re-analyzes. The `KnowledgePort` docstring says *"query construction lives ABOVE the port, never inside an adapter"*, yet ANALYSIS lives inside all four. The "single stemmer" is a convention four files honour, not a structure: a change to hop 7 MUST be mirrored in hop 11 for every adapter, and nothing enforces it.

## 2. Analysis — the stemmer and the tokenizers (hops 7 + 11)

**Owner:** `query.ts` — `tokenize`, `TermProcessor`, `stemTerm`, `stemText`. Every adapter imports from here; none defines its own stemmer.

**The chain is data, not a function body.** `Stage = (tokens: readonly string[]) => readonly string[]`; text enters as `[text]` and `analyze` reduces the stages, so order is a config edit. Four named chains in `ANALYZERS`:

| Id | Stages | Use |
|---|---|---|
| `porter-fold` | split · lowercase · fold · stem | **DEFAULT — today's behaviour, bit-identical** |
| `porter-nofold` | split · lowercase · stem | isolates folding |
| `nostem-fold` | split · lowercase · fold | isolates stemming |
| `nostem-nofold` | split · lowercase | neither |

`splitTokens` admits `\p{M}` where `tokenize`'s `NON_WORD_RE` does not: `tokenize` folds BEFORE splitting, a chain splits FIRST, and without admitting marks a decomposed `café` would fragment mid-word. `foldTokens` drops the stranded marks. MUST NOT "simplify" that class back.

| Symbol | Does |
|---|---|
| `tokenize` | lowercase → NFD diacritic fold → split on `[^\p{L}\p{N}]+`. **Three responsibilities in one function**, and folding is unconditionally BEFORE stemming. Kept for the three adapters that still call it |
| `stemTerm` | Porter (1980) via npm `stemmer` — **English only**, applied to every adapter and every language |
| `stemText` | `tokenize(text).map(stemTerm).join(' ')` — equals `analyzeToText(text, 'porter-fold')`, proven over 300 real bodies |
| `analyze` / `analyzeToText` | Run a NAMED chain; default `porter-fold` |

| Adapter | Hop 7 (index side) | Hop 11 (query side) |
|---|---|---|
| `fts5` | `analyzeToText(body, analyzer)` in `writeEntries`; the id is **stamped into `index_meta`** in the same transaction | `toMatchExpression` per WHITESPACE CHUNK, with the id **READ BACK from the stamp** — `Fts5AdapterOptions` has NO analyzer field, so the query side cannot be told, only derived. Missing stamp = `porter-fold` (the only chain that ever existed); unknown stamp fails loudly |
| `lancedb` | `stemText(entry.body)` into `BODY_FIELD` | `stemText(query)` |
| `linear` | `tokenize(title + body).map(processTerm)` | `queryTerms` — `tokenize(query).map(processTerm)` |
| `minisearch` | MiniSearch `processTerm` option = `stemTerm` — the library applies it on both sides | same |

**Two tokenizers run in series on `fts5` and `lancedb`.** Ours runs first (inside `stemText`), then the engine's own runs over the already-stemmed output: SQLite `unicode61` for fts5, and Lance's `baseTokenizer:'simple'` for lancedb. Both engines have their own stemmers **deliberately disabled** — fts5 keeps `unicode61` rather than its bundled `porter`, and lancedb sets `stem:false`, `asciiFolding:false`, `removeStopWords:false` — precisely so `query.ts` stays the ONLY stemmer. MUST NOT enable an engine-side stemmer; it reintroduces a second, invisible analyzer.

`linear` is the only adapter with a swappable analyzer today (`processTerm?` option, defaulting to `stemTerm`); `minisearch` accepts one too. `fts5` and `lancedb` hard-import `stemText` — but the call is JS-side, **not** a SQLite or Lance constraint.

## 3. BM25 — four implementations, not one

| Adapter | Implementation | k1 / b | Indexed text |
|---|---|---|---|
| `fts5` | SQLite built-in `bm25(atom_fts)` | 1.2 / 0.75 **compiled into SQLite**, no setter exists | `atom.body` only |
| `linear` | Own TS — `scoreTerm`, `lengthNorm`, `idf` | `BM25_K1=1.2` / `BM25_B=0.75`, **overridable** per instance via `Bm25Params` | `frontmatter.title` + `atom.body` |
| `minisearch` | MiniSearch's own | its own defaults; boost / fuzzy / prefix all unset | `BODY_FIELD` |
| `lancedb` | Lance/Tantivy FTS | its own | `BODY_FIELD` |

`linear`'s formula, the only one written in this repo:

| Part | Form |
|---|---|
| IDF | `ln(1 + (N − df + 0.5) / (df + 0.5))`, smoothing from `BM25_IDF_SMOOTHING` (`config.ts`) |
| Length norm | `1 − b + b × length / avgLength`, where `length` = **token count** |
| Term score | `weight × freq × (k1 + 1) / (freq + k1 × norm)` |

**The same IDF formula is written twice** — `idf` in `query.ts` (private, reached only by `buildQuery`, which has NO production caller) and again in `linearScanAdapter.ts`. Only the constant is shared. Changing one does not change the other.

**MUST NOT read an adapter delta as a scorer delta** — they differ in parameters, tokenizer AND indexed text simultaneously. See `GNOSIS-GUIDE.md` § Adapters.

## 4. Index artifacts — what hop 8 actually writes

| Adapter | Artifact | Persisted | Shape |
|---|---|---|---|
| `fts5` | SQLite file at `indexPath` | disk | `atom_meta(rowid, id, path)` + `atom_fts` VIRTUAL `fts5(body, content='', detail=full)` + `index_meta(key, value)` carrying the analyzer id |
| `linear` | `CorpusScan {docs, avgLength, docFreq}` | **memory only** | rebuilt per retrieve unless `cacheCorpusScan` |
| `minisearch` | MiniSearch `toJSON` / `loadJSON` | disk | loaded, **never rebuilt in-process** |
| `lancedb` | Lance table + FTS index | disk dir | `BODY_FIELD`, `FTS_INDEX_OPTIONS` |

**`content=''` makes the fts5 table CONTENTLESS** — it stores the index, never the text. That is why the port rule says the returned `body` MUST be re-read from disk at call time: the index structurally cannot return it. `detail=full` keeps positions, which is what makes phrase queries work.

`atom_meta.rowid` = insertion order (`index + 1`), joined to `atom_fts.rowid`. `buildFts5Index` rebuilds **wholesale** so the same corpus always yields the same rowids, hence the same ranking.

**Ordering:** `bm25()` returns MORE NEGATIVE for a better match, so plain ASC is best-first. Bare `bm25()` ties are non-deterministic → `ORDER BY bm25(atom_fts), m.rowid`, then the port re-tiebreaks `(score DESC, atomId ASC)` so every adapter orders identically.

## 5. Freshness — every staleness check is mtime-based

| Check | Symbol | Predicate |
|---|---|---|
| fts5 index state | `resolveState` / `isStale` | index file `mtimeMs` vs newest atom `mtimeMs` (sampled at most once per adapter instance) |
| fts5 handle cache | handle key | `inode:mtimeMs:size` |
| linear scan cache | `isFresh` | `{count, newestMtimeMs}` **plus `processTerm` by function REFERENCE** |

`IndexState` = `unavailable` (no index — **NO search ran**, exit 3) · `stale` · `empty` (count 0) · `ready`. MUST NOT read `unavailable` as "no matches".

**None of these hash content.** A same-second edit, a checkout restoring an older mtime, or a swap preserving count and newest-mtime serves a stale index silently — the defect class behind the stale atom cache and the ghost documents in § Landmines.

## 6. Deciding the route

| I want to… | Hop | Where | Gotcha |
|---|---|---|---|
| Add or reorder an analysis step | 7 + 11 | `ANALYZERS` in `query.ts` | A chain is data — add the `Stage`, name the chain. `fts5` picks it up via the stamp; the other three still hard-call `stemText` |
| Measure an analyzer arm | — | `npm run gnosis:bench -- --analyzer <id>` | **`fts5` only** — refused on other adapters, because they would analyze with their own chain under your label |
| Change what the LEGACY helpers do (`tokenize` / `stemText`) | 7 AND 11 | `query.ts` + `linear`, `minisearch`, `lancedb` | Rebuild every index; update `isFresh`; engine-side stemmers MUST stay off. `fts5` no longer calls them |
| Make the OTHER adapters analyzer-aware | 7, 10, 11 | `port.ts` first | The port passes `string`, which is WHY analysis is duplicated 4× — fix the port signature, not each adapter |
| Tune k1 / b | 12 | `linearScanAdapter.ts` only | `fts5` compiles them in; `minisearch` / `lancedb` expose their own, unrelated knobs |
| Weight the title differently | 8 | `fts5Adapter.ts` schema | **Impossible without a schema change** — the table is single-column. `linear` already includes the title, which is one reason the two disagree |
| Change the IDF | 12 | `linearScanAdapter.ts` | The copy in `query.ts` is dead for retrieval; changing it alone changes NOTHING |
| Change phrase behaviour | 11 | `toMatchExpression` | It analyses PER whitespace chunk so `adr-018` stays an adjacency phrase. Flattening to one term list silently degrades phrases to bag-of-words |
| Change query construction / rephrasing | **9 only** | `buildQuery`, and `tools/dp-gnosis/README.md` § Query rephrasing | `buildQuery` has no production caller — the rule lives with the CALLER, not the engine |
| Change the rerank protocol | 14-15 | `RERANK_FUSION_PRESETS` (`config.ts`) | `K_INIT` and the URL are NOT caller-settable |
| Add an adapter | 10 | implement `KnowledgePort` | It MUST re-analyze identically, and nothing checks that it does |
| Debug "no results" | 13 | `indexState` first | `unavailable` means nothing was searched — never "no matches" |
| Make retrieval faster | 12 | already `fts5` | `linear` re-reads the corpus per retrieve and is not a production candidate |
