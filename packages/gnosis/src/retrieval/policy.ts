/**
 * The retrieval POLICY of a `search` run — how deep the first pass goes, what
 * the per-document cap and the `-k` slice leave, what the calibrated floor
 * removes, what the token budget fits, and how much evidence the delivered
 * atoms carry.
 *
 * It is separated from `cli/retrieveCommand.ts` because none of it is
 * presentation: the CLI parses the flags and renders the three outputs, and
 * every decision that changes WHICH atoms are delivered is made here, once, so
 * a second caller cannot acquire a second copy of it by re-deriving the rules.
 */
import type { VocabularyGap } from '../adapters/fts5VocabularyGap.js';
import type { AtomMeasure, SkippedAtom } from '../budget.js';
import { fitToTokenBudget } from '../budget.js';
import type { CommandContext } from '../cli/context.js';
import {
  capPerDocument,
  groupByDocument,
  GROUPED_POOL_FLOOR,
  NO_CAP
} from '../cli/grouping.js';
import type { BudgetMode, FieldWeights } from '../config.js';
import { ABSTAIN_FLOOR } from '../config.js';
import type { RetrievalResult, RetrievedAtom, RetrieveOptions } from '../port.js';
import type { PrfParams } from '../prf.js';
import type { RerankOptions } from '../rerank.js';
import { calibrate, rerankCalibrationKey } from '../rerank.js';
import type { AtomDomain, AtomType } from '../vocabulary.js';

/**
 * The `RERANK_CALIBRATION` key this run may be read against — the SAME four
 * tiers `rerank.ts` resolves, and `undefined` under a backend that has no
 * measured scale.
 */
export const rerankModelOf = (options: RerankOptions): string | undefined => rerankCalibrationKey(options);

/**
 * WHICH switch turned the feedback pass on — the one thing a caller cannot
 * recover from the reported cell, since a tuning flag shows up in the cell
 * itself. `flag` = an explicit `--prf`; `profile` = the profile's `defaultPrf`.
 */
export type PrfSourceName = 'flag' | 'profile';

export interface RetrieveRequest {
  readonly context: CommandContext;
  readonly query: string;
  readonly k: number;
  readonly maxTokens: number;
  /** How `maxTokens` is counted. REPORTED, so a reader knows which measure ran. */
  readonly budgetMode: BudgetMode;
  /** `undefined` = unfiltered. Never an empty list — the port refuses that. */
  readonly types: readonly AtomType[] | undefined;
  /**
   * The knowledge domains to search, as `--domain` named them against THIS
   * invocation's profile. `undefined` = unfiltered; never an empty list, which
   * the port refuses.
   */
  readonly domains: readonly AtomDomain[] | undefined;
  /**
   * At most this many atoms from one source document, and the answer arranged by
   * document. `undefined` = `--flat`: no cap, no grouping, no position marker.
   */
  readonly maxPerDoc: number | undefined;
  /**
   * The BM25F column weights the first pass scores under — the shipped defaults
   * unless `--field-weights` overrode a column. Body-only by default, so an
   * absent sidecar reproduces today's ranking byte for byte.
   */
  readonly fieldWeights: FieldWeights;
  readonly rerank: boolean;
  /** The reranker's model and fusion rule as the tuning flags resolved them. */
  readonly rerankOptions: RerankOptions;
  /**
   * How many first-pass candidates the reranker is handed — the flag, else the
   * profile's `rerankPoolK`, else `RERANK_K_INIT`. It is a FLOOR under the
   * pool, never a cap: a `-k` deeper than it keeps its own depth.
   */
  readonly rerankPoolK: number;
  /** The calibrated relevance floor; `undefined` when no floor was asked for. */
  readonly minRelevance: number | undefined;
  readonly rephrase: boolean;
  /**
   * The RM3 knobs `--prf` resolved; `undefined` when no feedback pass was asked
   * for, which is what keeps the default ranking byte for byte what it was.
   */
  readonly prf: PrfParams | undefined;
  /**
   * Which switch turned that pass on — REPORTED, because the cell alone cannot
   * say whether the caller asked or the profile did. `undefined` when no pass
   * ran, so it is set exactly when {@link RetrieveRequest.prf} is.
   */
  readonly prfSource: PrfSourceName | undefined;
  /**
   * The line an unhonoured PROFILE feedback default must carry, so an
   * unexpanded ranking is never delivered as an expanded one. `undefined` when
   * the profile stated none, or when the adapter honoured it.
   */
  readonly prfNote: string | undefined;
  /** The rewrite `--rephrase` produced; `undefined` when it was off or refused. */
  readonly queryRewritten: string | undefined;
  /** The rewriter's refusal, carried into the note and the PARTIAL exit code. */
  readonly rephraseRefusal: string | undefined;
  /** The reranker's refusal, carried the same way. `undefined` when it ranked. */
  readonly rerankRefusal: string | undefined;
  /**
   * C11a — which analysed query terms reach ZERO atoms in the index that was
   * searched. `undefined` when no such measurement was possible: a non-fts5
   * adapter, or an index that was not `ready`. Absence is "not measured", never
   * "no gap" — a diagnostic that reports a clean zero for an index it could not
   * open is the failure class this whole family of warnings exists to end.
   */
  readonly vocabularyGap: VocabularyGap | undefined;
}

