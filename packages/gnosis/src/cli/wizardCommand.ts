/**
 * `wizard` — the interactive first run: one command that takes a fresh clone to
 * a vault that answers.
 *
 * It COMPOSES the non-interactive commands rather than replacing them. `init`
 * writes a profile, `setup` probes and configures a reranker, `ingest` and
 * `index` build, `doctor` checks — all of them stay exactly as they are,
 * scriptable and tested, and this command is the guided path through them. A
 * wizard that reimplemented any of that would become a second owner of it.
 *
 * Four rules shape it.
 *
 * **No configuration is written until the summary is confirmed.** Every answer
 * is collected into a plan (`wizard/plan.ts`, pure), rendered, and only then
 * committed, so `Ctrl-C` at any question leaves the profile and `config.json`
 * exactly as they were. TWO things asked for along the way outlive an abort,
 * and both happen on the reranker rung, BEFORE the summary is reached: a model
 * file agreed to and downloaded, and a detached `llama-server` agreed to and
 * started, with its log (`wizard/backend.ts`). Neither is configuration, and
 * each is named as it happens — `WELCOME` says so up front, `CANCELLED_TEXT`
 * on the way out.
 *
 * **It refuses without a terminal.** A wizard that read EOF as an answer would
 * half-configure a CI job in silence; `init` and `setup` are the scriptable
 * path and the refusal names them.
 *
 * **It ends by PROVING the vault answers.** `ingest` restamps the corpus digest
 * and exits 0 while the index beside it still carries the old one, so the next
 * query refuses — silently, as far as any test suite is concerned. The wizard
 * therefore runs `index` as part of the same step, never as advice, and then
 * runs one real `search` and reads `indexState` back. That read, not the exit
 * code of the build, is what says the instance works.
 *
 * **A partial ingest is a REPORT, and the chain continues through it.** `ingest`
 * exits 3 whenever it refused anything — one empty heading or one mirrored
 * appendix is enough on a real corpus — and it exits 3 again when it wrote
 * nothing at all. The exit code alone cannot tell those apart, so the wizard
 * asks the only question that distinguishes them: are there atoms on disk?
 * None means blocked and the chain stops; any means `index` MUST still run,
 * because stopping there is precisely the atoms-without-an-index state the rule
 * above exists to prevent. What was refused is not lost — the ingest step's
 * whole output is written to `ingest-report.txt` at the data root, and its
 * summary line and that path are shown on BOTH screens, so a run that skipped
 * hundreds of documents says so even when it succeeded.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomFileCount, existingInstance, instancePaths, writeInstance } from '../instance.js';
import { cliInvocation } from '../invocation.js';
import { atomsDir as atomsDirOf, dataRoot, userProfilePath } from '../paths.js';
import type { IndexState } from '../port.js';
import type { AdapterName } from './adapter.js';
import { DEFAULT_ADAPTER, defaultIndexPath } from './adapter.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import { writeUserConfig } from './rerankSetup.js';
import type { Draft } from './wizard/amend.js';
import { amend } from './wizard/amend.js';
import type { CorpusAnswers } from './wizard/flow.js';
import { askCorpus, rerankPreference } from './wizard/flow.js';
import { readHardware } from './wizard/hardware.js';
import type { ChatAnswer, PlanLocations, WizardAnswers, WizardPlan } from './wizard/plan.js';
import { buildPlan } from './wizard/plan.js';
import type { Option, Prompter } from './wizard/prompts.js';
import { CANCELLED, terminalPrompter } from './wizard/prompts.js';
import type { RerankResult } from './wizard/rerankFlow.js';
import { askChatModels, askRerank } from './wizard/rerankFlow.js';
import { banner, note, section } from './wizard/screen.js';

/** The verb, named here so `cli.ts` registers and scopes it from one place. */
export const WIZARD_COMMAND = 'wizard';

/** The step whose non-zero exit is read against the atoms it left, not alone. */
const INGEST_STEP = 'ingest';

