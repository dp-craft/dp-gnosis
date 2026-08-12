import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAdapter } from '../src/adapters/fakeAdapter.js';
import { lanceDbAvailability } from '../src/adapters/lanceDbAdapter.js';
import { miniSearchAvailability } from '../src/adapters/miniSearchAdapter.js';
import type { BenchOptions, BenchReport } from '../src/bench.js';
import { COLD_REGIME, runBenchmark, WARM_REGIME } from '../src/bench.js';
import type { AdapterCandidate } from '../src/bench/candidates.js';
import { defaultCandidates, isAvailable, skippedOf } from '../src/bench/candidates.js';
import type { BenchCorpus } from '../src/bench/corpora.js';
import { aggregate, recallAtK, reciprocalRank, scoreQuery } from '../src/bench/metrics.js';
import { renderReportMarkdown } from '../src/bench/report.js';
import { generateSyntheticAtoms } from '../src/bench/syntheticCorpus.js';
import type { GoldenAxis, GoldenQuery, GoldenSet } from '../src/goldenSet.js';
import type { KnowledgePort, RetrievedAtom, RetrieveOptions } from '../src/port.js';

// The FAKE adapter is the whole point of this file's metric assertions: its
// ranking is fixed and query-independent, so every expected value below is
// hand-computed from the fixture and asserted EXACTLY. A metrics bug and a
// ranking bug are otherwise indistinguishable on the first real run.

const atom = (id: string): RetrievedAtom => ({
  id,
  title: `title-${id}`,
  domain: 'runner',
  type: 'knowledge',
  body: `body-${id}`,
  score: 1,
  sourcePath: `RUNNER-${id}.md`,
});

// Fixed ranking: a, b, c, d.
const FIXED_RANKING: readonly RetrievedAtom[] = [atom('a'), atom('b'), atom('c'), atom('d')];

const query = (
  id: string,
  relevantAtomIds: readonly string[],
  axis: GoldenAxis = 'exact-keyword'
): GoldenQuery => ({
  id,
  axis,
  query: `query text for ${id}`,
  domain: null,
  type: null,
  relevantAtomIds,
  rationale: `rationale for ${id}`,
});

const goldenSet = (queries: readonly GoldenQuery[]): GoldenSet => ({
  version: 1,
  frozenAt: '2026-08-08T00:00:00.000Z',
  corpusAtomCount: 4,
  minimumMeaningfulDifference: {
    queries: queries.length,
    recallResolution: queries.length === 0 ? 0 : 1 / queries.length,
    statement: 'a gap below the recall resolution is not a result',
  },
  queries,
});

const fakeCandidate = (name: string, port: KnowledgePort): AdapterCandidate => ({
  name,
  index: () => Promise.resolve(0),
  open: () => port,
});

const unavailableCandidate = (name: string, reason: string): AdapterCandidate => ({
  name,
  unavailableReason: reason,
  index: () => Promise.resolve(0),
  open: () => {
    throw new Error(reason);
  },
});

const corpus = (atomsDir: string): BenchCorpus => ({
  label: 'fixture',
  atomsDir,
  atomCount: 4,
  scoresMetrics: true,
});

const benchOptions = (
  workDir: string,
  candidates: readonly AdapterCandidate[],
  set: GoldenSet
): BenchOptions => ({
  goldenSet: set,
  goldenSetPath: '/fixture/golden-set.v1.json',
  goldenSetHash: 'fixturehash',
  candidates,
  corpora: [corpus(join(workDir, 'atoms'))],
  workDir,
  k: 3,
  timing: { warmupIterations: 0, measuredIterations: 1 },
  now: new Date('2026-08-08T19:30:00.000Z'),
});

