/**
 * `retrieve --rephrase` — the OPT-IN query rewriter.
 *
 * No live server is required: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/chat/completions`) are answered in-process.
 * The two properties worth protecting are the ones asserted hardest here: with
 * the flag ABSENT the output is byte-identical to today's, and a refused
 * rewrite never presents as a successful rephrased run.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { REPHRASE_MODEL_ENV_VAR, REPHRASE_MODEL_ID, REPHRASE_PROMPT_VERSION } from '../src/config.js';
import {
  carriesExactRareTerm,
  normaliseRewrite,
  REPHRASE_SYSTEM_PROMPT,
  rephraseCacheKey,
  rephraseModelFact,
  rephraseQuery,
  resolveRephraseModel
} from '../src/rephrase.js';
import { clearUserConfigCache } from '../src/userConfig.js';

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Gamma'] as const;

const RAW_QUERY = 'zestful retrieval';
const REWRITTEN_QUERY = 'zestful retrieval bravo';

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

const doc = (label: string, repeats: number): string =>
  `# Zestful Retrieval ${label}\n\n${body(repeats)}\n`;

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-rephrase-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map((label, index) =>
      writeFile(join(corpus, `${label}.md`), doc(label, index + 2), 'utf8')
    )
  );
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return { repoRoot, atomsDir, indexPath: join(repoRoot, 'index.sqlite') };
};

interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cliArgs = (fixture: Fixture, query: string, extra: readonly string[]): string[] => [
  'search',
  query,
  // Pinned: the rewrite is the subject here, and the default adapter is
  // index-backed — an unpinned run would search the repo's own index.
  '--adapter',
  'linear',
  '--atoms-dir',
  fixture.atomsDir,
  '--index-path',
  fixture.indexPath,
  '--repo-root',
  fixture.repoRoot,
  ...extra,
];

/** `--json` is added here; a case needing another format calls `runCli` with `cliArgs`. */
const retrieve = async (
  fixture: Fixture,
  query: string,
  extra: readonly string[]
): Promise<CliOutput> => await runCli(cliArgs(fixture, query, [...extra, '--json']));

interface JsonAtom {
  readonly id: string;
}

interface JsonPayload {
  readonly query?: string;
  readonly queryRewritten?: string;
  readonly note?: string;
  readonly atoms: readonly JsonAtom[];
}

const parsePayload = (stdout: string): JsonPayload => JSON.parse(stdout) as JsonPayload;

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const completion = (content: string): unknown => ({
  choices: [{ message: { role: 'assistant', content } }],
});

/** Answers both llama-swap endpoints and records every URL called. */
const stubServer = (models: readonly string[], content: string): string[] => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
    calls.push(url);
    return url.endsWith('/v1/models')
      ? okResponse({ data: models.map(id => ({ id })) })
      : okResponse(completion(content));
  });
  return calls;
};

describe('normaliseRewrite', () => {
  it('lowercases and strips punctuation and quotes', () => {
    expect(normaliseRewrite('"Zustand Store Testing, Mock!"')).toBe('zustand store testing mock');
  });

  it('keeps the rare identifiers rule 4 exists to protect', () => {
    expect(normaliseRewrite('llama-swap db/idb.ts c++ node@20 tag#1 snake_case')).toBe(
      'llama-swap db/idb.ts c++ node@20 tag#1 snake_case'
    );
  });

  it('takes the FIRST non-empty line, ignoring commentary below it', () => {
    expect(normaliseRewrite('\n\nzustand store testing\nI expanded rule 3 here.')).toBe(
      'zustand store testing'
    );
  });

  it('collapses whitespace and trims', () => {
    expect(normaliseRewrite('   zustand \t  store   testing  ')).toBe('zustand store testing');
  });
});

describe('prompt v2 — the two diagnosed v1 defects', () => {
  // Both are prompt-side statements the measurement note requires; the guard
  // below is the code-side half of the second one.
  it('tells the model to answer in the QUERY OWN language', () => {
    expect(REPHRASE_SYSTEM_PROMPT).toMatch(/same language as the question/i);
    expect(REPHRASE_SYSTEM_PROMPT).not.toMatch(/English word STEM/i);
  });

  it('carries a worked Hungarian example, so the language rule is shown not just stated', () => {
    expect(REPHRASE_SYSTEM_PROMPT).toContain('bejövő számla adópont');
  });

  it('forbids splitting an identifier, the measured English harm', () => {
    expect(REPHRASE_SYSTEM_PROMPT).toMatch(/MUST NOT split/i);
    expect(REPHRASE_SYSTEM_PROMPT).toContain('forEachLocale');
  });
});

