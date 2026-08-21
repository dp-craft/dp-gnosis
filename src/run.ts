/**
 * The entry point: manifest → per dataset (load, ingest, index, retrieve,
 * score) → report → optional comparison against the recorded history.
 *
 * Three call-site duties live here, because no lower layer can discharge them:
 *
 * 1. **The rerank first pass is WIDENED, then sliced back.** The CLI reranks the
 *    top `RERANK_K_INIT` (`retrieveCommand.ts:308` — `Math.max(request.k,
 *    RERANK_K_INIT)`), and `engine.ts` deliberately does not replicate that. At
 *    a depth below 20 an un-widened first pass would hand the reranker fewer
 *    candidates than the shipped configuration ever sees, so the `--rerank` arm
 *    would measure a configuration that does not exist. The constant is
 *    IMPORTED from the engine's config, never restated, so the two cannot drift.
 * 2. **A dataset failure fails the RUN.** The other datasets still run and are
 *    still recorded — a fetch problem in one should not cost the rest — but the
 *    process exits non-zero, because a partial run silently reported as complete
 *    is the failure mode this suite exists to prevent. For the same reason an
 *    unknown `--only` id, and any selection that measures nothing, exit 1 with a
 *    message on stderr before a single dataset is touched. Each dataset is
 *    RECORDED as it completes, so the same holds when the PROCESS dies rather
 *    than a dataset — the reason the buffered form was replaced.
 * 3. **Topics come from the qrels, not the query file.** A query with no
 *    judgments cannot be scored; including it would divide the mean by a topic
 *    that could only ever contribute 0.
 *
 * Datasets are processed one at a time on purpose: ingest is CPU-bound and each
 * dataset owns an exclusive work directory (`engine.ts` rule 3).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fusesLegs } from '../../dp-gnosis/src/adapters/lanceDbDenseAdapter.js';
import type { ExtractStrategy } from '../../dp-gnosis/src/bench/reranker.js';
import { fitToTokenBudget } from '../../dp-gnosis/src/budget.js';
import {
  ADAPTER_NAMES,
  adapterError,
  type AdapterName,
  denseRouteOf,
  resolveAdapter
} from '../../dp-gnosis/src/cli/adapter.js';
import {
  ATOM_MAX_CHARS,
  DEFAULT_EXCLUDED_TYPES,
  DEFAULT_RERANK_PRESET,
  EMBED_MODEL_ID,
  RERANK_DOC_MAX_CHARS,
  RERANK_K_INIT,
  RERANK_MODEL_ID,
  type RerankFusion } from '../../dp-gnosis/src/config.js';
import type { KnowledgePort, RetrievedAtom } from '../../dp-gnosis/src/port.js';
import { DEFAULT_PRF_PARAMS, type PrfParams } from '../../dp-gnosis/src/prf.js';
import { type AnalyzerId, ANALYZERS, DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import { EXTRACT_STRATEGY, resolveRerankFusion } from '../../dp-gnosis/src/rerank.js';
import {
  type Qrel,
  readCorpus,
  readQrels,
  readQueries,
  readQueryFacets,
  type TopicFacets
} from './beir.js';
import { compareAll, type Comparison, formatComparison } from './compare.js';
import {
  assertRerankDiscriminates,
  openPort,
  prepareDataset,
  type PreparedDataset,
  probePortSoundness,
  rerankIfRequested,
  retrieveDocs
} from './engine.js';
import { ensureBeirDataset } from './fetch/beirZip.js';
import { ensureBrightDataset, readExcluded } from './fetch/bright.js';
import {
  assertGoldReachable,
  describeDerivation,
  ensureVaultDataset,
  UNREACHABLE_GOLD_CAUSE
} from './fetch/vault.js';
import { assertKnownFlags, type FlagSpec, GATE_VALUE_FLAGS } from './flags.js';
import { GATE_EXIT_CODE, type GateOptions, gateReport, parseGateArgs } from './gate.js';
import {
  type BeirDataset,
  type DatasetEntry,
  datasetsInLayer,
  enabledDatasets,
  type LayerName,
  LAYERS_TEXT,
  loadManifest,
  resolveLayer
} from './manifest.js';
import {
  corpusChecksum,
  currentGitSha,
  type DatasetResult,
  HISTORY_FILE,
  NO_TYPE_FILTER,
  readHistory,
  recordDataset,
  type RunProvenance,
  writeRunSummary
} from './report.js';
import {
  type AtomSpread,
  atomSpread,
  type DatasetScore,
  perAxisStrata,
  scoreDataset,
  toDocumentRanking,
  withTopicFacets
} from './score.js';
import { type MetricName, pairedSignificance, type Significance } from './significance.js';
import { significanceLabel } from './sweepReport.js';

/** The suite directory; every other path here is resolved from it, never from `cwd`. */
export const SUITE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
export const MANIFEST_PATH = resolve(SUITE_ROOT, 'datasets.json');
const RESULTS_DIR = resolve(SUITE_ROOT, 'results');
const DATA_DIR = resolve(SUITE_ROOT, 'data');
/** Where every dataset's throwaway corpus, atoms and index live — one subdir per id. */
export const WORK_ROOT = resolve(DATA_DIR, 'work');
const CORPUS_FILE = 'corpus.jsonl';

/**
 * The adapter measured when `--adapter` is silent. NOT the engine CLI's default
 * (`linear`): the suite's recorded history is fts5, and moving the bench default
 * would silently re-base every comparison against it.
 */
export const BENCH_DEFAULT_ADAPTER: AdapterName = 'fts5';

const DEFAULT_DEPTH = 100;
const METRIC_DIGITS = 4;
const FAILURE_EXIT_CODE = 1;

/**
 * A REFUSAL, distinct from a dataset failure: the run could have measured, and
 * declines to, because what it would measure is not the thing the numbers claim
 * (CLAUDE.md § Script Exit-Code Contract). Exit 1 already means "a dataset
 * failed, the rest are recorded", which is the opposite reading.
 */
export const REFUSAL_EXIT_CODE = 3;

const REFUSAL_CAUSES: readonly string[] = [UNREACHABLE_GOLD_CAUSE];

const isRefusal = (error: unknown): boolean =>
  error instanceof Error && typeof error.cause === 'string' && REFUSAL_CAUSES.includes(error.cause);

/** The flags `bench.sh` forwards. */
export interface CliOptions {
  /** Dataset ids to run; empty means every enabled entry. */
  readonly only: readonly string[];
  /** The suite layer to run; `undefined` means "not filtered by layer". */
  readonly layer: LayerName | undefined;
  readonly depth: number;
  readonly rerank: boolean;
  readonly compare: boolean;
  /** The adapter arm under measurement; recorded as provenance. */
  readonly adapter: AdapterName;
  /**
   * The rerank protocol BY NAME — what the run records, and what a reader of
   * `history.jsonl` compares. The bench never restates the fusion rule itself.
   */
  readonly rerankProfile: string;
  /** A raw weight override on the named preset; `undefined` means the preset's own. */
  readonly rerankWeight: number | undefined;
  /**
   * The DENSE leg's weight in the HYBRID route's leg fusion — a different fusion
   * from `rerankWeight`'s, over different orders, so the two flags stay separate.
   * `undefined` means the engine's shipped `HYBRID_FUSION`, which is what every
   * recorded hybrid row was measured under.
   */
  readonly hybridWeight: number | undefined;
  /**
   * The cross-encoder MODEL the rerank arm scores with; `undefined` means the
   * engine's shipped `RERANK_MODEL_ID`, which every recorded run used. Recorded
   * as a treatment field, so two model arms can never be subtracted.
   */
  readonly rerankModel: string | undefined;
  /**
   * The EXPLICIT candidate pool the reranker scores, bypassing the engine's
   * `RERANK_K_INIT` floor entirely. `undefined` means the shipped formula —
   * `max(depth, RERANK_K_INIT)` — which every recorded arm was measured under,
   * so an unflagged run stays bit-identical. It exists because the floor made a
   * pool SMALLER than the constant unmeasurable once the constant reached 100,
   * and the bench must be able to measure a pool the serving path does not use.
   */
  readonly rerankPool: number | undefined;
  /**
   * WHAT the reranker is shown: how much of an atom body reaches it, and which
   * part. `undefined` on either means the engine's shipped default —
   * `RERANK_DOC_MAX_CHARS` and `EXTRACT_STRATEGY` — which every recorded arm was
   * measured under, so an unflagged run stays bit-identical. They are recorded
   * RESOLVED, because the text the cross-encoder scored is not recoverable from
   * the numbers afterwards.
   */
  readonly rerankDocMaxChars: number | undefined;
  readonly rerankExtract: ExtractStrategy | undefined;
  /**
   * The CONSUMER's token cap, applied to the PRESENTED ranking after every
   * ranking stage. `undefined` means no cap at all — the default path every
   * recorded row was measured on, byte for byte.
   */
  readonly tokenBudget: number | undefined;
  /**
   * How many top atoms the budget is charged over. `undefined` means the run
   * depth — the whole presentation — so `--budget` alone caps by TOKENS and
   * nothing else. Meaningless without a budget, and refused there.
   */
  readonly servedK: number | undefined;
  /** The engine's resolution of that name, resolved ONCE so a bad one fails before any dataset. */
  readonly rerankFusion: RerankFusion;
  /**
   * The analysis chain the index is BUILT with — a treatment, recorded on every
   * row, because every run has one whether or not it named it.
   */
  readonly analyzer: AnalyzerId;
  /**
   * The QUERY-SIDE adjacency treatment: a multi-term raw token contributes its
   * phrase as an extra disjunct BESIDE its individual terms. Recorded on every
   * row like `analyzer`, because every run either applied it or did not.
   */
  readonly queryAdjacency: boolean;
  /**
   * RM3 pseudo-relevance feedback: the first pass builds a term model and the
   * ranking is REPLACED by the weighted rescore. Recorded on every row like
   * `queryAdjacency`, because every run either expanded or did not.
   */
  readonly prf: boolean;
  /**
   * The three RM3 knobs, each `undefined` meaning the engine's shipped
   * `DEFAULT_PRF_PARAMS` — the model the flag alone measures. Meaningless
   * without `--prf`, and refused there.
   */
  readonly prfDocs: number | undefined;
  readonly prfTerms: number | undefined;
  readonly prfAlpha: number | undefined;
  /**
   * Whether the run projects the FULL vault — every atom type — instead of the
   * SERVABLE subset the CLI shows. Same name and same meaning as the CLI's flag.
   * OFF aligns the bench with serving: the excluded types are subtracted at the
   * DERIVE step (`fetch/vault.ts`), the one place the atom's type still exists,
   * because the BEIR projection carries `{id,title,text}` alone.
   */
  readonly includeHistory: boolean;
}

