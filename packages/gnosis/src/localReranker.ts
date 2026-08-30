/**
 * The IN-PROCESS reranker engine — what `rerank.backend: "local"` scores with.
 *
 * This module knows one thing: how to turn a GGUF file on disk plus a query and
 * some documents into raw cross-encoder scores. It does NOT know which config
 * key names the file, what a good score is, or whether the result may be served.
 * Those are `rerank.ts`'s, and keeping them there is what lets ONE probe, ONE
 * fusion and ONE calibration decision govern both backends.
 *
 * The engine is `node-llama-cpp`, a **devDependency** of this package (ADR
 * 2026-08-29, `docs/research/`): present in a checkout so the suite can exercise
 * the real thing, absent for a consumer, who installs it beside the package the
 * way `OPTIONAL.md` § Enabling them already documents for lancedb. It is the
 * same llama.cpp the served path talks to, so the local backend reranks with the
 * same implementation over the same GGUF files rather than introducing a second,
 * unmeasured scoring stack.
 *
 * The load follows `adapters/lanceDbAdapter.ts:loadLance`, for the reason
 * recorded there: an import of a native module fails in TWO ways — module
 * resolution, and a BINDING error on a platform whose prebuilt binary lags — so
 * a catch narrowed to `MODULE_NOT_FOUND` would hard-fail where it should
 * degrade. Every error class is caught.
 *
 * **The local backend is deliberately UNCALIBRATED.** `RERANK_CALIBRATION`
 * (`config.ts`) is keyed by MODEL ID ALONE, and `confidence` / `--min-relevance`
 * read the probabilities it produces. A local engine's raw scores are a
 * different scale from the served endpoint's for the same model id, so
 * inheriting that entry would report a calibrated probability computed against
 * a scale nothing measured — a plausible number for a measurement that never
 * happened. `rerank.ts:rerankCalibrationKey` therefore returns nothing under
 * this backend: `confidence` honestly reports `weak` and `--min-relevance`
 * refuses by name. An entry may be added only when a calibration has actually
 * been MEASURED against this engine.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import { packageDir } from './paths.js';

/** The optional native engine this backend needs. A devDependency, not a dependency. */
export const LOCAL_RERANKER_PACKAGE = 'node-llama-cpp';

/**
 * The argv {@link installLocalReranker} runs, and the SOURCE of
 * {@link LOCAL_RERANKER_INSTALL_COMMAND}. One owner, so the command a refusal
 * tells the user to run is the command this module would run for them — a
 * second spelling drifts on the first flag either half gains.
 */
const INSTALL_ARGV: readonly string[] = ['install', LOCAL_RERANKER_PACKAGE];

/** What the refusal tells the user to run, verbatim. */
export const LOCAL_RERANKER_INSTALL_COMMAND = `npm ${INSTALL_ARGV.join(' ')}`;

/** Whether the local engine loaded, and — when it did not — the whole message. */
export type LocalRerankerAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * How the engine module is obtained. It is a PARAMETER rather than a hard-wired
 * import so the suite can exercise BOTH states in one process: the engine is a
 * devDependency, so a checkout has it and a consumer does not, and a test that
 * could only observe whichever state the machine happened to be in would cover
 * the consumer's state nowhere.
 */
export type EngineLoader = () => Promise<unknown>;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * The four shapes this module calls, and nothing else the package exports.
 *
 * They are declared HERE rather than imported from `node-llama-cpp` on purpose:
 * the type checker MUST NOT be asked to resolve a package a consumer will not
 * have installed. Each is reached through a type PREDICATE over `unknown`, so
 * an engine whose surface changed is caught as a refusal naming the missing
 * method rather than as a crash inside a call that was never checked.
 */
interface RankingContext {
  readonly rankAll: (query: string, documents: readonly string[]) => Promise<readonly number[]>;
  readonly dispose: () => Promise<void>;
}

interface LoadedModel {
  readonly createRankingContext: () => Promise<unknown>;
  readonly dispose: () => Promise<void>;
}

interface Llama {
  readonly loadModel: (options: { readonly modelPath: string }) => Promise<unknown>;
}

interface Engine {
  readonly getLlama: () => Promise<unknown>;
}

const isEngine = (value: unknown): value is Engine =>
  isRecord(value) && typeof value['getLlama'] === 'function';