describe('recall@k against the fake adapter', () => {
  // Fixed ranking a,b,c,d. Relevant = {b, d}. At k=3 only b is inside the
  // window, so recall = 1 hit / 2 relevant = 0.5 exactly.
  it('counts only hits inside the k window', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], ['b', 'd'], 3)).toBe(0.5);
  });

  it('reports 1 when every relevant atom is inside the window', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], ['a', 'c'], 3)).toBe(1);
  });

  it('reports 0 when no relevant atom is retrieved', () => {
    expect(recallAtK(['a', 'b', 'c'], ['z'], 3)).toBe(0);
  });

  it('does not divide by zero when a query declares no relevant atoms', () => {
    expect(recallAtK(['a', 'b'], [], 3)).toBeUndefined();
  });

  it('deduplicates repeated relevant ids rather than inflating the denominator', () => {
    expect(recallAtK(['a', 'b'], ['a', 'a'], 3)).toBe(1);
  });
});

describe('MRR', () => {
  // Ranking a,b,c,d with relevant = {c}: first hit is rank 3 => 1/3.
  it('uses the FIRST relevant hit rank', () => {
    expect(reciprocalRank(['a', 'b', 'c', 'd'], ['c'])).toBeCloseTo(1 / 3, 12);
  });

  it('ignores later relevant hits once the first is found', () => {
    const single = reciprocalRank(['a', 'b', 'c', 'd'], ['b']);
    const withLaterHits = reciprocalRank(['a', 'b', 'c', 'd'], ['b', 'c', 'd']);

    expect(withLaterHits).toBe(single);
    expect(withLaterHits).toBe(0.5);
  });

  it('reports 0 when nothing relevant was retrieved', () => {
    expect(reciprocalRank(['a', 'b'], ['z'])).toBe(0);
  });

  it('does not divide by zero when a query declares no relevant atoms', () => {
    expect(reciprocalRank(['a', 'b'], [])).toBeUndefined();
  });
});

describe('aggregate', () => {
  // q1 recall 1/2, q2 recall 1/1 => mean 0.75. RR 1/2 and 1/1 => MRR 0.75.
  it('averages only the scorable queries and counts the rest', () => {
    const metrics = [
      scoreQuery(query('q1', ['b', 'd']), ['a', 'b', 'c'], 3),
      scoreQuery(query('q2', ['a']), ['a', 'b', 'c'], 3),
      scoreQuery(query('q3', []), ['a', 'b', 'c'], 3),
    ];

    expect(aggregate(3, metrics)).toEqual({
      k: 3,
      recallAtK: 0.75,
      mrr: 0.75,
      scoredQueries: 2,
      unscorableQueries: 1,
    });
  });

  it('reports undefined averages when every query is unscorable', () => {
    const metrics = [scoreQuery(query('q1', []), ['a'], 3)];

    expect(aggregate(3, metrics).recallAtK).toBeUndefined();
    expect(aggregate(3, metrics).mrr).toBeUndefined();
  });
});

describe('synthetic corpus generation', () => {
  it('produces an identical corpus for the same seed', () => {
    expect(generateSyntheticAtoms(20, 42)).toEqual(generateSyntheticAtoms(20, 42));
  });

  it('produces a different corpus for a different seed', () => {
    expect(generateSyntheticAtoms(20, 42)).not.toEqual(generateSyntheticAtoms(20, 43));
  });

  it('uses no Math.random: a re-generated atom is byte-identical', () => {
    const first = generateSyntheticAtoms(5, 7)[2];
    const second = generateSyntheticAtoms(5, 7)[2];

    expect(first?.content).toBe(second?.content);
    expect(first?.id).toBe('syn-7-000002');
  });
});

