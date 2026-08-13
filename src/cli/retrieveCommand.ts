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

import type { AtomType } from '../config.js';
import { ATOM_TYPES } from '../config.js';
import type { RetrievalResult, RetrievedAtom, RetrieveOptions } from '../port.js';
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

const retrieveText = (result: RetrievalResult): string =>
  [
    `retrieve: mode ${result.mode}, indexState ${result.indexState}, atoms ${result.atoms.length}`,
    ...(isUnavailable(result) ? [NO_CORPUS] : []),
    ...result.atoms.map(atomLine),
  ].join('\n');

type ArgsResult =
  | { readonly ok: true; readonly k: number; readonly types: readonly AtomType[] | undefined }
  | { readonly ok: false; readonly error: string };

/** Both value flags, resolved together so the command states one refusal path. */
const resolveArgs = (flags: FlagValues): ArgsResult => {
  const k = resolveK(flags);
  const types = resolveTypes(flags);
  if (k === undefined) return { ok: false, error: kError(stringFlag(flags, '-k') ?? '') };
  return types.ok ? { ok: true, k, types: types.types } : { ok: false, error: types.error };
};

interface RetrieveRequest {
  readonly context: CommandContext;
  readonly query: string;
  readonly k: number;
  /** `undefined` = unfiltered. Never an empty list — the port refuses that. */
  readonly types: readonly AtomType[] | undefined;
}

/** The `--json` payload. Its key set is adapter-independent by construction. */
const payload = (
  request: RetrieveRequest,
  result: RetrievalResult
): Readonly<Record<string, unknown>> => ({
  command: 'retrieve',
  adapter: request.context.adapter,
  query: request.query,
  k: request.k,
  mode: result.mode,
  indexState: result.indexState,
  count: result.atoms.length,
  atoms: result.atoms,
  ...(isUnavailable(result) ? { note: NO_CORPUS } : {}),
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
 */
const documentXml = (atom: RetrievedAtom, repoRoot: string): string =>
  [
    `  <document ${xmlAttribute('id', atom.id)} ${xmlAttribute('score', formatScore(atom.score))} ${xmlAttribute('domain', atom.domain)}>`,
    '    <metadata>',
    `      <source>${escapeXml(relative(repoRoot, atom.sourcePath))}</source>`,
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
const retrieveXml = (request: RetrieveRequest, result: RetrievalResult): string =>
  [
    `<retrieved_context ${rootAttributes(request, result)}>`,
    ...(isUnavailable(result) ? [`  <note>${escapeXml(NO_CORPUS)}</note>`] : []),
    ...result.atoms.map(atom => documentXml(atom, request.context.repoRoot)),
    '</retrieved_context>',
  ].join('\n');

const retrieveOptions = (request: RetrieveRequest): RetrieveOptions =>
  request.types === undefined ? { k: request.k } : { k: request.k, types: request.types };

const search = async (request: RetrieveRequest): Promise<CommandOutcome> => {
  const { context, query } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath);
  const result = await port.retrieve(query, retrieveOptions(request));
  port.close?.();
  return {
    exitCode: exitCodeFor(result),
    data: payload(request, result),
    text: retrieveText(result),
    xml: retrieveXml(request, result),
  };
};

export const runRetrieveCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const query = context.positionals.join(' ');
  const args = resolveArgs(context.flags);
  if (query.length === 0) return usageError(NO_QUERY);
  if (!args.ok) return usageError(args.error);
  return await search({ context, query, k: args.k, types: args.types });
};
