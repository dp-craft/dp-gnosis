<!-- LLM-PRIMARY: dp-gnosis — lexical retrieval over a markdown atom vault: layout, CLI contract, query-rephrasing rules, LLM integration prompt. -->

# dp-gnosis

Retrieval over a curated vault of markdown **atoms** — one document chunked into ~3.2k-char, frontmatter-tagged units, ranked by BM25. No embeddings, no server, no network.

## Layout

Code is `tools/dp-gnosis/` — a **liftable unit** (own `package.json`, own tests). Data is ONE top-level directory with two typed children.

| Path | Tracked? | Contents |
|---|---|---|
| `tools/dp-gnosis/` | yes | the package: `src/`, `golden/golden-set.v1.json` (frozen relevance set) |
| `dp-gnosis/vault/` | yes | the knowledge unit |
| `dp-gnosis/vault/atoms/` | **gitignored** | retrievable atoms — the ONLY root an adapter reads. Ignored because `ingest` still materialises it from repo docs (machine output) |
| `dp-gnosis/vault/proposals/` | gitignored | pre-admission drafts; unretrievable **by location**, never filtered after the fact |
| `dp-gnosis/cache/` | **gitignored** | derived + disposable: `cache/index/<per-adapter>`, `cache/bench/` scratch corpora |

Every path is owned by `src/paths.ts` and anchored on that file's own location — never `process.cwd()`. `ingest` is deterministic: re-running over an unchanged corpus rewrites byte-identical files, so a non-empty `git diff` over the vault means a source doc actually changed.

## CLI

`npm run gnosis -- <command> [args] [flags]` (script: `tsx tools/dp-gnosis/src/cli/main.ts`).

A bare invocation, `--help` or `-h` prints help and exits 0. An **unknown flag is a hard error, never ignored** — a silently dropped `--jsn` would hand an agent a wrong answer under a success code.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | everything asked for happened |
| 2 | bad input or usage; the message names the correction |
| 3 | **partial** — real output was produced AND something was refused |

Callers MUST branch on the code. `3` is not a failure and MUST NOT be retried blindly.

### Commands

| Command | Positionals | Honoured flags |
|---|---|---|
| `ingest` | **none** (passing one is exit 2) | `--atoms-dir`, `--repo-root`, `--json` |
| `index` | none | `--adapter`, `--atoms-dir`, `--index-path`, `--json` |
| `retrieve <query…>` | query terms, joined with spaces | `--adapter`, `--atoms-dir`, `--index-path`, `--repo-root`, `-k`, `--format`, `--json` |
| `bench` | none | `--atoms-dir`, `--golden-set`, `--json` |

### Flags

| Flag | Value | Default |
|---|---|---|
| `--adapter` | `linear\|fts5\|minisearch\|lancedb` | `linear` |
| `--atoms-dir` | dir | `dp-gnosis/vault/atoms` |
| `--index-path` | file for `fts5`/`minisearch`, **directory** for `lancedb` | per-adapter path under `dp-gnosis/cache/index/` |
| `--repo-root` | dir | repo root |
| `--golden-set` | file | `tools/dp-gnosis/golden/golden-set.v1.json` |
| `-k` | positive integer | `5` |
| `--format` | `text\|json\|xml` — **`retrieve` only** | `text` |
| `--json` | boolean — alias for `--format json` | off |
| `--help` / `-h` | boolean | off |

`bench` deliberately IGNORES `--adapter`: a benchmark of one adapter is not a comparison.

### Output format

`--json` is an **alias** for `--format json` and its bytes are unchanged — `bench`, the tests and the agent prompt below all depend on it.

| Invocation | Result |
|---|---|
| no flag / `--format text` | the compact human line per hit (score, id, domain, title — **no body**) |
| `--json` / `--format json` / both together | the JSON object in § `--json` key shape |
| `--format xml` | a `<retrieved_context>` block carrying each atom **body** — paste-ready for an LLM |
| `--json --format xml` | **exit 2**, naming both flags — a contradiction is refused, never resolved |
| `--format <anything else>` | exit 2, naming `text, json, xml` |
| `--format` on `ingest` / `index` / `bench` | exit 2 through the unknown-flag path |

Exit codes are identical across formats; `xml` is a rendering, never a different search.

### `--json` key shape

Every object carries `exitCode`. In `--json` mode one object goes to stdout even for a failure; in human mode a usage failure goes to **stderr**.

