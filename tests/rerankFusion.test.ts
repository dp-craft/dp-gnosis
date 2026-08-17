/**
 * The rerank fusion PRESETS — `shipped` (RRF) and `beir-ce` (replacement).
 *
 * The first test is the load-bearing one: `SHIPPED_RANKING` was captured by
 * running this exact fixture against the code BEFORE fusion became a parameter,
 * and it pins ids AND full-precision scores. Every recorded rerank number was
 * measured under that arm, so a change that moves it invalidates the baselines
 * rather than improving them. It fails on any drift in the RRF constants, the
 * fusion arithmetic, the first-pass floor, or the default preset.
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
import { fuseLegs, fuseRanking, resolveRerankFusion } from '../src/rerank.js';

const LABELS = ['Alpha', 'Bravo', 'Delta', 'Echo', 'Gamma', 'Hotel'] as const;

/** First-pass INDICES best-first. Index 2 is withheld: the reranker missed one. */
const RERANK_ORDER = [3, 0, 5, 1, 4] as const;

/**
 * Captured 2026-08-15 from `retrieve --rerank -k 6` on the fixture below, at the
 * commit before this file existed. `[id, score]`, best-first.
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

const stubServer = (order: readonly number[]): void => {
  vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
    return okResponse({
      results: order.map((index, position) => ({ index, relevance_score: 1 - position * 0.1 })),
    });
  });
};

interface JsonAtom {
  readonly id: string;
  readonly score: number;
}

const rankingOf = async (fixture: Fixture): Promise<readonly (readonly [string, number])[]> => {
  const out = await runCli([
    'retrieve',
    'zestful retrieval',
    '--atoms-dir',
    fixture.atomsDir,
    '--repo-root',
    fixture.repoRoot,
    '--json',
    '-k',
    '6',
    '--rerank',
  ]);
  const payload = JSON.parse(out.stdout) as { readonly atoms: readonly JsonAtom[] };
  return payload.atoms.map(atom => [atom.id, atom.score] as const);
};

describe('retrieve --rerank default arm', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reproduces the pre-parameterisation ranking exactly — ids and scores', async () => {
    const fixture = await makeFixture();
    stubServer(RERANK_ORDER);

    expect(await rankingOf(fixture)).toEqual(SHIPPED_RANKING);
  });
});

describe('resolveRerankFusion', () => {
  it('defaults to the shipped RRF preset — K=20, w=0.5', () => {
    expect(resolveRerankFusion()).toEqual({ kind: 'rrf', rrfK: 20, rerankWeight: 0.5 });
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

  it('differs from the shipped preset on the same input', () => {
    const shipped = fuseRanking(['a', 'b', 'c', 'd'], [3, 1, 0, 2], RERANK_FUSION_PRESETS.shipped);

    expect(shipped.map(entry => entry.item)).not.toEqual(['d', 'b', 'a', 'c']);
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
    expect(RERANK_RRF_WEIGHT).toBe(0.5);
  });
});
