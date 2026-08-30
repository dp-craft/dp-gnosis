/**
 * The reranker half of the interview — the ladder from "nothing is installed"
 * to an endpoint that has been PROVED to discriminate.
 *
 * One rule governs every rung: **nothing is written until a probe passes.**
 * `setup` already refuses a model that fails `rerankHealth`, and the reason is
 * the whole point of this file. Most published Qwen3-Reranker GGUFs are missing
 * the `cls.output.weight` rank head; the server answers HTTP 200, the scores
 * parse as floats around 4.5e-23, and every later run exits 0 over a reranker
 * that ranks nothing. Downloading gigabytes and writing a config on the
 * strength of a 200 would be that failure with a progress bar.
 *
 * So a download is never the last word. After the model is served, the wizard
 * runs the SAME two-document discrimination probe against it, and configures
 * the pair only if it separates.
 *
 * The wizard also never installs a backend. `llama.cpp` and Ollama are platform
 * builds with their own package managers; what this file does is DETECT one,
 * drive it, and — when there is none — hand over the exact command, which is
 * the honest end of what a Node CLI can promise.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { RERANK_DOC_MAX_CHARS, RERANK_K_INIT } from '../../config.js';
import { LOCAL_RERANKER_INSTALL_COMMAND, localRerankerAvailability, localRerankScores } from '../../localReranker.js';
import { rerankHealth } from '../../rerank.js';
import type { Probed } from '../rerankSetup.js';
import { candidateUrls, findServer, passed, probeCandidates, selectCandidates } from '../rerankSetup.js';
import type { Choice, RunMode } from './advice.js';
import { describeChoice, LOCAL_ENGINE_ADVICE, poolChoices, RERANK_ADVICE, RUN_MODE_CHOICES } from './advice.js';
import { detectBackends, localBaseUrl, serveCommand, startServer, waitForServer } from './backend.js';
import { downloadFile, hfGgufFiles } from './download.js';
import type { HardwareFacts } from './hardware.js';
import type { Quant, RerankerModel } from './models.js';
import { GIB, recommendedModel, recommendedQuant, WORKING_MODELS } from './models.js';
import type { RerankAnswer } from './plan.js';
import type { Option, Prompter } from './prompts.js';
import { note, section } from './screen.js';

/** The port `RERANK_DEFAULT_URL` names, and what a wizard-started server binds. */
const SERVE_PORT = 9292;

/** Whole-number percent, for the one progress line. */
const PERCENT = 100;

