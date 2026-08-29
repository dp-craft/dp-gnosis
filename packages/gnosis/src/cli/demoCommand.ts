/**
 * `demo` — a stranger who owns no corpus types one word and sees ranked hits.
 *
 * It ingests, indexes and searches THIS PACKAGE'S OWN documentation
 * (`paths.ts:DEMO_CORPUS_ROOTS`, walked under `demoCorpusRoot()`), so it needs
 * no vault, no configuration and no declared repository — which is why it is
 * exempt from the `repoRoot`-must-be-declared check, exactly as `init` is.
 *
 * Owner decision, 2026-08-29 — where its data lives: a FIXED `demo/` subtree
 * under the resolved data root, `demoAtomsDir()` and `demoIndexPath()`. It MUST
 * NOT use the default atoms or index paths under ANY circumstance. `ingest`
 * WRITES AND PRUNES — it makes its output tree hold exactly the current run's
 * write set — so a demo pointed at the default locations would claim, restamp
 * and prune a real vault's atoms, on the one command whose promise is that
 * trying it costs the reader nothing. The fixed subtree makes that impossible
 * rather than unlikely.
 *
 * Exit 0 means it produced HITS. Producing none is a FAULT reported loudly, not
 * a quiet 0: a component that produced nothing and had it recorded as data is
 * the failure class this repository exists to police, and as a first-run
 * experience it is also the whole product misrepresenting itself.
 *
 * None of the three stages is re-implemented — the command composes the shipped
 * handlers against a context whose paths it has replaced.
 */
import { loadIngestProfile } from '../ingestProfile.js';
import {
  DEMO_CORPUS_ROOTS,
  demoAtomsDir,
  demoCorpusRoot,
  demoProfilePath
} from '../paths.js';
import { demoIndexPath } from './adapter.js';
import type { CommandContext } from './context.js';
import { runIndexCommand } from './indexCommand.js';
import { runIngestCommand } from './ingestCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import { runRetrieveCommand } from './retrieveCommand.js';

/**
 * The built-in query. It is a single ordinary word that the four shipped
 * documents genuinely answer — verified against a real run, because a demo that
 * returns nothing is this repository's failure class as a first-run experience.
 */
const DEMO_QUERY = 'retrieval';

const NO_POSITIONALS =
  'demo takes no arguments — it brings its own corpus and its own query; use `search <query>` to search your own vault';

/**
 * The invocation the three hops actually run: the demo profile, the demo corpus
 * and the demo paths, REPLACING whatever the caller's instance resolved to. It
 * carries NO positional — `ingest` refuses one — so the query is attached for
 * the search hop alone, by {@link searchContext}.
 */
const demoContext = (context: CommandContext): CommandContext => ({
  ...context,
  positionals: [],
  profile: loadIngestProfile(demoProfilePath()),
  profilePath: demoProfilePath(),
  repoRoot: demoCorpusRoot(),
  corpusRoots: DEMO_CORPUS_ROOTS,
  atomsDir: demoAtomsDir(),
  indexPath: demoIndexPath(context.adapter),
});

/** The three hops, in the one order that makes the third one answerable. */
interface DemoRun {
  readonly ingest: CommandOutcome;
  readonly index: CommandOutcome;
  readonly search: CommandOutcome;
}

/** The query, supplied as the positional the retrieval handler already reads. */
const searchContext = (demo: CommandContext): CommandContext => ({
  ...demo,
  positionals: [DEMO_QUERY],
});

const runHops = async (demo: CommandContext): Promise<DemoRun> => {
  const ingest = await runIngestCommand(demo);
  const index = await runIndexCommand(demo);
  return { ingest, index, search: await runRetrieveCommand(searchContext(demo)) };
};

/** Read off the search payload, never re-derived: an absent count is zero hits. */
const hitCount = (search: CommandOutcome): number => {
  const count = search.data.count;
  return typeof count === 'number' ? count : 0;
};

const whereLine = (demo: CommandContext): string =>
  `demo: ${DEMO_CORPUS_ROOTS.length} shipped documents ingested into ${demo.atomsDir} and indexed at ${demo.indexPath}, then searched for "${DEMO_QUERY}" — your own corpus is untouched, because demo never reads or writes the default atoms and index locations`;

const noHits = (demo: CommandContext): string =>
  `FAULT: demo found no hits for "${DEMO_QUERY}" in its own shipped documentation under ${demo.atomsDir} — the demo corpus or its index produced nothing, which is a defect in this build, not an empty answer to your question`;

const faultLines = (demo: CommandContext, hits: number): readonly string[] =>
  hits > 0 ? [] : [noHits(demo)];

const outcome = (demo: CommandContext, run: DemoRun): CommandOutcome => {
  const hits = hitCount(run.search);
  return {
    exitCode: hits > 0 ? EXIT_OK : EXIT_PARTIAL,
    data: {
      command: 'demo',
      query: DEMO_QUERY,
      corpus: DEMO_CORPUS_ROOTS,
      atomsDir: demo.atomsDir,
      indexPath: demo.indexPath,
      ingest: run.ingest.data,
      index: run.index.data,
      search: run.search.data,
    },
    text: [run.search.text, whereLine(demo), ...faultLines(demo, hits)].join('\n'),
  };
};

export const runDemoCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  if (context.positionals.length > 0) return usageError(NO_POSITIONALS);
  const demo = demoContext(context);
  return outcome(demo, await runHops(demo));
};
