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
import type { IngestProfile } from '../ingestProfile.js';
import { loadIngestProfile } from '../ingestProfile.js';
import { activeProfile } from '../vocabulary.js';
import type { AdapterName } from './adapter.js';
import { adapterError, DEFAULT_ADAPTER, resolveAdapter } from './adapter.js';
import { runAnswerCommand, SYNTHESIZE_FLAG } from './answerCommand.js';
import type { ParsedArgs } from './args.js';
import { parseArgs, stringFlag, unknownFlagMessage } from './args.js';
import { runBenchCommand } from './benchCommand.js';
import type { CommandContext, CommandHandler } from './context.js';
import {
  ENRICH_MODEL_FLAG,
  ENRICHMENT_FLAG,
  LIMIT_FLAG,
  runEnrichCommand
} from './enrichCommand.js';
import type { OutputFormat } from './format.js';
import { FORMAT_FLAG, resolveFormat } from './format.js';
import { helpText } from './help.js';
import { runIndexCommand } from './indexCommand.js';
import { runIngestCommand } from './ingestCommand.js';
import { resolveLocations } from './locations.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_USAGE, usageError } from './outcome.js';
import {
  BUDGET_MODE_FLAG,
  DOMAIN_FLAG,
  EXCLUDE_TYPE_FLAG,
  FIELD_WEIGHTS_FLAG,
  FLAT_FLAG,
  INCLUDE_HISTORY_FLAG,
  MAX_PER_DOC_FLAG,
  MAX_TOKENS_FLAG,
  MIN_RELEVANCE_FLAG,
  PRF_ALPHA_FLAG,
  PRF_DOCS_FLAG,
  PRF_FLAG,
  PRF_TERMS_FLAG,
  REPHRASE_FLAG,
  RERANK_FLAG,
  RERANK_MODEL_FLAG,
  RERANK_PROFILE_FLAG,
  RERANK_WEIGHT_FLAG,
  runRetrieveCommand,
  TYPE_FLAG
} from './retrieveCommand.js';

/** What one invocation produced. The caller owns writing it to a real process. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  ingest: runIngestCommand,
  enrich: runEnrichCommand,
  index: runIndexCommand,
  retrieve: runRetrieveCommand,
  answer: runAnswerCommand,
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
  if (path === undefined) return { ok: true, profile: activeProfile() };
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

const helpOutcome = (): CommandOutcome => {
  const help = helpText();
  return { exitCode: EXIT_OK, data: { command: 'help', help }, text: help };
};

/** A bare invocation is a help request, not a failure. */
const wantsHelp = (args: ParsedArgs): boolean =>
  args.command === undefined || args.flags['--help'] === true || args.flags['-h'] === true;

/**
 * `--format`, `--type` with `--exclude-type` / `--include-history`, `--max-tokens` with `--budget-mode`, `--rerank` with its three tuning flags,
 * `--rephrase`, and the two grouping flags belong to the RETRIEVAL commands —
 * `retrieve` and `answer`, which run the same pipeline. On any other command
 * they are refused through the SAME message an unknown flag gets: a flag no
 * command can honour MUST NOT look accepted, and one wording keeps the
 * correction identical either way.
 *
 * `--flat` is the exception that stays inside the list: it reaches `answer` so
 * the command can refuse it by NAME — a pack is grouped by construction — at
 * the same exit 2 the generic wording would have given, but saying why.
 */
const RETRIEVE_COMMAND = 'retrieve';

const ANSWER_COMMAND = 'answer';

const RETRIEVAL_COMMANDS: readonly string[] = [RETRIEVE_COMMAND, ANSWER_COMMAND];

const RETRIEVAL_FLAGS: readonly string[] = [
  FORMAT_FLAG,
  TYPE_FLAG,
  DOMAIN_FLAG,
  EXCLUDE_TYPE_FLAG,
  INCLUDE_HISTORY_FLAG,
  MAX_TOKENS_FLAG,
  BUDGET_MODE_FLAG,
  MIN_RELEVANCE_FLAG,
  RERANK_FLAG,
  RERANK_MODEL_FLAG,
  RERANK_PROFILE_FLAG,
  RERANK_WEIGHT_FLAG,
  REPHRASE_FLAG,
  PRF_FLAG,
  PRF_DOCS_FLAG,
  PRF_TERMS_FLAG,
  PRF_ALPHA_FLAG,
  MAX_PER_DOC_FLAG,
  FLAT_FLAG,
  FIELD_WEIGHTS_FLAG,
];

/**
 * `--synthesize` is narrower still: `answer` ALONE. `retrieve` produces a
 * ranking, not a pack, so there is nothing for it to synthesise over — and it
 * is refused through the SAME wording every misplaced flag gets, so the
 * correction reads identically wherever the flag lands.
 */
const ANSWER_ONLY_FLAGS: readonly string[] = [SYNTHESIZE_FLAG];

/**
 * The generation verb, and the two flags only it can honour. `--enrichment` is
 * NOT among them: it names one artefact that `enrich` writes and `index` reads,
 * so it is scoped to BOTH — a sidecar path accepted on one side and refused on
 * the other is how the two commands end up pointed at different files.
 */
const ENRICH_COMMAND = 'enrich';

const INDEX_COMMAND = 'index';

const ENRICH_ONLY_FLAGS: readonly string[] = [LIMIT_FLAG, ENRICH_MODEL_FLAG];

const SIDECAR_COMMANDS: readonly string[] = [ENRICH_COMMAND, INDEX_COMMAND];

const SIDECAR_FLAGS: readonly string[] = [ENRICHMENT_FLAG];

const misplacedRetrievalFlag = (args: ParsedArgs): string | undefined =>
  RETRIEVAL_COMMANDS.includes(args.command ?? '')
    ? undefined
    : RETRIEVAL_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedAnswerFlag = (args: ParsedArgs): string | undefined =>
  args.command === ANSWER_COMMAND
    ? undefined
    : ANSWER_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedEnrichFlag = (args: ParsedArgs): string | undefined =>
  args.command === ENRICH_COMMAND
    ? undefined
    : ENRICH_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedSidecarFlag = (args: ParsedArgs): string | undefined =>
  SIDECAR_COMMANDS.includes(args.command ?? '')
    ? undefined
    : SIDECAR_FLAGS.find(flag => args.flags[flag] !== undefined);

/**
 * Every scope check, in one list. A `??` chain would grow one branch per scope;
 * the fold keeps the complexity flat as the vocabulary grows.
 */
const SCOPE_CHECKS: readonly ((args: ParsedArgs) => string | undefined)[] = [
  misplacedRetrievalFlag,
  misplacedAnswerFlag,
  misplacedEnrichFlag,
  misplacedSidecarFlag,
];

const misplacedFlag = (args: ParsedArgs): string | undefined =>
  SCOPE_CHECKS.reduce<string | undefined>((found, check) => found ?? check(args), undefined);

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
