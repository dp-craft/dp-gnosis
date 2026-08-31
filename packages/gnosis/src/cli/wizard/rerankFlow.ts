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

import { RERANK_DEFAULT_URL, RERANK_DOC_MAX_CHARS, RERANK_K_INIT } from '../../config.js';
import {
  installLocalReranker,
  LOCAL_RERANKER_INSTALL_COMMAND,
  localRerankerAvailability,
  localRerankerDirectory,
  localRerankScores
} from '../../localReranker.js';
import { rerankHealth, resolveRerankUrl } from '../../rerank.js';
import type { Probed } from '../rerankSetup.js';
import { candidateUrls, findServer, passed, probeCandidates, selectCandidates } from '../rerankSetup.js';
import type { Choice, RunMode } from './advice.js';
import { describeChoice, LOCAL_ENGINE_ADVICE, poolChoices, RERANK_ADVICE, RUN_MODE_CHOICES } from './advice.js';
import { detectBackends, localBaseUrl, portTaken, serveCommand, startServer, waitForServer } from './backend.js';
import { downloadFile, hfGgufFiles } from './download.js';
import type { HardwareFacts } from './hardware.js';
import type { Quant, RerankerModel } from './models.js';
import { GIB, recommendedModel, recommendedQuant, WORKING_MODELS } from './models.js';
import type { RerankAnswer } from './plan.js';
import type { Option, Prompter } from './prompts.js';
import { note, section } from './screen.js';

/**
 * The port `RERANK_DEFAULT_URL` names, and what a wizard-started server binds.
 * DERIVED from that constant rather than restated beside it, because
 * {@link PORT_TAKEN} tells the user the two are the same address — a second
 * spelling would let that sentence become false without anything saying so.
 */
const SERVE_PORT = Number(new URL(RERANK_DEFAULT_URL).port);

/**
 * What is offered when {@link SERVE_PORT} is taken — the next port up. It is a
 * SUGGESTION: {@link askPort} re-asks with the NEXT one each time, so answering
 * by pressing Enter walks up the range instead of re-submitting a taken port.
 */
const ALTERNATE_SERVE_PORT = SERVE_PORT + 1;

/** The last port a socket can bind. A typed number outside 1..this is re-asked, never coerced. */
const MAX_TCP_PORT = 65535;

/** Whole-number percent, for the one progress line. */
const PERCENT = 100;