/**
 * The budget outcome as the renderings see it: `result.atoms` is already the
 * KEPT set, and `skipped` is what the caller must still be told about.
 */
export interface BudgetedResult {
  readonly result: RetrievalResult;
  readonly skipped: readonly SkippedAtom[];
  readonly maxTokens: number;
  /**
   * How many atoms the FIRST PASS returned, before the `-k` slice and before the
   * budget. `count` alone cannot say whether a short answer means a thin corpus
   * or a deep pool the caller asked to cut.
   */
  readonly poolSize: number;
  /**
   * How many atoms of that first pass SURVIVE the per-document cap, which is the
   * most the answer can deliver. Equal to `poolSize` whenever the cap subtracted
   * nothing (`--flat`, `NO_CAP`, or a pool of distinct documents). The count is
   * order-invariant — it is `sum over documents of min(cap, atoms)` — so it is
   * the same before and after a rerank reorders the pool.
   */
  readonly cappedPool: number;
  /**
   * How many atoms the calibrated floor removed BECAUSE THEY SCORED BELOW IT.
   * Zero on every run that named no floor, so an unfiltered run reports nothing
   * new. An atom dropped for carrying no score at all is counted by `unscored`
   * instead — the two are different facts and only one is a measurement.
   */
  readonly belowFloor: number;
  /** Atoms the floor dropped that carried NO calibrated score to judge. */
  readonly unscored: number;
  /** The floor those atoms fell below; `undefined` when none was in effect. */
  readonly minRelevance: number | undefined;
  /** `false` when a floor was named but deliberately not run — see {@link applyFloor}. */
  readonly floorApplied: boolean;
  /**
   * What the KEPT atoms cost, plus the chrome a command reserved before the fit.
   * It is the number a rendering states as "used of `maxTokens`"; `maxTokens`
   * stays the FULL ceiling the caller passed, so the two are comparable.
   */
  readonly usedTokens: number;
}

/**
 * How much CALIBRATED evidence stands behind the delivered atoms.
 *
 * Three values, judged against the MEASURED {@link ABSTAIN_FLOOR} unless
 * `--min-relevance` named its own:
 *
 *   `none` nothing was delivered, so there is nothing to be confident about;
 *   `ok`   the top delivered atom's calibrated probability clears the floor;
 *   `weak` atoms were delivered whose best calibrated probability is below the
 *          floor, or that carry no calibrated evidence at all — no rerank, a
 *          refused rerank, or an uncalibrated model.
 *
 * The verdict alone reads the default floor. A run that delivers atoms delivers
 * exactly the same atoms whatever this says; only `--min-relevance` DROPS.
 */
export type RetrieveConfidence = 'none' | 'weak' | 'ok';

/** The calibrated probability behind one atom; `undefined` = no such evidence. */
const calibratedOf = (request: RetrieveRequest, atom: RetrievedAtom): number | undefined => {
  const model = rerankModelOf(request.rerankOptions);
  return atom.rerankScore === undefined || model === undefined
    ? undefined
    : calibrate(model, atom.rerankScore);
};

/**
 * The strongest evidence delivered, chosen by SCORE rather than by position:
 * grouping arranges the answer for reading, so the first line is the first atom
 * of the best-ranked DOCUMENT, which need not be the best-scoring atom. On an
 * ungrouped answer the two are the same atom, so no `--flat` run moves.
 */
const bestScored = (atoms: readonly RetrievedAtom[]): RetrievedAtom | undefined =>
  atoms.reduce<RetrievedAtom | undefined>(
    (best, atom) => (best === undefined || atom.score > best.score ? atom : best),
    undefined
  );

