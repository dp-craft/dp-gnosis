/**
 * `ingest` — run the ingest pipeline over the configured corpus roots.
 *
 * The exit code carries the skip/write split: a run that wrote atoms AND
 * refused some exits 3, not 0. Reporting a partial corpus as a clean success is
 * how a caller ends up querying a vault that is quietly missing documents.
 */
import { CORPUS_ROOTS_ENV_VAR } from '../config.js';
import { loadJudgedAtomIds } from '../goldenIds.js';
import type { IngestSkip, IngestSummary } from '../ingest.js';
import { ingest } from '../ingest.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

/** Built per call so the message names the scope THIS invocation would use. */
const unexpectedSource = (corpusRoots: readonly string[]): string =>
  `ingest takes no source path — it walks the configured corpus roots (${corpusRoots.join(
    ', '
  )}); change the scope with ${CORPUS_ROOTS_ENV_VAR}=<comma-separated repo-relative roots>`;

const skipLine = (skip: IngestSkip): string =>
  `  skipped ${skip.source} (${skip.title}): ${skip.reasons.join('; ')}`;

const ingestText = (summary: IngestSummary): string =>
  [
    `ingest: written ${summary.written}, skipped ${summary.skipped.length} (${summary.duplicates} duplicate-body)`,
    ...summary.skipped.map(skipLine),
  ].join('\n');

const summarize = (summary: IngestSummary): CommandOutcome => ({
  exitCode: summary.skipped.length === 0 ? EXIT_OK : EXIT_PARTIAL,
  data: {
    command: 'ingest',
    written: summary.written,
    skipped: summary.skipped,
    duplicates: summary.duplicates,
  },
  text: ingestText(summary),
});

/** `ingest` only: the gold source the exact-body dedupe breaks ties against. */
export const GOLD_IDS_FLAG = '--gold-ids';

/**
 * The gold source, CHOSEN VISIBLY and never defaulted: the caller's flag, else
 * the value the loaded profile declares, else nothing at all. Without gold ids
 * the exact-body dedupe is gold-BLIND and drops the judged copy of a mirrored
 * pair whenever its twin sorts first — so the shipped profiles declare their
 * `goldIdsPath` rather than letting this module read a directory nobody named.
 */
const goldSourceOf = (context: CommandContext): string | undefined =>
  stringFlag(context.flags, GOLD_IDS_FLAG) ?? context.profile.goldIdsPath;

/** Gold ids resolved, or the refusal that says why they could not be. */
type GoldIdsResult =
  | { readonly ok: true; readonly goldIds: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * A source nobody asked for is the ONE silent case — it resolves to no ids,
 * which is exactly what "no tie-break" means. A source that WAS asked for and
 * cannot be read refuses: returning empty there would dedupe by sorted path and
 * re-point which source file counts as gold, on a run that exits 0.
 */
const resolveGoldIds = (context: CommandContext): GoldIdsResult => {
  const source = goldSourceOf(context);
  if (source === undefined) return { ok: true, goldIds: [] };
  try {
    return { ok: true, goldIds: loadJudgedAtomIds(source) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * PARTIAL, not usage: the argv was well formed and the run stopped before
 * writing anything, so it belongs with every other "some of it did not happen"
 * exit the README tells a caller to branch on.
 */
const goldRefusal = (message: string): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: { command: 'ingest', written: 0, skipped: [], duplicates: 0, error: message },
  text: message,
});

const ingestCorpus = async (
  context: CommandContext,
  goldIds: readonly string[]
): Promise<CommandOutcome> =>
  summarize(
    await ingest({
      corpusRoots: context.corpusRoots,
      outputDir: context.atomsDir,
      repoRoot: context.repoRoot,
      profile: context.profile,
      goldIds,
    })
  );

/**
 * A corpus scope that resolves to nothing is a USAGE error, not a crash: the
 * roots are caller-configured, and the refusal names the correction. Letting it
 * escape as an uncaught throw exits 1 — outside the 0/2/3 vocabulary the README
 * tells callers to branch on — so it is routed through the same usage path
 * every other bad input takes.
 */
const attemptIngest = async (
  context: CommandContext,
  goldIds: readonly string[]
): Promise<CommandOutcome> => {
  try {
    return await ingestCorpus(context, goldIds);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
};

const withGoldIds = async (context: CommandContext): Promise<CommandOutcome> => {
  const gold = resolveGoldIds(context);
  return gold.ok ? await attemptIngest(context, gold.goldIds) : goldRefusal(gold.message);
};

export const runIngestCommand = async (context: CommandContext): Promise<CommandOutcome> =>
  context.positionals.length > 0
    ? usageError(unexpectedSource(context.corpusRoots))
    : await withGoldIds(context);
