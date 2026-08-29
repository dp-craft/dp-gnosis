/**
 * `search` — rank atoms for a query through the selected adapter.
 *
 * `mode` and `indexState` are REPORTED, never hidden. `indexState` is the only
 * thing that separates "searched a populated corpus and nothing matched" from
 * "no index exists, so nothing was searched"; collapsing the two lets a caller
 * read an empty result as evidence about the corpus when it is evidence about
 * the index.
 */
import { relative } from 'node:path';

import { readIndexAnalyzer } from '../adapters/fts5Adapter.js';
import {
  readVocabularyGap,
  type VocabularyGap
} from '../adapters/fts5VocabularyGap.js';
import type { AtomMeasure, SkippedAtom } from '../budget.js';
import { fitToTokenBudget } from '../budget.js';
import type { BudgetMode, FieldWeights, FtsColumn } from '../config.js';
import {
  ABSTAIN_FLOOR,
  BUDGET_MODES,
  DEFAULT_BUDGET_MODE,
  DEFAULT_FIELD_WEIGHTS,
  FTS_COLUMNS,
  RERANK_CALIBRATION,
  RERANK_K_INIT,
  RERANK_MODEL_ID,
  RETRIEVE_TOKEN_BUDGET
} from '../config.js';
import { indexRebuildCommand, ingestCommand } from '../invocation.js';
import type { RetrievalResult, RetrievedAtom, RetrieveOptions } from '../port.js';
import type { PrfParams } from '../prf.js';
import { DEFAULT_PRF_PARAMS } from '../prf.js';
import { rephraseQuery } from '../rephrase.js';
import type { RerankFusionOverrides, RerankOptions } from '../rerank.js';
import { calibrate, rerankAtoms, rerankProbeRefusal, resolveRerankFusion } from '../rerank.js';
import type { TokenCountResult } from '../tokenize.js';
import { createTokenCounter } from '../tokenize.js';
import type { AtomDomain, AtomType } from '../vocabulary.js';
import { atomTypes, defaultExcludedTypes } from '../vocabulary.js';
import type { AdapterName } from './adapter.js';
import { createPort, hasPersistentIndex } from './adapter.js';
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { ChargedText, CountAtoms, CountOne } from './counting.js';
import {
  bodyText,
  BUDGET_MODE_FLAG,
  budgetRefusalOutcome,
  resolveCounting
} from './counting.js';
import { explainAtoms } from './explain.js';
import {
  capPerDocument,
  DEFAULT_MAX_PER_DOC,
  groupByDocument,
  GROUPED_POOL_FLOOR,
  NO_CAP,
  positionMarker
} from './grouping.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import { escapeXml, xmlAttribute } from './xml.js';

const DEFAULT_K = 5;
const SCORE_DIGITS = 4;

const NO_QUERY =
  'search requires a query — pass it as a positional argument, e.g. `search "zustand selector" -k 5`';

const kError = (raw: string): string =>
  `-k must be a positive integer — got "${raw}"; pass e.g. \`-k 5\``;

const parseK = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const resolveK = (flags: FlagValues): number | undefined => {
  const raw = stringFlag(flags, '-k');
  return raw === undefined ? DEFAULT_K : parseK(raw);
};

/** The type filter belongs to `search` alone; `cli.ts` refuses it elsewhere. */
export const TYPE_FLAG = '--type';

/**
 * The domain filter, `search` and `ask` alone; `cli.ts` refuses it
 * elsewhere. Its vocabulary is the LOADED profile's `domains`, never the
 * module-level {@link atomDomains}: a `--profile` instance carries its own
 * knowledge domains, and validating against the shipped tuple would refuse the
 * only domains that instance has.
 */
export const DOMAIN_FLAG = '--domain';

/**
 * The exclusion override, `search` only; `cli.ts` refuses it elsewhere. It
 * REPLACES {@link defaultExcludedTypes} instead of extending it, so what a
 * run excluded is what the caller typed — an exclusion silently unioned with an
 * invisible default is not readable off the command line.
 */
export const EXCLUDE_TYPE_FLAG = '--exclude-type';

/** Search every type, default exclusion included. `search` only. */
export const INCLUDE_HISTORY_FLAG = '--include-history';

/** The budget override, `search` only; `cli.ts` refuses it elsewhere. */
export const MAX_TOKENS_FLAG = '--max-tokens';

/**
 * The reranker, `search` only and OPT-IN: without it the ranking is exactly
 * what it was before the reranker existed. `cli.ts` refuses it elsewhere.
 */
export const RERANK_FLAG = '--rerank';

/**
 * The query rewriter, `search` only and OPT-IN: without it the query reaches
 * the adapter exactly as typed. `cli.ts` refuses it elsewhere.
 *
 * The plan's `rewriteRules[]` output — the model reporting WHICH of the six
 * rules it applied — is deliberately NOT implemented: a model's own account of
 * its reasoning is unverifiable, so it would be prose presented as provenance.
 * What IS reported is the rewritten query itself, which the reader can check.
 */
export const REPHRASE_FLAG = '--rephrase';

/**
 * The per-document cap and the escape hatch from grouping, `search` only;
 * `cli.ts` refuses both elsewhere.
 *
 * They are MUTUALLY EXCLUSIVE by construction: `--flat` says the answer is not
 * grouped, and a cap on a grouping that does not happen is a run whose flag did
 * nothing under a success code.
 */
export const MAX_PER_DOC_FLAG = '--max-per-doc';

export const FLAT_FLAG = '--flat';

/**
 * The BM25F column weights, `search` and `ask`; `cli.ts` refuses it
 * elsewhere. It is stated as OVERRIDES over {@link DEFAULT_FIELD_WEIGHTS}, not
 * as a whole vector: an unnamed column keeps its default, so
 * `--field-weights questions=2` leaves `body` at 1 rather than silently zeroing
 * the column every recorded number was measured on.
 *
 * An unknown column name is a usage error naming {@link FTS_COLUMNS}. Ignoring
 * it would run the SHIPPED weights while the caller reads a run labelled with
 * the weights they asked for.
 */
export const FIELD_WEIGHTS_FLAG = '--field-weights';

const PAIR_SEPARATOR = ',';
const PAIR_ASSIGN = '=';

const fieldWeightsError = (offender: string, why: string): string =>
  `${FIELD_WEIGHTS_FLAG} entry "${offender}" ${why} — pass \`${FIELD_WEIGHTS_FLAG} <col${PAIR_ASSIGN}w[${PAIR_SEPARATOR}col${PAIR_ASSIGN}w]>\` naming one of: ${FTS_COLUMNS.join(', ')}`;

const asColumn = (name: string): FtsColumn | undefined =>
  FTS_COLUMNS.find(column => column === name);

type WeightPairResult =
  | { readonly ok: true; readonly column: FtsColumn; readonly weight: number }
  | { readonly ok: false; readonly error: string };

const columnOf = (entry: string): FtsColumn | undefined =>
  asColumn((entry.split(PAIR_ASSIGN)[0] ?? '').trim());

/** `undefined` for an empty or non-finite weight — never a silent `NaN`. */
const weightOf = (entry: string): number | undefined => {
  const raw = (entry.split(PAIR_ASSIGN)[1] ?? '').trim();
  const value = Number(raw);
  return raw.length > 0 && Number.isFinite(value) ? value : undefined;
};

const parseWeightPair = (entry: string): WeightPairResult => {
  const column = columnOf(entry);
  const weight = weightOf(entry);
  if (column === undefined)
    return { ok: false, error: fieldWeightsError(entry, 'names no fts5 column') };
  return weight === undefined
    ? { ok: false, error: fieldWeightsError(entry, 'carries no finite weight') }
    : { ok: true, column, weight };
};

type FieldWeightsResult =
  | { readonly ok: true; readonly fieldWeights: FieldWeights }
  | { readonly ok: false; readonly error: string };

const mergePair = (weights: FieldWeights, entry: string): FieldWeightsResult => {
  const pair = parseWeightPair(entry);
  return pair.ok
    ? { ok: true, fieldWeights: { ...weights, [pair.column]: pair.weight } }
    : { ok: false, error: pair.error };
};

const mergePairs = (entries: readonly string[]): FieldWeightsResult =>
  entries.reduce<FieldWeightsResult>(
    (carried, entry) => (carried.ok ? mergePair(carried.fieldWeights, entry) : carried),
    { ok: true, fieldWeights: DEFAULT_FIELD_WEIGHTS }
  );

/** `col=w[,col=w]` over the shipped defaults. Absent = the shipped defaults. */
export const resolveFieldWeights = (flags: FlagValues): FieldWeightsResult => {
  const raw = stringFlag(flags, FIELD_WEIGHTS_FLAG);
  if (raw === undefined) return { ok: true, fieldWeights: DEFAULT_FIELD_WEIGHTS };
  const entries = raw.split(PAIR_SEPARATOR).map(entry => entry.trim()).filter(entry => entry.length > 0);
  return entries.length === 0
    ? { ok: false, error: fieldWeightsError(raw, 'names no column at all') }
    : mergePairs(entries);
};

const maxPerDocError = (raw: string): string =>
  `${MAX_PER_DOC_FLAG} must be a non-negative integer — got "${raw}"; pass e.g. \`${MAX_PER_DOC_FLAG} ${DEFAULT_MAX_PER_DOC}\`, or \`${MAX_PER_DOC_FLAG} ${NO_CAP}\` to cap nothing`;

const groupingConflictError = (): string =>
  `${FLAT_FLAG} and ${MAX_PER_DOC_FLAG} each state how the answer is grouped, and a run may state it only once — ${FLAT_FLAG} delivers the ranking ungrouped, so a per-document cap would have nothing to cap`;

const parseMaxPerDoc = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= NO_CAP ? value : undefined;
};

/**
 * `undefined` = `--flat`: no grouping, no cap, and the pre-grouping rendering
 * byte for byte. `NO_CAP` = grouped with every atom kept.
 */
type MaxPerDocResult =
  | { readonly ok: true; readonly maxPerDoc: number | undefined }
  | { readonly ok: false; readonly error: string };

/** `--flat` accepts no cap beside it; the pairing is the whole conflict. */
const flatMaxPerDoc = (raw: string | undefined): MaxPerDocResult =>
  raw === undefined
    ? { ok: true, maxPerDoc: undefined }
    : { ok: false, error: groupingConflictError() };