/** Where the ingest step's full output is kept, so the screens can stay short. */
const INGEST_REPORT = 'ingest-report.txt';

/** Where a wizard-downloaded model and a wizard-started server's log live. */
const MODELS_SUBDIR = 'models';
const SERVER_LOG = 'llama-server.log';

/** The query the closing check runs. Its COUNT is not the check — `indexState` is. */
const PROBE_QUERY = 'gnosis';

const NO_TTY = (): string =>
  `${WIZARD_COMMAND} needs an interactive terminal — it asks questions, and reading EOF as an answer would half-configure this machine in silence; use \`${cliInvocation()} init <dir…>\` and \`${cliInvocation()} setup\`, which are the scriptable path`;

const POSITIONALS = `${WIZARD_COMMAND} takes no arguments — it asks for everything it needs`;

const refuse = (message: string): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: { command: WIZARD_COMMAND, error: message },
  text: message,
});

/**
 * The remedy names `DP_GNOSIS_CONFIG_HOME`, not `DP_GNOSIS_DATA_HOME`, and the
 * distinction is the whole value of the message: the profile this refuses over
 * lives in the CONFIG home (`paths.ts:userProfilePath`), so moving the DATA root
 * would leave the same file exactly where it is and the wizard would refuse
 * again for the same reason. A refusal whose remedy does not work is worse than
 * no remedy — it costs the reader a run to discover that.
 */
const alreadyExists = (found: string): string =>
  `${WIZARD_COMMAND}: this instance already exists — ${found} is present, and the wizard MUST NOT overwrite a profile you have edited; edit it in place, run \`${cliInvocation()} setup\` to reconfigure the reranker alone, or point DP_GNOSIS_CONFIG_HOME at a new directory to build a second instance beside it`;

/**
 * `init`'s second refusal, in this command's voice. Adopting atoms this profile
 * never wrote makes the next `ingest` prune every one of them as an orphan, so
 * the count is named: the reader has to know something is there before choosing
 * another root.
 */
const alreadyOccupied = (atomsPath: string, atoms: number): string =>
  `${WIZARD_COMMAND}: ${atomsPath} already holds ${atoms} atom file${atoms === 1 ? '' : 's'} (*.md), and the wizard MUST NOT adopt atoms it did not write — the next ingest would prune every one of them as an orphan; choose another data root, or ingest with the profile that wrote them`;

/**
 * Both of `init`'s refusals, read against the root the user JUST chose — the
 * default root says nothing about a root they typed, and neither refusal reads
 * the index path, which is why any resolved one serves to build the triple.
 */
const instanceRefusal = (root: string): string | undefined => {
  const atomsPath = atomsDirOf(root);
  const found = existingInstance(instancePaths(atomsPath, defaultIndexPath(DEFAULT_ADAPTER, root)));
  if (found !== undefined) return alreadyExists(found);
  const atoms = atomFileCount(atomsPath);
  return atoms > 0 ? alreadyOccupied(atomsPath, atoms) : undefined;
};

const ROOT_EXPLANATION = [
  'Everything dp-gnosis builds lives under one data root — the atoms your documents are split into, the search index, any reranker model downloaded here, and the server log.',
  'Your own documents are never moved, written to or modified. They are only read.',
];

const ROOT_NOTE = (resolved: string): readonly string[] => [
  '',
  'dp-gnosis keeps its atoms and its index under one data root.',
  `This machine resolves that to ${resolved}.`,
];

const askDataRoot = async (prompter: Prompter): Promise<string | undefined> => {
  const resolved = dataRoot();
  prompter.say([...section('Where things go'), ...note(ROOT_EXPLANATION)]);
  prompter.say(ROOT_NOTE(resolved));
  const typed = await prompter.input('Data root', resolved);
  return typed === resolved ? undefined : typed;
};

