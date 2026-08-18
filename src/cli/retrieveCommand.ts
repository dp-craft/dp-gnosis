/**
 * `retrieve` — rank atoms for a query through the selected adapter.
 *
 * `mode` and `indexState` are REPORTED, never hidden. `indexState` is the only
 * thing that separates "searched a populated corpus and nothing matched" from
 * "no index exists, so nothing was searched"; collapsing the two lets a caller
 * read an empty result as evidence about the corpus when it is evidence about
 * the index.
 */
import { relative } from 'node:path';

import type { SkippedAtom } from '../budget.js';
import { fitToTokenBudget } from '../budget.js';
import type { AtomType } from '../config.js';
import {
  ATOM_TYPES,
  RERANK_K_INIT,
  RETRIEVE_TOKEN_BUDGET
} from '../config.js';
import type { RetrievalResult, RetrievedAtom, RetrieveOptions } from '../port.js';
import { rephraseQuery } from '../rephrase.js';
import type { RerankFusionOverrides, RerankOptions } from '../rerank.js';
import { rerankAtoms, rerankProbeRefusal, resolveRerankFusion } from '../rerank.js';
import type { AdapterName } from './adapter.js';
import { createPort, hasPersistentIndex } from './adapter.js';
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import { escapeXml, xmlAttribute } from './xml.js';

const DEFAULT_K = 5;
const SCORE_DIGITS = 4;

const NO_QUERY =
  'retrieve requires a query — pass it as a positional argument, e.g. `retrieve "zustand selector" -k 5`';

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

/** The type filter belongs to `retrieve` alone; `cli.ts` refuses it elsewhere. */
export const TYPE_FLAG = '--type';

/** The budget override, `retrieve` only; `cli.ts` refuses it elsewhere. */
export const MAX_TOKENS_FLAG = '--max-tokens';

/**
 * The reranker, `retrieve` only and OPT-IN: without it the ranking is exactly
 * what it was before the reranker existed. `cli.ts` refuses it elsewhere.
 */
export const RERANK_FLAG = '--rerank';

/**
 * The query rewriter, `retrieve` only and OPT-IN: without it the query reaches
 * the adapter exactly as typed. `cli.ts` refuses it elsewhere.
 *
 * The plan's `rewriteRules[]` output — the model reporting WHICH of the six
 * rules it applied — is deliberately NOT implemented: a model's own account of
 * its reasoning is unverifiable, so it would be prose presented as provenance.
 * What IS reported is the rewritten query itself, which the reader can check.
 */
export const REPHRASE_FLAG = '--rephrase';

/**
 * The three tuning flags for that pass. Each one is inert without
 * {@link RERANK_FLAG} — nothing would rerank, yet the run would carry the label
 * — so each REFUSES on its own rather than being ignored, the same rule the
 * bench's `--rerank-model` follows.
 */
export const RERANK_MODEL_FLAG = '--rerank-model';

export const RERANK_PROFILE_FLAG = '--rerank-profile';

export const RERANK_WEIGHT_FLAG = '--rerank-weight';

const RERANK_TUNING_FLAGS: readonly string[] = [
  RERANK_MODEL_FLAG,
  RERANK_PROFILE_FLAG,
  RERANK_WEIGHT_FLAG,
];

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

/** The offending token as the caller typed it, for a message that quotes it. */
const rawFlag = (flags: FlagValues, name: string): string => stringFlag(flags, name) ?? '';

/**
 * A value outside the closed vocabulary is a REFUSAL, never a silently dropped
 * filter: a caller who mistyped `--type adrs` would otherwise read an unfiltered
 * ranking as a filtered one. The message names the offending value AND the whole
 * vocabulary, so the correction needs no second call.
 */
const typeError = (offender: string): string =>
  `${TYPE_FLAG} value "${offender}" is outside the closed vocabulary — replace it with one of ${ATOM_TYPES.join(' | ')}; pass several as \`${TYPE_FLAG} adr,review\``;

const splitTypes = (raw: string): readonly string[] => raw.split(',').map(part => part.trim());

const asType = (value: string): AtomType | undefined => ATOM_TYPES.find(type => type === value);

type TypesResult =
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
 * `unavailable` means nothing was searched, so an agent reading a zero count as
 * evidence about the corpus would be reading it about a corpus that is not
 * there. It is reported as the EXISTING partial code with a message naming the
 * correction, never as success and never as a usage fault — the call was
 * well-formed, the corpus simply has not been built yet.
 */
const NO_CORPUS =
  'retrieve: nothing was searched — no corpus exists at the atoms directory; build it first with `gnosis ingest <path...>`';

