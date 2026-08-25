import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRunFile } from '../src/forensics.js';
import {
  allGoldInBudget,
  CAUSE_QREL_DRIFT,
  FORENSICS_COLUMNS,
  forensicsCell,
  forensicsReport,
  type ForensicsRow,
  forensicsTsvRow,
  goldSurvivingBudget,
  metricDisagreements,
  noiseAtServedK,
  parseForensicsArgs,
  recordedMetrics
} from '../src/forensicsCli.js';
import type { Metrics, Qrel } from '../src/metrics.js';
import type { HistoryRow } from '../src/report.js';
import { type ParsedMetrics, readPerTopic, type TopicScores } from '../src/significance.js';

/**
 * Provenance of the fixture — sliced from the RECORDED champion run, not synthesized:
 *
 *   history row  gitSha b64d5bff · ts 2026-08-18T14:42:12.129Z · dataset vault
 *                adapter fts5 · depth 100 · rerankModel qwen3-reranker-4b · ndcg10 0.5040
 *   rankings     results/runs/2026-08-18-144212129-fts5-vault.trec  (first 10 topics)
 *   judgments    data/vault/qrels/test.tsv                          (those topics' rows)
 *   recorded     results/per-topic/2026-08-18-144212129-fts5-vault.tsv (those topics' rows)
 */
const FIXTURES = resolve(__dirname, '../fixtures');
const RUN_FIXTURE = resolve(FIXTURES, 'vault-champion-10.trec');
const QRELS_FIXTURE = resolve(FIXTURES, 'vault-champion-10.qrels.tsv');
const PER_TOPIC_FIXTURE = resolve(FIXTURES, 'vault-champion-10.per-topic.tsv');

const CUT = 10;