describe('REPHRASE_PROMPT_VERSION in the cache key', () => {
  // The v1 rewrites on disk (and in the frozen arm goldens) MUST NOT be served
  // under the v2 prompt — the version is what makes them miss.
  it('is v2, so every v1 entry misses', () => {
    expect(REPHRASE_PROMPT_VERSION).toBe('v2');
  });

  it('changes the key when only the version changes', () => {
    expect(rephraseCacheKey(REPHRASE_MODEL_ID, 'v1', RAW_QUERY)).not.toBe(
      rephraseCacheKey(REPHRASE_MODEL_ID, 'v2', RAW_QUERY)
    );
  });

  it('is stable for identical inputs', () => {
    expect(rephraseCacheKey(REPHRASE_MODEL_ID, 'v2', RAW_QUERY)).toBe(
      rephraseCacheKey(REPHRASE_MODEL_ID, 'v2', RAW_QUERY)
    );
  });
});

describe('carriesExactRareTerm — README rule 5 as a hard guard', () => {
  it.each([
    'where is forEachLocale defined',
    'guardRejections behaviour',
    'RUNNER_EVAL_CAPTURE meaning',
    'what does gate-no-verdict mean',
    'how to use llama-swap',
    'Xenova/distilgpt2 model',
    'lint:test-shape task',
    '@/features import rule',
    'what is in db/idb.ts',
    'the --no-verify flag',
  ])('guards %s', query => {
    expect(carriesExactRareTerm(query)).toBe(true);
  });

  it.each([
    'i would like to see testing strategy related info',
    'how to start e2e tests',
    'what llm service solutions are available',
    'functional programming style',
    'Hogyan kapcsolom be a naplókban az áfa-analitikát?',
    'Mi dönti el egy bejövő számla adópontját?',
  ])('leaves %s to the rewriter', query => {
    expect(carriesExactRareTerm(query)).toBe(false);
  });
});

describe('rephraseQuery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reports an unreachable server, naming the model and the URL', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const outcome = await rephraseQuery(RAW_QUERY);
    const error = outcome.ok ? '' : outcome.error;

    expect(outcome.ok).toBe(false);
    expect(error).toContain(`"${REPHRASE_MODEL_ID}"`);
    expect(error).toContain('http://127.0.0.1:9292');
    expect(error).toContain('server down');
    expect(error).toContain('DP_GNOSIS_RERANK_URL');
    expect(error).toContain('drop --rephrase');
  });

  it('reports a served server that lacks the model, distinctly', async () => {
    stubServer(['some-reranker'], REWRITTEN_QUERY);

    const outcome = await rephraseQuery(RAW_QUERY);
    const error = outcome.ok ? '' : outcome.error;

    expect(outcome.ok).toBe(false);
    expect(error).toContain('model not served');
    expect(error).not.toContain('server down');
    expect(error).toContain('some-reranker');
    expect(error).toContain('DP_GNOSIS_LLM_MODEL');
  });

  it('reports a failed chat call, naming the chat path', async () => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: REPHRASE_MODEL_ID }] });
      return { ok: false, status: 500, text: async (): Promise<string> => 'boom' };
    });

    const outcome = await rephraseQuery(RAW_QUERY);
    const error = outcome.ok ? '' : outcome.error;

    expect(outcome.ok).toBe(false);
    expect(error).toContain('HTTP 500');
    expect(error).toContain('/v1/chat/completions');
  });

  it('REFUSES an answer with no usable line rather than searching an empty query', async () => {
    stubServer([REPHRASE_MODEL_ID], '\n  "",  \n');

    const outcome = await rephraseQuery(RAW_QUERY);
    const error = outcome.ok ? '' : outcome.error;

    expect(outcome.ok).toBe(false);
    expect(error).toContain('no usable query line');
  });

  it('returns a rare-term query UNCHANGED and never calls the rewriter', async () => {
    const identifierQuery = 'where is forEachLocale defined';
    const calls = stubServer([REPHRASE_MODEL_ID], REWRITTEN_QUERY);

    const outcome = await rephraseQuery(identifierQuery);

    expect(outcome).toEqual({ ok: true, rewritten: identifierQuery, cached: false });
    expect(calls).toEqual([]);
  });

  it('caches a rewrite on disk: the second call is a HIT and issues no fetch', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gnosis-rephrase-cache-'));
    const calls = stubServer([REPHRASE_MODEL_ID], REWRITTEN_QUERY);

    const first = await rephraseQuery(RAW_QUERY, { cacheDir });
    const callsAfterMiss = calls.length;
    const second = await rephraseQuery(RAW_QUERY, { cacheDir });

    expect(first).toEqual({ ok: true, rewritten: REWRITTEN_QUERY, cached: false });
    expect(callsAfterMiss).toBe(2);
    expect(second).toEqual({ ok: true, rewritten: REWRITTEN_QUERY, cached: true });
    expect(calls).toHaveLength(callsAfterMiss);
  });

  it('MISSES when the model id changes — the key covers the model', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gnosis-rephrase-cache-'));
    const calls = stubServer([REPHRASE_MODEL_ID, 'other-chat-model'], REWRITTEN_QUERY);

    await rephraseQuery(RAW_QUERY, { cacheDir });
    const callsAfterMiss = calls.length;
    const other = await rephraseQuery(RAW_QUERY, { cacheDir, model: 'other-chat-model' });

    expect(other).toEqual({ ok: true, rewritten: REWRITTEN_QUERY, cached: false });
    expect(calls.length).toBe(callsAfterMiss * 2);
  });
});

