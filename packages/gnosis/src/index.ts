/**
 * The library entry point: the same engine the `gnosis` binary runs, callable
 * in-process.
 *
 * `search` is NOT a second retrieval path. It renders the request as the argv
 * of `ask --json` and hands it to {@link runCli}, then reads the payload
 * that command already produced — exactly as `src/mcp/protocol.ts` reads the
 * pack out of `runCli`'s own stdout rather than re-rendering it. A parallel
 * implementation would drift the first time either side changed, and the drift
 * would be invisible: both would still return a plausible answer.
 */
import type { GnosisAnswer, GnosisRequest } from './api.js';
import { runCli } from './cli/cli.js';

export type {
  GnosisAnswer,
  GnosisAtom,
  GnosisExitCode,
  GnosisRequest,
  GnosisSkippedAtom
} from './api.js';
export type { CliResult } from './cli/cli.js';
export { runCli } from './cli/cli.js';

/** An ABSENT field states nothing; it MUST NOT become a flag carrying a default. */
const valueFlag = (name: string, value: string | undefined): readonly string[] =>
  value === undefined ? [] : [name, value];

const numberFlag = (name: string, value: number | undefined): readonly string[] =>
  valueFlag(name, value === undefined ? undefined : String(value));

/** A LIST arrives as the CLI spells it: one flag, comma-joined. */
const listFlag = (name: string, values: readonly string[] | undefined): readonly string[] =>
  values === undefined || values.length === 0 ? [] : [name, values.join(',')];

/** `false` is an omission, never `--no-x`: the CLI's own default is the off state. */
const booleanFlag = (name: string, on: boolean | undefined): readonly string[] =>
  on === true ? [name] : [];

/**
 * The ONE argv a request ever runs. Exported so a caller — and the test — can
 * see the exact command that will execute rather than infer it.
 */
export const searchArgv = (request: GnosisRequest): readonly string[] => [
  'ask',
  request.query,
  '--json',
  ...numberFlag('-k', request.k),
  ...valueFlag('--adapter', request.adapter),
  ...listFlag('--type', request.types),
  ...listFlag('--domain', request.domains),
  ...numberFlag('--max-tokens', request.maxTokens),
  ...valueFlag('--budget-mode', request.budgetMode),
  ...numberFlag('--min-relevance', request.minRelevance),
  ...numberFlag('--max-per-doc', request.maxPerDoc),
  ...booleanFlag('--rerank', request.rerank),
  ...booleanFlag('--rephrase', request.rephrase),
  ...booleanFlag('--synthesize', request.synthesize),
];

/** Narrowing only — a non-object payload reads as no fields, never as a cast to `any`. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const parsePayload = (stdout: string): Readonly<Record<string, unknown>> => {
  try {
    return asRecord(JSON.parse(stdout));
  } catch {
    return {};
  }
};

const refusalOf = (payload: Readonly<Record<string, unknown>>): string => {
  const stated = payload['error'] ?? payload['note'];
  return typeof stated === 'string' ? stated : 'its --json payload carries no pack';
};

/**
 * A refused run MUST NOT read as an empty answer: `pack` present and a string
 * is exactly the slice that says a pack was rendered, and its absence throws
 * with the CLI's own words rather than a half-filled object.
 */
const asAnswer = (
  payload: Readonly<Record<string, unknown>>,
  stderr: string
): GnosisAnswer => {
  if (typeof payload['pack'] === 'string') return payload as GnosisAnswer;
  throw new Error(`gnosis: ${refusalOf(payload)}${stderr === '' ? '' : ` — ${stderr.trim()}`}`);
};

/**
 * Retrieve one citable knowledge pack, byte-identical to what
 * `gnosis ask --json` writes for the same request. A PARTIAL run (exit 3 —
 * a refused rerank, an over-budget atom) still delivers its pack, and states
 * what was refused on `note`.
 */
export const search = async (request: GnosisRequest): Promise<GnosisAnswer> => {
  const result = await runCli(searchArgv(request));
  return asAnswer(parsePayload(result.stdout), result.stderr);
};
