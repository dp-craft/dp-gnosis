<!-- LLM-PRIMARY: How to point a SECOND consumer at a gnosis vault without editing TypeScript — the stdio MCP server and its one tool, client configuration for opencode / Claude Desktop / Cursor / Zed, the Obsidian route via a profile, and the ingest+index refresh step that half the deliverable depends on. The CLI contract itself is in packages/gnosis/README.md. -->

# Integrating gnosis with another consumer

Everything here is **client-side**. Nothing in this repository has to change to serve a new consumer, and the repository deliberately ships **no `.mcp.json`** — that file belongs to the consumer, whose absolute paths differ.

Two routes exist, and they answer different questions:

| Route | Use when |
|---|---|
| § MCP surface — a stdio JSON-RPC server, one tool | the client speaks MCP (opencode, Claude Desktop, Cursor, Zed) |
| § Obsidian — a profile pointed at the vault folder | the corpus is already a folder of markdown and the client just runs a command |

Either way, § The refresh step is not optional: a vault whose documents moved under its index is REFUSED at query time, and nothing rebuilds it for you.

The CLI contract these routes wrap — commands, flags, exit codes, output formats, profiles — is `packages/gnosis/README.md`.

## MCP surface — one tool over stdio

`npm run gnosis:mcp` serves the vault to any MCP client over stdio. Zero new dependencies: three files in `src/mcp/` over node builtins, and the protocol constants are MIRRORED from `@modelcontextprotocol/sdk` 1.27.1 rather than imported (default `2025-11-25`; the four older versions it lists are accepted and echoed).

Framing is **newline-delimited JSON-RPC 2.0** — one object per line, NOT LSP `Content-Length` framing. **stdout is the protocol**: only response lines reach it, every diagnostic goes to stderr, and a notification (`notifications/initialized`) gets no response at all.

| Tool | Argument | Meaning |
|---|---|---|
| `gnosis_answer` | `question` (string, REQUIRED) | The question, in the words it would be searched with — see `packages/gnosis/README.md` § Query rephrasing |
| | `k` (integer, optional) | Omit it to take the CLI's own default; this surface states no second default |
| | `domain` (string, optional) | Validated against the LOADED profile's domain vocabulary, exactly as `--domain` is |

The tool runs `answer <question> [-k <k>] --json [--domain <d>]` through `runCli` and reads the pack OUT of that payload — **one code path**, so the returned text is byte-identical to the `pack` field of the same `answer --json` invocation. It is asserted by `tests/mcpProtocol.test.ts`, not assumed; a second rendering would drift from the CLI's the first time either changed.

The exit code is the contract and is mirrored, never flattened:

| CLI exit | MCP result |
|---|---|
| 0 | `content[0].text` = the pack, no `isError` |
| 3 | the SAME pack, with the payload's `note` appended — a PARTIAL is a real answer with something refused, and flagging it would discard a good pack |
| 2, or a payload with no `pack` | `isError: true`, text = the payload's `error` — a usage failure MUST NOT read as an empty answer |

A malformed line answers `-32700` (`id: null`), an unknown method `-32601`, an unknown tool name `-32602`. Acceptance over real stdio: `bash packages/gnosis/scripts/mcp-smoke.sh [question]` — exit 0 when both handshake and call come back well formed.

## Second consumer — point another client at this vault, without editing TypeScript

`17` DoD #5. Everything here is a **client-side** snippet: nothing in this repository has to change, and the
repository deliberately ships **no `.mcp.json`** — the file belongs to the consumer, whose absolute paths differ.

**Two absolute paths are the whole configuration**, and both are stable properties of the checkout:

| Placeholder | What to substitute | Why absolute |
|---|---|---|
| `<REPO>` | the absolute path of this checkout, e.g. `/home/dev/work/dippe/dp-gnosis` | an MCP client launches the server with an unspecified working directory |
| `<NODE_BIN>` | the directory holding `node`, e.g. `/home/dev/.nvm/versions/node/v24.14.0/bin` | needed only when the client's `PATH` does not already carry a Node ≥ 22 — `tsx`'s shebang is `env node` |

**The server does not read the working directory.** `REPO_ROOT` is derived from the module's own location
(`src/paths.ts`), so the vault, the index and the profile resolve identically from any cwd. That is what makes an
absolute-path launch sufficient.

