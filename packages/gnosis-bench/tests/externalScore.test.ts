import { describe, expect, it } from 'vitest';

import type { Qrel } from '../src/beir.js';
import { alignToQrels, parseTrecRun, unresolvableIds } from '../src/externalScore.js';

const line = (queryId: string, docId: string, rank: number): string =>
  `${queryId} Q0 ${docId} ${rank} ${1 / rank} qmd`;

const qrelsOf = (ids: readonly string[]): ReadonlyMap<string, Qrel> =>
  new Map(ids.map(id => [id, new Map([['d1', 1]])]));

describe('parseTrecRun', () => {
  it('orders each topic by the rank column, not by line order', () => {
    const text = [line('q1', 'dC', 3), line('q1', 'dA', 1), line('q1', 'dB', 2)].join('\n');
    expect(parseTrecRun(text).get('q1')).toEqual(['dA', 'dB', 'dC']);
  });

  it('keeps topics separate and tolerates blank lines', () => {
    const text = [line('q1', 'dA', 1), '', line('q2', 'dB', 1), ''].join('\n');
    expect([...parseTrecRun(text)]).toEqual([
      ['q1', ['dA']],
      ['q2', ['dB']],
    ]);
  });

  it('throws on a line without exactly six fields', () => {
    expect(() => parseTrecRun('q1 Q0 dA 1 0.9')).toThrow(/needs 6 fields/);
  });

  it('throws on a non-numeric rank rather than scoring an unclaimed order', () => {
    expect(() => parseTrecRun('q1 Q0 dA first 0.9 qmd')).toThrow(/non-numeric rank/);
  });
});

describe('alignToQrels', () => {
  it('emits one entry per qrels topic, in qrels order', () => {
    const rankings = new Map([['q2', ['dA']]]);
    expect([...alignToQrels(rankings, qrelsOf(['q1', 'q2']), 10).keys()]).toEqual(['q1', 'q2']);
  });

  it('gives a qrels topic the run never mentions an empty ranking', () => {
    const rankings = new Map([['q2', ['dA']]]);
    expect(alignToQrels(rankings, qrelsOf(['q1', 'q2']), 10).get('q1')).toEqual([]);
  });

  it('truncates each ranking to depth', () => {
    const rankings = new Map([['q1', ['dA', 'dB', 'dC']]]);
    expect(alignToQrels(rankings, qrelsOf(['q1']), 2).get('q1')).toEqual(['dA', 'dB']);
  });

  it('drops a run topic the qrels do not judge', () => {
    const rankings = new Map([['q1', ['dA']], ['qX', ['dB']]]);
    expect([...alignToQrels(rankings, qrelsOf(['q1']), 10).keys()]).toEqual(['q1']);
  });
});

describe('unresolvableIds', () => {
  it('returns the distinct ids the corpus does not hold', () => {
    const rankings = new Map([
      ['q1', ['known', 'ghost']],
      ['q2', ['ghost', 'other']],
    ]);
    expect(unresolvableIds(rankings, new Set(['known']))).toEqual(['ghost', 'other']);
  });

  it('returns nothing when every id resolves', () => {
    const rankings = new Map([['q1', ['a', 'b']]]);
    expect(unresolvableIds(rankings, new Set(['a', 'b']))).toEqual([]);
  });
});
