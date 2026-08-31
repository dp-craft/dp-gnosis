<!-- LLM-PRIMARY: How to phrase a query for a lexical BM25 engine — the five measured rephrasing rules, the non-English stem rule, the no-match warning, and the verbatim LLM integration prompt to copy into an agent tool definition. Phrasing is the largest measured quality lever in the system. The CLI contract is in packages/gnosis/README.md. -->

# Querying gnosis — how to phrase it, and the prompt that encodes it

Two things, one subject: the rules a caller applies before every `search`, and the tool-definition block that hands those rules to an agent.

The commands, flags, exit codes and output formats these rules are applied through are `packages/gnosis/README.md`.

## Query rephrasing (MANDATORY before every `search`)

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

The five rules:

1. **Strip intent words.** "how to", "I want", "please show me", "info about", "available", "related" — high frequency, zero discrimination. They add score mass to documents that match them incidentally.
2. **Name things as the documents name them.** Query the vocabulary of the corpus, not the vocabulary of the asker.
3. **Add synonyms by hand.** BM25 has NO synonymy. `e2e` does not match `end-to-end`; `LLM` does not match `language model`. Include both.
4. **Prefer rare terms.** IDF rewards them. One `llama-swap` outweighs ten `system`s.
5. **MUST NOT dilute a query that already carries the exact rare term.** This is the measured exception to rule 3. When the user's own words already contain the corpus's domain term, adding synonyms *lowers* precision — the added terms pull in unrelated documents and sink the exact match. `how to use llama-swap` beat its rewrite (P@10 0.60 vs 0.55) for exactly this reason. Rephrase to *supply* a missing domain term, never to decorate one that is already there.

These rules are also EXECUTABLE: `search --rephrase` hands the question to a local chat model under exactly this prompt and searches its rewrite (`packages/gnosis/README.md` § CLI → `--rephrase`). The flag is opt-in and its rewrite is reported, so a caller can always see — and check — what was actually searched.

**Measured 2026-08-18, the flag does NOT reproduce the rules above.** Against the same golden topics the hand rewrite improves, the model's rewrite is INERT on Hungarian and measurably HARMFUL on English — it answers Hungarian queries in English, and rewrites the queries rule 5 says to leave alone. Apply the rules yourself; use the flag only to test or re-measure it. Record: `docs/analysis/2026-08-18-dp-gnosis-full-review/10-rephrase-arm-measurement.md`.

**Prompt v2 (`REPHRASE_PROMPT_VERSION = 'v2'`) addresses both diagnosed causes and is UNMEASURED.** The language rule is now rule 1 and carries worked Hungarian examples — v1 had transcribed the non-English rule below as *"emit the ENGLISH word stem"*, one word that no rule here has ever said and that produced the measured Hungarian failure on its own. Rule 5 is additionally enforced in CODE (`carriesExactRareTerm`), short-circuiting BEFORE the cache and the model: a query already carrying an identifier, symbol, path, flag or error string is returned VERBATIM and never reaches the rewriter, so `rephrased "q" -> "q"` is a correct outcome, not a no-op failure. **The advice above stands unchanged until the arms are re-measured** — and re-measuring first needs the frozen `vault-autorephrased` / `vault-hu-autorephrased` goldens regenerated under v2 (`scripts/regenerate-autorephrased-golden.ts`), because they hold v1 rewrites.

Grammar and word order are **irrelevant** — it is a bag of words. `zustand selector stability` and `stability selector zustand` score identically.

**Non-English corpora.** Stemming is English Porter (npm `stemmer`), applied uniformly to every adapter. On an agglutinative language it does nothing useful: a Hungarian run missed the correct document in 3 of 5 queries purely on suffix mismatch — query `használata` never matched document `használ` / `használnak` / `használva`; query `kerekítési összege` never matched `kerekítése` / `összegeket`; query `modulok` never matched `modul` / `moduloknak` / `modulban`. **A language-aware analyzer now EXISTS and is OPT-IN per profile** (`packages/gnosis/README.md` § Analyzers — `hulight-fold` / `ident-hulight-fold`, `defaultAnalyzer`), but `DEFAULT_ANALYZER` is still `porter-fold` and the chain is stamped into the index at BUILD time. So the rule still binds, scoped to what was built: on any corpus whose index was built with `porter-fold` — every corpus but `hu-tax` — a non-English query MUST be written with the **word stem** the document uses, not the inflected form the asker would speak.

