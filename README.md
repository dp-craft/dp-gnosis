<!-- LLM-PRIMARY: Product front page for gnosis — what it is, how to install it, how to ask it a question. A lexical BM25 search engine over a folder of markdown, with an optional cross-encoder reranker and an MCP server. There is NO corpus in this repository: a fresh clone searches nothing, and that is exit 0 by design. Contributors start at CONTRIBUTING.md; engine and benchmark work starts at handbook/GNOSIS-GUIDE.md. -->

# gnosis

**Search your own markdown from the command line — or hand it to an LLM as one citable block of evidence.**

Point gnosis at a folder of markdown. It splits each document into **atoms** — small, self-contained, frontmatter-tagged units — indexes them with BM25, and ranks them against your keywords. No embeddings, no cloud, no network call on the default path. The whole thing is a Node CLI and a SQLite file.

It exists because a retrieval tool that quietly returns nothing is worse than one that fails. Every stage here refuses out loud instead of handing back a plausible empty answer.

## What you can do with it

| | Command |
|---|---|
| Search your notes for keywords | `dp-gnosis retrieve "llama-swap model swap local server"` |
| Get one paste-ready, citable block for an LLM prompt | `dp-gnosis answer "bm25 length normalisation"` |
| Get a written answer *with* its sources | `dp-gnosis answer "…" --synthesize` |
| Check an instance that is misbehaving | `dp-gnosis doctor` |
| Serve the vault to Claude Desktop, Cursor, Zed or opencode | `npm run gnosis:mcp` |
| Sharpen the ranking with a cross-encoder | add `--rerank` |

In a checkout rather than an install, every `dp-gnosis <cmd>` reads `npm run gnosis -- <cmd>`.

## Install

You need **Node 22 or newer**. `better-sqlite3` and `stemmer` are the only required dependencies.

**It is not on the npm registry yet**, so there are two honest paths.

*As a tool you use* — build a tarball and install it. You get a `dp-gnosis` command and your data
lives under `~/.local/share/dp-gnosis`, with nothing written into the checkout:

```bash
git clone <this-repo> dp-gnosis && cd dp-gnosis && npm install
cd packages/gnosis && npm pack        # builds dist/ and writes dp-gnosis-<version>.tgz
npm install -g ./dp-gnosis-*.tgz
```

*As a checkout you develop in* — skip the pack and call it through npm. Every `dp-gnosis <cmd>`
below becomes `npm run gnosis -- <cmd>`, and the data stays inside the repository:

```bash
git clone <this-repo> dp-gnosis && cd dp-gnosis && npm install
```

## Your first search, in four commands

```bash
# 1. Create an instance and point it at your markdown.
dp-gnosis init ~/notes ~/work/some-project/docs

# 2. Chunk those documents into atoms.
dp-gnosis ingest

# 3. Build the search index. Do NOT skip this — see below.
dp-gnosis index --adapter fts5

# 4. Ask.
dp-gnosis retrieve "bm25 length normalisation"
```

`init` creates the atoms and index directories, writes a profile at
`~/.config/dp-gnosis/user.profile.json`, and prints the exact commands to run next. It refuses
rather than overwrite an instance you have already edited.

**Then edit that profile.** It is the one file that decides what is read and how it is labelled, and
`init` can only guess so much. `packages/gnosis/CONFIGURATION.md` owns the schema and walks through
multi-project setups.

**`ingest` and `index` are one operation in two commands**, and the second is the half that gets
forgotten. An `ingest` alone leaves the index carrying the old digest, and the next query refuses
with exit 3 rather than answering from a stale index.

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
