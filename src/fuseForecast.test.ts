import { describe, expect, it } from 'vitest';

import {
  alignedRankings,
  assertProvenanceMatch,
  assertReproduces,
  forecastArms,
  forecastReport,
  FUSE_GUARDED_FIELDS,
  FUSE_VARIED_FIELDS,
  fusionSpecs,
  headToHead,
  type Leg,
  provenanceDrift,
  RERANK_RRF_K,
  rrfFuse,
  THREE_WAY_SHARE
} from './fuseForecast.js';
import {
  FUSE_FORECAST_HELP,
  FUSE_LEG_SPECS,
  isFusableRow,
  parseFuseForecastArgs,
  requireLegRow,
  selectLegRow
} from './fuseForecastCli.js';
import type { Qrel } from './metrics.js';
import type { HistoryRow } from './report.js';
import { scoreDataset } from './score.js';

/**
 * Fixtures are stated in memory, never read from a shared work dir: the bench
 * work directory is destructive (GUIDE § Landmines) and a GPU arm may be live.
 */
const DEPTH = 100;

const legRow = (fields: Partial<HistoryRow>): HistoryRow =>
  ({
    ts: '2026-08-20T10:00:00.000Z',
    dataset: 'vault',
    adapter: 'fts5',
    prf: false,
    depth: DEPTH,
    rerank: false,
    runPath: 'runs/a.trec',
    atomCount: 100,
    corpusLines: 10,
    ndcg10: 0,
    ...fields,
  }) as HistoryRow;

const rankings = (entries: readonly (readonly [string, readonly string[]])[]) =>
  new Map(entries);

const qrelsOf = (
  entries: readonly (readonly [string, readonly (readonly [string, number])[]])[]
): ReadonlyMap<string, Qrel> =>
  new Map(entries.map(([queryId, judged]) => [queryId, new Map(judged)]));

describe('rrfFuse', () => {
  it('scores the union with the engine formula, w on the first leg', () => {
    const fused = rrfFuse([['a', 'b'], ['b', 'a']], [0.7, 0.3]);
    // a: 0.7/21 + 0.3/22 = 0.046969...  b: 0.7/22 + 0.3/21 = 0.045909...
    expect(fused).toEqual(['a', 'b']);
  });

  it('uses 1-based ranks against K', () => {
    const fused = rrfFuse([['a'], ['b']], [0.5, 0.5]);
    expect(fused).toEqual(['a', 'b']);
    expect(RERANK_RRF_K).toBe(20);
  });

  it('gives a document absent from a leg no contribution from that leg', () => {
    // `only` sits at rank 1 of leg two and nowhere in leg one. With a 0.99 share
    // on leg one it must still lose to leg one's own rank-1 document.
    expect(rrfFuse([['top'], ['only']], [0.99, 0.01])).toEqual(['top', 'only']);
    // A synthetic tail rank for the missing leg would have flipped this pair.
    expect(rrfFuse([['top'], ['only']], [0.01, 0.99])).toEqual(['only', 'top']);
  });

  it('fuses three legs at a uniform share', () => {
    const fused = rrfFuse([['a'], ['a'], ['b']], [THREE_WAY_SHARE, THREE_WAY_SHARE, THREE_WAY_SHARE]);
    expect(fused).toEqual(['a', 'b']);
  });

  it('truncates the union to the given depth', () => {
    expect(rrfFuse([['a', 'b'], ['c', 'd']], [0.5, 0.5], 3)).toHaveLength(3);
  });

  it('breaks an exact tie on the document id, deterministically', () => {
    expect(rrfFuse([['b', 'a'], ['a', 'b']], [0.5, 0.5])).toEqual(['a', 'b']);
  });
});