const groupedMaxPerDoc = (raw: string | undefined): MaxPerDocResult => {
  if (raw === undefined) return { ok: true, maxPerDoc: DEFAULT_MAX_PER_DOC };
  const value = parseMaxPerDoc(raw);
  return value === undefined ? { ok: false, error: maxPerDocError(raw) } : { ok: true, maxPerDoc: value };
};

/** Grouping is on unless `--flat` turned it off; `maxPerDoc` carries that fact. */
export const isGrouped = (request: RetrieveRequest): boolean => request.maxPerDoc !== undefined;

const resolveMaxPerDoc = (flags: FlagValues): MaxPerDocResult => {
  const raw = stringFlag(flags, MAX_PER_DOC_FLAG);
  return flags[FLAT_FLAG] === true ? flatMaxPerDoc(raw) : groupedMaxPerDoc(raw);
};

/**
 * The tuning flags for that pass. Each one is inert without
 * {@link RERANK_FLAG} — nothing would rerank, yet the run would carry the label
 * — so each REFUSES on its own rather than being ignored, the same rule the
 * bench's `--rerank-model` follows.
 */
export const RERANK_MODEL_FLAG = '--rerank-model';

export const RERANK_PROFILE_FLAG = '--rerank-profile';

export const RERANK_WEIGHT_FLAG = '--rerank-weight';

/** Spelled as the bench spells it (`run.ts:RERANK_POOL_FLAG`), deliberately. */
export const RERANK_POOL_FLAG = '--rerank-pool';

const RERANK_TUNING_FLAGS: readonly string[] = [
  RERANK_MODEL_FLAG,
  RERANK_PROFILE_FLAG,
  RERANK_WEIGHT_FLAG,
  RERANK_POOL_FLAG,
];

/** A pool of nothing reranks nothing, so one candidate is the smallest pool. */
const RERANK_POOL_MIN = 1;

/**
 * A non-integer or sub-minimal pool is a usage error, NOT something to round:
 * a corrected run reports the depth it was ASKED for while scoring another one.
 */
const rerankPoolError = (raw: string): string =>
  `${RERANK_POOL_FLAG} expects a whole number of candidates of at least ${RERANK_POOL_MIN} — got "${raw}"; it is never rounded`;

const parseRerankPoolK = (raw: string): number | undefined => {
  const pool = Number(raw);
  return Number.isInteger(pool) && pool >= RERANK_POOL_MIN ? pool : undefined;
};

type PoolResult =
  | { readonly ok: true; readonly poolK: number }
  | { readonly ok: false; readonly error: string };

/**
 * How deep the first pass goes before the reranker sees it: the flag when there
 * is one, else the profile's `rerankPoolK`, else {@link RERANK_K_INIT} — which
 * is what keeps a run stating neither byte for byte what it always was.
 */
const resolveRerankPoolK = (flags: FlagValues, profileDefault: number | undefined): PoolResult => {
  const raw = stringFlag(flags, RERANK_POOL_FLAG);
  if (raw === undefined) return { ok: true, poolK: profileDefault ?? RERANK_K_INIT };
  const poolK = parseRerankPoolK(raw);
  return poolK === undefined ? { ok: false, error: rerankPoolError(raw) } : { ok: true, poolK };
};

/** The RRF weight the RERANKED order carries; the first pass carries `1 - w`. */
const RERANK_WEIGHT_MIN = 0;
const RERANK_WEIGHT_MAX = 1;

const weightRangeText = `${RERANK_WEIGHT_MIN} (first pass only) to ${RERANK_WEIGHT_MAX} (reranker only)`;

/**
 * A weight outside `0…1` is a usage error, NOT something to clamp: a clamped
 * run reports the weight it was ASKED for while fusing another one.
 */
const rerankWeightError = (raw: string): string =>
  `${RERANK_WEIGHT_FLAG} expects a number from ${weightRangeText} — got "${raw}"; it is never clamped`;

const orphanRerankFlagError = (flag: string): string =>
  `${flag} requires ${RERANK_FLAG} — without it nothing reranks and the result would carry a rerank label it never earned`;

const parseRerankWeight = (raw: string): number | undefined => {
  const weight = Number(raw);
  return weight >= RERANK_WEIGHT_MIN && weight <= RERANK_WEIGHT_MAX ? weight : undefined;
};

type RerankOptionsResult =
  | { readonly ok: true; readonly options: RerankOptions }
  | { readonly ok: false; readonly error: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The fusion a NAME selects, resolved by `rerank.ts` — this file MUST NOT hold a
 * second resolution path, or an unknown preset could be refused in one place and
 * accepted in the other. Its throw becomes the usage message, which already
 * lists every valid name.
 */
const fusionOf = (name: string | undefined, weight: number | undefined): RerankOptionsResult => {
  const overrides: RerankFusionOverrides = weight === undefined ? {} : { rerankWeight: weight };
  try {
    return { ok: true, options: { fusion: resolveRerankFusion(name, overrides) } };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
};

const withModel = (options: RerankOptions, model: string | undefined): RerankOptions =>
  model === undefined ? options : { ...options, model };

type WeightResult =
  | { readonly ok: true; readonly weight: number | undefined }
  | { readonly ok: false; readonly error: string };

const rerankWeightOf = (flags: FlagValues): WeightResult => {
  const raw = stringFlag(flags, RERANK_WEIGHT_FLAG);
  if (raw === undefined) return { ok: true, weight: undefined };
  const weight = parseRerankWeight(raw);
  return weight === undefined ? { ok: false, error: rerankWeightError(raw) } : { ok: true, weight };
};

/** The first tuning flag passed without `--rerank`, or `undefined` when none was. */
const orphanTuningFlag = (flags: FlagValues, rerank: boolean): string | undefined =>
  rerank ? undefined : RERANK_TUNING_FLAGS.find(flag => flags[flag] !== undefined);

/**
 * Every rerank tuning flag, resolved together into the single options object
 * `rerankAtoms` takes. Absent flags resolve to the shipped preset and the
 * shipped model, so a bare `--rerank` is bit-identical to what it always was.
 */
const resolveRerankOptions = (flags: FlagValues, rerank: boolean): RerankOptionsResult => {
  const orphan = orphanTuningFlag(flags, rerank);
  if (orphan !== undefined) return { ok: false, error: orphanRerankFlagError(orphan) };
  const weight = rerankWeightOf(flags);
  if (!weight.ok) return weight;
  const fusion = fusionOf(stringFlag(flags, RERANK_PROFILE_FLAG), weight.weight);
  return fusion.ok
    ? { ok: true, options: withModel(fusion.options, stringFlag(flags, RERANK_MODEL_FLAG)) }
    : fusion;
};

/**
 * The calibrated relevance floor, `search` only and OPT-IN: without it the
 * delivered set is exactly what it was before this flag existed.
 *
 * It is STRICTLY SUBTRACTIVE — it drops atoms the run already delivered and
 * never promotes one from deeper in the pool, so it can lower an answer's
 * length but never change its order.
 */
export const MIN_RELEVANCE_FLAG = '--min-relevance';

const MIN_RELEVANCE_MIN = 0;
const MIN_RELEVANCE_MAX = 1;

/** The reranker ids with a measured score scale, for a message that lists them. */
const CALIBRATED_MODEL_IDS: readonly string[] = Object.keys(RERANK_CALIBRATION);

/**
 * Out of range is a REFUSAL, not a clamp, for the same reason `--rerank-weight`
 * refuses: a clamped run reports the floor it was ASKED for while filtering on
 * another one.
 */
const minRelevanceError = (raw: string): string =>
  `${MIN_RELEVANCE_FLAG} expects a calibrated probability from ${MIN_RELEVANCE_MIN} to ${MIN_RELEVANCE_MAX} — got "${raw}"; it is never clamped`;

/**
 * Without `--rerank` no atom carries a cross-encoder score, so nothing could be
 * calibrated and the floor would drop the whole answer — a run that looks
 * filtered while having filtered on no evidence at all.
 */
const orphanFloorError = (): string =>
  `${MIN_RELEVANCE_FLAG} requires ${RERANK_FLAG} — without it no atom carries a calibrated score, so nothing could clear the floor and an empty answer would read as "nothing is relevant"`;

/** An uncalibrated model has no measured scale, so its score is not a probability. */
const uncalibratedModelError = (model: string): string =>
  `${MIN_RELEVANCE_FLAG} needs a reranker with a measured score scale and "${model}" has none — pass ${RERANK_MODEL_FLAG} naming one of ${CALIBRATED_MODEL_IDS.join(', ')}, or drop ${MIN_RELEVANCE_FLAG}`;

const parseMinRelevance = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isFinite(value) && value >= MIN_RELEVANCE_MIN && value <= MIN_RELEVANCE_MAX
    ? value
    : undefined;
};

type MinRelevanceResult =
  | { readonly ok: true; readonly minRelevance: number | undefined }
  | { readonly ok: false; readonly error: string };

const calibratedFloor = (floor: number, model: string): MinRelevanceResult =>
  RERANK_CALIBRATION[model] === undefined
    ? { ok: false, error: uncalibratedModelError(model) }
    : { ok: true, minRelevance: floor };

/** The model the run will actually score with, flag or shipped default. */
const rerankModelOf = (options: RerankOptions): string => options.model ?? RERANK_MODEL_ID;

/** Absent flag = no floor. Every other outcome is a value or a refusal. */
const resolveMinRelevance = (
  flags: FlagValues,
  rerank: boolean,
  model: string
): MinRelevanceResult => {
  const raw = stringFlag(flags, MIN_RELEVANCE_FLAG);
  if (raw === undefined) return { ok: true, minRelevance: undefined };
  const floor = parseMinRelevance(raw);
  if (floor === undefined) return { ok: false, error: minRelevanceError(raw) };
  if (!rerank) return { ok: false, error: orphanFloorError() };
  return calibratedFloor(floor, model);
};

/**
 * RM3 pseudo-relevance feedback, OPT-IN: without it the query reaches the
 * adapter exactly as typed and the first pass IS the ranking, byte for byte.
 *
 * It is honoured by `fts5` alone — the rescore rides fts5's own `bm25()`, which
 * was MEASURED additive across single-term queries. Every other adapter REFUSES
 * rather than ignoring it: an unexpanded ranking delivered under a `--prf` label
 * is a wrong answer reported as a clean one.
 */
export const PRF_FLAG = '--prf';

export const PRF_DOCS_FLAG = '--prf-docs';

export const PRF_TERMS_FLAG = '--prf-terms';

export const PRF_ALPHA_FLAG = '--prf-alpha';

/**
 * The OFF switch for a profile-carried default. Without it a profile that turns
 * feedback on makes the unexpanded arm unreachable from the CLI, and a losing
 * leg that cannot be re-tested cheaply stops being evidence.
 */
export const NO_PRF_FLAG = '--no-prf';

const PRF_TUNING_FLAGS: readonly string[] = [PRF_DOCS_FLAG, PRF_TERMS_FLAG, PRF_ALPHA_FLAG];

/** The one adapter whose scorer carries the weighted rescore. */
const PRF_ADAPTER: AdapterName = 'fts5';

const orphanPrfFlagError = (flag: string): string =>
  `${flag} requires a feedback pass — pass ${PRF_FLAG}, or drop ${NO_PRF_FLAG} on a profile that states one; without it nothing expands and the result would carry a feedback label it never earned`;

const prfContradictionError = (): string =>
  `${PRF_FLAG} and ${NO_PRF_FLAG} state opposite things and this run passed both — pass exactly one; a contradiction is refused, never resolved`;

/**
 * A PROFILE default cannot refuse the run: refusing would make every non-fts5
 * adapter unusable under the shipped profiles. It retrieves unexpanded and SAYS
 * so — an ignored expansion nobody is told about is the "produced nothing,
 * recorded as data" class this project keeps hitting.
 */
const prfUnexpandedNote = (adapter: AdapterName): string =>
  `${PRF_FLAG}: this profile serves a feedback default, which the ${PRF_ADAPTER} adapter alone carries, and this run selected "${adapter}" — the ranking is UNEXPANDED. Pass \`--adapter ${PRF_ADAPTER}\` to expand it, or ${NO_PRF_FLAG} to state the plain first pass deliberately`;

const prfAdapterError = (adapter: AdapterName): string =>
  `${PRF_FLAG} is honoured by the ${PRF_ADAPTER} adapter alone and this run selected "${adapter}" — pass \`--adapter ${PRF_ADAPTER}\` or drop ${PRF_FLAG}; it is never silently ignored, because an unexpanded ranking under a ${PRF_FLAG} label is a wrong answer reported as a clean one`;

const prfCountError = (flag: string, raw: string, shipped: number): string =>
  `${flag} must be a positive integer — got "${raw}"; pass e.g. \`${flag} ${shipped}\``;

const prfAlphaError = (raw: string): string =>
  `${PRF_ALPHA_FLAG} expects a number from 0 (the query alone) to 1 (the expansion alone) — got "${raw}"; it is never clamped`;

type PrfNumberResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

const prfCountOf = (flags: FlagValues, flag: string, shipped: number): PrfNumberResult => {
  const raw = stringFlag(flags, flag);
  if (raw === undefined) return { ok: true, value: shipped };
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: prfCountError(flag, raw, shipped) };
};

