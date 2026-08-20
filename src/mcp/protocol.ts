/**
 * The MCP protocol, as a PURE function of one parsed request.
 *
 * No stdin, no stdout, no process: `server.ts` owns the framing and this file
 * owns the meaning, so every rule below is provable by direct call. The answer
 * runner is INJECTED for the same reason — a test drives the handshake, the
 * tool list and every error code without a corpus on disk.
 *
 * The MCP SDK is deliberately NOT a dependency (`@modelcontextprotocol/sdk`
 * resolves from the repo root and MUST NOT be reached for): this surface is
 * three small files over node builtins, and the protocol constants below are
 * MIRRORED from it rather than imported.
 */
import type { CliResult } from '../cli/cli.js';
import { EXIT_PARTIAL, EXIT_USAGE } from '../cli/outcome.js';

/**
 * Read off the installed `node_modules/@modelcontextprotocol/sdk` **1.27.1** on
 * 2026-08-20 (`dist/esm/types.js`: `LATEST_PROTOCOL_VERSION`). The SDK is not a
 * dependency, so this is a mirrored value, not an imported one — re-read it
 * there before changing it, never from memory.
 */
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

/**
 * Mirrored from the same file and version (`SUPPORTED_PROTOCOL_VERSIONS`). The
 * handshake echoes a client's requested version only when it appears HERE;
 * anything else is answered with {@link DEFAULT_PROTOCOL_VERSION}, because
 * agreeing to a version this server does not implement is the silent failure.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  DEFAULT_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** Mirrors `package.json` `name` / `version`; asserted against it by the tests. */
export const SERVER_NAME = 'dp-gnosis';
export const SERVER_VERSION = '0.1.0';

/** The one tool. A second one would be a second contract to keep in step. */
export const TOOL_NAME = 'gnosis_answer';

/** What a caller may state. `k` absent means "whatever the CLI's default is". */
export interface AnswerInput {
  readonly question: string;
  readonly k?: number;
  readonly domain?: string;
}

/** The injected seam: one call, one `answer --json` invocation, one pack. */
export type AnswerRunner = (input: AnswerInput) => Promise<CliResult>;

/**
 * The ONE argv the tool ever runs. `-k` is OMITTED when the caller states no
 * `k` — inventing a second default here would let the MCP surface and the CLI
 * answer the same question with different depths.
 */
export const answerArgv = (input: AnswerInput): readonly string[] => [
  'answer',
  input.question,
  ...(input.k === undefined ? [] : ['-k', String(input.k)]),
  '--json',
  ...(input.domain === undefined ? [] : ['--domain', input.domain]),
];

/** JSON-RPC 2.0 ids are a string, a number, or null on a parse failure. */
type RpcId = string | number | null;

interface RpcError {
  readonly code: number;
  readonly message: string;
}

export interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: RpcId;
  readonly result?: unknown;
  readonly error?: RpcError;
}

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** A handler either produced a result or named a JSON-RPC failure. */
type Reply = { readonly result: unknown } | { readonly error: RpcError };

/** Narrowing only — never a cast to `any`; a non-object reads as no fields. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const stringField = (
  source: Readonly<Record<string, unknown>>,
  key: string
): string | undefined => {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
};

const numberField = (
  source: Readonly<Record<string, unknown>>,
  key: string
): number | undefined => {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
};

const requestedVersion = (params: unknown): string => {
  const raw = stringField(asRecord(params), 'protocolVersion');
  return raw !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(raw)
    ? raw
    : DEFAULT_PROTOCOL_VERSION;
};

const initializeResult = (params: unknown): Reply => ({
  result: {
    protocolVersion: requestedVersion(params),
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  },
});

/**
 * The tool's declared surface. The descriptions state what the pack IS and that
 * `domain` is checked against the LOADED profile's vocabulary, because a client
 * model picks arguments from this text alone and a rejected domain costs a
 * whole round trip.
 */