**No-match warning.** The engine returns up to `k` results ranked by score and **never signals "no good match"**. A caller MUST treat a low absolute score, or a top result far below the run's usual scores, as a probable miss — and MUST NOT read a returned atom as an answer merely because it was returned. `count < k` only means fewer atoms scored above zero.

## LLM integration prompt

Copy this block verbatim into an agent tool definition (opencode, a Claude Code skill, any tool-calling LLM).

```text
TOOL: dp-gnosis — lexical (BM25) retrieval over this repository's documentation,
split into markdown "atoms". Invoke as:

    npm run gnosis -- search "<keyword query>" -k 5 --json

WHEN TO CALL
- Call it before answering any question about this repo's architecture,
  standards, ADRs, runner, testing policy, or conventions.
- Call it again with a different query if the first result set looks off-topic.
- Do NOT call it for questions about code behaviour that only source files
  answer; read the source instead.

REWRITE THE QUERY FIRST — MANDATORY
This engine matches stemmed words. It does not understand questions. Rewriting a
natural-language question changes ~90% of the top-10 results, so pass keywords,
never the user's sentence. Measured on a paired benchmark: on a non-English
corpus this is a large top-10 gain; on English it buys deep recall rather than a
better top-10.
1. Strip intent framing: "how to", "I want", "show me", "info about", "available".
2. Use the vocabulary the documents use, not the user's.
3. Add synonyms yourself — there is no synonymy ("e2e" will not match
   "end-to-end"; include both).
4. Keep rare, specific terms; they carry the most weight.
5. EXCEPTION to 3: if the user's own words already contain the exact rare term,
   do NOT pad the query with synonyms — the added terms sink the exact match.
   Rephrase to supply a missing domain term, never to decorate one already there.
6. Non-English query: write the word STEM the document uses, not the inflected
   form. Stemming is English-only, so "használata" will not match "használ".
Word order and grammar are irrelevant — it is a bag of words.
Example: "how do I start the e2e tests?" -> "run e2e end-to-end playwright test
command spec".

READ THE JSON
Fields: adapter, query, k, mode, indexState, count, poolSize, atoms[].
Each atom: {id, title, domain, type, body, score, sourcePath, originPaths,
matchedTerms, snippet, scoreNormalised} plus {firstPassScore, rerankScore} on a
reranked run. atoms[] is sorted by score, descending.
- exitCode 0  = the search ran.
- exitCode 2  = you called it wrong; read "error", fix the call, retry once.
- exitCode 3  = partial. If indexState is "unavailable" NOTHING was searched —
  say so; do not report "no results found".
- indexState "empty" = the corpus holds no atoms. "stale" = ranking may lag the
  current docs; say so when you cite. "mismatched" = the index was REFUSED
  because it describes another corpus; NOTHING was searched — say so and run
  the rebuild the note names; do not report "no results found".

CITE
Cite every claim as: <title> (<id>, <sourcePath>). Quote from the atom "body"
only; never paraphrase from "title" alone.

SCORES ARE NOT CONFIDENCE — HARD RULE
This tool ALWAYS returns up to k atoms and NEVER signals "no good match". A
returned atom is not evidence that an answer exists. Nothing here is a
calibrated threshold; these are the three signals you have, in this order.
1. matchedTerms — the strongest and cheapest check. An atom whose matchedTerms
   miss the rare, specific terms of your query is off-topic however it scored.
   An EMPTY matchedTerms on every atom means the query shares no analysed term
   with anything: rewrite it, do not report the atoms.
2. rerankScore, when the run reranked (mode ends in "+rerank"). It is the one
   number with an absolute scale: on a healthy cross-encoder a relevant atom
   scores orders of magnitude above an irrelevant one. Read it, not "score" —
   "score" is a fused rank sum with no scale. Use it to spot the case where the
   whole pool is weak, which relative comparison cannot see.
3. scoreNormalised — WITHIN this answer only: 1 is this answer's top hit, 0 its
   last, null when it cannot be computed. It says nothing about the vault. Every
   atom near 1 is the NOISE signature (they all scored alike), not a good set.
   At k=2 it is always 1 and 0 by construction; it needs k>=5 to mean anything.
- If the signals are weak or the atoms are plainly off-topic, rewrite the query
  with different keywords and call again.
- If a second attempt is still weak, tell the user the vault has no clear answer
  and name what you searched for. Do NOT present a low-scoring atom as
  authoritative.
```
