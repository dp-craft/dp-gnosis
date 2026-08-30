/**
 * The mechanics `setup` performs: find the reranker server, decide which of its
 * ids are worth a probe, probe them, and merge a patch into `config.json`.
 *
 * It is the FACTS half of `setup` — no output text lives here. The reason for
 * the split is that a second caller (the interactive wizard) must reach the
 * same server on the same addresses, apply the same bounded selection rule, and
 * write through the same merging writer. A second copy of any of the three
 * would be a second owner of the probe, and two owners of a rule that exists to
 * stop a non-discriminating reranker being configured is one owner too many.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { RERANK_MODEL_ID } from '../config.js';
import { configHome } from '../env.js';
import type { RerankHealth } from '../rerank.js';
import { rerankCatalogue, rerankHealth, rerankUrlFact } from '../rerank.js';
import { userConfigPath } from '../userConfig.js';
import { RERANK_MODEL_FLAG } from './retrieveCommand.js';

/** Ollama's OpenAI-compatible address — the second machine a reranker is served on. */
export const OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * How many ids one run may probe. Each probe may pay a cold model load, so the
 * cap is what keeps `setup` a command rather than an afternoon.
 */
export const MAX_PROBED_MODELS = 3;

/** The substring that makes an id worth a probe. Case-insensitive by design. */
const RERANKER_MARK = 'rerank';

const NOT_A_RERANKER = 'the id does not name a reranker';

const BEYOND_CAP = `beyond the ${String(MAX_PROBED_MODELS)}-model probe cap`;

/** One id that was not probed, and why it was not — never a silent drop. */
export interface Skipped {
  readonly id: string;
  readonly why: string;
}

/** One id that WAS probed, with the health verdict it produced. */
export interface Probed {
  readonly model: string;
  readonly health: RerankHealth;
}

type ServerResult =
  | { readonly ok: true; readonly baseUrl: string; readonly models: readonly string[] }
  | { readonly ok: false; readonly tried: readonly string[] };

/** The addresses to try, in order: the resolved one, then Ollama's. */
export const candidateUrls = (): readonly string[] => {
  const resolved = rerankUrlFact().value;
  return resolved === OLLAMA_URL ? [resolved] : [resolved, OLLAMA_URL];
};

const askServer = async (baseUrl: string, tried: readonly string[]): Promise<ServerResult> => {
  const catalogue = await rerankCatalogue(baseUrl);
  return catalogue.ok
    ? { ok: true, baseUrl, models: catalogue.models }
    : { ok: false, tried: [...tried, `${baseUrl} (${catalogue.cause})`] };
};

/** The first address that answers `GET /v1/models`, else every failure in order. */
export const findServer = async (urls: readonly string[]): Promise<ServerResult> =>
  await urls.reduce<Promise<ServerResult>>(
    async (pending, url) => {
      const soFar = await pending;
      return soFar.ok ? soFar : await askServer(url, soFar.tried);
    },
    Promise.resolve({ ok: false, tried: [] })
  );

/**
 * What one run will probe, and what it deliberately will not.
 *
 * The three ways an id is left out are reported DIFFERENTLY, and the split is
 * ACTIONABILITY, not tidiness.
 *
 * An id the CAP left out is a rerank-capable model this run did not try, and
 * the reader can act on it — name it with `--rerank-model`. So it is ITEMISED,
 * one line each.
 *
 * An id the NAME FILTER left out (a chat model) and an id `--rerank-model`
 * excluded are both noise the reader can do nothing with. Measured against a
 * real llama-swap, they were 20+ lines burying the single line that matters, on
 * the default path every user takes. So each class collapses into one COUNTED
 * summary — counted, never dropped, because an id that vanished from the report
 * reads as an id that failed.
 */
export interface Candidates {
  readonly probe: readonly string[];
  readonly skipped: readonly Skipped[];
  readonly summary: string | undefined;
}

const skippedFor = (models: readonly string[], probe: readonly string[], why: (id: string) => string): readonly Skipped[] =>
  [...models]
    .filter(id => !probe.includes(id))
    .sort()
    .map(id => ({ id, why: why(id) }));

/** One counted line, or nothing at all when there is nothing to count. */
export const summaryLine = (count: number, noun: string, why: string): string | undefined =>
  count === 0 ? undefined : `  ${String(count)} ${noun} id${count === 1 ? '' : 's'} not probed — ${why}`;

const restrictedSummary = (others: number, requested: string): string | undefined =>
  summaryLine(others, 'other served', `${RERANK_MODEL_FLAG} named ${requested}`);

const namedCandidates = (models: readonly string[], requested: string): Candidates => ({
  probe: [requested],
  skipped: [],
  summary: restrictedSummary(models.filter(id => id !== requested).length, requested),
});

/**
 * The shipped id goes FIRST when it is served. Alphabetical order alone put
 * `bge-reranker-v2-m3` — superseded at `92d683e2` — ahead of it, so a real
 * server's four rerank-marked ids exhausted the cap before the champion was
 * reached and `setup` reported success over a model no recorded baseline uses.
 * It also makes the common case ONE probe rather than three, and each probe can
 * pay a cold model load.
 */
export const orderShippedFirst = (named: readonly string[]): readonly string[] =>
  named.includes(RERANK_MODEL_ID)
    ? [RERANK_MODEL_ID, ...named.filter(id => id !== RERANK_MODEL_ID)]
    : named;

const filteredCandidates = (models: readonly string[]): Candidates => {
  const named = orderShippedFirst([...models].filter(id => id.toLowerCase().includes(RERANKER_MARK)).sort());
  const probe = named.slice(0, MAX_PROBED_MODELS);
  return {
    probe,
    skipped: skippedFor(named, probe, () => BEYOND_CAP),
    summary: summaryLine(models.length - named.length, 'served', NOT_A_RERANKER),
  };
};

export const selectCandidates = (models: readonly string[], requested: string | undefined): Candidates =>
  requested === undefined ? filteredCandidates(models) : namedCandidates(models, requested);

export const passed = (probed: readonly Probed[]): Probed | undefined =>
  probed.find(entry => entry.health.kind === 'healthy');

/** Sequential by construction, and it STOPS at the first pass — each probe costs a load. */
export const probeCandidates = async (baseUrl: string, ids: readonly string[]): Promise<readonly Probed[]> =>
  await ids.reduce<Promise<readonly Probed[]>>(async (pending, model) => {
    const done = await pending;
    if (passed(done) !== undefined) return done;
    return [...done, { model, health: await rerankHealth({ baseUrl, model, backend: 'http' }) }];
  }, Promise.resolve([]));

/** The whole file as written, so a key this build does not read still survives. */
const readRaw = (path: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
};

/**
 * What the write displaced: the previous value of every key the patch
 * overwrote, and nothing else. A key the patch never named is absent, so a
 * caller cannot report as replaced something it merely left alone.
 */
export interface Written {
  readonly path: string;
  readonly replaced: Readonly<Record<string, unknown>>;
}

const displaced = (
  existing: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.keys(patch).filter(key => key in existing).map(key => [key, existing[key]]));

export const writeUserConfig = (patch: Readonly<Record<string, unknown>>): Written => {
  const path = userConfigPath(configHome());
  const existing = readRaw(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, 'utf8');
  return { path, replaced: displaced(existing, patch) };
};
