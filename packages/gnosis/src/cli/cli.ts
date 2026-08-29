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
import { isVocabularyError } from '../config.js';
import type { IngestProfile } from '../ingestProfile.js';
import { loadIngestProfile } from '../ingestProfile.js';
import { ingestProfilePath, packageVersion } from '../paths.js';
import { isUserConfigError } from '../userConfig.js';
import { activeProfile } from '../vocabulary.js';
import type { AdapterName } from './adapter.js';
import { adapterError, DEFAULT_ADAPTER, resolveAdapter } from './adapter.js';
import { runAnswerCommand, SYNTHESIZE_FLAG } from './answerCommand.js';
import type { ParsedArgs } from './args.js';
import { parseArgs, stringFlag, unknownFlagMessage } from './args.js';
import { runBenchCommand } from './benchCommand.js';
import type { CommandContext, CommandHandler } from './context.js';
import { runDemoCommand } from './demoCommand.js';
import { runDoctorCommand } from './doctorCommand.js';
import {
  ENRICH_MODEL_FLAG,
  ENRICHMENT_FLAG,
  LIMIT_FLAG,
  runEnrichCommand
} from './enrichCommand.js';
import type { OutputFormat } from './format.js';
import { FORMAT_FLAG, resolveFormat } from './format.js';
import { helpText } from './help.js';
import {
  BODY_SOURCE_FLAG,
  ENRICHMENT_COLUMNS_FLAG,
  KEYWORD_FILTER_FLAG,
  runIndexCommand
} from './indexCommand.js';
import { GOLD_IDS_FLAG, runIngestCommand } from './ingestCommand.js';
import { runInitCommand } from './initCommand.js';
import {
  ATOMS_DIR_FLAG,
  INDEX_PATH_FLAG,
  REPO_ROOT_FLAG,
  repoRootRefusal,
  resolveLocations,
  undeclaredRepoRoot
} from './locations.js';
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
import { runSetupCommand, SETUP_COMMAND } from './setupCommand.js';
import { runUpdateCommand } from './updateCommand.js';

/** What one invocation produced. The caller owns writing it to a real process. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  init: runInitCommand,
  setup: runSetupCommand,
  demo: runDemoCommand,
  doctor: runDoctorCommand,
  ingest: runIngestCommand,
  enrich: runEnrichCommand,
  index: runIndexCommand,
  update: runUpdateCommand,
  search: runRetrieveCommand,
  ask: runAnswerCommand,
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
  profile: IngestProfile,
  profilePath: string
): CommandContext => ({
  positionals: args.positionals,
  flags: args.flags,
  adapter,
  profile,
  profilePath,
  ...resolveLocations(args.flags, adapter, profile),
});

/** The named instance to run as. `--profile` is the only way to leave the shipped one. */
export const PROFILE_FLAG = '--profile';

type ProfileResult =
  | { readonly ok: true; readonly profile: IngestProfile; readonly path: string }
  | { readonly ok: false; readonly error: string };

/**
 * A profile that cannot be read or is malformed is a USAGE error, not a crash:
 * the loader already names the file and the exact defect, and exit 2 is what a
 * scripted caller reads. Falling back to the shipped profile is FORBIDDEN — that
 * would silently ingest one instance's corpus with another's labels.
 */
