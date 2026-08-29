/**
 * WHICH reranker scores — the backend, as a persistable setting beside the URL
 * and the model id.
 *
 * Two rules carry every case here. A backend the caller SELECTED and cannot be
 * served MUST refuse: falling through to the HTTP endpoint would answer under a
 * backend nobody asked for, which is a wrong answer delivered confidently. And
 * the shipped `http` path MUST be byte-identical to what it was before the
 * selector existed — a default that moved would re-rank every recorded run.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import {
  RERANK_BACKEND_ENV_VAR,
  RERANK_DEFAULT_BACKEND,
  RERANK_MODEL_ID,
} from '../src/config.js';
import { LOCAL_RERANKER_INSTALL_COMMAND, localRerankerAvailability } from '../src/localReranker.js';
import { rerankBackendFact, resetRerankProbeCache, resolveRerankBackend } from '../src/rerank.js';
import { activeProfile } from '../src/vocabulary.js';
import { clearUserConfigCache } from '../src/userConfig.js';

const emptyConfigDir = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-backend-cfg-'));
  mkdirSync(join(home, 'dp-gnosis'));
  return home;
};

const configFile = (home: string): string => join(home, 'dp-gnosis', 'config.json');

const configDirWith = (text: string): string => {
  const home = emptyConfigDir();
  writeFileSync(configFile(home), text, 'utf8');
  return home;
};

const envWith = (configDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  XDG_CONFIG_HOME: configDir,
  ...extra,
});

const backendConfig = (backend: unknown): string => JSON.stringify({ rerank: { backend } });

beforeEach(() => clearUserConfigCache());

describe('the reranker backend resolves flag > env > config.json > constant', () => {
  it('is the shipped http backend with neither environment nor config', () => {
    const env = envWith(emptyConfigDir());

    expect(resolveRerankBackend(env)).toBe(RERANK_DEFAULT_BACKEND);
    expect(RERANK_DEFAULT_BACKEND).toBe('http');
    expect(rerankBackendFact(undefined, env).origin).toBe('default');
  });

  it('takes the backend config.json states', () => {
    const env = envWith(configDirWith(backendConfig('local')));

    expect(resolveRerankBackend(env)).toBe('local');
    expect(rerankBackendFact(undefined, env).origin).toBe('config');
  });

  it('lets the environment outrank config.json, reporting the loser', () => {
    const env = envWith(configDirWith(backendConfig('local')), {
      [RERANK_BACKEND_ENV_VAR]: 'http',
    });

    const fact = rerankBackendFact(undefined, env);

    expect(fact.value).toBe('http');
    expect(fact.origin).toBe('env');
    expect(fact.configured).toBe('local');
  });

  it('lets an explicit selection outrank both', () => {
    const env = envWith(configDirWith(backendConfig('http')), {
      [RERANK_BACKEND_ENV_VAR]: 'http',
    });

    expect(rerankBackendFact('local', env).value).toBe('local');
    expect(rerankBackendFact('local', env).origin).toBe('flag');
  });
});

describe('an unknown backend REFUSES by name, listing what is accepted', () => {
  it('refuses it in config.json, naming the file, the key and both values', () => {
    const dir = configDirWith(backendConfig('llamacpp'));

    expect(() => resolveRerankBackend(envWith(dir))).toThrow(configFile(dir));
    clearUserConfigCache();
    expect(() => resolveRerankBackend(envWith(dir))).toThrow(/rerank\.backend/);
    clearUserConfigCache();
    expect(() => resolveRerankBackend(envWith(dir))).toThrow(/http.*local|local.*http/);
  });

  it('refuses a non-string backend', () => {
    const dir = configDirWith(backendConfig(7));

    expect(() => resolveRerankBackend(envWith(dir))).toThrow(/rerank\.backend/);
  });

  it('refuses it in the environment, naming the variable', () => {
    const env = envWith(emptyConfigDir(), { [RERANK_BACKEND_ENV_VAR]: 'llamacpp' });

    expect(() => resolveRerankBackend(env)).toThrow(RERANK_BACKEND_ENV_VAR);
  });
});

describe('the local engine is absent, and says so completely', () => {
  it('reports unavailable with the install command and the HTTP alternative', async () => {
    const availability = await localRerankerAvailability();

    expect(availability.available).toBe(false);
    const reason = availability.available ? '' : availability.reason;
    expect(reason).toContain(LOCAL_RERANKER_INSTALL_COMMAND);
    expect(LOCAL_RERANKER_INSTALL_COMMAND).toBe('npm install node-llama-cpp');
    expect(reason).toContain('--rerank');
    expect(reason).toContain('HTTP');
  });
});

const LABELS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'] as const;

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

const makeFixture = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-rerank-backend-'));
  await mkdir(join(repoRoot, 'doc'), { recursive: true });
  await Promise.all(
    LABELS.map((label, index) =>
      writeFile(
        join(repoRoot, 'doc', `${label}.md`),
        `# Zestful Retrieval ${label}\n\n${body(index + 2)}\n`,
        'utf8'
      )
    )
  );
  const profilePath = join(repoRoot, 'base.profile.json');
  await writeFile(
    profilePath,
    JSON.stringify({
      ...activeProfile(),
      repoRoot,
      corpusRoots: ['doc'],
      atomsDir: join(repoRoot, 'atoms'),
    }),
    'utf8'
  );
  await runCli(['ingest', '--profile', profilePath]);
  return profilePath;
};

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/** The discrimination probe's query carries this; it is NOT a scoring call. */
const PROBE_MARKER = 'BM25';