/** A scorable query: judged by the qrels, so it can contribute a non-zero mean. */
export interface Topic {
  readonly id: string;
  readonly text: string;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const csv = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split(',').map(part => part.trim()).filter(part => part.length > 0);

/**
 * An unknown `--adapter` THROWS. Falling back to the default would record a run
 * whose provenance says one engine path while another was measured — the exact
 * confusion `compare.ts` refuses to subtract across.
 */
const parseAdapter = (value: string | undefined): AdapterName => {
  if (value === undefined) return BENCH_DEFAULT_ADAPTER;
  const adapter = resolveAdapter(value);
  if (adapter === undefined) throw new Error(`dp-gnosis-bench: ${adapterError(value)}`);
  return adapter;
};

/**
 * An unknown `--layer` THROWS, naming the valid ones, exactly as `--adapter`
 * does: silently running the whole suite instead of the layer asked for would
 * cost an hour and record a run nobody requested.
 */
const parseLayer = (value: string | undefined): LayerName | undefined => {
  if (value === undefined) return undefined;
  const layer = resolveLayer(value);
  if (layer === undefined) {
    throw new Error(`dp-gnosis-bench: unknown --layer "${value}" — use ${LAYERS_TEXT}`);
  }
  return layer;
};

const ANALYZER_IDS: readonly string[] = Object.keys(ANALYZERS);

const isAnalyzerId = (value: string): value is AnalyzerId => ANALYZER_IDS.includes(value);

/**
 * An unknown `--analyzer` THROWS, naming the valid chains, for the reason
 * `--adapter` does: the chain is not recoverable from the numbers afterwards, so
 * a silent fallback would publish a run under an analyzer label it never used.
 */
const parseAnalyzer = (value: string | undefined): AnalyzerId => {
  if (value === undefined) return DEFAULT_ANALYZER;
  if (isAnalyzerId(value)) return value;
  throw new Error(
    `dp-gnosis-bench: unknown --analyzer "${value}" — use ${ANALYZER_IDS.join(', ')}`
  );
};

/** The ONE adapter whose index build takes the named chain (`prepareDataset`). */
const ANALYZER_AWARE_ADAPTER: AdapterName = 'fts5';

/**
 * The chain `linear` and `minisearch` implement IN CODE — they call `tokenize` +
 * `stemTerm`, which IS `porter-fold`. Deliberately NOT `DEFAULT_ANALYZER`: the
 * default moves (it became `ident-porter-fold`), and a waiver written against a
 * moving default silently widens to whatever the default names next, stamping the
 * `analyzer` treatment field with a chain that never ran.
 */
const HARDCODED_ADAPTER_ANALYZER: AnalyzerId = 'porter-fold';

/**
 * The chain an arm ACTUALLY analyses with. `fts5` builds its index with whatever
 * chain is named, so it takes the flag and the engine default. Every other
 * adapter analyses with `HARDCODED_ADAPTER_ANALYZER` no matter what is asked, so
 * an ABSENT flag resolves to that chain — the run then records what ran — and an
 * EXPLICIT flag naming any other chain REFUSES before a dataset is prepared,
 * because `analyzer` is a TREATMENT field `compare.ts` labels an arm by, and a
 * label under a chain the run never used is unrecoverable from the numbers.
 */
const resolveAnalyzer = (adapter: AdapterName, value: string | undefined): AnalyzerId => {
  if (adapter === ANALYZER_AWARE_ADAPTER) return parseAnalyzer(value);
  if (value === undefined) return HARDCODED_ADAPTER_ANALYZER;
  const analyzer = parseAnalyzer(value);
  if (analyzer === HARDCODED_ADAPTER_ANALYZER) return analyzer;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" does not honour --analyzer "${analyzer}" — ` +
      `only "${ANALYZER_AWARE_ADAPTER}" builds its index with the named chain; ` +
      `"${adapter}" always analyses with "${HARDCODED_ADAPTER_ANALYZER}"`
  );
};

const INCLUDE_HISTORY_FLAG = '--include-history';

/**
 * The TREATMENT string a run stamps: the types its corpus EXCLUDED, sorted so
 * two runs of one arm stamp the same value, and derived from the engine's own
 * `DEFAULT_EXCLUDED_TYPES` so no list is restated here. A run that excluded
 * nothing stamps `NO_TYPE_FILTER`, which is what every legacy row means.
 */
export const typeFilterOf = (includeHistory: boolean): string => {
  const excluded = includeHistory ? [] : [...DEFAULT_EXCLUDED_TYPES].sort();
  return excluded.length === 0 ? NO_TYPE_FILTER : excluded.join(',');
};

const QUERY_ADJACENCY_FLAG = '--query-adjacency';

/** The ONE adapter whose `retrieve` honours the adjacency option (`fts5Adapter.ts`). */
const ADJACENCY_AWARE_ADAPTER: AdapterName = 'fts5';

/**
 * `--query-adjacency` on any other adapter REFUSES, before a dataset is
 * prepared, exactly as `--analyzer` does: no other adapter reads the option, so
 * the row would record `queryAdjacency` — a TREATMENT field `compare.ts` labels
 * an arm — under a treatment the run never applied. The flagless invocation is
 * what every adapter already does, so every legacy invocation stands.
 */
const checkAdjacencyAdapter = (adapter: AdapterName, adjacency: boolean): boolean => {
  if (!adjacency || adapter === ADJACENCY_AWARE_ADAPTER) return adjacency;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" does not honour ${QUERY_ADJACENCY_FLAG} — ` +
      `only "${ADJACENCY_AWARE_ADAPTER}" applies the adjacency phrase at query time`
  );
};

const PRF_FLAG = '--prf';
const PRF_DOCS_FLAG = '--prf-docs';
const PRF_TERMS_FLAG = '--prf-terms';
const PRF_ALPHA_FLAG = '--prf-alpha';

/** The ONE adapter whose `retrieve` honours the RM3 option (`fts5Adapter.ts`). */
const PRF_AWARE_ADAPTER: AdapterName = 'fts5';

/**
 * `--prf` on any other adapter REFUSES, before a dataset is prepared, exactly as
 * `--query-adjacency` does: no other adapter reads the option — the engine
 * refuses it too — so the row would record `prf`, a TREATMENT field `compare.ts`
 * labels an arm, under an expansion the run never ran. Reaching the engine and
 * hoping would cost the arm instead of the parse.
 */
const checkPrfAdapter = (adapter: AdapterName, prf: boolean): boolean => {
  if (!prf || adapter === PRF_AWARE_ADAPTER) return prf;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" does not honour ${PRF_FLAG} — ` +
      `only "${PRF_AWARE_ADAPTER}" expands the query from its own first pass`
  );
};

