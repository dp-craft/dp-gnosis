/**
 * The rerank fusion PRESETS — `shipped` (RRF) and `beir-ce` (replacement).
 *
 * The first test is the load-bearing one: `SHIPPED_RANKING` was captured by
 * running this exact fixture against the code BEFORE fusion became a parameter,
 * and it pins ids AND full-precision scores. Every rerank number recorded before
 * `RERANK_RRF_WEIGHT` moved to 0.75 was measured under that arm, so it is run as
 * an EXPLICIT `--rerank-weight 0.5` arm — the weight is now the only parameter
 * of it the default does not supply. It still fails on any drift in `RERANK_RRF_K`,
 * the fusion arithmetic, or the first-pass floor.
 *
 * No live server: `fetch` is stubbed, so both llama-swap calls are answered
 * in-process and an offline run still passes.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli/cli.js';
import {
  HYBRID_DENSE_LEG_WEIGHT,
  HYBRID_FUSION,
  RERANK_FUSION_PRESETS,
  RERANK_MODEL_ID,
  RERANK_RRF_WEIGHT
} from '../src/config.js';
import {
  fuseLegs,
  fuseRanking,
  resetRerankProbeCache,
  resolveRerankFusion } from '../src/rerank.js';

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Echo', 'Gamma', 'Hotel'] as const;

/** First-pass INDICES best-first. Index 2 is withheld: the reranker missed one. */
const RERANK_ORDER = [3, 0, 5, 1, 4] as const;

/**
 * Captured 2026-08-15 from `retrieve --rerank -k 6` on the fixture below, at the
 * commit before this file existed. `[id, score]`, best-first — at the weight
 * that held then, 0.5, which the arm below names explicitly.
 */
const SHIPPED_RANKING: readonly (readonly [string, number])[] = [
  ['hotel-zestful-retrieval-hotel', 0.046536796536796536],
  ['delta-zestful-retrieval-delta', 0.04464285714285714],
  ['gamma-zestful-retrieval-gamma', 0.043560606060606064],
  ['alpha-zestful-retrieval-alpha', 0.04096989966555184],
  ['bravo-zestful-retrieval-bravo', 0.04],
  ['echo-zestful-retrieval-echo', 0.021739130434782608],
];

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-fusion-'));
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

const okResponse = (payload: unknown): unknown => ({
  ok: true,
  status: 200,
  text: async (): Promise<string> => JSON.stringify(payload),
});

/**
 * The discrimination probe runs on the serving path before the first scoring
 * call, so the fake server must answer it as a working reranker would — its
 * query is the one carrying {@link PROBE_MARKER}, and index 0 is the relevant
 * document. Answering it from `order` instead would make the probe's verdict an
 * accident of the fixture's rerank order.
 */
const PROBE_MARKER = 'BM25';

const isProbe = (init: { readonly body?: string } | undefined): boolean =>
  String(JSON.parse(String(init?.body ?? '{}'))['query'] ?? '').includes(PROBE_MARKER);

const HEALTHY_PROBE = [
  { index: 0, relevance_score: 2.07 },
  { index: 1, relevance_score: -11 },
];

const rerankBody = (order: readonly number[]): unknown => ({
  results: order.map((index, position) => ({ index, relevance_score: 1 - position * 0.1 })),
});

const stubServer = (order: readonly number[]): void => {
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
    return okResponse(isProbe(init) ? { results: HEALTHY_PROBE } : rerankBody(order));
  });
};

/** The same stub, recording which model id each rerank call named. */
const capturingServer = (order: readonly number[], served: string): string[] => {
  const models: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: served }] });
    models.push(String(JSON.parse(String(init?.body ?? '{}'))['model']));
    return okResponse(isProbe(init) ? { results: HEALTHY_PROBE } : rerankBody(order));
  });
  return models;
};

interface JsonAtom {
  readonly id: string;
  readonly score: number;
}

const rankingOf = async (
  fixture: Fixture,
  extra: readonly string[] = []
): Promise<readonly (readonly [string, number])[]> => {
  const out = await runCli([
    'retrieve',
    'zestful retrieval',
    // Pinned: the fusion rule is the subject here, and the default adapter is
    // index-backed — an unpinned run would search the repo's own index.
    '--adapter',
    'linear',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    '--json',
    '-k',
    '6',
    '--rerank',
    ...extra,
  ]);
  const payload = JSON.parse(out.stdout) as { readonly atoms: readonly JsonAtom[] };
  return payload.atoms.map(atom => [atom.id, atom.score] as const);
};

