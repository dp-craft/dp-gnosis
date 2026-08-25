/**
 * The SERVING-path query rewriter: `retrieve --rephrase`, opt-in.
 *
 * Three decisions live here and nowhere else.
 *
 * OPT-IN, not always-on — with the flag absent this module is never imported
 * into a decision: the retrieval path stays byte-identical to the one every
 * recorded number was measured on. A rewrite is a second network hop and a
 * second failure surface, and it MUST NOT be paid by a caller who did not ask.
 *
 * REFUSAL, not fallback — a rewriter that is down, unserved, or that answered
 * with nothing usable is reported. The CLI still retrieves with the RAW query,
 * but as a PARTIAL run carrying the refusal: `--rephrase` is a quality claim,
 * and a silently skipped rewrite would make it a false one.
 *
 * CACHED ON DISK, keyed by `(model, prompt version, query)` — the same three
 * inputs that determine the answer. A cache that outlived a prompt change would
 * serve the old prompt's rewrites with a fresh mtime, the stale-derived-artefact
 * landmine in handbook/GNOSIS-GUIDE.md § Landmines. A HIT short-circuits before the
 * catalogue call, so a warm cache works with llama-swap stopped.
 *
 * The refusal split and message shape are `rerank.ts`'s, deliberately: the two
 * flags fail against the same server for the same three reasons, and a reader
 * who has fixed one has already read the other.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  REPHRASE_MAX_TOKENS,
  REPHRASE_MODEL_ENV_VAR,
  REPHRASE_MODEL_ID,
  REPHRASE_PROMPT_VERSION,
  REPHRASE_TIMEOUT_MS,
  RERANK_DEFAULT_URL,
  RERANK_URL_ENV_VAR
} from './config.js';

/** The llama-swap model catalogue, per the OpenAI-compatible API. */
const MODELS_PATH = '/v1/models';

/** The chat endpoint the rewrite itself goes to. */
const CHAT_PATH = '/v1/chat/completions';

/**
 * The rewriting rules, from `packages/gnosis/README.md` § Query rephrasing —
 * the flag EXECUTES the documented rules rather than inventing a second set.
 *
 * The examples are load-bearing, not decoration: measured zero-shot, this model
 * returned `testing strategy` where the README target is `testing strategy
 * layered test model coverage thresholds`. Rule 2 is supplied by the examples,
 * not by the sentence stating it. Shortening either half regresses the rewrite.
 *
 * `v2` repairs the two defects measured on v1
 * (`docs/analysis/2026-08-18-dp-gnosis-full-review/10-rephrase-arm-measurement.md`):
 *
 * LANGUAGE — v1 answered Hungarian questions in English against a Hungarian
 * index, so the rewrite shared almost no terms with the documents and the arm
 * could not move nDCG@10 while the hand rewrite moved it +0.2407. v1's rule 6
 * actively caused it: it asked for "the English word STEM". The rule now asks
 * for the question's OWN language, and Hungarian worked examples SHOW it —
 * the same failure class defeated a plain instruction on the summariser too,
 * so the examples, not the sentence, are the mechanism.
 *
 * IDENTIFIERS — v1 rewrote 58 of 60 English topics where the human left 20
 * untouched under README rule 5, splitting `forEachLocale` into `foreachlocale`
 * and `gate-no-verdict` into three words. Rule 5 is stated here AND enforced
 * outside the model by {@link carriesExactRareTerm}: a prompt line is the weaker
 * half of that fix, because the query never reaches the model at all when the
 * guard fires.
 */