/** The three artefact locations, derived from the root the user just chose. */
const locationsFor = (root: string, adapter: AdapterName): PlanLocations => ({
  profilePath: userProfilePath(),
  atomsDir: atomsDirOf(root),
  indexPath: defaultIndexPath(adapter, root),
  repoRoot: root,
});

/** A JSON value, indented so it reads as a quoted block rather than as output. */
const quoted = (value: unknown): string =>
  JSON.stringify(value, null, 2)
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');

const configLines = (patch: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(patch).length === 0
    ? []
    : ['', `  merged into ${Object.keys(patch).join(', ')} of your config.json:`, quoted(patch)];

/**
 * The whole of what a confirmation buys. It shows the FILES and the literal
 * contents rather than a prose recap: the profile is the file the owner edits
 * next, and a summary that paraphrased it would be a second description of a
 * thing they are about to read anyway.
 */
const summaryOf = (plan: WizardPlan): readonly string[] => [
  '',
  'This is everything that will be written:',
  '',
  `  profile   ${plan.locations.profilePath}`,
  `  atoms     ${plan.locations.atomsDir}`,
  `  index     ${plan.locations.indexPath}`,
  '',
  quoted(plan.profile),
  ...configLines(plan.configPatch),
  '',
];

/** One in-process CLI run. Imported lazily so `cli.ts` can register this command. */
const runCommand = async (argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const { runCli } = await import('./cli.js');
  return await runCli(argv);
};

interface Step {
  readonly label: string;
  /** What this step DOES, in the reader's words — the command name says nothing. */
  readonly narration: string;
  readonly argv: readonly string[];
}

const buildSteps = (plan: WizardPlan, adapter: string): readonly Step[] => [
  {
    label: INGEST_STEP,
    narration: 'splitting your documents into atoms',
    argv: ['ingest', '--profile', plan.locations.profilePath],
  },
  {
    label: 'index',
    narration: 'building the search index',
    argv: ['index', '--adapter', adapter, '--profile', plan.locations.profilePath],
  },
];

interface StepResult {
  readonly label: string;
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * What STOPS the chain. Every step but `ingest` blocks on any non-zero exit;
 * `ingest` blocks only when it left no atoms, because it returns the same 3 for
 * a corpus it refused entirely and for one it merely reported skips on. The
 * atoms on disk are the distinguisher — never the exit code.
 */
const blocked = (plan: WizardPlan, result: StepResult): boolean =>
  result.exitCode !== EXIT_OK &&
  (result.label !== INGEST_STEP || atomFileCount(plan.locations.atomsDir) === 0);

/** Milliseconds in the unit the elapsed line reports. */
const SECOND_MS = 1000;

const elapsed = (startedAt: number): string =>
  `  done in ${((Date.now() - startedAt) / SECOND_MS).toFixed(1)}s`;

/**
 * One step, announced by what it DOES and closed by how long it took. Two lines
 * per step and no more: `ingest` over a real corpus already prints hundreds,
 * and a wizard that narrated each one would bury both of these.
 */
const runStep = async (prompter: Prompter, step: Step): Promise<StepResult> => {
  prompter.say([`  ${step.narration}…`]);
  const startedAt = Date.now();
  const result = await runCommand(step.argv);
  prompter.say([elapsed(startedAt)]);
  return { label: step.label, ...result };
};

/**
 * Sequential by construction, and it STOPS at the first BLOCKING exit. `ingest`
 * and `index` are one operation in two commands; running the second over a
 * failed first would build an index for a corpus that was never written, and
 * skipping it over a merely partial first would leave atoms nothing can query.
 */
const runSteps = async (
  prompter: Prompter,
  plan: WizardPlan,
  steps: readonly Step[]
): Promise<readonly StepResult[]> =>
  await steps.reduce<Promise<readonly StepResult[]>>(async (pending, step) => {
    const done = await pending;
    if (done.some(result => blocked(plan, result))) return done;
    return [...done, await runStep(prompter, step)];
  }, Promise.resolve([]));

/**
 * The ingest step's output, kept in full on disk and quoted by its first line —
 * the `ingest: written N, pruned N, skipped N` summary. A corpus that skipped
 * hundreds of sections prints hundreds of lines, and a screen that dumped them
 * buries the one line saying how many there were.
 */
const ingestStdout = (results: readonly StepResult[]): string =>
  results.find(result => result.label === INGEST_STEP)?.stdout ?? '';

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

const newlineTerminated = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

const ingestReport = (plan: WizardPlan, results: readonly StepResult[]): readonly string[] => {
  const stdout = ingestStdout(results);
  if (stdout.trim().length === 0) return [];
  const path = join(plan.locations.repoRoot, INGEST_REPORT);
  writeFileSync(path, newlineTerminated(stdout), 'utf8');
  return ['', `  ${firstLine(stdout)}`, `  full report: ${path}`];
};

/** What ONE real search says about the index — the only closing check that counts. */
const indexStateOf = (stdout: string): string => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const state =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['indexState'] : undefined;
    return typeof state === 'string' ? state : 'unreported';
  } catch {
    return 'unreadable';
  }
};

