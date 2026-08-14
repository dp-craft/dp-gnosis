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
import { ATOM_TYPES, RERANK_K_INIT, RETRIEVE_TOKEN_BUDGET } from '../config.js';
import type { RetrievalResult, RetrievedAtom, RetrieveOptions } from '../port.js';
import { rerankAtoms } from '../rerank.js';
import { createPort } from './adapter.js';
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

const isUnavailable = (result: RetrievalResult): boolean => result.indexState === 'unavailable';

const exitCodeFor = (result: RetrievalResult): number =>
  isUnavailable(result) ? EXIT_PARTIAL : EXIT_OK;

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

const retrieveText = (budgeted: BudgetedResult): string => {
  const { result } = budgeted;
  return [
    `retrieve: mode ${result.mode}, indexState ${result.indexState}, atoms ${result.atoms.length}`,
    ...(isUnavailable(result) ? [NO_CORPUS] : []),
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
  }
  | { readonly ok: false; readonly error: string };

/** Every value flag, resolved together so the command states one refusal path. */
const resolveArgs = (flags: FlagValues): ArgsResult => {
  const k = resolveK(flags);
  const maxTokens = resolveMaxTokens(flags);
  const types = resolveTypes(flags);
  if (k === undefined) return { ok: false, error: kError(rawFlag(flags, '-k')) };
  if (maxTokens === undefined) {
    return { ok: false, error: maxTokensError(rawFlag(flags, MAX_TOKENS_FLAG)) };
  }
  return types.ok
    ? { ok: true, k, maxTokens, types: types.types, rerank: flags[RERANK_FLAG] === true }
    : { ok: false, error: types.error };
};

interface RetrieveRequest {
  readonly context: CommandContext;
  readonly query: string;
  readonly k: number;
  readonly maxTokens: number;
  /** `undefined` = unfiltered. Never an empty list — the port refuses that. */
  readonly types: readonly AtomType[] | undefined;
  readonly rerank: boolean;
}

/**
 * One `note` key carries whichever refusal happened, so a caller reads a single
 * field instead of two. A skip and an absent corpus cannot co-occur: nothing was
 * retrieved to budget in the second case.
 */
const noteField = (budgeted: BudgetedResult): Readonly<Record<string, string>> => {
  if (hasSkips(budgeted)) return { note: budgetWarning(budgeted) };
  return isUnavailable(budgeted.result) ? { note: NO_CORPUS } : {};
};

/** The `--json` payload. Its key set is adapter-independent by construction. */
const payload = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, unknown>> => ({
  command: 'retrieve',
  adapter: request.context.adapter,
  query: request.query,
  k: request.k,
  mode: budgeted.result.mode,
  indexState: budgeted.result.indexState,
  count: budgeted.result.atoms.length,
  atoms: budgeted.result.atoms,
  skipped: budgeted.skipped,
  ...noteField(budgeted),
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

const rootAttributes = (request: RetrieveRequest, result: RetrievalResult): string =>
  [
    xmlAttribute('query', request.query),
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
    ...(isUnavailable(budgeted.result) ? [`  <note>${escapeXml(NO_CORPUS)}</note>`] : []),
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

type RankedResult =
  | { readonly ok: true; readonly result: RetrievalResult }
  | { readonly ok: false; readonly error: string };

/**
 * The reranked-and-fused ranking, or the refusal that explains why there is
 * none. A failure MUST NOT degrade to the first-pass ranking: `--rerank` is a
 * quality claim, and a silent fallback would make it a false one. `mode` names
 * the extra leg so a caller reads which ranking it got.
 */
const rankedResult = async (
  request: RetrieveRequest,
  result: RetrievalResult
): Promise<RankedResult> => {
  if (!request.rerank) return { ok: true, result };
  const reranked = await rerankAtoms(request.query, result.atoms);
  if (!reranked.ok) return reranked;
  const atoms = reranked.atoms.slice(0, request.k);
  return { ok: true, result: { ...result, atoms, mode: `${result.mode}+rerank` } };
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

const search = async (request: RetrieveRequest): Promise<CommandOutcome> => {
  const { context, query } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath);
  const result = await port.retrieve(query, retrieveOptions(request));
  port.close?.();
  const ranked = await rankedResult(request, result);
  if (!ranked.ok) return usageError(ranked.error);
  const budgeted = applyBudget(ranked.result, request.maxTokens);
  return {
    exitCode: exitCodeFor(ranked.result),
    data: payload(request, budgeted),
    text: retrieveText(budgeted),
    xml: retrieveXml(request, budgeted),
  };
};

export const runRetrieveCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const query = context.positionals.join(' ');
  const args = resolveArgs(context.flags);
  if (query.length === 0) return usageError(NO_QUERY);
  if (!args.ok) return usageError(args.error);
  return await search({
    context,
    query,
    k: args.k,
    maxTokens: args.maxTokens,
    types: args.types,
    rerank: args.rerank,
  });
};
