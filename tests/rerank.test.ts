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
import { fuseRanking, probeRerankDiscrimination, resetRerankProbeCache } from '../src/rerank.js';

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
    // Pinned, not defaulted: this file measures the RERANK leg, and the default
    // adapter is index-backed, so an unpinned run would search the repo's own
    // index instead of the fixture's atoms.
    '--adapter',
    'linear',
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
  readonly mode?: string;
  readonly note?: string;
  readonly error?: string;
}

const parsePayload = (stdout: string): JsonPayload => JSON.parse(stdout) as JsonPayload;

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/** The probe's own query, recognised so the fake server answers it as a reranker would. */
const PROBE_MARKER = 'BM25';

const queryOf = (init: { readonly body?: string } | undefined): string =>
  String(JSON.parse(String(init?.body ?? '{}'))['query'] ?? '');

const isProbe = (init: { readonly body?: string } | undefined): boolean =>
  queryOf(init).includes(PROBE_MARKER);

/** A discriminating answer to the probe: the relevant document (index 0) wins. */
const HEALTHY_PROBE = [
  { index: 0, relevance_score: 2.07 },
  { index: 1, relevance_score: -11 },
];

/**
 * Answers both llama-swap endpoints; `order` lists first-pass indices best-first.
 * The discrimination probe now runs on the serving path, so the fake server must
 * answer it too — its query is the one carrying {@link PROBE_MARKER}.
 */
const stubServer = (models: readonly string[], order: readonly number[]): string[] => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    calls.push(url);
    if (url.endsWith('/v1/models')) {
      return okResponse({ data: models.map(id => ({ id })) });
    }
    if (isProbe(init)) return okResponse({ results: HEALTHY_PROBE });
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
    // The probe memo is per PROCESS; each test serves its own fake reranker.
    resetRerankProbeCache();
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
    const error = parsePayload(result.stdout).note ?? '';

    expect(result.exitCode).toBe(3);
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
    const error = parsePayload(result.stdout).note ?? '';

    expect(result.exitCode).toBe(3);
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

    const error = parsePayload((await retrieve(fixture, ['--rerank'])).stdout).note ?? '';

    expect(error).toContain('http://127.0.0.1:9999');
  });
});

/**
 * The two-document discrimination probe. A reranker whose rank head this
 * llama.cpp build does not support answers HTTP 200 with well-formed scores, so
 * a broken model is invisible to every assertion downstream of it. The two
 * observed break signatures diagnose differently and are reported as such:
 * CONSTANT (mxbai-rerank-large-v2 — the SAME score to 16 decimals whatever the
 * document) and INVERTED (jina-reranker-v3 — the irrelevant document wins).
 */
describe('probeRerankDiscrimination', () => {
  /** The score mxbai-rerank-large-v2 returned for BOTH documents, measured live. */
  const MXBAI_CONSTANT_SCORE = 0.11378549039363861;

  /** Answers both endpoints; `scores` is indexed by probe document position. */
  const stubProbeServer = (models: readonly string[], scores: readonly number[]): void => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      if (url.endsWith('/v1/models')) {
        return okResponse({ data: models.map(id => ({ id })) });
      }
      return okResponse({
        results: scores.map((relevance_score, index) => ({ index, relevance_score })),
      });
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REFUSES a CONSTANT scorer, quoting both raw scores and the model', async () => {
    stubProbeServer([RERANK_MODEL_ID], [MXBAI_CONSTANT_SCORE, MXBAI_CONSTANT_SCORE]);

    const outcome = await probeRerankDiscrimination();

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error).toContain('CONSTANT');
    expect(error).not.toContain('INVERTED');
    expect(error).toContain(String(MXBAI_CONSTANT_SCORE));
    expect(error).toContain(`"${RERANK_MODEL_ID}"`);
  });

  it('REFUSES an INVERTED scorer, distinctly from a constant one', async () => {
    stubProbeServer([RERANK_MODEL_ID], [1.96e-7, 2.94e-7]);

    const outcome = await probeRerankDiscrimination();

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error).toContain('INVERTED');
    expect(error).not.toContain('CONSTANT');
    expect(error).toContain(String(1.96e-7));
    expect(error).toContain(String(2.94e-7));
  });

  it('PASSES a model that ranks the relevant passage above the irrelevant one', async () => {
    stubProbeServer([RERANK_MODEL_ID], [2.07, -11]);

    const outcome = await probeRerankDiscrimination();

    expect(outcome).toEqual({ ok: true, relevantScore: 2.07, irrelevantScore: -11 });
  });

  it('carries the server-down refusal through unchanged', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const outcome = await probeRerankDiscrimination();

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error).toContain('server down');
    expect(error).toContain(`"${RERANK_MODEL_ID}"`);
  });

  it('carries the model-not-served refusal through unchanged', async () => {
    stubProbeServer(['some-chat-model'], []);

    const outcome = await probeRerankDiscrimination();

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error).toContain('model not served');
    expect(error).toContain('some-chat-model');
    expect(error).not.toContain('server down');
  });
});

