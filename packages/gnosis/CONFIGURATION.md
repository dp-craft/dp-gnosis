<!-- LLM-PRIMARY: How a dp-gnosis instance is configured — the three layers (profile, config.json, environment), how a domain is assigned, and the worked multi-project / multi-language setups. Owns the CONFIGURATION vocabulary. The CLI FLAG vocabulary is README.md; atom authoring is AUTHORING.md; serving to a consumer is INTEGRATION.md. -->

# Configuring dp-gnosis

| | |
|---|---|
| **This file owns** | the profile schema · domain and type assignment · `config.json` · the environment variables · the worked setups |
| **Never here** | CLI flags (`README.md`) · atom frontmatter (`AUTHORING.md`) · MCP/consumer wiring (`INTEGRATION.md`) · retrieval constants (`src/config.ts`) |

A constant named below is cited BY NAME, never by value — read the value from
`src/config.ts`. A value copied into prose rots silently.

---

## 1. The three layers

| Layer | Lives in | Decides |
|---|---|---|
| **Profile** | a `*.profile.json` file | WHAT is ingested and how it is labelled — the corpus scope, the domain and type vocabularies, the analysis chain, where the atoms and index are written |
| **User config** | `config.json` in the config home | WHAT THIS MACHINE has — where it keeps its data, and which server serves the reranker. Machine facts, not vault facts: a vault synced to a second machine keeps its profile and picks up that machine's own `config.json` |
| **Environment** | `DP_GNOSIS_*` variables | per-invocation overrides, and the model/service endpoints |

**Precedence is narrow-beats-broad**: a CLI flag beats a profile, a profile beats
a built-in default, and a gnosis-specific variable beats a shared one.

### 1.1 Where the data root comes from

Resolution order, highest first:

| # | Source | Note |
|---|---|---|
| 1 | `DP_GNOSIS_DATA_HOME` | the narrow, gnosis-specific statement — the ONLY thing that overrides a development checkout |
| 2 | `dataRoot` in `config.json` | absolute; a relative value is REFUSED by name |
| 3 | installed → the data home; checkout → the repository root | an install is detected by the package sitting inside a `node_modules` path segment |

`XDG_DATA_HOME` deliberately does NOT appear as a trigger. It is a SHARED
setting — pointing it at a new tree redirects every application at once — so
letting it win would silently relocate a development checkout's vault while
`ingest` writes and prunes against it. It still SHAPES the result in row 3,
where the data home is already the chosen base and XDG is doing its normal job.

### 1.2 The four directories

Resolved by `src/env.ts`, which is pure — it computes paths and creates nothing.

| Kind | Linux default | Override |
|---|---|---|
| config | `~/.config/dp-gnosis` | `DP_GNOSIS_CONFIG_HOME`, else `XDG_CONFIG_HOME` |
| data | `~/.local/share/dp-gnosis` | `DP_GNOSIS_DATA_HOME`, else `XDG_DATA_HOME` |
| cache | `~/.cache/dp-gnosis` | `DP_GNOSIS_CACHE_HOME`, else `XDG_CACHE_HOME` |
| state | `~/.local/state/dp-gnosis` | `DP_GNOSIS_STATE_HOME`, else `XDG_STATE_HOME` |

macOS uses the `Library/` conventions and Windows `APPDATA`/`LOCALAPPDATA`; an
XDG variable that is SET still wins on macOS, because exporting it there is a
deliberate opt-out. A variable that is set but blank reads as UNSET, and a
relative value is REFUSED by name rather than resolved against the shell's
working directory — a root that moves with the caller's terminal is a different
vault per terminal.

### 1.3 `config.json`

Optional. Absent → built-in defaults, which is the common case. Present but
unreadable, not an object, or carrying a bad value → **exit 2**, one line
naming the file and the correction. It is never ignored silently: resolving a
plausible path the user never asked for is the failure this project polices.

```json
{
  "dataRoot": "/home/dev/vaults/work",
  "rerank": { "url": "http://127.0.0.1:9292", "model": "qwen3-reranker-4b" },
  "models": { "rephrase": "qwen3-27b", "synthesize": "qwen3-27b", "enrich": "qwen3-30b-a3b" }
}
```

| Key | Meaning | Refused when |
|---|---|---|
| `dataRoot` | absolute root the vault and cache trees hang off | relative — a root that moves with the caller's terminal is a different vault per terminal |
| `rerank.url` | base URL of the server that answers `/v1/rerank` | not a string, blank, or missing an `http://` / `https://` scheme. A scheme-less address is refused rather than repaired: guessing the protocol would send every call somewhere the user never wrote, and the connection error would then name the guess instead of the file |
| `rerank.model` | the id THAT server serves the reranker under | not a string, or blank |
| `models.rephrase` | the chat id `search --rephrase` rewrites the query with | not a string, or blank |
| `models.synthesize` | the chat id `ask --synthesize` writes the answer with | not a string, or blank |
| `models.enrich` | the chat id `enrich` generates each atom's sidecar record with | not a string, or blank |