const isPrfAlpha = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

/** Out of range REFUSES rather than clamping, the rule `--rerank-weight` set. */
const prfAlphaOf = (flags: FlagValues, shipped: number): PrfNumberResult => {
  const raw = stringFlag(flags, PRF_ALPHA_FLAG);
  if (raw === undefined) return { ok: true, value: shipped };
  const value = Number(raw);
  return isPrfAlpha(value) ? { ok: true, value } : { ok: false, error: prfAlphaError(raw) };
};

/**
 * WHICH switch turned the feedback pass on — the one thing a caller cannot
 * recover from the reported cell, since a tuning flag shows up in the cell
 * itself. `flag` = an explicit `--prf`; `profile` = the profile's `defaultPrf`.
 */
export type PrfSourceName = 'flag' | 'profile';

/** The feedback pass as argv AND the profile resolved it, with what it must say. */
interface PrfResolution {
  /** `undefined` = no feedback pass; the first pass IS the ranking. */
  readonly prf: PrfParams | undefined;
  /** Set exactly when `prf` is, so the pair cannot report a source with no pass. */
  readonly prfSource: PrfSourceName | undefined;
  /** Present when a profile default could not be honoured on this adapter. */
  readonly prfNote: string | undefined;
}

type PrfResult =
  | ({ readonly ok: true } & PrfResolution)
  | { readonly ok: false; readonly error: string };

/** Which switch turned the pass on, as the payload names it. */
const prfSourceName = (source: PrfSource): PrfSourceName =>
  source.explicit ? 'flag' : 'profile';

/**
 * Absent tuning flags resolve to `base` — the profile's cell when it states one,
 * {@link DEFAULT_PRF_PARAMS} otherwise — so a flag overrides ONE member and
 * leaves the served cell carrying the rest.
 */
const prfParamsOf = (flags: FlagValues, source: PrfSource): PrfResult => {
  const { base } = source;
  const docs = prfCountOf(flags, PRF_DOCS_FLAG, base.fbDocs);
  if (!docs.ok) return docs;
  const terms = prfCountOf(flags, PRF_TERMS_FLAG, base.fbTerms);
  if (!terms.ok) return terms;
  const alpha = prfAlphaOf(flags, base.alpha);
  return alpha.ok
    ? {
        ok: true,
        prf: { fbDocs: docs.value, fbTerms: terms.value, alpha: alpha.value },
        prfSource: prfSourceName(source),
        prfNote: undefined,
      }
    : alpha;
};

/** The first tuning flag passed with no feedback pass to tune, or `undefined`. */
const orphanPrfFlag = (flags: FlagValues, on: boolean): string | undefined =>
  on ? undefined : PRF_TUNING_FLAGS.find(flag => flags[flag] !== undefined);

/** Where the feedback pass came from, which is what the adapter rule turns on. */
interface PrfSource {
  /** A feedback pass was asked for at all: by argv, or by the profile. */
  readonly on: boolean;
  /** Asked for by ARGV — the case that refuses on a non-fts5 adapter. */
  readonly explicit: boolean;
  /** The cell the tuning flags override, member by member. */
  readonly base: PrfParams;
}

/** `flag > profile > OFF`, stated once so no branch below re-derives it. */
const prfSourceOf = (flags: FlagValues, profileDefault: PrfParams | undefined): PrfSource => {
  const explicit = flags[PRF_FLAG] === true;
  const disabled = flags[NO_PRF_FLAG] === true;
  return {
    explicit,
    on: explicit || (!disabled && profileDefault !== undefined),
    base: profileDefault ?? DEFAULT_PRF_PARAMS,
  };
};

/** `fts5` expands; elsewhere an EXPLICIT flag refuses and a profile default notes. */
const prfForAdapter = (
  source: PrfSource,
  flags: FlagValues,
  adapter: AdapterName
): PrfResult => {
  if (adapter === PRF_ADAPTER) return prfParamsOf(flags, source);
  return source.explicit
    ? { ok: false, error: prfAdapterError(adapter) }
    : {
        ok: true,
        prf: undefined,
        prfSource: undefined,
        prfNote: prfUnexpandedNote(adapter),
      };
};

const prfForSource = (
  source: PrfSource,
  flags: FlagValues,
  adapter: AdapterName
): PrfResult => {
  const orphan = orphanPrfFlag(flags, source.on);
  if (orphan !== undefined) return { ok: false, error: orphanPrfFlagError(orphan) };
  if (!source.on) {
    return { ok: true, prf: undefined, prfSource: undefined, prfNote: undefined };
  }
  return prfForAdapter(source, flags, adapter);
};

/**
 * The whole resolution order: an explicit flag beats the profile's default,
 * which beats OFF, and `--no-prf` turns a profile default off. Passing both
 * switches is a usage error rather than a silent winner.
 */
export const resolvePrf = (
  flags: FlagValues,
  adapter: AdapterName,
  profileDefault: PrfParams | undefined
): PrfResult =>
  flags[PRF_FLAG] === true && flags[NO_PRF_FLAG] === true
    ? { ok: false, error: prfContradictionError() }
    : prfForSource(prfSourceOf(flags, profileDefault), flags, adapter);

/** The rewrite cache sits beside the index it serves, like the embedding cache. */
const REPHRASE_CACHE_SUFFIX = '.rephrase-cache';

const maxTokensError = (raw: string): string =>
  `${MAX_TOKENS_FLAG} must be a non-negative integer — got "${raw}"; pass e.g. \`${MAX_TOKENS_FLAG} ${RETRIEVE_TOKEN_BUDGET}\``;

/** Zero is legal: it asks for the skip report alone, and is not a mistake. */
const parseMaxTokens = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
};

const resolveMaxTokens = (flags: FlagValues): number | undefined => {
  const raw = stringFlag(flags, MAX_TOKENS_FLAG);
  return raw === undefined ? RETRIEVE_TOKEN_BUDGET : parseMaxTokens(raw);
};

/** Owned by `counting.ts`, re-exported so every existing importer is unmoved. */
export { BUDGET_MODE_FLAG };

/** A measure outside the closed vocabulary is BAD INPUT, refused at exit 2. */
const budgetModeError = (raw: string): string =>
  `${BUDGET_MODE_FLAG} value "${raw}" is outside the closed vocabulary — replace it with one of ${BUDGET_MODES.join(' | ')}`;

const isBudgetMode = (raw: string): raw is BudgetMode =>
  (BUDGET_MODES as readonly string[]).includes(raw);

/** The measure argv selected; `undefined` marks a value this CLI refuses. */
const resolveBudgetMode = (flags: FlagValues): BudgetMode | undefined => {
  const raw = stringFlag(flags, BUDGET_MODE_FLAG);
  if (raw === undefined) return DEFAULT_BUDGET_MODE;
  return isBudgetMode(raw) ? raw : undefined;
};

/** The offending token as the caller typed it, for a message that quotes it. */
const rawFlag = (flags: FlagValues, name: string): string => stringFlag(flags, name) ?? '';

/**
 * A value outside the closed vocabulary is a REFUSAL, never a silently dropped
 * filter: a caller who mistyped `--type adrs` would otherwise read an unfiltered
 * ranking as a filtered one. The message names the offending value AND the whole
 * vocabulary, so the correction needs no second call.
 */
const typeError = (offender: string, flag: string = TYPE_FLAG): string =>
  `${flag} value "${offender}" is outside the closed vocabulary — replace it with one of ${atomTypes().join(' | ')}; pass several as \`${flag} adr,review\``;