export const REPHRASE_SYSTEM_PROMPT: string = [
  'You rewrite a user question into a keyword query for a lexical BM25 search engine over',
  'this repository\'s markdown documentation. Output ONLY the rewritten query: keywords',
  'separated by spaces, no punctuation, no explanation, no quotes.',
  '',
  'Rules:',
  '1. Write the rewrite in the SAME LANGUAGE AS THE QUESTION. A Hungarian question gets a',
  '   Hungarian rewrite, with its accents intact. The index holds the documents in the',
  '   language they were written in, and a translated query matches none of their terms.',
  '   MUST NOT translate, transliterate, or strip accents.',
  '2. Strip intent framing ("how to", "I want", "please show me", "info about", "available",',
  '   "related") — high frequency, zero discrimination.',
  '3. Name things as the documents name them, not as the asker names them.',
  '4. Add synonyms by hand: BM25 has no synonymy (e2e AND end-to-end; llm AND language model).',
  '5. Prefer rare, high-IDF terms. Expand to the concepts the documents name.',
  '6. Copy every identifier, symbol, path, flag and error string VERBATIM. MUST NOT split one',
  '   on a hyphen, slash, dot, colon or case boundary: forEachLocale stays forEachLocale, and',
  '   gate-no-verdict stays gate-no-verdict. Splitting one destroys the rarest term in the query.',
  '7. If the question already carries such an exact rare term, return the question UNCHANGED.',
  '   An unchanged answer is a correct and expected answer — adding synonyms beside a term the',
  '   documents already use LOWERS precision.',
  '8. Inflected language: emit the word STEM the documents use, in that same language, not the',
  '   inflected form the asker spoke.',
  '',
  'Examples:',
  'i would like to see testing strategy related info -> testing strategy layered test model coverage thresholds',
  'how to start e2e tests -> run e2e playwright test command spec',
  'what llm service solutions are available -> llm provider service ollama openrouter gemini anthropic',
  'how to use llama-swap -> how to use llama-swap',
  'where is forEachLocale defined -> where is forEachLocale defined',
  'architectural requirements of runner -> agentic code runner architecture ownership boundaries design rules',
  'functional programming style -> functional programming immutability pure functions no classes',
  'Hogyan kapcsolom be a naplókban az áfa-analitikát? -> napló engedélyezés áfa analitika kapcsoló beállítás',
  'Mi dönti el egy bejövő számla adópontját? -> bejövő számla adópont teljesítés dátum delivery_date invoice_date taxpoint',
  'Miért nem jelennek meg a kivételek a regiszterben? -> kivétel csak olvasható regiszter kivétel-lista megjelölt számla áfabevallási kivétel',
].join('\n');

/**
 * What a caller may vary. All three are omissible: the URL and the model each
 * default to what the CLI has always resolved, and an omitted `cacheDir` runs
 * UNCACHED rather than inventing a directory — a caller with nowhere to put the
 * entry gets the rewrite, not a surprise write.
 */
export interface RephraseOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly cacheDir?: string;
}

/** The rewrite plus whether it was served from disk, or the message naming the fault. */
export type RephraseOutcome =
  | { readonly ok: true; readonly rewritten: string; readonly cached: boolean }
  | { readonly ok: false; readonly error: string };

/** The base URL to call. The env override outranks the default, as a flag would. */
export const resolveRephraseUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[RERANK_URL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : RERANK_DEFAULT_URL;
};

/** The rewriter id to call under. The env override outranks the shipped id. */
export const resolveRephraseModel = (
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const declared = (env[REPHRASE_MODEL_ENV_VAR] ?? '').trim();
  return declared.length > 0 ? declared : REPHRASE_MODEL_ID;
};

/**
 * Everything outside this class becomes a space. `-_/.@+#` SURVIVE: they sit
 * inside the rare identifiers rule 4 exists to protect (`llama-swap`,
 * `db/idb.ts`), and stripping them would split exactly the high-IDF terms the
 * rewrite is asked to find.
 */
