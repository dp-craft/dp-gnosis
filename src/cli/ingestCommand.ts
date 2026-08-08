/**
 * `ingest` — run the ingest pipeline over the given sources.
 *
 * The exit code carries the skip/write split: a run that wrote atoms AND
 * refused some exits 3, not 0. Reporting a partial corpus as a clean success is
 * how a caller ends up querying a vault that is quietly missing documents.
 */
import type { IngestSkip, IngestSummary } from '../ingest.js';
import { ingest } from '../ingest.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

const NO_SOURCE =
  'ingest requires at least one source path — pass the markdown files or directories to ingest, e.g. `ingest claude-artifacts/standards --atoms-dir <dir>`';

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

const ingestSources = async (
  context: CommandContext,
  sources: readonly string[]
): Promise<CommandOutcome> =>
  summarize(
    await ingest({ sources, outputDir: context.atomsDir, repoRoot: context.repoRoot })
  );

export const runIngestCommand = async (context: CommandContext): Promise<CommandOutcome> =>
  context.positionals.length === 0
    ? usageError(NO_SOURCE)
    : await ingestSources(context, context.positionals);