/** A feedback set or a term model of fewer than one member expands nothing. */
const PRF_COUNT_MIN = 1;

/** The interpolation's two ends: the unexpanded query, and the expansion alone. */
const PRF_ALPHA_MIN = 0;
const PRF_ALPHA_MAX = 1;

/**
 * An RM3 knob without `--prf` REFUSES, exactly as `--rerank-pool` does without
 * `--rerank`: nothing would expand, yet the row would name a term model no query
 * was ever rescored by.
 */
const requirePrf = (flag: string, value: string, prf: boolean): void => {
  if (prf) return;
  throw new Error(
    `dp-gnosis-bench: ${flag} "${value}" requires ${PRF_FLAG} — ` +
      'without it nothing expands and the row would name a model nothing ran'
  );
};

/**
 * A fractional, zero or negative count is a usage error, NOT something to clamp:
 * a clamped cell records the model it was ASKED for while expanding under
 * another, so two cells of one sweep would carry the same label.
 */
const parsePrfCount = (flag: string, value: string | undefined, prf: boolean): number | undefined => {
  if (value === undefined) return undefined;
  requirePrf(flag, value, prf);
  const count = Number(value);
  if (Number.isInteger(count) && count >= PRF_COUNT_MIN) return count;
  throw positiveIntegerError(flag, PRF_COUNT_MIN, value);
};

/** An alpha outside `0…1` is a usage error for the reason `--hybrid-weight` is. */
const parsePrfAlpha = (value: string | undefined, prf: boolean): number | undefined => {
  if (value === undefined) return undefined;
  requirePrf(PRF_ALPHA_FLAG, value, prf);
  const alpha = Number(value);
  if (alpha >= PRF_ALPHA_MIN && alpha <= PRF_ALPHA_MAX) return alpha;
  throw new Error(
    `dp-gnosis-bench: ${PRF_ALPHA_FLAG} expects a number from ${PRF_ALPHA_MIN} ` +
      `(the unexpanded query) to ${PRF_ALPHA_MAX} (the expansion alone), got "${value}"`
  );
};

/**
 * The adapters that fuse two legs, DERIVED from the engine's own route table and
 * its own `fusesLegs` rule — the bench states no adapter list of its own.
 */
const HYBRID_ADAPTERS: readonly AdapterName[] = ADAPTER_NAMES.filter(name => {
  const route = denseRouteOf(name);
  return route !== undefined && fusesLegs(route);
});

/** The two ends of the leg-fusion weight: pure lexical, and pure dense. */
const HYBRID_WEIGHT_MIN = 0;
const HYBRID_WEIGHT_MAX = 1;

const HYBRID_WEIGHT_FLAG = '--hybrid-weight';

const hybridRangeText = `${HYBRID_WEIGHT_MIN} (pure lexical) to ${HYBRID_WEIGHT_MAX} (pure dense)`;

/**
 * A weight outside `0…1` is a usage error, NOT something to clamp: a clamped
 * sweep point records the weight it was ASKED for while measuring another, so
 * two cells of one sweep would carry the same number under different labels.
 */
const parseHybridWeight = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const weight = Number(value);
  if (weight >= HYBRID_WEIGHT_MIN && weight <= HYBRID_WEIGHT_MAX) return weight;
  throw new Error(
    `dp-gnosis-bench: ${HYBRID_WEIGHT_FLAG} expects a number from ${hybridRangeText}, ` +
      `got "${value}"`
  );
};

/**
 * `--hybrid-weight` on an adapter that fuses no legs REFUSES, exactly as
 * `--analyzer` does off `fts5`: it is a TREATMENT field, so the row would name a
 * leg weight nothing ever fused with.
 */
const checkHybridWeightAdapter = (
  adapter: AdapterName,
  weight: number | undefined
): number | undefined => {
  if (weight === undefined || HYBRID_ADAPTERS.includes(adapter)) return weight;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" fuses no legs, so ${HYBRID_WEIGHT_FLAG} ` +
      `"${String(weight)}" would be recorded as a treatment it never applied — ` +
      `use ${HYBRID_ADAPTERS.join(' or ')}`
  );
};

/** A weight that is not a number would be measured as `NaN` and recorded as a run. */
const parseRerankWeight = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const weight = Number(value);
  if (Number.isFinite(weight)) return weight;
  throw new Error(`dp-gnosis-bench: --rerank-weight expects a number, got "${value}"`);
};

/**
 * The fusion rule the NAME selects, resolved by the ENGINE — the bench must not
 * reimplement fusion, or the suite would stop measuring the shipped path. An
 * unknown name (or a weight override on a preset with no weight term) refuses
 * here, before a single dataset is touched, exactly as `--adapter` does: a
 * fallback would publish a number under the wrong protocol label.
 */
const parseRerankFusion = (profile: string, rerankWeight: number | undefined): RerankFusion => {
  try {
    return resolveRerankFusion(profile, { rerankWeight });
  } catch (error) {
    throw new Error(`dp-gnosis-bench: ${messageOf(error)}`);
  }
};

/**
 * A `--rerank-model` without `--rerank` REFUSES. Nothing would rerank, yet the
 * row would carry the model id as its treatment — a run recorded under a model
 * that never scored a single document, which is exactly what naming the model
 * exists to prevent.
 */
const parseRerankModel = (value: string | undefined, rerank: boolean): string | undefined => {
  if (value === undefined) return undefined;
  if (rerank) return value;
  throw new Error(
    `dp-gnosis-bench: --rerank-model "${value}" requires --rerank — ` +
      'without it nothing reranks and the row would name a model that never ran'
  );
};

const RERANK_POOL_FLAG = '--rerank-pool';

/** A pool of fewer than one document scores nothing; there is no smaller arm. */
const RERANK_POOL_MIN = 1;

/**
 * A fractional, zero or negative pool is a usage error, NOT something to clamp:
 * a clamped run records the pool it was ASKED for while scoring another, which
 * is the very divergence `rerankPool` was added to make visible.
 */
const parseRerankPoolSize = (value: string): number => {
  const pool = Number(value);
  if (Number.isInteger(pool) && pool >= RERANK_POOL_MIN) return pool;
  throw new Error(
    `dp-gnosis-bench: ${RERANK_POOL_FLAG} expects an integer of at least ` +
      `${RERANK_POOL_MIN}, got "${value}"`
  );
};

/**
 * A `--rerank-pool` without `--rerank` REFUSES, exactly as `--rerank-model`
 * does: nothing would rerank, yet the row would carry a pool label no
 * cross-encoder ever scored over.
 */
const parseRerankPool = (value: string | undefined, rerank: boolean): number | undefined => {
  if (value === undefined) return undefined;
  if (rerank) return parseRerankPoolSize(value);
  throw new Error(
    `dp-gnosis-bench: ${RERANK_POOL_FLAG} "${value}" requires --rerank — ` +
      'without it nothing reranks and the row would name a pool nothing scored'
  );
};

const BUDGET_FLAG = '--budget';
const SERVED_K_FLAG = '--served-k';

/** A budget of fewer than one token admits nothing; there is no smaller arm. */
const TOKEN_BUDGET_MIN = 1;

/** A served window of fewer than one atom presents nothing. */
const SERVED_K_MIN = 1;

const positiveIntegerError = (flag: string, minimum: number, value: string): Error =>
  new Error(
    `dp-gnosis-bench: ${flag} expects an integer of at least ${minimum}, got "${value}"`
  );

/**
 * A fractional, zero or negative budget is a usage error, NOT something to
 * clamp: a clamped run records the cap it was ASKED for while presenting under
 * another, and the presented set is not recoverable from the metrics afterwards.
 */
const parseTokenBudget = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const budget = Number(value);
  if (Number.isInteger(budget) && budget >= TOKEN_BUDGET_MIN) return budget;
  throw positiveIntegerError(BUDGET_FLAG, TOKEN_BUDGET_MIN, value);
};

const parseServedKSize = (value: string): number => {
  const servedK = Number(value);
  if (Number.isInteger(servedK) && servedK >= SERVED_K_MIN) return servedK;
  throw positiveIntegerError(SERVED_K_FLAG, SERVED_K_MIN, value);
};

/**
 * A `--served-k` without `--budget` REFUSES, exactly as `--rerank-pool` does
 * without `--rerank`: nothing would be capped, yet the row would carry a served
 * window no presentation ever applied.
 */