/**
 * An index-backed adapter has a SECOND way to reach `unavailable`: the corpus is
 * ingested but never indexed. The note names that build command verbatim, so an
 * agent-driven caller can run the correction without a second lookup — an
 * ingest-only remedy would send it to rebuild a corpus that is already there.
 */
const indexRemedy = (adapter: AdapterName): string =>
  `; if the corpus is already ingested, build the index with \`npm run gnosis -- index --adapter ${adapter}\``;

const noCorpusNote = (adapter: AdapterName): string =>
  hasPersistentIndex(adapter) ? `${NO_CORPUS}${indexRemedy(adapter)}` : NO_CORPUS;

const isUnavailable = (result: RetrievalResult): boolean => result.indexState === 'unavailable';

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
 */
const exitCodeFor = (request: RetrieveRequest, result: RetrievalResult): number =>
  isUnavailable(result) || refusalsOf(request).length > 0 ? EXIT_PARTIAL : EXIT_OK;

const formatScore = (score: number): string => score.toFixed(SCORE_DIGITS);

const atomLine = (atom: RetrievedAtom): string =>
  `  ${formatScore(atom.score)}  ${atom.id}  [${atom.domain}]  ${atom.title}`;

/**
 * One line per ORIGIN document, under the atom it belongs to. A list rather than
 * one joined value: the origins are separate documents, and an atom naming none
 * emits no line at all instead of a blank one.
 */
const originLine = (origin: string): string => `    origin  ${origin}`;

const atomLines = (atom: RetrievedAtom): readonly string[] => [
  atomLine(atom),
  ...atom.originPaths.map(originLine),
];

/**
 * The budget outcome as the renderings see it: `result.atoms` is already the
 * KEPT set, and `skipped` is what the caller must still be told about.
 */
interface BudgetedResult {
  readonly result: RetrievalResult;
  readonly skipped: readonly SkippedAtom[];
  readonly maxTokens: number;
}

/**
 * The warning that goes back to the LLM. An atom over budget is SKIPPED, never
 * truncated and never silently dropped, so the message states both remedies:
 * raise the budget, or read the named source file directly.
 */
const budgetWarning = (budgeted: BudgetedResult): string =>
  `retrieve: ${budgeted.skipped.length} atom(s) did not fit the ${budgeted.maxTokens}-token budget and were skipped — raise it with \`${MAX_TOKENS_FLAG} <n>\` or read the source files named below`;

const hasSkips = (budgeted: BudgetedResult): boolean => budgeted.skipped.length > 0;

const skippedLine = (skipped: SkippedAtom): string =>
  `  skipped  ${skipped.id}  ~${skipped.estimatedTokens} tokens  ${skipped.sourcePath}`;

const skipText = (budgeted: BudgetedResult): readonly string[] =>
  hasSkips(budgeted) ? [budgetWarning(budgeted), ...budgeted.skipped.map(skippedLine)] : [];

/**
 * The rewrite is stated in FULL, both sides: the ranking is evidence about the
 * rewritten query, and a reader who cannot see what was actually searched
 * cannot judge the results.
 */
const rephraseLines = (request: RetrieveRequest): readonly string[] => {
  const rewritten = request.queryRewritten;
  if (rewritten !== undefined) return [`retrieve: rephrased "${request.query}" -> "${rewritten}"`];
  return request.rephraseRefusal === undefined ? [] : [request.rephraseRefusal];
};

/** The rerank refusal reads as its own line; the atoms below it are first-pass. */
const rerankLines = (request: RetrieveRequest): readonly string[] =>
  request.rerankRefusal === undefined ? [] : [request.rerankRefusal];

const retrieveText = (request: RetrieveRequest, budgeted: BudgetedResult): string => {
  const { result } = budgeted;
  return [
    `retrieve: mode ${result.mode}, indexState ${result.indexState}, atoms ${result.atoms.length}`,
    ...rephraseLines(request),
    ...rerankLines(request),
    ...(isUnavailable(result) ? [noCorpusNote(request.context.adapter)] : []),
    ...result.atoms.flatMap(atomLines),
    ...skipText(budgeted),
  ].join('\n');
};

type ArgsResult =
  | {
    readonly ok: true;
    readonly k: number;
    readonly maxTokens: number;
    readonly types: readonly AtomType[] | undefined;
    readonly rerank: boolean;
    readonly rerankOptions: RerankOptions;
    readonly rephrase: boolean;
  }
  | { readonly ok: false; readonly error: string };