| Command | Keys |
|---|---|
| `ingest` | `command`, `written`, `skipped[{source,title,reasons[]}]` |
| `index` | `command`, `adapter`, `built`, `indexPath` (`null` when nothing was built), `note` |
| `retrieve` | `command`, `adapter`, `query`, `k`, `mode`, `indexState`, `count`, `atoms[{id,title,domain,body,score,sourcePath}]`, plus `note` when `indexState` is `unavailable` |
| `bench` | `command`, `markdownPath`, `jsonPath`, `adapters[]`, `skippedAdapters[{name,reason}]`, `corpora[]`, `goldenSet` |
| any usage failure | `error` |

`indexState` ∈ `ready` (searched a current index) · `empty` (searched, corpus holds no atoms) · `stale` (searched, index older than the corpus — ranking may lag) · `unavailable` (**nothing was searched**). `unavailable` exits 3, never 0: a zero `count` under it is evidence about the index, not about the corpus.

### Worked examples

```bash
# 1. Build the corpus from the configured roots.
npm run gnosis -- ingest --json
# {"command":"ingest","written":1043,"skipped":[],"exitCode":0}
# exit 3 + a populated skipped[] means a partial corpus — read every `reasons`.

# 2. Build an adapter index (no-op, exit 0, for `linear`).
npm run gnosis -- index --adapter fts5
# index: fts5 — built at <repo>/dp-gnosis/cache/index/atoms-fts5.db

# 3. Rank atoms. Query is keywords, NOT a sentence — see § Query rephrasing.
npm run gnosis -- retrieve "testing strategy layered test model coverage thresholds" -k 5 --json
# {"command":"retrieve","adapter":"linear","query":"…","k":5,
#  "mode":"lexical:bm25-linear","indexState":"ready","count":5,
#  "atoms":[{"id":"ts-testing-layered-test-model","title":"Layered Test Model",
#            "domain":"standards","body":"…","score":18.4471,
#            "sourcePath":"…/vault/atoms/ts-testing-layered-test-model.md"}],
#  "exitCode":0}

# 4. Measure every adapter over the frozen golden set; writes to docs/test/.
npm run gnosis -- bench --json
# {"command":"bench","markdownPath":"…","jsonPath":"…","adapters":["linear","fts5"],
#  "skippedAdapters":[{"name":"lancedb","reason":"…"}],"corpora":["seed","…"],
#  "goldenSet":{…},"exitCode":3}
```

`bench` measures at k=5 over the seed vault plus two synthetic ceiling rungs, cold and warm regimes side by side. It picks **no winner** — a human reads the report.

### `xml` shape

```bash
npm run gnosis -- retrieve "functional programming immutability pure functions" -k 1 --format xml
```

```xml
<retrieved_context query="functional programming immutability pure functions" adapter="linear" mode="lexical:bm25-linear" indexState="ready" count="1">
  <document id="typescript-typescript-principles-functional-programming-mandatory" score="24.0523" domain="standards">
    <metadata>
      <source>dp-gnosis/vault/atoms/typescript-typescript-principles-functional-programming-mandatory.md</source>
      <section>Functional Programming (MANDATORY)</section>
    </metadata>
    <content>
| Immutability | `const` only (never `let`/`var`) &amp; spread/map/filter/reduce |
    </content>
  </document>
</retrieved_context>
```

| Element / attribute | Content |
|---|---|
| root attributes | `query`, `adapter`, `mode`, `indexState`, `count` — the same values `--json` reports |
| `<source>` | the atom file path **relative to the repo root** (`--repo-root` sets the base); `--json` keeps the absolute form |
| `<section>` | the atom's `title` — see the limitation below |
| `<content>` | the atom body verbatim, entity-escaped |

**Escaping.** Entity escaping (`&` `<` `>` `"` `'`), never CDATA: an atom body containing the literal `]]>` closes a CDATA section early, and code fences and markdown tables make `<`/`&` routine. Output is well-formed for every atom in the vault; a consumer parses it with any XML reader.

**`<section>` limitation.** It carries the atom's `title`, which `ingest` sets to the **leaf heading** — promoted to the full `>`-joined heading chain only when that leaf is ambiguous across sources. The chain is otherwise consumed to build the atom id and is not stored on the atom, so most sections show one heading with no ancestry. Reconstructing it would mean re-reading the source document; no `headingChain` field exists.

