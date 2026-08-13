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
import { RETRIEVE_TOKEN_BUDGET } from '../src/config.js';
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

/**
 * Skip-and-continue, decided 2026-08-13 (§9.7 of the hu-en measurement report):
 * an atom that does not fit is SKIPPED, not a stop sign, and it stays REPORTED
 * with its id, its `sourcePath` and its estimated size — a warning naming
 * neither the file nor the size tells the caller nothing it can act on.
 */
describe('fitToTokenBudget', () => {
  const atoms: readonly RetrievedAtom[] = [atom('a', 'x'.repeat(10)), atom('b', 'y'.repeat(10)), atom('c', 'z'.repeat(10))];

  it('should keep rank order for the atoms that fit', () => {
    const fit = fitToTokenBudget(atoms, 25);

    expect(fit.kept.map(a => a.id)).toEqual(['a', 'b']);
    expect(fit.skipped.map(s => s.id)).toEqual(['c']);
  });

  it('should skip an oversize atom in the middle and still admit the ones behind it', () => {
    const mixed: readonly RetrievedAtom[] = [
      atom('head', 'x'.repeat(5)),
      atom('big', 'y'.repeat(30)),
      atom('tail', 'z'.repeat(5)),
    ];

    const fit = fitToTokenBudget(mixed, 20);

    expect(fit.kept.map(a => a.id)).toEqual(['head', 'tail']);
    expect(fit.skipped).toEqual([{ id: 'big', sourcePath: 'vault/big.md', estimatedTokens: 30 }]);
  });

  it('should keep every atom and skip nothing when the budget covers all of them', () => {
    const fit = fitToTokenBudget(atoms, 30);

    expect(fit.kept.map(a => a.id)).toEqual(['a', 'b', 'c']);
    expect(fit.skipped).toEqual([]);
  });

  it('should keep nothing and report everything for a zero budget', () => {
    const fit = fitToTokenBudget(atoms, 0);

    expect(fit.kept).toEqual([]);
    expect(fit.skipped.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(fit.skipped.map(s => s.sourcePath)).toEqual(['vault/a.md', 'vault/b.md', 'vault/c.md']);
    expect(fit.skipped.every(s => s.estimatedTokens === 10)).toBe(true);
  });

  it('should return empty for an empty input', () => {
    expect(fitToTokenBudget([], 1000)).toEqual({ kept: [], skipped: [] });
  });

  it('should apply the configured default budget when none is passed', () => {
    const fits = atom('fits', 'x'.repeat(RETRIEVE_TOKEN_BUDGET));
    const over = atom('over', 'y'.repeat(RETRIEVE_TOKEN_BUDGET + 1));

    expect(fitToTokenBudget([over, fits]).kept.map(a => a.id)).toEqual(['fits']);
    expect(fitToTokenBudget([over, fits]).skipped.map(s => s.estimatedTokens)).toEqual([
      RETRIEVE_TOKEN_BUDGET + 1,
    ]);
  });

  it('should budget multi-byte bodies by bytes, not characters', () => {
    const cjkAtoms: readonly RetrievedAtom[] = [atom('a', '日'.repeat(4)), atom('b', '本')];

    expect(fitToTokenBudget(cjkAtoms, 12).kept.map(a => a.id)).toEqual(['a']);
    expect(fitToTokenBudget(cjkAtoms, 15).kept.map(a => a.id)).toEqual(['a', 'b']);
  });
});