/** How long a freshly started server is given to answer. A cold load is minutes, not seconds. */
const START_TIMEOUT_MS = 240_000;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GB`;

/** What the reranker half produced, plus the catalogue the chat step reuses. */
export interface RerankResult {
  readonly rerank: RerankAnswer | undefined;
  /** Every id the server advertises, or empty when no server answered. */
  readonly catalogue: readonly string[];
}

const verdictOf = (probe: Probed): string =>
  probe.health.kind === 'healthy'
    ? `  ${probe.model}  PASSED — relevant ${String(probe.health.relevantScore)}, irrelevant ${String(probe.health.irrelevantScore)}`
    : `  ${probe.model}  REJECTED — ${probe.health.detail}`;

/**
 * What the preset chose for this half of the interview, carried in rather than
 * re-derived. `poolK` is a row {@link poolChoices} itself returned for this
 * language, so pre-selecting it cannot open the menu on a depth it withholds.
 */
export interface RerankPreference {
  readonly hungarian: boolean;
  /** Whether `Set up the reranker?` opens on yes. */
  readonly rerank: boolean;
  readonly poolK: number;
}

/**
 * The pool depth alone. Exported because it is the ONE reranker answer an amend
 * may re-ask: the rung around it downloads files and starts servers, and this
 * question does neither.
 */
export const askPool = async (prompter: Prompter, preference: RerankPreference): Promise<number> => {
  const choices = poolChoices(preference.hungarian);
  const picked = await prompter.select(
    'How many candidates should the reranker reorder?',
    choices.map(choice => ({
      value: choice.value,
      name: choice.title,
      description: describeChoice(choice),
    })),
    String(preference.poolK)
  );
  return Number(picked);
};

/** What a rung hands back once its probe has passed: everything but the pool. */
type ProvedRerank =
  | { readonly backend: 'http'; readonly url: string; readonly model: string }
  | { readonly backend: 'local'; readonly modelPath: string; readonly model: string };

const accepted = async (
  prompter: Prompter,
  preference: RerankPreference,
  proved: ProvedRerank
): Promise<RerankAnswer> => ({ ...proved, poolK: await askPool(prompter, preference) });

/** Probe every rerank-marked id the server advertises, stopping at the first pass. */
const probeServer = async (
  prompter: Prompter,
  baseUrl: string,
  models: readonly string[]
): Promise<Probed | undefined> => {
  const candidates = selectCandidates(models, undefined);
  if (candidates.probe.length === 0) {
    prompter.say([`  ${baseUrl} serves no model whose id names a reranker`]);
    return undefined;
  }
  prompter.say([`  probing ${candidates.probe.join(', ')} — a cold model load can take minutes`]);
  const probed = await probeCandidates(baseUrl, candidates.probe);
  prompter.say(probed.map(verdictOf));
  return passed(probed);
};

const modelOption = (model: RerankerModel): Option<RerankerModel> => ({
  value: model,
  name: model.title,
  description: `  + ${model.pro}\n  − ${model.con}`,
});

const quantOption = (quant: Quant): Option<Quant> => ({
  value: quant,
  name: `${quant.label} — about ${gib(quant.approxBytes)}`,
  description: `  ${quant.note}`,
});

const hardwareLines = (facts: HardwareFacts, model: RerankerModel): readonly string[] => [
  '',
  `  this machine: ${gib(facts.totalRamBytes)} RAM` +
    (facts.gpuName === undefined
      ? ', no NVIDIA GPU detected (the check reads nvidia-smi, so an AMD or Apple one will not show here)'
      : `, ${facts.gpuName} with ${facts.vramBytes === undefined ? 'unknown' : gib(facts.vramBytes)} VRAM`) +
    (facts.freeDiskBytes === undefined ? '' : `, ${gib(facts.freeDiskBytes)} free`),
  `  → recommended: ${model.title}`,
];

/** Which published GGUF to fetch — model, then quantisation, both recommended first. */
const askWhichModel = async (
  prompter: Prompter,
  facts: HardwareFacts
): Promise<{ readonly model: RerankerModel; readonly quant: Quant }> => {
  const suggested = recommendedModel(facts.vramBytes, facts.totalRamBytes);
  prompter.say(hardwareLines(facts, suggested));
  const model = await prompter.select('Which reranker?', WORKING_MODELS.map(modelOption), suggested);
  const quant = recommendedQuant(model, facts.freeDiskBytes);
  return { model, quant: await prompter.select('Which quantisation?', model.quants.map(quantOption), quant) };
};

const progressOf = (prompter: Prompter, file: string) => (received: number, total: number): void => {
  const share = total === 0 ? 0 : Math.round((received / total) * PERCENT);
  prompter.progress(`  ${file}  ${String(share)} %  (${gib(received)} of ${gib(total)})`);
};

/** Fetch the chosen quantisation, resolving its FILE NAME from the repository itself. */
const fetchModel = async (
  prompter: Prompter,
  choice: { readonly model: RerankerModel; readonly quant: Quant },
  modelsDir: string
): Promise<string | undefined> => {
  const listing = await hfGgufFiles(choice.model.repo);
  if (!listing.ok) {
    prompter.say([`  could not list ${choice.model.repo}: ${listing.error}`]);
    return undefined;
  }
  const wanted = listing.files.find(file => file.file.toLowerCase().includes(choice.quant.label.toLowerCase()));
  if (wanted === undefined) {
    prompter.say([`  ${choice.model.repo} publishes no ${choice.quant.label} file — it lists ${listing.files.map(file => file.file).join(', ')}`]);
    return undefined;
  }
  if (!(await prompter.confirm(`Download ${wanted.file} (${gib(wanted.sizeBytes)}) into ${modelsDir}?`, true))) return undefined;
  mkdirSync(modelsDir, { recursive: true });
  const outcome = await downloadFile(wanted, join(modelsDir, wanted.file), progressOf(prompter, wanted.file));
  prompter.say(['']);
  if (outcome.ok) return outcome.path;
  prompter.say([`  the download did not verify and was discarded: ${outcome.error}`]);
  return undefined;
};

const NO_BACKEND = (rendered: string): readonly string[] => [
  '',
  '  No llama.cpp server was found on PATH, so the model cannot be started from here.',
  '  Install llama.cpp (or llama-swap), then serve the file with:',
  '',
  `    ${rendered}`,
  '',
  '  Then re-run the wizard, or `dp-gnosis setup`, to probe and configure it.',
];

/**
 * What the user is told between the spawn and the wait. A port that was ALREADY
 * answering was not started by this run, and saying so is the difference between
 * probing a server the wizard understands and adopting a stranger's.
 */
const startedLines = (
  started: { readonly pid: number } | { readonly pid: undefined; readonly alreadyServing: string },
  logPath: string
): readonly string[] =>
  started.pid === undefined
    ? [
        `  ${started.alreadyServing} is already answering, so nothing was started — the probe below is against THAT server, not one this wizard owns`,
      ]
    : [`  started as pid ${String(started.pid)}; log at ${logPath}`, '  waiting for it to answer — a first load can take minutes'];

/** Start a detected llama.cpp server over the downloaded file, and wait for it. */
const serveModel = async (
  prompter: Prompter,
  modelPath: string,
  logPath: string
): Promise<boolean> => {
  const rendered = serveCommand(modelPath, SERVE_PORT).rendered;
  const backends = await detectBackends();
  if (!backends.some(backend => backend.kind === 'llama-server')) {
    prompter.say(NO_BACKEND(rendered));
    return false;
  }
  if (!(await prompter.confirm(`Start it now?  ${rendered}`, true))) return false;
  const started = await startServer(modelPath, SERVE_PORT, logPath);
  if (!started.ok) {
    prompter.say([`  could not start it: ${started.error}`]);
    return false;
  }
  prompter.say(startedLines(started, logPath));
  return await waitForServer(localBaseUrl(SERVE_PORT), START_TIMEOUT_MS);
};

/** Where a wizard-downloaded model and its server log live under the data root. */
export interface ServeLocations {
  readonly modelsDir: string;
  readonly logPath: string;
}

/**
 * A document of exactly the width the reranker is really shown
 * ({@link RERANK_DOC_MAX_CHARS}), so the timing below measures the cost this
 * instance will actually pay. Timing a two-sentence probe would understate it by
 * whatever ratio the widths differ.
 */
const SAMPLE_SENTENCE =
  'BM25 scores a document by summing an inverse document frequency weight times a saturating ' +
  'term frequency factor normalised by the document length against the average of the collection. ';

const sampleDoc = (): string =>
  SAMPLE_SENTENCE.repeat(Math.ceil(RERANK_DOC_MAX_CHARS / SAMPLE_SENTENCE.length)).slice(0, RERANK_DOC_MAX_CHARS);

const SAMPLE_QUERY = 'how does BM25 rank documents by term frequency and document length';

const MS_PER_SECOND = 1000;

const seconds = (ms: number): string => `${(ms / MS_PER_SECOND).toFixed(1)} s`;

/**
 * The projection above which the missing timeout is worth saying out loud.
 *
 * `rerank.ts` forwards `timeoutMs` to the HTTP scorer only, so the in-process
 * scoring path runs UNBOUNDED — a pool that has started is ended by Ctrl-C and
 * by nothing else. On a machine where the projection is a few seconds that is
 * trivia; one minute is where the user stops watching and starts waiting, which
 * is exactly when "nothing will cancel this" becomes part of the choice. The
 * threshold is stated in the same second unit the lines themselves print, so a
 * reader can check it against the number above it.
 */
const LONG_PROJECTION_MS = 60 * MS_PER_SECOND;

/** Printed only past {@link LONG_PROJECTION_MS}, beside the projection it qualifies. */
const NO_TIMEOUT_WARNING =
  '  and nothing bounds that run: the in-process path is given no timeout, so once a search starts only Ctrl-C ends it';

/**
 * What scoring costs ON THIS MACHINE, measured rather than quoted.
 *
 * The projection to a full pool is labelled as one. It is the same model, the
 * same engine and the same document width scaled linearly, which is what the
 * measurements this backend was accepted on behaved like — but it is arithmetic
 * over two documents, not a run of a hundred, and the wizard says so.
 */
export const timingLines = (elapsedMs: number, documents: number, poolK: number): readonly string[] => {
  const perDoc = elapsedMs / documents;
  const projectedMs = perDoc * poolK;
  return [
    `  scored ${String(documents)} documents of ${String(RERANK_DOC_MAX_CHARS)} characters in ${seconds(elapsedMs)}` +
      ` — about ${String(Math.round(perDoc))} ms each on this machine`,
    `  at that rate a pool of ${String(poolK)} would cost roughly ${seconds(projectedMs)} per search (a projection, not a measured run)`,
    ...(projectedMs >= LONG_PROJECTION_MS ? [NO_TIMEOUT_WARNING] : []),
  ];
};

/** The engine's own verdict on this machine, before anything is written. */
const measureLocal = async (prompter: Prompter, modelPath: string): Promise<boolean> => {
  const health = await rerankHealth({ backend: 'local', modelPath });
  prompter.say([verdictOf({ model: modelPath, health })]);
  if (health.kind !== 'healthy') return false;
  const documents = [sampleDoc(), sampleDoc()];
  const timed = await localRerankScores(modelPath, SAMPLE_QUERY, documents);
  if (timed.ok) prompter.say(timingLines(timed.elapsedMs, documents.length, RERANK_K_INIT));
  return true;
};

/**
 * WHICH of the two ways the downloaded file is run. The engine's absence is
 * stated rather than hidden: a menu that offered an option this checkout cannot
 * take would spend a question to reach an error.
 *
 * The recommendation follows what can actually run HERE. `served` is the shipped
 * default and the measured path, so it leads whenever a llama.cpp server is on
 * PATH; with no server there is nothing to serve the file, and recommending it
 * anyway would point a laptop at an install it did not ask for.
 */
const askRunMode = async (
  prompter: Prompter,
  facts: HardwareFacts,
  hasServer: boolean
): Promise<RunMode> => {
  const availability = await localRerankerAvailability();
  if (!availability.available) {
    prompter.say(['', `  the in-process engine is not installed — \`${LOCAL_RERANKER_INSTALL_COMMAND}\` adds it; serving the file is the only option here`]);
    return 'served';
  }
  prompter.say(['', `  ${facts.gpuName === undefined ? LOCAL_ENGINE_ADVICE.cpu : LOCAL_ENGINE_ADVICE.gpu}`]);
  const choices = hasServer ? RUN_MODE_CHOICES : ordered(RUN_MODE_CHOICES, 'local');
  return await prompter.select(
    'How should the model be run?',
    choices.map(choice => ({
      value: choice.value,
      name: choice.title,
      description: describeChoice(choice),
    })),
    choices.find(choice => choice.recommended === true)?.value
  );
};

