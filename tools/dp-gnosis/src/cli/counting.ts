/**
 * Counting at the COMMAND boundary: what one atom costs the budget, resolved
 * once per run and handed to `budget.ts` as a pure synchronous measure.
 *
 * The text charged is INJECTED rather than fixed to `atom.body`, because a
 * command that renders something else — a summary, a window, a joined group —
 * would otherwise budget against text it never emits, admitting atoms whose
 * real cost it never counted. `retrieve` charges the body, so its numbers are
 * unchanged; a second command states its own {@link ChargedText}.
 */
import type { AtomMeasure } from '../budget.js';
import { estimateTokens } from '../budget.js';
import type { BudgetMode } from '../config.js';
import type { RetrievedAtom } from '../port.js';
import type { TokenCounter, TokenCountResult } from '../tokenize.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_PARTIAL } from './outcome.js';

export const BUDGET_MODE_FLAG = '--budget-mode';

/**
 * A resolved measure, or the named reason the run has none. There is no third
 * case: falling back to the byte bound under `--budget-mode tokens` would
 * report an upper bound as a real count.
 */
export type MeasureResult =
  | { readonly ok: true; readonly measure: AtomMeasure }
  | { readonly ok: false; readonly reason: string };

/**
 * Counting at the COMMAND boundary: every atom is measured here, once, and the
 * budget layer receives a pure synchronous function. `budget.ts` does no I/O.
 */
export type CountAtoms = (atoms: readonly RetrievedAtom[]) => Promise<MeasureResult>;

/** What one atom costs the budget, as the TEXT the caller will actually emit. */
export type ChargedText = (atom: RetrievedAtom) => string;

/** The atom as `retrieve` delivers it, which is what `retrieve` is charged for. */
export const bodyText: ChargedText = (atom: RetrievedAtom): string => atom.body;

/** `--budget-mode bytes`: the historical measure, resolved without a round trip. */
export const byteCounting = (charged: ChargedText): CountAtoms =>
  async (): Promise<MeasureResult> => ({
    ok: true,
    measure: (atom: RetrievedAtom): number => estimateTokens(charged(atom)),
  });

type CountedSoFar =
  | { readonly ok: true; readonly counts: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly reason: string };

const EMPTY_COUNTS: CountedSoFar = { ok: true, counts: new Map() };

const countRefusal = (atom: RetrievedAtom, reason: string): string =>
  `atom ${atom.id} could not be counted — ${reason}`;

const withCount = (counter: TokenCounter, charged: ChargedText) =>
  async (soFar: CountedSoFar, atom: RetrievedAtom): Promise<CountedSoFar> => {
    if (!soFar.ok) return soFar;
    const counted = await counter.count(charged(atom));
    return counted.ok
      ? { ok: true, counts: new Map(soFar.counts).set(atom.id, counted.count) }
      : { ok: false, reason: countRefusal(atom, counted.reason) };
  };

/**
 * One `/tokenize` call per atom, SEQUENTIALLY: a retrieve budgets at most ~100
 * atoms and llama-swap serves one model at a time, so a parallel burst buys
 * nothing and risks queueing behind itself. The first failure stops the walk.
 */
const countAll = async (
  counter: TokenCounter,
  charged: ChargedText,
  atoms: readonly RetrievedAtom[]
): Promise<CountedSoFar> => {
  const step = withCount(counter, charged);
  return await atoms.reduce(
    async (acc: Promise<CountedSoFar>, atom) => await step(await acc, atom),
    Promise.resolve(EMPTY_COUNTS)
  );
};

/**
 * The pure measure the budget runs on. An atom absent from the map is
 * unreachable — the map is built from the very atoms being budgeted — and is
 * charged INFINITY rather than a byte bound, so an unmeasured atom can never be
 * admitted under a count it never got.
 */
const measureFrom = (counts: ReadonlyMap<string, number>): AtomMeasure =>
  (atom: RetrievedAtom): number => counts.get(atom.id) ?? Number.POSITIVE_INFINITY;

const tokenCounting = (counter: TokenCounter, charged: ChargedText): CountAtoms =>
  async (atoms: readonly RetrievedAtom[]): Promise<MeasureResult> => {
    const counted = await countAll(counter, charged, atoms);
    return counted.ok ? { ok: true, measure: measureFrom(counted.counts) } : counted;
  };

/**
 * The one wording for "`--budget-mode tokens` was asked for and cannot be
 * honoured". It names the CONDITION and the correction; the run exits PARTIAL
 * rather than quietly enforcing the byte bound under a token label.
 *
 * The command NAMES itself rather than the prefix being fixed to `retrieve`: a
 * second command's refusal that opened with another command's name would send
 * the reader to a run that never happened.
 */
export const budgetRefusal = (command: string, reason: string): string =>
  `${command}: ${BUDGET_MODE_FLAG} tokens could not count with the served tokenizer — ${reason}; re-run with \`${BUDGET_MODE_FLAG} bytes\` to budget by the conservative UTF-8 bound instead`;

/** The command NAMES itself, so a second command's payload is not labelled `retrieve`. */
export const budgetRefusalOutcome = (command: string, reason: string): CommandOutcome => {
  const message = budgetRefusal(command, reason);
  return {
    exitCode: EXIT_PARTIAL,
    data: { command, budgetMode: 'tokens', error: message },
    text: message,
  };
};

/**
 * What ONE fixed text costs the budget, in the SAME measure the atoms are
 * charged in. A command that emits chrome around the atoms — a delimited block,
 * a preamble — reserves it with this, so the ceiling bounds what is emitted
 * rather than only the atoms inside it.
 */
export type CountOne = (text: string) => Promise<TokenCountResult>;

const byteCountOne: CountOne = async (text: string): Promise<TokenCountResult> => ({
  ok: true,
  count: estimateTokens(text),
});

/** One tokenizer call, never a per-atom walk: the reserve is a single string. */
const tokenCountOne = (counter: TokenCounter): CountOne =>
  async (text: string): Promise<TokenCountResult> => await counter.count(text);

type CountingResult =
  | { readonly ok: true; readonly counting: CountAtoms; readonly countOne: CountOne }
  | { readonly ok: false; readonly reason: string };

/**
 * The STARTUP probe. `--budget-mode tokens` proves the route answers before the
 * run depends on it, so a dead tokenizer is a refusal rather than a surprise
 * halfway through the atoms.
 */
export const resolveCounting = async (
  mode: BudgetMode,
  counter: TokenCounter,
  charged: ChargedText
): Promise<CountingResult> => {
  if (mode === 'bytes') {
    return { ok: true, counting: byteCounting(charged), countOne: byteCountOne };
  }
  const probe = await counter.probe();
  return probe.ok
    ? { ok: true, counting: tokenCounting(counter, charged), countOne: tokenCountOne(counter) }
    : { ok: false, reason: probe.reason };
};