describe('provenance guard', () => {
  it('exempts exactly the adapter and the PRF treatment', () => {
    expect([...FUSE_VARIED_FIELDS]).toEqual(['adapter', 'prf', 'prfDocs', 'prfTerms', 'prfAlpha']);
    expect(FUSE_GUARDED_FIELDS).toContain('atomCount');
    expect(FUSE_GUARDED_FIELDS).toContain('corpusLines');
    expect(FUSE_GUARDED_FIELDS).not.toContain('adapter');
    expect(FUSE_GUARDED_FIELDS).not.toContain('prf');
  });

  it('passes legs that differ only in adapter and PRF', () => {
    const legs: readonly Leg[] = [
      { label: 'fts5', row: legRow({}), rankings: new Map() },
      { label: 'linear', row: legRow({ adapter: 'linear' }), rankings: new Map() },
      { label: 'fts5+prf', row: legRow({ prf: true, prfDocs: 3 }), rankings: new Map() },
    ];
    expect(provenanceDrift(legs)).toEqual([]);
    expect(() => assertProvenanceMatch(legs)).not.toThrow();
  });

  it('refuses a drifted atomCount, naming the field and every leg value', () => {
    const legs: readonly Leg[] = [
      { label: 'fts5', row: legRow({ atomCount: 100 }), rankings: new Map() },
      { label: 'linear', row: legRow({ adapter: 'linear', atomCount: 296 }), rankings: new Map() },
      { label: 'fts5+prf', row: legRow({ prf: true }), rankings: new Map() },
    ];
    const drift = provenanceDrift(legs);
    expect(drift.map(item => item.field)).toEqual(['atomCount']);
    expect(() => assertProvenanceMatch(legs)).toThrow(/atomCount/);
    expect(() => assertProvenanceMatch(legs)).toThrow(/linear=296/);
    expect(() => assertProvenanceMatch(legs)).toThrow(/fts5=100/);
  });

  it('treats an absent field as absent, never as a measured zero', () => {
    const legs: readonly Leg[] = [
      { label: 'a', row: legRow({ tokenBudget: 0 }), rankings: new Map() },
      { label: 'b', row: legRow({}), rankings: new Map() },
    ];
    expect(provenanceDrift(legs).map(item => item.field)).toEqual(['tokenBudget']);
  });
});

describe('assertReproduces', () => {
  it('accepts a leg inside the tolerance', () => {
    expect(() => assertReproduces('fts5', 0.5, 0.5 + 1e-12)).not.toThrow();
  });

  it('refuses a leg that no longer reproduces its recorded number', () => {
    expect(() => assertReproduces('fts5', 0.5, 0.51)).toThrow(/no longer reproduces/);
  });
});

describe('alignedRankings', () => {
  it('keeps a judged topic the run file never retrieved for', () => {
    const aligned = alignedRankings(
      qrelsOf([['q1', [['d1', 1]]], ['q2', [['d2', 1]]]]),
      rankings([['q1', ['d1']]])
    );
    expect([...aligned.keys()]).toEqual(['q1', 'q2']);
    expect(aligned.get('q2')).toEqual([]);
  });
});

describe('fusionSpecs', () => {
  it('names both pairs at every weight, then the uniform three-way', () => {
    const specs = fusionSpecs(['fts5', 'linear', 'fts5+prf']);
    expect(specs).toHaveLength(7);
    expect(specs.map(spec => spec.label)).toEqual([
      'fts5⊕linear w=0.3',
      'fts5⊕linear w=0.5',
      'fts5⊕linear w=0.7',
      'fts5+prf⊕linear w=0.3',
      'fts5+prf⊕linear w=0.5',
      'fts5+prf⊕linear w=0.7',
      'fts5⊕linear⊕fts5+prf uniform',
    ]);
    expect(specs[0]?.weights).toEqual([0.3, 0.7]);
  });
});

/** Two topics where `fts5` and `linear` each win one — the complementarity case. */
const QRELS = qrelsOf([['q1', [['d1', 1]]], ['q2', [['d2', 1]]]]);

const FTS5 = rankings([['q1', ['d1', 'x']], ['q2', ['x', 'd2']]]);
const LINEAR = rankings([['q1', ['x', 'd1']], ['q2', ['d2', 'x']]]);
const PRF = rankings([['q1', ['d1', 'x']], ['q2', ['d2', 'x']]]);

const recordedNdcg = (run: ReadonlyMap<string, readonly string[]>): number =>
  scoreDataset(alignedRankings(QRELS, run), QRELS, DEPTH).mean.ndcg10;

const input = () => ({
  dataset: 'vault',
  qrels: QRELS,
  legs: [
    { label: 'fts5', row: legRow({ ndcg10: recordedNdcg(FTS5) }), rankings: FTS5 },
    {
      label: 'linear',
      row: legRow({ adapter: 'linear', ndcg10: recordedNdcg(LINEAR) }),
      rankings: LINEAR,
    },
    { label: 'fts5+prf', row: legRow({ prf: true, ndcg10: recordedNdcg(PRF) }), rankings: PRF },
  ],
});

describe('forecastArms', () => {
  it('reports the three legs and the seven fusions', () => {
    const arms = forecastArms(input());
    expect(arms).toHaveLength(10);
    expect(arms.slice(0, 3).map(arm => arm.label)).toEqual(['fts5', 'linear', 'fts5+prf']);
  });

  it('refuses a leg whose .trec no longer reproduces its recorded nDCG@10', () => {
    const base = input();
    const broken = {
      ...base,
      legs: [{ ...base.legs[0], row: legRow({ ndcg10: 0.9 }) }, ...base.legs.slice(1)],
    };
    expect(() => forecastArms(broken as never)).toThrow(/no longer reproduces/);
  });

  it('refuses before fusing when provenance drifted', () => {
    const base = input();
    const drifted = {
      ...base,
      legs: [
        { ...base.legs[0], row: legRow({ ndcg10: recordedNdcg(FTS5), corpusLines: 999 }) },
        ...base.legs.slice(1),
      ],
    };
    expect(() => forecastArms(drifted as never)).toThrow(/corpusLines/);
  });
});