/**
 * The recommendation is moved to the top AND marked, rather than only marked: a
 * menu whose pre-selected row is the second one reads as a list the tool has no
 * opinion about. `flow.ts` orders its own menus the same way.
 */
const ordered = (choices: readonly Choice<RunMode>[], first: RunMode): readonly Choice<RunMode>[] => {
  const chosen = choices.find(choice => choice.value === first);
  if (chosen === undefined) return choices;
  return [
    { ...chosen, recommended: true as const },
    ...choices.filter(choice => choice.value !== first).map(({ recommended: _dropped, ...rest }) => rest),
  ];
};

/**
 * The download rung. It ends in a PROBE, never in a download: a served model
 * that answers 200 has proved nothing this project accepts as evidence.
 */
const downloadRung = async (
  prompter: Prompter,
  facts: HardwareFacts,
  places: ServeLocations
): Promise<ProvedRerank | undefined> => {
  prompter.say(note(DOWNLOAD_NOTE));
  const choice = await askWhichModel(prompter, facts);
  const modelPath = await fetchModel(prompter, choice, places.modelsDir);
  if (modelPath === undefined) return undefined;
  const backends = await detectBackends();
  const mode = await askRunMode(prompter, facts, backends.some(backend => backend.kind === 'llama-server'));
  return mode === 'local'
    ? await localRung(prompter, modelPath, choice.model.servedId)
    : await servedRung(prompter, modelPath, choice.model.servedId, places.logPath);
};

