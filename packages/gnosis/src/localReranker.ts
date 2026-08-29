/**
 * The IN-PROCESS reranker backend — `rerank.backend: "local"`, scored by
 * `node-llama-cpp` instead of over HTTP.
 *
 * The engine is an OPTIONAL native dependency and is deliberately NOT in
 * `package.json`: the shipped path is the HTTP one, and a user who never
 * installs it must lose nothing. So this module owns exactly one thing today —
 * whether the engine is loadable, and the refusal to report when it is not.
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
 * happened. With no entry, `confidence` honestly reports `weak` and
 * `--min-relevance` refuses by name. An entry may be added only when a
 * calibration has actually been MEASURED against this engine.
 */

/** The optional dependency this backend needs. Not a `package.json` entry. */
export const LOCAL_RERANKER_PACKAGE = 'node-llama-cpp';

/** What the refusal tells the user to run, verbatim. */
export const LOCAL_RERANKER_INSTALL_COMMAND = `npm install ${LOCAL_RERANKER_PACKAGE}`;

/** Whether the local engine loaded, and — when it did not — the whole message. */
export type LocalRerankerAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

type LoadResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The ONLY place `node-llama-cpp` is loaded. The specifier is held in a
 * `string`-typed binding, not written as a literal, so the module is not a
 * build-time dependency of this package — the type checker MUST NOT be asked to
 * resolve a package that is not installed. The result is taken as `unknown`,
 * which keeps the dynamic import off the `any` path.
 */
const loadEngine = async (): Promise<LoadResult> => {
  const specifier: string = LOCAL_RERANKER_PACKAGE;
  try {
    const loaded: unknown = await import(specifier);
    return loaded === undefined || loaded === null
      ? { ok: false, detail: 'the module loaded as nothing' }
      : { ok: true };
  } catch (error: unknown) {
    return { ok: false, detail: describeError(error) };
  }
};

const unavailableMessage = (detail: string): string =>
  `the local rerank backend needs ${LOCAL_RERANKER_PACKAGE}, which did not load (${detail}) — install it with \`${LOCAL_RERANKER_INSTALL_COMMAND}\`, or select the http backend, where --rerank works over HTTP with no local engine at all`;

/** Probes the optional dependency so a caller can report WHY the backend is refused. */
export const localRerankerAvailability = async (): Promise<LocalRerankerAvailability> => {
  const loaded = await loadEngine();
  return loaded.ok ? { available: true } : { available: false, reason: unavailableMessage(loaded.detail) };
};

/**
 * Stated as a refusal, not a fallback: the scoring implementation is not built
 * yet, and answering over the HTTP endpoint instead would hand back a ranking
 * from a backend the caller did not select — a wrong answer that reads exactly
 * like a right one.
 */
const SCORING_UNIMPLEMENTED = `the local rerank backend loaded ${LOCAL_RERANKER_PACKAGE} but scores nothing yet — select the http backend to rerank`;

/**
 * What the SERVING path reports when the local backend is selected. ALWAYS a
 * refusal today, for the reason above; the atoms the caller receives are the
 * first pass, and the run exits PARTIAL rather than claiming a rerank.
 */
export const localRerankRefusal = async (): Promise<string> => {
  const availability = await localRerankerAvailability();
  return availability.available ? SCORING_UNIMPLEMENTED : availability.reason;
};