const parseServedK = (value: string | undefined, budget: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (budget !== undefined) return parseServedKSize(value);
  throw new Error(
    `dp-gnosis-bench: ${SERVED_K_FLAG} "${value}" requires ${BUDGET_FLAG} — ` +
      'without it nothing is capped and the row would name a window nothing applied'
  );
};

const RERANK_DOC_MAX_CHARS_FLAG = '--rerank-doc-max-chars';
const RERANK_EXTRACT_FLAG = '--rerank-extract';

/** A window of fewer than one character shows the reranker nothing. */
const RERANK_DOC_MAX_CHARS_MIN = 1;

/**
 * The extractions the bench may NAME. Deliberately a subset of the engine's
 * `ExtractStrategy`: `full` and `tail`/`maxfit` either ignore `maxChars` or have
 * never been measured, and a row stamping a width the extraction never applied
 * is the provenance failure both fields exist to prevent.
 */
const RERANK_EXTRACT_CHOICES: readonly ExtractStrategy[] = ['head', 'headtail'];

const isExtractChoice = (value: string): value is ExtractStrategy =>
  (RERANK_EXTRACT_CHOICES as readonly string[]).includes(value);

/**
 * A fractional, zero or negative width is a usage error, NOT something to clamp:
 * a clamped run records the window it was ASKED for while showing the reranker
 * another, and the scored text is unrecoverable from the metrics afterwards.
 */
const parseRerankDocMaxCharsSize = (value: string): number => {
  const width = Number(value);
  if (Number.isInteger(width) && width >= RERANK_DOC_MAX_CHARS_MIN) return width;
  throw positiveIntegerError(RERANK_DOC_MAX_CHARS_FLAG, RERANK_DOC_MAX_CHARS_MIN, value);
};

/**
 * A doc-window flag without `--rerank` REFUSES, exactly as `--rerank-pool` does:
 * nothing would rerank, yet the row would carry a width label no cross-encoder
 * ever read.
 */
const requireRerank = (flag: string, value: string, rerank: boolean): void => {
  if (rerank) return;
  throw new Error(
    `dp-gnosis-bench: ${flag} "${value}" requires --rerank — ` +
      'without it nothing reranks and the row would name a window nothing was shown'
  );
};

const parseRerankDocMaxChars = (
  value: string | undefined,
  rerank: boolean
): number | undefined => {
  if (value === undefined) return undefined;
  requireRerank(RERANK_DOC_MAX_CHARS_FLAG, value, rerank);
  return parseRerankDocMaxCharsSize(value);
};

/** An unknown extraction THROWS naming the valid ones, exactly as `--analyzer` does. */
const parseRerankExtract = (
  value: string | undefined,
  rerank: boolean
): ExtractStrategy | undefined => {
  if (value === undefined) return undefined;
  requireRerank(RERANK_EXTRACT_FLAG, value, rerank);
  if (isExtractChoice(value)) return value;
  throw new Error(
    `dp-gnosis-bench: unknown ${RERANK_EXTRACT_FLAG} "${value}" — ` +
      `use ${RERANK_EXTRACT_CHOICES.join(', ')}`
  );
};

/**
 * Every flag this CLI reads, the gate's included (`gate.ts` parses the same
 * argv). Declared ONCE, beside the parser that consumes it, and asserted
 * against its own call sites by `flags.test.ts` — a flag parsed but missing
 * here fails that test rather than drifting into a silent acceptance.
 */
export const RUN_FLAGS: FlagSpec = {
  value: [
    '--adapter',
    '--analyzer',
    '--depth',
    '--layer',
    '--only',
    '--rerank-model',
    '--rerank-profile',
    '--rerank-weight',
    BUDGET_FLAG,
    SERVED_K_FLAG,
    RERANK_POOL_FLAG,
    RERANK_DOC_MAX_CHARS_FLAG,
    RERANK_EXTRACT_FLAG,
    HYBRID_WEIGHT_FLAG,
    PRF_DOCS_FLAG,
    PRF_TERMS_FLAG,
    PRF_ALPHA_FLAG,
    ...GATE_VALUE_FLAGS,
  ],
  boolean: [
    '--compare',
    '--help',
    '--rerank',
    QUERY_ADJACENCY_FLAG,
    PRF_FLAG,
    INCLUDE_HISTORY_FLAG,
  ],
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  assertKnownFlags(argv, RUN_FLAGS);
  const rerankProfile = flagValue(argv, '--rerank-profile') ?? DEFAULT_RERANK_PRESET;
  const rerankWeight = parseRerankWeight(flagValue(argv, '--rerank-weight'));
  const adapter = parseAdapter(flagValue(argv, '--adapter'));
  const rerank = argv.includes('--rerank');
  const tokenBudget = parseTokenBudget(flagValue(argv, BUDGET_FLAG));
  const prf = checkPrfAdapter(adapter, argv.includes(PRF_FLAG));
  return {
    tokenBudget,
    servedK: parseServedK(flagValue(argv, SERVED_K_FLAG), tokenBudget),
    only: csv(flagValue(argv, '--only')),
    layer: parseLayer(flagValue(argv, '--layer')),
    depth: Number(flagValue(argv, '--depth') ?? DEFAULT_DEPTH),
    rerank,
    compare: argv.includes('--compare'),
    adapter,
    rerankProfile,
    rerankWeight,
    rerankModel: parseRerankModel(flagValue(argv, '--rerank-model'), rerank),
    rerankPool: parseRerankPool(flagValue(argv, RERANK_POOL_FLAG), rerank),
    rerankDocMaxChars: parseRerankDocMaxChars(
      flagValue(argv, RERANK_DOC_MAX_CHARS_FLAG),
      rerank
    ),
    rerankExtract: parseRerankExtract(flagValue(argv, RERANK_EXTRACT_FLAG), rerank),
    rerankFusion: parseRerankFusion(rerankProfile, rerankWeight),
    hybridWeight: checkHybridWeightAdapter(
      adapter,
      parseHybridWeight(flagValue(argv, HYBRID_WEIGHT_FLAG))
    ),
    analyzer: resolveAnalyzer(adapter, flagValue(argv, '--analyzer')),
    queryAdjacency: checkAdjacencyAdapter(adapter, argv.includes(QUERY_ADJACENCY_FLAG)),
    prf,
    prfDocs: parsePrfCount(PRF_DOCS_FLAG, flagValue(argv, PRF_DOCS_FLAG), prf),
    prfTerms: parsePrfCount(PRF_TERMS_FLAG, flagValue(argv, PRF_TERMS_FLAG), prf),
    prfAlpha: parsePrfAlpha(flagValue(argv, PRF_ALPHA_FLAG), prf),
    includeHistory: argv.includes(INCLUDE_HISTORY_FLAG),
  };
};

/**
 * Where a dataset's BEIR files are. `beir-local` points at a directory that
 * already exists; every other format is materialised into `data/<id>` by its
 * fetcher, so a missing directory names the fetcher that has to run first.
 */
export const datasetDir = (entry: DatasetEntry): string => {
  const dir =
    entry.format === 'beir-local' ? resolve(SUITE_ROOT, entry.source) : resolve(DATA_DIR, entry.id);
  if (existsSync(resolve(dir, CORPUS_FILE))) return dir;
  throw new Error(
    `dp-gnosis-bench: dataset "${entry.id}" has no ${CORPUS_FILE} at ${dir} — ` +
      `fetch it first (format "${entry.format}"), or disable the entry in datasets.json`
  );
};

/**
 * A `beir-local` entry carrying `derive` is built from the repo's own atoms and
 * golden set on EVERY run — the inputs are local files, so a cache could only
 * make the run measure a vault that has since changed. The unreachable-gold
 * count is printed BEFORE it is judged: it caps recall for the dataset, and a
 * ceiling that is not visible next to the number it bounds gets read as quality.
 * Above the declared floor the derivation then REFUSES (exit 3) instead of
 * letting the run score a corpus that has lost the documents it is judged on.
 */
const deriveVault = (entry: BeirDataset, includeHistory: boolean): void => {
  const derived = ensureVaultDataset(entry, SUITE_ROOT, includeHistory);
  process.stdout.write(`${describeDerivation(entry.id, derived)}\n`);
  assertGoldReachable(entry.id, derived);
};

/**
 * Fetch the dataset if its fetcher has not already put it on disk, then verify
 * the layout. `beir-local` points at a directory the repo already carries, so
 * there is nothing to fetch and a missing one is an error, not a download.
 */
export const ensureDataset = async (
  entry: DatasetEntry,
  includeHistory = false
): Promise<string> => {
  if (entry.format === 'bright') await ensureBrightDataset(entry, DATA_DIR);
  if (entry.format === 'beir-zip') await ensureBeirDataset(entry, DATA_DIR);
  if (entry.format === 'beir-local' && entry.derive !== undefined) {
    deriveVault(entry, includeHistory);
  }
  return datasetDir(entry);
};

