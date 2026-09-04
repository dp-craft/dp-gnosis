# End-user usability review — dp-gnosis

Read files: `README.md`, `packages/gnosis/README.md`, `packages/gnosis-bench/README.md`.
Research base: immediate value proposition, runnable examples, predictable structure, visual proof, trust signals, and the abandonment reasons from Art of README / Make a README / thoughtbot / Changelog.

## First impression — what the user sees first

* `README.md:3-7` does give a one-liner and a problem statement: “Search your own markdown from the command line — or hand it to an LLM as one citable block of evidence.” That satisfies the “what is it / why care” first 5-10 lines.
* No badges, no screenshot/GIF, no visual proof of output. Best-practice READMEs show a screenshot or a short demo clip before deep text. The repo is image-free.
* No Table of Contents. The file is 176 lines of dense tables and warnings. Users scan; they will not read 70+ lines of exit-code philosophy before trying the tool.

## Install friction — biggest drop-off point

* `README.md:28-37` states: *“It is not on the npm registry yet”*. The honest path is:
  ```bash
  git clone ... && npm install
  cd packages/gnosis && npm pack
  npm install -g ./dp-gnosis-*.tgz
  ```
  Best practice is a one-liner install. This is three steps, a pack, and a global install. First-time users will bounce. The checkout path `npm run gnosis -- <cmd>` is documented, but it is presented as a secondary “develop in checkout” option.

* Prerequisites are only “Node 22 or newer”. No mention of `better-sqlite3` build tools, no OS notes. Users hit a native-module compile error and have no link to help.

## Quick start — can a user get value in <2 minutes?

* `README.md:48-60` gives the four-command first search:
  1. `dp-gnosis init ~/notes ...`
  2. `dp-gnosis ingest`
  3. `dp-gnosis index --adapter fts5`
  4. `dp-gnosis retrieve "bm25 length normalisation"`

  It is accurate, but it is four separate commands with a mandatory “do NOT skip this” warning about `ingest`+`index` being one operation in two commands `README.md:70-72`. The mental model of *atoms → index digest → refuse on mismatch* is explained before the user has seen a single successful result.

* There is no demo corpus and no copy-paste example output. The user must supply their own `~/notes`. Best practice is a runnable minimal example with expected output. The repo explicitly says “There is no corpus in this repository” `README.md:132-135`. That is honest, but it means a fresh clone returns silence, not a hello-world.

* Profile editing is required after `init` `README.md:66-68`. The user is sent to `packages/gnosis/CONFIGURATION.md` before they have run a successful query. That is a classic “tutorial cliff”.

## Discoverability and structure

* The root README correctly splits concerns and points to `packages/gnosis/README.md` for the CLI reference. That is good separation.
* `packages/gnosis/README.md:3-14` is the CLI reference. It is exhaustive — the whole flag vocabulary is test-locked `README.md:73`. For a new user this is overwhelming. The flag table starts at line 75 and runs >100 rows. Users need a quick-start, not a spec.
* Important usability lever is buried: *Ask with keywords, not with a question* `README.md:121-130`. The measured effect “precision@10 0.20 → 0.80” is a headline that should be above the fold, not after rerank tables and doctor instructions.

* Exit-code philosophy dominates the narrative. Exit 3 = partial, refusals, index mismatch, etc. `README.md:78-80`, `README.md:93-98`. Users learn this after install. The project is correct to refuse loudly, but presenting the refusal model before a successful query increases cognitive load and fear of breaking something.

## Trust signals and support

* License is mentioned only at the very bottom `README.md:176`. No SPDX badge, no link to `SECURITY.md` in the first screen.
* No CI/status badges, no version badge, no link to issues/discussions.
* Support path is `dp-gnosis doctor` `README.md:82-92`. `doctor` is read-only and useful, but it is introduced as a troubleshooting tool rather than as a first-run health check.
* No FAQ, no “common errors” summary. The symptom table `README.md:93-98` is good, but it is the only troubleshooting surface.

## What users like, and where dp-gnosis deviates

* **Immediate value + runnable example:** Users expect copy-paste command + output. dp-gnosis gives commands but no output sample, no demo data.
* **Predictable structure with bail-out:** Users expect Name → Description → Install → Usage → Support. The root README has those sections but interleaves deep warnings and advanced options early, breaking the funnel.
* **Visual proof:** No screenshot, no GIF of `retrieve`/`answer` output. The `xml` shape is documented in `packages/gnosis/README.md:337-355` but not shown visually.
* **Clear install:** Not on npm registry = friction. The “installable, not yet published” status `README.md:168-171` is honest but demotivating for evaluation.
* **Clear query guidance:** The keyword-rewriting rule is the largest measured lever. It is present, but placed after rerank cost analysis.

## Critical risks from an end-user perspective

* **First-run failure mode is silent:** A fresh clone has an empty atoms dir. `index` and `answer` exit 0 with empty pack `README.md:136-138`. A user will think “it’s broken” rather than “point it at my markdown”.
* **Two-gate corpus model:** `corpusRoots` decides what is read; a separate path→domain rule decides what is labelled `README.md:74-76`. Unlabelled sources are refused by name. This is a landmine that will surface as “why is my doc not found?” with no obvious fix.
* **Rerank cost surprise:** `--rerank` costs ~12 s per query and needs a local llama-swap server `README.md:114-116`. The query is refused, not silently degraded, which is correct, but the user discovers this only after reading a table.
* **Documentation sprawl:** The user must read root README → `CONFIGURATION.md` → `AUTHORING.md` → `INTEGRATION.md` to be productive. That is correct for a power tool, but it violates the “README is the instruction manual” principle.

## What to fix first, without changing the engine

* Put a 30-second demo at the top of the root README: a one-liner install for evaluators, a tiny built-in demo corpus, and a copy-paste query with sample output.
* Move the keyword-rewriting rule and a 2-line example into the first screen.
* Add badges for license, Node version, and CI status.
* Replace the four-command first search with a single `dp-gnosis demo` or a `quickstart.sh` that creates a temporary instance with sample markdown.
* Surface `doctor` as a first-run health check, not only a troubleshooting tool.
* Add a Table of Contents and keep the first 200 lines focused on “install → first result → next steps”. Push the exit-code philosophy and flag reference deeper.

The project is technically honest and well-documented, but from a cold-start end-user view it asks for trust before it demonstrates value. That is the inverse of what users like.
