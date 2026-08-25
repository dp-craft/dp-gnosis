/**
 * The two PURE deciders behind the § 11.2 (c) gates. Both are tested against
 * stem arrays and strings directly rather than through a sidecar: the join to
 * the corpus is I/O, while the verdict these two return is what turns a pilot
 * into a PASS or a FAIL, and it must be exercised without a fixture vault.
 */
import { describe, expect, it } from 'vitest';

import {
  isDocumentLevelGenerality,
  maxStemRun,
  PARAPHRASE_RUN_STEMS,
  scaledLimit
} from '../src/enrichmentGate.js';

const stems = (text: string): readonly string[] => text.split(' ');

describe('maxStemRun', () => {
  it('counts only CONSECUTIVE shared stems, not scattered ones', () => {
    expect(maxStemRun(stems('a x b y c'), stems('a b c'))).toBe(1);
  });

  it('returns the longest run when several runs overlap', () => {
    expect(maxStemRun(stems('q a b c z'), stems('n a b c d'))).toBe(3);
  });

  it('is 0 when nothing is shared, and 0 on an empty side', () => {
    expect(maxStemRun(stems('a b'), stems('c d'))).toBe(0);
    expect(maxStemRun([], stems('a b'))).toBe(0);
    expect(maxStemRun(stems('a b'), [])).toBe(0);
  });

  it('finds a run that starts at index 0 of the second text', () => {
    expect(maxStemRun(stems('z a b'), stems('a b z'))).toBe(2);
  });

  it('crosses the near-verbatim threshold exactly at the run length the gate uses', () => {
    const shared = 'one two three four five six seven eight';
    expect(maxStemRun(stems(shared), stems(`x ${shared} y`))).toBe(PARAPHRASE_RUN_STEMS);
  });
});

describe('isDocumentLevelGenerality', () => {
  it('fires on a summary that talks about the document instead of its subject', () => {
    expect(isDocumentLevelGenerality('This document explains tariff policy.')).toBe(true);
    expect(isDocumentLevelGenerality('The passage argues for open borders.')).toBe(true);
    expect(isDocumentLevelGenerality('this FRAGMENT covers vaccination law')).toBe(true);
  });

  it('does not fire on a summary about the subject matter', () => {
    expect(isDocumentLevelGenerality('Tariffs raise consumer prices in import markets.')).toBe(
      false
    );
  });

  it('does not fire when the noun is not preceded by this/the', () => {
    expect(isDocumentLevelGenerality('Document retention rules differ by state.')).toBe(false);
  });
});

describe('scaledLimit', () => {
  it('is the plan threshold at the pilot size of 100', () => {
    expect(scaledLimit(100)).toBe(12);
  });

  it('scales proportionally to a partial pilot', () => {
    expect(scaledLimit(50)).toBe(6);
  });
});