const splitTypes = (raw: string): readonly string[] => raw.split(',').map(part => part.trim());

const asType = (value: string): AtomType | undefined => atomTypes().find(type => type === value);

/**
 * `types: undefined` = no filter reaches the port at all. It is deliberately
 * NOT "the whole vocabulary spelled out": the unfiltered call is the path every
 * recorded number was measured on, and passing a complete list instead would
 * change the query the adapter builds.
 */
export type TypesResult =
  | { readonly ok: true; readonly types: readonly AtomType[] | undefined }
  | { readonly ok: false; readonly error: string };

/** Absent flag reads as "unfiltered"; every named value must be in the vocabulary. */
const resolveTypes = (flags: FlagValues): TypesResult => {
  const raw = stringFlag(flags, TYPE_FLAG);
  if (raw === undefined) return { ok: true, types: undefined };
  const requested = splitTypes(raw);
  const offender = requested.find(value => asType(value) === undefined);
  return offender === undefined
    ? { ok: true, types: requested.flatMap(value => asType(value) ?? []) }
    : { ok: false, error: typeError(offender) };
};

/**
 * `domains: undefined` = no filter reaches the port at all, exactly as with
 * {@link TypesResult}: the unfiltered call is the path every recorded number was
 * measured on, and spelling the whole vocabulary out instead would change the
 * candidate walk.
 */
export type DomainsResult =
  | { readonly ok: true; readonly domains: readonly AtomDomain[] | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * A value outside the vocabulary is a REFUSAL, never a silently dropped filter,
 * for the same reason `--type` refuses one: an unfiltered ranking read as a
 * filtered one is a wrong answer under a success code. The message names the
 * offending value AND the accepted vocabulary, which is the one the LOADED
 * profile declares, so a `--profile` caller is corrected with its own domains.
 */
const domainError = (offender: string, vocabulary: readonly AtomDomain[]): string =>
  `${DOMAIN_FLAG} value "${offender}" is outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}; pass several as \`${DOMAIN_FLAG} ${vocabulary.slice(0, 2).join(',')}\``;

/** Absent flag reads as "unfiltered"; every named value must be in the vocabulary. */
export const resolveDomainFilter = (
  flags: FlagValues,
  vocabulary: readonly AtomDomain[]
): DomainsResult => {
  const raw = stringFlag(flags, DOMAIN_FLAG);
  if (raw === undefined) return { ok: true, domains: undefined };
  const requested = splitTypes(raw);
  const offender = requested.find(value => !vocabulary.includes(value));
  return offender === undefined
    ? { ok: true, domains: requested }
    : { ok: false, error: domainError(offender, vocabulary) };
};

/**
 * The three ways to state a type filter, and a run may use exactly ONE: they
 * mean different things (name the types, replace the exclusion, exclude
 * nothing), so honouring one and dropping another would hand back a filter the
 * caller never asked for under a success code.
 */
const FILTER_SOURCE_FLAGS: readonly string[] = [TYPE_FLAG, EXCLUDE_TYPE_FLAG, INCLUDE_HISTORY_FLAG];

const filterConflictError = (given: readonly string[]): string =>
  `${given.join(' and ')} each select the type filter, and a run may state it only once — ${TYPE_FLAG} names the only types to search, ${EXCLUDE_TYPE_FLAG} replaces the default exclusion, ${INCLUDE_HISTORY_FLAG} searches every type`;

const filterConflict = (flags: FlagValues): string | undefined => {
  const given = FILTER_SOURCE_FLAGS.filter(flag => flags[flag] !== undefined);
  return given.length > 1 ? filterConflictError(given) : undefined;
};

/**
 * An exclusion that leaves nothing is refused HERE rather than sent on: the
 * port refuses an empty type list too, but only after the run looks well-formed,
 * and this message names the flags that produced the emptiness.
 */
const emptyExclusionError = (): string =>
  `${EXCLUDE_TYPE_FLAG} excludes every type in the vocabulary, so nothing could be searched — drop a value, or pass ${INCLUDE_HISTORY_FLAG} to search all of ${atomTypes().join(' | ')}`;

type ExcludedResult =
  | { readonly ok: true; readonly excluded: readonly AtomType[] }
  | { readonly ok: false; readonly error: string };

/** The exclusion in force: none with `--include-history`, the flag's list when
 * given, the shipped profile default otherwise. */
const resolveExcluded = (flags: FlagValues): ExcludedResult => {
  if (flags[INCLUDE_HISTORY_FLAG] === true) return { ok: true, excluded: [] };
  const raw = stringFlag(flags, EXCLUDE_TYPE_FLAG);
  if (raw === undefined) return { ok: true, excluded: defaultExcludedTypes() };
  const requested = splitTypes(raw);
  const offender = requested.find(value => asType(value) === undefined);
  return offender === undefined
    ? { ok: true, excluded: requested.flatMap(value => asType(value) ?? []) }
    : { ok: false, error: typeError(offender, EXCLUDE_TYPE_FLAG) };
};

/** Excluding nothing passes NO filter, keeping the today-path byte-identical. */
const keptTypes = (excluded: readonly AtomType[]): TypesResult => {
  if (excluded.length === 0) return { ok: true, types: undefined };
  const kept = atomTypes().filter(type => !excluded.includes(type));
  return kept.length === 0 ? { ok: false, error: emptyExclusionError() } : { ok: true, types: kept };
};

const exclusionFilter = (flags: FlagValues): TypesResult => {
  const excluded = resolveExcluded(flags);
  return excluded.ok ? keptTypes(excluded.excluded) : { ok: false, error: excluded.error };
};

/**
 * The effective type filter for one run. `--type` is an explicit request and
 * WINS whole: nothing is subtracted from a list the caller named. Only when it
 * is absent does the default exclusion apply.
 */
export const resolveTypeFilter = (flags: FlagValues): TypesResult => {
  const conflict = filterConflict(flags);
  if (conflict !== undefined) return { ok: false, error: conflict };
  const requested = resolveTypes(flags);
  return requested.ok && requested.types === undefined ? exclusionFilter(flags) : requested;
};

/**
 * `unavailable` means nothing was searched, so an agent reading a zero count as
 * evidence about the corpus would be reading it about a corpus that is not
 * there. It is reported as the EXISTING partial code with a message naming the
 * correction, never as success and never as a usage fault — the call was
 * well-formed, the corpus simply has not been built yet.
 */
const noCorpus = (): string =>
  `search: nothing was searched — no corpus exists at the atoms directory; build it first with \`${ingestCommand()} <path...>\``;

/**
 * An index-backed adapter has a SECOND way to reach `unavailable`: the corpus is
 * ingested but never indexed. The note names that build command verbatim, so an
 * agent-driven caller can run the correction without a second lookup — an
 * ingest-only remedy would send it to rebuild a corpus that is already there.
 */
const indexRemedy = (adapter: AdapterName): string =>
  `; if the corpus is already ingested, build the index with \`${indexRebuildCommand(adapter)}\``;

const noCorpusNote = (adapter: AdapterName): string =>
  hasPersistentIndex(adapter) ? `${noCorpus()}${indexRemedy(adapter)}` : noCorpus();

const isUnavailable = (result: RetrievalResult): boolean => result.indexState === 'unavailable';

/**
 * The index is THERE and was refused: it describes another corpus, or a stamp
 * schema this build does not read. The refusal TEXT comes from the adapter that
 * ran the check — it already names the condition, both digests and the rebuild
 * command, and a second wording here would be a second thing to keep in step.
 */
const isRefused = (result: RetrievalResult): boolean => result.indexState === 'mismatched';

/**
 * The two ways a run can deliver zero atoms WITHOUT having searched. Every note
 * that reasons about the corpus is gated on this: the vault is evidence about
 * nothing when nothing was asked of it.
 */
const isUnsearched = (result: RetrievalResult): boolean =>
  isUnavailable(result) || isRefused(result);

/** The line that explains an unsearched run, whichever of the two it was. */
const unsearchedNotes = (request: RetrieveRequest, result: RetrievalResult): readonly string[] => {
  if (result.indexRefusal !== undefined) return [result.indexRefusal];
  return isUnavailable(result) ? [noCorpusNote(request.context.adapter)] : [];
};

/**
 * Every refusal the run collected, in the order they could happen. Both are
 * reported: a run whose rewrite AND whose rerank were refused got neither, and
 * naming one would let the reader assume the other succeeded.
 */
const refusalsOf = (request: RetrieveRequest): readonly string[] =>
  [request.rephraseRefusal, request.rerankRefusal].flatMap(refusal =>
    refusal === undefined ? [] : [refusal]
  );

/**
 * A refused rewrite or a refused rerank is PARTIAL, not success: the run did
 * retrieve, but not the way `--rephrase` / `--rerank` claimed it would, and a
 * caller that reads exit 0 would take the degraded ranking for the promised one.
 *
 * A budget SKIP is the same shape of answer: atoms were delivered AND atoms the
 * ranking earned were refused for want of budget. It is a property of skipping,
 * so it holds in both `--budget-mode` counts, and exit 0 would let a caller read
 * a truncated context as the whole of what the vault holds.
 */
export const exitCodeFor = (
  request: RetrieveRequest,
  result: RetrievalResult,
  budgeted: BudgetedResult
): number =>
  isUnsearched(result) || refusalsOf(request).length > 0 || hasSkips(budgeted)
    ? EXIT_PARTIAL
    : EXIT_OK;

export const formatScore = (score: number): string => score.toFixed(SCORE_DIGITS);

/**
 * The RAW cross-encoder score, beside the fused one it produced. Present only
 * when the reranker scored this atom, so a run that did not rerank emits the
 * line it always did, byte for byte. It sits next to `score` rather than at the
 * end of the line because the two are read together — the fused number is not
 * decomposable, and the pair is what says whether the reranker moved this atom.
 */
const rerankPart = (atom: RetrievedAtom): string =>
  atom.rerankScore === undefined ? '' : `  rerank  ${formatScore(atom.rerankScore)}`;

/**
 * WHERE in its document the atom sits, on a GROUPED answer only. An atom that
 * states no position renders no marker, and `--flat` renders none at all — the
 * ungrouped line is what every caller before grouping reads, byte for byte.
 */
const positionPart = (atom: RetrievedAtom, grouped: boolean): string => {
  const marker = grouped ? positionMarker(atom) : '';
  return marker === '' ? '' : `  ${marker}`;
};

const atomLine = (atom: RetrievedAtom, grouped: boolean): string =>
  `  ${formatScore(atom.score)}${rerankPart(atom)}${positionPart(atom, grouped)}  ${atom.id}  [${atom.domain}]  ${atom.title}`;

/**
 * One line per ORIGIN document, under the atom it belongs to. A list rather than
 * one joined value: the origins are separate documents, and an atom naming none
 * emits no line at all instead of a blank one.
 */
const originLine = (origin: string): string => `    origin  ${origin}`;

const atomLines = (atom: RetrievedAtom, grouped: boolean): readonly string[] => [
  atomLine(atom, grouped),
  ...atom.originPaths.map(originLine),
];

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
 * The warning that goes back to the LLM. An atom over budget is SKIPPED, never
 * truncated and never silently dropped, so the message states both remedies:
 * raise the budget, or read the named source file directly.
 */
export const budgetWarning = (budgeted: BudgetedResult): string =>
  `search: ${budgeted.skipped.length} atom(s) did not fit the ${budgeted.maxTokens}-token budget and were skipped — raise it with \`${MAX_TOKENS_FLAG} <n>\` or read the source files named below`;

export const hasSkips = (budgeted: BudgetedResult): boolean => budgeted.skipped.length > 0;

const skippedLine = (skipped: SkippedAtom): string =>
  `  skipped  ${skipped.id}  ~${skipped.estimatedTokens} tokens  ${skipped.sourcePath}`;

const skipText = (budgeted: BudgetedResult): readonly string[] =>
  hasSkips(budgeted) ? [budgetWarning(budgeted), ...budgeted.skipped.map(skippedLine)] : [];

/**
 * A floor drop is REPORTED, exactly like a budget skip: an answer that is short
 * because the reranker judged the rest irrelevant reads identically to a thin
 * corpus unless the count and the floor are stated.
 */
const floorWarning = (budgeted: BudgetedResult): string =>
  `search: ${budgeted.belowFloor} atom(s) scored below the ${budgeted.minRelevance} calibrated relevance floor and were dropped — lower \`${MIN_RELEVANCE_FLAG} <p>\` or drop the flag to see them`;

/**
 * An atom with no calibrated score was NOT scored below the floor — it was
 * never scored. Saying otherwise asserts a measurement that did not happen and
 * offers a remedy (lower the floor) that cannot reach it.
 */
const unscoredWarning = (budgeted: BudgetedResult): string =>
  `search: ${budgeted.unscored} atom(s) were dropped by the ${budgeted.minRelevance} floor with NO calibrated score — they were never scored, not scored below it`;

/**
 * The floor was named and deliberately not run. Stated in full, because the
 * delivered ranking is the un-floored first pass: a caller that believed the
 * floor had run would read an unfiltered answer as a filtered one.
 */
const unappliedFloorNote = (budgeted: BudgetedResult): string =>
  `search: the ${budgeted.minRelevance} calibrated relevance floor was NOT applied — the rerank was refused, so no atom carries a calibrated score and nothing could be judged against the floor; the atoms below are the un-floored first pass`;

const appliedFloorNotes = (budgeted: BudgetedResult): readonly string[] => [
  ...(budgeted.belowFloor > 0 ? [floorWarning(budgeted)] : []),
  ...(budgeted.unscored > 0 ? [unscoredWarning(budgeted)] : []),
];

/** Empty on every run that named no floor, so nothing new is rendered. */
const floorNotes = (budgeted: BudgetedResult): readonly string[] => {
  if (budgeted.minRelevance === undefined) return [];
  return budgeted.floorApplied ? appliedFloorNotes(budgeted) : [unappliedFloorNote(budgeted)];
};

/**
 * `count: 0` is a VALID answer — "it is not in the vault" — so it stays exit 0.
 * What it MUST NOT be is unactionable: a run emptied by the type filter and a
 * run whose terms matched nothing read identically from the count, and their
 * remedies are different. The note names which of the two happened, and the
 * correction for that one.
 *
 * The phrasing lever itself is NOT restated here: the rules live where the
 * caller executes them, and a second copy would drift from them.
 */
const NOTHING_MATCHED = 'search: nothing in the vault matched these terms';

const REPHRASE_REMEDY =
  'the largest lever is the keyword phrasing — rewrite the query per `packages/gnosis/QUERYING.md` § Query rephrasing and retrieve again';

/** No filter ran, so the whole vault was searched and phrasing is all that is left. */
const unfilteredEmptyNote = (): string =>
  `${NOTHING_MATCHED}, and no type filter was in effect — ${REPHRASE_REMEDY}`;

/**
 * A filtered run says WHICH filter ran and how to widen it, then falls back to
 * the phrasing lever. It states nothing about what the excluded types hold —
 * nothing measured that, and claiming it would invent evidence.
 */
const filteredEmptyNote = (filter: string, remedy: string): string =>
  `${NOTHING_MATCHED} within the type filter in effect (${filter}) — ${remedy}; if widening it changes nothing, ${REPHRASE_REMEDY}`;

const WIDEN_ALL = `pass ${INCLUDE_HISTORY_FLAG} to search every type`;

/**
 * Which filter is in force, read from argv rather than from the resolved list:
 * the kept set alone cannot say whether the caller named it or the profile
 * default did, and only the caller-named case is widened by editing a flag.
 */
const filteredNote = (flags: FlagValues): string => {
  const named = stringFlag(flags, TYPE_FLAG);
  if (named !== undefined) {
    return filteredEmptyNote(`${TYPE_FLAG} ${named}`, `widen or drop ${TYPE_FLAG}`);
  }
  const excluded = stringFlag(flags, EXCLUDE_TYPE_FLAG);
  if (excluded !== undefined) {
    return filteredEmptyNote(
      `${EXCLUDE_TYPE_FLAG} ${excluded}`,
      `drop a value from ${EXCLUDE_TYPE_FLAG}, or ${WIDEN_ALL}`
    );
  }
  return filteredEmptyNote(
    `the profile default excludes ${defaultExcludedTypes().join(', ')}`,
    WIDEN_ALL
  );
};

const emptyNote = (request: RetrieveRequest): string =>
  request.types === undefined ? unfilteredEmptyNote() : filteredNote(request.context.flags);

/**
 * Fires on the FIRST PASS being empty, not on the delivered count: a count of
 * zero behind a non-empty pool was produced by the floor or the budget, and
 * those notes already say so — claiming "nothing matched" there would be false.
 * An `unavailable` run is excluded outright; nothing was searched, so the vault
 * is not evidence about anything.
 */
const emptyNotes = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): readonly string[] =>
  budgeted.poolSize === 0 && !isUnsearched(budgeted.result) ? [emptyNote(request)] : [];