describe('runBenchmark', () => {
  const withHarness = async (
    fn: (workDir: string) => Promise<void>
  ): Promise<void> => {
    const workDir = await mkdtemp(join(tmpdir(), 'gnosis-bench-'));
    await mkdir(join(workDir, 'atoms'), { recursive: true });
    await fn(workDir);
    await rm(workDir, { recursive: true, force: true });
  };

  const runFake = async (
    workDir: string,
    candidates: readonly AdapterCandidate[]
  ): Promise<BenchReport> =>
    await runBenchmark(
      benchOptions(workDir, candidates, goldenSet([query('q-001', ['b', 'd']), query('q-002', ['a'])]))
    );

  it('reports the fake adapter metrics exactly as hand-computed', async () => {
    await withHarness(async workDir => {
      const port = createFakeAdapter(FIXED_RANKING);

      const report = await runFake(workDir, [fakeCandidate('fake', port)]);

      // k=3 => window a,b,c. q-001 relevant {b,d}: recall 0.5, RR 1/2.
      // q-002 relevant {a}: recall 1, RR 1/1. Means: recall 0.75, MRR 0.75.
      expect(report.results[0]?.metrics).toEqual({
        k: 3,
        recallAtK: 0.75,
        mrr: 0.75,
        scoredQueries: 2,
        unscorableQueries: 0,
      });
    });
  });

  it('reports the two regimes separately, never merged', async () => {
    await withHarness(async workDir => {
      const report = await runFake(workDir, [fakeCandidate('fake', createFakeAdapter(FIXED_RANKING))]);
      const regimes = report.results[0]?.regimes ?? [];

      expect(regimes.map(regime => regime.regime)).toEqual([COLD_REGIME, WARM_REGIME]);
      expect(regimes[0]?.cacheHitP50Ms).toBeUndefined();
      expect(typeof regimes[1]?.cacheHitP50Ms).toBe('number');
    });
  });

  it('lists an unavailable adapter as skipped and does not measure it', async () => {
    await withHarness(async workDir => {
      const report = await runFake(workDir, [
        fakeCandidate('fake', createFakeAdapter(FIXED_RANKING)),
        unavailableCandidate('lancedb', 'optional dependency @lancedb/lancedb is not installed'),
      ]);

      expect(report.adapters).toEqual(['fake']);
      expect(report.skippedAdapters).toEqual([
        { name: 'lancedb', reason: 'optional dependency @lancedb/lancedb is not installed' },
      ]);
      expect(report.results.map(result => result.adapter)).toEqual(['fake']);
    });
  });

  it('carries the golden-set provenance into the report', async () => {
    await withHarness(async workDir => {
      const report = await runFake(workDir, [fakeCandidate('fake', createFakeAdapter(FIXED_RANKING))]);

      expect(report.goldenSet.sha256).toBe('fixturehash');
      expect(report.goldenSet.frozenAt).toBe('2026-08-08T00:00:00.000Z');
      expect(report.goldenSet.queryCount).toBe(2);
    });
  });
});

describe('renderReportMarkdown', () => {
  const reportWith = async (
    candidates: readonly AdapterCandidate[]
  ): Promise<BenchReport> => {
    const workDir = await mkdtemp(join(tmpdir(), 'gnosis-bench-md-'));
    await mkdir(join(workDir, 'atoms'), { recursive: true });
    const report = await runBenchmark(
      benchOptions(workDir, candidates, goldenSet([query('q-001', ['b'])]))
    );
    await rm(workDir, { recursive: true, force: true });
    return report;
  };

  it('contains the skipped-adapter section naming the reason', async () => {
    const report = await reportWith([
      fakeCandidate('fake', createFakeAdapter(FIXED_RANKING)),
      unavailableCandidate('minisearch', 'optional dependency minisearch is not installed'),
    ]);

    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('## Skipped adapters');
    expect(markdown).toContain('**minisearch** — optional dependency minisearch is not installed');
  });

  it('states that no winner is picked and that the regimes must not be merged', async () => {
    const report = await reportWith([fakeCandidate('fake', createFakeAdapter(FIXED_RANKING))]);

    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('No winner is picked here');
    expect(markdown).toContain('MUST NOT be merged');
    expect(markdown).toContain(COLD_REGIME);
    expect(markdown).toContain(WARM_REGIME);
  });

  it('records the methodology and the pre-registered minimum meaningful difference', async () => {
    const report = await reportWith([fakeCandidate('fake', createFakeAdapter(FIXED_RANKING))]);

    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('## Measurement methodology');
    expect(markdown).toContain('warmup passes (discarded): 0');
    expect(markdown).toContain('a gap below the recall resolution is not a result');
    expect(markdown).toContain('fixturehash');
  });

  it('says explicitly when every declared adapter ran', async () => {
    const report = await reportWith([fakeCandidate('fake', createFakeAdapter(FIXED_RANKING))]);

    expect(renderReportMarkdown(report)).toContain('None — every declared adapter ran.');
  });
});

