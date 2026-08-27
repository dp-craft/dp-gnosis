/**
 * The reranked-candidate POOL as a per-instance setting: `--rerank-pool`, the
 * profile's `rerankPoolK`, and `RERANK_K_INIT` as the fallback that keeps an
 * unstated pool exactly what it always was.
 *
 * The pool is observed WHERE IT IS SPENT — the count of documents the fake
 * reranker is asked to score. A pool resolved but never passed to the port
 * would leave every ranking unchanged and every assertion about it vacuous,
 * which is the failure this file exists to catch.
 *
 * `--flat` is pinned throughout: grouping floors the first pass at
 * `GROUPED_POOL_FLOOR` independently of the rerank pool, so a grouped run
 * cannot show the pool moving at all.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { RERANK_K_INIT, RERANK_MODEL_ID } from '../src/config.js';
import { parseIngestProfile } from '../src/ingestProfile.js';
import { resetRerankProbeCache } from '../src/rerank.js';
import { activeProfile } from '../src/vocabulary.js';

const LABELS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima',
] as const;

/** Every document is an atom, so the whole corpus fits inside the shipped pool. */
const CORPUS_ATOMS = LABELS.length;

const body = (repeats: number): string =>
  'zestful retrieval '.repeat(repeats).padEnd(400, 'x padding sentence about other things ');

interface Fixture {
  /** No `rerankPoolK` — the arm that must reproduce today byte for byte. */
  readonly basePath: string;
  /** Identical but for `rerankPoolK`, so the profile key is the only variable. */
  readonly poolPath: string;
}

const PROFILE_POOL_K = 5;

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-rerank-pool-'));
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
  const base = {
    ...activeProfile(),
    repoRoot,
    corpusRoots: ['doc'],
    atomsDir: join(repoRoot, 'atoms'),
  };
  const basePath = join(repoRoot, 'base.profile.json');
  const poolPath = join(repoRoot, 'pool.profile.json');
  await writeFile(basePath, JSON.stringify(base), 'utf8');
  await writeFile(poolPath, JSON.stringify({ ...base, rerankPoolK: PROFILE_POOL_K }), 'utf8');
  await runCli(['ingest', '--profile', basePath]);
  return { basePath, poolPath };
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

const scored = (order: readonly string[]): unknown => ({
  results: order.map((_doc, position) => ({
    index: position,
    relevance_score: 1 - position * 0.01,
  })),
});

/** Every scoring call's document count, in order. The probe is excluded. */
const countingServer = (): number[] => {
  const counts: number[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { readonly body?: string }): Promise<unknown> => {
    if (url.endsWith('/v1/models')) return okResponse({ data: [{ id: RERANK_MODEL_ID }] });
    const call = callOf(init);
    if (call.query.includes(PROBE_MARKER)) return okResponse({ results: HEALTHY_PROBE });
    counts.push(call.documents.length);
    return okResponse(scored(call.documents));
  });
  return counts;
};

const retrieve = async (profilePath: string, extra: readonly string[] = []): Promise<string> => {
  const out = await runCli([
    'retrieve',
    'zestful retrieval',
    // `linear` scans the atoms directly, so no index build stands between the
    // pool this asserts and the documents the reranker is handed.
    '--adapter', 'linear',
    '--profile', profilePath,
    '--json',
    '--flat',
    '-k', '2',
    '--rerank',
    ...extra,
  ]);
  return out.stdout;
};

/** One number: how deep the first pass actually went, summed over the batches. */
const pooledOf = async (profilePath: string, extra: readonly string[] = []): Promise<number> => {
  const counts = countingServer();
  await retrieve(profilePath, extra);
  return counts.reduce((total, count) => total + count, 0);
};

const usageErrorFor = async (extra: readonly string[]) =>
  await runCli(['retrieve', 'zestful retrieval', '--adapter', 'linear', ...extra]);

const RAW_PROFILE = {
  name: 'probe',
  domains: ['engineering'],
  types: ['knowledge'],
  defaultType: 'knowledge',
  domainRules: [{ prefix: 'doc', domain: 'engineering' }],
  typeRules: [],
  segmentRules: [],
};

describe('profile rerankPoolK', () => {
  it('is ABSENT unless the profile states it, and ROUND-TRIPS the count when it does', () => {
    expect(parseIngestProfile(RAW_PROFILE, 'probe.json').rerankPoolK).toBeUndefined();
    expect(parseIngestProfile({ ...RAW_PROFILE, rerankPoolK: 40 }, 'probe.json').rerankPoolK).toBe(40);
  });

  it.each([0, -1, 2.5, '40', null])(
    'REFUSES %p by NAME rather than coercing it into a pool',
    value => {
      // `field "rerankPoolK"`, not the unknown-key refusal — a key the schema
      // never learned would name it too, and prove nothing about the check.
      expect(() => parseIngestProfile({ ...RAW_PROFILE, rerankPoolK: value }, 'probe.json')).toThrow(
        /field "rerankPoolK"/
      );
    }
  );
});

describe('retrieve --rerank-pool', () => {
  beforeEach(() => {
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reranks the shipped RERANK_K_INIT pool when neither flag nor profile states one', async () => {
    const fixture = await makeFixture();

    expect(RERANK_K_INIT).toBe(100);
    // The floor exceeds the corpus, so the pool IS every atom — the pre-change
    // behaviour, and the arm the two below must be distinguishable from.
    expect(await pooledOf(fixture.basePath)).toBe(CORPUS_ATOMS);
  });

  it('delivers the byte-identical ranking an explicit --rerank-pool 100 delivers', async () => {
    const fixture = await makeFixture();
    countingServer();
    const shipped = await retrieve(fixture.basePath);
    vi.unstubAllGlobals();
    resetRerankProbeCache();
    countingServer();

    expect(await retrieve(fixture.basePath, ['--rerank-pool', String(RERANK_K_INIT)])).toBe(shipped);
  });

  it('scores exactly the pool the FLAG names', async () => {
    const fixture = await makeFixture();

    expect(await pooledOf(fixture.basePath, ['--rerank-pool', '4'])).toBe(4);
  });

  it('scores the pool the PROFILE names when no flag overrides it', async () => {
    const fixture = await makeFixture();

    expect(await pooledOf(fixture.poolPath)).toBe(PROFILE_POOL_K);
  });

  it('lets the flag OUTRANK the profile', async () => {
    const fixture = await makeFixture();

    expect(await pooledOf(fixture.poolPath, ['--rerank-pool', '3'])).toBe(3);
  });

  it('exits 2 when passed without --rerank, naming both flags', async () => {
    const result = await usageErrorFor(['--rerank-pool', '20']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--rerank-pool');
    expect(result.stderr).toContain('--rerank');
  });

  it.each(['0', '-4', '2.5', 'deep'])(
    'exits 2 on --rerank-pool %s rather than rounding or clamping it',
    async value => {
      const result = await usageErrorFor(['--rerank', '--rerank-pool', value]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--rerank-pool');
      expect(result.stderr).toContain(value);
    }
  );
});