/**
 * Under-delivery MUST NOT be silent. An answer shorter than `-k` reads exactly
 * like a thin corpus unless the run names what shortened it, and the caller's
 * remedy differs: a query needs rephrasing, a cap needs raising.
 *
 * It fires only when the cap ACTUALLY subtracted (`cappedPool < poolSize`) —
 * blaming the cap for a pool it left untouched would state a falsehood, and the
 * budget and the floor already name their own subtractions.
 */
const capShortfallNote = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  `search: delivered ${budgeted.cappedPool} of the ${request.k} atoms asked for — the per-document cap did that, not the query: the first pass matched ${budgeted.poolSize} atom(s), and at \`${MAX_PER_DOC_FLAG} ${request.maxPerDoc}\` only ${budgeted.cappedPool} of them survive it — raise it with \`${MAX_PER_DOC_FLAG} <n>\`, or pass \`${FLAT_FLAG}\` to cap nothing`;

const isCapShort = (request: RetrieveRequest, budgeted: BudgetedResult): boolean =>
  budgeted.cappedPool < request.k && budgeted.cappedPool < budgeted.poolSize;

const capNotes = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): readonly string[] => (isCapShort(request, budgeted) ? [capShortfallNote(request, budgeted)] : []);

/**
 * The rewrite is stated in FULL, both sides: the ranking is evidence about the
 * rewritten query, and a reader who cannot see what was actually searched
 * cannot judge the results.
 */
const rephraseLines = (request: RetrieveRequest): readonly string[] => {
  const rewritten = request.queryRewritten;
  if (rewritten !== undefined) return [`search: rephrased "${request.query}" -> "${rewritten}"`];
  return request.rephraseRefusal === undefined ? [] : [request.rephraseRefusal];
};

/** The rerank refusal reads as its own line; the atoms below it are first-pass. */
const rerankLines = (request: RetrieveRequest): readonly string[] =>
  request.rerankRefusal === undefined ? [] : [request.rerankRefusal];

/**
 * C11a. The silent hole this closes is the QUERY-side twin of the one C1 closed
 * on the index side: a query term the index has never seen contributes an EMPTY
 * posting list, `MATCH` still succeeds, atoms still come back ranked by whatever
 * terms DID hit, and the run exits 0 over a plausible answer. The term that
 * carried the caller's intent reached nothing, and nothing said so.
 *
 * Stated as a WARNING only. Like the enrichment, body-source and domain
 * warnings it MUST NOT move the exit code: the index is sound, the search ran,
 * and the ranking delivered is the real ranking for the terms that exist.
 */
const vocabularyGapWarning = (gap: VocabularyGap): string =>
  `search: ${gap.gapCount} of ${gap.termCount} analysed query term(s) have ZERO postings in ` +
  `this index — ${gap.gapTerms.map(term => `"${term}"`).join(', ')} — no atom holds them, so ` +
  'they add nothing to the ranking and a feedback pass built on it expands from the terms that ' +
  'did hit; check the spelling, or ask with words this corpus uses.';

/** A gap that was not measured, and a gap of zero, both say NOTHING — today's output. */
const gapOf = (request: RetrieveRequest): VocabularyGap | undefined => {
  const gap = request.vocabularyGap;
  return gap === undefined || gap.gapCount === 0 ? undefined : gap;
};

const vocabularyGapLines = (request: RetrieveRequest): readonly string[] => {
  const gap = gapOf(request);
  return gap === undefined ? [] : [vocabularyGapWarning(gap)];
};