**`rerank` is what makes the reranker configurable once instead of per-invocation.**
Before it existed the URL was environment-only and the model was `--rerank-model`
on every single call. Both now resolve **flag → environment → `config.json` →
built-in constant**:

| Setting | Flag | Environment | `config.json` | Constant |
|---|---|---|---|---|
| endpoint | — | `DP_GNOSIS_RERANK_URL` | `rerank.url` | `RERANK_DEFAULT_URL` |
| model id | `--rerank-model` | `DP_GNOSIS_RERANK_MODEL` | `rerank.model` | `RERANK_MODEL_ID` |

**`models` does the same for the three CHAT hops**, which have no `setup` to find
them: they share the `rerank.url` endpoint — one server, one address — and
differ only in the id it serves each under. The shipped ids are the ones one
machine's llama-swap happens to serve, so on any other server they are the ids
your run will be refused for, by name.

| Setting | Flag | Environment | `config.json` | Constant |
|---|---|---|---|---|
| rephrase model | — | `DP_GNOSIS_LLM_MODEL` | `models.rephrase` | `REPHRASE_MODEL_ID` |
| synthesize model | — | `DP_GNOSIS_SYNTHESIZE_MODEL` | `models.synthesize` | `SYNTHESIZE_MODEL_ID` |
| enrich model | `--enrich-model` | `DP_GNOSIS_ENRICH_MODEL` | `models.enrich` | `ENRICH_MODEL_ID` |

**`setup` MUST NOT pick a chat model for you.** A reranker can be probed — score
a relevant and an irrelevant passage and see whether the pair separates — and
`setup` refuses one that does not. No such probe exists for a chat model, so
`setup` reports which of the three resolved ids the server does not advertise
and writes nothing; guessing one would be the failure this project polices.

`dp-gnosis setup` writes this block for you — it finds the server, probes the
models it serves for a working rank head, and merges the winner in without
disturbing `dataRoot`. `dp-gnosis doctor` reports which tier won and names the
one it beat, so a `config.json` silently outranked by an exported variable is a
finding rather than a mystery.

---

## 2. The profile

One profile = one named instance. Selected with `--profile <file>`.

### 2.1 Required fields

| Field | Meaning |
|---|---|
| `name` | the instance name; also what stamps the atoms directory as owned |
| `domains` | the `x_domain` vocabulary. **Open** — a new domain is data here, with no TypeScript edit |
| `types` | the atom type vocabulary. **Closed in practice**: an unknown name falls back to `defaultType` at read time and `--type` validates against the shipped set, so a profile-only type is unusable as a filter |
| `defaultType` | the type a source gets when no `typeRules` prefix claims it |
| `domainRules` | `[{ prefix, domain }]` — the source→domain table (§3) |
| `typeRules` | `[{ prefix, type }]` — the source→type table |
| `segmentRules` | `[{ segment, type }]` — type by path SEGMENT rather than prefix |

A key not in the known set is an error; keys prefixed `comment:` carry authored
rationale and are ignored as data.

### 2.2 Optional fields

| Field | Meaning |
|---|---|
| `repoRoot` | the base a RELATIVE `corpusRoots` entry resolves against |
| `corpusRoots` | the directories ingest walks (§4). Absent → the shipped `CORPUS_ROOTS` |
| `atomsDir` | where atoms are written. **Every profile MUST own its own** |
| `indexPath` | where the index is built. **Every profile MUST own its own** |
| `goldIdsPath` | gold ids ingest breaks exact-body dedupe ties against |
| `atomMaxChars` | per-atom size ceiling |
| `excludePaths` | paths skipped inside an included root |
| `defaultExcludedTypes` | types hidden from CLI results by default — a PRESENTATION default, not a corpus change |
| `defaultPrf` | the RM3 knobs this profile serves |
| `summarySidecar` | the enrichment sidecar joined at index time |
| `defaultAnalyzer` | the analysis chain this profile's index is BUILT with (§6) |
| `rerankPoolK` | how many candidates `--rerank` reorders for this corpus (§9). Absent → the shipped `RERANK_K_INIT` |

### 2.3 Why `atomsDir` and `indexPath` are per-profile

Two profiles left on the defaults collide, and the two collisions differ:

