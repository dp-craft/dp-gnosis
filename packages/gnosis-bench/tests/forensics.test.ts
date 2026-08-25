import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  firstRelevantRank,
  isRecallLimited,
  oracleNdcgAt,
  precisionAt,
  readRunFile,
  topicForensics
} from '../src/forensics.js';
import { ndcgAt, type Qrel } from '../src/metrics.js';

const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-forensics-'));

/** The message a throwing call produced, or the empty string when it did not throw. */
const messageOf = (act: () => unknown): string => {
  try {
    act();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CUT = 10;

/** Two relevant docs, plus one JUDGED-BUT-NOT-RELEVANT doc (grade 0). */
const qrel: Qrel = new Map([
  ['a', 1],
  ['b', 1],
  ['z', 0],
]);

/** Graded qrel — oracle reordering must sort by GRADE, not merely by relevance. */
const gradedQrel: Qrel = new Map([
  ['a', 3],
  ['b', 1],
]);

const fixtures: readonly (readonly [string, readonly string[], Qrel])[] = [
  ['relevant docs at the front', ['a', 'b', 'x'], qrel],
  ['relevant docs buried', ['x', 'y', 'z', 'a', 'w', 'b'], qrel],
  ['one relevant retrieved', ['x', 'b', 'y'], qrel],
  ['nothing relevant retrieved', ['x', 'y', 'z'], qrel],
  ['graded, inverted order', ['b', 'a'], gradedQrel],
  ['empty ranking', [], qrel],
];

describe('oracleNdcgAt', () => {
  it.each(fixtures)(
    'should be at least the achieved nDCG, given %s',
    (_name, ranking, topicQrel) => {
      expect(oracleNdcgAt(ranking, topicQrel, CUT)).toBeGreaterThanOrEqual(
        ndcgAt(ranking, topicQrel, CUT)
      );
    }
  );

  it('should be 1 when every relevant doc was retrieved somewhere in the ranking', () => {
    // both relevant docs are present, but at ranks 4 and 6 — reordering can fix it
    expect(oracleNdcgAt(['x', 'y', 'z', 'a', 'w', 'b'], qrel, CUT)).toBeCloseTo(1, 12);
  });

  it('should equal the achieved nDCG when the relevant docs already occupy the front', () => {
    const ranking = ['a', 'b', 'x'];
    expect(oracleNdcgAt(ranking, qrel, CUT)).toBeCloseTo(ndcgAt(ranking, qrel, CUT), 12);
  });

  it('should reorder by relevance GRADE, so a graded doc rises above a lesser one', () => {
    // achieved: grade 1 at rank 1, grade 3 at rank 2 — the oracle swaps them
    expect(ndcgAt(['b', 'a'], gradedQrel, CUT)).toBeLessThan(1);
    expect(oracleNdcgAt(['b', 'a'], gradedQrel, CUT)).toBeCloseTo(1, 12);
  });

  it('should stay below 1 when a relevant doc was never retrieved', () => {
    expect(oracleNdcgAt(['a', 'x'], qrel, CUT)).toBeLessThan(1);
  });
});

describe('precisionAt', () => {
  it('should count the relevant docs in the top k and divide by k', () => {
    expect(precisionAt(['a', 'x', 'b', 'y'], qrel, 4)).toBeCloseTo(0.5, 12);
  });

  it.each(fixtures)(
    'should be bounded by min(1, relevantCount / k), given %s',
    (_name, ranking, topicQrel) => {
      const relevant = [...topicQrel.values()].filter(grade => grade > 0).length;
      const precision = precisionAt(ranking, topicQrel, CUT);
      expect(precision).toBeGreaterThanOrEqual(0);
      expect(precision).toBeLessThanOrEqual(Math.min(1, relevant / CUT));
    }
  );
});

describe('firstRelevantRank', () => {
  it('should report the 1-based rank of the first relevant doc', () => {
    expect(firstRelevantRank(['x', 'z', 'b', 'a'], qrel)).toBe(3);
  });

  it('should be undefined when no relevant doc was retrieved', () => {
    expect(firstRelevantRank(['x', 'y', 'z'], qrel)).toBeUndefined();
  });
});

describe('grade-0 judgments', () => {
  it('should not count a grade-0 doc as relevant, matching metrics.ts', () => {
    expect(precisionAt(['z'], qrel, 1)).toBe(0);
    expect(firstRelevantRank(['z'], qrel)).toBeUndefined();
    expect(oracleNdcgAt(['z'], qrel, CUT)).toBe(0);
    expect(isRecallLimited(['z'], qrel, CUT)).toBe(true);
  });
});

describe('isRecallLimited', () => {
  it('should be false when every relevant doc is somewhere in the ranking', () => {
    expect(isRecallLimited(['x', 'y', 'a', 'b'], qrel, CUT)).toBe(false);
  });

  it('should be true when a relevant doc is missing from the ranking', () => {
    expect(isRecallLimited(['x', 'a'], qrel, CUT)).toBe(true);
  });

  it('should be false at k smaller than the retrieved relevant count', () => {
    // k=1 needs only min(1, 2) = 1 relevant doc, and one was retrieved
    expect(isRecallLimited(['a', 'x'], qrel, 1)).toBe(false);
  });
});

describe('topicForensics', () => {
  it('should report a zero-hit topic as recall-limited with no ordering loss', () => {
    const forensics = topicForensics(['x', 'y', 'z'], qrel, CUT);
    expect(forensics.ndcg).toBe(0);
    expect(forensics.oracleNdcg).toBe(0);
    expect(forensics.firstRelevantRank).toBeUndefined();
    expect(forensics.recallLimited).toBe(true);
    expect(forensics.orderingLoss).toBe(0);
    expect(forensics.recallLoss).toBe(1);
    expect(forensics.retrievedRelevant).toBe(0);
    expect(forensics.relevantCount).toBe(2);
  });

  it('should attribute the whole gap to ORDERING when recall is complete', () => {
    const forensics = topicForensics(['x', 'y', 'z', 'a', 'w', 'b'], qrel, CUT);
    expect(forensics.recallLimited).toBe(false);
    expect(forensics.recallLoss).toBeCloseTo(0, 12);
    expect(forensics.orderingLoss).toBeCloseTo(1 - forensics.ndcg, 12);
    expect(forensics.firstRelevantRank).toBe(4);
    expect(forensics.recall).toBeCloseTo(1, 12);
  });

  it.each(fixtures)(
    'should decompose the deficit as ndcg + orderingLoss + recallLoss = 1, given %s',
    (_name, ranking, topicQrel) => {
      const f = topicForensics(ranking, topicQrel, CUT);
      expect(f.ndcg + f.orderingLoss + f.recallLoss).toBeCloseTo(1, 12);
    }
  );
});

describe('readRunFile', () => {
  const fixture = (name: string, content: string): string => {
    const path = resolve(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  it('should preserve file order and separate topics', () => {
    const path = fixture(
      'two-topics.trec',
      [
        'q1 Q0 docA 1 3 fts5',
        'q1 Q0 docB 2 2 fts5',
        'q2 Q0 docC 1 2 fts5',
        'q1 Q0 docD 3 1 fts5',
        'q2 Q0 docE 2 1 fts5',
      ].join('\n')
    );
    const run = readRunFile(path);
    expect([...run.keys()]).toEqual(['q1', 'q2']);
    expect(run.get('q1')).toEqual(['docA', 'docB', 'docD']);
    expect(run.get('q2')).toEqual(['docC', 'docE']);
  });

  it('should ignore blank lines', () => {
    const path = fixture('blanks.trec', '\nq1 Q0 docA 1 2 fts5\n\n   \nq1 Q0 docB 2 1 fts5\n\n');
    expect(readRunFile(path).get('q1')).toEqual(['docA', 'docB']);
  });

  it('should read an empty file as no topics', () => {
    expect(readRunFile(fixture('empty.trec', '')).size).toBe(0);
  });

  // A line short of the docid column is a TRUNCATED WRITE. Skipping it records a
  // shorter ranking as if it were the ranking the run produced — the recurring
  // failure class of this repo (a component produced nothing, read as data).
  it('should THROW naming the file and the 1-based line number on a short line', () => {
    const path = fixture(
      'truncated.trec',
      ['q1 Q0 docA 1 3 fts5', 'q2 Q0', 'q3 Q0 docC 1 1 fts5'].join('\n')
    );
    const message = messageOf(() => readRunFile(path));
    expect(message).toContain(path);
    expect(message).toContain('line 2');
  });

  it('should THROW on a line carrying only a query id', () => {
    const path = fixture('qid-only.trec', 'q1\n');
    expect(() => readRunFile(path)).toThrow(/line 1/);
  });
});