describe('retrieve --rerank default arm', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    // The probe memo is per PROCESS; each test serves its own fake reranker.
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reproduces the pre-parameterisation ranking exactly at w=0.5 — ids and scores', async () => {
    const fixture = await makeFixture();
    stubServer(RERANK_ORDER);

    expect(await rankingOf(fixture, ['--rerank-weight', '0.5'])).toEqual(SHIPPED_RANKING);
  });

  /**
   * The adopted weight is a DIFFERENT arm, and it must be visibly different —
   * a default that still reproduced the 0.5 ranking would mean the constant is
   * read from somewhere else.
   */
  it('does NOT reproduce that ranking at the shipped weight, which moved to 0.75', async () => {
    const fixture = await makeFixture();
    stubServer(RERANK_ORDER);

    expect(await rankingOf(fixture)).not.toEqual(SHIPPED_RANKING);
  });
});

describe('resolveRerankFusion', () => {
  it('defaults to the shipped RRF preset — K=20, w=0.75', () => {
    expect(resolveRerankFusion()).toEqual({ kind: 'rrf', rrfK: 20, rerankWeight: 0.75 });
  });

  it('resolves beir-ce to pure replacement', () => {
    expect(resolveRerankFusion('beir-ce')).toEqual({ kind: 'replace' });
  });

  it('applies a raw weight override to the shipped preset', () => {
    expect(resolveRerankFusion('shipped', { rerankWeight: 1 })).toEqual({
      kind: 'rrf',
      rrfK: 20,
      rerankWeight: 1,
    });
  });

  it('refuses an unknown preset by name, listing the known ones', () => {
    expect(() => resolveRerankFusion('rrf60')).toThrow(/unknown preset "rrf60".*shipped, beir-ce/);
  });

  it('refuses a weight override on a preset that has no weight term', () => {
    expect(() => resolveRerankFusion('beir-ce', { rerankWeight: 1 })).toThrow(/beir-ce/);
  });
});

describe('fuseRanking under beir-ce', () => {
  it('emits the reranker order, ignoring the first pass entirely', () => {
    const fused = fuseRanking(['a', 'b', 'c', 'd'], [3, 1, 0, 2], RERANK_FUSION_PRESETS['beir-ce']);

    expect(fused.map(entry => entry.item)).toEqual(['d', 'b', 'a', 'c']);
    expect(fused.map(entry => entry.score)).toEqual([1, 1 / 2, 1 / 3, 1 / 4]);
  });

  it('keeps an entry the reranker did not return, below every one it did', () => {
    const fused = fuseRanking(['a', 'b', 'c'], [2, 0], RERANK_FUSION_PRESETS['beir-ce']);

    expect(fused.map(entry => entry.item)).toEqual(['c', 'a', 'b']);
    expect(fused[2]?.score).toBeLessThan(fused[1]?.score ?? 0);
  });

  /**
   * TEN items, not four: at `w=0.75` the reranked order dominates a list short
   * enough that its rank gaps exceed the whole first-pass spread, so the two
   * rules AGREE there. The disagreement the shipped preset exists for needs a
   * first-pass rank far enough from the reranked one to outweigh one rerank step.
   */
  const TEN = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;

  it('differs from the shipped preset on the same input', () => {
    const order = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8];
    const replaced = fuseRanking([...TEN], order, RERANK_FUSION_PRESETS['beir-ce']);
    const shipped = fuseRanking([...TEN], order, RERANK_FUSION_PRESETS.shipped);

    expect(replaced.map(entry => entry.item).slice(0, 2)).toEqual(['j', 'a']);
    expect(shipped.map(entry => entry.item).slice(0, 2)).toEqual(['a', 'j']);
  });
});

/**
 * The TWO-LEG form of the same fusion. It exists so the hybrid route reuses this
 * arithmetic instead of cloning it; the extension is deliberately additive —
 * `fuseRanking`'s own signature is untouched, and both share `rrfTerm`.
 */
describe('fuseLegs', () => {
  it('scores an item absent from a leg from the other leg ALONE', () => {
    const fused = fuseLegs(
      { items: ['a', 'b', 'c'], primary: [0], secondary: [2, 0, 1] },
      HYBRID_FUSION
    );

    expect(fused.map(entry => entry.item)).toEqual(['a', 'c', 'b']);
    expect(fused[0]?.score).toBeCloseTo(0.5 / 21 + 0.5 / 22, 12);
    expect(fused[1]?.score).toBeCloseTo(0.5 / 21, 12);
    expect(fused[2]?.score).toBeCloseTo(0.5 / 23, 12);
  });

  it('refuses a replacement preset — a hybrid leg cannot REPLACE the other', () => {
    expect(() =>
      fuseLegs({ items: ['a'], primary: [0], secondary: [0] }, RERANK_FUSION_PRESETS['beir-ce'])
    ).toThrow(/two-leg fusion/);
  });
});

/**
 * The dense leg's fusion weight is its OWN parameter. It once read
 * `RERANK_RRF_WEIGHT` by code reuse, which coupled two independently measured
 * numbers: tuning the reranker moved the hybrid route as a side effect, and
 * that inheritance published a wrong Phase D conclusion.
 */