/**
 * The probe runs on the adapter the instance was BUILT with — `search` defaults
 * to `fts5`, so any other choice would open an index that is not there and the
 * closing check would report the wizard's own omission as the vault's state.
 *
 * A non-zero exit carries its own explanation, so it is reported rather than
 * flattened into `unreadable`: a refusal the tool already named is the real
 * reason, and `unreadable` would replace it with a guess about JSON.
 */
const verify = async (plan: WizardPlan, adapter: string): Promise<string> => {
  const result = await runCommand(['search', PROBE_QUERY, '--adapter', adapter, '--profile', plan.locations.profilePath, '--json']);
  const state = indexStateOf(result.stdout);
  return state === 'unreadable' && result.exitCode !== EXIT_OK ? `search exited ${String(result.exitCode)}` : state;
};

const nextSteps = (profilePath: string, adapter: string): readonly string[] => [
  '',
  'Next:',
  `  ${cliInvocation()} search "<keywords>" --adapter ${adapter} --profile ${profilePath}`,
  `  ${cliInvocation()} doctor --profile ${profilePath}`,
  '',
  'To serve this vault to Claude Desktop, Cursor, Zed, opencode or Obsidian, the client',
  'configuration is in packages/gnosis/INTEGRATION.md.',
  '',
  'Ask with KEYWORDS, not with a question — it is the largest measured quality lever',
  'the tool has (packages/gnosis/QUERYING.md § Query rephrasing).',
];

/** `ingest`'s own output is already quoted by the report, so it is not repeated. */
const failureDetail = (broke: StepResult | undefined): readonly string[] =>
  broke === undefined || broke.label === INGEST_STEP ? [] : ['', broke.stdout];

const failed = (
  plan: WizardPlan,
  results: readonly StepResult[],
  report: readonly string[]
): CommandOutcome => {
  const broke = results.find(result => blocked(plan, result));
  const message = `${WIZARD_COMMAND}: the profile and config were written, but \`${broke?.label ?? 'the build'}\` exited ${String(broke?.exitCode ?? 1)} — fix what it reported, then re-run it with --profile ${plan.locations.profilePath}`;
  return {
    exitCode: EXIT_PARTIAL,
    data: { command: WIZARD_COMMAND, error: message, steps: results.map(result => ({ step: result.label, exitCode: result.exitCode })) },
    text: [message, ...report, ...failureDetail(broke)].join('\n'),
  };
};

/**
 * What each `indexState` means for a wizard that has just built the thing.
 * `ready` is the ONLY one that says the instance answers; the rest are read as
 * refusals with their own remedy, because the whole point of the closing check
 * is that a build exiting 0 does not prove a query will be served.
 */
