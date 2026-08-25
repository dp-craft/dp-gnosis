/**
 * `--body-source` in the bench — the arm that indexes GENERATED text instead of
 * the atom body.
 *
 * It is a TREATMENT, not a scale: two arms differing only in where the `body`
 * column's text came from rank differently over the same corpus, so a row that
 * did not stamp it would compare EQUAL to a body-indexed row and the delta would
 * be read as a code change. And an absent stamp MUST read as the default, since
 * every recorded row was measured on an atom-bodied index.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_BODY_SOURCE } from '../../gnosis/src/config.js';
import { TREATMENT_FIELDS, treatmentChanges } from '../src/compare.js';
import type { HistoryRow } from '../src/report.js';
import { parseArgs } from '../src/run.js';

const row = (overrides: Partial<HistoryRow>): HistoryRow => ({
  ts: '2026-08-25T09:30:00.000Z',
  gitSha: 'aaa1111',
  dataset: 'scifact',
  corpusBytes: 4096,
  corpusLines: 5183,
  adapter: 'fts5',
  atomMaxChars: null,
  depth: 100,
  rerank: false,
  topics: 300,
  docCount: 5183,
  atomCount: 5202,
  ingestMs: 1000,
  queryMs: 300,
  ndcg10: 0.6,
  recall10: 0.5,
  recall20: 0.7,
  recall100: 0.9,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.55,
  ...overrides,
});

describe('--body-source parsing', () => {
  it('defaults to the atom body — the arm every recorded row was measured on', () => {
    expect(parseArgs([]).bodySource).toBe(DEFAULT_BODY_SOURCE);
  });

  it('accepts each member of the closed vocabulary', () => {
    expect(parseArgs(['--body-source', 'long']).bodySource).toBe('long');
    expect(parseArgs(['--body-source', 'long+keywords']).bodySource).toBe('long+keywords');
  });

  it('REFUSES a name outside the vocabulary, listing it', () => {
    expect(() => parseArgs(['--body-source', 'summary'])).toThrow(/--body-source.*long\+keywords/s);
  });

  it('REFUSES the flag on an adapter that builds no such column', () => {
    expect(() => parseArgs(['--adapter', 'linear', '--body-source', 'long'])).toThrow(
      /linear.*--body-source/s
    );
  });
});

describe('the body source is guarded provenance', () => {
  it('is a TREATMENT field', () => {
    expect([...TREATMENT_FIELDS]).toContain('bodySource');
  });

  it('reads an ABSENT stamp as the default, so a legacy row compares equal', () => {
    expect(treatmentChanges(row({}), row({ bodySource: DEFAULT_BODY_SOURCE }))).toEqual([]);
  });

  it('labels a moved source as a change, both values named', () => {
    expect(treatmentChanges(row({}), row({ bodySource: 'long' }))).toEqual([
      { field: 'bodySource', previous: DEFAULT_BODY_SOURCE, latest: 'long' },
    ]);
  });
});