const topCalibrated = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): number | undefined => {
  const top = bestScored(budgeted.result.atoms);
  return top === undefined ? undefined : calibratedOf(request, top);
};

/**
 * The floor the VERDICT is judged against: the explicit `--min-relevance` when
 * one was passed, else the measured {@link ABSTAIN_FLOOR}.
 *
 * Only the verdict reads this. Every DROP path keeps reading
 * `minRelevance` alone, so the default floor changes what a run CLAIMS and
 * never what it delivers.
 */
const verdictFloor = (budgeted: BudgetedResult): number =>
  budgeted.minRelevance ?? ABSTAIN_FLOOR;

const meetsFloor = (request: RetrieveRequest, budgeted: BudgetedResult): boolean => {
  const top = topCalibrated(request, budgeted);
  return top !== undefined && top >= verdictFloor(budgeted);
};

export const confidenceOf = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): RetrieveConfidence => {
  if (budgeted.result.atoms.length === 0) return 'none';
  return meetsFloor(request, budgeted) ? 'ok' : 'weak';
};

/**
 * How deep the FIRST PASS must go before the cap subtracts from it.
 *
 * The cap drops atoms off the TOP of the ranking, so a pool of exactly `k` would
 * deliver fewer than `k` the moment one document holds several of the best
 * atoms. `k * maxPerDoc` is the pool in which `k` distinct documents could each
 * contribute their whole cap — a STATED heuristic, not a guarantee: a pool made
 * of one document still delivers that document's cap and no more, and `count`
 * reports what was actually served.
 *
 * `k * maxPerDoc` ALONE is inverted, and shipped that way: it SHRINKS the pool
 * as the cap tightens, while a tighter cap needs `ceil(k / cap)` distinct
 * documents and so a DEEPER one. {@link GROUPED_POOL_FLOOR} is the floor that
 * corrects it, exactly as `RERANK_K_INIT` floors the rerank pool.
 *
 * `--flat` and `NO_CAP` subtract nothing, so both keep the pool at exactly `k`
 * and their output is byte-identical to the ungrouped renderer's.
 */
const cappedPoolK = (request: RetrieveRequest): number => {
  const cap = request.maxPerDoc;
  if (cap === undefined || cap === NO_CAP) return request.k;
  return Math.max(request.k * cap, GROUPED_POOL_FLOOR);
};

const firstPassK = (request: RetrieveRequest): number =>
  request.rerank ? Math.max(cappedPoolK(request), request.rerankPoolK) : cappedPoolK(request);

/**
 * Each filter is OMITTED rather than sent as `undefined`, so an adapter cannot
 * read "no filter asked for" as "filter on nothing".
 */
export const retrieveOptions = (request: RetrieveRequest): RetrieveOptions => ({
  k: firstPassK(request),
  ...(request.types === undefined ? {} : { types: request.types }),
  ...(request.domains === undefined ? {} : { domains: request.domains }),
  ...(request.prf === undefined ? {} : { prf: request.prf }),
});

/**
 * The delivered set, out of the deeper pool `firstPassK` asked the port for: the
 * per-document cap, then the `-k` slice, then reading order within each
 * document.
 *
 * The order is load-bearing. Capping BEFORE the slice is what lets a lower-
 * ranked document's atom take a freed slot; grouping AFTER it is what keeps the
 * delivered atoms the `k` best-ranked ones the cap left — the arrangement
 * changes how they are read, never which ones they are.
 *
 * `--flat` (`maxPerDoc === undefined`) does neither, so it is the plain slice it
 * always was.
 */
const arranged = (
  atoms: readonly RetrievedAtom[],
  maxPerDoc: number | undefined
): readonly RetrievedAtom[] =>
  maxPerDoc === undefined ? atoms : groupByDocument(atoms).flatMap(group => group.atoms);

export const trimmed = (result: RetrievalResult, request: RetrieveRequest): RetrievalResult => {
  const cap = request.maxPerDoc;
  const capped = cap === undefined ? result.atoms : capPerDocument(result.atoms, cap);
  return { ...result, atoms: arranged(capped.slice(0, request.k), cap) };
};

/** The delivered ranking after the floor, and how many atoms it removed. */
export interface FlooredResult {
  readonly result: RetrievalResult;
  readonly belowFloor: number;
  readonly unscored: number;
  readonly minRelevance: number | undefined;
  readonly applied: boolean;
}