/**
 * The atom cap the run ACTUALLY used. A silent manifest means the engine
 * default, and that number is recorded rather than `null`: two runs straddling
 * a change to `ATOM_MAX_CHARS` would otherwise both read `null`, and
 * `compare.ts` would report a delta across two different measuring scales.
 */
export const effectiveAtomMaxChars = (entry: DatasetEntry): number =>
  entry.atomMaxChars ?? ATOM_MAX_CHARS;

/** Only queries the dataset actually judged; an unjudged topic is not scorable. */
export const topicsOf = (
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): readonly Topic[] =>
  [...qrels.keys()]
    .map(id => ({ id, text: queries.get(id) ?? '' }))
    .filter(topic => topic.text.length > 0);

/** The gold set as `metrics.ts` reads it: judged docs above grade 0, order-free. */
const relevantIdsOf = (qrel: Qrel): readonly string[] =>
  [...qrel.entries()]
    .filter(([, grade]) => grade > 0)
    .map(([docId]) => docId)
    .sort();

/**
 * A topic's identity UNDER THE RETRIEVAL ACTUALLY PERFORMED. The bench applies no
 * topic filter, so an authored `domain`/`type` filter is invisible here — only the
 * query text and the gold set can tell two topics apart.
 */
const topicSignature = (text: string, qrel: Qrel): string =>
  JSON.stringify([text.trim(), relevantIdsOf(qrel)]);

const bySignature = (
  topics: readonly Topic[],
  qrels: ReadonlyMap<string, Qrel>
): ReadonlyMap<string, readonly string[]> =>
  topics.reduce((groups, topic) => {
    const key = topicSignature(topic.text, qrels.get(topic.id) ?? new Map());
    return groups.set(key, [...(groups.get(key) ?? []), topic.id]);
  }, new Map<string, readonly string[]>());

const byFirstId = (a: readonly string[], b: readonly string[]): number =>
  (a[0] ?? '') < (b[0] ?? '') ? -1 : 1;

/**
 * Topic ids that are INDISTINGUISHABLE to this bench — same trimmed query text and
 * same gold set — in groups of two or more. Each group is one topic the macro
 * averages count once per member. Empty when every topic is distinct.
 */
export const collapsingTopicGroups = (
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): readonly (readonly string[])[] =>
  [...bySignature(topicsOf(queries, qrels), qrels).values()]
    .filter(ids => ids.length > 1)
    .map(ids => [...ids].sort())
    .sort(byFirstId);

/** Prefix of the collapsing-topics warning — a WARNING, not a refusal. */
export const COLLAPSING_TOPICS_WARNING = 'dp-gnosis-bench/collapsing-topics';

const collapsingMessage = (
  datasetId: string,
  groups: readonly (readonly string[])[]
): string =>
  `${COLLAPSING_TOPICS_WARNING}: ${datasetId} has ${groups.length} topic group(s) that this ` +
  `bench cannot tell apart — identical query text and identical gold set, and no topic filter ` +
  `is applied at retrieval: ${groups.map(ids => ids.join(' + ')).join(', ')}. ` +
  `Every member beyond the first is double-counted in every macro-average of this run.\n`;

/**
 * Warns, and lets the run proceed: the collapsing pair in the vault golden set is
 * deliberately authored, so refusing would block every `vault` run.
 */
export const warnCollapsingTopics = (
  datasetId: string,
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): void => {
  const groups = collapsingTopicGroups(queries, qrels);
  if (groups.length > 0) process.stderr.write(collapsingMessage(datasetId, groups));
};

/**
 * The CLI's `k_init` handling, which `engine.ts` leaves to its caller. An
 * EXPLICIT `pool` wins outright — it is the measurement's own scale, and the
 * engine constant is a serving default the instrument must be able to step
 * outside of. Absent, the shipped formula is unchanged to the byte.
 */
export const firstPassDepth = (depth: number, rerank: boolean, pool?: number): number =>
  pool ?? (rerank ? Math.max(depth, RERANK_K_INIT) : depth);

/** The ONE resolution of the first pass, so ranking and provenance cannot diverge. */
export const rerankPoolOf = (options: CliOptions): number =>
  firstPassDepth(options.depth, options.rerank, options.rerankPool);

/** Prefix of the pool-below-depth warning — a WARNING, not a refusal. */
export const RERANK_POOL_BELOW_DEPTH_WARNING = 'dp-gnosis-bench/rerank-pool-below-depth';

const poolBelowDepthMessage = (pool: number, depth: number): string =>
  `${RERANK_POOL_BELOW_DEPTH_WARNING}: the reranker scored a pool of ${pool} while the run ` +
  `asks for depth ${depth}. Every metric whose cut is above ${pool} is CAPPED by the pool — ` +
  `R@${depth} from a pool of ${pool} is R@${pool} under another name.\n`;

/**
 * Warns, and lets the run proceed: a pool below the depth is exactly what a
 * small-pool rerank arm IS, so refusing would block the measurement the flag
 * exists for. Silent truncation is the part that would not be legitimate.
 */
export const warnRerankPoolBelowDepth = (options: CliOptions): void => {
  const pool = rerankPoolOf(options);
  if (options.rerank && pool < options.depth) {
    process.stderr.write(poolBelowDepthMessage(pool, options.depth));
  }
};

/**
 * One dataset's query-time context. `excluded` is per QUERY, because BRIGHT
 * ships per-query exclusions and scoring a document the dataset told us to drop
 * makes the number wrong in both directions (`score.ts`).
 */
export interface RankContext {
  readonly port: KnowledgePort;
  readonly options: CliOptions;
  readonly excluded: ReadonlyMap<string, readonly string[]>;
}

/** The window the budget is charged over: the named one, else the whole presentation. */
export const servedKOf = (options: CliOptions): number => options.servedK ?? options.depth;

/**
 * WHAT the reranker was actually shown — the named window, else the engine's
 * shipped default. Resolved ONCE and read by both the scoring path and the
 * provenance stamp, so the row can never name a width the reranker never read.
 */
export const rerankDocMaxCharsOf = (options: CliOptions): number =>
  options.rerankDocMaxChars ?? RERANK_DOC_MAX_CHARS;

/**
 * The EFFECTIVE fusion weight — read off the RESOLVED fusion, so it is the
 * `--rerank-weight` override when one was given and the preset's own shipped
 * weight otherwise. Stamping the raw flag instead left every default run's row
 * blank, and `compare.ts` reads a blank as the LEGACY weight: once the shipped
 * weight moved, two rows fused at DIFFERENT weights both read blank and were
 * subtracted as a like-for-like delta. A `replace` protocol has no weight term,
 * so it records none.
 */
export const rerankWeightOf = (options: CliOptions): number | undefined =>
  options.rerankFusion.kind === 'rrf' ? options.rerankFusion.rerankWeight : undefined;

export const rerankExtractOf = (options: CliOptions): ExtractStrategy =>
  options.rerankExtract ?? EXTRACT_STRATEGY;

/**
 * The RM3 model the run ACTUALLY expanded with — each knob the named one, else
 * the engine's shipped `DEFAULT_PRF_PARAMS`. Resolved ONCE and read by both the
 * retrieval path and the provenance stamp, so a row can never name a model the
 * query was not rescored by. `undefined` without `--prf`: the port then receives
 * no option at all and the call is what every recorded run made, byte for byte.
 */
export const prfParamsOf = (options: CliOptions): PrfParams | undefined =>
  options.prf
    ? {
        fbDocs: options.prfDocs ?? DEFAULT_PRF_PARAMS.fbDocs,
        fbTerms: options.prfTerms ?? DEFAULT_PRF_PARAMS.fbTerms,
        alpha: options.prfAlpha ?? DEFAULT_PRF_PARAMS.alpha,
      }
    : undefined;

/**
 * The PRESENTED atoms — what a consumer would actually receive.
 *
 * `fitToTokenBudget` is the CLI's presentation cap and is IMPORTED, never
 * restated, so the arm measures the shipped admission rule (skip-and-continue,
 * not prefix truncation). It sits HERE rather than in `engine.ts:retrieveDocs`
 * on purpose: `retrieveDocs` runs BEFORE `rerankIfRequested`, so capping there
 * would truncate the RERANKER'S CANDIDATE POOL and record a presentation cap as
 * a pool cap — the provenance confusion `rerankPool` exists to prevent.
 *
 * No budget means no cap: the slice is exactly what every recorded row was
 * measured under, to the byte.
 */