const DISALLOWED = /[^\p{L}\p{N}\-_/.@+# ]/gu;

const firstLine = (raw: string): string =>
  raw.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';

/**
 * The model's answer as a query. The FIRST non-empty line only — a model that
 * adds a sentence of commentary below the line still yields a usable query,
 * while joining the lines would put the commentary into the search.
 */
export const normaliseRewrite = (raw: string): string =>
  firstLine(raw).toLowerCase().replace(DISALLOWED, ' ').replace(/\s+/g, ' ').trim();

/**
 * What makes a token an EXACT rare term — README rule 5's trigger, as patterns
 * rather than as an instruction the model may ignore. Every one of these was
 * destroyed by prompt v1 on a measured topic: `forEachLocale`, `guardRejections`,
 * `RUNNER_EVAL_CAPTURE`, `gate-no-verdict`, `Xenova/distilgpt2`, `lint:test-shape`,
 * `@/features`, `db/idb.ts`.
 *
 * The hyphen pattern is deliberately ASCII-ONLY: a Hungarian compound such as
 * `áfa-analitikát` is ordinary prose that WANTS rewriting, while `llama-swap` is
 * the corpus's own term. It still over-guards an English compound like
 * `end-to-end`, and that direction is the safe one — an unchanged query costs the
 * lever, a destroyed identifier measured −0.0877 nDCG@10 on the rule-5 subgroup.
 */
const RARE_TERM_PATTERNS: readonly RegExp[] = [
  /\p{Ll}\p{Lu}/u,
  /[\p{L}\p{N}]_[\p{L}\p{N}]/u,
  /[\p{L}\p{N}]\/[\p{L}\p{N}]/u,
  /[\p{L}\p{N}]\.[a-z]{1,5}$/u,
  /^--?[\p{L}\p{N}]/u,
  /[@#]|\+\+|::|[\p{L}\p{N}]:[\p{L}\p{N}]/u,
  /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u,
];

/** Sentence punctuation is not part of the term — `db/idb.ts?` is still a path. */
const bareToken = (token: string): string =>
  token.replace(/^[("'`]+/u, '').replace(/[?!.,;)"'`]+$/u, '');

/**
 * README rule 5: a question already carrying the corpus's exact rare term MUST
 * NOT be rewritten. Answered here, before the model is asked — an instruction
 * the model disobeys 58 times in 60 is not a guard.
 */
export const carriesExactRareTerm = (query: string): boolean =>
  query
    .split(/\s+/u)
    .map(bareToken)
    .some(token => token.length > 1 && RARE_TERM_PATTERNS.some(pattern => pattern.test(token)));

/**
 * Where to rewrite, and under which id. The model travels WITH the URL because
 * every refusal message names both: a message naming the shipped id while
 * another was requested would send the reader to fix the wrong entry.
 */
interface Endpoint {
  readonly baseUrl: string;
  readonly model: string;
}

const request = (model: string): string =>
  `retrieve --rephrase: rewriter model "${model}" was requested`;

const requirement = (model: string): string =>
  ` — llama-swap MUST serve a chat model under the id "${model}"; `;

const DROP = ', or drop --rephrase to retrieve with the query as typed.';

/** Server DOWN: the catalogue call itself did not complete. */
const unreachableMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} did not answer GET ${MODELS_PATH} (server down: ${cause})${requirement(endpoint.model)}start llama-swap on that address, or point ${RERANK_URL_ENV_VAR} at the host that serves it, then re-run${DROP}`;

/** Server UP, model absent: the catalogue answered and does not list the id. */
const notServedMessage = (endpoint: Endpoint, served: readonly string[]): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} answered GET ${MODELS_PATH} but does not serve it (model not served; it serves: ${served.join(', ') || 'nothing'})${requirement(endpoint.model)}add that model to the llama-swap config under exactly that id, or name a served one with ${REPHRASE_MODEL_ENV_VAR}, then re-run${DROP}`;

/** The rewrite call failed after the catalogue passed — still a refusal. */
const callFailedMessage = (endpoint: Endpoint, cause: string): string =>
  `${request(endpoint.model)}; the server at ${endpoint.baseUrl} accepted GET ${MODELS_PATH} but the rewrite call failed (${cause})${requirement(endpoint.model)}check that the id names a CHAT model (a reranker answers /v1/models but not ${CHAT_PATH}), then re-run${DROP}`;

/** An answer with no usable line is a refusal — never an empty query to the adapter. */
const EMPTY_REWRITE = 'the model returned no usable query line';

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const modelIds = (payload: unknown): readonly string[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []
  );
};

type Catalogue =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly cause: string };

const fetchCatalogue = async (baseUrl: string): Promise<Catalogue> => {
  try {
    const response = await fetch(`${baseUrl}${MODELS_PATH}`);
    const body = await response.text();
    return response.ok
      ? { ok: true, models: modelIds(JSON.parse(body)) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/** `undefined` when the model is served; otherwise the message to refuse with. */
const catalogueRefusal = async (endpoint: Endpoint): Promise<string | undefined> => {
  const catalogue = await fetchCatalogue(endpoint.baseUrl);
  if (!catalogue.ok) return unreachableMessage(endpoint, catalogue.cause);
  return catalogue.models.includes(endpoint.model)
    ? undefined
    : notServedMessage(endpoint, catalogue.models);
};

/**
 * `temperature: 0` with a fixed seed makes a cache MISS reproducible: the same
 * query re-rewrites to the same line after the cache is deleted, so a cache is
 * an optimisation and never a source of a different answer.
 *
 * `chat_template_kwargs.enable_thinking: false` is LOAD-BEARING, not a tuning
 * knob — verified to suppress this gguf's default reasoning block, which would
 * otherwise occupy the answer's first lines and be read as the query.
 */
const chatBody = (model: string, query: string): unknown => ({
  model,
  messages: [
    { role: 'system', content: REPHRASE_SYSTEM_PROMPT },
    { role: 'user', content: query },
  ],
  temperature: 0,
  seed: 7,
  max_tokens: REPHRASE_MAX_TOKENS,
  chat_template_kwargs: { enable_thinking: false },
});

const firstChoice = (payload: unknown): unknown =>
  isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;

const messageOf = (choice: unknown): unknown => (isRecord(choice) ? choice.message : undefined);

const messageContent = (payload: unknown): string => {
  const message = messageOf(firstChoice(payload));
  return isRecord(message) && typeof message.content === 'string' ? message.content : '';
};

type ChatResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly cause: string };

const fetchCompletion = async (endpoint: Endpoint, query: string): Promise<ChatResult> => {
  try {
    const response = await fetch(`${endpoint.baseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody(endpoint.model, query)),
      signal: AbortSignal.timeout(REPHRASE_TIMEOUT_MS),
    });
    const text = await response.text();
    return response.ok
      ? { ok: true, content: messageContent(JSON.parse(text)) }
      : { ok: false, cause: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
};

/** What the entry records — the whole key, so a stale one is readable as such. */
interface CacheEntry {
  readonly model: string;
  readonly promptVersion: string;
  readonly query: string;
  readonly rewritten: string;
}

/**
 * The whole key, with the prompt version as a PARAMETER rather than a read of
 * the constant — so a test can prove that a version change misses without
 * rebuilding the module, which is exactly the property that keeps v1 rewrites
 * from being served under v2.
 */
export const rephraseCacheKey = (model: string, promptVersion: string, query: string): string =>
  createHash('sha256').update([model, promptVersion, query].join(' '), 'utf8').digest('hex');

/** `undefined` when the caller named no cache directory — then nothing is stored. */
const cachePath = (cacheDir: string | undefined, model: string, query: string): string | undefined =>
  cacheDir === undefined
    ? undefined
    : join(cacheDir, `${rephraseCacheKey(model, REPHRASE_PROMPT_VERSION, query)}.json`);

const rewrittenOf = (parsed: unknown): string | undefined =>
  isRecord(parsed) && typeof parsed.rewritten === 'string' ? parsed.rewritten : undefined;

/** A miss, an unreadable entry and a malformed one are the SAME answer: re-rewrite. */
const readCached = async (path: string | undefined): Promise<string | undefined> => {
  if (path === undefined) return undefined;
  try {
    return rewrittenOf(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
};

/** A write failure costs the NEXT call a rewrite; it MUST NOT fail this one. */
const writeCached = async (path: string | undefined, entry: CacheEntry): Promise<void> => {
  if (path === undefined) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), 'utf8');
  } catch {
    return;
  }
};

const callAndStore = async (
  endpoint: Endpoint,
  query: string,
  path: string | undefined
): Promise<RephraseOutcome> => {
  const completion = await fetchCompletion(endpoint, query);
  if (!completion.ok) return { ok: false, error: callFailedMessage(endpoint, completion.cause) };
  const rewritten = normaliseRewrite(completion.content);
  if (rewritten.length === 0) return { ok: false, error: callFailedMessage(endpoint, EMPTY_REWRITE) };
  const entry: CacheEntry = {
    model: endpoint.model,
    promptVersion: REPHRASE_PROMPT_VERSION,
    query,
    rewritten,
  };
  await writeCached(path, entry);
  return { ok: true, rewritten, cached: false };
};

/** A HIT as an outcome; `undefined` for a miss, an unreadable entry or no cache. */
const servedFromCache = async (path: string | undefined): Promise<RephraseOutcome | undefined> => {
  const cached = await readCached(path);
  return cached === undefined ? undefined : { ok: true, rewritten: cached, cached: true };
};

/** The network half: the catalogue gate, then the rewrite it guards. */
const rewriteOrRefuse = async (
  endpoint: Endpoint,
  query: string,
  path: string | undefined
): Promise<RephraseOutcome> => {
  const refusal = await catalogueRefusal(endpoint);
  return refusal === undefined
    ? await callAndStore(endpoint, query, path)
    : { ok: false, error: refusal };
};

const rephraseEndpoint = (options: RephraseOptions): Endpoint => ({
  baseUrl: options.baseUrl ?? resolveRephraseUrl(),
  model: options.model ?? resolveRephraseModel(),
});

/**
 * Rewrite `query` into a keyword line, or refuse with a message naming the
 * correction. The cache is consulted FIRST — before the catalogue call — so a
 * repeated query costs no network at all.
 *
 * README rule 5 is answered BEFORE the cache: a question already carrying an
 * exact rare term comes back unchanged, uncached and unsent, because no model
 * answer could improve on it and prompt v1 measurably made it worse.
 */
export const rephraseQuery = async (
  query: string,
  options: RephraseOptions = {}
): Promise<RephraseOutcome> => {
  const asked = query.trim();
  if (carriesExactRareTerm(asked)) return { ok: true, rewritten: asked, cached: false };
  const endpoint = rephraseEndpoint(options);
  const path = cachePath(options.cacheDir, endpoint.model, asked);
  const hit = await servedFromCache(path);
  return hit ?? (await rewriteOrRefuse(endpoint, asked, path));
};
