/**
 * The SERVING-path reranker: `search --rerank`, opt-in.
 *
 * Two decisions live here and nowhere else.
 *
 * FUSION, not replacement — the reranked order is RRF-fused with the first-pass
 * order (`src/config.ts`, `RERANK_RRF_K` / `RERANK_RRF_WEIGHT`), because pure
 * reranking measurably regresses MRR while the fused cell improves every
 * metric. A future edit that makes the first-pass term unreachable is a quality
 * regression, not a simplification. The `beir-ce` preset does drop it, but only
 * for a caller that asks for it BY NAME, to reproduce the published BEIR
 * BM25+CE protocol; the default is and stays `shipped`.
 *
 * REFUSAL, not fallback — an endpoint that is down, or up without the model, is
 * reported as a usage failure. Returning unreranked atoms under `--rerank`
 * would make a quality flag lie about what produced the ranking, and no caller
 * could tell the two rankings apart afterwards.
 *
 * The HTTP client is `bench/reranker.ts`'s: one client, one wire format.
 */
import {
  createRerankerClient,
  extractDoc,
  type ExtractStrategy,
  type RerankResult
} from './bench/reranker.js';
import {
  DEFAULT_RERANK_PRESET,
  RERANK_BACKEND_ENV_VAR,
  RERANK_CALIBRATION,
  RERANK_DEFAULT_BACKEND,
  RERANK_DEFAULT_URL,
  RERANK_DOC_MAX_CHARS,
  RERANK_FUSION_PRESETS,
  RERANK_MODEL_ENV_VAR,
  RERANK_MODEL_ID,
  RERANK_PRESET_NAMES,
  RERANK_PROBE_MIN_SCORE,
  RERANK_URL_ENV_VAR,
  type RerankFusion,
  type RerankPresetName
} from './config.js';
import { configHome, statedVar } from './env.js';
import type { RetrievedAtom } from './port.js';
import { asRerankBackend, loadUserConfig, type RerankBackend } from './userConfig.js';

/**
 * The measured extraction, and the DEFAULT a caller that names none gets: the
 * atom's HEAD, `RERANK_DOC_MAX_CHARS` wide. Exported because it decides WHAT the
 * reranker is shown, which the bench stamps on every rerank row — an unstamped
 * move would be subtracted as a like-for-like delta.
 *
 * A caller MAY override both via {@link RerankOptions}; the constant stays the
 * value every recorded run was measured under, so an unset call is bit-identical.
 */
export const EXTRACT_STRATEGY: ExtractStrategy = 'head';

/**
 * Client-side chunking limit, mirroring `DEFAULT_RERANKERS`' `maxBatchTokens`
 * for this model — it is the physical batch llama.cpp serves it with, so a
 * larger request is rejected on the wire rather than ranked.
 */
const MAX_BATCH_TOKENS = 8000;

/** One HTTP call's ceiling. A reranker pass is a foreground CLI wait. */
const TIMEOUT_MS = 60000;

/**
 * The DISCRIMINATION PROBE's own ceiling, deliberately far above `TIMEOUT_MS`.
 * llama-swap loads a model on demand and the first `/v1/rerank` call after an
 * eviction was MEASURED at 1 m 59 s — past the 60 s abort (handbook/GNOSIS-GUIDE.md
 * § Landmines, the cold-reranker row). The probe IS the warm-up that landmine
 * requires before an arm, so it MUST NOT itself time out on a cold load.
 */
const PROBE_TIMEOUT_MS = 300000;

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
const MODELS_PATH = '/v1/models';

/** Which tier supplied a resolved reranker setting — the precedence, made readable. */
export type RerankOrigin = 'flag' | 'env' | 'config' | 'default';

/**
 * A resolved reranker setting WITH the tier that supplied it and the statements
 * it beat, mirroring `paths.ts:DataRootFact`. A value alone cannot say that a
 * `config.json` named another server and lost, which is the whole subject of the
 * diagnostic that reads this.
 */
export interface RerankFact {
  readonly value: string;
  readonly origin: RerankOrigin;
  /** What the environment VARIABLE holds, whether or not it won. */
  readonly stated: string | undefined;
  /** What `config.json` declared, whether or not it won. */
  readonly configured: string | undefined;
}

/**
 * Every statement about one setting, before the precedence is read off them.
 * Generic in the setting's own type so a fact over a CLOSED vocabulary — the
 * backend — keeps that vocabulary instead of widening to `string`.
 */
