import type { PrfFeedbackDoc, PrfParams } from '../src/prf.js';
import { DEFAULT_PRF_PARAMS, rm3Weights } from '../src/prf.js';

const params = (over: Partial<PrfParams> = {}): PrfParams => ({ ...DEFAULT_PRF_PARAMS, ...over });

const doc = (terms: readonly string[], score: number): PrfFeedbackDoc => ({ terms, score });

/** Six decimals is the same tolerance the fts5 additivity probe was read at. */
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(actual ?? 0).toBeCloseTo(expected, 6);
};

describe('DEFAULT_PRF_PARAMS', () => {
  it('is the cell the offline forecast measured', () => {
    expect(DEFAULT_PRF_PARAMS).toEqual({ fbDocs: 10, fbTerms: 20, alpha: 0.5 });
  });
});

describe('rm3Weights', () => {
  /**
   * Hand-computed, every step written out.
   *
   * feedback scores 3 and 1 → doc weights 0.75 and 0.25.
   * doc1 ['a','b'] len 2 → a += 0.375, b += 0.375
   * doc2 ['b','c'] len 2 → b += 0.125, c += 0.125
   * mass: b 0.5, a 0.375, c 0.125. fbTerms 2 keeps b and a; z = 0.875.
   * expansion: b = 0.5·0.5/0.875 = 2/7, a = 0.5·0.375/0.875 = 3/14.
   * query base: a = (1−0.5)/1 = 0.5.
   * final: a = 0.5 + 3/14 = 5/7, b = 2/7, and c is not kept at all.
   */
  it('matches a hand-computed RM3 model', () => {
    const weights = rm3Weights({
      queryTerms: ['a'],
      feedback: [doc(['a', 'b'], 3), doc(['b', 'c'], 1)],
      params: params({ fbTerms: 2 }),
    });
    near(weights.get('a'), 5 / 7);
    near(weights.get('b'), 2 / 7);
    expect(weights.has('c')).toBe(false);
  });

  it('sums to one — the query mass and the expansion mass are each normalised', () => {
    const weights = rm3Weights({
      queryTerms: ['a', 'd'],
      feedback: [doc(['a', 'b'], 3), doc(['b', 'c'], 1)],
      params: params({ fbTerms: 3 }),
    });
    const total = [...weights.values()].reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('is the query alone when no feedback document is offered', () => {
    const weights = rm3Weights({ queryTerms: ['a', 'b'], feedback: [], params: params() });
    near(weights.get('a'), 0.25);
    near(weights.get('b'), 0.25);
    expect(weights.size).toBe(2);
  });

  it('reads a repeated query term as repeated mass, never as one term', () => {
    const weights = rm3Weights({ queryTerms: ['a', 'a'], feedback: [], params: params() });
    near(weights.get('a'), 0.5);
  });

  it('honours fbDocs — a document past the cut contributes nothing', () => {
    const weights = rm3Weights({
      queryTerms: ['a'],
      feedback: [doc(['b'], 1), doc(['zzz'], 1)],
      params: params({ fbDocs: 1 }),
    });
    expect(weights.has('zzz')).toBe(false);
    near(weights.get('b'), 0.5);
  });

  it('falls back to uniform document weights when the scores carry no mass', () => {
    const weights = rm3Weights({
      queryTerms: [],
      feedback: [doc(['a'], 0), doc(['b'], 0)],
      params: params({ fbTerms: 2, alpha: 1 }),
    });
    near(weights.get('a'), 0.5);
    near(weights.get('b'), 0.5);
  });

  it('at alpha 0 ignores the feedback entirely', () => {
    const weights = rm3Weights({
      queryTerms: ['a'],
      feedback: [doc(['b'], 1)],
      params: params({ alpha: 0 }),
    });
    near(weights.get('a'), 1);
    expect(weights.get('b')).toBe(0);
  });
});
