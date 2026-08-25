# Security policy

## Supported versions

This project is pre-1.0 and under active development. Only the tip of `main` receives fixes.

## Reporting a vulnerability

Please report privately through **GitHub's private vulnerability reporting** — the *Security* tab → *Report a vulnerability*. That opens a private advisory visible only to the maintainers.

Please do not open a public issue for a security problem.

Include what you have: the version or commit, what you ran, what happened, and what you expected. A reproduction is welcome but not required to report.

You should get an acknowledgement within a week. Since this is a small project, please read that as best effort rather than a guaranteed SLA.

## What the engine actually does

Most of this project's attack surface is smaller than an OSS security policy usually implies, so it is worth stating plainly.

**At query time the engine makes no network call.** Retrieval is lexical BM25 over local markdown atoms, with a local SQLite FTS5 index. Nothing is sent anywhere.

Three flags are the exceptions, and all three are **opt-in and off by default**:

| Flag | What it contacts |
|---|---|
| `--rerank` | a local OpenAI-compatible reranker, by default `http://127.0.0.1:9292`, overridable with `DP_GNOSIS_RERANK_URL` |
| `--rephrase` | an LLM endpoint, to rewrite the query |
| `--synthesize` | an LLM endpoint, to synthesize an answer over the retrieved atoms |

Each sends your query — and for `--synthesize`, the retrieved atom bodies — to whatever endpoint is configured. The shipped default is loopback, but the variable can point anywhere, so treat it as an egress decision.

The benchmark is different: it **does** fetch corpora over the network (BEIR datasets, and Hungarian MILQA from Hugging Face), from the URLs declared in `packages/gnosis-bench/datasets.json`.

## Untrusted content

The `answer` verb wraps retrieved atoms in a delimited knowledge pack whose preamble states that everything between the delimiters is data, never instructions. That is a mitigation against prompt injection from corpus content, not a guarantee. **If you ingest documents you do not control, treat retrieved text as untrusted input to whatever consumes it.**

## Out of scope

- The corpus itself. Atom content is whatever you ingested.
- Behaviour under a hand-edited index or atom cache.
- Third-party reranker or LLM endpoints you point the engine at.