### opencode / Claude Desktop / Cursor / Zed — stdio MCP

```json
{
  "mcpServers": {
    "dp-gnosis": {
      "command": "<REPO>/node_modules/.bin/tsx",
      "args": ["<REPO>/packages/gnosis/src/mcp/main.ts"]
    }
  }
}
```

One tool, `gnosis_answer` — § MCP surface owns its argument contract. **Rewrite the question into keywords before
calling it** (`packages/gnosis/README.md` § Query rephrasing); it is the largest measured quality lever in the system and the MCP surface applies
no rephrasing of its own.

**Measured latency, so a consumer does not read the first call as a hang.** Over stdio from a clean shell
(`env -i`, cwd `/tmp`), on this machine: handshake **0.2 s**, the FIRST `tools/call` **34–52 s**, and the SECOND
call in the same session **0.2 s**. The first call pays `tsx` transpilation of the source tree plus opening the
14k-atom `fts5` index; the session then holds both. An MCP server is long-lived, so the cold cost is paid once per
client launch, not per question. **This is the NO-rerank path** — adding `--rerank` costs ≈12 s per query on top
(`handbook/GNOSIS-BASELINES.md` § Serving path), and the MCP tool does not enable it.

### Obsidian

A vault IS a folder of markdown, so it needs no MCP at all — it needs a **profile**. § Obsidian owns the usage
contract (never write into the vault, exclude `.obsidian/`, rebuild after editing); the launch is:

```
<REPO>/node_modules/.bin/tsx <REPO>/packages/gnosis/src/cli/main.ts \
  --profile <REPO>/packages/gnosis/profiles/<your>.profile.json \
  answer "your keywords here"
```

The profile's `repoRoot` points at the vault directory, `corpusRoots` at the folders inside it to search, and
`atomsDir` / `indexPath` at locations **outside** the vault. Every profile MUST own its own two — `packages/gnosis/README.md` § Profiles states
why sharing either one destroys the other instance's corpus.

### The refresh step — half the deliverable

**A stale index refuses; nothing rebuilds it.** `indexState` returns `stale` when the corpus moved under the index
and the query REFUSES with exit 3 rather than answering from it. That is the correct behaviour and it is also a dead
end for a consumer who does not know the two commands that clear it:

```
<REPO>/node_modules/.bin/tsx <REPO>/packages/gnosis/src/cli/main.ts [--profile <p>] ingest
<REPO>/node_modules/.bin/tsx <REPO>/packages/gnosis/src/cli/main.ts [--profile <p>] index
```

**Both, in that order, every time the documents change.** `ingest` rewrites the atoms; `index` rebuilds the search
index WHOLESALE from them — there is no incremental update, so an edited note is invisible until `index` has run.

| Rule | Why |
|---|---|
| `ingest` PRUNES | the atoms tree is made to hold exactly the current run's write set. Point it at a throwaway `--atoms-dir` for any read-only experiment, never at a live one |
| Restart the MCP server after a refresh | the session holds an open index handle; a rebuilt index reaches an already-running server only on relaunch |
| An `ingest` that matches no files THROWS | a typo'd corpus root would otherwise index zero documents in silence — see `packages/gnosis/README.md` § Exit codes for the code it leaves |

## Obsidian — usage contract

Point a profile's `repoRoot` at the vault directory and its `corpusRoots` at the folders inside it to search. Everything else follows the profile rules above.

| Rule | Why |
|---|---|
| dp-gnosis NEVER writes into the vault | Atoms are written to the profile's own `atomsDir`, outside the vault — which is exactly why each profile MUST own one (`packages/gnosis/README.md` § Profiles) |
| Exclude `.obsidian` and every template folder through `excludePaths` | They are configuration and skeletons, not knowledge; an excluded prefix is dropped before read, so it enters no count and no `skipped[]`. Directory prefixes need a trailing slash |
| Re-run `index` after editing the vault | The index is built WHOLESALE from the atoms; there is no incremental update, so an edited note is invisible until the rebuild |
| A stale or foreign index is REFUSED at query time | `indexState` `stale` (the corpus moved under it) or `mismatched` (it belongs to another profile) refuses rather than answering from it — a plausible answer over yesterday's vault is worse than none |