/** Serve the file, wait for it, then probe it. A started server is not evidence. */
const servedRung = async (
  prompter: Prompter,
  modelPath: string,
  servedId: string,
  logPath: string
): Promise<ProvedRerank | undefined> => {
  if (!(await serveModel(prompter, modelPath, logPath))) return undefined;
  const url = localBaseUrl(SERVE_PORT);
  const health = await rerankHealth({ baseUrl: url, model: servedId, backend: 'http' });
  prompter.say([verdictOf({ model: servedId, health })]);
  return health.kind === 'healthy' ? { backend: 'http', url, model: servedId } : undefined;
};

/**
 * Load the file in-process, probe it, and time it. The probe is the SAME
 * two-document discrimination probe the served path runs, on the same fixed
 * pair, against the same magnitude floor: a GGUF missing its `cls.output.weight`
 * rank head scores both documents at ~4.5e-23 whether llama.cpp is reached over
 * a socket or linked into this process, and it is directionally right half the
 * time. Configuring on a load that succeeded would be that failure with a
 * progress bar in front of it.
 */
const localRung = async (
  prompter: Prompter,
  modelPath: string,
  servedId: string
): Promise<ProvedRerank | undefined> => {
  prompter.say(['', '  loading it in-process and probing it — a first load takes seconds']);
  return (await measureLocal(prompter, modelPath))
    ? { backend: 'local', modelPath, model: servedId }
    : undefined;
};