const TOOL_DESCRIPTOR = {
  name: TOOL_NAME,
  description:
    'Answer a question from the dp-gnosis vault. Returns one citable knowledge pack: a delimited block of the retrieved atom bodies, each carrying a [^atom-id] footnote that resolves inside the same block. Byte-identical to the CLI `answer --json` pack.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The question, in the words it would be searched with. Keywords retrieve better than a full sentence.',
      },
      k: {
        type: 'integer',
        description:
          'How many atoms to retrieve. Omit it to take the CLI default — this surface states no default of its own.',
      },
      domain: {
        type: 'string',
        description:
          'Restrict retrieval to one knowledge domain. Validated against the LOADED profile\'s domain vocabulary; an unknown value is refused rather than ignored.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;

const toolsResult = (): Reply => ({ result: { tools: [TOOL_DESCRIPTOR] } });

const unknownToolError = (name: string | undefined): RpcError => ({
  code: INVALID_PARAMS,
  message: `unknown tool "${String(name)}" — this server exposes exactly one: ${TOOL_NAME}`,
});

const missingQuestionError = (): RpcError => ({
  code: INVALID_PARAMS,
  message: `${TOOL_NAME} requires a "question" string argument`,
});

const content = (text: string, isError: boolean): unknown => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const parsePayload = (stdout: string): Readonly<Record<string, unknown>> => {
  try {
    return asRecord(JSON.parse(stdout));
  } catch {
    return {};
  }
};

/**
 * A PARTIAL run is a real pack with something refused — a skipped over-budget
 * atom, a refused rerank. The note is appended so the caller can see WHAT was
 * refused; `isError` stays unset, because flagging it would discard a good
 * answer over a partial one.
 */
const packText = (
  pack: string,
  exitCode: number,
  note: string | undefined
): string =>
  exitCode === EXIT_PARTIAL && note !== undefined ? `${pack}\n\n${note}` : pack;

/** A usage failure MUST NOT read as an empty answer, so it names the refusal. */
const failureText = (
  payload: Readonly<Record<string, unknown>>,
  stdout: string
): string => stringField(payload, 'error') ?? stringField(payload, 'note') ?? stdout;

/**
 * The exit code IS the contract and is mirrored, never flattened: 0 and 3 both
 * deliver the pack, 2 — or any payload carrying no pack at all — is an error.
 * The pack is READ OUT of the `--json` payload and never re-rendered here.
 */
const toolResult = (result: CliResult): unknown => {
  const payload = parsePayload(result.stdout);
  const pack = stringField(payload, 'pack');
  return pack === undefined || result.exitCode === EXIT_USAGE
    ? content(failureText(payload, result.stdout), true)
    : content(packText(pack, result.exitCode, stringField(payload, 'note')), false);
};

/**
 * An ABSENT argument stays absent — under `exactOptionalPropertyTypes` an
 * explicit `undefined` is a different thing from an omission, and it is the
 * omission that makes {@link answerArgv} leave the flag off entirely.
 */
const answerInput = (
  args: Readonly<Record<string, unknown>>,
  question: string
): AnswerInput => {
  const k = numberField(args, 'k');
  const domain = stringField(args, 'domain');
  return {
    question,
    ...(k === undefined ? {} : { k }),
    ...(domain === undefined ? {} : { domain }),
  };
};

const callResult = async (params: unknown, run: AnswerRunner): Promise<Reply> => {
  const request = asRecord(params);
  const name = stringField(request, 'name');
  if (name !== TOOL_NAME) return { error: unknownToolError(name) };
  const args = asRecord(request['arguments']);
  const question = stringField(args, 'question');
  if (question === undefined) return { error: missingQuestionError() };
  return { result: toolResult(await run(answerInput(args, question))) };
};

type MethodHandler = (params: unknown, run: AnswerRunner) => Promise<Reply>;

const METHODS: Readonly<Record<string, MethodHandler>> = {
  initialize: async params => await Promise.resolve(initializeResult(params)),
  'tools/list': async () => await Promise.resolve(toolsResult()),
  'tools/call': async (params, run) => await callResult(params, run),
};

const unknownMethodError = (method: string | undefined): RpcError => ({
  code: METHOD_NOT_FOUND,
  message: `unknown method "${String(method)}" — this server implements: ${Object.keys(METHODS).join(', ')}`,
});

const respond = (id: RpcId, reply: Reply): RpcResponse =>
  'error' in reply
    ? { jsonrpc: '2.0', id, error: reply.error }
    : { jsonrpc: '2.0', id, result: reply.result };

const idOf = (request: Readonly<Record<string, unknown>>): RpcId | undefined => {
  const raw = request['id'];
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  return raw === null ? null : undefined;
};

/**
 * One parsed request in, one response out — or `undefined` for a NOTIFICATION.
 * A notification carries no `id`, and answering one desynchronises nothing less
 * than the client's whole id correlation, so the absence is load-bearing.
 */
export const handleRequest = async (
  message: unknown,
  run: AnswerRunner
): Promise<RpcResponse | undefined> => {
  const request = asRecord(message);
  const id = idOf(request);
  if (id === undefined) return undefined;
  const method = stringField(request, 'method');
  const handler = method === undefined ? undefined : METHODS[method];
  if (handler === undefined) return respond(id, { error: unknownMethodError(method) });
  return respond(id, await handler(request['params'], run));
};

type ParsedLine = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * The parse is isolated so a THROW FROM THE RUNNER can never be reported as a
 * parse error — the two failures have different fixes and must not share a code.
 */
const parsedLine = (line: string): ParsedLine => {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
};

const PARSE_FAILURE: RpcResponse = {
  jsonrpc: '2.0',
  id: null,
  error: { code: PARSE_ERROR, message: 'parse error — every message MUST be one JSON object on one line' },
};

/**
 * One LINE in, one response out. An unparseable line answers `-32700` with a
 * null id — the id is unknowable, and staying silent would leave the client
 * waiting forever on a request it believes is in flight.
 */
export const handleLine = async (
  line: string,
  run: AnswerRunner
): Promise<RpcResponse | undefined> => {
  const message = parsedLine(line);
  return message.ok ? await handleRequest(message.value, run) : PARSE_FAILURE;
};
