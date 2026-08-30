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

### The short path — `dp-gnosis setup`

```bash
dp-gnosis setup
```

It finds the server, probes the reranker-named models it serves for one whose rank head actually
discriminates, and writes that pair into `config.json` — so the rest of this section is the manual
path, needed only when `setup` finds nothing or you want a model it did not pick.

The probe is why it is worth running rather than hand-editing: it is the same discrimination check
`doctor` performs, so it **rejects a silently-broken GGUF by name** instead of configuring one. See
§ Which GGUF below — that failure answers 200 with numbers that parse.

It is non-interactive, it probes the shipped `RERANK_MODEL_ID` first whenever the server serves it
(every recorded baseline is at that model), and its merge-write leaves every other `config.json` key
alone. Exit 0 written · 3 server reachable but nothing passed · 2 usage.

`dp-gnosis wizard` is the GUIDED form of the same thing, and it goes further: when no server
answers, it can fetch a verified GGUF from this file’s table — sized against the machine’s RAM,
VRAM and free disk — start a detected `llama-server` over it, and probe THAT before writing
anything. It offers only the verified repositories, never the broken ones below. Everything after this subsection
applies to both commands.

| Setting | Default | Stated in |
|---|---|---|
| Base URL | `http://127.0.0.1:9292` — `RERANK_DEFAULT_URL` (`src/config.ts`) | `config.json`, `DP_GNOSIS_RERANK_URL` |
| Model id | `qwen3-reranker-4b` — `RERANK_MODEL_ID` | `config.json`, `DP_GNOSIS_RERANK_MODEL`, `--rerank-model <id>` |
| Backend | `http` — `RERANK_DEFAULT_BACKEND` | `config.json`, `DP_GNOSIS_RERANK_BACKEND` |
| Pool depth | `100` — `RERANK_K_INIT` | `--rerank-pool <n>`, or the profile's `rerankPoolK` |

**`packages/gnosis/CONFIGURATION.md` owns the precedence between those tiers** and the `config.json`
schema; this file does not restate it. `dp-gnosis doctor` reports which tier won and names the one it
beat.

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

### The in-process backend — no server at all

`rerank.backend: "local"` scores inside the gnosis process instead of over HTTP, using
[`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) — the same llama.cpp, the same GGUF
files, the same rank head. It is the SIMPLER install, not the faster one, and the wizard offers it
in exactly those words.

```bash
npm install node-llama-cpp --save-prod --omit=dev   # beside the package, like the dense routes above
```

```json
{ "rerank": { "backend": "local", "modelPath": "/home/you/models/qwen3-reranker-0.6b-q8_0.gguf" } }
```

`rerank.modelPath` MUST be absolute and MUST NOT be relative; `rerank.model` stays an HTTP model id
and is not read under this backend. `CONFIGURATION.md` § 1.3 owns both keys.

**The engine picks the hardware, and you do not.** `localReranker.ts` calls `getLlama()` with no
options at all, so the engine uses whatever GPU backend the installed `node-llama-cpp` was built
with — Vulkan on the machine everything below was measured on — and the CPU when it finds none.
Which backends a given build carries is node-llama-cpp's own documentation to state, not this
file's. That is why this backend needs no configuration beyond the two keys above: there is
deliberately no `rerank.gpu` key, because there is nothing for it to set.
Read the flip side in the same breath — a GPU that is present is a GPU that is used, so you cannot
pin a run to the CPU while one is there, and on a single card the engine is competing for it with
any llama.cpp server you are also running (the contention note below).

**What it costs, measured.** `qwen3-reranker-0.6b-q8_0`, Vulkan on an AMD RADV GFX1201, 100
synthetic 2 000-character documents, the rerank step alone, 2026-08-29:

| | model load | 100 documents | per document |
|---|---|---|---|
| GPU (Vulkan) | 1 846 ms | 6 472 ms | 64.7 ms |
| CPU (`gpu: false`, 12 cores) | 2 914 ms warm | 170 763 ms | 1 708 ms |

Read those two rows against each other and nothing else. They are the rerank STEP over synthetic
documents; the served figures in `handbook/GNOSIS-BASELINES.md` are WHOLE-QUERY times over the real
corpus, so the two MUST NOT be subtracted. What the rows do settle is the shape of the choice: on a
GPU the in-process engine is worth having, and on a CPU a pool of 100 is minutes per search rather
than seconds. The wizard times YOUR machine before it writes anything.

**On a CPU the run is long and nothing cancels it.** The local scoring path is given no deadline:
`rerank.ts` forwards its `timeoutMs` to the HTTP scorer alone, so the served path is bounded and the
in-process one is not. At the CPU rate tabulated above, a pool of 100 runs for minutes and only
Ctrl-C ends it. That is a property to plan around rather than a fault to report — an interactive
CPU-only search is the case it bites, and a long-lived `dp-gnosis-mcp` on a GPU the case it does
not.

**The model load is per PROCESS.** A one-shot `dp-gnosis search` pays it on every invocation; a
long-lived `dp-gnosis-mcp` pays it once and then never again. That asymmetry, not throughput, is
where this backend earns its place.

**It competes with a llama.cpp server for the GPU.** Running llama-swap and the in-process engine
at once on one card fails with `InsufficientMemoryError`, at every context size. This is an
architectural consequence of two processes wanting the same VRAM, not a defect. `curl
http://127.0.0.1:9292/unload` frees it, but llama-swap reloads on demand, so the freeing is
transient — pick one or the other on a single-GPU machine.

**It is deliberately UNCALIBRATED.** `RERANK_CALIBRATION` (`src/config.ts`) is keyed by model ID and
was measured against the SERVED endpoint, so inheriting an entry would publish a probability
computed against a scale nothing measured on this engine. Under `local`, `confidence` reports `weak`
and `--min-relevance` REFUSES by name. Ranking works; the probability does not, until someone
measures one.

**Ranking QUALITY under `local` is UNMEASURED.** The path loads, discriminates and reorders —
verified end to end on 2026-08-30 in this checkout, with `qwen3-reranker-0.6b-q8_0`, the engine
installed and NOTHING answering at `127.0.0.1:9292`:

```bash
DP_GNOSIS_RERANK_BACKEND=local DP_GNOSIS_RERANK_MODEL_PATH=<abs>.gguf \
  dp-gnosis search "…" -k 3 --rerank --json
```

It returned `"mode":"fts5+rerank"`, `"poolSize":100`, `"confidence":"weak"` and exit 0, in 10.5 s
wall including process start and model load. That is a proof the PATH RUNS, and nothing more: no
paired benchmark arm has scored this backend against the served one, so nothing states that the two
produce the same ORDERING. Keep it apart from the calibration point above — that one is about the
PROBABILITY `--min-relevance` reads, this one about the order the results come back in. It is why
`RERANK_DEFAULT_BACKEND` stays `http` (`src/config.ts`): `local` is an available route, not a
promoted one.

**The probe is the same probe.** The local path scores the same fixed relevant/irrelevant pair
against the same `RERANK_PROBE_MIN_SCORE` floor, magnitude before direction, and refuses on
`DEGENERATE` / `CONSTANT` / `INVERTED` with the same diagnosis — a rank-head-less GGUF is the same
defect whether llama.cpp is reached over a socket or linked into this process.

An absent engine is a refusal naming `npm install node-llama-cpp --save-prod --omit=dev`, never a
silent fall back to the HTTP endpoint: the two are different scorers on different score scales, and
a caller who asked for one and received the other could not tell the rankings apart.

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