const STATE_REMEDY: Readonly<Record<string, string | undefined>> = {
  ready: undefined,
  empty: 'the index was built but holds nothing — check that the corpus directories really contain the markdown you meant',
  stale: 'the index is older than the atoms beside it',
  unavailable: 'there is no index at that path — the build step did not leave one',
  mismatched: 'the index carries a different corpus digest than the atoms beside it',
} satisfies Readonly<Record<IndexState, string | undefined>>;

/** `indexStateOf` can report a string no `IndexState` names, so it is GUARDED. */
const remedyFor = (state: string): string | undefined =>
  state in STATE_REMEDY ? STATE_REMEDY[state] : undefined;

const REBUILD = (profilePath: string): string =>
  `rebuild it with: ${cliInvocation()} index --profile ${profilePath}`;

/** What the build left behind: the state one real search read, and its report. */
interface BuildOutcome {
  readonly state: string;
  readonly report: readonly string[];
}

const succeeded = (plan: WizardPlan, adapter: string, built: BuildOutcome): CommandOutcome => {
  const state = built.state;
  const remedy = remedyFor(state);
  const served = state === 'ready';
  const text = [
    served
      ? `${WIZARD_COMMAND}: this instance is configured, built and answering.`
      : `${WIZARD_COMMAND}: this instance is configured and built, but a real search did not reach a ready index.`,
    `  profile      ${plan.locations.profilePath}`,
    `  indexState   ${state}`,
    ...(served ? [] : ['', `  ${remedy ?? 'the closing search did not report an index state'}`, `  ${REBUILD(plan.locations.profilePath)}`]),
    ...built.report,
    ...nextSteps(plan.locations.profilePath, adapter),
  ].join('\n');
  return {
    exitCode: served ? EXIT_OK : EXIT_PARTIAL,
    data: { command: WIZARD_COMMAND, profilePath: plan.locations.profilePath, indexState: state },
    text,
  };
};

const CANCELLED_TEXT = `${WIZARD_COMMAND}: cancelled — no profile and no config were written; a model file downloaded, or a server started, earlier in this run is still there`;

const commit = async (prompter: Prompter, plan: WizardPlan, adapter: string): Promise<CommandOutcome> => {
  writeInstance(instancePaths(plan.locations.atomsDir, plan.locations.indexPath), plan.profile);
  if (Object.keys(plan.configPatch).length > 0) writeUserConfig(plan.configPatch);
  const results = await runSteps(prompter, plan, buildSteps(plan, adapter));
  const report = ingestReport(plan, results);
  if (results.some(result => blocked(plan, result))) return failed(plan, results, report);
  return succeeded(plan, adapter, { state: await verify(plan, adapter), report });
};

/**
 * What confirming the summary actually starts, and what it does NOT.
 *
 * Both claims are read off `buildSteps` rather than described from intent: it
 * holds `ingest` and `index` and nothing else, and `runStep` closes each one
 * with its own elapsed line. Enrichment is a THIRD command with its own model
 * (`enrich --enrich-model`) whose output only reaches the index through a later
 * `index --enrichment`, so a wizard that left it unmentioned would let a first
 * run finish believing the generated fields were part of what it just built.
 */
const BUILD_EXPLANATION = [
  'On confirming, ingest and index both run now, one after the other — your documents are split into atoms and the index is built over them. Each prints how long it took.',
  'Enrichment is NOT part of setup. `dp-gnosis enrich` is a separate run you can make later; it needs a chat model, and the index has to be rebuilt afterwards for what it generates to be searchable.',
];

const WELCOME = [
  '',
  'dp-gnosis setup. No profile and no config is written until you confirm the',
  'summary at the end, so Ctrl-C before it leaves your configuration untouched.',
  'Two things asked for along the way DO outlive an abort: a model file you agree',
  'to download, and a server you agree to start. Both are named as they happen.',
];

