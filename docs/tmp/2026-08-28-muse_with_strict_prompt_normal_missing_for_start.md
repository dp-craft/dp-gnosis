# Project usability review — gnosis README from end-user perspective

Date: 2026-08-28

## Context
Review requested from end-user perspective, starting with README files as first touchpoint on GitHub. Web research on what makes a good project/README was performed.

## Research summary — what users like in a good README
* Make a README: name, description, badges, visuals/screenshots/GIFs, Installation, Usage with examples and expected output, Support, Roadmap, Contributing, License. Too long is better than too short; move detail to docs.
* Awesome README: project banner/logo, badges, clear description, TOC, demo GIF, quick install, feature list, links.
* thoughtbot How To Write A Great README: grab attention early with one-line value proposition, strong intro, syntax-highlighted code samples, call out known pitfalls, badges reflect health. Technical writing must be readable.

## Files reviewed
* /home/dev/work/dippe/dp-gnosis/README.md
* packages/gnosis/README.md
* packages/gnosis-bench/README.md

## Strengths
* Clear value proposition up top: Search your own markdown from CLI or hand to LLM as citable block.
* Honest expectations: no corpus in repo, fresh clone searches nothing, exit 0 by design.
* Common failure prevention: ingest + index are two commands, stale index leads to exit 3 refusal.
* Measured data shown: rerank benefit table with nDCG@10, with caveat about non-comparability.
* Exit-code contract explained: exit 3 = partial, not crash; doctor is read-only diagnostic.
* Navigation map: Where to go next table routes to CONFIGURATION.md, AUTHORING.md, INTEGRATION.md, handbook/GNOSIS-GUIDE.md.
* CLI reference completeness: packages/gnosis/README.md is test-locked against src/cli/args.ts, exhaustive flags, exit codes, JSON key shape.

## Usability gaps from end-user perspective
* No badges / health signals. No version, test status, license, Node requirement badges.
* No visual demo. No screenshot/GIF of real retrieve/answer run.
* Install friction front-and-center. Not on npm registry → build tarball, npm pack, npm install -g. Multi-step barrier.
* First-run flow requires manual profile edit. init creates profile then README says edit it. No example diff shown.
* Dense, warning-heavy tone. Repeated explanations of exit 3, partial refusals, two gates raise cognitive load before first success.
* No table of contents / quick anchors. 176 lines, many sections, hard to scan.
* No FAQ / Support channel. No issues link, chat, or common error list.
* Package README is reference not landing page. Starts with layout and exit codes, drowns newcomer in flags.
* Query rephrasing rule critical but buried. Single largest quality lever not surfaced in quick start.

## Recommendations
1. Above-the-fold quick start
   Add 30-second copy-paste block with expected output example.
2. Visual proof
   Add terminal recording/GIF or ASCII example of answer with citations.
3. Badges
   Add Shields for Node >=22, license GPL-3.0-or-later, test status.
4. Reduce first-run friction
   Document minimal working profile example. Consider init --demo with tiny sample corpus.
5. Separate reference from landing
   Keep root README as product story + quick start. Add short Common commands cheat sheet at top of packages/gnosis/README.md.
6. FAQ for common refusals
   Promote Search returns nothing / Exit 3 / Wrong project to concise FAQ with one-line fix.
7. Tone balance
   Keep honesty about refusals but surface after first success. Use collapsible Common pitfalls.

## Next step
Draft revised root README outline with TOC, badges placeholder, quick start block, and FAQ section based on existing content.