const servedAtoms = (
  options: CliOptions,
  ordered: readonly RetrievedAtom[]
): readonly RetrievedAtom[] => {
  if (options.tokenBudget === undefined) return ordered.slice(0, options.depth);
  return fitToTokenBudget(ordered.slice(0, servedKOf(options)), options.tokenBudget).kept;
};

/**
 * The document ranking AND the atom-level spread the rollup dedupes away, both
 * read off the SAME served list and the same exclusions — measured once, so the
 * two can never describe different atoms.
 */
interface TopicRanking {
  readonly ranking: readonly string[];
  readonly spread: AtomSpread;
}

const rankTopic = async (context: RankContext, topic: Topic): Promise<TopicRanking> => {
  const { options } = context;
  const depth = rerankPoolOf(options);
  const atoms = await retrieveDocs(
    context.port,
    topic.text,
    depth,
    options.queryAdjacency,
    prfParamsOf(options)
  );
  const ordered = await rerankIfRequested(topic.text, atoms, options.rerank, {
    fusion: options.rerankFusion,
    model: options.rerankModel,
    rerankDocMaxChars: rerankDocMaxCharsOf(options),
    rerankExtract: rerankExtractOf(options),
  });
  const served = servedAtoms(options, ordered);
  const excluded = context.excluded.get(topic.id) ?? [];
  return { ranking: toDocumentRanking(served, excluded), spread: atomSpread(served, excluded) };
};

/** One topic's ranking and the wall time the retrieve+rerank+rollup path took. */
interface TimedTopic {
  readonly id: string;
  readonly ranking: readonly string[];
  readonly spread: AtomSpread;
  readonly ms: number;
}

const timeTopic = async (context: RankContext, topic: Topic): Promise<TimedTopic> => {
  const startedAt = Date.now();
  const { ranking, spread } = await rankTopic(context, topic);
  return { id: topic.id, ranking, spread, ms: Date.now() - startedAt };
};

/** Sequential by design: one port, one index, one CPU-bound query at a time. */
const rankAllTopics = async (
  context: RankContext,
  topics: readonly Topic[]
): Promise<readonly TimedTopic[]> =>
  topics.reduce<Promise<readonly TimedTopic[]>>(
    async (pending, topic) => [...(await pending), await timeTopic(context, topic)],
    Promise.resolve([])
  );

/**
 * Nearest-rank percentile over the timings, sorted ascending. No timing means
 * no query ran, which is reported as 0 rather than `NaN`.
 */
export const percentileMs = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] ?? 0;
};

const P50 = 0.5;
const P95 = 0.95;

/** The query phase: rankings by topic, total wall time, and its distribution. */
export interface QueryOutcome {
  readonly rankings: ReadonlyMap<string, readonly string[]>;
  /** Per-topic presentation diversity — scored alongside, never into, the metrics. */
  readonly spread: ReadonlyMap<string, AtomSpread>;
  readonly queryMs: number;
  readonly queryP50Ms: number;
  readonly queryP95Ms: number;
}

/**
 * Exported so `sweep.ts` measures its grid points through the SAME query path a
 * recorded run uses — a second loop there would be a second measurement.
 */
export const queryDataset = async (
  context: RankContext,
  topics: readonly Topic[]
): Promise<QueryOutcome> => {
  const startedAt = Date.now();
  const timed = await rankAllTopics(context, topics);
  const perQueryMs = timed.map(entry => entry.ms);
  return {
    rankings: new Map(timed.map(entry => [entry.id, entry.ranking])),
    spread: new Map(timed.map(entry => [entry.id, entry.spread])),
    queryMs: Date.now() - startedAt,
    queryP50Ms: percentileMs(perQueryMs, P50),
    queryP95Ms: percentileMs(perQueryMs, P95),
  };
};

/** Who the dataset is: its manifest descriptors plus the corpus checksum. */
const descriptorOf = (
  entry: DatasetEntry,
  dir: string
): Pick<
  DatasetResult,
  'dataset' | 'domain' | 'docShape' | 'queryShape' | 'corpusBytes' | 'corpusLines' | 'atomMaxChars'
> => ({
  dataset: entry.id,
  domain: entry.domain,
  docShape: entry.docShape,
  queryShape: entry.queryShape,
  ...corpusChecksum(resolve(dir, CORPUS_FILE)),
  atomMaxChars: effectiveAtomMaxChars(entry),
});

/**
 * What the run measured. `rankings` is carried through to the TREC run file and
 * NOWHERE else — `report.ts` keeps it out of the JSON summary, which stays the
 * one-row-per-dataset record it has always been.
 */
const measurementsOf = (
  queried: QueryOutcome,
  scored: DatasetScore,
  facets: ReadonlyMap<string, TopicFacets>
): Pick<
  DatasetResult,
  | 'queryMs'
  | 'queryP50Ms'
  | 'queryP95Ms'
  | 'metrics'
  | 'metricsSd'
  | 'rPrecisionTopics'
  | 'perTopic'
  | 'perAxisDescriptive'
  | 'rankings'
> => {
  const perTopic = withTopicFacets(scored.perTopic, facets);
  const strata = perAxisStrata(perTopic);
  return {
    queryMs: queried.queryMs,
    queryP50Ms: queried.queryP50Ms,
    queryP95Ms: queried.queryP95Ms,
    metrics: scored.mean,
    metricsSd: scored.sd,
    rPrecisionTopics: scored.rPrecisionTopics,
    perTopic,
    // A dataset with no authored axis records no key at all — never an empty list.
    ...(strata.length === 0 ? {} : { perAxisDescriptive: strata }),
    rankings: queried.rankings,
  };
};

/** The treatments that decide what gets BUILT, as opposed to how it is queried. */
export interface PrepareArm {
  readonly adapter: AdapterName;
  /** Absent means the engine default — the chain `sweep.ts` and every legacy run used. */
  readonly analyzer?: AnalyzerId | undefined;
}

/**
 * A dataset the bench PROJECTS from the repo's own atoms plus a hand-authored
 * golden set (`fetch/vault.ts`). Only such a dataset has a golden set the suite
 * owns; every BEIR and BRIGHT entry ships its judgments with its corpus and is
 * ingested exactly as it always was.
 */
export const isDerivedDataset = (entry: DatasetEntry): boolean =>
  entry.format !== 'bright' && entry.derive !== undefined;

/** A judged pair — grade 0 is a JUDGED non-relevant document and names no gold. */
const isRelevant = (graded: readonly [string, number]): boolean => graded[1] > 0;

const relevantIds = (qrels: ReadonlyMap<string, Qrel>): readonly string[] => [
  ...new Set([...qrels.values()].flatMap(graded => [...graded].filter(isRelevant).map(pair => pair[0]))),
];

/**
 * The gold the INGEST is told about, taken from the qrels the run SCORES —
 * never from the golden JSON a second time, so the two can never disagree. The
 * exact-body dedupe keeps one copy of a mirrored document, and gold-blind it
 * kept the unjudged mirror on 8 `vault` topics, which lost their `recall@100`
 * outright (GNOSIS-BENCH § Known harness gaps).
 *
 * `undefined` for every dataset the bench does not derive: their dedupe stays
 * gold-blind and their rows stay byte-comparable with every one recorded.
 */
export const goldIdsOf = (
  entry: DatasetEntry,
  qrels: ReadonlyMap<string, Qrel>
): readonly string[] | undefined => (isDerivedDataset(entry) ? relevantIds(qrels) : undefined);

/**
 * What one dataset's preparation needs: where its BEIR layout is, the arm whose
 * index gets built, and — for a derived dataset only — the ids its judgments
 * name, so the ingest dedupe keeps the copy the run can credit.
 */
export interface PrepareRequest {
  readonly entry: DatasetEntry;
  readonly dir: string;
  readonly arm: PrepareArm;
  readonly goldIds?: readonly string[] | undefined;
}

/**
 * The arm is passed DOWN, not assumed: `prepareDataset` builds the index that
 * arm reads, so an adapter can never be measured over an index another adapter
 * built, nor an analyzer over an index another chain stamped. `sweep.ts` passes
 * its own fixed `linear`.
 */
export const prepareOf = (request: PrepareRequest): Promise<PreparedDataset> =>
  prepareDataset({
    id: request.entry.id,
    docs: readCorpus(request.dir),
    workRoot: WORK_ROOT,
    atomMaxChars: request.entry.atomMaxChars,
    adapter: request.arm.adapter,
    analyzer: request.arm.analyzer,
    ...(request.goldIds === undefined ? {} : { goldIds: request.goldIds }),
  });

/**
 * The post-open gate, then the measured loop, under ONE port lifetime. The probe
 * is inside the `finally` because a refusal must still close the port: the
 * previous form wrapped `queryDataset` alone, so anything failing before it
 * leaked the handle.
 */
