<!-- LLM-PRIMARY: The always-binding dp-gnosis rules — the failure class every decision is read against, and what may be stated as fact. Auto-loaded via CLAUDE.md; applies to ALL work in this repository, not only retrieval. Retrieval-specific landmines are in GNOSIS-GUIDE.md § Landmines. -->

# Gnosis Rules — always binding

Small and always loaded. Everything here applies to **every** task in this repository. A rule that binds only engine or benchmark work belongs in `GNOSIS-GUIDE.md`, not here.

## The failure class

**A component produced nothing, and the pipeline recorded it as data.**

Every design, review and reporting decision MUST be read against that sentence.

| Signal | Required reading |
|---|---|
| An all-zero metric row | a defect until proven otherwise — never a finding |
| `p=1.0000` | same |
| A zero-width confidence interval | same |
| A number that merely looks reasonable | **not** evidence the pipeline is sound |

**The worst recorded instance failed toward a PLAUSIBLE number, not an obvious zero** — which is why the obvious defects were caught in hours and that one survived a whole campaign.

## Evidence — what may be stated as fact

| Rule | Applies to |
|---|---|
| Report a measured value with its SOURCE — command, `file:line`, or tool output | every number |
| Flag names, defaults and version behavior MUST be verified against the installed binary/config before being stated; unverifiable → say so | every claim about behavior |
| MUST NOT state a remembered value as fact | every claim |
| A quality number is a fact only with its **corpus, serving config and sha** | every retrieval metric |
| MUST NOT quote a baseline from memory, compare rows recorded under different serving configs, or present an estimate as a measurement | every retrieval metric |

## Volatile facts — route, never restate

A copied count rots silently. Restated counts have repeatedly gone stale in this repository's own governance files — manifest size, gate totals and the landmine tally were each wrong at the same time.

| Volatile fact | Ask this instead |
|---|---|
| Which datasets exist; their `layers`, `enabled`, `format`, `source` | `packages/gnosis-bench/datasets.json` — the manifest is the ONLY owner |
| Dependency versions | the two `package.json` files |
| Test counts | run the command; a number in a doc is stale by the next commit |
| What the vault currently holds | `benchmark-data/vault/corpus-manifest.json` — its `atomCount` and mtime |
| Where a symbol lives | `grep -n "export const <name>"` or LSP `workspaceSymbol`. **Code is cited by SYMBOL, never by line number** |
| Any constant — `RERANK_*`, `SERVED_PRF_PARAMS`, `ATOM_*`, `FTS_COLUMNS`, field weights | `packages/gnosis/src/config.ts` |