/** Every answer, assembled into the shape  validates. */
const answersFrom = (
  chosenRoot: string | undefined,
  corpus: CorpusAnswers,
  rerank: RerankResult,
  chat: ChatAnswer | undefined
): WizardAnswers => ({
  dataRoot: chosenRoot,
  roots: corpus.roots,
  excludePaths: corpus.excludePaths,
  defaultType: corpus.defaultType,
  excludedTypes: corpus.excludedTypes,
  analyzer: corpus.language.analyzer,
  adapter: corpus.adapter,
  prf: corpus.prf,
  rerank: rerank.rerank,
  chat,
});

/**
 * The three things the summary can be answered with. It is a `select` rather
 * than the `confirm` it grew out of because the reported failure was pressing
 * Enter through a multi-select with no way back: a yes/no offers correcting
 * nothing, and Ctrl-C throws the whole interview away to fix one answer.
 */
type Decision = 'write' | 'amend' | 'cancel';

const REVIEW_QUESTION = 'Write it?';

const REVIEW_OPTIONS: readonly Option<Decision>[] = [
  { value: 'write', name: 'Write it' },
  { value: 'amend', name: 'Change an answer' },
  { value: 'cancel', name: 'Cancel' },
];

/** What an amendment cannot change, so it is resolved once and carried through. */
interface ReviewContext {
  readonly chosenRoot: string | undefined;
  readonly root: string;
  readonly chat: ChatAnswer | undefined;
}

/**
 * Summary, decision, and — on an amendment — the same three again over the
 * amended draft. The plan is REBUILT from the draft on every pass rather than
 * patched, so an amended answer that no longer validates refuses exactly as it
 * would have on the first pass instead of being swallowed by the amend path.
 */
const review = async (
  prompter: Prompter,
  context: ReviewContext,
  draft: Draft
): Promise<CommandOutcome> => {
  const plan = buildPlan(
    answersFrom(context.chosenRoot, draft.corpus, draft.rerank, context.chat),
    locationsFor(context.root, draft.corpus.adapter)
  );
  if (!plan.ok) return refuse(`${WIZARD_COMMAND}: ${plan.error}`);
  prompter.say(summaryOf(plan.plan));
  const decision = await prompter.select<Decision>(REVIEW_QUESTION, REVIEW_OPTIONS, 'write');
  if (decision === 'write') return await commit(prompter, plan.plan, draft.corpus.adapter);
  if (decision === 'cancel') return refuse(CANCELLED_TEXT);
  return await review(prompter, context, await amend(prompter, context.root, draft));
};

const interview = async (prompter: Prompter): Promise<CommandOutcome> => {
  prompter.say(banner());
  prompter.say(WELCOME);
  const chosenRoot = await askDataRoot(prompter);
  const root = chosenRoot ?? dataRoot();
  const refusal = instanceRefusal(root);
  if (refusal !== undefined) return refuse(refusal);
  const corpus = await askCorpus(prompter, root);
  const rerank = await askRerank(prompter, rerankPreference(corpus), await readHardware(root), {
    modelsDir: join(root, MODELS_SUBDIR),
    logPath: join(root, SERVER_LOG),
  });
  const chat = await askChatModels(prompter, rerank);

  prompter.say([...section('Build'), ...note(BUILD_EXPLANATION)]);
  return await review(prompter, { chosenRoot, root, chat }, { corpus, rerank });
};

/**
 * The prompter is a PARAMETER so the suite can drive the whole flow with a
 * scripted implementation. `cli.ts` calls the handler below, which supplies the
 * real terminal.
 */
export const runWizard = async (context: CommandContext, prompter: Prompter): Promise<CommandOutcome> => {
  if (context.positionals.length > 0) return usageError(POSITIONALS);
  try {
    return await interview(prompter);
  } catch (error: unknown) {
    if (error === CANCELLED) return refuse(CANCELLED_TEXT);
    throw error;
  }
};

export const runWizardCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  if (process.stdin.isTTY !== true) return usageError(NO_TTY());
  return await runWizard(context, await terminalPrompter());
};