describe('HYBRID_DENSE_LEG_WEIGHT', () => {
  const configSource = async (): Promise<string> =>
    await readFile(fileURLToPath(new URL('../src/config.ts', import.meta.url)), 'utf8');

  it('resolves the dense-leg fusion default to 0.5 when no hybrid weight is named', () => {
    expect(HYBRID_DENSE_LEG_WEIGHT).toBe(0.5);
    expect(HYBRID_FUSION.rerankWeight).toBe(HYBRID_DENSE_LEG_WEIGHT);

    const fused = fuseLegs({ items: ['a', 'b'], primary: [0, 1], secondary: [1, 0] }, HYBRID_FUSION);

    expect(fused[0]?.score).toBeCloseTo(0.5 / 21 + 0.5 / 22, 12);
  });

  it('lets an explicitly named hybrid weight override the default', () => {
    const overridden = { ...HYBRID_FUSION, rerankWeight: 0.25 };

    const fused = fuseLegs({ items: ['a', 'b'], primary: [0, 1], secondary: [1, 0] }, overridden);

    expect(overridden.rerankWeight).not.toBe(HYBRID_DENSE_LEG_WEIGHT);
    expect(fused[0]?.item).toBe('a');
    expect(fused[0]?.score).toBeCloseTo(0.25 / 22 + 0.75 / 21, 12);
  });

  it('is a SEPARATE binding from RERANK_RRF_WEIGHT, not derived from it', async () => {
    const source = await configSource();
    const declaration = source.slice(source.indexOf('export const HYBRID_FUSION'));

    expect(source).toMatch(/export const HYBRID_DENSE_LEG_WEIGHT\s*=\s*0\.5/);
    expect(declaration).toContain('HYBRID_DENSE_LEG_WEIGHT');
    expect(declaration.slice(0, declaration.indexOf('}'))).not.toContain('RERANK_RRF_WEIGHT');
    expect(RERANK_RRF_WEIGHT).toBe(0.75);
  });
});

/**
 * The three tuning flags on `retrieve`. Each mirrors the bench's rule: a
 * treatment a run NAMES must be a treatment the run APPLIED, so a tuning flag
 * without `--rerank` refuses instead of being ignored, and neither an unknown
 * preset nor an out-of-range weight is quietly repaired into something that
 * would score under the wrong label.
 */
describe('retrieve rerank tuning flags', () => {
  const usageErrorFor = async (
    extra: readonly string[]
  ): Promise<Awaited<ReturnType<typeof runCli>>> =>
    await runCli(['retrieve', 'zestful retrieval', '--adapter', 'linear', ...extra]);

  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
    // The probe memo is per PROCESS; each test serves its own fake reranker.
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ['--rerank-model', 'qwen3-reranker-0.6b'],
    ['--rerank-profile', 'beir-ce'],
    ['--rerank-weight', '0.75'],
  ])('exits 2 when %s is passed without --rerank, naming the missing flag', async (flag, value) => {
    const result = await usageErrorFor([flag, value]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(flag);
    expect(result.stderr).toContain('--rerank');
  });

  it('exits 2 on an unknown --rerank-profile, listing the known presets', async () => {
    const result = await usageErrorFor(['--rerank', '--rerank-profile', 'rrf60']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('rrf60');
    expect(result.stderr).toContain('shipped, beir-ce');
  });

  it.each(['1.5', 'heavy'])(
    'exits 2 on --rerank-weight %s, naming the range rather than clamping it',
    async value => {
      const result = await usageErrorFor(['--rerank', '--rerank-weight', value]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('0');
      expect(result.stderr).toContain('1');
      expect(result.stderr).toContain('never clamped');
    }
  );

  it('scores with the model --rerank-model names, not the shipped default', async () => {
    const fixture = await makeFixture();
    const models = capturingServer(RERANK_ORDER, 'qwen3-reranker-0.6b');

    await rankingOf(fixture, ['--rerank-model', 'qwen3-reranker-0.6b']);

    expect(models).toContain('qwen3-reranker-0.6b');
    expect(models).not.toContain(RERANK_MODEL_ID);
  });

  it('applies the fusion rule --rerank-profile names — beir-ce replaces the first pass', async () => {
    const fixture = await makeFixture();
    stubServer(RERANK_ORDER);

    const ranked = await rankingOf(fixture, ['--rerank-profile', 'beir-ce']);

    expect(ranked.map(([id]) => id)).not.toEqual(SHIPPED_RANKING.map(([id]) => id));
    expect(ranked[0]?.[1]).toBe(1);
    expect(ranked[1]?.[1]).toBe(1 / 2);
  });

  it('applies the weight --rerank-weight names, moving the fused scores', async () => {
    const fixture = await makeFixture();
    stubServer(RERANK_ORDER);

    const ranked = await rankingOf(fixture, ['--rerank-weight', '1']);

    expect(ranked.map(([, score]) => score)).not.toEqual(SHIPPED_RANKING.map(([, score]) => score));
  });
});
