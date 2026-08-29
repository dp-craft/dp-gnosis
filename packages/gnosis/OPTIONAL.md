<!-- LLM-PRIMARY: The optional machinery a plain install does not need — setting up the `/v1/rerank` reranker (which GGUFs work, how to serve it, how `doctor` checks it) and the three dense/hybrid research `--adapter` routes with the command that installs their dependencies. Everything in packages/gnosis/README.md works without any of it. -->

# Optional machinery — the reranker and the research routes

Neither half is needed to run gnosis. The reranker is opt-in and is the tool's measured best quality; the dense and hybrid routes are measurement arms whose dependencies a normal install does not carry.

The CLI contract these attach to — commands, flags, exit codes, output formats — is `packages/gnosis/README.md`.

## Setting up the reranker

`--rerank` is the one network hop in the ranking path, and it is opt-in. Without it you get the
first-pass BM25 ranking; with it, the tool's measured best quality. Setting it up is the difference
between judging gnosis at BM25-only and judging what it actually does — the gap is large, and both
sides of it are recorded with their corpus, serving config and sha in
**`handbook/GNOSIS-BASELINES.md`**. This file does not restate those figures.

gnosis talks OpenAI-compatible `/v1/rerank` over HTTP. Anything that serves that endpoint works;
`llama-server` (llama.cpp) and llama-swap are what this project measures against.

| Setting | Default | Override |
|---|---|---|
| Base URL | `http://127.0.0.1:9292` — `RERANK_DEFAULT_URL` (`src/config.ts`) | `DP_GNOSIS_RERANK_URL` |
| Model id | `qwen3-reranker-4b` — `RERANK_MODEL_ID` | `--rerank-model <id>` |
| Pool depth | `100` — `RERANK_K_INIT` | `--rerank-pool <n>`, or the profile's `rerankPoolK` |

### Which GGUF — this matters more than the quantisation

**Most published Qwen3-Reranker GGUFs are silently broken.** They are missing the
`cls.output.weight` tensor — a `[hidden, 2]` yes/no head whose softmax produces `P(yes)` — and
without it `--pooling rank` emits garbage on the order of **4.5e-23** for every pair. The server
answers 200, the scores parse as floats, and the run records them as data.

That is `handbook/GNOSIS-RULES.md` § The failure class, exactly: *a component produced nothing, and
the pipeline recorded it as data.* **A score near 1e-23 is a broken GGUF, never a finding.**