const probeThenQuery = async (
  context: RankContext,
  datasetId: string,
  topics: readonly Topic[]
): Promise<QueryOutcome> => {
  const { port, options } = context;
  try {
    await probePortSoundness({
      port,
      datasetId,
      adapter: options.adapter,
      topicTexts: topics.map(topic => topic.text),
    });
    return await queryDataset(context, topics);
  } finally {
    port.close?.();
  }
};

/** The scorable topics, after warning about any this bench cannot tell apart. */
const topicsFor = (
  dir: string,
  datasetId: string,
  qrels: ReadonlyMap<string, Qrel>
): readonly Topic[] => {
  const queries = readQueries(dir);
  warnCollapsingTopics(datasetId, queries, qrels);
  return topicsOf(queries, qrels);
};

const runDataset = async (entry: DatasetEntry, options: CliOptions): Promise<DatasetResult> => {
  const dir = await ensureDataset(entry, options.includeHistory);
  const qrels = readQrels(dir, entry.format === 'bright' ? 'test' : entry.qrels);
  const topics = topicsFor(dir, entry.id, qrels);
  const prepared = await prepareOf({
    entry,
    dir,
    arm: { adapter: options.adapter, analyzer: options.analyzer },
    goldIds: goldIdsOf(entry, qrels),
  });
  // Before the dataset's FIRST rerank call, and before the port exists — a
  // refusal here has nothing to close. It doubles as the cold-load warm-up.
  if (options.rerank) await assertRerankDiscriminates({ model: options.rerankModel });
  const port = openPort(prepared, {
    adapter: options.adapter,
    hybridWeight: options.hybridWeight,
  });
  const context = { port, options, excluded: readExcluded(dir) };
  const queried = await probeThenQuery(context, entry.id, topics);
  return {
    ...descriptorOf(entry, dir),
    topics: topics.length,
    docCount: prepared.docCount,
    atomCount: prepared.atomCount,
    ingestMs: prepared.ingestMs,
    ...measurementsOf(
      queried,
      scoreDataset(queried.rankings, qrels, options.depth, queried.spread),
      readQueryFacets(dir)
    ),
  };
};

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

/** A cutoff this run's depth never reached prints as absent, never as a score. */
const optionalMetric = (value: number | undefined): string =>
  value === undefined ? '—' : metric(value);

const summaryLine = (result: DatasetResult): string =>
  `${result.dataset}: nDCG@10 ${metric(result.metrics.ndcg10)}  ` +
  `R@10 ${optionalMetric(result.metrics.recall10)}  ` +
  `R@100 ${optionalMetric(result.metrics.recall100)}  ` +
  `MRR@10 ${metric(result.metrics.mrr10)}  ` +
  `(${result.topics} topics, ${result.atomCount} atoms, ${result.ingestMs}ms ingest, ` +
  `${result.queryMs}ms query)`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The two halves of one dataset's turn, injected so the loop below can be driven
 * with a failing dataset in a test — the property it guards (an earlier dataset
 * is already on disk when a later one dies) is unobservable from a whole-suite
 * call, which is precisely how it went unnoticed until an OOM cost 67.5 minutes
 * of measurement.
 */
export interface DatasetRun {
  readonly measure: (entry: DatasetEntry) => Promise<DatasetResult>;
  readonly record: (result: DatasetResult) => void;
}

/**
 * Recording happens INSIDE the try: a dataset that measured but could not be
 * written down has not been recorded, and the run's contract counts recorded
 * datasets, not measured ones.
 */
const attempt = async (
  entry: DatasetEntry,
  run: DatasetRun
): Promise<DatasetResult | undefined> => {
  try {
    const result = await run.measure(entry);
    process.stdout.write(`${summaryLine(result)}\n`);
    run.record(result);
    return result;
  } catch (error) {
    if (isRefusal(error)) throw error;
    process.stderr.write(`${entry.id}: FAILED — ${messageOf(error)}\n`);
    return undefined;
  }
};

const isResult = (value: DatasetResult | undefined): value is DatasetResult => value !== undefined;

/**
 * Each dataset is recorded the moment it finishes, BEFORE the next one starts.
 * Buffering to the end made "a partial run must never look complete" true only
 * for a dataset failure: a process death (OOM, 2026-08-15, six datasets in) lost
 * every completed dataset because not one row had been written.
 */
export const measureAndRecordAll = async (
  entries: readonly DatasetEntry[],
  run: DatasetRun
): Promise<readonly DatasetResult[]> =>
  (
    await entries.reduce<Promise<readonly (DatasetResult | undefined)[]>>(
      async (pending, entry) => [...(await pending), await attempt(entry, run)],
      Promise.resolve([])
    )
  ).filter(isResult);

/** What the flags resolved to, the ids they could not resolve, and how they were asked. */
export interface Selection {
  readonly entries: readonly DatasetEntry[];
  readonly unknown: readonly string[];
  /** The flags that produced it, so an EMPTY selection can name what emptied it. */
  readonly criteria?: string | undefined;
}

/** `--layer` narrows the pool the ids are then matched against — an intersection. */
const poolOf = (
  all: readonly DatasetEntry[],
  layer: LayerName | undefined
): readonly DatasetEntry[] => (layer === undefined ? all : datasetsInLayer(all, layer));

/**
 * A bare run measures the DEFAULT suite; a named layer is an explicit request,
 * so it measures its whole membership, `enabled` or not — the same rule `--only`
 * follows.
 */
const withoutIds = (
  pool: readonly DatasetEntry[],
  layer: LayerName | undefined
): readonly DatasetEntry[] => (layer === undefined ? enabledDatasets(pool) : pool);

/** Named so an empty intersection reports the flags, never a bare "nothing". */
const criteriaOf = (only: readonly string[], layer: LayerName | undefined): string | undefined => {
  const parts = [
    ...(layer === undefined ? [] : [`--layer ${layer}`]),
    ...(only.length === 0 ? [] : [`--only ${only.join(',')}`]),
  ];
  return parts.length === 0 ? undefined : parts.join(' with ');
};

/**
 * `enabled` means "member of the DEFAULT suite", not "runnable". So `--only`
 * selects across the WHOLE manifest: an explicit id is a direct request, and the
 * arm datasets are disabled precisely so they do not change what a bare run
 * measures. Filtering the enabled set first made `--only <disabled-or-typo>`
 * measure nothing and say nothing.
 *
 * `--layer` composes with it as an INTERSECTION: an id outside the layer is a
 * known id that this run does not measure, so it is not "unknown" — it empties
 * the selection instead, and `selectionError` refuses the run by name.
 */
export const selectDatasets = (
  all: readonly DatasetEntry[],
  only: readonly string[],
  layer?: LayerName | undefined
): Selection => {
  const pool = poolOf(all, layer);
  const known = new Set(all.map(entry => entry.id));
  return {
    entries: only.length === 0 ? withoutIds(pool, layer) : pool.filter(e => only.includes(e.id)),
    unknown: only.filter(id => !known.has(id)),
    criteria: criteriaOf(only, layer),
  };
};

/**
 * Why the run cannot start, or `undefined`. A selection that measures nothing
 * MUST NOT exit 0 — the suite's contract is that a partial run never looks
 * complete, and measuring zero datasets is the emptiest partial run there is.
 * An empty `--layer`/`--only` intersection lands here too, naming both flags:
 * every id was known, so the "unknown id" message would be a lie.
 */
export const selectionError = (selection: Selection): string | undefined => {
  if (selection.unknown.length > 0) {
    return `dp-gnosis-bench: unknown dataset id(s): ${selection.unknown.join(', ')}`;
  }
  if (selection.entries.length > 0) return undefined;
  const asked = selection.criteria === undefined ? '' : ` by ${selection.criteria}`;
  return `dp-gnosis-bench: no datasets selected${asked} — nothing was measured`;
};

/**
 * The rerank protocol is recorded ONLY on a rerank run: a row that reranked
 * nothing has no protocol, and stamping the default on it would make every new
 * BM25 row differ from every legacy one on a treatment field it never used.
 *
 * The MODEL is resolved before it is recorded, never left `undefined` on a run
 * that reranked: the id that scored the documents is not recoverable from the
 * numbers afterwards, and two model arms with no id on the row read as one
 * treatment.
 *
 * The CONSUMER cap follows the same rule: `tokenBudget` and `servedK` are
 * stamped only on a run that asked for a budget, so every recorded row stays
 * byte-identical on both. `embedModel` is stamped only where an encoder ran —
 * a dense route — exactly as `rerankDocMaxChars` is stamped only where a
 * reranker ran.
 *
 * Exported so a test can read the TREATMENT a flag set records without paying
 * for a measured run — the value is unrecoverable from the numbers, so what it
 * stamps is the property worth asserting.
 */