/** The value flags that carry no refusal of their own, once each has parsed. */
interface ResolvedValues {
  readonly k: number;
  readonly maxTokens: number;
  readonly types: readonly AtomType[] | undefined;
}

const okArgs = (
  flags: FlagValues,
  values: ResolvedValues,
  rerankOptions: RerankOptions
): ArgsResult => ({
  ok: true,
  ...values,
  rerank: flags[RERANK_FLAG] === true,
  rerankOptions,
  rephrase: flags[REPHRASE_FLAG] === true,
});

const withRerankArgs = (flags: FlagValues, values: ResolvedValues): ArgsResult => {
  const options = resolveRerankOptions(flags, flags[RERANK_FLAG] === true);
  return options.ok
    ? okArgs(flags, values, options.options)
    : { ok: false, error: options.error };
};

/** Every value flag, resolved together so the command states one refusal path. */
const resolveArgs = (flags: FlagValues): ArgsResult => {
  const k = resolveK(flags);
  const maxTokens = resolveMaxTokens(flags);
  const types = resolveTypes(flags);
  if (k === undefined) return { ok: false, error: kError(rawFlag(flags, '-k')) };
  if (maxTokens === undefined) {
    return { ok: false, error: maxTokensError(rawFlag(flags, MAX_TOKENS_FLAG)) };
  }
  if (!types.ok) return { ok: false, error: types.error };
  return withRerankArgs(flags, { k, maxTokens, types: types.types });
};

interface RetrieveRequest {
  readonly context: CommandContext;
  readonly query: string;
  readonly k: number;
  readonly maxTokens: number;
  /** `undefined` = unfiltered. Never an empty list — the port refuses that. */
  readonly types: readonly AtomType[] | undefined;
  readonly rerank: boolean;
  /** The reranker's model and fusion rule as the tuning flags resolved them. */
  readonly rerankOptions: RerankOptions;
  readonly rephrase: boolean;
  /** The rewrite `--rephrase` produced; `undefined` when it was off or refused. */
  readonly queryRewritten: string | undefined;
  /** The rewriter's refusal, carried into the note and the PARTIAL exit code. */
  readonly rephraseRefusal: string | undefined;
  /** The reranker's refusal, carried the same way. `undefined` when it ranked. */
  readonly rerankRefusal: string | undefined;
}

/**
 * The text the SEARCH runs on — the rewrite when there is one, the raw query
 * otherwise. One helper, because the port and the reranker MUST see the same
 * string: a reranker scoring the raw query against a rewritten first pass would
 * fuse two orders produced for two different questions.
 */
const effectiveQuery = (request: RetrieveRequest): string =>
  request.queryRewritten ?? request.query;

/**
 * One `note` key carries whichever refusal happened, so a caller reads a single
 * field instead of two. A skip and an absent corpus cannot co-occur: nothing was
 * retrieved to budget in the second case.
 */
const noteField = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, string>> => {
  const refusals = refusalsOf(request);
  if (refusals.length > 0) return { note: refusals.join('\n') };
  if (hasSkips(budgeted)) return { note: budgetWarning(budgeted) };
  return isUnavailable(budgeted.result)
    ? { note: noCorpusNote(request.context.adapter) }
    : {};
};

/** Omitted entirely when no rewrite happened, so an unrephrased payload is unchanged. */
const rewrittenField = (request: RetrieveRequest): Readonly<Record<string, string>> =>
  request.queryRewritten === undefined ? {} : { queryRewritten: request.queryRewritten };

