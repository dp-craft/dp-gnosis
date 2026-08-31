/**
 * `setup` — configuring the reranker in ONE non-interactive command.
 *
 * The three properties that matter, and each is a failure this project has
 * already paid for:
 *
 *   - it MUST NOT probe a whole catalogue. `PROBE_TIMEOUT_MS` is 300 s and a
 *     llama-swap cold load measured 69 s, so a served list of twenty models is
 *     an hour of foreground CLI wait. Only ids whose NAME says reranker are
 *     probed, at most {@link MAX_PROBED_MODELS} of them, and every id left out
 *     is named with the reason it was left out.
 *   - a model that fails the discrimination probe MUST NOT be written. Most
 *     published Qwen3-Reranker GGUFs answer HTTP 200 with well-formed numbers
 *     around 4.5e-23 through a missing `cls.output.weight` head (OPTIONAL.md);
 *     writing one configures a reranker that silently reranks nothing.
 *   - the write MERGES. A `config.json` that already declares `dataRoot` MUST
 *     come back with that `dataRoot` — a setup command that relocates the
 *     user's whole vault as a side effect of configuring a URL is the
 *     silent-wrong-location failure the config loader exists to police.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FlagValues } from '../src/cli/args.js';
import type { CommandContext } from '../src/cli/context.js';
import type { CommandOutcome } from '../src/cli/outcome.js';
import { EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from '../src/cli/outcome.js';
import { MAX_PROBED_MODELS, OLLAMA_URL, runSetupCommand } from '../src/cli/setupCommand.js';
import {
  ENRICH_MODEL_ENV_VAR,
  ENRICH_MODEL_ID,
  REPHRASE_MODEL_ENV_VAR,
  RERANK_DEFAULT_URL,
  RERANK_MODEL_ID,
  SYNTHESIZE_MODEL_ENV_VAR
} from '../src/config.js';
import { configHome } from '../src/env.js';
import { atomsDir, fts5IndexPath, ingestProfilePath } from '../src/paths.js';
import { resetRerankProbeCache } from '../src/rerank.js';
import { clearUserConfigCache, userConfigPath } from '../src/userConfig.js';
import { activeProfile } from '../src/vocabulary.js';

/** One stubbed llama-swap: what it serves, and how each id scores the probe pair. */
interface ServerStub {
  readonly models: readonly string[];
  /** `[relevantScore, irrelevantScore]`. An id absent here answers HTTP 500. */
  readonly scores: Readonly<Record<string, readonly [number, number]>>;
}

interface Wire {
  readonly probed: string[];
  readonly catalogued: string[];
}

const HEALTHY: readonly [number, number] = [0.99972, 0.0000039];
const DEGENERATE: readonly [number, number] = [4.5e-23, 1.1e-23];

const jsonResponse = (body: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(body),
});

const errorResponse = (): unknown => ({
  ok: false,
  status: 500,
  text: async (): Promise<string> => 'no rank head',
});

const scoreBody = (pair: readonly [number, number]): unknown => ({
  results: [
    { index: 0, relevance_score: pair[0] },
    { index: 1, relevance_score: pair[1] },
  ],
});

const modelOf = (init: unknown): string => {
  const body = (init as { readonly body?: string } | undefined)?.body ?? '{}';
  return String((JSON.parse(body) as { readonly model?: unknown }).model);
};

const stubServers = (servers: Readonly<Record<string, ServerStub>>): Wire => {
  const wire: Wire = { probed: [], catalogued: [] };
  vi.stubGlobal('fetch', async (url: string, init?: unknown): Promise<unknown> => {
    const base = url.replace(/\/v1\/(models|rerank)$/, '');
    const catalogue = url.endsWith('/v1/models');
    if (catalogue) wire.catalogued.push(base);
    const server = servers[base];
    if (server === undefined) throw new Error(`connect ECONNREFUSED ${base}`);
    if (catalogue) return jsonResponse({ data: server.models.map(id => ({ id })) });
    const model = modelOf(init);
    wire.probed.push(model);
    const pair = server.scores[model];
    return pair === undefined ? errorResponse() : jsonResponse(scoreBody(pair));
  });
  return wire;
};