describe('retrieve --rephrase', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is off by default — no rewriter call, byte-identical output', async () => {
    const fixture = await makeFixture();
    const before = await retrieve(fixture, RAW_QUERY, []);

    const calls = stubServer([REPHRASE_MODEL_ID], REWRITTEN_QUERY);
    const after = await retrieve(fixture, RAW_QUERY, []);

    expect(calls).toEqual([]);
    expect(after.stdout).toBe(before.stdout);
    expect(after.exitCode).toBe(0);
  });

  it('is refused on a command other than retrieve', async () => {
    const result = await runCli(['index', '--rephrase']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--rephrase');
  });

  it('searches the REWRITE while reporting the original query', async () => {
    const fixture = await makeFixture();
    const rewritten = 'gamma';
    stubServer([REPHRASE_MODEL_ID], rewritten);

    const result = await retrieve(fixture, RAW_QUERY, ['--rephrase']);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.query).toBe(RAW_QUERY);
    expect(payload.queryRewritten).toBe(rewritten);
    // Only the Gamma document carries that term, so the port saw the rewrite.
    expect(payload.atoms.map(atom => atom.id).join(' ')).toContain('gamma');
  });

  it('names the rewrite in the text and xml renderings', async () => {
    const fixture = await makeFixture();
    stubServer([REPHRASE_MODEL_ID], REWRITTEN_QUERY);

    const text = await runCli(cliArgs(fixture, RAW_QUERY, ['--rephrase']));
    const xml = await runCli(cliArgs(fixture, RAW_QUERY, ['--rephrase', '--format', 'xml']));

    expect(text.stdout).toContain(`search: rephrased "${RAW_QUERY}" -> "${REWRITTEN_QUERY}"`);
    expect(xml.stdout).toContain(`queryRewritten="${REWRITTEN_QUERY}"`);
  });

  it('degrades to the RAW query on a refusal — exit 3, refusal in the note', async () => {
    const fixture = await makeFixture();
    const raw = parsePayload((await retrieve(fixture, RAW_QUERY, [])).stdout);
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const result = await retrieve(fixture, RAW_QUERY, ['--rephrase']);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(payload.note ?? '').toContain('server down');
    expect(payload.queryRewritten).toBeUndefined();
    expect(payload.atoms.map(atom => atom.id)).toEqual(raw.atoms.map(atom => atom.id));
  });
});

/**
 * The rewriter id as a PERSISTABLE setting. It used to resolve
 * `env -> shipped constant`, and the shipped constant is one machine's private
 * llama-swap id — so a fresh install could only reach its own rewriter by
 * exporting a variable in every shell. The tiers are the reranker's, minus the
 * flag no rephrase call carries.
 */
describe('the rewriter id resolves env > config.json > constant', () => {
  const configEnv = (
    config?: Readonly<Record<string, unknown>>,
    extra: NodeJS.ProcessEnv = {}
  ): NodeJS.ProcessEnv => {
    const home = mkdtempSync(join(tmpdir(), 'gnosis-rephrase-cfg-'));
    mkdirSync(join(home, 'dp-gnosis'));
    if (config !== undefined) {
      writeFileSync(join(home, 'dp-gnosis', 'config.json'), JSON.stringify(config), 'utf8');
    }
    clearUserConfigCache();
    return { XDG_CONFIG_HOME: home, ...extra };
  };

  it('is the shipped constant when neither the environment nor the file states one', () => {
    const env = configEnv();

    expect(resolveRephraseModel(env)).toBe(REPHRASE_MODEL_ID);
    expect(rephraseModelFact(env).origin).toBe('default');
  });

  it('reads models.rephrase out of config.json when the environment states nothing', () => {
    const env = configEnv({ models: { rephrase: 'box-rewriter' } });

    expect(resolveRephraseModel(env)).toBe('box-rewriter');
    expect(rephraseModelFact(env).origin).toBe('config');
  });

  it('lets the environment variable outrank config.json, reporting the loser', () => {
    const env = configEnv({ models: { rephrase: 'box-rewriter' } }, {
      [REPHRASE_MODEL_ENV_VAR]: 'env-rewriter',
    });

    const fact = rephraseModelFact(env);

    expect(fact.value).toBe('env-rewriter');
    expect(fact.origin).toBe('env');
    expect(fact.configured).toBe('box-rewriter');
  });

  it('REFUSES a blank models.rephrase by key name instead of falling through', () => {
    const env = configEnv({ models: { rephrase: '   ' } });

    expect(() => resolveRephraseModel(env)).toThrow(/models\.rephrase/);
  });
});
