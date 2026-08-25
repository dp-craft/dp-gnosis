/**
 * The one place a bench CLI decides whether a `--flag` it was handed is real.
 *
 * WHY it refuses rather than ignores: an unknown flag used to be dropped in
 * silence while the run still recorded the label that flag was meant to set — a
 * typo'd `--rerank-model` left the reranker on its default and the history row
 * still named the cross-encoder that never scored anything. That is the
 * recurring failure class of handbook/GNOSIS-GUIDE.md § Landmines: a component produced
 * nothing and the pipeline recorded it as data. The gate flags escaped it only
 * by accident, through their mutual requirement.
 */

/** What a parser accepts. The two kinds differ only in whether a token follows. */
export interface FlagSpec {
  /** Flags whose NEXT argv token is their argument, so that token is never read as a flag. */
  readonly value: readonly string[];
  /** Flags that stand alone. */
  readonly boolean: readonly string[];
}

/**
 * The gate's two flags, owned HERE rather than in `gate.ts` for one mechanical
 * reason: `gate.ts` parses `run.ts`'s argv, so `RUN_FLAGS` has to spread them at
 * module-evaluation time, and `run.ts → gate.ts → pair.ts → run.ts` is an
 * existing import cycle that leaves the export undefined at that moment. This
 * module imports nothing, so it cannot be caught in one.
 */
export const BASELINE_FLAG = '--baseline';
export const FAIL_UNDER_FLAG = '--fail-under';

/** The gate's flags as a set, spread into `RUN_FLAGS` — the gate owns no argv of its own. */
export const GATE_VALUE_FLAGS: readonly string[] = [BASELINE_FLAG, FAIL_UNDER_FLAG];

/** The end-of-flags separator. It, and every bare positional, is ignored — as it always was. */
const FLAG_END = '--';

const isFlagToken = (token: string): boolean => token.startsWith(FLAG_END) && token !== FLAG_END;

/**
 * The argv positions consumed as a value flag's ARGUMENT. A negative number
 * (`--fail-under -0.01`) lands here, and a `--`-prefixed argument does too —
 * both match what `flagValue` reads, which is argv[index + 1] whatever it holds.
 */
const argumentPositions = (
  argv: readonly string[],
  valueFlags: readonly string[]
): ReadonlySet<number> =>
  new Set(argv.flatMap((token, index) => (valueFlags.includes(token) ? [index + 1] : [])));

/** Every `--flag` in argv the spec does not declare, in the order given. */
export const unknownFlags = (argv: readonly string[], spec: FlagSpec): readonly string[] => {
  const consumed = argumentPositions(argv, spec.value);
  const known = [...spec.value, ...spec.boolean];
  return argv.filter(
    (token, index) => !consumed.has(index) && isFlagToken(token) && !known.includes(token)
  );
};

/** Refuses the FIRST unknown flag by name, listing the valid ones, as `--layer` does. */
export const assertKnownFlags = (argv: readonly string[], spec: FlagSpec): void => {
  const unknown = unknownFlags(argv, spec);
  if (unknown.length === 0) return;
  const known = [...spec.value, ...spec.boolean].sort();
  throw new Error(`dp-gnosis-bench: unknown flag "${unknown[0]}" — use ${known.join(', ')}`);
};
