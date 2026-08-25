/**
 * The inventory joins recorded history rows to the artefacts they name. Its
 * whole value is telling apart "the row says the file is there" from "the file
 * is there" — so the tests fabricate a results directory where one row's run
 * file is missing, one row carries no `runPath` at all, and one artefact is
 * backdated far behind its row (handbook/GNOSIS-GUIDE.md § Landmines: a stale untracked
 * derived artefact reads exactly like a code defect).
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildInventory,
  main,
  MTIME_LEAD_TOLERANCE_MS,
  mtimeVerdict,
  summarize
} from '../scripts/inventory-artefacts.js';

const ROW_TS = '2026-08-10T12:00:00.000Z';

const row = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    ts: ROW_TS,
    gitSha: 'abc1234',
    dataset: 'vault',
    adapter: 'fts5',
    analyzer: 'default',
    depth: 100,
    rerank: false,
    corpusBytes: 10,
    corpusLines: 2,
    topics: 3,
    docCount: 4,
    atomCount: 5,
    ingestMs: 6,
    queryMs: 7,
    ndcg10: 0.5,
    mrr10: 0.5,
    ...extra,
  });

const seed = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-inv-'));
  mkdirSync(join(dir, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'per-topic'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'a.trec'), 'q1 Q0 d1 1 1.0 tag\n', 'utf8');
  writeFileSync(join(dir, 'per-topic', 'a.tsv'), 'query_id\tndcg10\n', 'utf8');
  writeFileSync(join(dir, 'per-topic', 'stale.tsv'), 'query_id\tndcg10\n', 'utf8');
  // The two healthy artefacts are dated at their row; only `stale.tsv` is not.
  const onTime = new Date(Date.parse(ROW_TS));
  utimesSync(join(dir, 'runs', 'a.trec'), onTime, onTime);
  utimesSync(join(dir, 'per-topic', 'a.tsv'), onTime, onTime);
  const backdated = new Date(Date.parse(ROW_TS) - 90 * 24 * 3600 * 1000);
  utimesSync(join(dir, 'per-topic', 'stale.tsv'), backdated, backdated);
  writeFileSync(
    join(dir, 'history.jsonl'),
    [
      row({ runPath: 'runs/a.trec', perTopicPath: 'per-topic/a.tsv' }),
      row({ dataset: 'vault-hu', runPath: 'runs/gone.trec', perTopicPath: 'per-topic/stale.tsv' }),
      row({ dataset: 'legacy' }),
      'not json at all',
    ].join('\n') + '\n',
    'utf8'
  );
  return dir;
};

describe('inventory-artefacts', () => {
  it('marks a row re-scorable only when its .trec is on disk', () => {
    const inventory = buildInventory(seed());
    const totals = summarize(inventory);
    expect(totals.rows).toBe(3);
    expect(totals.rescorable).toBe(1);
    expect(totals.pairable).toBe(2);
    expect(totals.missingRun).toBe(1);
    expect(totals.noRunPath).toBe(1);
    expect(totals.noPerTopicPath).toBe(1);
  });

  it('flags an artefact whose mtime sits far behind its row timestamp', () => {
    const flagged = buildInventory(seed()).filter(entry => entry.anomalies.length > 0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.dataset).toBe('vault-hu');
    expect(flagged[0]?.anomalies[0]).toContain('per-topic');
  });

  it('reads an mtime just before its row as normal — artefacts are written first', () => {
    const ts = Date.parse(ROW_TS);
    expect(mtimeVerdict(ts, ts - MTIME_LEAD_TOLERANCE_MS + 1000)).toBe('ok');
    expect(mtimeVerdict(ts, ts - MTIME_LEAD_TOLERANCE_MS - 1000)).toBe('older-than-row');
  });

  it('exits 2 on a results directory that holds no history file', () => {
    expect(main(['--results', join(tmpdir(), 'gnosis-inv-absent')], seed())).toBe(2);
  });

  it('exits 0 and prints a row per history line', () => {
    expect(main(['--results', seed(), '--format', 'tsv'], seed())).toBe(0);
    expect(main(['--help'], seed())).toBe(0);
  });

  it('exits 2 on an unknown flag', () => {
    expect(main(['--nope'], seed())).toBe(2);
  });
});