interface RerankTiers<T extends string> {
  readonly explicit: T | undefined;
  readonly stated: T | undefined;
  readonly configured: T | undefined;
  readonly fallback: T;
}

const factOf = <T extends string>(tiers: RerankTiers<T>): RerankFact & { readonly value: T } => {
  const { stated, configured } = tiers;
  if (tiers.explicit !== undefined) {
    return { value: tiers.explicit, origin: 'flag', stated, configured };
  }
  if (stated !== undefined) return { value: stated, origin: 'env', stated, configured };
  if (configured !== undefined) return { value: configured, origin: 'config', stated, configured };
  return { value: tiers.fallback, origin: 'default', stated, configured };
};

/** The `rerank` section of `config.json`; a malformed one REFUSES from here. */
const rerankConfig = (
  env: NodeJS.ProcessEnv
): Readonly<{ url?: string | undefined; model?: string | undefined; backend?: RerankBackend | undefined }> =>
  loadUserConfig(configHome(env)).rerank ?? {};

/**
 * The base URL to query, resolved `flag > env > config.json > constant`. The
 * `explicit` argument is the option a caller (ultimately a flag) passed; passing
 * `undefined` asks the same question every uninstructed call site asks.
 */
export const rerankUrlFact = (
  explicit: string | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env
): RerankFact =>
  factOf({
    explicit,
    stated: statedVar(env, RERANK_URL_ENV_VAR),
    configured: rerankConfig(env).url,
    fallback: RERANK_DEFAULT_URL,
  });

/** The model id to score under, resolved through the same four tiers. */
export const rerankModelFact = (
  explicit: string | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env
): RerankFact =>
  factOf({
    explicit,
    stated: statedVar(env, RERANK_MODEL_ENV_VAR),
    configured: rerankConfig(env).model,
    fallback: RERANK_MODEL_ID,
  });

/** A resolved backend fact, narrowed to the two names the vocabulary accepts. */
export interface RerankBackendFact extends RerankFact {
  readonly value: RerankBackend;
}

/**
 * The environment's backend, VALIDATED as it is read. An unknown name refuses
 * naming the variable rather than resolving to the shipped default: a user who
 * exported a typo would otherwise be served by a backend they did not select.
 */
const statedBackend = (env: NodeJS.ProcessEnv): RerankBackend | undefined => {
  const stated = statedVar(env, RERANK_BACKEND_ENV_VAR);
  return stated === undefined ? undefined : asRerankBackend(RERANK_BACKEND_ENV_VAR, stated);
};

/** WHICH implementation scores, resolved through the same four tiers. */
export const rerankBackendFact = (
  explicit: RerankBackend | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env
): RerankBackendFact =>
  factOf({
    explicit,
    stated: statedBackend(env),
    configured: rerankConfig(env).backend,
    fallback: RERANK_DEFAULT_BACKEND,
  });

/** The resolved backend alone, so no caller re-spells the precedence. */
export const resolveRerankBackend = (env: NodeJS.ProcessEnv = process.env): RerankBackend =>
  rerankBackendFact(undefined, env).value;

/** The resolved base URL alone — the fact reduced, for every caller that only serves. */
export const resolveRerankUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  rerankUrlFact(undefined, env).value;

/** The resolved model id alone, so no caller re-spells the precedence. */
export const resolveRerankModel = (env: NodeJS.ProcessEnv = process.env): string =>
  rerankModelFact(undefined, env).value;

/** One fused entry: the first-pass item and the score that reordered it. */
export interface FusedItem<T> {
  readonly item: T;
  readonly score: number;
}

type RrfFusion = Extract<RerankFusion, { readonly kind: 'rrf' }>;

const rrfTerm = (rrfK: number, weight: number, rank: number | undefined): number =>
  rank === undefined ? 0 : weight / (rrfK + rank);

/**
 * The two 1-based ranks RRF scores. BOTH are optional because a two-leg fusion
 * has candidates that only one leg returned; the rerank path simply never
 * passes `undefined` for `firstPass`, since every candidate came from it.
 */
interface RrfRanks {
  readonly rerank: number | undefined;
  readonly firstPass: number | undefined;
}

/** One candidate's two 1-based ranks, plus how many the reranker returned. */
interface Ranks extends RrfRanks {
  /** `undefined` when the reranker did not return this candidate. */
  readonly rerank: number | undefined;
  readonly firstPass: number;
  readonly returned: number;
}