/**
 * Its OWN key, deliberately not `note`: the note carries refusals, and a shared
 * key would let whichever is written last erase the other — a silent drop is the
 * failure class this diagnostic exists to report. Omitted ENTIRELY when nothing
 * is missing, so a clean query's payload is byte for byte the one it always was.
 *
 * The gap TERMS are stated, not the full per-term posting table: an operator
 * needs the hole named. The whole table is what `gnosis:vocabgap` emits, over a
 * whole topic set, offline.
 */
const vocabularyGapField = (
  request: RetrieveRequest
): Readonly<Record<string, unknown>> => {
  const gap = gapOf(request);
  return gap === undefined
    ? {}
    : {
        vocabularyGap: {
          gapTerms: gap.gapTerms,
          gapCount: gap.gapCount,
          termCount: gap.termCount,
          warning: vocabularyGapWarning(gap),
        },
      };
};

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
const calibratedOf = (request: RetrieveRequest, atom: RetrievedAtom): number | undefined =>
  atom.rerankScore === undefined
    ? undefined
    : calibrate(rerankModelOf(request.rerankOptions), atom.rerankScore);

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

const confidenceLine = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  `search: confidence ${confidenceOf(request, budgeted)}`;

/**
 * WHICH measure was enforced, stated on every run. Without it a caller cannot
 * tell a byte-bounded answer from a token-counted one, and the two admit
 * different atoms at the same `--max-tokens`.
 */
const budgetLine = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  `search: budget ${budgeted.maxTokens} counted as ${request.budgetMode}`;

/**
 * The expansion stated on the human rendering too, and ONLY when one ran: the
 * text output is the same record in another shape, so a fact absent from it is
 * a fact the reader does not have.
 */
export const prfLines = (request: RetrieveRequest): readonly string[] => {
  const { prf, prfSource } = request;
  if (prf === undefined || prfSource === undefined) return [];
  return [
    `search: prf fbDocs ${prf.fbDocs}, fbTerms ${prf.fbTerms}, alpha ${prf.alpha} (${prfSource})`,
  ];
};

const retrieveText = (request: RetrieveRequest, budgeted: BudgetedResult): string => {
  const { result } = budgeted;
  return [
    `search: mode ${result.mode}, indexState ${result.indexState}, atoms ${result.atoms.length}`,
    confidenceLine(request, budgeted),
    budgetLine(request, budgeted),
    ...prfLines(request),
    ...rephraseLines(request),
    ...rerankLines(request),
    ...vocabularyGapLines(request),
    ...unsearchedNotes(request, result),
    ...result.atoms.flatMap(atom => atomLines(atom, isGrouped(request))),
    ...skipText(budgeted),
    ...floorNotes(budgeted),
    ...emptyNotes(request, budgeted),
    ...capNotes(request, budgeted),
  ].join('\n');
};

type ArgsResult =
  | {
    readonly ok: true;
    readonly k: number;
    readonly maxTokens: number;
    readonly budgetMode: BudgetMode;
    readonly types: readonly AtomType[] | undefined;
    readonly domains: readonly AtomDomain[] | undefined;
    /** `undefined` = `--flat`. See {@link resolveMaxPerDoc}. */
    readonly maxPerDoc: number | undefined;
    /** The BM25F column weights. See {@link resolveFieldWeights}. */
    readonly fieldWeights: FieldWeights;
    readonly rerank: boolean;
    readonly rerankOptions: RerankOptions;
    /** The resolved rerank depth. See {@link resolveRerankPoolK}. */
    readonly rerankPoolK: number;
    readonly minRelevance: number | undefined;
    readonly rephrase: boolean;
    /** `undefined` = no feedback pass; the first pass IS the ranking. */
    readonly prf: PrfParams | undefined;
    /** Which switch turned that pass on; `undefined` when none ran. */
    readonly prfSource: PrfSourceName | undefined;
    /** What an unhonoured profile default must say; `undefined` when none. */
    readonly prfNote: string | undefined;
  }
  | { readonly ok: false; readonly error: string };

/** The value flags that carry no refusal of their own, once each has parsed. */
interface ResolvedValues {
  readonly k: number;
  readonly maxTokens: number;
  readonly budgetMode: BudgetMode;
  readonly types: readonly AtomType[] | undefined;
  readonly domains: readonly AtomDomain[] | undefined;
  /** `undefined` = `--flat`. See {@link resolveMaxPerDoc}. */
  readonly maxPerDoc: number | undefined;
  /** See {@link resolveFieldWeights}. */
  readonly fieldWeights: FieldWeights;
  /** `undefined` = no feedback pass. See {@link resolvePrf}. */
  readonly prf: PrfParams | undefined;
  /** See {@link PrfResolution}. */
  readonly prfSource: PrfSourceName | undefined;
  /** See {@link PrfResolution}. */
  readonly prfNote: string | undefined;
}

/** How the rerank leg scores: the options, and how deep a pool it is handed. */
interface RerankLeg {
  readonly options: RerankOptions;
  readonly poolK: number;
}

/** That leg as argv resolved it, plus the floor the result is served at. */
interface RerankResolved extends RerankLeg {
  readonly minRelevance: number | undefined;
}

const okArgs = (
  flags: FlagValues,
  values: ResolvedValues,
  rerank: RerankResolved
): ArgsResult => ({
  ok: true,
  ...values,
  rerank: flags[RERANK_FLAG] === true,
  rerankOptions: rerank.options,
  rerankPoolK: rerank.poolK,
  minRelevance: rerank.minRelevance,
  rephrase: flags[REPHRASE_FLAG] === true,
});

/** The last rerank decision: the floor, over a leg that has already resolved. */
const withFloor = (flags: FlagValues, values: ResolvedValues, leg: RerankLeg): ArgsResult => {
  const rerank = flags[RERANK_FLAG] === true;
  const floor = resolveMinRelevance(flags, rerank, rerankModelOf(leg.options));
  return floor.ok
    ? okArgs(flags, values, { ...leg, minRelevance: floor.minRelevance })
    : { ok: false, error: floor.error };
};

const withRerankArgs = (
  flags: FlagValues,
  values: ResolvedValues,
  profilePoolK: number | undefined
): ArgsResult => {
  const rerank = flags[RERANK_FLAG] === true;
  const options = resolveRerankOptions(flags, rerank);
  if (!options.ok) return { ok: false, error: options.error };
  const pool = resolveRerankPoolK(flags, profilePoolK);
  return pool.ok
    ? withFloor(flags, values, { options: options.options, poolK: pool.poolK })
    : { ok: false, error: pool.error };
};

type CountsResult =
  | {
    readonly ok: true;
    readonly k: number;
    readonly maxTokens: number;
    readonly budgetMode: BudgetMode;
  }
  | { readonly ok: false; readonly error: string };

type BudgetResult =
  | { readonly ok: true; readonly maxTokens: number; readonly budgetMode: BudgetMode }
  | { readonly ok: false; readonly error: string };

/** The budget ceiling and its MEASURE, which are one decision, not two. */
const resolveBudget = (flags: FlagValues): BudgetResult => {
  const maxTokens = resolveMaxTokens(flags);
  const budgetMode = resolveBudgetMode(flags);
  if (maxTokens === undefined) {
    return { ok: false, error: maxTokensError(rawFlag(flags, MAX_TOKENS_FLAG)) };
  }
  if (budgetMode === undefined) {
    return { ok: false, error: budgetModeError(rawFlag(flags, BUDGET_MODE_FLAG)) };
  }
  return { ok: true, maxTokens, budgetMode };
};

/** The integer flags and the budget, refusing with the token the caller typed. */
const resolveCounts = (flags: FlagValues): CountsResult => {
  const k = resolveK(flags);
  const budget = resolveBudget(flags);
  if (k === undefined) return { ok: false, error: kError(rawFlag(flags, '-k')) };
  return budget.ok
    ? { ok: true, k, maxTokens: budget.maxTokens, budgetMode: budget.budgetMode }
    : budget;
};

type PresentationResult =
  | {
    readonly ok: true;
    readonly types: readonly AtomType[] | undefined;
    readonly domains: readonly AtomDomain[] | undefined;
    readonly maxPerDoc: number | undefined;
    readonly fieldWeights: FieldWeights;
  }
  | { readonly ok: false; readonly error: string };

/** The two search filters, once each has parsed — carried together so the
 * arrangement step below states one shape rather than a growing parameter list. */
interface SearchFilters {
  readonly types: readonly AtomType[] | undefined;
  readonly domains: readonly AtomDomain[] | undefined;
}

/** The arrangement plus the filters, once both have parsed. */
interface Arranged extends SearchFilters {
  readonly maxPerDoc: number | undefined;
}

/** The last presentation step: how the columns are weighed. */
const withFieldWeights = (flags: FlagValues, arranged: Arranged): PresentationResult => {
  const weights = resolveFieldWeights(flags);
  return weights.ok
    ? { ok: true, ...arranged, fieldWeights: weights.fieldWeights }
    : { ok: false, error: weights.error };
};

/** The arrangement, added to filters that already parsed. */
const withMaxPerDoc = (flags: FlagValues, filters: SearchFilters): PresentationResult => {
  const maxPerDoc = resolveMaxPerDoc(flags);
  return maxPerDoc.ok
    ? withFieldWeights(flags, { ...filters, maxPerDoc: maxPerDoc.maxPerDoc })
    : { ok: false, error: maxPerDoc.error };
};

/**
 * WHAT is searched and HOW the answer is arranged — neither one scores. The
 * domain vocabulary is the invocation's own profile, so a `--profile` run is
 * validated against the domains it actually declares.
 */
const resolvePresentation = (
  flags: FlagValues,
  vocabulary: readonly AtomDomain[]
): PresentationResult => {
  const types = resolveTypeFilter(flags);
  const domains = resolveDomainFilter(flags, vocabulary);
  if (!types.ok) return { ok: false, error: types.error };
  if (!domains.ok) return { ok: false, error: domains.error };
  return withMaxPerDoc(flags, { types: types.types, domains: domains.domains });
};

/** The three resolutions, welded into the one shape the rerank step takes. */
const resolvedValues = (
  counts: Extract<CountsResult, { readonly ok: true }>,
  presentation: Extract<PresentationResult, { readonly ok: true }>,
  prf: PrfResolution
): ResolvedValues => ({
  k: counts.k,
  maxTokens: counts.maxTokens,
  budgetMode: counts.budgetMode,
  types: presentation.types,
  domains: presentation.domains,
  maxPerDoc: presentation.maxPerDoc,
  fieldWeights: presentation.fieldWeights,
  ...prf,
});