/** The RESOLVED term model, stamped only where an expansion actually ran. */
type PrfProvenance = Pick<RunProvenance, 'prf' | 'prfDocs' | 'prfTerms' | 'prfAlpha'>;

const prfProvenance = (options: CliOptions): PrfProvenance => {
  const params = prfParamsOf(options);
  return {
    prf: options.prf,
    prfDocs: params?.fbDocs,
    prfTerms: params?.fbTerms,
    prfAlpha: params?.alpha,
  };
};

export const provenanceOf = (options: CliOptions, gitSha: string): RunProvenance => ({
  ts: new Date().toISOString(),
  gitSha,
  adapter: options.adapter,
  depth: options.depth,
  rerank: options.rerank,
  rerankProfile: options.rerank ? options.rerankProfile : undefined,
  rerankWeight: options.rerank ? rerankWeightOf(options) : undefined,
  rerankModel: options.rerank ? (options.rerankModel ?? RERANK_MODEL_ID) : undefined,
  rerankPool: options.rerank ? rerankPoolOf(options) : undefined,
  rerankDocMaxChars: options.rerank ? rerankDocMaxCharsOf(options) : undefined,
  rerankExtract: options.rerank ? rerankExtractOf(options) : undefined,
  tokenBudget: options.tokenBudget,
  servedK: options.tokenBudget === undefined ? undefined : servedKOf(options),
  embedModel: denseRouteOf(options.adapter) === undefined ? undefined : EMBED_MODEL_ID,
  hybridWeight: options.hybridWeight,
  analyzer: options.analyzer,
  queryAdjacency: options.queryAdjacency,
  ...prfProvenance(options),
  typeFilter: typeFilterOf(options.includeHistory),
});

/** The headline; the other three metrics are read off the delta line above it. */
const SIGNIFICANCE_METRIC: MetricName = 'ndcg10';

/** An arm comparison says so on its OWN line — a p-value read alone must not mislead. */
const armPrefix = (result: Significance): string =>
  result.kind === 'verdict' && result.arms !== undefined ? 'ARM COMPARISON — ' : '';

/**
 * The paired permutation p and bootstrap interval for the pair just compared,
 * from `significance.ts` — the same statistic the sweep rates its cells with.
 * A comparison that produced no delta (refused, or too little history) gets no
 * line: there is nothing to rate.
 */
const significanceLines = (comparison: Comparison): readonly string[] => {
  if (comparison.kind !== 'delta' && comparison.kind !== 'arm-delta') return [];
  const result = pairedSignificance({
    resultsDir: RESULTS_DIR,
    previous: comparison.previous,
    latest: comparison.latest,
    metric: SIGNIFICANCE_METRIC,
  });
  return [`  nDCG@10: ${armPrefix(result)}${significanceLabel(result)}`];
};

const comparisonLines = (comparison: Comparison): readonly string[] => [
  formatComparison(comparison),
  ...significanceLines(comparison),
];

const printComparison = (): void => {
  const history = readHistory(resolve(RESULTS_DIR, HISTORY_FILE));
  process.stdout.write('\n-- compare (last two runs per dataset) --\n');
  process.stdout.write(`${compareAll(history).flatMap(comparisonLines).join('\n')}\n`);
};

/**
 * The whole-run view, over exactly the datasets that ran. It adds no record —
 * every one of them was already written down as it finished.
 */
const summarize = (provenance: RunProvenance, results: readonly DatasetResult[]): void => {
  const written = writeRunSummary({ resultsDir: RESULTS_DIR, provenance, results });
  process.stdout.write(`\nwrote ${written.markdownPath}\n`);
};

/** Every selected dataset ran and was recorded, or the run failed. */
const exitCode = (recorded: number, selectedCount: number): number =>
  recorded === selectedCount ? 0 : FAILURE_EXIT_CODE;

/**
 * The provenance is stamped ONCE, before the first dataset: it names the
 * per-dataset artefact paths and the summary stem alike, so a suite that
 * completes leaves a summary whose stem matches the rows it describes.
 */
const runSelection = async (
  entries: readonly DatasetEntry[],
  options: CliOptions,
  gitSha: string
): Promise<number> => {
  const provenance = provenanceOf(options, gitSha);
  const results = await measureAndRecordAll(entries, {
    measure: entry => runDataset(entry, options),
    record: result => {
      recordDataset({ resultsDir: RESULTS_DIR, provenance, result });
    },
  });
  if (results.length > 0) summarize(provenance, results);
  if (options.compare) printComparison();
  return exitCode(results.length, entries.length);
};

/**
 * The flags themselves are documented ONCE, in the README — restating them here
 * would create a second owner that rots. What `--help` owns is the exit-code
 * contract (CLAUDE.md § Script Exit-Code Contract), which no other surface
 * states in full.
 */
export const RUN_HELP = [
  'dp-gnosis-bench — the retrieval benchmark.',
  '',
  'usage: ./bench.sh [flags]   (npm run gnosis:bench -- [flags] from the repo root)',
  '',
  'flags: tools/dp-gnosis-bench/README.md § Run it — the single owner of the flag table.',
  '',
  'regression gate:',
  `  --baseline <perTopicPath substring>  the reference run, resolved PER DATASET`,
  `  --fail-under <delta>                 the tolerated drop in nDCG@10`,
  '  Given together or not at all. The gate rates the POINT ESTIMATE, prints the',
  '  p-value and CI beside it, and a pairing it cannot make is a FAILURE, not a pass.',
  '',
  'exit codes:',
  '  0  every selected dataset ran and was recorded',
  '  1  at least one dataset failed (the rest are still recorded)',
  `  ${REFUSAL_EXIT_CODE}  a dataset was REFUSED — its golden set names documents the corpus cannot reach`,
  `  ${GATE_EXIT_CODE}  the regression gate failed — a drop past --fail-under, or a pair it could not compare`,
  '',
].join('\n');

const GATE_HEADER = '\n-- regression gate (nDCG@10) --\n';

/**
 * The gate was ASKED for and did not run. It SAYS so: a run that exits non-zero
 * having printed nothing about a gate the operator requested reads as "the gate
 * passed", which is the § Landmines shape — a component produced nothing and the
 * reader recorded it as data. The code is NOT changed: exit 1 says a dataset did
 * not measure, and that is the more basic failure.
 */
const reportGateSkipped = (code: number): void => {
  process.stdout.write(
    `${GATE_HEADER}NOT RUN — the run exited ${code}: at least one dataset failed, so the ` +
      'recorded set is partial and pairing it would compare an incomplete run against the baseline.\n'
  );
};

const runGate = (gate: GateOptions, entries: readonly DatasetEntry[]): number => {
  const report = gateReport({
    resultsDir: RESULTS_DIR,
    history: readHistory(resolve(RESULTS_DIR, HISTORY_FILE)),
    datasets: entries.map(entry => entry.id),
    options: gate,
  });
  process.stdout.write(`${GATE_HEADER}${report.lines.join('\n')}\n`);
  return report.exitCode;
};

/**
 * The gate's verdict, or the run's own code. No gate asked for means SILENCE —
 * the flags absent leave the run byte-identical to one before they existed.
 */
export const applyGate = (
  gate: GateOptions | undefined,
  entries: readonly DatasetEntry[],
  code: number
): number => {
  if (gate === undefined) return code;
  if (code === 0) return runGate(gate, entries);
  reportGateSkipped(code);
  return code;
};

/**
 * A refusal reaches here UNRECORDED — nothing measured, nothing to compare —
 * so it becomes the exit code rather than a failed dataset's exit 1.
 */
const runOrRefuse = async (
  entries: readonly DatasetEntry[],
  options: CliOptions,
  gitSha: string
): Promise<number> => {
  try {
    return await runSelection(entries, options, gitSha);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    process.stderr.write(`${messageOf(error)}\n`);
    return REFUSAL_EXIT_CODE;
  }
};

export const main = async (argv: readonly string[], gitSha: string): Promise<number> => {
  if (argv.includes('--help')) {
    process.stdout.write(RUN_HELP);
    return 0;
  }
  const options = parseArgs(argv);
  const gate = parseGateArgs(argv);
  warnRerankPoolBelowDepth(options);
  const selection = selectDatasets(loadManifest(MANIFEST_PATH), options.only, options.layer);
  const problem = selectionError(selection);
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    return FAILURE_EXIT_CODE;
  }
  return applyGate(gate, selection.entries, await runOrRefuse(selection.entries, options, gitSha));
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), currentGitSha(SUITE_ROOT));
}