const isLlama = (value: unknown): value is Llama =>
  isRecord(value) && typeof value['loadModel'] === 'function';

const isLoadedModel = (value: unknown): value is LoadedModel =>
  isRecord(value) && typeof value['createRankingContext'] === 'function' && typeof value['dispose'] === 'function';

const isRankingContext = (value: unknown): value is RankingContext =>
  isRecord(value) && typeof value['rankAll'] === 'function' && typeof value['dispose'] === 'function';

const isDisposable = (value: unknown): value is { readonly dispose: () => Promise<void> } =>
  isRecord(value) && typeof value['dispose'] === 'function';

/**
 * The ONE place `node-llama-cpp` is loaded. The specifier is held in a
 * `string`-typed binding, not written as a literal, so the module is not a
 * build-time dependency of this package. The result is taken as `unknown`,
 * which keeps the dynamic import off the `any` path.
 */
const importEngine: EngineLoader = async () => {
  const specifier: string = LOCAL_RERANKER_PACKAGE;
  return await import(specifier);
};

type LoadResult = { readonly ok: true; readonly engine: Engine } | { readonly ok: false; readonly detail: string };

const loadEngine = async (load: EngineLoader): Promise<LoadResult> => {
  try {
    const loaded: unknown = await load();
    if (loaded === undefined || loaded === null) return { ok: false, detail: 'the module loaded as nothing' };
    return isEngine(loaded)
      ? { ok: true, engine: loaded }
      : { ok: false, detail: 'the module loaded but exports no getLlama' };
  } catch (error: unknown) {
    return { ok: false, detail: describeError(error) };
  }
};

const unavailableMessage = (detail: string): string =>
  `the local rerank backend needs ${LOCAL_RERANKER_PACKAGE}, which did not load (${detail}) — install it with \`${LOCAL_RERANKER_INSTALL_COMMAND}\`, or select the http backend, where --rerank works over HTTP with no local engine at all`;

/** Probes the optional dependency so a caller can report WHY the backend is refused. */
export const localRerankerAvailability = async (
  load: EngineLoader = importEngine
): Promise<LocalRerankerAvailability> => {
  const loaded = await loadEngine(load);
  return loaded.ok ? { available: true } : { available: false, reason: unavailableMessage(loaded.detail) };
};

/**
 * WHERE the install runs: this package's own directory, from `paths.ts`, which
 * OWNS it. It is not `process.cwd()`, which is the tree the user happened to be
 * standing in when they started the wizard: an engine installed there is an
 * engine this package's import still cannot find, and the wizard would have
 * fetched hundreds of megabytes to change nothing.
 */
export const localRerankerDirectory = (): string => packageDir();

/** What an install did, or the whole reason the engine is still unavailable. */
export type LocalRerankerInstall =
  | { readonly installed: true }
  | { readonly installed: false; readonly reason: string };

/** What the install process reported: its exit code, and what it said about a failure. */
export interface InstallOutcome {
  readonly code: number;
  readonly stderr: string;
}

/**
 * How the install is run. A PARAMETER for the same reason {@link EngineLoader}
 * is one: the real install fetches and builds a native binary, so a suite that
 * used it could exercise exactly one of the outcomes below, on whichever
 * machine happened to run it.
 */
export type InstallRunner = (cwd: string) => Promise<InstallOutcome>;

/** Everything {@link installLocalReranker} takes from a caller, all of it defaulted. */
export interface InstallDeps {
  readonly run?: InstallRunner;
  readonly load?: EngineLoader;
  readonly directory?: string;
}

/**
 * npm is verbose and the default `execFile` buffer is 1 MB, past which the call
 * fails with ENOBUFS — an install that WORKED, reported as a failure. The
 * output is bounded rather than unbounded because it is held in memory.
 */
const INSTALL_OUTPUT_LIMIT = 32 * 1024 * 1024;

/**
 * What a failed `execFile` reported, in the TWO shapes it reports it in.
 *
 * A command that RAN and failed carries a numeric `code` and says why on
 * stderr. A command that never ran at all — npm absent from `PATH`, or named
 * `npm.cmd` on Windows — rejects with `code: 'ENOENT'`, a STRING, and an empty
 * stderr. Reading the numeric field alone turned that into "`npm install
 * node-llama-cpp` exited 1 — it printed nothing on stderr": a real cause
 * reported as a different one, with no remedy the reader can act on. So the
 * spawn error's own text becomes the reason when the process said nothing.
 */