const loadProfile = (args: ParsedArgs): ProfileResult => {
  const path = stringFlag(args.flags, PROFILE_FLAG);
  if (path === undefined) {
    return { ok: true, profile: activeProfile(), path: ingestProfilePath() };
  }
  try {
    return { ok: true, profile: loadIngestProfile(path), path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Resolving the locations reads the user's `config.json`, which REFUSES when it
 * is malformed. That refusal is a usage failure — the file names the correction
 * — so it exits 2 through the same path a bad `--profile` takes. Letting it
 * escape printed a raw stack trace and a `dist/` path at the user instead. Any
 * OTHER error is a real defect and still propagates.
 */
const contextResult = (
  args: ParsedArgs,
  adapter: AdapterName,
  profile: IngestProfile,
  profilePath: string
): ContextResult => {
  try {
    return { ok: true, context: contextFor(args, adapter, profile, profilePath) };
  } catch (error) {
    if (isUserConfigError(error)) return { ok: false, error: error.message };
    throw error;
  }
};

/** The first-run commands, named here because they are the ones exempt from the check below. */
const INIT_COMMAND = 'init';

const DEMO_COMMAND = 'demo';

/**
 * `init` may run with no declared `repoRoot`: it WRITES the declaration, and it
 * never reads the resolved one (`initCommand.ts` takes the flag or the data
 * root, and writes that into the profile it creates). `demo` may for the
 * opposite reason — it brings its OWN corpus, its own profile and its own fixed
 * paths, so requiring a declared instance would defeat the one command a reader
 * with no vault can run. `setup` may for a third: it configures the RERANKER
 * BACKEND, which is a property of the machine and not of any instance — it must
 * run before an instance exists, or a first-run user cannot configure the one
 * optional hop the product ships. Every other command refuses, so the message
 * arrives on the first thing the user types rather than partway through an
 * ingest.
 */
const ROOTLESS_COMMANDS: readonly string[] = [INIT_COMMAND, DEMO_COMMAND, SETUP_COMMAND];
const buildContext = (args: ParsedArgs): ContextResult => {
  const profile = loadProfile(args);
  if (!profile.ok) return { ok: false, error: profile.error };
  if (!ROOTLESS_COMMANDS.includes(args.command ?? '') && undeclaredRepoRoot(args.flags, profile.profile)) {
    return { ok: false, error: repoRootRefusal() };
  }
  const requested = stringFlag(args.flags, '--adapter') ?? DEFAULT_ADAPTER;
  const adapter = resolveAdapter(requested);
  return adapter === undefined
    ? { ok: false, error: adapterError(requested) }
    : contextResult(args, adapter, profile.profile, profile.path);
};

const helpOutcome = (): CommandOutcome => {
  const help = helpText();
  return { exitCode: EXIT_OK, data: { command: 'help', help }, text: help };
};

/** A bare invocation is a help request, not a failure. */
const wantsHelp = (args: ParsedArgs): boolean =>
  args.command === undefined || args.flags['--help'] === true || args.flags['-h'] === true;

const versionOutcome = (): CommandOutcome => {
  const version = packageVersion();
  return { exitCode: EXIT_OK, data: { command: 'version', version }, text: version };
};

/** Asked BEFORE `--help`, so `--version --help` answers the narrower question. */
const wantsVersion = (args: ParsedArgs): boolean =>
  args.flags['--version'] === true || args.flags['-v'] === true;

/**
 * `--format`, `--type` with `--exclude-type` / `--include-history`, `--max-tokens` with `--budget-mode`, `--rerank` with its three tuning flags,
 * `--rephrase`, and the two grouping flags belong to the RETRIEVAL commands —
 * `search` and `ask`, which run the same pipeline. On any other command
 * they are refused through the SAME message an unknown flag gets: a flag no
 * command can honour MUST NOT look accepted, and one wording keeps the
 * correction identical either way.
 *
 * `--flat` is the exception that stays inside the list: it reaches `ask` so
 * the command can refuse it by NAME — a pack is grouped by construction — at
 * the same exit 2 the generic wording would have given, but saying why.
 */
const SEARCH_COMMAND = 'search';

const ASK_COMMAND = 'ask';

const RETRIEVAL_COMMANDS: readonly string[] = [SEARCH_COMMAND, ASK_COMMAND];

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
 * `--synthesize` is narrower still: `ask` ALONE. `search` produces a
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

/**
 * `update` runs BOTH hops, so it honours the union of what each honours: an
 * ingest-only or index-only flag refused there would make the composed command
 * unable to express what its two halves already do.
 */
const UPDATE_COMMAND = 'update';

/**
 * `--body-source`, `--keyword-filter` and `--enrichment-columns` each decide what
 * an index BUILD writes, so only the build honours them. Accepting one on
 * `search` would let a caller believe a ranking came from text the index it
 * read never held.
 */
const INDEX_ONLY_FLAGS: readonly string[] = [
  BODY_SOURCE_FLAG,
  KEYWORD_FILTER_FLAG,
  ENRICHMENT_COLUMNS_FLAG,
];

const ENRICH_ONLY_FLAGS: readonly string[] = [LIMIT_FLAG, ENRICH_MODEL_FLAG];

const INDEX_COMMANDS: readonly string[] = [INDEX_COMMAND, UPDATE_COMMAND];

const SIDECAR_COMMANDS: readonly string[] = [ENRICH_COMMAND, INDEX_COMMAND, UPDATE_COMMAND];

const SIDECAR_FLAGS: readonly string[] = [ENRICHMENT_FLAG];

/**
 * `--gold-ids` names the dedupe tie-break source, which only `ingest` reads.
 * Accepting it on `search` would let a caller believe a gold source shaped a
 * ranking it never touched, so it is refused through the same wording.
 */
const INGEST_COMMAND = 'ingest';

const INGEST_ONLY_FLAGS: readonly string[] = [GOLD_IDS_FLAG];

const INGEST_COMMANDS: readonly string[] = [INGEST_COMMAND, UPDATE_COMMAND];

/**
 * `demo` brings its OWN corpus, its own profile and a FIXED `demo/` subtree
 * (`paths.ts:demoAtomsDir` / `demoProfilePath`, `adapter.ts:demoIndexPath`),
 * which `demoCommand.ts` substitutes for whatever the caller's instance
 * resolved to. So there is no reading of these four it could honour — and a
 * `demo --atoms-dir /tmp/x` that ranked hits at exit 0 while writing nothing to
 * `/tmp/x` is the silently-dropped token this parser exists to refuse. Scoped
 * to `demo` alone: every other command resolves all four normally.
 *
 * `--adapter` is deliberately absent — the demo index filename comes from the
 * adapter table, so that one IS honoured, as are `--json` and `-k`.
 */
const DEMO_REFUSED_FLAGS: readonly string[] = [
  ATOMS_DIR_FLAG,
  INDEX_PATH_FLAG,
  REPO_ROOT_FLAG,
  PROFILE_FLAG,
];

/**
 * `setup` honours `--rerank-model` — it names the ONE id to probe, instead of
 * the ids it would select off the catalogue. Every other retrieval flag stays
 * refused there: `setup` runs no query, so nothing else has a reading.
 */
const scopedRetrievalFlags = (command: string): readonly string[] =>
  command === SETUP_COMMAND
    ? RETRIEVAL_FLAGS.filter(flag => flag !== RERANK_MODEL_FLAG)
    : RETRIEVAL_FLAGS;

const misplacedRetrievalFlag = (args: ParsedArgs): string | undefined =>
  RETRIEVAL_COMMANDS.includes(args.command ?? '')
    ? undefined
    : scopedRetrievalFlags(args.command ?? '').find(flag => args.flags[flag] !== undefined);

const misplacedAnswerFlag = (args: ParsedArgs): string | undefined =>
  args.command === ASK_COMMAND
    ? undefined
    : ANSWER_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedEnrichFlag = (args: ParsedArgs): string | undefined =>
  args.command === ENRICH_COMMAND
    ? undefined
    : ENRICH_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedIngestFlag = (args: ParsedArgs): string | undefined =>
  INGEST_COMMANDS.includes(args.command ?? '')
    ? undefined
    : INGEST_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedIndexFlag = (args: ParsedArgs): string | undefined =>
  INDEX_COMMANDS.includes(args.command ?? '')
    ? undefined
    : INDEX_ONLY_FLAGS.find(flag => args.flags[flag] !== undefined);

const misplacedDemoFlag = (args: ParsedArgs): string | undefined =>
  args.command === DEMO_COMMAND
    ? DEMO_REFUSED_FLAGS.find(flag => args.flags[flag] !== undefined)
    : undefined;

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
  misplacedIngestFlag,
  misplacedIndexFlag,
  misplacedSidecarFlag,
  misplacedDemoFlag,
];

const misplacedFlag = (args: ParsedArgs): string | undefined =>
  SCOPE_CHECKS.reduce<string | undefined>((found, check) => found ?? check(args), undefined);

const handlerFor = (command: string | undefined): CommandHandler | undefined =>
  command === undefined ? undefined : COMMANDS[command];

/**
 * The vocabulary a profile declares is narrowed LAZILY — the first reader to
 * ask for it is wherever the refusal surfaces, which is inside the handler and
 * not at context construction. So the boundary is drawn around BOTH: a profile
 * naming a type this build does not define is bad input, exit 2, one line
 * naming the file and the correction. Letting it escape printed a Node stack
 * trace at exit 1, a code the contract does not define at all. Any OTHER error
 * is a real defect and still propagates.
 */
const withContext = async (
  args: ParsedArgs,
  handler: CommandHandler
): Promise<CommandOutcome> => {
  const context = buildContext(args);
  if (!context.ok) return usageError(context.error);
  try {
    return await handler(context.context);
  } catch (error) {
    if (isVocabularyError(error)) return usageError(error.message);
    throw error;
  }
};

const outcomeFor = async (args: ParsedArgs): Promise<CommandOutcome> => {
  if (wantsVersion(args)) return versionOutcome();
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
