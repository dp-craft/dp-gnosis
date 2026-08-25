<!-- LLM-PRIMARY: Product front page for gnosis — what it is, how to install it, how to ask it a question. A lexical BM25 search engine over a folder of markdown, with an optional cross-encoder reranker and an MCP server. There is NO corpus in this repository: a fresh clone searches nothing, and that is exit 0 by design. Contributors start at CONTRIBUTING.md; engine and benchmark work starts at handbook/GNOSIS-GUIDE.md. -->

# gnosis

**Search your own markdown from the command line — or hand it to an LLM as one citable block of evidence.**

Point gnosis at a folder of markdown. It splits each document into **atoms** — small, self-contained, frontmatter-tagged units — indexes them with BM25, and ranks them against your keywords. No embeddings, no cloud, no network call on the default path. The whole thing is a Node CLI and a SQLite file.

It exists because a retrieval tool that quietly returns nothing is worse than one that fails. Every stage here refuses out loud instead of handing back a plausible empty answer.

## What you can do with it

| | Command |
|---|---|
| Search your notes for keywords | `npm run gnosis -- retrieve "llama-swap model swap local server"` |
| Get one paste-ready, citable block for an LLM prompt | `npm run gnosis -- answer "bm25 length normalisation"` |
| Get a written answer *with* its sources | `npm run gnosis -- answer "…" --synthesize` |
| Serve the vault to Claude Desktop, Cursor, Zed or opencode | `npm run gnosis:mcp` |
| Sharpen the ranking with a cross-encoder | add `--rerank` |

## Install

You need **Node 22 or newer**. There is no npm package yet — you clone it.

```bash
git clone <this-repo> dp-gnosis
cd dp-gnosis
npm install          # one lockfile, npm workspaces
```

That is the whole install. `better-sqlite3` and `stemmer` are the only required dependencies.

## Your first search, in three commands

gnosis reads markdown from the roots named in `DP_GNOSIS_CORPUS_ROOTS`. Point it at your own folders:

```bash
# 1. Chunk your documents into atoms.
DP_GNOSIS_CORPUS_ROOTS=docs \
  npm run gnosis -- ingest --atoms-dir /tmp/my-atoms

# 2. Build the search index. Do NOT skip this — see below.
npm run gnosis -- index --adapter fts5 \
  --atoms-dir /tmp/my-atoms --index-path /tmp/my-atoms.db

# 3. Ask.
npm run gnosis -- answer "some keywords" --adapter fts5 \
  --atoms-dir /tmp/my-atoms --index-path /tmp/my-atoms.db
```

Those exact commands, run against this repository's own `docs/`, produce **3141 atoms** and answer queries over them.

**Step 1 exits 3, and that is correct.** Exit 3 means *partial* — atoms were written AND something was refused, here 118 duplicate or empty sections listed in `skipped[]`. Read them; do not retry blindly.

**A file needs to clear TWO gates, not one.** `DP_GNOSIS_CORPUS_ROOTS` decides what is READ; a separate path→domain rule decides what is LABELLED, and an unlabelled file is dropped whole. Adding `handbook` to the roots above writes **zero** extra atoms for exactly that reason. `packages/gnosis/AUTHORING.md` owns both gates — read it before pointing gnosis at a new tree.

**`ingest` and `index` are one operation in two commands**, and the second is the half that gets forgotten. An `ingest` alone leaves the index carrying the old digest, and the next query refuses with exit 3 rather than answering from a stale index.

For a permanent setup, put those paths in a **profile file** instead of repeating the flags — `packages/gnosis/README.md` § Profiles.

## Ask with keywords, not with a question

This is a lexical engine. It matches stemmed words; it has no idea what a question *means*. Rewriting a natural-language question into keywords is **the single largest measured lever on result quality in this system** — larger than which adapter you pick.

| Don't ask | Ask |
|---|---|
| `how do I start the e2e tests` | `run e2e end-to-end playwright test command spec` |
| `what llm service solutions are available` | `llm provider service ollama openrouter gemini anthropic` |

The six rules, the measured effect (precision@10 0.20 → 0.80) and the exception that matters most are in `packages/gnosis/README.md` § Query rephrasing. If you are wiring gnosis into an agent, copy that file's § LLM integration prompt verbatim into the tool definition.

## There is no corpus in this repository

**A fresh clone has nothing to search.** `benchmark-data/vault/atoms/` is gitignored, and the documents the measured vault was built from live in the private repository this was extracted from. Only `corpus-manifest.json` is tracked, as the digest anchor the recorded baselines were measured against.

That matters because of how the engine treats an empty corpus: **a genuinely empty atoms directory is not an error.** `index` and `answer` both exit 0 and hand back an empty knowledge pack, deliberately — an empty index over an empty corpus is the correct answer. The `index-empty` refusal (exit 3) is reserved for the real defect, where markdown files *are* present and none of them reached the index. So on a fresh clone you get silence, not a complaint.

Point it at your own markdown, as above.

## Under the hood

For readers who want the technical shape before committing to it:

| | |
|---|---|
| **Ranking** | BM25. Four lexical adapters — `fts5` (SQLite FTS5, the default and the measured champion), `linear` (reference BM25 in TypeScript), `minisearch`, `lancedb`. Three dense/hybrid routes exist as **measurement** routes and are deliberately not shipped |
| **Chunking** | Documents split on heading boundaries into ~3200-character atoms, each carrying its heading chain so a heading's terms stay searchable |
| **Query expansion** | RM3 pseudo-relevance feedback, **on by default** on the shipped profiles. Pure SQLite, no network. Turn it off with `--no-prf` |
| **Reranking** | Optional cross-encoder over HTTP (`--rerank`, default `qwen3-reranker-4b`), RRF-fused with the first pass. This is the one network hop in the ranking path, and it is opt-in |
| **Output** | `text`, `json` or `xml`; `answer` renders one delimited knowledge pack with `[^atom-id]` citations |
| **Refusals** | Exit 3 means *partial* — real output was produced and something was refused. A stale or foreign index is refused rather than answered from |
| **Measurement** | A benchmark package gates every engine change against BEIR, BRIGHT and two real corpora. Its datasets are public and download themselves on first use |

## Where to go next

| I want to… | Read |
|---|---|
| Use the CLI — every command, flag, exit code and output format | `packages/gnosis/README.md` |
| Write documents so they become retrievable atoms | `packages/gnosis/AUTHORING.md` |
| Wire it into an MCP client, Obsidian, or another consumer | `packages/gnosis/INTEGRATION.md` |
| Run or read the benchmark | `packages/gnosis-bench/README.md` |
| Contribute code — gates, layout, PR rules | `CONTRIBUTING.md` |
| Change retrieval quality, or understand the pipeline | `handbook/GNOSIS-GUIDE.md` — **read it first**; it owns the landmines |

## Status

**Not yet an installable product.** Turning it into one is the job of `docs/2026-08-24-2111-dp-gnosis-standalone-product-v2.md`, which owns the phase plan and its gates. Phases 0 and 1 are done.

Licensed **GPL-3.0-or-later**. Security policy: `SECURITY.md`.
