<!-- LLM-PRIMARY: Product front page for gnosis — what it is, how to install it, how to ask it a question. A lexical BM25 search engine over a folder of markdown, with an optional cross-encoder reranker and an MCP server. There is NO corpus in this repository: a fresh clone searches nothing, and that is exit 0 by design. Contributors start at CONTRIBUTING.md; engine and benchmark work starts at handbook/GNOSIS-GUIDE.md. -->

# gnosis

[![CI](https://github.com/dp-craft/dp-gnosis/actions/workflows/ci.yml/badge.svg)](https://github.com/dp-craft/dp-gnosis/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](.nvmrc)

**It finds the exact identifier that vector search misses.**

`forEachLocale`. `gate-no-verdict`. `RERANK_K_INIT`. `ENOTEMPTY`. A rare token is the highest-signal
thing in a technical question, and an embedding is the wrong tool for it — it maps that token into a
neighbourhood of things that *mean* something similar, which is exactly not what you asked for.
BM25 does the opposite: the rarer the term, the harder it weighs it.

Point gnosis at a folder of markdown. It splits each document into **atoms** — small,
self-contained, frontmatter-tagged units — indexes them with BM25, and ranks them against your
keywords. The whole thing is a Node CLI and a SQLite file. No embeddings, no cloud, no network call
on the default path — not as an ideological position, but because on the corpora measured here the
lexical path **wins**, and the receipts are below.

It also exists because a retrieval tool that quietly returns nothing is worse than one that fails.
Every stage refuses out loud instead of handing back a plausible empty answer.

**Where it is the wrong tool:** a question with no rare term in it — *"how should I structure a
project"* — is a paraphrase problem, and BM25 has no concept of synonymy. Rewriting the question
into corpus vocabulary is the largest measured quality lever in the system (§ Rephrasing), and it is
work the caller has to do.

## What you can do with it

| | Command |
|---|---|
| Search your notes for keywords | `dp-gnosis search "llama-swap model swap local server"` |
| Get one paste-ready, citable block for an LLM prompt | `dp-gnosis ask "bm25 length normalisation"` |
| Get a written answer *with* its sources | `dp-gnosis ask "…" --synthesize` |
| Check an instance that is misbehaving | `dp-gnosis doctor` |
| Serve the vault to Claude Desktop, Cursor, Zed or opencode | `dp-gnosis-mcp` |
| Sharpen the ranking with a cross-encoder | add `--rerank` |

In a checkout rather than an install, every `dp-gnosis <cmd>` reads `npm run gnosis -- <cmd>`, and `dp-gnosis-mcp` reads `npm run gnosis:mcp`.

## Install

You need **Node 22 or newer**, on **Linux or macOS**. Windows is not supported. `better-sqlite3`,
`stemmer` and `minisearch` are the only required dependencies.

**It is not on the npm registry yet**, so there are two honest paths.

*As a tool you use* — build a tarball and install it. You get `dp-gnosis` and `dp-gnosis-mcp`
commands, and your data lives under `~/.local/share/dp-gnosis`, with nothing written into the
checkout:

```bash
git clone https://github.com/dp-craft/dp-gnosis.git && cd dp-gnosis && npm install
cd packages/gnosis && npm pack        # builds dist/ and writes dp-gnosis-<version>.tgz
npm install -g ./dp-gnosis-*.tgz
dp-gnosis --version                   # prints the version — the install worked
```

*As a checkout you develop in* — skip the pack and call it through npm. Every `dp-gnosis <cmd>`
below becomes `npm run gnosis -- <cmd>`, and the data stays inside the repository:

```bash
git clone https://github.com/dp-craft/dp-gnosis.git && cd dp-gnosis && npm install
```

**If the install fails while compiling.** `better-sqlite3` is a native module, and gnosis needs it
built with FTS5 — Node's own `node:sqlite` cannot compile FTS5
([nodejs/node#56951](https://github.com/nodejs/node/issues/56951)), so this dependency is
structural rather than a preference. npm downloads a prebuilt binary for common platforms; when
none matches yours it falls back to compiling from source, which needs a C++ toolchain (`build-essential`
and `python3` on Debian/Ubuntu, the Xcode command line tools on macOS). Install those and re-run
`npm install`.

## Try it with no corpus at all

```bash
dp-gnosis demo
```

`demo` ingests, indexes and searches **gnosis's own documentation** and prints the ranked result. It
needs no instance, no configuration and no markdown of yours. Its data lives in a fixed `demo/`
subtree under the data root and it cannot reach the default atoms or index paths, so your own vault
is untouched whether or not you have one.

## Your first search, in four commands

```bash
# 1. Create an instance and point it at your markdown.
dp-gnosis init ~/notes ~/work/some-project/docs

# 2. Chunk those documents into atoms.
dp-gnosis ingest

# 3. Build the search index. Do NOT skip this — see below.
dp-gnosis index --adapter fts5

# 4. Ask.
dp-gnosis search "bm25 length normalisation"
```

### What that actually looks like

Real output, captured from a run over three markdown files (only the long absolute paths are
shortened, for width):

```
$ dp-gnosis ingest
ingest: written 33, pruned 0, skipped 3 (0 duplicate-body)
  skipped …/notes/AUTHORING.md (Authoring for retrieval — how a document becomes an atom): section
  "Authoring for retrieval — how a document becomes an atom" has an empty body once its heading line
  is stripped, so it would index nothing and could never be retrieved — give the section prose of
  its own, or remove the heading

$ dp-gnosis index --adapter fts5
index: fts5 — built at …/benchmark-data/cache/index/atoms-fts5.db
  by domain — notes: 33 file(s) in, 33 atom(s) out

$ dp-gnosis search "atom frontmatter type labelling" -k 3
search: mode fts5, indexState ready, atoms 3
search: confidence weak
search: budget 64000 counted as bytes
  3.5802  (1/20)  configuration-configuring-dp-gnosis  [notes]  Configuring dp-gnosis
    origin  …/notes/CONFIGURATION.md
  4.0006  (2/20)  configuration-configuring-dp-gnosis-1-the-three-layers  [notes]  1. The three layers
    origin  …/notes/CONFIGURATION.md
  3.2168  (5/6)   authoring-…-4-metadata-the-author  [notes]  4. Metadata the author actually controls
    origin  …/notes/AUTHORING.md
```

Three things in that output are the point of the tool, not noise:

- **`skipped 3`, each with a reason and a file.** A heading whose body is empty would index nothing
  and could never be retrieved, so it is refused out loud instead of silently contributing zero.
- **`confidence weak`.** The engine ranks and reports how sure it is. It does not have a "no good
  match" signal, so a weak verdict on a returned atom is the warning you get — see § Rephrasing.
- **`(1/20)` and `(5/6)`.** The atom's reading position inside its source document, so you know
  whether a hit is the opening of a document or a fragment from its middle.

`init` creates the atoms and index directories, writes a profile at
`~/.config/dp-gnosis/user.profile.json`, and prints the exact commands to run next. It refuses
rather than overwrite an instance you have already edited.

**Then edit that profile.** It is the one file that decides what is read and how it is labelled, and
`init` can only guess so much. `packages/gnosis/CONFIGURATION.md` owns the schema and walks through
multi-project setups.

**`ingest` and `index` are one operation in two commands**, and the second is the half that gets
forgotten. An `ingest` alone leaves the index carrying the old digest, and the next query refuses
with exit 3 rather than answering from a stale index. `dp-gnosis update` runs the pair as one
command and exits with the more severe of the two outcomes, so an ingest that skipped files still
exits 3 after the index rebuilds cleanly.

**A file needs to clear TWO gates, not one.** `corpusRoots` decides what is READ; a separate
path→domain rule decides what is LABELLED, and an unlabelled source is refused by name rather than
guessed at. `packages/gnosis/AUTHORING.md` owns both gates.

**Exit 3 is not a crash.** It means *partial* — real output was produced and something was refused.
An `ingest` that writes atoms and skips 118 duplicate or empty sections exits 3 and lists them.
Read them; do not retry blindly.

## When something looks wrong, run `doctor`

```bash
dp-gnosis doctor
```

It is read-only and changes nothing. It reports where every path came from, whether the index and
the corpus manifest still describe the same corpus, whether the index was built with the analysis
chain your profile declares, which domains produced no atoms, and every place one configuration
surface silently overrode another.

| Symptom | Usually |
|---|---|
| A search returns nothing at all | `index` was never run after `ingest`, or the corpus root matched no markdown. `doctor` names which |
| Exit 3 on a query that used to work | The index and the corpus disagree — re-run `ingest` then `index` |
| Results from the wrong project | Two trees share one index; narrow with `--domain`, or check the `domainRules` prefixes |
| A setting in the profile appears to do nothing | Something outranks it — a CLI flag, or a `DP_GNOSIS_*` environment variable. `doctor` reports the loser by name |

## Is `--rerank` worth it?

`--rerank` runs a cross-encoder over the top candidates and re-orders them. It is the largest
quality lever the tool has, and also the only one that costs seconds.

| Corpus | BM25 only | with `--rerank` |
|---|---|---|
| `vault` — 6628 English documents, 60 topics | 0.4894 | **0.5791** |
| `vault-hu` — 454 Hungarian documents, 31 topics | 0.4868 | **0.7699** |

nDCG@10, `handbook/GNOSIS-BASELINES.md`, at `qwen3-reranker-4b` over a pool of 100. **The two rows
are not comparable to each other** — the corpora differ in size by more than an order of magnitude,
so their random-ranking floors differ; compare down a column, never across.

**The cost is about 12 seconds per query**, and it needs a local llama-swap server. The pool floor
binds even when you ask for `-k 5`, so a small result set does not make it cheaper. If the server is
absent the query is **refused**, not silently answered from the unreranked order.

Use it for research questions where you will read the top few carefully. Leave it off for
navigational lookups where you already know roughly what you are looking for.

## Ask with keywords, not with a question

This is a lexical engine. It matches stemmed words; it has no idea what a question *means*. Rewriting a natural-language question into keywords is **the single largest measured lever on result quality in this system** — larger than which adapter you pick.

| Don't ask | Ask |
|---|---|
| `how do I start the e2e tests` | `run e2e end-to-end playwright test command spec` |
| `what llm service solutions are available` | `llm provider service ollama openrouter gemini anthropic` |

The five rules, the measured effect (precision@10 0.20 → 0.80) and the exception that matters most are in `packages/gnosis/QUERYING.md` § Query rephrasing. If you are wiring gnosis into an agent, copy that file's § LLM integration prompt verbatim into the tool definition.

## There is no corpus in this repository

**A fresh clone has nothing to search.** `benchmark-data/vault/atoms/` is gitignored, and the documents the measured vault was built from live in the private repository this was extracted from. Only `corpus-manifest.json` is tracked, as the digest anchor the recorded baselines were measured against.

That matters because of how the engine treats an empty corpus: **a genuinely empty atoms directory is not an error.** `index` and `ask` both exit 0 and hand back an empty knowledge pack, deliberately — an empty index over an empty corpus is the correct answer. The `index-empty` refusal (exit 3) is reserved for the real defect, where markdown files *are* present and none of them reached the index. So on a fresh clone you get silence, not a complaint.

Point it at your own markdown, as above.

## Under the hood

For readers who want the technical shape before committing to it:

| | |
|---|---|
| **Ranking** | BM25. Four lexical adapters — `fts5` (SQLite FTS5, the default and the measured champion), `linear` (reference BM25 in TypeScript), `minisearch`, `lancedb` — work on any install. Three dense/hybrid **research** routes are also wired into `--adapter`, but their dependencies are not installed by default: see `packages/gnosis/OPTIONAL.md` § Dense and hybrid research routes |
| **Chunking** | Documents split on heading boundaries into ~3200-character atoms, each carrying its heading chain so a heading's terms stay searchable |
| **Query expansion** | RM3 pseudo-relevance feedback, **on by default** on the shipped profiles. Pure SQLite, no network. Turn it off with `--no-prf` |
| **Reranking** | Optional cross-encoder over HTTP (`--rerank`, default `qwen3-reranker-4b`), RRF-fused with the first pass. This is the one network hop in the ranking path, and it is opt-in |
| **Output** | `text`, `json` or `xml`; `ask` renders one delimited knowledge pack with `[^atom-id]` citations |
| **Refusals** | Exit 3 means *partial* — real output was produced and something was refused. A stale or foreign index is refused rather than answered from |
| **Measurement** | A benchmark package gates every engine change against BEIR, BRIGHT and two real corpora. Its datasets are public and download themselves on first use |

## Why not ripgrep?

`rg` is faster and you already have it. Use it when you know the string. gnosis is for when you
know *roughly* what you are looking for and want the best few passages out of thousands.

| | `ripgrep` | gnosis |
|---|---|---|
| Matching | exact string / regex, per line | BM25 over stemmed terms, per **atom** |
| Result | every line that matches, unordered | the top `k` passages, **ranked**, with a score |
| Multi-term | all terms must appear | partial matches rank too; rare terms weigh more |
| Unit | a line, without its context | a heading-bounded section carrying its heading chain |
| Output for an LLM | you assemble it | one delimited, citable block under a token budget |

The honest split: **a term you can spell exactly and expect few hits → `rg`.** A question whose
answer is spread over a handful of documents you cannot name → gnosis. They are not competitors;
gnosis's own refusal messages tell you to grep when that is the better move.

## Measured against a vector-hybrid tool

The nearest comparable tool is [`tobi/qmd`](https://github.com/tobi/qmd) — the same job, done with
an embedding + BM25 hybrid. It was measured head-to-head, black-box on its stock defaults, at
**version 2.8.3**, engine `gitSha` `e468b2bd`, both systems at the **same reranker**
(`qwen3-reranker-0.6b`) and scored by the same code at document level.

Corpora: `vault` (6 628 documents, 60 topics, English) and `vault-hu` (454 documents, 31 topics,
Hungarian).

Paired, at **matched pool 40**, qmd minus dp-gnosis — negative means dp-gnosis ahead:

| Corpus | Δ nDCG@10 | p | 95 % CI |
|---|---|---|---|
| `vault` (60 topics) | **−0.1375** | 0.0001 | [−0.1919, −0.0838] |
| `vault-hu` (31 topics) | **−0.1969** | 0.0015 | [−0.3126, −0.0872] |

**The mechanism, read off qmd's own `--explain`:** its candidate pool is vector-dominated — 86 % of
RRF contributions on English, 98 % on Hungarian — and it still recalls less gold than plain BM25
(R@≤40 0.6339 vs our 0.7642 on English). **qmd's reranker is fine**; `--no-rerank` shows it buying a
real +0.076 EN / +0.078 HU. The deficit is first-stage recall.

Indexing cost, same corpus: qmd **5 m 29 s** into **69 MB** plus ~2.1 GB of auto-downloaded models;
gnosis **3.9 s** into **5.0 MB** and nothing downloaded.

**Three caveats, because a comparison without them is advocacy:**

- **qmd is not run-to-run reproducible.** Two identical invocations reproduced the ranking on only
  18 of 31 Hungarian and 7 of 60 English topics, so both arms were run twice and **a single qmd arm
  MUST NOT be quoted as qmd's number.** The aggregate is stable (EN 0.4025 → 0.3995).
- **These are two corpora, both mine.** They are technical documentation in English and Hungarian.
  Nothing here claims BM25 beats hybrid retrieval in general, and on a corpus of prose questions
  without rare terms the result could plausibly invert.
- **qmd ran on stock defaults** and was not tuned. A tuned qmd is unmeasured.

Full table, every arm, the per-query latencies and the deviations: **`handbook/GNOSIS-BASELINES.md`**
§ `tobi/qmd` 2.8.3 head-to-head. That file, not this one, owns the numbers.

## Where to go next

| I want to… | Read |
|---|---|
| Use the CLI — every command, flag, exit code and output format | `packages/gnosis/README.md` |
| Configure an instance — profiles, domains, `corpusRoots`, multi-project setups | `packages/gnosis/CONFIGURATION.md` |
| Write documents so they become retrievable atoms | `packages/gnosis/AUTHORING.md` |
| Wire it into an MCP client, Obsidian, or another consumer | `packages/gnosis/INTEGRATION.md` |
| Run or read the benchmark | `packages/gnosis-bench/README.md` |
| Contribute code — gates, layout, PR rules | `CONTRIBUTING.md` |
| Change retrieval quality, or understand the pipeline | `handbook/GNOSIS-GUIDE.md` — **read it first**; it owns the landmines |

## Status

**Installable, not yet published.** `npm pack` plus `npm install -g` gives a working `dp-gnosis`
command whose data lives outside the checkout, and `init` / `doctor` cover first-run setup and
diagnosis. What remains before a registry release — publish, an uninstall path, and a clean-container
acceptance run — is owned by `docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md`.

The engine itself is measured and gated; `handbook/GNOSIS-BASELINES.md` is the snapshot and
`handbook/GNOSIS-GUIDE.md` records what has been settled and what is still open.

Licensed **GPL-3.0-or-later**. Security policy: `SECURITY.md`.
