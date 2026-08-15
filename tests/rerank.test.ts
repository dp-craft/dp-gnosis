/**
 * `retrieve --rerank` — the OPT-IN serving-path reranker.
 *
 * No live server is required: `fetch` is stubbed, so both llama-swap calls
 * (`GET /v1/models` and `POST /v1/rerank`) are answered in-process. That keeps
 * the two failure messages — server down vs model not served — testable, which
 * is the point: a silent fallback to unreranked results would make the flag lie.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens } from '../src/budget.js';
import { runCli } from '../src/cli/cli.js';
import { RERANK_FUSION_PRESETS, RERANK_MODEL_ID } from '../src/config.js';
import { fuseRanking } from '../src/rerank.js';

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Gamma'] as const;

/** Same byte length for every atom, so one atom's cost is the whole budget. */
const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

const doc = (label: string, repeats: number): string =>
  `# Zestful Retrieval ${label}\n\n${body(repeats)}\n`;

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-rerank-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map((label, index) =>
      writeFile(join(corpus, `${label}.md`), doc(label, index + 2), 'utf8')
    )
  );
  await runCli(['ingest', '--atoms-dir', join(repoRoot, 'atoms'), '--repo-root', repoRoot]);
  return { repoRoot, atomsDir: join(repoRoot, 'atoms') };
};

const retrieve = async (
  fixture: Fixture,
  extra: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  await runCli([
    'retrieve',
    'zestful retrieval',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    '--json',
    ...extra,
  ]);

interface JsonAtom {
  readonly id: string;
  readonly body: string;
}

interface JsonPayload {
  readonly atoms: readonly JsonAtom[];
  readonly skipped: readonly { readonly id: string }[];
  readonly error?: string;
}

const parsePayload = (stdout: string): JsonPayload => JSON.parse(stdout) as JsonPayload;

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/** Answers both llama-swap endpoints; `order` lists first-pass indices best-first. */
const stubServer = (models: readonly string[], order: readonly number[]): string[] => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
    calls.push(url);
    if (url.endsWith('/v1/models')) {
      return okResponse({ data: models.map(id => ({ id })) });
    }
    return okResponse({
      results: order.map((index, position) => ({ index, relevance_score: 1 - position * 0.1 })),
    });
  });
  return calls;
};

describe('fuseRanking — the shipped preset', () => {
  it('fuses the reranked order with the first-pass order at K=20, w=0.5', () => {
    const fused = fuseRanking(['a', 'b', 'c', 'd'], [1, 2, 3, 0], RERANK_FUSION_PRESETS.shipped);

    // 'b': first-pass rank 2 and rerank rank 1 beats 'a' at first-pass 1, rerank 4.
    expect(fused.map(entry => entry.item)).toEqual(['b', 'a', 'c', 'd']);
    expect(fused[0]?.score).toBeCloseTo(0.5 / 22 + 0.5 / 21, 10);
    expect(fused[1]?.score).toBeCloseTo(0.5 / 21 + 0.5 / 24, 10);
  });

  it('scores an entry the reranker did not return from the first pass alone', () => {
    const fused = fuseRanking(['a', 'b'], [1], RERANK_FUSION_PRESETS.shipped);

    expect(fused.map(entry => entry.item)).toEqual(['b', 'a']);
    expect(fused[1]?.score).toBeCloseTo(0.5 / 21, 10);
  });
});

describe('retrieve --rerank', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is off by default — no reranker call, byte-identical output', async () => {
    const fixture = await makeFixture();
    const before = await retrieve(fixture, []);

    const calls = stubServer([RERANK_MODEL_ID], [1, 2, 3, 0]);
    const after = await retrieve(fixture, []);

    expect(calls).toEqual([]);
    expect(after.stdout).toBe(before.stdout);
    expect(after.exitCode).toBe(0);
  });

  it('is refused on a command other than retrieve', async () => {
    const result = await runCli(['index', '--rerank']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--rerank');
  });

  it('reorders the first pass by RRF fusion', async () => {
    const fixture = await makeFixture();
    const baseline = parsePayload((await retrieve(fixture, [])).stdout);
    expect(baseline.atoms).toHaveLength(4);

    stubServer([RERANK_MODEL_ID], [1, 2, 3, 0]);
    const reranked = parsePayload((await retrieve(fixture, ['--rerank'])).stdout);

    const ids = baseline.atoms.map(atom => atom.id);
    expect(reranked.atoms.map(atom => atom.id)).toEqual([ids[1], ids[0], ids[2], ids[3]]);
  });

  it('applies the token budget AFTER fusion', async () => {
    const fixture = await makeFixture();
    const baseline = parsePayload((await retrieve(fixture, [])).stdout);
    const budget = String(estimateTokens(baseline.atoms[0]?.body ?? ''));

    stubServer([RERANK_MODEL_ID], [1, 2, 3, 0]);
    const reranked = parsePayload(
      (await retrieve(fixture, ['--rerank', '--max-tokens', budget])).stdout
    );

    const ids = baseline.atoms.map(atom => atom.id);
    // The fusion winner is kept; the first-pass winner is the one skipped first.
    expect(reranked.atoms.map(atom => atom.id)).toEqual([ids[1]]);
    expect(reranked.skipped.map(atom => atom.id)).toEqual([ids[0], ids[2], ids[3]]);
  });

  it('reports an unreachable server, naming the model and the URL', async () => {
    const fixture = await makeFixture();
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const result = await retrieve(fixture, ['--rerank']);
    const error = parsePayload(result.stdout).error ?? '';

    expect(result.exitCode).toBe(2);
    expect(error).toContain(`"${RERANK_MODEL_ID}"`);
    expect(error).toContain('http://127.0.0.1:9292');
    expect(error).toContain('server down');
    expect(error).toContain('llama-swap');
    expect(error.indexOf(RERANK_MODEL_ID)).toBeLessThan(error.indexOf('http://127.0.0.1:9292'));
  });

  it('reports a served server that lacks the model, distinctly', async () => {
    const fixture = await makeFixture();
    stubServer(['some-chat-model'], []);

    const result = await retrieve(fixture, ['--rerank']);
    const error = parsePayload(result.stdout).error ?? '';

    expect(result.exitCode).toBe(2);
    expect(error).toContain(`"${RERANK_MODEL_ID}"`);
    expect(error).toContain('http://127.0.0.1:9292');
    expect(error).toContain('model not served');
    expect(error).not.toContain('server down');
    expect(error).toContain('some-chat-model');
  });

  it('honours DP_GNOSIS_RERANK_URL in the failure message', async () => {
    const fixture = await makeFixture();
    vi.stubEnv('DP_GNOSIS_RERANK_URL', 'http://127.0.0.1:9999');
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const error = parsePayload((await retrieve(fixture, ['--rerank'])).stdout).error ?? '';

    expect(error).toContain('http://127.0.0.1:9999');
  });
});