/** Every value flag, resolved together so the command states one refusal path. */
const resolveArgs = (context: CommandContext): ArgsResult => {
  const { flags, profile } = context;
  const counts = resolveCounts(flags);
  if (!counts.ok) return { ok: false, error: counts.error };
  const presentation = resolvePresentation(flags, profile.domains);
  if (!presentation.ok) return { ok: false, error: presentation.error };
  const prf = resolvePrf(flags, context.adapter, profile.defaultPrf);
  return prf.ok
    ? withRerankArgs(flags, resolvedValues(counts, presentation, prf), profile.rerankPoolK)
    : { ok: false, error: prf.error };
};

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
 * The text the SEARCH runs on — the rewrite when there is one, the raw query
 * otherwise. One helper, because the port and the reranker MUST see the same
 * string: a reranker scoring the raw query against a rewritten first pass would
 * fuse two orders produced for two different questions.
 */
export const effectiveQuery = (request: RetrieveRequest): string =>
  request.queryRewritten ?? request.query;

/**
 * One `note` key carries whichever refusal happened, so a caller reads a single
 * field instead of two. A skip and an absent corpus cannot co-occur: nothing was
 * retrieved to budget in the second case.
 */
/**
 * The unexpanded-ranking line, and nothing else: it is a STATEMENT about what
 * ran, not a refusal, so it never moves the exit code — the run delivered
 * everything it could, by the adapter rule the profile default states.
 */
const prfNotes = (request: RetrieveRequest): readonly string[] =>
  request.prfNote === undefined ? [] : [request.prfNote];

export const noteLines = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): readonly string[] => {
  const refusals = refusalsOf(request);
  const trailing = [
    ...prfNotes(request),
    ...floorNotes(budgeted),
    ...emptyNotes(request, budgeted),
    ...capNotes(request, budgeted),
  ];
  if (refusals.length > 0) return [...refusals, ...trailing];
  if (hasSkips(budgeted)) return [budgetWarning(budgeted), ...trailing];
  return [...unsearchedNotes(request, budgeted.result), ...trailing];
};

const noteField = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, string>> => {
  const lines = noteLines(request, budgeted);
  return lines.length > 0 ? { note: lines.join('\n') } : {};
};

/**
 * The RESOLVED feedback model the run expanded under, PRESENT only when a pass
 * actually ran — its presence is what says one did, exactly as `rerankScore`
 * says a reranker scored an atom. A default-valued field could not tell an
 * expanded ranking from a plain one, and the expansion is unrecoverable from
 * the atoms afterwards: a run that changed the answer MUST show it in the record.
 */
export interface PrfReport {
  readonly fbDocs: number;
  readonly fbTerms: number;
  readonly alpha: number;
  readonly source: PrfSourceName;
}

/** The resolved cell plus its source, or `undefined` when nothing expanded. */
const prfReport = (request: RetrieveRequest): PrfReport | undefined =>
  request.prf === undefined || request.prfSource === undefined
    ? undefined
    : { ...request.prf, source: request.prfSource };

export const prfField = (request: RetrieveRequest): { readonly prf?: PrfReport } => {
  const report = prfReport(request);
  return report === undefined ? {} : { prf: report };
};

/** Omitted entirely when no rewrite happened, so an unrephrased payload is unchanged. */
const rewrittenField = (request: RetrieveRequest): Readonly<Record<string, string>> =>
  request.queryRewritten === undefined ? {} : { queryRewritten: request.queryRewritten };

/**
 * What the run has to SAY, beyond the atoms — one group, because both members
 * are omitted when there is nothing to say and both must be able to fire on the
 * same run without either erasing the other.
 */
const reportFields = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, unknown>> => ({
  ...vocabularyGapField(request),
  ...noteField(request, budgeted),
});

/** The `--json` payload. Its key set is adapter-independent by construction. */
const payload = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, unknown>> => ({
  command: 'search',
  adapter: request.context.adapter,
  query: request.query,
  ...rewrittenField(request),
  k: request.k,
  mode: budgeted.result.mode,
  indexState: budgeted.result.indexState,
  count: budgeted.result.atoms.length,
  poolSize: budgeted.poolSize,
  budgetMode: request.budgetMode,
  confidence: confidenceOf(request, budgeted),
  ...prfField(request),
  atoms: explainAtoms(effectiveQuery(request), budgeted.result.atoms),
  skipped: budgeted.skipped,
  ...reportFields(request, budgeted),
});

/**
 * `<section>` carries the atom's own `title`, which ingest sets to the LEAF
 * heading and promotes to the full `>`-joined chain only when that leaf is
 * ambiguous across sources. The chain is otherwise consumed to build the atom id
 * and not kept on the atom, so reconstructing it here would mean re-reading the
 * source document — a different job.
 *
 * `<source>` is stated RELATIVE to the repo root: an absolute path is noise in a
 * pasted prompt, and the absolute form stays available in `--json`.
 *
 * `<origin>` is a SEPARATE element, one per origin document, and it is not
 * relativized: ingest already wrote those paths repo-relative. It sits beside
 * `<source>` rather than replacing it because the two answer different
 * questions — which atom file this is, and which document it was cut from.
 */
const originXml = (origin: string): string => `      <origin>${escapeXml(origin)}</origin>`;

const documentXml = (atom: RetrievedAtom, repoRoot: string): string =>
  [
    `  <document ${xmlAttribute('id', atom.id)} ${xmlAttribute('score', formatScore(atom.score))} ${xmlAttribute('domain', atom.domain)}>`,
    '    <metadata>',
    `      <source>${escapeXml(relative(repoRoot, atom.sourcePath))}</source>`,
    ...atom.originPaths.map(originXml),
    `      <section>${escapeXml(atom.title)}</section>`,
    '    </metadata>',
    '    <content>',
    escapeXml(atom.body),
    '    </content>',
    '  </document>',
  ].join('\n');

const rewrittenAttribute = (request: RetrieveRequest): readonly string[] =>
  request.queryRewritten === undefined
    ? []
    : [xmlAttribute('queryRewritten', request.queryRewritten)];

const rootAttributes = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  [
    xmlAttribute('query', request.query),
    ...rewrittenAttribute(request),
    xmlAttribute('adapter', request.context.adapter),
    xmlAttribute('mode', budgeted.result.mode),
    xmlAttribute('indexState', budgeted.result.indexState),
    xmlAttribute('count', String(budgeted.result.atoms.length)),
    xmlAttribute('confidence', confidenceOf(request, budgeted)),
  ].join(' ');

/**
 * An `unavailable` run emits the SAME empty block plus a `<note>`, so a consumer
 * separates "searched, found nothing" from "no search happened" without parsing
 * prose: `indexState` carries the discrimination, and each case states its own
 * `<note>` — the empty search names the filter and the phrasing lever, the
 * unavailable one names the build command.
 */
/**
 * A skipped atom is an EMPTY element beside the documents: it has no content to
 * carry, only the identity, the source to load it from and the size that made it
 * not fit. The `<note>` states what to do about it in prose.
 */
const skippedXml = (skipped: SkippedAtom, repoRoot: string): string =>
  `  <skipped ${xmlAttribute('id', skipped.id)} ${xmlAttribute('source', relative(repoRoot, skipped.sourcePath))} ${xmlAttribute('estimatedTokens', String(skipped.estimatedTokens))}/>`;

const floorXml = (budgeted: BudgetedResult): readonly string[] =>
  floorNotes(budgeted).map(note => `  <note>${escapeXml(note)}</note>`);

const skipXml = (budgeted: BudgetedResult, repoRoot: string): readonly string[] =>
  hasSkips(budgeted)
    ? [
        `  <note>${escapeXml(budgetWarning(budgeted))}</note>`,
        ...budgeted.skipped.map(skipped => skippedXml(skipped, repoRoot)),
      ]
    : [];

const retrieveXml = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  [
    `<retrieved_context ${rootAttributes(request, budgeted)}>`,
    ...unsearchedNotes(request, budgeted.result).map(
      note => `  <note>${escapeXml(note)}</note>`
    ),
    ...skipXml(budgeted, request.context.repoRoot),
    ...floorXml(budgeted),
    ...emptyNotes(request, budgeted).map(note => `  <note>${escapeXml(note)}</note>`),
    ...capNotes(request, budgeted).map(note => `  <note>${escapeXml(note)}</note>`),
    ...budgeted.result.atoms.map(atom => documentXml(atom, request.context.repoRoot)),
    '</retrieved_context>',
  ].join('\n');

/**
 * The reranker reorders a POOL, so the first pass must fetch one: `k` alone
 * would hand it the very ranking it exists to change. A caller asking for more
 * than the measured depth keeps its own `k` — never fewer candidates than
 * results.
 */
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
const retrieveOptions = (request: RetrieveRequest): RetrieveOptions => ({
  k: firstPassK(request),
  ...(request.types === undefined ? {} : { types: request.types }),
  ...(request.domains === undefined ? {} : { domains: request.domains }),
  ...(request.prf === undefined ? {} : { prf: request.prf }),
});

/** The ranking to render, plus the reranker's refusal when there was one. */
interface RankedOutcome {
  readonly result: RetrievalResult;
  readonly refusal: string | undefined;
}

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

const trimmed = (result: RetrievalResult, request: RetrieveRequest): RetrievalResult => {
  const cap = request.maxPerDoc;
  const capped = cap === undefined ? result.atoms : capPerDocument(result.atoms, cap);
  return { ...result, atoms: arranged(capped.slice(0, request.k), cap) };
};

/**
 * The reranked-and-fused ranking, or the first pass plus the refusal that
 * explains why there is no second one.
 *
 * The discrimination probe runs FIRST, before any document is scored: a broken
 * reranker answers HTTP 200 with numbers that carry no ranking signal.
 *
 * A refusal DEGRADES rather than discards. `RERANK_K_INIT` is 100, so throwing
 * the run away over an unreachable reranker would bin a full 100-candidate
 * first pass — a real ranking the caller can use — and answer a question with
 * nothing. What the degraded run MUST NOT do is claim the rerank: `mode` keeps
 * the first-pass value with NO `+rerank` suffix, since `mode` is the caller's
 * only evidence of which ranking it actually received, and the refusal reaches
 * it as the note under a PARTIAL exit code.
 */