const rrfScore = (fusion: RrfFusion, ranks: RrfRanks): number =>
  rrfTerm(fusion.rrfK, fusion.rerankWeight, ranks.rerank) +
  rrfTerm(fusion.rrfK, 1 - fusion.rerankWeight, ranks.firstPass);

/**
 * The replacement score is `1/rank` over the EMITTED order: the fusion sees
 * ranks, not the cross-encoder's raw relevance scores, and a score that did not
 * produce the order it is printed beside would misread in a TREC run file. An
 * index the reranker did not return sorts below every one it did.
 */
const replacementScore = (ranks: Ranks): number =>
  1 / (ranks.rerank ?? ranks.returned + ranks.firstPass);

const fusedScore = (fusion: RerankFusion, ranks: Ranks): number =>
  fusion.kind === 'rrf' ? rrfScore(fusion, ranks) : replacementScore(ranks);

/**
 * Combines the reranked order with the first-pass order under `fusion`.
 *
 * `rerankOrder` lists FIRST-PASS INDICES best-first. An index the reranker did
 * not return is kept — scored from the first pass alone under `rrf`, appended
 * in first-pass order under `replace` — rather than dropped: a candidate that
 * reached the reranker was already retrieved, and losing it here would silently
 * shrink the result.
 */
export const fuseRanking = <T>(
  firstPass: readonly T[],
  rerankOrder: readonly number[],
  fusion: RerankFusion
): readonly FusedItem<T>[] => {
  const rerankRank = new Map(rerankOrder.map((index, position) => [index, position + 1]));
  const scored = firstPass.map((item, index) => ({
    item,
    score: fusedScore(fusion, {
      rerank: rerankRank.get(index),
      firstPass: index + 1,
      returned: rerankOrder.length,
    }),
  }));
  return [...scored].sort((left, right) => right.score - left.score);
};

/**
 * Two ranked orders over ONE pool: `items` is the union, and each leg lists the
 * indices into it that IT returned, best-first. An index a leg did not return
 * contributes nothing from that leg — which is what makes this a union fusion
 * rather than a reordering of one list.
 */
export interface RankedLegs<T> {
  readonly items: readonly T[];
  /** The leg carrying `1 - rerankWeight` — the lexical leg for the hybrid route. */
  readonly primary: readonly number[];
  /** The leg carrying `rerankWeight` — the dense leg for the hybrid route. */
  readonly secondary: readonly number[];
}

const rrfOrRefuse = (fusion: RerankFusion): RrfFusion => {
  if (fusion.kind !== 'rrf') {
    throw new Error(
      'rerank fusion: two-leg fusion is defined for an RRF preset only; a replacement preset ' +
        'would discard one leg entirely, which is not a hybrid.'
    );
  }
  return fusion;
};

const rankOf = (order: readonly number[]): ReadonlyMap<number, number> =>
  new Map(order.map((index, position) => [index, position + 1]));

/**
 * Fuses TWO ranked legs under the same RRF arithmetic `fuseRanking` uses — the
 * hybrid route reuses this file's scoring rather than owning a second fusion.
 * `fuseRanking` is the reranker↔first-pass form, where every candidate is in the
 * first pass by construction; this is the union form, where neither leg is.
 */
export const fuseLegs = <T>(
  legs: RankedLegs<T>,
  fusion: RerankFusion
): readonly FusedItem<T>[] => {
  const rrf = rrfOrRefuse(fusion);
  const primary = rankOf(legs.primary);
  const secondary = rankOf(legs.secondary);
  const scored = legs.items.map((item, index) => ({
    item,
    score: rrfScore(rrf, { rerank: secondary.get(index), firstPass: primary.get(index) }),
  }));
  return [...scored].sort((left, right) => right.score - left.score);
};

/** `undefined` when `name` is not a preset — the caller decides how to refuse. */
const presetOf = (name: string): RerankFusion | undefined =>
  (RERANK_PRESET_NAMES as readonly string[]).includes(name)
    ? RERANK_FUSION_PRESETS[name as RerankPresetName]
    : undefined;

const presetOrRefuse = (name: string): RerankFusion => {
  const preset = presetOf(name);
  if (preset !== undefined) return preset;
  throw new Error(
    `rerank fusion: unknown preset "${name}" — known presets are ${RERANK_PRESET_NAMES.join(', ')}.`
  );
};

