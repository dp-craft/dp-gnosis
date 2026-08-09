/**
 * `ingest` — run the ingest pipeline over the configured corpus roots.
 *
 * The exit code carries the skip/write split: a run that wrote atoms AND
 * refused some exits 3, not 0. Reporting a partial corpus as a clean success is
 * how a caller ends up querying a vault that is quietly missing documents.
 */
import { CORPUS_ROOTS_ENV_VAR, resolveCorpusRoots } from '../config.js';
import type { IngestSkip, IngestSummary } from '../ingest.js';
import { ingest } from '../ingest.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

/** Built per call so the message names the scope THIS invocation would use. */
const unexpectedSource = (): string =>
  `ingest takes no source path — it walks the configured corpus roots (${resolveCorpusRoots().join(
    ', '
  )}); change the scope with ${CORPUS_ROOTS_ENV_VAR}=<comma-separated repo-relative roots>`;

const skipLine = (skip: IngestSkip): string =>
  `  skipped ${skip.source} (${skip.title}): ${skip.reasons.join('; ')}`;

const ingestText = (summary: IngestSummary): string =>
  [
    `ingest: written ${summary.written}, skipped ${summary.skipped.length}`,
    ...summary.skipped.map(skipLine),
  ].join('\n');

const summarize = (summary: IngestSummary): CommandOutcome => ({
  exitCode: summary.skipped.length === 0 ? EXIT_OK : EXIT_PARTIAL,
  data: { command: 'ingest', written: summary.written, skipped: summary.skipped },
  text: ingestText(summary),
});

const ingestCorpus = async (context: CommandContext): Promise<CommandOutcome> =>
  summarize(await ingest({ outputDir: context.atomsDir, repoRoot: context.repoRoot }));

export const runIngestCommand = async (context: CommandContext): Promise<CommandOutcome> =>
  context.positionals.length > 0 ? usageError(unexpectedSource()) : await ingestCorpus(context);