describe('headToHead', () => {
  it('counts a win, a loss and a tie per topic', () => {
    const arms = forecastArms(input());
    const [fts5, linear] = arms;
    const pair = headToHead(fts5 as never, linear as never);
    expect(pair).toEqual({ left: 'fts5', right: 'linear', wins: 1, losses: 1, ties: 0 });
  });

  it('calls a difference below the tolerance a tie', () => {
    const arms = forecastArms(input());
    const [fts5] = arms;
    expect(headToHead(fts5 as never, fts5 as never).ties).toBe(2);
  });
});

describe('forecastReport', () => {
  it('renders an arm table and a per-topic win/loss/tie table', () => {
    const lines = forecastReport(input());
    expect(lines[0]).toContain('vault');
    expect(lines).toContain('| arm | nDCG@10 | R@100 |');
    expect(lines).toContain('| pair (per-topic nDCG@10) | win | loss | tie |');
    expect(lines.filter(line => line.startsWith('| fts5 |'))).toHaveLength(1);
    expect(lines.some(line => line.startsWith('| fts5 vs linear |'))).toBe(true);
    expect(lines.some(line => line.startsWith('| fts5+prf vs linear |'))).toBe(true);
  });

  it('reports one measured row per arm', () => {
    const rows = forecastReport(input()).filter(line => /^\| .+ \| \d\.\d{4} \| /.test(line));
    expect(rows).toHaveLength(10);
  });
});

describe('fuseForecastCli argument and leg selection', () => {
  it('defaults to vault then nfcorpus, and narrows with --only', () => {
    expect(parseFuseForecastArgs([]).datasets).toEqual(['vault', 'nfcorpus']);
    expect(parseFuseForecastArgs(['--only', 'nfcorpus']).datasets).toEqual(['nfcorpus']);
  });

  it('refuses --only without a value', () => {
    expect(() => parseFuseForecastArgs(['--only', '--help'])).toThrow(/--only/);
  });

  it('rejects a row that is reranked, shallow, off-dataset or has no runPath', () => {
    expect(isFusableRow(legRow({}), 'vault')).toBe(true);
    expect(isFusableRow(legRow({ rerank: true }), 'vault')).toBe(false);
    expect(isFusableRow(legRow({ depth: 20 }), 'vault')).toBe(false);
    expect(isFusableRow(legRow({ runPath: undefined }), 'vault')).toBe(false);
    expect(isFusableRow(legRow({}), 'nfcorpus')).toBe(false);
  });

  it('picks the latest matching row by timestamp', () => {
    const history = [
      legRow({ ts: '2026-08-20T10:00:00.000Z', runPath: 'runs/old.trec' }),
      legRow({ ts: '2026-08-21T10:00:00.000Z', runPath: 'runs/new.trec' }),
      legRow({ ts: '2026-08-22T10:00:00.000Z', adapter: 'linear', runPath: 'runs/other.trec' }),
    ];
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[0] as never)?.runPath).toBe('runs/new.trec');
  });

  it('separates the PRF leg from the plain fts5 leg', () => {
    const history = [legRow({ prf: true, runPath: 'runs/prf.trec' })];
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[0] as never)).toBeUndefined();
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[2] as never)?.runPath).toBe('runs/prf.trec');
  });

  it('reads a pre-flag row with no prf key as the prf-OFF leg', () => {
    const preFlag = legRow({ runPath: 'runs/preflag.trec' });
    delete (preFlag as { prf?: boolean }).prf;
    const history = [preFlag, legRow({ adapter: 'linear', runPath: 'runs/preflag-linear.trec' })];
    delete (history[1] as { prf?: boolean }).prf;
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[0] as never)?.runPath)
      .toBe('runs/preflag.trec');
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[1] as never)?.runPath)
      .toBe('runs/preflag-linear.trec');
    expect(selectLegRow(history, 'vault', FUSE_LEG_SPECS[2] as never)).toBeUndefined();
  });

  it('names the missing leg when no recorded row qualifies', () => {
    expect(() => requireLegRow([], 'vault', FUSE_LEG_SPECS[1] as never)).toThrow(/linear/);
  });

  it('documents its exit codes in --help', () => {
    expect(FUSE_FORECAST_HELP).toContain('exit codes:');
    expect(FUSE_FORECAST_HELP).toContain('--only');
  });
});