- the index default is per-ADAPTER, so both write the same file and the later run overwrites the earlier one **in silence**;
- an atoms directory is worse — `ingest` makes the tree hold EXACTLY the current run's write set, so whichever profile ingests last **PRUNES the other's atoms**.

The atoms directory is stamped with an owner marker (`ATOMS_OWNER_FILE`), so a
second profile is REFUSED rather than suffered. The refusal is a guardrail, not
a workflow — set both keys and never meet it.

---

## 3. How a domain is assigned

**Declared, never guessed.** There is no directory-name magic and no
classifier.

1. `domains` declares the vocabulary.
2. `domainRules` maps a **path prefix** to one of those domains.
3. Ingest derives `x_domain` from that table ALONE, so re-running over unchanged sources is stable.
4. **Longest prefix wins** — rules are sorted longest-first, so a nested root always outranks the broader root containing it and declaration order does not matter. What the prefix is matched AGAINST is the source's identity — §4.1.
5. A source under **no** declared prefix is REFUSED, naming the prefixes. Ingest MUST NOT guess a domain.
6. A `domainRules` entry naming a domain absent from `domains` is REFUSED.

Types work the same way through `typeRules` (prefix) and `segmentRules`
(segment), except that an unclaimed source falls to `defaultType` instead of
being refused.

The resulting domain travels all the way to the answer: every retrieved atom
carries `domain`, so a consumer can always tell which project a result came
from.

---

## 4. `corpusRoots`

The directories ingest walks. An entry may be:

| Form | Resolved against |
|---|---|
| relative (`doc`, `docs/adr`) | the profile's `repoRoot` |
| absolute (`/home/dev/work/aichatney/doc`) | used as-is |
| `~`-prefixed (`~/knowledge/standards`) | the user's home. `~user/` is REFUSED by name rather than read as a directory |

`DP_GNOSIS_CORPUS_ROOTS` overrides the whole list for one invocation, comma
separated, and its entries accept the same three forms.

A root that matches **no** markdown files FAILS LOUDLY naming the resolved
location — a silently empty corpus is how a vault comes to answer nothing while
every gate stays green.

### 4.1 How a source is NAMED — the rule every prefix matches against

A prefix in `domainRules` / `typeRules` is matched against the source's
**identity**, which is:

| Where the source lies | Its identity |
|---|---|
| under the profile's `repoRoot` | its path RELATIVE to `repoRoot` — byte for byte what it has always been |
| anywhere else | its own ABSOLUTE path |

So an in-repo tree keeps repo-relative prefixes, and an out-of-repo tree is
claimed by declaring its absolute (or `~/`) prefix. Identity is decided by the
path ALONE — never by which root matched first — so declaration order and root
order cannot change a source's domain. The alternative ("relative to the root
that matched it") would collide two projects' `doc/x.md` into one identity and
silently reassign a domain.

A source under no declared prefix stays refused (§3).

### 4.2 Two limits of out-of-repo roots

| Limit | Detail |
|---|---|
| **`excludePaths` cannot exclude anything under an absolute root** | It still REFUSES an absolute or `..` prefix, loudly. Aligning it with `domainRules` is a separate change and has not been made |
| **Absolute source paths are machine-specific** | An out-of-repo source records its absolute path in the atom's `sources:` frontmatter and in the corpus manifest, so those atoms are not portable to a machine with a different layout. Inherent to the feature |

---

## 5. The two-command rule

`ingest` and `index` are **one operation in two commands**, and the second is
the forgotten half:

```
gnosis ingest --profile <p>
gnosis index  --profile <p> --adapter fts5
```

`ingest` restamps the corpus digest and exits 0. The index beside it still
carries the OLD digest, so the next query REFUSES — exit 3, `indexState:
"mismatched"`, `count: 0`. The refusal is correct and names its remedy, but no
test suite queries the production index, so a suite can be fully green over a
vault that answers nothing.

**After any corpus or profile change, run ONE real `search` and read
`indexState` before believing the vault is served.**

---

## 6. The analyzer is a property of the DOCUMENTS

`defaultAnalyzer` names the chain the index is BUILT with. The chain is stamped
into the index and the query side reads the stamp back, so query and index
cannot disagree about how text was tokenised.

Two consequences:

- **It takes effect only on a REBUILD.** An existing index keeps its own stamp. Changing the profile alone changes nothing served.
- **A profile that declares a chain its index was not built with is REFUSED** — exit 3, naming both chains and the remedy — rather than being served silently by the stamp.

**Language is the real index boundary.** The Hungarian chain measured +0.1369
nDCG@10 on a Hungarian corpus and −0.0634 on English; the tradeoff is a property
of the documents, not of the tool. So a second LANGUAGE needs its own profile
and its own index. A second PROJECT does not.

---