// Registration, not measurement: a full benchmark takes minutes, so these
// assert only that all four shipped adapters ARE candidates and that an
// optional dependency that failed to load is REPORTED rather than dropped.
describe('defaultCandidates', () => {
  it('registers all four shipped adapters', async () => {
    const candidates = await defaultCandidates();

    expect(candidates.map(candidate => candidate.name)).toEqual([
      'linear-scan',
      'fts5',
      'minisearch',
      'lancedb',
    ]);
  });

  it('gives every unavailable candidate a non-empty reason and a throwing open', async () => {
    const candidates = await defaultCandidates();
    const unavailable = candidates.filter(candidate => !isAvailable(candidate));

    expect(skippedOf(candidates)).toHaveLength(unavailable.length);
    skippedOf(candidates).forEach(entry => {
      expect(entry.reason.length).toBeGreaterThan(0);
    });
    unavailable.forEach(candidate => {
      expect(() => candidate.open({ atomsDir: '/nonexistent', indexPath: '/nonexistent' })).toThrow();
    });
  });

  it('reports the optional-dependency adapters as available in this checkout', async () => {
    const byName = new Map((await defaultCandidates()).map(c => [c.name, c]));
    const probes = { minisearch: await miniSearchAvailability(), lancedb: await lanceDbAvailability() };

    expect(isAvailable(byName.get('minisearch') as AdapterCandidate)).toBe(probes.minisearch.available);
    expect(isAvailable(byName.get('lancedb') as AdapterCandidate)).toBe(probes.lancedb.available);
  });
});

// A golden query's `domain` and `type` are FILTERS, not annotations: unless the
// harness forwards them into `RetrieveOptions` the adapter answers an unfiltered
// question and the measured recall belongs to a query nobody authored.
describe('golden-query filters reach the port', () => {
  const filtered = (id: string, domain: string | null, type: string | null): GoldenQuery => ({
    ...query(id, ['a']),
    domain,
    type,
  });

  const recordingPort = (calls: RetrieveOptions[]): KnowledgePort => ({
    name: 'recording',
    retrieve: (_query: string, opts: RetrieveOptions) => {
      calls.push(opts);
      return Promise.resolve({
        atoms: FIXED_RANKING,
        mode: 'fixed',
        indexState: 'ready' as const,
      });
    },
  });

  const optionsSeen = async (queries: readonly GoldenQuery[]): Promise<RetrieveOptions[]> => {
    const workDir = await mkdtemp(join(tmpdir(), 'gnosis-filter-'));
    await mkdir(join(workDir, 'atoms'), { recursive: true });
    const calls: RetrieveOptions[] = [];
    await runBenchmark(
      benchOptions(workDir, [fakeCandidate('recording', recordingPort(calls))], goldenSet(queries))
    );
    await rm(workDir, { recursive: true, force: true });
    return calls;
  };

  it('forwards a type-only golden query as a type filter', async () => {
    const calls = await optionsSeen([filtered('q-type', null, 'adr')]);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toContainEqual({ k: 3, type: 'adr' });
  });

  it('leaves a null-type query unfiltered', async () => {
    const calls = await optionsSeen([filtered('q-none', null, null)]);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(opts => opts.type === undefined)).toBe(true);
    expect(calls).toContainEqual({ k: 3 });
  });

  it('combines domain and type independently', async () => {
    const calls = await optionsSeen([filtered('q-both', 'runner', 'adr')]);

    expect(calls).toContainEqual({ k: 3, domain: 'runner', type: 'adr' });
  });

  it('keeps a domain-only query free of a type filter', async () => {
    const calls = await optionsSeen([filtered('q-domain', 'runner', null)]);

    expect(calls).toContainEqual({ k: 3, domain: 'runner' });
  });
});