/**
 * The probe ON THE SERVING PATH (T1.2) and what its refusal does to the run
 * (T1.3). A broken reranker answers HTTP 200 with well-formed numbers, so the
 * probe is the only thing between it and a ranking nobody can tell from a good
 * one — and its refusal MUST NOT cost the caller the first pass it already has.
 */
describe('retrieve --rerank — the serving-path probe', () => {
  /** The score mxbai-rerank-large-v2 returned for BOTH documents, measured live. */
  const CONSTANT_SCORE = 0.11378549039363861;

  /** A fake server whose reranker is invariant to the document. */
  const stubConstantServer = (): void => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      return okResponse({
        results: [0, 1, 2, 3].map(index => ({ index, relevance_score: CONSTANT_SCORE })),
      });
    });
  };

  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('probes once per process, before the first document scoring call', async () => {
    const fixture = await makeFixture();
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
      if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
      queries.push(queryOf(init));
      if (isProbe(init)) return okResponse({ results: HEALTHY_PROBE });
      return okResponse({ results: [{ index: 0, relevance_score: 1 }] });
    });

    await retrieve(fixture, ['--rerank']);
    await retrieve(fixture, ['--rerank']);

    expect(queries[0]).toContain(PROBE_MARKER);
    expect(queries.filter(query => query.includes(PROBE_MARKER))).toHaveLength(1);
    expect(queries).toHaveLength(3);
  });

  it('REFUSES a reranker whose score is constant across documents', async () => {
    const fixture = await makeFixture();
    stubConstantServer();

    const note = parsePayload((await retrieve(fixture, ['--rerank'])).stdout).note ?? '';

    expect(note).toContain('rerank-probe-failed');
    expect(note).toContain('CONSTANT');
    expect(note).toContain(String(CONSTANT_SCORE));
  });

  it('leaves a healthy run byte-identical to the unprobed one', async () => {
    const fixture = await makeFixture();
    stubServer([RERANK_MODEL_ID], [1, 2, 3, 0]);
    const first = await retrieve(fixture, ['--rerank']);

    resetRerankProbeCache();
    stubServer([RERANK_MODEL_ID], [1, 2, 3, 0]);
    const second = await retrieve(fixture, ['--rerank']);

    expect(second.stdout).toBe(first.stdout);
    expect(second.exitCode).toBe(0);
  });

  it('degrades a refusal to the first pass at exit 3, with no +rerank in mode', async () => {
    const fixture = await makeFixture();
    const unreranked = parsePayload((await retrieve(fixture, [])).stdout);
    stubConstantServer();

    const result = await retrieve(fixture, ['--rerank']);
    const payload = parsePayload(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(payload.mode).toBe(unreranked.mode);
    expect(payload.mode ?? '').not.toContain('+rerank');
    expect(payload.note ?? '').toContain('rerank-probe-failed');
    expect(payload.atoms.map(atom => atom.id)).toEqual(unreranked.atoms.map(atom => atom.id));
    expect(payload.atoms.length).toBeGreaterThan(0);
  });
});
