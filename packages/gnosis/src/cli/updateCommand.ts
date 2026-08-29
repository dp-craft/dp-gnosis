/**
 * `update` — `ingest` then `index`, in that order, as ONE command.
 *
 * They are one operation in two commands and the second is the routinely
 * forgotten half: an `ingest` alone restamps `corpus-manifest.json` with a new
 * digest while the index beside it still carries the old one, so the next query
 * refuses — silently, as far as any test suite is concerned, because no gate
 * queries the production index (`handbook/GNOSIS-GUIDE.md` § Landmines).
 *
 * Owner decision, 2026-08-29 — the exit code. `update` exits with the
 * HIGHEST-SEVERITY outcome of the two hops. So an `ingest` that exits 3
 * (partial: some files skipped, each with a reason) followed by an `index` that
 * exits 0 makes `update` exit 3, not 0: `EXIT_PARTIAL` already means "real
 * output was produced AND something was refused", which is precisely this
 * state, and a caller reading 0 would never learn files were skipped.
 *
 * A USAGE error from `ingest` STOPS the command before `index` runs at all —
 * there is nothing to index, and the second failure would bury the first. An
 * `ingest` that exits 3 DOES proceed: partial atoms are still atoms, and it is
 * exactly the case where leaving the index stale does the damage.
 *
 * BOTH hops are reported, never just the last: `data` carries each payload under
 * its own key so a `--json` caller can see WHICH half refused, and the text
 * shows both renderings in order.
 *
 * Neither hop is re-implemented here. This module composes the two handlers, so
 * every flag, refusal and diagnostic either command owns reaches `update`
 * unchanged.
 */
import type { CommandContext } from './context.js';
import { runIndexCommand } from './indexCommand.js';
import { runIngestCommand } from './ingestCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from './outcome.js';

/**
 * The exit vocabulary ORDERED by severity, which is not its numeric order: a
 * usage failure (2) outranks a partial result (3). Taking the numeric maximum
 * would report a refused invocation as a partial success — the one reading a
 * caller must not be given.
 */
const MOST_SEVERE = 2;

const SEVERITY: Readonly<Record<number, number>> = {
  [EXIT_OK]: 0,
  [EXIT_PARTIAL]: 1,
  [EXIT_USAGE]: MOST_SEVERE,
};

/** A code outside the vocabulary is treated as the MOST severe, never as success. */
const severity = (code: number): number => SEVERITY[code] ?? MOST_SEVERE;

const worst = (left: number, right: number): number =>
  severity(left) >= severity(right) ? left : right;

const NOT_INDEXED =
  'index: not run — ingest refused the invocation, so there is nothing to index and a second failure would bury the first';

/** The short-circuit rendering: one hop ran, and the payload says so explicitly. */
const refused = (ingest: CommandOutcome): CommandOutcome => ({
  exitCode: ingest.exitCode,
  data: { command: 'update', ingest: ingest.data, index: null },
  text: [ingest.text, NOT_INDEXED].join('\n'),
});

const both = (ingest: CommandOutcome, index: CommandOutcome): CommandOutcome => ({
  exitCode: worst(ingest.exitCode, index.exitCode),
  data: { command: 'update', ingest: ingest.data, index: index.data },
  text: [ingest.text, index.text].join('\n'),
});

export const runUpdateCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const ingested = await runIngestCommand(context);
  return ingested.exitCode === EXIT_USAGE
    ? refused(ingested)
    : both(ingested, await runIndexCommand(context));
};
