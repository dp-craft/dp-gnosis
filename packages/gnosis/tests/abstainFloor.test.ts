/**
 * The DEFAULT abstain floor (T3.1b-min) — the measured point at which a run
 * stops claiming calibrated confidence.
 *
 * Before it, `confidence: ok` was unreachable on the default path: it required
 * `--min-relevance`, which is opt-in. The floor makes the VERDICT reachable and
 * changes NOTHING a caller receives — dropping atoms stays gated on the explicit
 * flag, which is what the "delivers the same atoms" tests below pin.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { ABSTAIN_FLOOR, RERANK_MODEL_ID } from '../src/config.js';
import { resetRerankProbeCache } from '../src/rerank.js';

/** The sweep window inside which BOTH acceptance criteria held (2026-08-20). */
const MEASURED_WINDOW = { min: 0.25, max: 0.5 } as const;

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Gamma'] as const;

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-abstain-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await Promise.all(
    LABELS.map((label, index) =>
      writeFile(
        join(corpus, `${label}.md`),
        `# Zestful Retrieval ${label}\n\n${body(index + 2)}\n`,
        'utf8'
      )
    )
  );
  await runCli(['ingest', '--atoms-dir', join(repoRoot, 'atoms'), '--repo-root', repoRoot]);
  return { repoRoot, atomsDir: join(repoRoot, 'atoms') };
};

interface JsonAtom {
  readonly id: string;
  readonly rerankScore?: number;
}

interface JsonPayload {
  readonly atoms: readonly JsonAtom[];
  readonly count: number;
  readonly poolSize: number;
  readonly confidence: string;
}

const json = async (
  fixture: Fixture,
  extra: readonly string[],
  query = 'zestful retrieval'
): Promise<JsonPayload> => {
  const result = await runCli([
    'retrieve',
    query,
    '--adapter',
    'linear',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    '--json',
    ...extra,
  ]);
  return JSON.parse(result.stdout) as JsonPayload;
};

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

const PROBE_MARKER = 'BM25';

const HEALTHY_PROBE = [
  { index: 0, relevance_score: 2.07 },
  { index: 1, relevance_score: -11 },
];

const queryOf = (init: { readonly body?: string } | undefined): string =>
  String(JSON.parse(String(init?.body ?? '{}'))['query'] ?? '');

/** Scores by first-pass index, so the rerank agrees with the first pass order. */
const stubScores = (scores: readonly number[]): void => {
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      if (queryOf(init).includes(PROBE_MARKER)) return okResponse({ results: HEALTHY_PROBE });
      return okResponse({
        results: scores.map((score, index) => ({ index, relevance_score: score })),
      });
    }
  );
};

/** A reranker that cannot discriminate — the probe refuses it. */
const stubRefusedRerank = (): void => {
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      if (queryOf(init).includes(PROBE_MARKER))
        return okResponse({
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: 1, relevance_score: 0.5 },
          ],
        });
      return okResponse({ results: [] });
    }
  );
};

const ABOVE = [0.9, 0.8, 0.7, 0.6] as const;
const BELOW = [0.3, 0.2, 0.15, 0.1] as const;

describe('ABSTAIN_FLOOR — the measured default', () => {
  it('sits inside the swept [0.25, 0.50] window where both criteria held', () => {
    expect(ABSTAIN_FLOOR).toBeGreaterThanOrEqual(MEASURED_WINDOW.min);
    expect(ABSTAIN_FLOOR).toBeLessThanOrEqual(MEASURED_WINDOW.max);
  });
});

describe('the default floor decides the VERDICT and nothing else', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reads ok when the top calibrated probability clears the floor', async () => {
    const fixture = await makeFixture();
    stubScores(ABOVE);

    expect((await json(fixture, ['--rerank'])).confidence).toBe('ok');
  });

  it('reads weak below the floor, and DROPS NOTHING doing it', async () => {
    const fixture = await makeFixture();
    stubScores(BELOW);
    const floored = await json(fixture, ['--rerank']);
    vi.unstubAllGlobals();
    resetRerankProbeCache();
    const unreranked = await json(fixture, []);

    expect(floored.confidence).toBe('weak');
    expect(floored.count).toBe(unreranked.count);
    expect([...floored.atoms].map(entry => entry.id).sort()).toEqual(
      [...unreranked.atoms].map(entry => entry.id).sort()
    );
  });

  it('reads none when nothing was delivered', async () => {
    expect((await json(await makeFixture(), [], 'pineapple')).confidence).toBe('none');
  });

  it('leaves a default-path run — no rerank, no flag — delivering its full pool', async () => {
    const payload = await json(await makeFixture(), []);

    expect(payload.confidence).toBe('weak');
    expect(payload.count).toBe(LABELS.length);
    expect(payload.poolSize).toBe(LABELS.length);
  });

  it('does not abstain or drop on a REFUSED rerank — nothing was calibrated', async () => {
    const fixture = await makeFixture();
    const unreranked = await json(fixture, []);
    stubRefusedRerank();

    const refused = await json(fixture, ['--rerank']);

    expect(refused.confidence).toBe('weak');
    expect(refused.atoms.map(entry => entry.id)).toEqual(unreranked.atoms.map(entry => entry.id));
  });
});

describe('--min-relevance overrides the default in both directions', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('a lower explicit floor reads ok where the default would read weak', async () => {
    const fixture = await makeFixture();
    stubScores(BELOW);

    const payload = await json(fixture, ['--rerank', '--min-relevance', '0.05']);

    expect(payload.confidence).toBe('ok');
    expect(payload.count).toBe(LABELS.length);
  });

  it('a higher explicit floor drops the atoms the default floor would have kept', async () => {
    const fixture = await makeFixture();
    stubScores(ABOVE);

    const payload = await json(fixture, ['--rerank', '--min-relevance', '0.95']);

    expect(payload.confidence).toBe('none');
    expect(payload.count).toBe(0);
  });
});