const failureOf = (error: unknown, stderr: string): InstallOutcome =>
  isRecord(error) && typeof error['code'] === 'number'
    ? { code: error['code'], stderr }
    : { code: 1, stderr: stderr.trim() === '' ? describeError(error) : stderr };

const npmInstall: InstallRunner = async cwd =>
  await new Promise<InstallOutcome>(settle => {
    execFile('npm', [...INSTALL_ARGV], { cwd, maxBuffer: INSTALL_OUTPUT_LIMIT }, (error, _stdout, stderr) => {
      settle(error === null ? { code: 0, stderr } : failureOf(error, stderr));
    });
  });

const writable = (directory: string): boolean => {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const notWritableMessage = (directory: string): string =>
  `the local rerank backend would install ${LOCAL_RERANKER_PACKAGE} into ${directory}, which is not writable — install it there as a user who can write it, or select the http backend, which needs no local engine at all`;

const failedMessage = (outcome: InstallOutcome): string =>
  `\`${LOCAL_RERANKER_INSTALL_COMMAND}\` exited ${String(outcome.code)} — ${outcome.stderr.trim() === '' ? 'it printed nothing on stderr' : outcome.stderr.trim()}`;

const stillMissingMessage = (reason: string): string =>
  `\`${LOCAL_RERANKER_INSTALL_COMMAND}\` exited 0, but ${reason}`;

/**
 * The re-probe, and the reason {@link installLocalReranker} is not just a
 * child process: `npm install` exits 0 having written a package whose native
 * binding then fails to load on this platform. Reporting that as installed
 * would be a component that produced nothing, recorded as success.
 */
const verified = async (load: EngineLoader | undefined): Promise<LocalRerankerInstall> => {
  const availability = await localRerankerAvailability(load);
  return availability.available
    ? { installed: true }
    : { installed: false, reason: stillMissingMessage(availability.reason) };
};

const runInstall = async (deps: InstallDeps, directory: string): Promise<LocalRerankerInstall> => {
  const outcome = await (deps.run ?? npmInstall)(directory);
  return outcome.code === 0 ? await verified(deps.load) : { installed: false, reason: failedMessage(outcome) };
};

/**
 * Installs the engine into {@link localRerankerDirectory} and re-probes it.
 *
 * An unwritable target is refused BEFORE npm is started: npm would fail deep
 * inside a fetch it had already paid for, and the honest answer — the engine
 * stays unavailable here — is known beforehand.
 */
export const installLocalReranker = async (deps: InstallDeps = {}): Promise<LocalRerankerInstall> => {
  const directory = deps.directory ?? localRerankerDirectory();
  return writable(directory)
    ? await runInstall(deps, directory)
    : { installed: false, reason: notWritableMessage(directory) };
};

/**
 * One loaded GGUF, kept for the life of the process and keyed by its path.
 *
 * The load is the expensive half — MEASURED at 1 846 ms for
 * `qwen3-reranker-0.6b-q8_0` on Vulkan, 2026-08-29, against a rerank of 100
 * documents in 6 472 ms in the same run. A one-shot `dp-gnosis search` pays it
 * once and exits; a long-lived `dp-gnosis-mcp` pays it once and then never
 * again, which is the whole reason this backend is worth offering at all. The
 * memo holds the PROMISE, so two concurrent first calls share one load rather
 * than loading the file twice.
 *
 * The ranking CONTEXT is deliberately not cached with it. It is the cheap half,
 * and a per-call context means two concurrent queries never share one sequence —
 * a hazard the MCP server, which serves calls in parallel, would otherwise own.
 */
const MODELS = new Map<string, Promise<LoadedModel>>();

const openModel = async (engine: Engine, modelPath: string): Promise<LoadedModel> => {
  const llama = await engine.getLlama();
  if (!isLlama(llama)) throw new Error(`${LOCAL_RERANKER_PACKAGE}'s getLlama returned no loadModel`);
  const model = await llama.loadModel({ modelPath });
  if (!isLoadedModel(model)) throw new Error(`${LOCAL_RERANKER_PACKAGE} loaded ${modelPath} but it has no ranking API`);
  return model;
};

const cachedModel = (engine: Engine, modelPath: string): Promise<LoadedModel> => {
  const held = MODELS.get(modelPath);
  if (held !== undefined) return held;
  const pending = openModel(engine, modelPath);
  MODELS.set(modelPath, pending);
  return pending;
};

const disposeOne = async (model: LoadedModel): Promise<void> => {
  await model.dispose();
};

const released = async (pending: Promise<LoadedModel>): Promise<void> => {
  await pending.then(disposeOne, () => undefined);
};

/**
 * Forgets one entry AND frees what it held.
 *
 * Both halves matter. A load that REJECTED stays in the map as a rejected
 * promise, so every later call would reuse the first failure instead of
 * retrying a file the user has since corrected; and a load that SUCCEEDED holds
 * VRAM that nothing else will release inside a long-lived process.
 */
const evict = async (modelPath: string): Promise<void> => {
  const held = MODELS.get(modelPath);
  MODELS.delete(modelPath);
  if (held !== undefined) await released(held);
};

/**
 * Drops every loaded model and frees what it held. For tests, which load a real
 * GGUF and would otherwise leave the native handle open when the run ends.
 */
export const resetLocalRerankerCache = async (): Promise<void> => {
  const held = [...MODELS.values()];
  MODELS.clear();
  await Promise.all(held.map(released));
};

/**
 * The raw scores, index-aligned with `documents`, and how long the scoring took.
 *
 * The elapsed time is returned rather than logged because it is the only honest
 * answer to "is this machine fast enough?": per-document cost spans more than an
 * order of magnitude between a GPU and a CPU, so a constant quoted from one
 * machine forecasts nothing about another. The wizard measures it on the machine
 * in front of it and shows the user that number.
 */
export type LocalScoreOutcome =
  | { readonly ok: true; readonly scores: readonly number[]; readonly elapsedMs: number }
  | { readonly ok: false; readonly error: string };

const scoreFailed = (modelPath: string, cause: string): string =>
  `the local rerank backend could not score with ${modelPath} (${cause})`;

const scoreCount = (modelPath: string, got: number, wanted: number): string =>
  scoreFailed(modelPath, `it returned ${String(got)} scores for ${String(wanted)} documents`);

const usableScores = (scores: readonly number[]): boolean =>
  scores.every(score => Number.isFinite(score));

/**
 * A context that CREATED but does not rank still holds its own native
 * allocation, so it is released before the refusal returns: the MCP server
 * process outlives many searches, and a leak per refused call accumulates in it.
 */
const noRankAll = async (modelPath: string, context: unknown): Promise<LocalScoreOutcome> => {
  if (isDisposable(context)) await context.dispose();
  return { ok: false, error: scoreFailed(modelPath, 'the model exposes no rankAll') };
};

/**
 * Scores `documents` against `query` with the GGUF at `modelPath`. It reports a
 * refusal for every failure class — an absent engine, an unloadable file, a
 * short or non-finite result — and never a partial ranking: a rerank that lost
 * documents on the way back would silently drop candidates the first pass found.
 */
export const localRerankScores = async (
  modelPath: string,
  query: string,
  documents: readonly string[],
  load: EngineLoader = importEngine
): Promise<LocalScoreOutcome> => {
  const loaded = await loadEngine(load);
  if (!loaded.ok) return { ok: false, error: unavailableMessage(loaded.detail) };
  try {
    const model = await cachedModel(loaded.engine, modelPath);
    const context = await model.createRankingContext();
    if (!isRankingContext(context)) return await noRankAll(modelPath, context);
    const started = Date.now();
    const release = async (): Promise<void> => {
      await context.dispose();
    };
    const scores = await context.rankAll(query, documents).finally(release);
    const elapsedMs = Date.now() - started;
    if (scores.length !== documents.length) return { ok: false, error: scoreCount(modelPath, scores.length, documents.length) };
    return usableScores(scores)
      ? { ok: true, scores, elapsedMs }
      : { ok: false, error: scoreFailed(modelPath, 'it returned a score that is not a finite number') };
  } catch (error: unknown) {
    await evict(modelPath);
    return { ok: false, error: scoreFailed(modelPath, describeError(error)) };
  }
};