/** How long a freshly started server is given to answer. A cold load is minutes, not seconds. */
const START_TIMEOUT_MS = 240_000;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GB`;

/**
 * Every id ONE server advertises, AND the address that advertised them.
 *
 * The two travel together because the ids alone are not usable: `plan.ts`
 * writes a chat id with no address of its own, and `rephrase.ts` reads the
 * RERANKER's address, so an id harvested from Ollama and written on its own
 * configures three hops against an address that does not serve them — and
 * nothing records that as wrong.
 */
export interface Catalogue {
  readonly baseUrl: string;
  readonly models: readonly string[];
}

/** What the reranker half produced, plus the catalogue the chat step reuses. */
export interface RerankResult {
  readonly rerank: RerankAnswer | undefined;
  /** What a server advertised, or nothing when none answered. */
  readonly catalogue: Catalogue | undefined;
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

/**
 * The ONE server search, and the ONE way its outcome is reported. Both halves
 * of this file run it — the reranker probe, and the chat step's second look —
 * and two spellings of "nothing answered" is two owners of what was tried.
 */
const searchForServer = async (prompter: Prompter): Promise<Catalogue | undefined> => {
  prompter.say(['', `  looking for a server on ${candidateUrls().join(' and ')}`]);
  const server = await findServer(candidateUrls());
  if (server.ok) return { baseUrl: server.baseUrl, models: server.models };
  prompter.say([`  nothing answered — tried ${server.tried.join(', ')}`]);
  return undefined;
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

/** The file to serve, where its output goes, and what it will be called once probed. */
interface ServeRequest {
  readonly modelPath: string;
  readonly servedId: string;
  readonly logPath: string;
}

/** A whole number a socket can actually bind, or nothing — a bad answer is re-asked. */
const legalPort = (typed: string): number | undefined => {
  const port = Number(typed);
  return Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : undefined;
};

const PORT_QUESTION = 'Which port should the new llama.cpp server bind? (empty: do not serve it)';

/** What an empty answer means, said back so the exit is not silent. */
const PORT_DECLINED = ['', '  Nothing was served, so nothing was proved and no reranker is configured from this file.'];

/** Said only of a port that ANSWERS — which is what makes it the reranker's. */
const SERVED_HERE =
  '  That is the address `RERANK_DEFAULT_URL` names, which is where a reranker found by the search above is served.';

/**
 * Why the port is checked BEFORE anything is served.
 *
 * {@link SERVE_PORT} is the port `RERANK_DEFAULT_URL` names, so it is the port a
 * reranker found by the search above is served on. Serving into it anyway is not
 * an error the user would see: `startServer` reports `alreadyServing`, the wait
 * passes against the OTHER server, and the probe then asks that server for the
 * freshly downloaded model's id — which it does not serve. The result is a
 * failed probe paid for with a multi-gigabyte download.
 *
 * Occupancy itself is `portTaken`'s BIND answer (`backend.ts`, which owns
 * ports and serving); the HTTP probe survives
 * only to word this line. A port that answers `/v1/models` is the reranker
 * address {@link SERVED_HERE} describes; a port merely bound is something else
 * entirely, and telling the two apart is the difference between an explanation
 * and a guess.
 */
const PORT_TAKEN = (port: number, serving: boolean): readonly string[] => [
  '',
  `  ${String(port)} is already ${serving ? 'answering' : 'bound by another process'}, so a second server cannot bind it.`,
  ...(serving ? [SERVED_HERE] : []),
  '  The new server therefore needs a port of its own, and the config records the port the model is actually served on.',
];

/** The next port to OFFER after one that could not be bound — never the same one again. */
const nextPort = (port: number): number => Math.min(port + 1, MAX_TCP_PORT);

const checkedPort = async (prompter: Prompter, typed: string, suggested: number): Promise<number | undefined> => {
  const port = legalPort(typed);
  if (port === undefined) {
    prompter.say([`  that is not a port — it has to be a whole number between 1 and ${String(MAX_TCP_PORT)}`]);
    return await askPort(prompter, suggested);
  }
  if (!(await portTaken(port))) return port;
  prompter.say([`  ${String(port)} cannot be bound either, so nothing new can serve there`]);
  return await askPort(prompter, nextPort(port));
};

/**
 * The port to serve on, or nothing at all.
 *
 * Both branches used to re-ask with the SAME suggestion, so on a machine where
 * the offered port was also taken, pressing Enter re-submitted it forever and
 * the only way out was Ctrl-C — which discards the download that has already
 * been paid for. So a taken port advances the suggestion, and an empty answer
 * leaves, which the question text states.
 */
const askPort = async (prompter: Prompter, suggested: number): Promise<number | undefined> => {
  const typed = (await prompter.input(PORT_QUESTION, String(suggested))).trim();
  if (typed === '') {
    prompter.say(PORT_DECLINED);
    return undefined;
  }
  return await checkedPort(prompter, typed, suggested);
};

/** {@link SERVE_PORT} when it is free — otherwise the port the user names. */
const resolvePort = async (prompter: Prompter): Promise<number | undefined> => {
  if (!(await portTaken(SERVE_PORT))) return SERVE_PORT;
  prompter.say(PORT_TAKEN(SERVE_PORT, await waitForServer(localBaseUrl(SERVE_PORT), 0)));
  return await askPort(prompter, ALTERNATE_SERVE_PORT);
};

/** Start a detected llama.cpp server over the downloaded file on `port`, and wait for it. */
const serveModel = async (prompter: Prompter, request: ServeRequest, port: number): Promise<boolean> => {
  const rendered = serveCommand(request.modelPath, port).rendered;
  const backends = await detectBackends();
  if (!backends.some(backend => backend.kind === 'llama-server')) {
    prompter.say(NO_BACKEND(rendered));
    return false;
  }
  if (!(await prompter.confirm(`Start it now?  ${rendered}`, true))) return false;
  const started = await startServer(request.modelPath, port, request.logPath);
  if (!started.ok) {
    prompter.say([`  could not start it: ${started.error}`]);
    return false;
  }
  prompter.say(startedLines(started, request.logPath));
  return await waitForServer(localBaseUrl(port), START_TIMEOUT_MS);
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
 * What an install would cost, stated BEFORE the question that starts it.
 *
 * The size is one machine's MEASUREMENT — `du -sh node_modules/node-llama-cpp`
 * in this checkout on 2026-08-30 — and is labelled as one: the package fetches
 * a prebuilt native binary for the platform it lands on, so another machine's
 * figure differs. Quoting it unlabelled would be a remembered number presented
 * as this user's.
 *
 * The size is not the whole cost: the command also REWRITES the `package.json`
 * in that directory, which the note owes the user before a `no`-defaulted
 * prompt. Why the flags are spelled that way belongs to
 * `localReranker.ts:INSTALL_ARGV`, not here.
 */
const installNote = (directory: string): readonly string[] => [
  '',
  `  \`${LOCAL_RERANKER_INSTALL_COMMAND}\` would run in ${directory}, which is where this package imports the engine from.`,
  '  It fetches and builds a native llama.cpp binary — 764 MB on disk in the checkout this was measured in, and different on another platform.',
  '  It also records the engine as a dependency of the package there, so it rewrites that `package.json`, and skips the development-only ones — which is why it fetches the engine and not the vector database listed beside it.',
];