**Zero results vs no search.** Both render the same empty block, and the difference stays machine-readable: a real search that matched nothing is `indexState="ready" count="0"` with no `<note>`; `indexState="unavailable"` (exit 3) adds a `<note>` and means **nothing was searched**.

```xml
<retrieved_context query="…" adapter="linear" mode="lexical:bm25-linear" indexState="unavailable" count="0">
  <note>retrieve: nothing was searched — no corpus exists at the atoms directory; build it first with `gnosis ingest &lt;path...&gt;`</note>
</retrieved_context>
```

### Adapters

Swapping the adapter changes **ranking and speed only**. Every subcommand sees a bare port, so the JSON schema and exit codes cannot diverge per adapter. All four share one tokenizer and one stemmer, applied index-side and query-side — a second stemmer would make `--adapter` a comparison of tokenizers instead of retrieval.

| Adapter | Index | Dependency | Notes |
|---|---|---|---|
| `linear` (default) | none | — | reference BM25 in memory; re-scans the vault every call, so an edit lands on the next call with no reindex. `index` is a stated no-op |
| `fts5` | `cache/index/atoms-fts5.db` | `better-sqlite3` (required) | contentless FTS5 + `atom_meta` join table; bodies never stored in SQL |
| `minisearch` | `cache/index/atoms-minisearch.json` | **optional** | measured for its load-vs-query cost profile |
| `lancedb` | `cache/index/atoms-lancedb/` (a tree) | **optional** | LanceDB's BM25 FTS path only — no vectors. A v2-readiness probe |

`minisearch` and `lancedb` are `optionalDependencies` loaded by lazy dynamic import. An absent one is **reported, never hidden**: `index` exits 3 with the loader's own reason, and `retrieve` reports `indexState: "unavailable"` (exit 3). Enable with `npm install` in `tools/dp-gnosis`.

### Configuration

`CORPUS_ROOTS` (`src/config.ts`) is the corpus SCOPE — the only thing deciding what `ingest` reads. Default: `['doc', 'claude-artifacts', 'RUNNER-*.md']`.

| Entry form | Resolution |
|---|---|
| contains `*` | glob against the repo root; contributes the matching `.md` FILES |
| anything else | directory, walked recursively for `.md` |

A root matching **zero** files THROWS, naming that root — a typo would otherwise index nothing in silence, and the only symptom would be empty queries. Override with `DP_GNOSIS_CORPUS_ROOTS=<comma-separated repo-relative roots>`; unset, empty or all-blank falls back to the default. `SOURCE_ROOT_DOMAINS` maps a source path prefix → `x_domain` (`runner|standards|adr|docs|claude`), longest prefix wins; a source under no declared root is skipped with a reason, never guessed.

## Query rephrasing (MANDATORY before every `retrieve`)

This is a **lexical BM25 engine**. It matches stemmed tokens. It has no idea what a question means.

Measured twice. Rewriting a natural-language question changes ~90% of the top-10 results (raw-vs-rephrased top-10 Jaccard — `minisearch` 0.027 · `linear` 0.074 · `lancedb` 0.108 · `fts5` 0.129), and an LLM-judged relevance pass over 186 blind-scored pairs shows the rewrite is **better**, not merely different:

| metric (mean, 6 needs × 4 adapters) | raw question | rephrased | change |
|---|---|---|---|
| precision@10 | 0.20 | 0.80 | **×4** |
| strict precision@5 (only "directly answers") | 0.09 | 0.58 | **×6** |
| reciprocal rank of first direct answer | 0.27 | 0.89 | **×3** |

Phrasing is not cosmetic. It is the single largest lever on result quality in this system — larger than the choice of adapter, which is statistically indistinguishable.

| natural-language question | rewritten for the engine | rule |
|---|---|---|
| i would like to see testing strategy related info | `testing strategy layered test model coverage thresholds` | drop intent framing; use the terms the documents use |
| how to start e2e tests | `run e2e playwright test command spec` | "how to start" carries no signal; name the tool |
| what llm service solutions are available | `llm provider service ollama openrouter gemini anthropic` | enumerate instances — BM25 has no concept of "solutions" |
| how to use llama-swap | `llama-swap model swap local server` | keep the rare term (high IDF), add context words |
| architectural requirements of runner | `agentic code runner architecture ownership boundaries design rules` | ambiguous noun → use the full product name |
| functional programming style | `functional programming immutability pure functions no classes` | expand to the concepts the documents name |

