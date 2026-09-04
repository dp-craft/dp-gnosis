# Project usability review – README-first, end-user perspective

## Summary
Repo root README is accurate and code-backed, but dense for a first-time user. The engine works as documented, the command surface matches code, and the refusal-first design is well explained. The main usability friction is cognitive load up-front and a few user-facing commands / environment knobs that are not surfaced in the first page.

## What is solid and matches code

* Product framing: lexical BM25 over markdown atoms, no embeddings by default. Matches engine.
* Commands exist as documented:
  * init, doctor, ingest, index, retrieve, answer, answer --synthesize – packages/gnosis/src/cli/cli.ts:80-89
  * npm run gnosis:mcp – package.json:16
  * dp-gnosis bin → dist/cli/main.js – packages/gnosis/package.json:11
* First-run flow init → ingest → index --adapter fts5 → retrieve is the served path.
  * init requires positionals, refuses on re-run, writes ~/.config/dp-gnosis/user.profile.json – paths.ts:240
  * init prints next steps ingest then index – initCommand.ts:183-188
* Two-gate model: corpusRoots reads, domainRules labels. README 74-76 matches AUTHORING.md ownership.
* Exit codes: exit 3 = partial, exit 0 = success, exit 2 = usage. outcome.ts defines EXIT_PARTIAL = 3. README 78-80 explains correctly.
* Ingest + index is one operation. README 70-72. ingest restamps corpus-manifest.json, retrieve refuses on indexState mismatched. Landmine GNOSIS-GUIDE.md:152.
* Query rephrasing as largest measured lever – root README 123-130 and packages/gnosis/README.md § Query rephrasing.
* Doctor read-only diagnostic. doctorCommand.ts exists, README 82-92 describes outputs correctly.

## Usability findings

* Dense first page. Tagline is good, then exit codes, PRF, rerank costs and benchmark tables before first run.
* Install friction. Not on npm registry yet + npm pack + npm install -g is honest but non-standard for end users.
* Command surface split. dp-gnosis <cmd> vs npm run gnosis -- <cmd> for checkouts. Both true per package.json:15, but copy-paste confusion likely.
* Profile editing required but not shown. init writes user.profile.json and README 66-68 says edit it. No one-line example of edit.
* Enrichment invisible. enrich command exists cli.ts:84, enrichCommand.ts is full command, never mentioned in root README.
* Environment override missing. DP_GNOSIS_DATA_HOME changes data root – env.ts:161-164 – escape hatch not mentioned in quick start.
* --profile flag never demonstrated in quick start.
* Rerank cost is upfront. nDCG table useful for power users, intimidating for first run.

## Validation against code – gaps / risks

* README accurate for init, doctor, ingest, index, retrieve, answer, --rerank, --synthesize, exit 3 semantics.
* Missing explicit mention of enrich in root README. Command exists and is part of generate sidecar then merge flow documented in packages/gnosis/README.md:292-325.
* No mention of absolute path requirement for init. initCommand.ts:100-101 refuses relative roots. README example uses ~/… which expands, rule not stated.
* MCP startup prerequisite not stated: npm run gnosis:mcp needs llama-swap server for rerank/rephrase/synthesize. README mentions rerank needs llama-swap later, not at MCP call.
* Flag scope confusion possible. Root README says every dp-gnosis <cmd> reads npm run gnosis -- <cmd>. True for checkouts, after global install command is dp-gnosis.

## What users like

* Clear 4-step first run – present.
* Exit codes that refuse instead of hallucinate – present and explained.
* doctor as single diagnostic – present.
* Query keyword guidance – present and measured.
* Citable answer pack – unique value prop, well described.

## Suggested minimal changes

* Add a 30-second first-run block above landmines with copy-paste commands and expected output.
* Mention DP_GNOSIS_DATA_HOME and --profile in the first run notes.
* Add one line about enrich for power users, linking to packages/gnosis/README.md.
* Clarify absolute path requirement for init.