const INSTALL_DONE = ['', '  the engine installed and loaded — the in-process option is available'];

/**
 * Offers the install, and REPORTS what came back rather than assuming it.
 *
 * The reason is the probe's own: it names what actually failed, which an
 * install repairs only when the package was absent. `installLocalReranker`
 * re-probes after npm exits, so a `true` here means the engine LOADED, never
 * that a command exited 0.
 *
 * The confirmation opens on `no`. An install this size on a stray Enter is a
 * decision the wizard would have made for the user.
 */
const offerInstall = async (prompter: Prompter, reason: string): Promise<boolean> => {
  prompter.say(['', `  ${reason}`, ...installNote(localRerankerDirectory())]);
  if (!(await prompter.confirm(`Run \`${LOCAL_RERANKER_INSTALL_COMMAND}\` now?`, false))) return false;
  prompter.progress(`  running ${LOCAL_RERANKER_INSTALL_COMMAND} — this takes a few minutes`);
  const outcome = await installLocalReranker();
  prompter.say(outcome.installed ? INSTALL_DONE : ['', `  ${outcome.reason}`]);
  return outcome.installed;
};

/** Whether the in-process engine can run here — after offering to make it so. */
const localEngineUsable = async (prompter: Prompter): Promise<boolean> => {
  const availability = await localRerankerAvailability();
  return availability.available || (await offerInstall(prompter, availability.reason));
};

const SERVED_ONLY = ['', '  serving the file is the only option here'];

/**
 * Both routes are dead, said BEFORE anything is fetched.
 *
 * The order used to be download-then-decide, so a machine with no
 * `llama-server` on PATH and no loadable engine paid for the whole file and was
 * then told `SERVED_ONLY` ("serving it is the only option") immediately
 * followed by `NO_BACKEND` ("the model cannot be started from here") — two
 * contradictory statements about a dead end that was knowable beforehand.
 */
const NO_ROUTE: readonly string[] = [
  '',
  '  Nothing here can run a model file: no llama.cpp server is on PATH, and the in-process engine did not load.',
  `  Install llama.cpp (or llama-swap), or \`${LOCAL_RERANKER_INSTALL_COMMAND}\`, then re-run the wizard.`,
  '  Nothing was downloaded — a multi-gigabyte file with nothing to run it is a cost with no result.',
];

/**
 * The menu itself. The recommendation follows what can actually run HERE:
 * `served` is the shipped default and the measured path, so it leads whenever a
 * llama.cpp server is on PATH; with no server there is nothing to serve the
 * file, and recommending it anyway would point a laptop at an install it did
 * not ask for.
 */
