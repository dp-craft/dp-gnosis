/**
 * The gold-audit CLI's arithmetic, on the three seams that made its numbers
 * incomparable to a recorded row: which dedupe it measures, which topics it
 * averages over, and whether a topic that retrieved NOTHING is visible.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BeirDoc } from '../src/beir.js';
import {
  auditIngestOptions,
  emptyRankingLines,
  emptyRankingTopics,
  GOLD_AUDIT_EMPTY_RUN_CAUSE,
  GOLD_AUDIT_EXIT_REFUSED,
  GOLD_AUDIT_EXIT_USAGE,
  main,
  requireRunFile,
  scoreRun
} from '../src/goldAuditCli.js';
import type { BeirDataset, DatasetEntry } from '../src/manifest.js';
import type { Qrel } from '../src/metrics.js';

const DOCS: readonly BeirDoc[] = [{ id: 'd1', title: 'One', text: 'Body one.' }];

const qrelsOf = (entries: readonly (readonly [string, Qrel])[]): ReadonlyMap<string, Qrel> =>
  new Map(entries);

const beirEntry = (derive: boolean): DatasetEntry => {
  const base: BeirDataset = {
    id: 'fixture',
    format: 'beir-local',
    source: 'data/fixture',
    qrels: 'test',
    domain: 'test',
    docShape: 'abstract',
    enabled: true,
    layers: [],
  };
  return derive ? { ...base, derive: { atoms: 'a', golden: 'g' } } : base;
};

const JUDGED = qrelsOf([['q1', new Map([['d1', 1]])]]);

const NOW = '2026-09-01T00:00:00.000Z';

describe('auditIngestOptions — the audit measures the dedupe PRODUCTION performs', () => {
  it('hands the golden ids to a derived dataset, as run.ts does', () => {
    expect(auditIngestOptions(beirEntry(true), DOCS, JUDGED).goldIds).toEqual(['d1']);
  });

  it('stays gold-blind for a non-derived dataset, as run.ts does', () => {
    expect(auditIngestOptions(beirEntry(false), DOCS, JUDGED).goldIds).toBeUndefined();
  });
});

describe('requireRunFile — a run file that ranks nothing is refused, not scored', () => {
  const trecAt = (body: string): string => {
    const path = resolve(mkdtempSync(resolve(tmpdir(), 'gnosis-goldaudit-')), 'run.trec');
    writeFileSync(path, body, 'utf8');
    return path;
  };

  /**
   * An existing but empty `.trec` scores every qrels topic at depth 0 and prints
   * a confident `nDCG@10 0.0000` beside the recorded rows.
   */
  it('refuses an existing .trec holding no ranking line, with a named cause', () => {
    const act = (): unknown => requireRunFile(trecAt('\n'));
    expect(act).toThrow(expect.objectContaining({ cause: GOLD_AUDIT_EMPTY_RUN_CAUSE }));
  });

  it('accepts a .trec that ranks at least one topic', () => {
    expect(() => requireRunFile(trecAt('q1 Q0 d1 1 1.0 run\n'))).not.toThrow();
  });

  /**
   * The invocation named its dataset and its run file, and both were readable —
   * only the CONTENT refused. Exit 2 would file that under "you typed it wrong".
   */
  it('exits refused from main for an empty run file, and usage for a missing --dataset', async () => {
    const argv = ['--dataset', 'fixture', '--run', trecAt('\n')];
    await expect(main(argv, NOW)).resolves.toBe(GOLD_AUDIT_EXIT_REFUSED);
    await expect(main([], NOW)).resolves.toBe(GOLD_AUDIT_EXIT_USAGE);
  });

  it('exits refused from main for a run file holding a malformed TREC line', async () => {
    const argv = ['--dataset', 'fixture', '--run', trecAt('q1 Q0\n')];
    await expect(main(argv, NOW)).resolves.toBe(GOLD_AUDIT_EXIT_REFUSED);
  });
});

describe('scoreRun — the topic base is the QRELS, not the recorded .trec', () => {
  const qrels = qrelsOf([
    ['q1', new Map([['d1', 1]])],
    ['q2', new Map([['d2', 1]])],
  ]);

  /**
   * `run.ts` scores every topic the run asked for, a topic that retrieved
   * nothing included; averaging over the .trec's topics alone divides by a
   * smaller denominator and prints a number that reads comparable and is not
   * (nfcorpus: 0.3319 against the 0.3164 recorded for the same run).
   */
  it('scores a topic with no ranking as 0 rather than dropping it', () => {
    const run = new Map<string, readonly string[]>([['q1', ['d1']]]);
    expect(scoreRun(run, qrels).ndcg10).toBeCloseTo(0.5, 10);
  });

  it('is unchanged when every qrels topic is ranked', () => {
    const run = new Map<string, readonly string[]>([
      ['q1', ['d1']],
      ['q2', ['d2']],
    ]);
    expect(scoreRun(run, qrels).ndcg10).toBeCloseTo(1, 10);
  });
});

describe('emptyRankingTopics — a topic that retrieved NOTHING is named, never silent', () => {
  const qrels = qrelsOf([
    ['q1', new Map([['d1', 1]])],
    ['q2', new Map([['d2', 1]])],
    ['q3', new Map([['d3', 1]])],
  ]);

  it('counts a topic absent from the run and one recorded with no lines', () => {
    const run = new Map<string, readonly string[]>([
      ['q1', ['d1']],
      ['q2', []],
    ]);
    expect(emptyRankingTopics(run, qrels)).toEqual(['q2', 'q3']);
  });

  it('reports the count against the full qrels topic set', () => {
    const run = new Map<string, readonly string[]>([['q1', ['d1']]]);
    expect(emptyRankingLines(run, qrels)[0]).toContain('2 of 3');
  });

  it('names at most ten of them', () => {
    const many = qrelsOf(
      Array.from({ length: 12 }, (_unused, index): readonly [string, Qrel] => [
        `t${index}`,
        new Map([['d1', 1]]),
      ])
    );
    const named = emptyRankingLines(new Map<string, readonly string[]>(), many)[1] ?? '';
    expect(named.split(' ').filter(token => /^t\d+$/.test(token))).toHaveLength(10);
  });
});
