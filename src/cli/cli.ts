/**
 * The dp-gnosis CLI: parse, dispatch, format. Nothing else.
 *
 * Retrieval, scoring, ingest and validation stay in their own modules — this
 * file MUST NOT re-implement any of them, or the CLI becomes a second,
 * divergent copy of the library it is meant to expose.
 *
 * `runCli` returns the exit code and streams as VALUES rather than writing to
 * `process`, so a test asserts an exit code by reading a field instead of
 * spawning a process. The process wrapper is the caller's one line.
 *
 * Adding a subcommand (e.g. `bench`) is one `COMMANDS` entry plus its handler
 * file — the parser, the context, the renderer and the exit-code contract are
 * already command-agnostic.
 */
import { ATOMS_DIR, FTS5_INDEX_PATH, REPO_ROOT } from '../paths.js';
import type { AdapterName } from './adapter.js';
import { adapterError, DEFAULT_ADAPTER, resolveAdapter } from './adapter.js';
import type { ParsedArgs } from './args.js';
import { parseArgs, stringFlag } from './args.js';
import type { CommandContext, CommandHandler } from './context.js';
import { HELP_TEXT } from './help.js';
import { runIndexCommand } from './indexCommand.js';
import { runIngestCommand } from './ingestCommand.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_USAGE, usageError } from './outcome.js';
import { runRetrieveCommand } from './retrieveCommand.js';

/** What one invocation produced. The caller owns writing it to a real process. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  ingest: runIngestCommand,
  index: runIndexCommand,
  retrieve: runRetrieveCommand,
};

type ContextResult =
  | { readonly ok: true; readonly context: CommandContext }
  | { readonly ok: false; readonly error: string };

const commandError = (command: string | undefined): string =>
  `unknown command "${String(command)}" — use one of: ${Object.keys(COMMANDS).join(', ')}; run \`--help\` for usage`;

const contextFor = (args: ParsedArgs, adapter: AdapterName): CommandContext => ({
  positionals: args.positionals,
  flags: args.flags,
  adapter,
  atomsDir: stringFlag(args.flags, '--atoms-dir') ?? ATOMS_DIR,
  indexPath: stringFlag(args.flags, '--index-path') ?? FTS5_INDEX_PATH,
  repoRoot: stringFlag(args.flags, '--repo-root') ?? REPO_ROOT,
});

const buildContext = (args: ParsedArgs): ContextResult => {
  const requested = stringFlag(args.flags, '--adapter') ?? DEFAULT_ADAPTER;
  const adapter = resolveAdapter(requested);
  return adapter === undefined
    ? { ok: false, error: adapterError(requested) }
    : { ok: true, context: contextFor(args, adapter) };
};

const helpOutcome = (): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: { command: 'help', help: HELP_TEXT },
  text: HELP_TEXT,
});

/** A bare invocation is a help request, not a failure. */
const wantsHelp = (args: ParsedArgs): boolean =>
  args.command === undefined || args.flags['--help'] === true || args.flags['-h'] === true;

const handlerFor = (command: string | undefined): CommandHandler | undefined =>
  command === undefined ? undefined : COMMANDS[command];

const withContext = async (
  args: ParsedArgs,
  handler: CommandHandler
): Promise<CommandOutcome> => {
  const context = buildContext(args);
  return context.ok ? await handler(context.context) : usageError(context.error);
};

const outcomeFor = async (args: ParsedArgs): Promise<CommandOutcome> => {
  if (wantsHelp(args)) return helpOutcome();
  const handler = handlerFor(args.command);
  if (handler === undefined) return usageError(commandError(args.command));
  return await withContext(args, handler);
};

/** One object on stdout, always — including for a usage failure. */
const renderJson = (outcome: CommandOutcome): CliResult => ({
  exitCode: outcome.exitCode,
  stdout: `${JSON.stringify({ ...outcome.data, exitCode: outcome.exitCode })}\n`,
  stderr: '',
});

/** Human mode: a usage failure goes to stderr, a result goes to stdout. */
const renderText = (outcome: CommandOutcome): CliResult =>
  outcome.exitCode === EXIT_USAGE
    ? { exitCode: outcome.exitCode, stdout: '', stderr: `${outcome.text}\n` }
    : { exitCode: outcome.exitCode, stdout: `${outcome.text}\n`, stderr: '' };

const render = (outcome: CommandOutcome, json: boolean): CliResult =>
  json ? renderJson(outcome) : renderText(outcome);

/**
 * Run one CLI invocation. `argv` excludes the node executable and script path.
 * A parse failure renders in human mode: `--json` cannot be trusted from an
 * argv that did not parse.
 */
export const runCli = async (argv: readonly string[]): Promise<CliResult> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return renderText(usageError(parsed.error));
  return render(await outcomeFor(parsed.args), parsed.args.flags['--json'] === true);
};