## 7. Worked setups

### 7.1 One project

The shipped default. No `corpusRoots`, no `repoRoot` — ingest walks the shipped
`CORPUS_ROOTS` under the resolved data root.

### 7.2 Several projects plus shared standards, ONE index

The recommended shape when cross-project discovery matters. One index, one
ingest, domains as the discriminator.

```json
{
  "name": "work",
  "domains": ["aichatney", "gnosis", "standards"],
  "corpusRoots": [
    "/home/dev/work/aichatney/doc",
    "/home/dev/work/dippe/dp-gnosis/docs",
    "~/knowledge/standards"
  ],
  "domainRules": [
    { "prefix": "/home/dev/work/aichatney/doc",       "domain": "aichatney" },
    { "prefix": "/home/dev/work/dippe/dp-gnosis/docs", "domain": "gnosis" },
    { "prefix": "~/knowledge/standards",               "domain": "standards" }
  ],
  "types": ["adr", "knowledge", "standard"],
  "defaultType": "knowledge",
  "typeRules": [{ "prefix": "/home/dev/work/aichatney/doc/adr", "type": "adr" }],
  "segmentRules": [],
  "atomsDir":  "~/.local/share/dp-gnosis/work/atoms",
  "indexPath": "~/.local/share/dp-gnosis/work/index/atoms-fts5.db"
}
```

Then:

| Intent | Command |
|---|---|
| cross-project discovery — the DEFAULT | `gnosis search "<q>" --profile work` |
| narrowed to one project | `… --domain aichatney` |
| that project's decisions only | `… --domain aichatney --type adr` |

**Do not filter by default.** The reranker scores query–document pairs
independently of which project a document came from, so the right answer wins on
merit and the `domain` field tells you where it came from. A domain guessed from
the query is a classifier, and a wrong guess hides the right answer behind a
plausible smaller result set with no error.

### 7.3 A second language

A second profile and a second index, because the analysis chain differs (§6) —
its own `domains`, its own `atomsDir`, its own `indexPath`, and its own
`defaultAnalyzer`.

### 7.4 A fully isolated per-project instance

The same as §7.2 with one root and one domain. Because the profile owns every
location, an isolated instance and a shared one differ only by configuration.

---

## 8. What refuses, and why that is the point

| Situation | Outcome |
|---|---|
| corpus root matching no markdown | fails loudly, naming the root |
| source under no declared `domainRules` prefix | refused, naming the prefixes |
| `domainRules` naming an undeclared domain | refused |
| a second profile writing into an owned atoms directory | refused by the owner marker |
| index digest disagreeing with the corpus manifest | exit 3, `mismatched`, remedy named |
| index analyzer disagreeing with the profile's `defaultAnalyzer` | exit 3, `mismatched`, both chains named |
| `config.json` unreadable, malformed, or with a relative `dataRoot` | exit 2, one line naming file and correction |
| a relative `DP_GNOSIS_*_HOME` | refused by variable name |

Every row is a component that would otherwise have produced nothing — or
something plausible and wrong — while the pipeline recorded it as data. A
refusal is the correct outcome and MUST NOT be worked around.

## 9. `rerankPoolK` — the pool is a property of the CORPUS

`--rerank` reorders a pool of first-pass candidates with a cross-encoder. The pool size is the
knob that trades latency against quality, and **the right value is not the same on every corpus**,
which is why it is a profile field rather than a second global default.

Measured on the two product corpora, cutting the pool from 100 to 60:

| Corpus | Effect of 100 → 60 |
|---|---|
| `vault` (English) | 14.4 s → 8.6 s per query, paired CI **[−0.0042, +0.0005]**, 56 of 60 topics bit-identical — a ~40 % latency cut for no measurable quality |
| `vault-hu` (Hungarian) | nDCG@10 **−0.0181**, CI EXCLUDING zero — a real loss |

Source: `docs/analysis/2026-08-27-full-dp-gnosis-overview/04-next-steps-and-gaps.md` N4.

Precedence, highest first: the `--rerank-pool` flag, then the profile's `rerankPoolK`, then
`RERANK_K_INIT`. **The shipped default is unchanged at 100** — a profile that says nothing behaves
exactly as before.

`--rerank-pool` REFUSES without `--rerank`, the same rule every other rerank knob follows: a pool
size with no reranker to fill it is a stated intention the pipeline would otherwise ignore.

**A larger pool is a RECALL lever, not an ordering one.** On `vault` it raises R@100 while leaving
nDCG@10 flat — the rescued documents arrive at ranks 11–100 and never reach the top 10
(`handbook/GNOSIS-GUIDE.md`). Raise it when you read deep into a result list; leave it alone when
you read the top few.