/** The ranking untouched, carrying the floor that was named but not run. */
const unfloored = (result: RetrievalResult, floor: number | undefined): FlooredResult => ({
  result,
  belowFloor: 0,
  unscored: 0,
  minRelevance: floor,
  applied: false,
});

const clearsFloor = (request: RetrieveRequest, floor: number, atom: RetrievedAtom): boolean => {
  const probability = calibratedOf(request, atom);
  return probability !== undefined && probability >= floor;
};

/**
 * The calibrated floor, applied to the atoms AS DELIVERED — after the rerank and
 * after the `-k` slice, immediately before the budget.
 *
 * It is SKIPPED ENTIRELY when the rerank was refused. Nothing was scored then,
 * so every atom would be dropped for lacking a measurement that never happened
 * — turning a transient server fault into `count: 0`, which the caller contract
 * reads as "it is not in the vault". A refused rerank MUST NOT be able to assert
 * a false negative about the corpus.
 *
 * SUBTRACTIVE and nothing else: it filters the list in place, so the surviving
 * atoms keep their relative order, no atom is promoted out of the deeper pool to
 * replace a dropped one, and `poolSize` is untouched. An atom with no calibrated
 * probability is dropped rather than kept — the floor asks for evidence, and
 * absent evidence is not evidence of relevance.
 */
export const applyFloor = (request: RetrieveRequest, result: RetrievalResult): FlooredResult => {
  const floor = request.minRelevance;
  if (floor === undefined || request.rerankRefusal !== undefined) return unfloored(result, floor);
  const kept = result.atoms.filter(atom => clearsFloor(request, floor, atom));
  const dropped = result.atoms.filter(atom => !clearsFloor(request, floor, atom));
  const unscored = dropped.filter(atom => calibratedOf(request, atom) === undefined).length;
  return {
    result: { ...result, atoms: kept },
    belowFloor: dropped.length - unscored,
    unscored,
    minRelevance: floor,
    applied: true,
  };
};

/** What the first pass returned, and how much of it the cap leaves deliverable. */
export interface PoolFacts {
  readonly size: number;
  readonly capped: number;
}

/**
 * How many atoms of the pool survive the per-document cap. Read off the FIRST
 * PASS rather than the delivered slice: the count is order-invariant, so it is
 * the ceiling on what any arrangement of that pool could have delivered.
 */
export const poolFacts = (request: RetrieveRequest, pool: readonly RetrievedAtom[]): PoolFacts => ({
  size: pool.length,
  capped:
    request.maxPerDoc === undefined ? pool.length : capPerDocument(pool, request.maxPerDoc).length,
});

/**
 * The budget as resolved: the ceiling, and the measure that charges against it.
 */
export interface BudgetSpec {
  readonly maxTokens: number;
  readonly measure: AtomMeasure;
  /**
   * The chrome a command emits AROUND the atoms, already counted in the active
   * measure. It is subtracted from `maxTokens` before the fit, so the ceiling
   * bounds what is emitted rather than only the atoms inside it. `search`
   * reserves nothing and passes 0, keeping its fit byte-identical.
   */
  readonly overhead: number;
}

/**
 * What the fit actually spent. The measure is re-run over the KEPT atoms rather
 * than threaded out of `budget.ts`: it is a pure lookup or a byte count, so a
 * second pass costs no I/O, and the alternative changes a return shape three
 * other callers already assert against.
 */
const usedBy = (kept: readonly RetrievedAtom[], budget: BudgetSpec): number =>
  kept.reduce((total, atom) => total + budget.measure(atom), budget.overhead);

/**
 * The budget is applied HERE, between the floor and the renderings: the adapters
 * rank, the CLI decides what fits the caller's window, and both halves of that
 * decision — kept and skipped — reach every rendering.
 */
export const applyBudget = (
  floored: FlooredResult,
  budget: BudgetSpec,
  pool: PoolFacts
): BudgetedResult => {
  const room = budget.maxTokens - budget.overhead;
  const fit = fitToTokenBudget(floored.result.atoms, room, budget.measure);
  return {
    result: { ...floored.result, atoms: fit.kept },
    skipped: fit.skipped,
    maxTokens: budget.maxTokens,
    usedTokens: usedBy(fit.kept, budget),
    poolSize: pool.size,
    cappedPool: pool.capped,
    belowFloor: floored.belowFloor,
    unscored: floored.unscored,
    minRelevance: floored.minRelevance,
    floorApplied: floored.applied,
  };
};