const weighted = (fusion: RerankFusion, rerankWeight: number): RerankFusion => {
  if (fusion.kind !== 'rrf') {
    throw new Error(
      `rerank fusion: a weight override applies only to an RRF preset; "beir-ce" has no weight term.`
    );
  }
  return { ...fusion, rerankWeight };
};

/** A raw numeric override on top of a named preset — the parameters stay measurable. */
export interface RerankFusionOverrides {
  readonly rerankWeight?: number | undefined;
}

/**
 * The fusion a NAME selects, with any raw override applied. An unknown name is
 * a usage error, not a fallback to the default: silently reranking under the
 * shipped protocol when `beir-ce` was asked for would publish the wrong number
 * under the right label.
 */
export const resolveRerankFusion = (
  name: string = DEFAULT_RERANK_PRESET,
  overrides: RerankFusionOverrides = {}
): RerankFusion => {
  const preset = presetOrRefuse(name);
  const { rerankWeight } = overrides;
  return rerankWeight === undefined ? preset : weighted(preset, rerankWeight);
};

/** What `rerankAtoms` hands back: a new order, or a message naming the fault. */
export type RerankOutcome =
  | { readonly ok: true; readonly atoms: readonly RetrievedAtom[] }
  | { readonly ok: false; readonly error: string };

/**
 * Where to score, and under which id. The model travels WITH the URL because
 * every refusal message names both: a message that named the shipped id while
 * another was requested would send the reader to fix the wrong entry.
 */
interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

const request = (model: string): string =>
  `search --rerank: reranker model "${model}" was requested`;

const requirement = (model: string): string =>
  ` — llama-swap MUST serve a reranker under the id "${model}"; `;

const DROP = ', or drop --rerank to retrieve without reranking.';

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${requirement(endpoint.model)}start llama-swap on that address, or point ${RERANK_URL_ENV_VAR} at the host that serves it, then re-run${DROP}`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (endpoint: Endpoint, served: readonly string[]): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${requirement(endpoint.model)}add that model to the llama-swap config under exactly that id, then re-run${DROP}`;

/** The rerank call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} accepted GET ${MODELS_PATH} but the rerank call failed (${cause})${requirement(endpoint.model)}check that the id names a RERANKER (a chat model answers /v1/models but not /v1/rerank), then re-run${DROP}`;

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const modelIds = (payload: unknown): readonly string[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []
  );
};

/**
 * What `GET /v1/models` answered: the served ids, or why the call did not
 * complete. Exported because `setup` has to READ the catalogue rather than ask
 * about one id — it selects which ids are worth probing at all.
 */
export type RerankCatalogue =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly cause: string };

type Catalogue = RerankCatalogue;

/**
 * A ceiling for a caller that MUST come back: `doctor` is an offline pass, and
 * the default `127.0.0.1` refuses instantly, but a `DP_GNOSIS_RERANK_URL`
 * pointing at an unreachable HOST would otherwise hang on the connect. The
 * serving path passes none — a slow catalogue there is worth waiting for.
 */
const CATALOGUE_TIMEOUT_MS = 5000;

const catalogueInit = (timeoutMs: number | undefined): RequestInit =>
  timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) };

