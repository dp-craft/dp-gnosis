/**
 * `--budget-mode bytes|tokens` — how `--max-tokens` is COUNTED.
 *
 * The property under test is the one the flag exists to protect: a run that
 * asked for real token counting and could not get it MUST refuse, loudly and
 * with a named reason, at a non-zero exit. A silent fall back to the UTF-8 byte
 * bound would report an upper bound roughly 3.8x the real cost as if it were
 * the count, so the caller would fill a fraction of the window it asked for and
 * read nothing anywhere saying so.
 *
 * No live server: `fetch` is stubbed, so the non-200, the malformed body and the
 * dead socket are all exercised deterministically.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { byteMeasure, estimateTokens, fitToTokenBudget } from '../src/budget.js';
import { runCli } from '../src/cli/cli.js';
import { BUDGET_MODES, DEFAULT_BUDGET_MODE, RERANK_MODEL_ID, TOKENIZE_MODEL_ID } from '../src/config.js';
import type { RetrievedAtom } from '../src/port.js';
import { createTokenCounter, tokenizeUrl } from '../src/tokenize.js';

const BASE_URL = 'http://127.0.0.1:9292';

const atom = (id: string, body: string): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body,
  score: 1,
  sourcePath: `vault/${id}.md`,
  originPaths: [`doc/${id}.md`],
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const counterWith = (fetchImpl: typeof fetch): ReturnType<typeof createTokenCounter> =>
  createTokenCounter({ baseUrl: BASE_URL, fetchImpl });

describe('tokenizeUrl', () => {
  it('carries the /upstream/<model>/ prefix the root route lacks', () => {
    expect(tokenizeUrl(BASE_URL, 'qwen3-reranker-4b')).toBe(
      'http://127.0.0.1:9292/upstream/qwen3-reranker-4b/tokenize'
    );
  });

  it('counts against the resident reranker, never a second model llama-swap would load', () => {
    expect(TOKENIZE_MODEL_ID).toBe(RERANK_MODEL_ID);
  });
});

describe('createTokenCounter', () => {
  it('probes with a POST carrying a "content" body and reads tokens.length', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const counter = counterWith((async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ tokens: [1, 2, 3] });
    }) as unknown as typeof fetch);

    const probe = await counter.probe();
    const counted = await counter.count('hello');

    expect(probe).toEqual({ ok: true, count: 3 });
    expect(counted).toEqual({ ok: true, count: 3 });
    expect(calls[0]?.url).toBe(tokenizeUrl(BASE_URL, TOKENIZE_MODEL_ID));
    expect(calls[1]?.body).toEqual({ content: 'hello' });
  });

  it('names an HTTP failure instead of throwing', async () => {
    const counter = counterWith((async () => jsonResponse({ error: 'nope' }, 404)) as unknown as typeof fetch);

    const probe = await counter.probe();

    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.reason).toContain('HTTP 404');
  });

  it('names a body without a tokens array instead of counting undefined', async () => {
    const counter = counterWith((async () => jsonResponse({ result: 'surprise' })) as unknown as typeof fetch);

    const probe = await counter.probe();

    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.reason).toContain('"tokens" array');
  });

  it('names a network failure instead of rejecting', async () => {
    const counter = counterWith((async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);

    const probe = await counter.probe();

    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.reason).toContain('ECONNREFUSED');
  });
});

describe('fitToTokenBudget measure injection', () => {
  const atoms: readonly RetrievedAtom[] = [atom('a', 'x'.repeat(10)), atom('b', 'y'.repeat(10))];

  it('defaults to the byte bound, unchanged', () => {
    expect(byteMeasure(atoms[0] as RetrievedAtom)).toBe(estimateTokens('x'.repeat(10)));
    expect(fitToTokenBudget(atoms, 15).kept.map(kept => kept.id)).toEqual(['a']);
  });

  it('admits under an injected measure what the byte bound would skip', () => {
    const fit = fitToTokenBudget(atoms, 15, () => 4);

    expect(fit.kept.map(kept => kept.id)).toEqual(['a', 'b']);
    expect(fit.skipped).toEqual([]);
  });

  it('reports the injected measure as the skipped size', () => {
    const fit = fitToTokenBudget(atoms, 0, () => 7);

    expect(fit.skipped.map(skipped => skipped.estimatedTokens)).toEqual([7, 7]);
  });
});

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const DOC = '# Budget Probe\n\nthe budget probe document about tokenizer counting\n';

const makeFixture = async (): Promise<Fixture> => {
  // The fixture corpus is its own root; the shipped roots name files no temp
  // directory has, and ingest refuses a root that matches nothing.
  vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-budget-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'BUDGET.md'), DOC, 'utf8');
  const atomsDir = join(repoRoot, 'atoms');
  await runCli(['ingest', '--atoms-dir', atomsDir, '--repo-root', repoRoot]);
  return { repoRoot, atomsDir };
};

const retrieve = async (
  fixture: Fixture,
  extra: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  await runCli([
    'search',
    'budget probe tokenizer',
    '--adapter',
    'linear',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    ...extra,
  ]);

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
};

describe('retrieve --budget-mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('offers exactly the closed vocabulary, defaulting to bytes', () => {
    expect(BUDGET_MODES).toEqual(['bytes', 'tokens']);
    expect(DEFAULT_BUDGET_MODE).toBe('bytes');
  });

  it('refuses an unknown mode as bad input at exit 2', async () => {
    const fixture = await makeFixture();

    const result = await retrieve(fixture, ['--budget-mode', 'chars']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('chars');
    expect(result.stderr).toContain('bytes | tokens');
  });

  it('reports the enforced measure in both renderings on a default run', async () => {
    const fixture = await makeFixture();

    const text = await retrieve(fixture, []);
    const json = await retrieve(fixture, ['--json']);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('counted as bytes');
    expect((JSON.parse(json.stdout) as { budgetMode: string }).budgetMode).toBe('bytes');
  });

  it('refuses at exit 3 with a named reason when the probe answers non-200', async () => {
    const fixture = await makeFixture();
    stubFetch(async () => jsonResponse({ error: 'no route' }, 404));

    const result = await retrieve(fixture, ['--budget-mode', 'tokens']);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('HTTP 404');
    expect(result.stdout).not.toContain('counted as bytes');
  });

  it('refuses at exit 3 when the probe body carries no tokens array', async () => {
    const fixture = await makeFixture();
    stubFetch(async () => jsonResponse({ count: 12 }));

    const result = await retrieve(fixture, ['--budget-mode', 'tokens']);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('"tokens" array');
  });

  it('refuses at exit 3 when the tokenizer is unreachable', async () => {
    const fixture = await makeFixture();
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await retrieve(fixture, ['--budget-mode', 'tokens']);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('ECONNREFUSED');
    expect(result.stdout).toContain('--budget-mode bytes');
  });

  /**
   * A skip is real output PLUS a refusal — the atom the ranking earned was
   * dropped for want of budget — which is exactly the exit-3 contract in
   * `src/cli/outcome.ts`. Exit 0 would let a caller read a truncated context as
   * the whole of what the vault holds.
   */
  it('exits 3 when the byte bound skips an atom', async () => {
    const fixture = await makeFixture();

    const result = await retrieve(fixture, ['--max-tokens', '1', '--json']);
    const payload = JSON.parse(result.stdout) as { skipped: readonly unknown[] };

    expect(payload.skipped.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(3);
  });

  it('exits 3 when the served count skips an atom, the same as bytes', async () => {
    const fixture = await makeFixture();
    stubFetch(async () => jsonResponse({ tokens: [1, 2, 3, 4, 5] }));

    const result = await retrieve(fixture, ['--budget-mode', 'tokens', '--max-tokens', '2', '--json']);
    const payload = JSON.parse(result.stdout) as { skipped: readonly unknown[] };

    expect(payload.skipped.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(3);
  });

  it('stays at exit 0 when the budget skips nothing', async () => {
    const fixture = await makeFixture();

    const result = await retrieve(fixture, ['--json']);
    const payload = JSON.parse(result.stdout) as { skipped: readonly unknown[] };

    expect(payload.skipped).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('budgets by the served count, admitting an atom the byte bound would skip', async () => {
    const fixture = await makeFixture();
    stubFetch(async () => jsonResponse({ tokens: [1, 2, 3, 4, 5] }));

    const counted = await retrieve(fixture, ['--budget-mode', 'tokens', '--max-tokens', '6', '--json']);
    vi.unstubAllGlobals();
    const bytes = await retrieve(fixture, ['--max-tokens', '6', '--json']);

    const countedPayload = JSON.parse(counted.stdout) as { count: number; budgetMode: string };
    const bytesPayload = JSON.parse(bytes.stdout) as { count: number; skipped: readonly unknown[] };

    expect(countedPayload.budgetMode).toBe('tokens');
    expect(countedPayload.count).toBe(1);
    expect(bytesPayload.count).toBe(0);
    expect(bytesPayload.skipped.length).toBe(1);
  });
});
