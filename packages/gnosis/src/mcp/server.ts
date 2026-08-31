/**
 * The stdio transport: lines in, lines out. Meaning lives in `protocol.ts`.
 *
 * MCP stdio framing is NEWLINE-DELIMITED JSON — one object per line, NOT the
 * LSP `Content-Length` framing. `node:readline` is what buffers a partial chunk
 * until its newline arrives, so a request split across two writes stays one
 * request and this file holds no mutable reassembly state of its own.
 *
 * **stdout is the protocol.** Nothing but a response line may ever reach it; a
 * single stray line corrupts the stream for the rest of the session, so every
 * diagnostic belongs on stderr and a blank input line is dropped rather than
 * answered with a parse error the client never asked for.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { runCli } from '../cli/cli.js';
import type { AnswerInput, AnswerRunner, RpcResponse } from './protocol.js';
import { answerArgv, handleLine, internalErrorResponse } from './protocol.js';

/** The real seam: ONE `ask --json` invocation, and the pack is read out of it. */
export const runAnswer: AnswerRunner = async (input: AnswerInput) =>
  await runCli(answerArgv(input));

export interface StdioStreams {
  readonly input: Readable;
  readonly output: Writable;
}

/**
 * The transport's error boundary. A throw that escapes the runner would other-
 * wise reject the promise `onLine` discards — killing the process under Node's
 * `--unhandled-rejections=throw` with NO response written for that id.
 */
const responseFor = async (line: string, run: AnswerRunner): Promise<RpcResponse | undefined> => {
  try {
    return await handleLine(line, run);
  } catch (error: unknown) {
    return internalErrorResponse(line, error);
  }
};

/**
 * Responses are written as each one completes rather than in request order.
 * JSON-RPC 2.0 correlates by `id` and explicitly permits out-of-order replies,
 * so this needs no queue — and a queue would be the one piece of mutable state
 * this transport otherwise avoids.
 */
const emit = async (
  output: Writable,
  line: string,
  run: AnswerRunner
): Promise<void> => {
  const response = await responseFor(line, run);
  if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
};

const onLine = (streams: StdioStreams, run: AnswerRunner) => (line: string): void => {
  if (line.trim().length > 0) void emit(streams.output, line, run);
};

/** Start serving. Returns nothing: the caller's process lives as long as stdin. */
export const serveStdio = (streams: StdioStreams, run: AnswerRunner = runAnswer): void => {
  const reader = createInterface({ input: streams.input, crlfDelay: Infinity });
  reader.on('line', onLine(streams, run));
};