/** The `--json` payload. Its key set is adapter-independent by construction. */
const payload = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, unknown>> => ({
  command: 'retrieve',
  adapter: request.context.adapter,
  query: request.query,
  ...rewrittenField(request),
  k: request.k,
  mode: budgeted.result.mode,
  indexState: budgeted.result.indexState,
  count: budgeted.result.atoms.length,
  atoms: budgeted.result.atoms,
  skipped: budgeted.skipped,
  ...noteField(request, budgeted),
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

const rootAttributes = (request: RetrieveRequest, result: RetrievalResult): string =>
  [
    xmlAttribute('query', request.query),
    ...rewrittenAttribute(request),
    xmlAttribute('adapter', request.context.adapter),
    xmlAttribute('mode', result.mode),
    xmlAttribute('indexState', result.indexState),
    xmlAttribute('count', String(result.atoms.length)),
  ].join(' ');

/**
 * An `unavailable` run emits the SAME empty block plus a `<note>`, so a consumer
 * separates "searched, found nothing" (`count="0"`, no note) from "no search
 * happened" (`indexState="unavailable"` + note) without parsing prose.
 */
/**
 * A skipped atom is an EMPTY element beside the documents: it has no content to
 * carry, only the identity, the source to load it from and the size that made it
 * not fit. The `<note>` states what to do about it in prose.
 */
const skippedXml = (skipped: SkippedAtom, repoRoot: string): string =>
  `  <skipped ${xmlAttribute('id', skipped.id)} ${xmlAttribute('source', relative(repoRoot, skipped.sourcePath))} ${xmlAttribute('estimatedTokens', String(skipped.estimatedTokens))}/>`;

const skipXml = (budgeted: BudgetedResult, repoRoot: string): readonly string[] =>
  hasSkips(budgeted)
    ? [
        `  <note>${escapeXml(budgetWarning(budgeted))}</note>`,
        ...budgeted.skipped.map(skipped => skippedXml(skipped, repoRoot)),
      ]
    : [];

const retrieveXml = (request: RetrieveRequest, budgeted: BudgetedResult): string =>
  [
    `<retrieved_context ${rootAttributes(request, budgeted.result)}>`,
    ...(isUnavailable(budgeted.result)
      ? [`  <note>${escapeXml(noCorpusNote(request.context.adapter))}</note>`]
      : []),
    ...skipXml(budgeted, request.context.repoRoot),
    ...budgeted.result.atoms.map(atom => documentXml(atom, request.context.repoRoot)),
    '</retrieved_context>',
  ].join('\n');

/**
 * The reranker reorders a POOL, so the first pass must fetch one: `k` alone
 * would hand it the very ranking it exists to change. A caller asking for more
 * than the measured depth keeps its own `k` — never fewer candidates than
 * results.
 */
const firstPassK = (request: RetrieveRequest): number =>
  request.rerank ? Math.max(request.k, RERANK_K_INIT) : request.k;

const retrieveOptions = (request: RetrieveRequest): RetrieveOptions => {
  const k = firstPassK(request);
  return request.types === undefined ? { k } : { k, types: request.types };
};

/** The ranking to render, plus the reranker's refusal when there was one. */
interface RankedOutcome {
  readonly result: RetrievalResult;
  readonly refusal: string | undefined;
}

/** The requested depth out of the deeper pool `firstPassK` asked the port for. */
const trimmed = (result: RetrievalResult, k: number): RetrievalResult => ({
  ...result,
  atoms: result.atoms.slice(0, k),
});

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
  if (!request.rerank) return { result, refusal: undefined };
  const unusable = await rerankProbeRefusal(request.rerankOptions);
  if (unusable !== undefined) return { result: trimmed(result, request.k), refusal: unusable };
  const reranked = await rerankAtoms(effectiveQuery(request), result.atoms, request.rerankOptions);
  if (!reranked.ok) return { result: trimmed(result, request.k), refusal: reranked.error };
  const atoms = reranked.atoms.slice(0, request.k);
  return { result: { ...result, atoms, mode: `${result.mode}+rerank` }, refusal: undefined };
};

/**
 * The budget is applied HERE, between the port and the renderings: the adapters
 * rank, the CLI decides what fits the caller's window, and both halves of that
 * decision — kept and skipped — reach every rendering.
 */
const applyBudget = (result: RetrievalResult, maxTokens: number): BudgetedResult => {
  const fit = fitToTokenBudget(result.atoms, maxTokens);
  return { result: { ...result, atoms: fit.kept }, skipped: fit.skipped, maxTokens };
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

const search = async (request: RetrieveRequest): Promise<CommandOutcome> => {
  const { context } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath);
  const result = await port.retrieve(effectiveQuery(request), retrieveOptions(request));
  port.close?.();
  const ranked = await rankedResult(request, result);
  const reported: RetrieveRequest = { ...request, rerankRefusal: ranked.refusal };
  const budgeted = applyBudget(ranked.result, request.maxTokens);
  return {
    exitCode: exitCodeFor(reported, ranked.result),
    data: payload(reported, budgeted),
    text: retrieveText(reported, budgeted),
    xml: retrieveXml(reported, budgeted),
  };
};

type ResolvedArgs = Extract<ArgsResult, { readonly ok: true }>;

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
  types: args.types,
  rerank: args.rerank,
  rerankOptions: args.rerankOptions,
  rephrase: args.rephrase,
  queryRewritten: undefined,
  rephraseRefusal: undefined,
  rerankRefusal: undefined,
});

export const runRetrieveCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const query = context.positionals.join(' ');
  const args = resolveArgs(context.flags);
  if (query.length === 0) return usageError(NO_QUERY);
  if (!args.ok) return usageError(args.error);
  return await search(await withRewrite(initialRequest(context, query, args)));
};
