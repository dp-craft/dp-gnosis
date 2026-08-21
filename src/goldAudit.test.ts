import { describe, expect, it } from 'vitest';

import type { DuplicateLink } from './engine.js';
import { auditGold, rePointQrels } from './goldAudit.js';
import type { Qrel } from './metrics.js';

const qrelsOf = (rows: Readonly<Record<string, Readonly<Record<string, number>>>>): ReadonlyMap<string, Qrel> =>
  new Map(Object.entries(rows).map(([topic, graded]) => [topic, new Map(Object.entries(graded))]));

/**
 * Two orphaned documents (`d4`, `d5`), one of them judged by two topics and the
 * other by none — so the audit has to distinguish "orphaned" from "orphaned AND
 * judged", which is the difference between a corpus-hygiene note and a recall
 * ceiling.
 */
const input = {
  datasetId: 'fixture',
  corpusDocIds: ['d1', 'd2', 'd3', 'd4', 'd5'],
  representedDocIds: ['d1', 'd2', 'd3'],
  qrels: qrelsOf({
    t1: { d1: 2, d4: 1 },
    t2: { d4: 2, d2: 0 },
    t3: { d3: 1 },
  }),
} as const;

describe('auditGold', () => {
  it('counts the orphaned documents and the judgments they make unwinnable', () => {
    expect(auditGold(input)).toEqual({
      datasetId: 'fixture',
      corpusDocs: 5,
      representedDocs: 3,
      orphanedDocs: 2,
      orphanedJudgedDocs: 1,
      lostJudgments: 2,
      affectedTopics: 2,
      totalRelevantJudgments: 4,
    });
  });

  it('does not count a grade-0 judgment as gold', () => {
    const audit = auditGold({
      ...input,
      qrels: qrelsOf({ t1: { d4: 0 }, t2: { d1: 1 } }),
    });
    expect(audit.lostJudgments).toBe(0);
    expect(audit.affectedTopics).toBe(0);
    expect(audit.totalRelevantJudgments).toBe(1);
  });

  it('reports a clean corpus as zero orphans', () => {
    const audit = auditGold({ ...input, representedDocIds: input.corpusDocIds });
    expect(audit.orphanedDocs).toBe(0);
    expect(audit.orphanedJudgedDocs).toBe(0);
    expect(audit.lostJudgments).toBe(0);
  });
});

describe('rePointQrels', () => {
  const links: readonly DuplicateLink[] = [{ orphanDocId: 'd4', survivorDocId: 'd1' }];

  it('moves an orphan\'s grade onto the document whose body survived', () => {
    const rePointed = rePointQrels(qrelsOf({ t2: { d4: 2, d2: 0 } }), links);
    expect([...rePointed.get('t2')!]).toEqual([
      ['d1', 2],
      ['d2', 0],
    ]);
  });

  it('keeps the higher grade when the survivor is already judged by the topic', () => {
    const rePointed = rePointQrels(qrelsOf({ t1: { d1: 2, d4: 1 } }), links);
    expect(rePointed.get('t1')!.get('d1')).toBe(2);
    expect(rePointed.get('t1')!.has('d4')).toBe(false);
  });

  it('raises the survivor when the orphan carried the stronger judgment', () => {
    const rePointed = rePointQrels(qrelsOf({ t1: { d1: 1, d4: 2 } }), links);
    expect(rePointed.get('t1')!.get('d1')).toBe(2);
  });

  it('leaves the qrels it was given untouched', () => {
    const original = qrelsOf({ t2: { d4: 2 } });
    rePointQrels(original, links);
    expect(original.get('t2')!.get('d4')).toBe(2);
  });

  it('is the identity when no document was orphaned', () => {
    const rePointed = rePointQrels(qrelsOf({ t1: { d1: 2 } }), []);
    expect([...rePointed.get('t1')!]).toEqual([['d1', 2]]);
  });
});
