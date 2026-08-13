/**
 * Token budgeting.
 *
 * The estimator is an UPPER BOUND on the real tokenizer count, so these tests
 * pin BYTES — not characters and not a chars/4 average. A char-based estimate
 * under-counts multi-byte text by up to ~4x, which is how oversize documents
 * reached the reranker at all.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens, fitToTokenBudget } from '../src/budget.js';
import type { RetrievedAtom } from '../src/port.js';

const atom = (id: string, body: string): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body,
  score: 1,
  sourcePath: `vault/${id}.md`,
});

describe('estimateTokens', () => {
  it('should count UTF-8 bytes rather than characters for multi-byte text', () => {
    const cjk = '日本語';

    expect(cjk.length).toBe(3);
    expect(estimateTokens(cjk)).toBe(9);
  });

  it('should estimate an emoji string above its character length', () => {
    const emoji = '🙂🙂';

    expect(estimateTokens(emoji)).toBeGreaterThan(emoji.length);
    expect(estimateTokens(emoji)).toBe(8);
  });

  it('should count one token per byte for plain ASCII', () => {
    expect(estimateTokens('hello')).toBe(5);
  });

  it('should return zero for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('fitToTokenBudget', () => {
  const atoms: readonly RetrievedAtom[] = [atom('a', 'x'.repeat(10)), atom('b', 'y'.repeat(10)), atom('c', 'z'.repeat(10))];

  it('should keep rank order and stop at the first atom that would exceed the budget', () => {
    const kept = fitToTokenBudget(atoms, 25);

    expect(kept.map(a => a.id)).toEqual(['a', 'b']);
  });

  it('should stop at the first non-fitting atom rather than skipping ahead to a smaller one', () => {
    const mixed: readonly RetrievedAtom[] = [atom('big', 'x'.repeat(30)), atom('small', 'y')];

    expect(fitToTokenBudget(mixed, 20)).toEqual([]);
  });

  it('should keep every atom when the budget covers all of them', () => {
    expect(fitToTokenBudget(atoms, 30).map(a => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('should return empty for a zero budget', () => {
    expect(fitToTokenBudget(atoms, 0)).toEqual([]);
  });

  it('should return empty for an empty input', () => {
    expect(fitToTokenBudget([], 1000)).toEqual([]);
  });

  it('should budget multi-byte bodies by bytes, not characters', () => {
    const cjkAtoms: readonly RetrievedAtom[] = [atom('a', '日'.repeat(4)), atom('b', '本')];

    expect(fitToTokenBudget(cjkAtoms, 12).map(a => a.id)).toEqual(['a']);
    expect(fitToTokenBudget(cjkAtoms, 15).map(a => a.id)).toEqual(['a', 'b']);
  });
});