let home = '';

const contextWith = (flags: FlagValues = {}, positionals: readonly string[] = []): CommandContext => ({
  adapter: 'fts5',
  atomsDir: atomsDir(),
  indexPath: fts5IndexPath(),
  repoRoot: home,
  profilePath: ingestProfilePath(),
  flags,
  positionals,
  corpusRoots: [],
  profile: activeProfile(),
});

const setup = async (flags: FlagValues = {}, positionals: readonly string[] = []): Promise<CommandOutcome> =>
  await runSetupCommand(contextWith(flags, positionals));

const configPath = (): string => userConfigPath(configHome());

const writeConfig = (value: Readonly<Record<string, unknown>>): void => {
  mkdirSync(configHome(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(value)}\n`, 'utf8');
};

const readConfig = (): Readonly<Record<string, unknown>> =>
  JSON.parse(readFileSync(configPath(), 'utf8')) as Readonly<Record<string, unknown>>;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-setup-'));
  process.env['DP_GNOSIS_CONFIG_HOME'] = join(home, 'config');
  process.env['DP_GNOSIS_DATA_HOME'] = join(home, 'data');
  clearUserConfigCache();
  resetRerankProbeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['DP_GNOSIS_CONFIG_HOME'];
  delete process.env['DP_GNOSIS_DATA_HOME'];
  clearUserConfigCache();
  resetRerankProbeCache();
  rmSync(home, { recursive: true, force: true });
});

describe('setup finds a server before it probes anything', () => {
  it('exits 3 naming every address it tried and the OPTIONAL.md remedy when none answers', async () => {
    stubServers({});

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_PARTIAL);
    expect(outcome.text).toContain(RERANK_DEFAULT_URL);
    expect(outcome.text).toContain(OLLAMA_URL);
    expect(outcome.text).toContain('OPTIONAL.md');
    expect(existsSync(configPath())).toBe(false);
  });

  it('falls back to the Ollama address when the shipped one does not answer', async () => {
    const wire = stubServers({
      [OLLAMA_URL]: { models: ['qwen3-reranker-4b'], scores: { 'qwen3-reranker-4b': HEALTHY } },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(wire.catalogued.slice(0, 2)).toEqual([RERANK_DEFAULT_URL, OLLAMA_URL]);
    expect(readConfig()['rerank']).toEqual({ url: OLLAMA_URL, model: 'qwen3-reranker-4b' });
  });
});

describe('setup probes a BOUNDED set of candidates, never the catalogue', () => {
  it('probes only ids whose name says reranker, and COUNTS the ones it did not', async () => {
    const wire = stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['gemma-3-27b', 'bge-m3', 'qwen3-reranker-4b'],
        scores: { 'qwen3-reranker-4b': HEALTHY },
      },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(wire.probed).toEqual(['qwen3-reranker-4b']);
    expect(outcome.text).toContain('2 served ids not probed — the id does not name a reranker');
    expect(outcome.data['skippedSummary']).toContain('does not name a reranker');
    expect(outcome.data['skipped']).toEqual([]);
  });

  it(`probes at most ${String(MAX_PROBED_MODELS)} ids and says the rest were left beyond the cap`, async () => {
    const models = ['a-reranker', 'b-reranker', 'c-reranker', 'd-reranker', 'e-reranker'];
    const wire = stubServers({ [RERANK_DEFAULT_URL]: { models, scores: {} } });

    const outcome = await setup();

    expect(wire.probed).toHaveLength(MAX_PROBED_MODELS);
    expect(outcome.exitCode).toBe(EXIT_PARTIAL);
    expect(outcome.data['skipped']).toContainEqual({
      id: 'e-reranker',
      why: `beyond the ${String(MAX_PROBED_MODELS)}-model probe cap`,
    });
  });

  it(`probes the shipped ${RERANK_MODEL_ID} FIRST when the server serves it, whatever sorts earlier`, async () => {
    const models = [
      'bge-reranker-v2-m3',
      'ettin-reranker-1b-v1',
      'qwen3-reranker-0.6b',
      RERANK_MODEL_ID,
    ];
    const wire = stubServers({
      [RERANK_DEFAULT_URL]: { models, scores: Object.fromEntries(models.map(id => [id, HEALTHY])) },
    });

    const outcome = await setup();

    expect(wire.probed).toEqual([RERANK_MODEL_ID]);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.data['model']).toBe(RERANK_MODEL_ID);
    expect(readConfig()['rerank']).toEqual({ url: RERANK_DEFAULT_URL, model: RERANK_MODEL_ID });
  });

  it('restricts the probe to exactly the id --rerank-model names', async () => {
    const wire = stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['qwen3-reranker-4b', 'bge-reranker-v2-m3'],
        scores: { 'qwen3-reranker-4b': HEALTHY, 'bge-reranker-v2-m3': HEALTHY },
      },
    });

    const outcome = await setup({ '--rerank-model': 'bge-reranker-v2-m3' });

    expect(wire.probed).toEqual(['bge-reranker-v2-m3']);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(readConfig()['rerank']).toEqual({
      url: RERANK_DEFAULT_URL,
      model: 'bge-reranker-v2-m3',
    });
  });
});

describe('the report stays readable — a skip list MUST NOT bury the result', () => {
  it('collapses the ids --rerank-model excluded into ONE counted line', async () => {
    const others = ['a-chat', 'b-chat', 'c-chat', 'd-chat', 'bge-reranker-v2-m3'];
    stubServers({
      [RERANK_DEFAULT_URL]: {
        models: [...others, RERANK_MODEL_ID],
        scores: { [RERANK_MODEL_ID]: HEALTHY },
      },
    });

    const outcome = await setup({ '--rerank-model': RERANK_MODEL_ID });

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.text.split('\n').filter(line => line.includes('not probed'))).toHaveLength(1);
    expect(outcome.text).toContain(`${String(others.length)} other served id`);
    expect(outcome.data['skipped']).toEqual([]);
  });

  it('counts the name-filter skips in ONE line while ITEMISING every over-cap reranker', async () => {
    const noise = ['gemma-3-27b', 'bge-m3', 'muse-30b', 'qwen2-7b'];
    const rerankers = ['a-reranker', 'b-reranker', 'c-reranker', 'd-reranker', 'e-reranker'];
    stubServers({
      [RERANK_DEFAULT_URL]: {
        models: [...noise, ...rerankers],
        scores: { 'a-reranker': HEALTHY },
      },
    });

    const outcome = await setup();

    const lines = outcome.text.split('\n').filter(line => line.includes('not probed'));
    expect(lines.filter(line => line.includes('does not name a reranker'))).toEqual([
      `  ${String(noise.length)} served ids not probed — the id does not name a reranker`,
    ]);
    expect(outcome.data['skipped']).toEqual([
      { id: 'd-reranker', why: `beyond the ${String(MAX_PROBED_MODELS)}-model probe cap` },
      { id: 'e-reranker', why: `beyond the ${String(MAX_PROBED_MODELS)}-model probe cap` },
    ]);
    expect(lines).toHaveLength(3);
  });
});

describe('a model that fails the probe is REJECTED, and the rejection is the diagnosis', () => {
  it('writes nothing and exits 3, quoting the raw scores of every candidate', async () => {
    stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['qwen3-reranker-4b'],
        scores: { 'qwen3-reranker-4b': DEGENERATE },
      },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_PARTIAL);
    expect(outcome.text).toContain('DEGENERATE');
    expect(outcome.text).toContain('4.5e-23');
    expect(existsSync(configPath())).toBe(false);
  });

  it('takes the first PASSING candidate in probe order and stops there', async () => {
    const wire = stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['zz-reranker', 'aa-reranker', 'mm-reranker'],
        scores: { 'aa-reranker': DEGENERATE, 'mm-reranker': HEALTHY, 'zz-reranker': HEALTHY },
      },
    });

    const outcome = await setup();

    expect(wire.probed).toEqual(['aa-reranker', 'mm-reranker']);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.data['model']).toBe('mm-reranker');
    expect(outcome.text).toContain('lexicographic');
  });
});

describe('the write MERGES into config.json', () => {
  it('leaves an existing dataRoot untouched', async () => {
    writeConfig({ dataRoot: '/srv/vault' });
    stubServers({
      [RERANK_DEFAULT_URL]: { models: ['qwen3-reranker-4b'], scores: { 'qwen3-reranker-4b': HEALTHY } },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(readConfig()['dataRoot']).toBe('/srv/vault');
    expect(readConfig()['rerank']).toEqual({ url: RERANK_DEFAULT_URL, model: 'qwen3-reranker-4b' });
  });

  it('says what it replaced when a rerank block was already there', async () => {
    writeConfig({ rerank: { url: 'http://10.0.0.9:9292', model: 'old-reranker' } });
    stubServers({
      'http://10.0.0.9:9292': {
        models: ['qwen3-reranker-4b'],
        scores: { 'qwen3-reranker-4b': HEALTHY },
      },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.text).toContain('old-reranker');
    expect(outcome.text).toContain('http://10.0.0.9:9292');
    expect(outcome.data['replaced']).toEqual({ url: 'http://10.0.0.9:9292', model: 'old-reranker' });
  });
});

describe('setup takes no positional arguments', () => {
  it('refuses one at exit 2, naming the correction', async () => {
    const outcome = await setup({}, ['http://127.0.0.1:9292']);

    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.text).toContain('--rerank-model');
  });
});

/**
 * The three CHAT hops are REPORTED, never chosen. `setup` may write a reranker
 * because a two-document discrimination probe PROVES one; no such probe exists
 * for a chat model, so an auto-picked generator would be a component nobody
 * measured, producing plausible text — this repository's failure class. What
 * `setup` owes the reader instead is the id each hop will ask for and whether
 * the catalogue it just fetched advertises it.
 */
describe('setup reports the chat ids the server does not serve, and configures none', () => {
  afterEach(() => {
    delete process.env[REPHRASE_MODEL_ENV_VAR];
    delete process.env[SYNTHESIZE_MODEL_ENV_VAR];
    delete process.env[ENRICH_MODEL_ENV_VAR];
  });

  it('names an unserved chat id with the config.json key that would fix it', async () => {
    stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['qwen3-reranker-4b'],
        scores: { 'qwen3-reranker-4b': HEALTHY },
      },
    });

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.text).toContain(ENRICH_MODEL_ID);
    expect(outcome.text).toContain('models.enrich');
    expect(readConfig()['models']).toBeUndefined();
  });

  it('says nothing about a hop whose resolved id the catalogue DOES advertise', async () => {
    stubServers({
      [RERANK_DEFAULT_URL]: {
        models: ['qwen3-reranker-4b', 'served-chat'],
        scores: { 'qwen3-reranker-4b': HEALTHY },
      },
    });
    process.env[REPHRASE_MODEL_ENV_VAR] = 'served-chat';
    process.env[SYNTHESIZE_MODEL_ENV_VAR] = 'served-chat';
    process.env[ENRICH_MODEL_ENV_VAR] = 'served-chat';

    const outcome = await setup();

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.text).not.toContain('models.enrich');
    expect(outcome.text).not.toContain('models.rephrase');
  });
});
