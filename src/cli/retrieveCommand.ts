/**
 * `retrieve` — rank atoms for a query through the selected adapter.
 *
 * `mode` and `indexState` are REPORTED, never hidden. `indexState` is the only
 * thing that separates "searched a populated corpus and nothing matched" from
 * "no index exists, so nothing was searched"; collapsing the two lets a caller
 * read an empty result as evidence about the corpus when it is evidence about
 * the index.
 */
import type { RetrievalResult, RetrievedAtom } from '../port.js';
import { createPort } from './adapter.js';
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

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

const atomLine = (atom: RetrievedAtom): string =>
  `  ${atom.score.toFixed(SCORE_DIGITS)}  ${atom.id}  [${atom.domain}]  ${atom.title}`;

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

const search = async (request: RetrieveRequest): Promise<CommandOutcome> => {
  const { context, query, k } = request;
  const port = createPort(context.adapter, context.atomsDir, context.indexPath);
  const result = await port.retrieve(query, { k });
  return {
    exitCode: exitCodeFor(result),
    data: payload(request, result),
    text: retrieveText(result),
  };
};

export const runRetrieveCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const query = context.positionals.join(' ');
  const k = resolveK(context.flags);
  if (query.length === 0) return usageError(NO_QUERY);
  if (k === undefined) return usageError(kError(stringFlag(context.flags, '-k') ?? ''));
  return await search({ context, query, k });
};