The four rules:

1. **Strip intent words.** "how to", "I want", "please show me", "info about", "available", "related" — high frequency, zero discrimination. They add score mass to documents that match them incidentally.
2. **Name things as the documents name them.** Query the vocabulary of the corpus, not the vocabulary of the asker.
3. **Add synonyms by hand.** BM25 has NO synonymy. `e2e` does not match `end-to-end`; `LLM` does not match `language model`. Include both.
4. **Prefer rare terms.** IDF rewards them. One `llama-swap` outweighs ten `system`s.
5. **MUST NOT dilute a query that already carries the exact rare term.** This is the measured exception to rule 3. When the user's own words already contain the corpus's domain term, adding synonyms *lowers* precision — the added terms pull in unrelated documents and sink the exact match. `how to use llama-swap` beat its rewrite (P@10 0.60 vs 0.55) for exactly this reason. Rephrase to *supply* a missing domain term, never to decorate one that is already there.

Grammar and word order are **irrelevant** — it is a bag of words. `zustand selector stability` and `stability selector zustand` score identically.

**Non-English corpora.** Stemming is English Porter (npm `stemmer`), applied uniformly to every adapter. On an agglutinative language it does nothing useful: a Hungarian run missed the correct document in 3 of 5 queries purely on suffix mismatch — query `használata` never matched document `használ` / `használnak` / `használva`; query `kerekítési összege` never matched `kerekítése` / `összegeket`; query `modulok` never matched `modul` / `moduloknak` / `modulban`. Until a language-aware analyzer is wired in, a non-English query MUST be written with the **word stem** the document uses, not the inflected form the asker would speak.

**No-match warning.** The engine returns up to `k` results ranked by score and **never signals "no good match"**. A caller MUST treat a low absolute score, or a top result far below the run's usual scores, as a probable miss — and MUST NOT read a returned atom as an answer merely because it was returned. `count < k` only means fewer atoms scored above zero.

## LLM integration prompt

Copy this block verbatim into an agent tool definition (opencode, a Claude Code skill, any tool-calling LLM).

```text
TOOL: dp-gnosis — lexical (BM25) retrieval over this repository's documentation,
split into markdown "atoms". Invoke as:

    npm run gnosis -- retrieve "<keyword query>" -k 5 --json

WHEN TO CALL
- Call it before answering any question about this repo's architecture,
  standards, ADRs, runner, testing policy, or conventions.
- Call it again with a different query if the first result set looks off-topic.
- Do NOT call it for questions about code behaviour that only source files
  answer; read the source instead.

REWRITE THE QUERY FIRST — MANDATORY
This engine matches stemmed words. It does not understand questions. Rewriting a
natural-language question changes ~90% of the top-10 results, so pass keywords,
never the user's sentence.
1. Strip intent framing: "how to", "I want", "show me", "info about", "available".
2. Use the vocabulary the documents use, not the user's.
3. Add synonyms yourself — there is no synonymy ("e2e" will not match
   "end-to-end"; include both).
4. Keep rare, specific terms; they carry the most weight.
Word order and grammar are irrelevant — it is a bag of words.
Example: "how do I start the e2e tests?" -> "run e2e end-to-end playwright test
command spec".

READ THE JSON
Fields: adapter, query, k, mode, indexState, count, atoms[].
Each atom: {id, title, domain, body, score, sourcePath}. atoms[] is sorted by
score, descending.
- exitCode 0  = the search ran.
- exitCode 2  = you called it wrong; read "error", fix the call, retry once.
- exitCode 3  = partial. If indexState is "unavailable" NOTHING was searched —
  say so; do not report "no results found".
- indexState "empty" = the corpus holds no atoms. "stale" = ranking may lag the
  current docs; say so when you cite.

CITE
Cite every claim as: <title> (<id>, <sourcePath>). Quote from the atom "body"
only; never paraphrase from "title" alone.

SCORES ARE NOT CONFIDENCE — HARD RULE
This tool ALWAYS returns up to k atoms and NEVER signals "no good match". A
returned atom is not evidence that an answer exists.
- Compare scores within the result set: if the top score is close to the bottom
  one, the ranking is noise.
- If scores are low or the atoms are plainly off-topic, rewrite the query with
  different keywords and call again.
- If a second attempt is still weak, tell the user the vault has no clear answer
  and name what you searched for. Do NOT present a low-scoring atom as
  authoritative.
```
