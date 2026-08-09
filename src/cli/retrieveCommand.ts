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

import type { RetrievalResult, RetrievedAtom } from '../port.js';
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

interface RetrieveRequest {
  readonly context: CommandContext;
  readonly query: string;
  readonly k: number;
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

const search = async (request: RetrieveRequest): Promise<CommandOutcome> => {
  const { context, query, k } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath);
  const result = await port.retrieve(query, { k });
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
  const k = resolveK(context.flags);
  if (query.length === 0) return usageError(NO_QUERY);
  if (k === undefined) return usageError(kError(stringFlag(context.flags, '-k') ?? ''));
  return await search({ context, query, k });
};
