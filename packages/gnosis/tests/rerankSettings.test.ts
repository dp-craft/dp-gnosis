/**
 * The reranker's URL and model as PERSISTABLE settings.
 *
 * Before this, the URL was environment-only and the model flag-only, so a user
 * whose llama-swap serves another id retyped `--rerank-model` on every call.
 * The tiers are `flag > env > config.json > constant`, and the case that MUST
 * NOT silently fall back is a malformed `config.json`: a relative or non-http
 * URL is a refusal naming the file, exactly as a relative `dataRoot` is.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RERANK_DEFAULT_URL,
  RERANK_MODEL_ENV_VAR,
  RERANK_MODEL_ID,
  RERANK_URL_ENV_VAR
} from '../src/config.js';
import {
  rerankHealth,
  rerankModelFact,
  rerankUrlFact,
  resetRerankProbeCache,
  resolveRerankModel,
  resolveRerankUrl
} from '../src/rerank.js';
import { clearUserConfigCache } from '../src/userConfig.js';

beforeEach(() => clearUserConfigCache());

const emptyConfigDir = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-rerank-cfg-'));
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

const rerankConfig = (url?: string, model?: string): string =>
  JSON.stringify({ rerank: { ...(url === undefined ? {} : { url }), ...(model === undefined ? {} : { model }) } });

describe('the reranker URL resolves flag > env > config.json > constant', () => {
  it('is the shipped constant with neither environment nor config — UNCHANGED behaviour', () => {
    const env = envWith(emptyConfigDir());
    expect(resolveRerankUrl(env)).toBe(RERANK_DEFAULT_URL);
    expect(rerankUrlFact(undefined, env).origin).toBe('default');
  });

  it('reads config.json when the environment states nothing', () => {
    const env = envWith(configDirWith(rerankConfig('http://box.lan:9292')));
    expect(resolveRerankUrl(env)).toBe('http://box.lan:9292');
    expect(rerankUrlFact(undefined, env).origin).toBe('config');
  });

  it('lets the environment variable outrank config.json, reporting the loser', () => {
    const env = envWith(configDirWith(rerankConfig('http://box.lan:9292')), {
      [RERANK_URL_ENV_VAR]: 'http://env.lan:9292',
    });
    const fact = rerankUrlFact(undefined, env);
    expect(fact.value).toBe('http://env.lan:9292');
    expect(fact.origin).toBe('env');
    expect(fact.configured).toBe('http://box.lan:9292');
  });

  it('lets an explicit option outrank both', () => {
    const env = envWith(configDirWith(rerankConfig('http://box.lan:9292')), {
      [RERANK_URL_ENV_VAR]: 'http://env.lan:9292',
    });
    const fact = rerankUrlFact('http://flag.lan:9292', env);
    expect(fact.value).toBe('http://flag.lan:9292');
    expect(fact.origin).toBe('flag');
  });

  it('ignores a blank environment variable, which states no address', () => {
    const env = envWith(configDirWith(rerankConfig('http://box.lan:9292')), {
      [RERANK_URL_ENV_VAR]: '   ',
    });
    expect(resolveRerankUrl(env)).toBe('http://box.lan:9292');
  });
});

describe('the reranker MODEL resolves flag > env > config.json > constant', () => {
  it('is the shipped id with neither environment nor config — UNCHANGED behaviour', () => {
    const env = envWith(emptyConfigDir());
    expect(resolveRerankModel(env)).toBe(RERANK_MODEL_ID);
    expect(rerankModelFact(undefined, env).origin).toBe('default');
  });

  it('reads config.json when the environment states nothing', () => {
    const env = envWith(configDirWith(rerankConfig(undefined, 'qwen3-reranker-0.6b')));
    expect(resolveRerankModel(env)).toBe('qwen3-reranker-0.6b');
    expect(rerankModelFact(undefined, env).origin).toBe('config');
  });

  it('lets DP_GNOSIS_RERANK_MODEL outrank config.json, reporting the loser', () => {
    const env = envWith(configDirWith(rerankConfig(undefined, 'qwen3-reranker-0.6b')), {
      [RERANK_MODEL_ENV_VAR]: 'bge-reranker-v2-m3',
    });
    const fact = rerankModelFact(undefined, env);
    expect(fact.value).toBe('bge-reranker-v2-m3');
    expect(fact.origin).toBe('env');
    expect(fact.stated).toBe('bge-reranker-v2-m3');
    expect(fact.configured).toBe('qwen3-reranker-0.6b');
  });

  it('lets an explicit option outrank both', () => {
    const env = envWith(configDirWith(rerankConfig(undefined, 'qwen3-reranker-0.6b')), {
      [RERANK_MODEL_ENV_VAR]: 'bge-reranker-v2-m3',
    });
    expect(rerankModelFact('flag-model', env).value).toBe('flag-model');
    expect(rerankModelFact('flag-model', env).origin).toBe('flag');
  });
});

describe('a malformed rerank config REFUSES, naming the file and the key', () => {
  const refuses = (text: string, key: RegExp): void => {
    const dir = configDirWith(text);
    expect(() => resolveRerankUrl(envWith(dir))).toThrow(configFile(dir));
    clearUserConfigCache();
    expect(() => resolveRerankUrl(envWith(dir))).toThrow(key);
  };

  it('refuses a non-object rerank section', () => {
    refuses(JSON.stringify({ rerank: 'http://box.lan' }), /rerank/);
  });

  it('refuses a relative url — an address that is not one', () => {
    refuses(JSON.stringify({ rerank: { url: '127.0.0.1:9292' } }), /rerank\.url/);
  });

  it('refuses a non-http url scheme', () => {
    refuses(JSON.stringify({ rerank: { url: 'ftp://box.lan' } }), /rerank\.url/);
  });

  it('refuses a non-string model', () => {
    refuses(JSON.stringify({ rerank: { model: 7 } }), /rerank\.model/);
  });

  it('refuses an empty model id', () => {
    refuses(JSON.stringify({ rerank: { model: '  ' } }), /rerank\.model/);
  });
});

/**
 * The tiers reach the ENDPOINT, not just the reporter: an option passed by
 * `--rerank-model` still beats both, and with none passed the process
 * environment decides which id the catalogue is asked for.
 */
describe('the resolved endpoint honours the same order', () => {
  const asked: string[] = [];

  beforeEach(() => {
    asked.length = 0;
    resetRerankProbeCache();
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      asked.push(url);
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => JSON.stringify({ data: [] }),
        json: async (): Promise<unknown> => ({ data: [] }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRerankProbeCache();
  });

  it('asks the environment-stated server for the environment-stated model', async () => {
    vi.stubEnv(RERANK_URL_ENV_VAR, 'http://env.lan:9292');
    vi.stubEnv(RERANK_MODEL_ENV_VAR, 'env-model');

    const health = await rerankHealth();

    expect(asked[0]).toBe('http://env.lan:9292/v1/models');
    expect(health.kind).toBe('unavailable');
    expect(health.kind === 'unavailable' ? health.detail : '').toContain('env-model');
  });

  it('lets an explicit option beat the environment', async () => {
    vi.stubEnv(RERANK_URL_ENV_VAR, 'http://env.lan:9292');
    vi.stubEnv(RERANK_MODEL_ENV_VAR, 'env-model');

    const health = await rerankHealth({ baseUrl: 'http://flag.lan:9292', model: 'flag-model' });

    expect(asked[0]).toBe('http://flag.lan:9292/v1/models');
    expect(health.kind === 'unavailable' ? health.detail : '').toContain('flag-model');
  });
});