const chooseRunMode = async (
  prompter: Prompter,
  facts: HardwareFacts,
  hasServer: boolean
): Promise<RunMode> => {
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
 * WHICH of the two ways the downloaded file is run — asked only once the
 * in-process engine is known to work. A menu offering an option this machine
 * cannot take would spend a question to reach an error.
 */
const askRunMode = async (
  prompter: Prompter,
  facts: HardwareFacts,
  hasServer: boolean
): Promise<RunMode | undefined> => {
  if (await localEngineUsable(prompter)) return await chooseRunMode(prompter, facts, hasServer);
  if (!hasServer) {
    prompter.say(NO_ROUTE);
    return undefined;
  }
  prompter.say(SERVED_ONLY);
  return 'served';
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
const resolveRunMode = async (prompter: Prompter, facts: HardwareFacts): Promise<RunMode | undefined> => {
  const backends = await detectBackends();
  return await askRunMode(prompter, facts, backends.some(backend => backend.kind === 'llama-server'));
};

const downloadRung = async (
  prompter: Prompter,
  facts: HardwareFacts,
  places: ServeLocations,
  intro: readonly string[] = DOWNLOAD_NOTE
): Promise<ProvedRerank | undefined> => {
  prompter.say(note(intro));
  const choice = await askWhichModel(prompter, facts);
  const mode = await resolveRunMode(prompter, facts);
  return mode === undefined ? undefined : await runChosen(prompter, places, { mode, choice });
};

/** Everything decided before a byte is spent: which file, and which engine runs it. */
interface DownloadPlan {
  readonly mode: RunMode;
  readonly choice: { readonly model: RerankerModel; readonly quant: Quant };
}

/** Fetch the file the plan names, then hand it to the engine the plan named. */
const runChosen = async (
  prompter: Prompter,
  places: ServeLocations,
  plan: DownloadPlan
): Promise<ProvedRerank | undefined> => {
  const modelPath = await fetchModel(prompter, plan.choice, places.modelsDir);
  if (modelPath === undefined) return undefined;
  const servedId = plan.choice.model.servedId;
  return plan.mode === 'local'
    ? await localRung(prompter, modelPath, servedId)
    : await servedRung(prompter, { modelPath, servedId, logPath: places.logPath });
};

/** Serve the file, wait for it, then probe it. A started server is not evidence. */
const servedRung = async (prompter: Prompter, request: ServeRequest): Promise<ProvedRerank | undefined> => {
  const port = await resolvePort(prompter);
  if (port === undefined) return undefined;
  if (!(await serveModel(prompter, request, port))) return undefined;
  const url = localBaseUrl(port);
  const model = request.servedId;
  const health = await rerankHealth({ baseUrl: url, model, backend: 'http' });
  prompter.say([verdictOf({ model, health })]);
  return health.kind === 'healthy' ? { backend: 'http', url, model } : undefined;
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

const DECLINED: RerankResult = { rerank: undefined, catalogue: undefined };

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
 * What the two download routes SHARE, stated once.
 *
 * They differ in ONE clause: the route taken while a server IS answering cannot
 * open with "Nothing here answered", because a server answered, passed the
 * probe, and was declined. Everything after that opening is the same shape — a
 * file is fetched, and how it runs is a separate question — so it is written
 * once and both openings are passed in.
 */
const fetchNote = (opening: string): readonly string[] => [
  `${opening} What is fetched is a plain \`.gguf\` model file — it belongs to no engine.`,
  'How it RUNS is the next question, and it is asked BEFORE the download: a llama.cpp server, or loaded inside the gnosis process. Nothing is written until the file has passed the same two-document discrimination probe a found server would have to pass.',
];

const OWN_NOTE = fetchNote('Setting up your own reranker starts with a model file.');

const DOWNLOAD_NOTE = fetchNote('Nothing here answered, so a model has to be fetched.');

/** A server-served model that PASSED the probe: where it is, and what it is called. */
interface FoundServer {
  readonly url: string;
  readonly model: string;
}

/** Which of the two proved routes the user takes when one is ALREADY running. */
type AdoptChoice = 'server' | 'own';

/**
 * The second row: fetch a model, then answer how it runs.
 *
 * Its pro and con are the ROUTE's own. They used to be READ from
 * {@link RUN_MODE_CHOICES}'s `local` entry, which was right while this row
 * forced the in-process engine and is wrong now that it leads to
 * {@link askRunMode} like every other download. The per-engine tradeoffs stay
 * stated once, in `advice.ts`, and are shown on the menu that actually decides
 * between the engines — quoting them here would describe a commitment this row
 * no longer makes.
 */
const OWN_ROW: Choice<AdoptChoice> = {
  value: 'own',
  title: 'Set up my own reranker instead — download a model and choose how it runs',
  when: 'Pick this only if you would rather gnosis carried its own reranker than depended on that server.',
  pro: 'the model is fetched and configured here, so reranking stops depending on a server this wizard did not start',
  con: 'it downloads a multi-gigabyte file first, and which engine runs it is a further question with tradeoffs of its own',
};

/**
 * The menu a PASSING server opens. It is a question rather than an adoption
 * because the wizard cannot know whose server that is — but the recommendation
 * is not neutral: the found endpoint has just discriminated on this machine, it
 * is the shipped `RERANK_DEFAULT_BACKEND`, and it is the path every recorded
 * baseline in `handbook/GNOSIS-BASELINES.md` was measured on.
 */
const adoptChoices = (found: FoundServer): readonly Choice<AdoptChoice>[] => [
  {
    value: 'server',
    title: `Use ${found.model}, already running at ${found.url}`,
    when: 'Pick this unless you have a reason not to.',
    pro: 'it has just passed the two-document discrimination probe on this machine, it is the shipped default backend, and it is the path every recorded measurement of gnosis was made on',
    con: 'gnosis does not own that server, so a server that stops takes reranking with it until you start it again',
    recommended: true,
  },
  OWN_ROW,
];

const OWN_INCOMPLETE = [
  '',
  '  Your own reranker was not set up, so nothing was proved on that route.',
];

/**
 * The download route, taken with a proved server still in hand — which is why a
 * failure here does NOT fall through to no reranker. Dropping to the first-pass
 * ranking after the user asked for a better one, while a passing endpoint was
 * sitting there, would be a downgrade nobody chose.
 */
const ownInstead = async (
  prompter: Prompter,
  facts: HardwareFacts,
  places: ServeLocations,
  found: FoundServer
): Promise<ProvedRerank | undefined> => {
  const proved = await downloadRung(prompter, facts, places, OWN_NOTE);
  if (proved !== undefined) return proved;
  prompter.say(OWN_INCOMPLETE);
  return (await prompter.confirm(`Use ${found.model} at ${found.url} instead?`, true))
    ? { backend: 'http', url: found.url, model: found.model }
    : undefined;
};

/**
 * What happens when a served model PASSES: the user is ASKED, never adopted for.
 * A reranker that answers on this machine may be one this project started, one
 * the user runs for something else, or one they would rather gnosis did not
 * depend on — and only they know which.
 *
 * Both rows are offered unconditionally. The second one used to be withheld
 * where the in-process engine was absent, which was right while it FORCED that
 * engine; it now downloads a file and asks {@link askRunMode} how to run it, and
 * serving that file needs no local engine at all. Withholding it hid a route
 * this machine can take.
 */
const askFound = async (
  prompter: Prompter,
  facts: HardwareFacts,
  places: ServeLocations,
  found: FoundServer
): Promise<ProvedRerank | undefined> => {
  const choices = adoptChoices(found);
  const picked = await prompter.select<AdoptChoice>(
    'A working reranker is already running. Use it, or set up your own?',
    choices.map(choice => ({ value: choice.value, name: choice.title, description: describeChoice(choice) })),
    'server'
  );
  return picked === 'server'
    ? { backend: 'http', url: found.url, model: found.model }
    : await ownInstead(prompter, facts, places, found);
};

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

  const catalogue = await searchForServer(prompter);
  const winner = catalogue === undefined ? undefined : await probeServer(prompter, catalogue.baseUrl, catalogue.models);
  const found = winner === undefined || catalogue === undefined ? undefined : { url: catalogue.baseUrl, model: winner.model };
  const proved =
    found === undefined
      ? await downloadRung(prompter, facts, places)
      : await askFound(prompter, facts, places, found);
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

/** What the three questions produce; every id is the user's own pick. */
interface ChatModels {
  readonly rephrase?: string | undefined;
  readonly synthesize?: string | undefined;
  readonly enrich?: string | undefined;
}

const chatHops = async (prompter: Prompter, catalogue: readonly string[]): Promise<ChatModels | undefined> => {
  prompter.say(CHAT_NOTE);
  if (!(await prompter.confirm('Configure the chat hops now?', false))) return undefined;
  return {
    rephrase: await askOneModel(prompter, 'Model for `search --rephrase`', catalogue),
    synthesize: await askOneModel(prompter, 'Model for `ask --synthesize`', catalogue),
    enrich: await askOneModel(prompter, 'Model for `enrich`', catalogue),
  };
};

/**
 * Why an empty catalogue is a question rather than an exit.
 *
 * The catalogue is empty in TWO cases: nothing answered the reranker search, and
 * the reranker was declined outright — in which case nothing was ever probed. So
 * the wording claims no failed probe; the re-probe below reports what it finds.
 * The case this exists for is the ordinary one: the server had not been started
 * when the reranker section ran, and the three chat hops then vanished with no
 * line of output at all.
 */
const NO_CATALOGUE = [
  '',
  '  So far no server has advertised a model catalogue, and there is nothing to',
  '  choose a chat model from — `search --rephrase`, `ask --synthesize` and',
  '  `enrich` would stay unset. Starting one now and looking again is enough.',
];

const NOTHING_YET = ['', '  Still nothing to choose from.'];

/** What the second look found, reported as {@link askRerank} reports the first. */
const lookAgain = async (prompter: Prompter): Promise<Catalogue | undefined> => {
  const found = await searchForServer(prompter);
  if (found === undefined) return undefined;
  prompter.say([`  ${found.baseUrl} answered with ${String(found.models.length)} models`]);
  return found;
};

/**
 * The user's own answer bounds this, so there is no attempt counter: the first
 * offer opens on yes, every later one on NO, so pressing Enter leaves.
 */
const retryCatalogue = async (prompter: Prompter, initial: boolean): Promise<Catalogue | undefined> => {
  if (!(await prompter.confirm('Look for a server again?', initial))) return undefined;
  const found = await lookAgain(prompter);
  if (found !== undefined && found.models.length > 0) return found;
  prompter.say(NOTHING_YET);
  return await retryCatalogue(prompter, false);
};

/**
 * The address the three chat hops will read ONCE THIS PLAN IS WRITTEN.
 *
 * They resolve the RERANKER's endpoint through `rerank.ts:resolveRerankUrl` —
 * the one owner of the documented `flag > env > config.json > constant`
 * precedence. But this interview is choosing that endpoint right now, so the
 * pre-run resolution is the WRONG address to guard against: the probe can find
 * a server on one port while the reranker the user then downloaded is served on
 * another, and comparing the catalogue against the stale value passes ids the
 * hops will never reach.
 *
 * An `http` answer becomes `rerank.url` in config.json (`plan.ts:rerankPatch`),
 * so it IS what the hops will resolve. A `local` answer writes `backend` and
 * `modelPath` and no url at all, and a declined reranker writes nothing, so in
 * both of those the url tier is untouched and today's resolution still holds.
 */
const chatAddress = (rerank: RerankAnswer | undefined): string =>
  rerank?.backend === 'http' ? rerank.url : resolveRerankUrl();

/**
 * Why a catalogue from another address is refused rather than offered.
 *
 * The ids are real and the server is real; what is missing is any way to write
 * WHERE they are served. `plan.ts` writes `rephrase` / `synthesize` / `enrich`
 * as bare ids and every chat hop resolves the reranker's address, so offering
 * an Ollama id here would configure three hops against a port that does not
 * serve it — a component producing nothing, recorded as configuration.
 */
const OTHER_ADDRESS = (baseUrl: string, address: string): readonly string[] => [
  '',
  `  Those models are served by ${baseUrl}, but the chat hops read ${address} — they share the reranker's address and carry none of their own.`,
  '  Choosing one would write an id against an address that does not serve it, so the three hops are left unset instead.',
  `  Serve a chat model on ${address}, or write \`models\` into config.json by hand.`,
];

/** The three questions, but only over ids the chat hops will actually reach. */
const offerFrom = async (prompter: Prompter, found: Catalogue, address: string): Promise<ChatModels | undefined> => {
  if (found.models.length === 0) return undefined;
  if (found.baseUrl !== address) {
    prompter.say(OTHER_ADDRESS(found.baseUrl, address));
    return undefined;
  }
  return await chatHops(prompter, found.models);
};

/**
 * The three chat ids, each CHOSEN by the user from the catalogue — never guessed.
 *
 * The whole {@link RerankResult} is carried in rather than its catalogue alone:
 * the catalogue says where the ids CAME from and the answer says where the hops
 * will LOOK, and the guard is the comparison of the two. Passing the catalogue
 * by itself is what let ids from the probe's address be offered while the
 * downloaded reranker was serving on a different one.
 */
export const askChatModels = async (
  prompter: Prompter,
  result: RerankResult
): Promise<ChatModels | undefined> => {
  if (result.catalogue === undefined) prompter.say(NO_CATALOGUE);
  const found = result.catalogue ?? (await retryCatalogue(prompter, true));
  return found === undefined ? undefined : await offerFrom(prompter, found, chatAddress(result.rerank));
};
