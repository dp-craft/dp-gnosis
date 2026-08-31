/**
 * WHERE the three chat hops call — `search --rephrase`, `ask --synthesize` and
 * `enrich`.
 *
 * `cli/help.ts` documents ONE precedence for the endpoint — flag > environment
 * > `config.json` > the shipped constant — and `rerank.ts:resolveRerankUrl` is
 * its single implementation. Each of the three hops used to re-spell it as
 * `env ?? constant`, dropping the `config.json` tier the setup wizard WRITES:
 * an instance whose llama-swap lives elsewhere reranked against its own
 * address and rephrased against the shipped one, silently.
 *
 * No live server: `fetch` is stubbed, and the only thing asserted is the
 * address every call carries.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpChatProvider } from '../src/chat.js';
import { RERANK_DEFAULT_URL, RERANK_URL_ENV_VAR } from '../src/config.js';
import { rephraseQuery } from '../src/rephrase.js';
import { synthesizeAnswer } from '../src/synthesize.js';
import { clearUserConfigCache } from '../src/userConfig.js';

const CONFIGURED_URL = 'http://box.lan:9292';
const STATED_URL = 'http://env.lan:9292';

/** Records every address called; the catalogue answers empty, which is enough. */
const stubbedCalls = (): string[] => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
    urls.push(url);
    return { ok: true, status: 200, text: async (): Promise<string> => JSON.stringify({ data: [] }) };
  });
  return urls;
};

/** A config home holding `config.json`, pointed at by `XDG_CONFIG_HOME`. */
const statesConfig = (config: Readonly<Record<string, unknown>>): void => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-endpoint-cfg-'));
  mkdirSync(join(home, 'dp-gnosis'));
  writeFileSync(join(home, 'dp-gnosis', 'config.json'), JSON.stringify(config), 'utf8');
  clearUserConfigCache();
  vi.stubEnv('XDG_CONFIG_HOME', home);
  vi.stubEnv(RERANK_URL_ENV_VAR, '');
};

/** The three hops, each reduced to the addresses one call reaches. */
const HOPS: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['search --rephrase', async (): Promise<unknown> => await rephraseQuery('zestful retrieval')],
  ['ask --synthesize', async (): Promise<unknown> => await synthesizeAnswer('a question', 'a pack')],
  [
    'enrich',
    async (): Promise<unknown> =>
      await createHttpChatProvider().complete({
        system: 'system',
        user: 'user',
        schema: { type: 'object', additionalProperties: false, properties: {} },
        schemaName: 'atom_enrichment',
      }),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearUserConfigCache();
});

describe.each(HOPS)('%s resolves its endpoint through the one owner', (_name, call) => {
  it('honours a config.json rerank.url — the tier the hop used to drop', async () => {
    statesConfig({ rerank: { url: CONFIGURED_URL } });
    const urls = stubbedCalls();

    await call();

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => url.startsWith(CONFIGURED_URL))).toBe(true);
  });

  it('lets the environment variable outrank config.json', async () => {
    statesConfig({ rerank: { url: CONFIGURED_URL } });
    vi.stubEnv(RERANK_URL_ENV_VAR, STATED_URL);
    const urls = stubbedCalls();

    await call();

    expect(urls.every(url => url.startsWith(STATED_URL))).toBe(true);
  });

  it('falls back to the shipped constant when neither states one', async () => {
    statesConfig({});
    const urls = stubbedCalls();

    await call();

    expect(urls.every(url => url.startsWith(RERANK_DEFAULT_URL))).toBe(true);
  });
});