const tsvRows = (path: string): readonly (readonly string[])[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .slice(1)
    .map(line => line.split('\t'));

/** The fixture qrels as `queryId -> Qrel`, in the shape `readQrels` produces. */
const readFixtureQrels = (): ReadonlyMap<string, Qrel> =>
  tsvRows(QRELS_FIXTURE).reduce((acc, cols) => {
    const perQuery = acc.get(cols[0] ?? '') ?? new Map<string, number>();
    perQuery.set(cols[1] ?? '', Number(cols[2]));
    return acc.set(cols[0] ?? '', perQuery);
  }, new Map<string, Map<string, number>>());

/**
 * The recorded per-topic scores, read by the SUITE'S OWN parser rather than a
 * second one here. A hand-rolled reader turned this file's empty `recall300` /
 * `recall1000` cells into a measured `0` on the first attempt — the exact defect
 * the drift guard exists to catch, reproduced inside the test that checks it.
 */
const readFixtureRecorded = (): TopicScores => {
  const scores = readPerTopic(PER_TOPIC_FIXTURE);
  if (scores === undefined) throw new Error(`unreadable fixture: ${PER_TOPIC_FIXTURE}`);
  return scores;
};

const row: HistoryRow = {
  ts: '2026-08-18T14:42:12.129Z',
  gitSha: 'b64d5bff',
  dataset: 'vault',
  adapter: 'fts5',
  depth: 100,
} as HistoryRow;

const baseArgs = { run: 'x', k: CUT, servedK: 5, budget: 64000 };

const reportOver = (qrels: ReadonlyMap<string, Qrel>) =>
  forensicsReport({
    row,
    run: readRunFile(RUN_FIXTURE),
    qrels,
    recorded: readFixtureRecorded(),
    bodies: undefined,
    budgetNote: 'not measured in this test',
    tsvPath: '/tmp/forensics.tsv',
    args: baseArgs,
  });

describe('forensics over the recorded champion fixture', () => {
  it('should reproduce every topic\'s RECORDED per-topic nDCG@10', () => {
    const recomputed = reportOver(readFixtureQrels());
    expect(recomputed.kind).toBe('report');
  });

  it('should have scored all ten fixture topics', () => {
    expect(readFixtureRecorded().size).toBe(10);
  });

  it('should agree on every column the legacy champion TSV carries', () => {
    const outcome = reportOver(readFixtureQrels());
    const lines = outcome.kind === 'report' ? outcome.lines : [];
    expect(lines.join('\n')).toContain(
      'agrees with the recorded TSV on 10 topics × 5 recorded columns'
    );
  });

  it('should ADD the four consumer columns the champion TSV predates', () => {
    const outcome = reportOver(readFixtureQrels());
    const body = outcome.kind === 'report' ? outcome.tsv : '';
    const added = ['allGoldInTop10', 'map', 'rPrecision', 'rbpResidual'];
    expect(added.every(name => (body.split('\n')[0] ?? '').includes(name))).toBe(true);
  });
});

/** Drop one topic's gold — the golden set moving under a recorded run. */
const perturbed = (): ReadonlyMap<string, Qrel> => {
  const qrels = new Map([...readFixtureQrels()].map(([id, qrel]) => [id, new Map(qrel)]));
  const first = qrels.get('q-001');
  if (first !== undefined) [...first.keys()].forEach(docId => first.delete(docId));
  return qrels;
};

describe('the drift guard', () => {
  it('should REFUSE when a perturbed qrel no longer reproduces the recorded score', () => {
    const outcome = reportOver(perturbed());
    expect(outcome.kind === 'refused' ? outcome.cause : '').toBe(CAUSE_QREL_DRIFT);
  });

  it('should name both the recorded and the recomputed value', () => {
    const outcome = reportOver(perturbed());
    const lines = outcome.kind === 'refused' ? outcome.lines.join('\n') : '';
    expect(lines).toContain('q-001 ndcg10: recorded 0.8200 vs recomputed 0.0000');
  });

  it('should not fire on a difference within the TSV\'s own 4-decimal rounding', () => {
    const rows = [rowWith({ ndcg10: 0.820_04 })];
    const recorded: TopicScores = new Map([['q-001', { ndcg10: 0.82 } as ParsedMetrics]]);
    expect(metricDisagreements(rows, recorded)).toHaveLength(0);
  });

  it('should check EVERY column the recorded TSV carries, not nDCG@10 alone', () => {
    const rows = [rowWith({ ndcg10: 0.82, map: 0.5 })];
    const recorded: TopicScores = new Map([
      ['q-001', { ndcg10: 0.82, map: 0.9 } as ParsedMetrics],
    ]);
    expect(metricDisagreements(rows, recorded).map(item => item.metric)).toEqual(['map']);
  });

  it('should treat a column a legacy TSV LACKS as not recorded, never as a 0', () => {
    const rows = [rowWith({ ndcg10: 0.82, map: 0.5 })];
    const legacy: TopicScores = new Map([['q-001', { ndcg10: 0.82 } as ParsedMetrics]]);
    expect(metricDisagreements(rows, legacy)).toHaveLength(0);
  });

  it('should report which columns the agreement actually covered', () => {
    const legacy: TopicScores = new Map([['q-001', { ndcg10: 0.82 } as ParsedMetrics]]);
    expect(recordedMetrics(legacy)).toEqual(['ndcg10']);
  });
});

const emptyMetrics = {
  ndcg10: 0,
  mrr10: 0,
  map: 0,
  rbpResidual: 0,
} as Metrics;

const emptyRow: ForensicsRow = {
  queryId: 'q-000',
  metrics: emptyMetrics,
  oracleNdcg10: 0,
  orderingLoss: 0,
  recallLoss: 1,
  firstGoldRank: undefined,
  recallLimited: true,
  goldSurvivesBudget: undefined,
  allGoldInBudget: undefined,
  noiseAtServedK: undefined,
};

/** A `q-001` row carrying only the metrics a drift case needs to state. */
const rowWith = (metrics: Partial<Metrics>): ForensicsRow => ({
  ...emptyRow,
  queryId: 'q-001',
  metrics: { ...emptyMetrics, ...metrics },
});

describe('unmeasurable cells', () => {
  it('should serialize as EMPTY, never as 0', () => {
    expect(forensicsCell(undefined)).toBe('');
  });

  it('should leave firstGoldRank and goldSurvivesBudget empty in the row', () => {
    const cells = forensicsTsvRow(emptyRow).split('\t');
    const rank = FORENSICS_COLUMNS.indexOf('firstGoldRank');
    const gold = FORENSICS_COLUMNS.indexOf('goldSurvivesBudget');
    expect([cells[rank], cells[gold]]).toEqual(['', '']);
  });

  it('should still write a measured zero as 0.0000', () => {
    expect(forensicsCell(0)).toBe('0.0000');
  });

  it('should leave the two derived columns empty in the row', () => {
    const cells = forensicsTsvRow(emptyRow).split('\t');
    const all = FORENSICS_COLUMNS.indexOf('allGoldInBudget');
    const noise = FORENSICS_COLUMNS.indexOf('noiseAtServedK');
    expect([cells[all], cells[noise]]).toEqual(['', '']);
  });

  it('should APPEND the derived columns after goldSurvivesBudget, moving none', () => {
    expect(FORENSICS_COLUMNS.slice(-3)).toEqual([
      'goldSurvivesBudget',
      'allGoldInBudget',
      'noiseAtServedK',
    ]);
  });
});

const qrel: Qrel = new Map([['a', 1], ['b', 1]]);

describe('goldSurvivingBudget', () => {
  it('should be 1 when the budget holds every served gold document', () => {
    const bodies = new Map([['a', 'xx'], ['b', 'yy'], ['c', 'zz']]);
    expect(goldSurvivingBudget(['a', 'c', 'b'], qrel, bodies, 3, 100)).toBe(1);
  });

  it('should drop the gold the budget cannot admit', () => {
    const bodies = new Map([['a', 'xxxx'], ['b', 'yy']]);
    expect(goldSurvivingBudget(['a', 'b'], qrel, bodies, 2, 5)).toBe(0.5);
  });

  it('should be UNMEASURABLE when the served window holds no gold', () => {
    const bodies = new Map([['c', 'zz']]);
    expect(goldSurvivingBudget(['c'], qrel, bodies, 5, 100)).toBeUndefined();
  });

  it('should be UNMEASURABLE when a served body is missing', () => {
    const bodies = new Map([['a', 'xx']]);
    expect(goldSurvivingBudget(['a', 'b'], qrel, bodies, 2, 100)).toBeUndefined();
  });
});

describe('allGoldInBudget', () => {
  it('should be 1 when every gold document is served AND survives the budget', () => {
    const bodies = new Map([['a', 'xx'], ['b', 'yy'], ['c', 'zz']]);
    expect(allGoldInBudget(['a', 'c', 'b'], qrel, bodies, 3, 100)).toBe(1);
  });

  it('should be 0 when a gold document never reaches the served window', () => {
    const bodies = new Map([['a', 'xx'], ['c', 'zz']]);
    expect(allGoldInBudget(['a', 'c'], qrel, bodies, 2, 100)).toBe(0);
  });

  it('should be 0 when gold is served but the budget drops it', () => {
    const bodies = new Map([['a', 'xxxx'], ['b', 'yy']]);
    expect(allGoldInBudget(['a', 'b'], qrel, bodies, 2, 5)).toBe(0);
  });

  it('should be UNMEASURABLE when the topic has no gold at all', () => {
    const bodies = new Map([['a', 'xx']]);
    expect(allGoldInBudget(['a'], new Map(), bodies, 5, 100)).toBeUndefined();
  });

  it('should be UNMEASURABLE when a served body is missing, before any 0', () => {
    const bodies = new Map([['a', 'xx']]);
    expect(allGoldInBudget(['a', 'b'], qrel, bodies, 2, 100)).toBeUndefined();
  });
});

describe('noiseAtServedK', () => {
  it('should be 1 minus precision over the served window', () => {
    expect(noiseAtServedK(['a', 'c', 'b'], qrel, 3)).toBeCloseTo(1 / 3, 10);
  });

  it('should divide by what was DELIVERED, not by servedK', () => {
    expect(noiseAtServedK(['a'], qrel, 5)).toBe(0);
  });

  it('should be UNMEASURABLE when nothing was delivered', () => {
    expect(noiseAtServedK([], qrel, 5)).toBeUndefined();
  });
});

describe('parseForensicsArgs', () => {
  it('should default k, servedK and budget', () => {
    const args = parseForensicsArgs(['--run', 'fts5-vault']);
    expect([args.k, args.servedK]).toEqual([10, 5]);
  });

  it('should refuse a non-integer --served-k rather than clamping it', () => {
    expect(() => parseForensicsArgs(['--run', 'x', '--served-k', '2.5'])).toThrow('--served-k');
  });

  it('should refuse a missing --run', () => {
    expect(() => parseForensicsArgs(['--k', '10'])).toThrow('--run');
  });
});