| Repo | Verdict |
|---|---|
| [`Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp`](https://huggingface.co/Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp) | **WORKING** — converted with the official `convert_hf_to_gguf.py`, carries `cls.output.weight`. Q2_K 296 MB → F16 1.2 GB |
| [`gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp`](https://huggingface.co/gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp) | **WORKING** — same method. Q4_K_M 2.5 GB, Q8_0 4.28 GB, F16 8.05 GB |
| `mradermacher/Qwen3-Reranker-*-GGUF`, `DevQuasar/*` | **BROKEN** — missing `cls.output.weight`; scores ≈4.5e-23 |
| [`Mungert/Qwen3-Reranker-4B-GGUF`](https://huggingface.co/Mungert/Qwen3-Reranker-4B-GGUF/discussions/1) | **SUSPECT** — reported failing to run; unverified here |

Upstream: [ggml-org/llama.cpp#16407](https://github.com/ggml-org/llama.cpp/issues/16407), open and
bug-unconfirmed as of this writing. Use the two WORKING repos: **4B as the quality reranker**, which
is what `RERANK_MODEL_ID` names and what the recorded baselines were measured with, and **0.6B as
the fast one**.

### Serving it

```bash
llama-server -m Qwen3-Reranker-4B-Q8_0.gguf \
  --reranking --pooling rank --embedding -c 8192 --port 9292
```

Whether `--embedding` is strictly required or merely implied by `--reranking` is **unverified** —
both working model cards pass all three flags, so this documents what is known to work rather than
the minimal set.

The model must be served under the **id gnosis asks for**. gnosis probes `GET /v1/models` first and
refuses by name if the id is absent, rather than reranking with whatever happens to be loaded:

```
search --rerank: reranker model "qwen3-reranker-4b" was requested; the server at
http://127.0.0.1:9292 did not answer GET /v1/models (server down: fetch failed) — …
```

### Checking it

```bash
dp-gnosis search "your keywords" --rerank
```

A reachable reranker adds a `rerank <score>` field to each hit and `+rerank` to `mode`. An
unreachable one is **exit 3, not a crash**: the first-pass ranking is still returned, `mode` keeps
no `+rerank` suffix, and the refusal is in `note` — discarding a full 100-candidate first pass
because the reranker was down would be the wrong trade.

**`dp-gnosis doctor` performs that check.** Its `rerank` row scores a shipped known-relevant /
known-irrelevant pair against the served model and reads the RELEVANT score against a magnitude
floor (`RERANK_PROBE_MIN_SCORE = 1e-6`, `src/config.ts`) BEFORE it reads the direction — a GGUF
converted without the `cls.output.weight` rank head scores every pair at ~4.5e-23 and is
directionally correct half the time, so direction alone passed it (upstream
ggml-org/llama.cpp#16407).

| `doctor` reports | When | Exit |
|---|---|---|
| `[unknown] rerank` | no reranker configured or the server does not serve the model — reranking is OPT-IN, so its absence is not a defect | **0** |
| `[ok] rerank` | the served model discriminates; both raw probe scores are quoted | **0** |
| `[fault] rerank` | the served model FAILED the probe — `DEGENERATE` (below the floor), `CONSTANT` (identical scores) or `INVERTED` (the irrelevant passage won). Both raw scores and the remedy are named | **3** |

`DEGENERATE` names the remedy: serve a GGUF converted with the official `convert_hf_to_gguf.py`,
e.g. `gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp` or `Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp`.
`search --rerank` runs the same probe on the serving path and refuses at exit 3 with the same
wording, returning the first-pass ranking rather than a reranked one nobody could question.

## Dense and hybrid research routes

**Not part of the everyday path.** Everything in `packages/gnosis/README.md` works on a plain install. This section covers
the three `--adapter` values that do not, and it exists so a reader who wants to experiment or
re-measure can, not because they are an upgrade.

| Route | What it ranks with |
|---|---|
| `lancedb-vec` | dense ONLY, the control — cosine over the vector column and nothing else |
| `lancedb-hybrid` | the dense leg fused with the BM25 leg of the same table, cut to `k` |
| `lancedb-hybrid-full` | the SAME fusion, offering the union of the two legs' top-`k` as a reranking pool instead of cutting it back to `k`. It still answers with at most `k` atoms — `hybrid` and `hybrid-full` differ in exactly one step, which is what makes them a clean pair |

All three are wired through `src/cli/args.ts`, `src/cli/indexCommand.ts` and `src/cli/doctorCommand.ts`
— they are reachable, not stubs. What a normal install lacks is their **dependencies**.

### Enabling them

`@lancedb/lancedb` and its required peer `apache-arrow` are `devDependencies`, so npm installs them
for a checkout and never for a consumer or a global install. That is deliberate: they are ≈323 MB (measured: 313 MB and 10 MB)
against the ≈16 MB the rest of the tool costs, and this is a lexical engine that promises no
embeddings on its default path.

```bash
# in a checkout: already installed by `npm install`, nothing to do
# beside an install: add the two packages next to it
npm install -g @lancedb/lancedb apache-arrow    # global install
npm install @lancedb/lancedb apache-arrow       # local install
```

They resolve because Node walks up from the adapter's own file to the directory holding
`dp-gnosis` itself. **Verified**, not assumed: after that install, `dp-gnosis doctor --adapter
lancedb-vec` reports `[ok] adapter: lancedb-vec is available` and exits 0, where before it reported
`[fault] adapter: lancedb-vec is unavailable — Cannot find package '@lancedb/lancedb'` at exit 3.

They are loaded by **lazy dynamic import**, and the loader catches *all* import errors rather than
only `MODULE_NOT_FOUND` — `@lancedb/lancedb` can fail at import time with a native binding error on a
platform whose prebuilt binary lags. An absent or unloadable package makes the route report itself
unavailable; `dp-gnosis doctor --adapter lancedb-vec` is what tells you which.

### What they measured

**They are measurement routes, and the measurement did not favour them.** Every dense and hybrid arm
landed below its corpus champion on nDCG@10 in the completed factorial; pure dense was the clearest
loss, while hybrid fusion was mixed — it helped recall on one corpus and one language and not on
another. The numbers, each with the corpus, serving config and `gitSha` that make it a fact rather
than a recollection, are in **`handbook/GNOSIS-BASELINES.md`** § Phase D. Read them there; this file
deliberately does not restate a quality figure, because a copied one rots silently.

Treat these routes as an experiment you can re-run, not as a better ranking you have not switched on.