const DECLINED: RerankResult = { rerank: undefined, catalogue: [] };

const NOT_CONFIGURED = [
  '',
  '  No reranker was configured. Search still works — you get the first-pass BM25',
  '  ranking — and `dp-gnosis setup` can configure one later without re-running this.',
];

const RERANK_EXPLANATION = [
  'A reranker re-orders the first-pass results with a language model. It is optional, it needs a model, and it is the slow hop — everything below still works without one.',
];

/**
 * Said BEFORE the probe, because the probe is the answer to "what if I already
 * have one?": {@link askRerank} asks {@link candidateUrls} first and only reaches
 * {@link downloadRung} when nothing there discriminates.
 */
const EXISTING_SERVER_NOTE = [
  'Nothing is downloaded until an existing reranker has been ruled out. The addresses below are probed first, and if a model one of them serves passes the two-document discrimination probe, that server is used as it stands.',
  'This is the path for a llama.cpp, llama-swap or Ollama setup you are already running.',
];

/**
 * Said before {@link askWhichModel}, because the download question sounds like an
 * engine question and is not: {@link fetchModel} fetches a file, and only then
 * does {@link askRunMode} ask how to run it.
 */
const DOWNLOAD_NOTE = [
  'Nothing here answered, so a model has to be fetched. What is fetched is a plain `.gguf` model file — it belongs to no engine.',
  'How it RUNS is the next question: a llama.cpp server, or loaded inside the gnosis process. Both are offered when both are possible; when the in-process engine is not installed, serving it is the only option and the wizard says so instead of asking.',
];

/** The whole reranker half: ask, probe, optionally download and serve, then probe again. */
export const askRerank = async (
  prompter: Prompter,
  preference: RerankPreference,
  facts: HardwareFacts,
  places: ServeLocations
): Promise<RerankResult> => {
  prompter.say([...section('Reranking'), ...note(RERANK_EXPLANATION)]);
  prompter.say(['', `  + ${RERANK_ADVICE.pro}`, `  − ${RERANK_ADVICE.con}`]);
  prompter.say(note(EXISTING_SERVER_NOTE));
  if (!(await prompter.confirm('Set up the reranker?', preference.rerank))) return DECLINED;

  prompter.say(['', `  looking for a server on ${candidateUrls().join(' and ')}`]);
  const server = await findServer(candidateUrls());
  const winner = server.ok ? await probeServer(prompter, server.baseUrl, server.models) : undefined;
  const catalogue = server.ok ? server.models : [];
  if (!server.ok) prompter.say([`  nothing answered — tried ${server.tried.join(', ')}`]);

  if (winner !== undefined && server.ok) {
    const proved: ProvedRerank = { backend: 'http', url: server.baseUrl, model: winner.model };
    return { rerank: await accepted(prompter, preference, proved), catalogue };
  }
  const proved = await downloadRung(prompter, facts, places);
  if (proved === undefined) {
    prompter.say(NOT_CONFIGURED);
    return { rerank: undefined, catalogue };
  }
  return { rerank: await accepted(prompter, preference, proved), catalogue };
};

const CHAT_NOTE = [
  '',
  '  The three chat hops are optional and share the reranker’s address. There is no',
  '  probe for a chat model — a reranker can be proved to discriminate, a generator',
  '  cannot — so the wizard will not pick one for you. Choose from what the server',
  '  advertises, or skip and write them into config.json later.',
];

const SKIP = '(skip — leave it unset)';

const askOneModel = async (
  prompter: Prompter,
  label: string,
  catalogue: readonly string[]
): Promise<string | undefined> => {
  const picked = await prompter.select<string>(
    label,
    [{ value: SKIP, name: SKIP }, ...catalogue.map(id => ({ value: id, name: id }))],
    SKIP
  );
  return picked === SKIP ? undefined : picked;
};

/** The three chat ids, each CHOSEN by the user from the catalogue — never guessed. */
export const askChatModels = async (
  prompter: Prompter,
  catalogue: readonly string[]
): Promise<{ readonly rephrase?: string | undefined; readonly synthesize?: string | undefined; readonly enrich?: string | undefined } | undefined> => {
  if (catalogue.length === 0) return undefined;
  prompter.say(CHAT_NOTE);
  if (!(await prompter.confirm('Configure the chat hops now?', false))) return undefined;
  return {
    rephrase: await askOneModel(prompter, 'Model for `search --rephrase`', catalogue),
    synthesize: await askOneModel(prompter, 'Model for `ask --synthesize`', catalogue),
    enrich: await askOneModel(prompter, 'Model for `enrich`', catalogue),
  };
};