const fetchCatalogue = async (baseUrl: string, timeoutMs?: number): Promise<Catalogue> => {
  try {
    const response = await fetch(`${baseUrl}${MODELS_PATH}`, catalogueInit(timeoutMs));
    const body = await response.text();
    return response.ok
      ? { ok: true, models: modelIds(JSON.parse(body)) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/**
 * The catalogue at `baseUrl`, under the bounded timeout every diagnostic uses:
 * `setup` walks candidate ADDRESSES, and an unreachable host MUST NOT hang the
 * walk before the next address is tried.
 */
export const rerankCatalogue = async (baseUrl: string): Promise<RerankCatalogue> =>
  await fetchCatalogue(baseUrl, CATALOGUE_TIMEOUT_MS);

/** `undefined` when the model is served; otherwise the message to refuse with. */
const catalogueRefusal = async (
  endpoint: Endpoint,
  timeoutMs?: number
): Promise<string | undefined> => {
  const catalogue = await fetchCatalogue(endpoint.baseUrl, timeoutMs);
  if (!catalogue.ok) return unreachableMessage(endpoint, catalogue.cause);
  return catalogue.models.includes(endpoint.model)
    ? undefined
    : notServedMessage(endpoint, catalogue.models);
};

type ScoreResult =
  | { readonly ok: true; readonly results: readonly RerankResult[] }
  | { readonly ok: false; readonly error: string };

/**
 * WHAT the reranker is shown: how much of an atom body, and which part. It is a
 * pair rather than two loose arguments because the two are only meaningful
 * together — a width without a strategy names no text — and the bench stamps
 * them as one treatment.
 */
interface DocWindow {
  readonly maxChars: number;
  readonly extract: ExtractStrategy;
}

/** One scoring call: already-extracted text, and how long it may take. */
interface ScoreRequest {
  readonly query: string;
  readonly documents: readonly string[];
  /** The probe passes `PROBE_TIMEOUT_MS`; a served pass passes `TIMEOUT_MS`. */
  readonly timeoutMs: number;
}

/** The one wire path to `/v1/rerank`: one client construction, one refusal shape. */
const scoreTexts = async (endpoint: Endpoint, request: ScoreRequest): Promise<ScoreResult> => {
  const client = createRerankerClient(
    endpoint.baseUrl,
    endpoint.model,
    request.timeoutMs,
    MAX_BATCH_TOKENS
  );
  try {
    return { ok: true, results: await client.rerank(request.query, request.documents) };
  } catch (error) {
    return { ok: false, error: callFailedMessage(endpoint, causeOf(error)) };
  }
};

const scoreDocuments = async (
  endpoint: Endpoint,
  query: string,
  atoms: readonly RetrievedAtom[],
  window: DocWindow
): Promise<ScoreResult> =>
  await scoreTexts(endpoint, {
    query,
    documents: atoms.map(atom => extractDoc(atom.body, window.extract, window.maxChars)),
    timeoutMs: TIMEOUT_MS,
  });

const bestFirst = (results: readonly RerankResult[]): readonly number[] =>
  [...results].sort((left, right) => right.relevanceScore - left.relevanceScore).map(r => r.index);

/**
 * What a caller may vary. All five are omissible and each defaults to what the
 * CLI has always done, so an existing two-argument call is unchanged.
 *
 * `model` names the cross-encoder to score with. A caller measuring a second
 * reranker MUST pass it AND record it: two models produce two different
 * rankings, and a run that does not carry the id cannot be told from one that
 * used another model. An unserved id still REFUSES — a wrong model must never
 * degrade into the first-pass order.
 *
 * `rerankDocMaxChars` / `rerankExtract` are WHAT the reranker is shown, and they
 * carry the names the bench stamps on the row so the flag, the option and the
 * provenance field cannot drift apart. A caller varying either MUST record it:
 * the text the cross-encoder scored is not recoverable from the numbers, and two
 * widths with no field on the row read as one treatment.
 */
export interface RerankOptions {
  readonly baseUrl?: string;
  readonly fusion?: RerankFusion;
  readonly model?: string | undefined;
  readonly rerankDocMaxChars?: number | undefined;
  readonly rerankExtract?: ExtractStrategy | undefined;
}

/** The tier-resolved URL and model id, the shipped preset and doc window. */
interface Resolved {
  readonly baseUrl: string;
  readonly fusion: RerankFusion;
  readonly model: string;
  readonly window: DocWindow;
}

const resolved = (options: RerankOptions): Resolved => ({
  baseUrl: rerankUrlFact(options.baseUrl).value,
  fusion: options.fusion ?? RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
  model: rerankModelFact(options.model).value,
  window: {
    maxChars: options.rerankDocMaxChars ?? RERANK_DOC_MAX_CHARS,
    extract: options.rerankExtract ?? EXTRACT_STRATEGY,
  },
});

/**
 * The raw cross-encoder score read as a RELEVANCE PROBABILITY, per the model's
 * measured scale ({@link RERANK_CALIBRATION}).
 *
 * `undefined` is the refusal, and it has three causes, all of them "this number
 * cannot be published as a probability": the model has no measured scale, the
 * datum is not a finite number, or an `identity` model returned a value outside
 * `0…1` — which contradicts the table's own assumption, so the assumption is
 * abandoned for that datum rather than the datum being coerced.
 *
 * Pure: no I/O, no server, no clock. It says how relevant the reranker judged
 * the pair, never whether that is good enough to serve.
 */
const sigmoid = (raw: number): number => 1 / (1 + Math.exp(-raw));

const asProbability = (value: number): number | undefined =>
  value >= 0 && value <= 1 ? value : undefined;

export const calibrate = (model: string, raw: number): number | undefined => {
  const scale = RERANK_CALIBRATION[model];
  if (scale === undefined || !Number.isFinite(raw)) return undefined;
  return scale === 'sigmoid' ? sigmoid(raw) : asProbability(raw);
};

/**
 * Attaches the first-pass score and the RAW cross-encoder score to each atom
 * BEFORE the fusion, so both travel with the atom through the reorder.
 *
 * By identity, deliberately: `fuseRanking` sorts, so the output position no
 * longer names the input index, and a post-fusion lookup by index would attach
 * one atom's cross-encoder score to another — a wrong number that reads as a
 * plausible one. An atom the reranker did not return carries NO `rerankScore`
 * rather than a zero, which would read as "scored, and scored badly".
 */
const withScores = (
  atoms: readonly RetrievedAtom[],
  results: readonly RerankResult[]
): readonly RetrievedAtom[] => {
  const raw = new Map(results.map(result => [result.index, result.relevanceScore]));
  return atoms.map((atom, index) => {
    const rerankScore = raw.get(index);
    return rerankScore === undefined
      ? { ...atom, firstPassScore: atom.score }
      : { ...atom, firstPassScore: atom.score, rerankScore };
  });
};

/**
 * Reorder `atoms` by the fused ranking, carrying the FUSED score on each atom —
 * the score a caller reads must be the one that produced the order it reads.
 *
 * The discrimination gate is NOT here: the bench runs its own before a
 * dataset's first call, and the serving path runs {@link rerankProbeRefusal}.
 * A second gate inside this function would probe twice on the bench path.
 */
export const rerankAtoms = async (
  query: string,
  atoms: readonly RetrievedAtom[],
  options: RerankOptions = {}
): Promise<RerankOutcome> => {
  const { baseUrl, fusion, model, window } = resolved(options);
  const endpoint: Endpoint = { baseUrl, model };
  const refusal = await catalogueRefusal(endpoint);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const scored = await scoreDocuments(endpoint, query, atoms, window);
  if (!scored.ok) return { ok: false, error: scored.error };
  const fused = fuseRanking(withScores(atoms, scored.results), bestFirst(scored.results), fusion);
  return { ok: true, atoms: fused.map(entry => ({ ...entry.item, score: entry.score })) };
};

/**
 * The two-document discrimination probe, fixed so every model is judged on the
 * SAME pair. A retrieval question, one passage that answers it, and one that
 * could not be less related — the shape the manual probes used (the chocolate
 * cake recipe) when they caught jina v3/v3.5 and mxbai.
 */
const PROBE_QUERY = 'how does BM25 rank documents by term frequency and document length';

const PROBE_RELEVANT_DOC =
  'BM25 scores a document by summing, over the query terms it contains, an inverse ' +
  'document frequency weight times a saturating term-frequency factor normalised by ' +
  'document length against the average length of the collection.';

const PROBE_IRRELEVANT_DOC =
  'Chocolate cake: cream the butter with the sugar, beat in the eggs one at a time, ' +
  'fold in the cocoa and flour, and bake for forty minutes at 180 degrees Celsius.';

/** Relevant FIRST, so a model that ignores the document also ignores the order. */
const PROBE_DOCUMENTS: readonly string[] = [PROBE_RELEVANT_DOC, PROBE_IRRELEVANT_DOC];

const PROBE_RELEVANT_INDEX = 0;
const PROBE_IRRELEVANT_INDEX = 1;

/** Both raw probe scores, verbatim as the server returned them. */
interface ProbeScores {
  readonly relevant: number;
  readonly irrelevant: number;
}

/**
 * The three BROKEN signatures seen on llama.cpp b10375. They diagnose
 * differently, so the refusal names which one fired.
 */
type ProbeSignature = 'CONSTANT' | 'INVERTED' | 'DEGENERATE';

const SIGNATURE_DIAGNOSIS: Readonly<Record<ProbeSignature, string>> = {
  DEGENERATE:
    'DEGENERATE — the RELEVANT score is below ' +
    `${String(RERANK_PROBE_MIN_SCORE)}, so the model produced no usable signal at all ` +
    '(the rank head `cls.output.weight` is ABSENT from the GGUF — the ' +
    'mradermacher/Qwen3-Reranker-*-GGUF and DevQuasar/* conversions, upstream ' +
    'ggml-org/llama.cpp#16407). The server still answers HTTP 200 with well-formed ' +
    'numbers around 4.5e-23, so nothing downstream notices; the ordering between two ' +
    'such scores is noise even when it points the right way. Serve a GGUF converted ' +
    'with the official convert_hf_to_gguf.py — gscoppino/Qwen3-Reranker-4B-GGUF-llama_cpp ' +
    'or Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp',
  CONSTANT:
    'CONSTANT — the two scores are IDENTICAL, so the score is invariant to the DOCUMENT ' +
    '(the mxbai-rerank-large-v2 signature). Equal scores leave the first-pass order ' +
    'essentially intact, so a run would report a plausible "reranking barely helped" ' +
    'number instead of failing',
  INVERTED:
    'INVERTED — the IRRELEVANT passage outranked the relevant one (the jina-reranker-v3 ' +
    'signature: an architecture whose rank head this llama.cpp build does not support ' +
    'still answers HTTP 200, with noise)',
};

/**
 * `undefined` when the model discriminates: the relevant score clears
 * {@link RERANK_PROBE_MIN_SCORE} AND beats the irrelevant one.
 *
 * MAGNITUDE is judged FIRST, and that order is load-bearing: a rank-head-less
 * GGUF scores both documents at ~4.5e-23, which is directionally correct half
 * the time. Reading the direction first would call that pair healthy.
 */
const probeSignature = (scores: ProbeScores): ProbeSignature | undefined => {
  if (scores.relevant < RERANK_PROBE_MIN_SCORE) return 'DEGENERATE';
  if (scores.relevant > scores.irrelevant) return undefined;
  return scores.relevant === scores.irrelevant ? 'CONSTANT' : 'INVERTED';
};

/** Quotes both raw scores verbatim — the reader diagnoses from the numbers. */
const probeFailedMessage = (
  endpoint: Endpoint,
  signature: ProbeSignature,
  scores: ProbeScores
): string =>
  `${request(endpoint.model)}; it failed the two-document discrimination probe at ` +
  `${endpoint.baseUrl} (${SIGNATURE_DIAGNOSIS[signature]}). It scored the RELEVANT passage ` +
  `${String(scores.relevant)} and the IRRELEVANT passage ${String(scores.irrelevant)}` +
  `${requirement(endpoint.model)}serve a reranker whose rank head this build supports, ` +
  `then re-run${DROP}`;

const INCOMPLETE_PROBE = 'the response did not score both probe documents';

const scoreAt = (results: readonly RerankResult[], index: number): number | undefined =>
  results.find(result => result.index === index)?.relevanceScore;

/** `undefined` when the server did not return a score for both documents. */
const probeScoresOf = (results: readonly RerankResult[]): ProbeScores | undefined => {
  const relevant = scoreAt(results, PROBE_RELEVANT_INDEX);
  const irrelevant = scoreAt(results, PROBE_IRRELEVANT_INDEX);
  return relevant === undefined || irrelevant === undefined ? undefined : { relevant, irrelevant };
};

/** The probe's verdict: the scores when it discriminates, else the refusal. */
export type RerankProbeOutcome =
  | { readonly ok: true; readonly relevantScore: number; readonly irrelevantScore: number }
  | { readonly ok: false; readonly error: string };

/** The refusal, or the verdict — a call that returned unusable results is a refusal too. */
const probeOutcomeOf = (endpoint: Endpoint, scored: ScoreResult): RerankProbeOutcome => {
  if (!scored.ok) return { ok: false, error: scored.error };
  const scores = probeScoresOf(scored.results);
  return scores === undefined
    ? { ok: false, error: callFailedMessage(endpoint, INCOMPLETE_PROBE) }
    : probeVerdict(endpoint, scores);
};

const probeVerdict = (endpoint: Endpoint, scores: ProbeScores): RerankProbeOutcome => {
  const signature = probeSignature(scores);
  return signature === undefined
    ? { ok: true, relevantScore: scores.relevant, irrelevantScore: scores.irrelevant }
    : { ok: false, error: probeFailedMessage(endpoint, signature, scores) };
};

/**
 * Scores the fixed relevant/irrelevant pair and reports whether the model
 * DISCRIMINATES at all: the relevant score must clear
 * {@link RERANK_PROBE_MIN_SCORE} and must beat the irrelevant one. There is
 * still no minimum GAP — the floor is an absolute magnitude, not a margin.
 *
 * A caller runs this once before trusting an arm. A model that fails it returns
 * HTTP 200 and well-formed numbers, so nothing downstream can notice.
 */
export const probeRerankDiscrimination = async (
  options: RerankOptions = {}
): Promise<RerankProbeOutcome> => {
  const { baseUrl, model } = resolved(options);
  const endpoint: Endpoint = { baseUrl, model };
  const refusal = await catalogueRefusal(endpoint);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const scored = await scoreTexts(endpoint, {
    query: PROBE_QUERY,
    documents: PROBE_DOCUMENTS,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return probeOutcomeOf(endpoint, scored);
};

/**
 * The cause tag a probe refusal carries, mirroring the bench's
 * `dp-gnosis-bench/rerank-probe-failed`: the two gates diagnose the same fault
 * on two paths, and a reader grepping one MUST find the other.
 */
const PROBE_FAILED_CAUSE = 'dp-gnosis/rerank-probe-failed';

const probeRefusal = (error: string): string => `${PROBE_FAILED_CAUSE}: ${error}`;

/** One memo entry per endpoint: the URL and the model both change the verdict. */
const probeKey = (endpoint: Endpoint): string => `${endpoint.baseUrl}\u0000${endpoint.model}`;

/**
 * The per-process probe memo. It holds the PROMISE, not the outcome, so two
 * concurrent first calls share one probe rather than paying the cold load twice.
 */
const probeCache = new Map<string, Promise<RerankProbeOutcome>>();

/**
 * Drops the memo. For tests, which exercise a healthy and a broken server in one
 * process and would otherwise read the first verdict for every later one.
 */
export const resetRerankProbeCache = (): void => {
  probeCache.clear();
};

/** The probe's verdict for `endpoint`, computed at most once per process. */
const probeOnce = (endpoint: Endpoint): Promise<RerankProbeOutcome> => {
  const key = probeKey(endpoint);
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  const pending = probeRerankDiscrimination({ ...endpoint });
  probeCache.set(key, pending);
  return pending;
};

/**
 * The SERVING path's gate: the refusal to report, or `undefined` when this
 * endpoint discriminates and may be scored with. Memoised per process, so the
 * probe is paid once and doubles as the warm-up the cold-load landmine requires
 * (handbook/GNOSIS-GUIDE.md § Landmines) — hence the probe's own long timeout.
 *
 * It is called BEFORE `rerankAtoms`, because a model whose rank head this build
 * cannot use answers HTTP 200 with well-formed numbers: nothing downstream of
 * the scoring call can notice it.
 */
export const rerankProbeRefusal = async (
  options: RerankOptions = {}
): Promise<string | undefined> => {
  const { baseUrl, model } = resolved(options);
  const probe = await probeOnce({ baseUrl, model });
  return probe.ok ? undefined : probeRefusal(probe.error);
};

/**
 * A DIAGNOSTIC's reading of the same probe, with the one distinction the serving
 * path does not need: an endpoint that is not there is not the same finding as
 * an endpoint that is there and broken.
 *
 * `unavailable` is what `doctor` reports as UNKNOWN — reranking is opt-in, so a
 * machine that never served one has no defect to report, and the catalogue call
 * that establishes it is bounded so an offline pass cannot hang on it. `broken`
 * carries the probe's own refusal verbatim; there is no second wording.
 */
export type RerankHealth =
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'broken'; readonly detail: string }
  | { readonly kind: 'healthy'; readonly relevantScore: number; readonly irrelevantScore: number };

const healthOf = (probe: RerankProbeOutcome): RerankHealth =>
  probe.ok
    ? { kind: 'healthy', relevantScore: probe.relevantScore, irrelevantScore: probe.irrelevantScore }
    : { kind: 'broken', detail: probe.error };

/**
 * The catalogue is asked FIRST and separately, because it is the only cheap
 * question: it decides `unavailable` before the probe's own long timeout — which
 * doubles as the cold-load warm-up — is ever entered. The probe itself is
 * memoised per process, so a `doctor` run beside a `search --rerank` pays once.
 */
export const rerankHealth = async (options: RerankOptions = {}): Promise<RerankHealth> => {
  const { baseUrl, model } = resolved(options);
  const endpoint: Endpoint = { baseUrl, model };
  const refusal = await catalogueRefusal(endpoint, CATALOGUE_TIMEOUT_MS);
  if (refusal !== undefined) return { kind: 'unavailable', detail: refusal };
  return healthOf(await probeOnce(endpoint));
};
