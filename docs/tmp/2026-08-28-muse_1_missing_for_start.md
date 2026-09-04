# Usability review – end-user perspective

Date: 2026-08-28

README files inspected:
- `/home/dev/work/dippe/dp-gnosis/README.md` – product front page
- `/home/dev/work/dippe/dp-gnosis/packages/gnosis/README.md` – engine / CLI reference
- `/home/dev/work/dippe/dp-gnosis/packages/gnosis-bench/README.md` – benchmark how-to

## What works well

- **Clear value proposition up front.** Root README: “Search your own markdown from the command line — or hand it to an LLM as one citable block of evidence.” `README.md:5-7`
- **First search in 4 commands** is given, with the `ingest` → `index` → `retrieve` flow explicitly called out. `README.md:46-60`
- **Exit-code contract is documented.** Exit 3 = partial, not crash, with a symptom table and `doctor` command. `README.md:82-98`
- **Query phrasing is highlighted as the largest lever** with before/after examples. `README.md:121-130`
- **Navigation table** at the end routes to the correct owner doc for each task. `README.md:156-164`
- CLI reference is test-locked to `src/cli/args.ts` – flags can’t drift undocumented. `packages/gnosis/README.md:73-74`
- `answer` renders a citable knowledge pack with `[^atom-id]` citations, budget reporting and neutralisation. `packages/gnosis/README.md:158-185`

## Usability friction from a first-time user

- **Install is not npm-installable.** No registry package, requires `npm pack` + `npm install -g ./dp-gnosis-*.tgz`. Node 22+ required. `README.md:28-37` – high barrier vs `npm i -g dp-gnosis`.
- **No corpus on fresh clone.** “A fresh clone has nothing to search.” `README.md:132-138` – users get empty output with exit 0, by design but surprising. No demo corpus or quick-start data.
- **Two-step ingest/index is a landmine.** `ingest` alone leaves a stale index and the next query refuses with exit 3. `README.md:70-72` – warning is buried after quick start.
- **Exit 3 is non-intuitive.** Partial success is correct for the design, but most CLIs use 0/1. Meaning is explained but requires reading the whole “Exit 3 is not a crash” section. `README.md:78-80`
- **Documentation is fragmented and dense.** Root README 176 lines dense, engine README >400 lines of flag tables, JSON shapes and analyzer chains. New users must jump between `README.md`, `packages/gnosis/README.md`, `CONFIGURATION.md`, `AUTHORING.md`, `handbook/GNOSIS-GUIDE.md`.
- **Query rewriting rule is critical but easy to miss.** Largest measured lever, yet lives in `packages/gnosis/README.md § Query rephrasing` and only referenced in root README. `README.md:123-130`
- **No visual affordances.** No badges, screenshots, GIFs, or quick demo output.
- **Flag vocabulary is huge.** 40+ flags, many with interdependencies. Table is complete but overwhelming for first search.
- **Error recovery guidance is scattered.** `doctor` is mentioned, but common first-run failures are only in symptom table. `README.md:93-98`
- **Profile concept is introduced late.** `init` prints commands, then “Then edit that profile” – profile owns `corpusRoots`, `domainRules`, labelling. User sent to `packages/gnosis/CONFIGURATION.md` before successful query. `README.md:66-68`

## Best-practice gaps vs typical open-source READMEs

- Name / Description: present, technical lean. No one-sentence elevator pitch.
- Installation: present, not one-liner.
- Usage: examples exist, no copy-paste minimal example with expected output.
- Support / FAQ: none. No “where to ask for help” or common pitfalls FAQ.
- Project status: “Installable, not yet published.” `README.md:168` – fine, but no roadmap.
- Visuals / Badges: missing.

## Recommendations

- Add a 30-second “Try it now” block with pre-built demo corpus or `dp-gnosis init --demo`.
- Promote query-rewriting rule to root README quick start.
- Surface ingest→index requirement as warning box directly under 4-command example.
- Provide short FAQ for three most common first-run states: empty results, exit 3 mismatched index, wrong project results.
- Consider “Getting started” page with 3 tabs: CLI user, MCP user, developer.