const HEALTHY_PROBE = [
  { index: 0, relevance_score: 2.07 },
  { index: 1, relevance_score: -11 },
];

interface Call {
  readonly query: string;
  readonly documents: readonly string[];
}

const callOf = (init: { readonly body?: string } | undefined): Call =>
  JSON.parse(String(init?.body ?? '{"query":"","documents":[]}')) as Call;

/** A reranker that reverses the first pass, so a rerank that RAN is visible. */
const healthyServer = (): string[] => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    urls.push(url);
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
    const call = callOf(init);
    if (call.query.includes(PROBE_MARKER)) return okResponse({ results: HEALTHY_PROBE });
    return okResponse({
      results: call.documents.map((_doc, position) => ({
        index: position,
        relevance_score: position * 0.01,
      })),
    });
  });
  return urls;
};

interface SearchPayload {
  readonly mode: string;
  readonly count: number;
  readonly note?: string;
  readonly atoms: readonly { readonly id: string }[];
}

const searchArgs = (profilePath: string, extra: readonly string[]): readonly string[] => [
  'search',
  'zestful retrieval',
  '--adapter', 'linear',
  '--profile', profilePath,
  '--json',
  '--flat',
  '-k', '3',
  ...extra,
];

describe('search --rerank under the local backend', () => {
  let profilePath = '';

  beforeAll(async () => {
    profilePath = await makeFixture();
  });

  beforeEach(() => resetRerankProbeCache());

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRerankProbeCache();
  });

  it('exits 3 with the install command and leaves the first-pass ranking intact', async () => {
    const urls = healthyServer();
    const firstPass = await runCli(searchArgs(profilePath, []));
    vi.stubEnv(RERANK_BACKEND_ENV_VAR, 'local');

    const outcome = await runCli(searchArgs(profilePath, ['--rerank']));

    const payload = JSON.parse(outcome.stdout) as SearchPayload;
    const expected = JSON.parse(firstPass.stdout) as SearchPayload;
    expect(outcome.exitCode).toBe(3);
    expect(payload.note ?? '').toContain(LOCAL_RERANKER_INSTALL_COMMAND);
    expect(payload.mode).not.toContain('+rerank');
    expect(payload.atoms.map(atom => atom.id)).toEqual(expected.atoms.map(atom => atom.id));
    expect(urls).toEqual([]);
  });

  it('MUST NOT silently fall back to the served endpoint', async () => {
    const urls = healthyServer();
    vi.stubEnv(RERANK_BACKEND_ENV_VAR, 'local');

    await runCli(searchArgs(profilePath, ['--rerank']));

    expect(urls).toEqual([]);
  });

  it('leaves the shipped http path byte-identical to an unstated backend', async () => {
    healthyServer();
    const unstated = await runCli(searchArgs(profilePath, ['--rerank']));
    resetRerankProbeCache();
    vi.stubEnv(RERANK_BACKEND_ENV_VAR, 'http');

    const stated = await runCli(searchArgs(profilePath, ['--rerank']));

    expect(unstated.stdout).toContain('+rerank');
    expect(stated.stdout).toBe(unstated.stdout);
    expect(unstated.exitCode).toBe(0);
  });
});

describe('doctor names the backend in effect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRerankProbeCache();
  });

  const settingsLine = async (): Promise<string> => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new Error('connection refused');
    });
    const outcome = await runCli(['doctor']);
    return outcome.stdout.split('\n').find(line => line.includes('] rerank-settings:')) ?? '';
  };

  it('states the default backend and where it came from', async () => {
    vi.stubEnv('DP_GNOSIS_CONFIG_HOME', emptyConfigDir());
    clearUserConfigCache();

    expect(await settingsLine()).toContain('rerankBackend = http (from the default)');
  });

  it('states the local backend AND that its engine will not load', async () => {
    vi.stubEnv(RERANK_BACKEND_ENV_VAR, 'local');
    vi.stubEnv('DP_GNOSIS_CONFIG_HOME', emptyConfigDir());
    clearUserConfigCache();

    const line = await settingsLine();

    expect(line).toContain('rerankBackend = local (from the env)');
    expect(line).toContain(LOCAL_RERANKER_INSTALL_COMMAND);
    expect(line).toContain('[fault]');
  });
});