const rankedResult = async (
  request: RetrieveRequest,
  result: RetrievalResult
): Promise<RankedOutcome> => {
  if (!request.rerank) return { result: trimmed(result, request), refusal: undefined };
  const unusable = await rerankProbeRefusal(request.rerankOptions);
  if (unusable !== undefined) return { result: trimmed(result, request), refusal: unusable };
  const reranked = await rerankAtoms(effectiveQuery(request), result.atoms, request.rerankOptions);
  if (!reranked.ok) return { result: trimmed(result, request), refusal: reranked.error };
  const fused = trimmed({ ...result, atoms: reranked.atoms }, request);
  return { result: { ...fused, mode: `${result.mode}+rerank` }, refusal: undefined };
};

/** The delivered ranking after the floor, and how many atoms it removed. */
interface FlooredResult {
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
const applyFloor = (request: RetrieveRequest, result: RetrievalResult): FlooredResult => {
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
interface PoolFacts {
  readonly size: number;
  readonly capped: number;
}

/**
 * How many atoms of the pool survive the per-document cap. Read off the FIRST
 * PASS rather than the delivered slice: the count is order-invariant, so it is
 * the ceiling on what any arrangement of that pool could have delivered.
 */
const poolFacts = (request: RetrieveRequest, pool: readonly RetrievedAtom[]): PoolFacts => ({
  size: pool.length,
  capped:
    request.maxPerDoc === undefined ? pool.length : capPerDocument(pool, request.maxPerDoc).length,
});

/**
 * The budget as resolved: the ceiling, and the measure that charges against it.
 */
interface BudgetSpec {
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
const applyBudget = (
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

/**
 * The rewrite, resolved onto the request before anything is searched.
 *
 * A refusal is NOT fatal: the RAW query is still retrieved with, because a
 * caller asking a question deserves an answer more than it deserves silence.
 * What it MUST NOT get is exit 0 — the refusal becomes the note and the run is
 * PARTIAL, so a rephrased run and a degraded one are never confused.
 */
const withRewrite = async (request: RetrieveRequest): Promise<RetrieveRequest> => {
  if (!request.rephrase) return request;
  const outcome = await rephraseQuery(request.query, {
    cacheDir: `${request.context.indexPath}${REPHRASE_CACHE_SUFFIX}`,
  });
  return outcome.ok
    ? { ...request, queryRewritten: outcome.rewritten }
    : { ...request, rephraseRefusal: outcome.error };
};

/** The three renderings of one budgeted run, plus the exit code they share. */
const rendered = (
  request: RetrieveRequest,
  result: RetrievalResult,
  budgeted: BudgetedResult
): CommandOutcome => ({
  exitCode: exitCodeFor(request, result, budgeted),
  data: payload(request, budgeted),
  text: retrieveText(request, budgeted),
  xml: retrieveXml(request, budgeted),
});

/** This command's name, on the payload of a refusal that has no ranking to render. */
const SEARCH_COMMAND = 'search';

/**
 * One completed retrieval, everything a rendering needs and nothing rendered
 * yet. `result` is the PRE-FLOOR ranked result, kept beside the budgeted one
 * because the exit code is judged on what was searched, not on what survived.
 */
export interface RetrievalRun {
  readonly request: RetrieveRequest;
  readonly budgeted: BudgetedResult;
  readonly result: RetrievalResult;
  readonly confidence: RetrieveConfidence;
  readonly exitCode: number;
}

/**
 * A run, or the outcome that replaces it. A refusal is already a full
 * `CommandOutcome` — a usage fault and a dead tokenizer produce no ranking, so
 * there is nothing for a second command to render differently.
 */
export type RetrievalOutcome =
  | { readonly ok: true; readonly run: RetrievalRun }
  | { readonly ok: false; readonly outcome: CommandOutcome };

const runOf = (
  request: RetrieveRequest,
  result: RetrievalResult,
  budgeted: BudgetedResult
): RetrievalRun => ({
  request,
  budgeted,
  result,
  confidence: confidenceOf(request, budgeted),
  exitCode: exitCodeFor(request, result, budgeted),
});

const refused = (reason: string): RetrievalOutcome => ({
  ok: false,
  outcome: budgetRefusalOutcome(SEARCH_COMMAND, reason),
});

/** The ceiling, the measure and the reserve — one decision, stated in one place. */
const budgetSpec = (
  request: RetrieveRequest,
  measure: AtomMeasure,
  overhead: number
): BudgetSpec => ({ maxTokens: request.maxTokens, measure, overhead });

/** The one adapter whose index carries an fts5 vocabulary to be read. */
const VOCABULARY_ADAPTER: AdapterName = 'fts5';

/**
 * The measurement, taken only when it can be taken: the fts5 adapter, over an
 * index the port reported `ready`. Any other state means nothing was searched,
 * or was searched somewhere this reader cannot open — and a clean zero from an
 * unmeasured index would be exactly the false green the warning exists to end.
 *
 * The raw query is used, and the analyser is the index's OWN stamped chain, so
 * the terms compared are the terms the search itself matched with.
 *
 * A throw is swallowed to `undefined` ON PURPOSE and here alone: this is a
 * diagnostic, and a diagnostic that can fail a retrieval has traded a warning
 * for an outage. The run then reports as it did before C11a existed.
 */
const vocabularyGapOf = (
  request: RetrieveRequest,
  result: RetrievalResult
): VocabularyGap | undefined => {
  const { context } = request;
  if (context.adapter !== VOCABULARY_ADAPTER || result.indexState !== 'ready') return undefined;
  try {
    return readVocabularyGap(
      context.indexPath,
      effectiveQuery(request),
      readIndexAnalyzer(context.indexPath)
    );
  } catch {
    return undefined;
  }
};

const search = async (
  request: RetrieveRequest,
  counting: CountAtoms,
  overhead: number
): Promise<RetrievalOutcome> => {
  const { context } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath, {
    fieldWeights: request.fieldWeights,
    expectedAnalyzer: context.profile.defaultAnalyzer,
  });
  const result = await port.retrieve(effectiveQuery(request), retrieveOptions(request));
  port.close?.();
  const ranked = await rankedResult(request, result);
  const reported: RetrieveRequest = {
    ...request,
    rerankRefusal: ranked.refusal,
    vocabularyGap: vocabularyGapOf(request, result),
  };
  const floored = applyFloor(reported, ranked.result);
  const measured = await counting(floored.result.atoms);
  if (!measured.ok) return refused(measured.reason);
  const budget = budgetSpec(request, measured.measure, overhead);
  const budgeted = applyBudget(floored, budget, poolFacts(request, result.atoms));
  return { ok: true, run: runOf(reported, ranked.result, budgeted) };
};

type ResolvedArgs = Extract<ArgsResult, { readonly ok: true }>;

/**
 * The three fields NO argv can state: each one is written later by the leg that
 * produces it, and starting them absent is what lets a reader tell "did not run"
 * from "ran and refused".
 */
const UNRESOLVED = {
  queryRewritten: undefined,
  rephraseRefusal: undefined,
  rerankRefusal: undefined,
  vocabularyGap: undefined,
} as const;

/** How the run SCORES: the column weights, and the feedback pass over them. */
const scoringFields = (args: ResolvedArgs): PrfResolution & { readonly fieldWeights: FieldWeights } => ({
  fieldWeights: args.fieldWeights,
  ...prfFields(args),
});

/** The feedback pass and the line it owes a reader, carried as one. */
const prfFields = (args: ResolvedArgs): PrfResolution => ({
  prf: args.prf,
  prfSource: args.prfSource,
  prfNote: args.prfNote,
});

/** The request as argv described it — every refusal field still unresolved. */
const initialRequest = (
  context: CommandContext,
  query: string,
  args: ResolvedArgs
): RetrieveRequest => ({
  context,
  query,
  k: args.k,
  maxTokens: args.maxTokens,
  budgetMode: args.budgetMode,
  types: args.types,
  domains: args.domains,
  maxPerDoc: args.maxPerDoc,
  rerank: args.rerank,
  rerankOptions: args.rerankOptions,
  rerankPoolK: args.rerankPoolK,
  minRelevance: args.minRelevance,
  rephrase: args.rephrase,
  ...scoringFields(args),
  ...UNRESOLVED,
});

/**
 * The chrome the run reserves, in the active measure. No overhead text means NO
 * count at all — `search` reserves nothing, so it makes no extra tokenizer
 * call and its budget is the one it always had.
 */
const overheadCost = async (
  countOne: CountOne,
  overhead: string | undefined
): Promise<TokenCountResult> =>
  overhead === undefined ? { ok: true, count: 0 } : await countOne(overhead);

/** Probe, then retrieve. The probe runs BEFORE the search, so a refusal costs none. */
const searchWithBudget = async (
  request: RetrieveRequest,
  charged: ChargedText,
  overhead: string | undefined
): Promise<RetrievalOutcome> => {
  const counting = await resolveCounting(request.budgetMode, createTokenCounter(), charged);
  if (!counting.ok) return refused(counting.reason);
  const reserved = await overheadCost(counting.countOne, overhead);
  if (!reserved.ok) return refused(reserved.reason);
  return await search(await withRewrite(request), counting.counting, reserved.count);
};

/**
 * The whole pipeline up to — and not including — the rendering: argv, the
 * rewrite, the search, the rerank, the floor, the budget.
 *
 * Split out so a second command reuses the RANKING rather than re-deriving it.
 * `charged` states what that command will actually emit per atom, so its budget
 * charges the text it renders; `overhead` states the fixed chrome it emits
 * AROUND them, subtracted from `maxTokens` before the fit. `search` charges
 * the body and reserves nothing, unchanged.
 */
export const performRetrieval = async (
  context: CommandContext,
  charged: ChargedText = bodyText,
  overhead?: string
): Promise<RetrievalOutcome> => {
  const query = context.positionals.join(' ');
  const args = resolveArgs(context);
  if (query.length === 0) return { ok: false, outcome: usageError(NO_QUERY) };
  if (!args.ok) return { ok: false, outcome: usageError(args.error) };
  return await searchWithBudget(initialRequest(context, query, args), charged, overhead);
};

export const runRetrieveCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const outcome = await performRetrieval(context);
  if (!outcome.ok) return outcome.outcome;
  const { request, result, budgeted } = outcome.run;
  return rendered(request, result, budgeted);
};
