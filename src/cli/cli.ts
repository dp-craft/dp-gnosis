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
import { DEFAULT_INGEST_PROFILE } from '../config.js';
import type { IngestProfile } from '../ingestProfile.js';
import { loadIngestProfile } from '../ingestProfile.js';
import type { AdapterName } from './adapter.js';
import { adapterError, DEFAULT_ADAPTER, resolveAdapter } from './adapter.js';
import type { ParsedArgs } from './args.js';
import { parseArgs, stringFlag, unknownFlagMessage } from './args.js';
import { runBenchCommand } from './benchCommand.js';
import type { CommandContext, CommandHandler } from './context.js';
import type { OutputFormat } from './format.js';
import { FORMAT_FLAG, resolveFormat } from './format.js';
import { HELP_TEXT } from './help.js';
import { runIndexCommand } from './indexCommand.js';
import { runIngestCommand } from './ingestCommand.js';
import { resolveLocations } from './locations.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_USAGE, usageError } from './outcome.js';
import { MAX_TOKENS_FLAG, RERANK_FLAG, runRetrieveCommand, TYPE_FLAG } from './retrieveCommand.js';

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
  bench: runBenchCommand,
};

type ContextResult =
  | { readonly ok: true; readonly context: CommandContext }
  | { readonly ok: false; readonly error: string };

const commandError = (command: string | undefined): string =>
  `unknown command "${String(command)}" — use one of: ${Object.keys(COMMANDS).join(', ')}; run \`--help\` for usage`;

const contextFor = (
  args: ParsedArgs,
  adapter: AdapterName,
  profile: IngestProfile
): CommandContext => ({
  positionals: args.positionals,
  flags: args.flags,
  adapter,
  profile,
  ...resolveLocations(args.flags, adapter, profile),
});

/** The named instance to run as. `--profile` is the only way to leave the shipped one. */
export const PROFILE_FLAG = '--profile';

type ProfileResult =
  | { readonly ok: true; readonly profile: IngestProfile }
  | { readonly ok: false; readonly error: string };

/**
 * A profile that cannot be read or is malformed is a USAGE error, not a crash:
 * the loader already names the file and the exact defect, and exit 2 is what a
 * scripted caller reads. Falling back to the shipped profile is FORBIDDEN — that
 * would silently ingest one instance's corpus with another's labels.
 */
const loadProfile = (args: ParsedArgs): ProfileResult => {
  const path = stringFlag(args.flags, PROFILE_FLAG);
  if (path === undefined) return { ok: true, profile: DEFAULT_INGEST_PROFILE };
  try {
    return { ok: true, profile: loadIngestProfile(path) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const buildContext = (args: ParsedArgs): ContextResult => {
  const profile = loadProfile(args);
  if (!profile.ok) return { ok: false, error: profile.error };
  const requested = stringFlag(args.flags, '--adapter') ?? DEFAULT_ADAPTER;
  const adapter = resolveAdapter(requested);
  return adapter === undefined
    ? { ok: false, error: adapterError(requested) }
    : { ok: true, context: contextFor(args, adapter, profile.profile) };
};

const helpOutcome = (): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: { command: 'help', help: HELP_TEXT },
  text: HELP_TEXT,
});

/** A bare invocation is a help request, not a failure. */
const wantsHelp = (args: ParsedArgs): boolean =>
  args.command === undefined || args.flags['--help'] === true || args.flags['-h'] === true;

/**
 * `--format`, `--type`, `--max-tokens` and `--rerank` belong to `retrieve` alone. Elsewhere they are refused
 * through the SAME message an unknown flag gets: a flag no command can honour
 * MUST NOT look accepted, and one wording keeps the correction identical either
 * way.
 */
const RETRIEVE_COMMAND = 'retrieve';

const RETRIEVE_ONLY_FLAGS: readonly string[] = [
  FORMAT_FLAG,
  TYPE_FLAG,
  MAX_TOKENS_FLAG,
  RERANK_FLAG,
];

const misplacedFlag = (args: ParsedArgs): string | undefined =>
  args.command === RETRIEVE_COMMAND
    ? undefined
    : RETRIEVE_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

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
  const misplaced = misplacedFlag(args);
  if (misplaced !== undefined) return usageError(unknownFlagMessage(misplaced));
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

/**
 * XML mode: only a command that PRODUCED an xml rendering gets one. Anything
 * else — help, a usage failure — falls back to text rather than wrapping prose
 * in a tag it does not satisfy.
 */
const renderXml = (outcome: CommandOutcome): CliResult =>
  outcome.xml === undefined
    ? renderText(outcome)
    : { exitCode: outcome.exitCode, stdout: `${outcome.xml}\n`, stderr: '' };

const RENDERERS: Readonly<Record<OutputFormat, (outcome: CommandOutcome) => CliResult>> = {
  text: renderText,
  json: renderJson,
  xml: renderXml,
};

/**
 * Run one CLI invocation. `argv` excludes the node executable and script path.
 * A parse failure, or a format that did not resolve, renders in human mode: no
 * format can be trusted from an argv the CLI refused.
 */
export const runCli = async (argv: readonly string[]): Promise<CliResult> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return renderText(usageError(parsed.error));
  const format = resolveFormat(parsed.args.flags);
  if (!format.ok) return renderText(usageError(format.error));
  return RENDERERS[format.format](await outcomeFor(parsed.args));
};
