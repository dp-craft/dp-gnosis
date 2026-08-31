/**
 * The vocabulary every bench CLI entry point repeated verbatim: flag reading,
 * error rendering, the direct-invocation guard, the numeric cell and the exit
 * table. Each of these existed as a per-tool copy; a copy that drifts is a
 * silent behavior difference between two tools that document the same contract.
 *
 * Imported by non-CLI modules too (`fuseForecast.ts` renders the same cell) —
 * the shape is what is shared, not the entry-point role.
 */

import { pathToFileURL } from 'node:url';

/** How many decimals a measured cell serializes with, across every tool. */
const CELL_DIGITS = 4;

/**
 * FIRST occurrence wins — `run.ts` semantics, now the only semantics. Three
 * tools previously took the LAST occurrence, so the same argv produced
 * different values depending on which binary read it.
 */
export const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/** A thrown value rendered for stderr — `unknown` is the only honest input type. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * True when THIS module URL is the process entry point, so a tool imported by a
 * test does not run its `main`. Callers pass their own `import.meta.url`.
 */
export const invokedDirectly = (moduleUrl: string): boolean =>
  process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;

/** An unmeasurable cell is EMPTY, never `0` and never `n/a` — the `report.ts:tsvCell` precedent. */
export const cell = (value: number | undefined): string =>
  value === undefined ? '' : value.toFixed(CELL_DIGITS);

/** The run, or the report, was produced. */
export const TOOL_EXIT_OK = 0;
/** Unusable invocation — unknown flag, missing required flag, unparseable value. */
export const TOOL_EXIT_USAGE = 2;
/** A guard refused: the inputs are readable but the measurement would be unsound. */
export const TOOL_EXIT_REFUSED = 3;
/** A gate ran and its threshold was not met. */
export const TOOL_EXIT_GATE_FAILED = 4;

/** A thrown value's `error.cause` when it names one, `undefined` for anything else. */
const causeOf = (error: unknown): string | undefined =>
  error instanceof Error && typeof error.cause === 'string' ? error.cause : undefined;

/**
 * The code a tool's outermost `catch` returns. A guard that REFUSED is not an
 * unusable invocation: the argv parsed and the inputs were readable, and only
 * the data was not what the invocation claimed. Collapsing both into 2 is what
 * made a refusal indistinguishable from a typo at the call site.
 *
 * `refusalCauses` is per tool — a cause another tool owns is not this tool's
 * refusal, so it stays usage.
 */
export const exitCodeOf = (error: unknown, refusalCauses: readonly string[]): number => {
  const cause = causeOf(error);
  return cause !== undefined && refusalCauses.includes(cause)
    ? TOOL_EXIT_REFUSED
    : TOOL_EXIT_USAGE;
};
