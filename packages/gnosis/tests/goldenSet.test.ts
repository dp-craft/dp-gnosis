import { describe, expect, it } from 'vitest';

import {
  GOLDEN_AXES,
  type GoldenSet,
  loadGoldenSet,
  loadVerifiedGoldenSet,
  parseGoldenSet,
  readCorpusAtomIds,
  validateGoldenSetAgainstCorpus
} from '../src/goldenSet.js';

const shipped: GoldenSet = loadGoldenSet();
const corpusIds = readCorpusAtomIds();

const validDocument = {
  version: 1,
  frozenAt: '2026-08-08',
  corpusAtomCount: 702,
  minimumMeaningfulDifference: { queries: 1, recallResolution: 1, statement: 'one query' },
  queries: [
    {
      id: 'q-001',
      axis: 'exact-keyword',
      query: 'backslides',
      domain: null,
      relevantAtomIds: ['runner-telemetry'],
      rationale: 'appears verbatim',
    },
  ],
};

const documentWith = (patch: Record<string, unknown>): string =>
  JSON.stringify({ ...validDocument, ...patch });

describe('shipped golden set', () => {
  it('should load and structurally validate', () => {
    expect(shipped.version).toBe(1);
    expect(shipped.queries.length).toBeGreaterThan(0);
  });

  it('should resolve every relevantAtomIds entry to an atom on disk', () => {
    const missing = shipped.queries.flatMap(query =>
      query.relevantAtomIds.filter(id => !corpusIds.has(id)).map(id => `${query.id} → ${id}`)
    );
    expect(missing).toEqual([]);
  });

  it('should pass the combined verified loader', () => {
    expect(() => loadVerifiedGoldenSet()).not.toThrow();
  });

  it('should represent every declared axis', () => {
    const used = new Set(shipped.queries.map(query => query.axis));
    expect([...GOLDEN_AXES].filter(axis => !used.has(axis))).toEqual([]);
  });

  it('should carry an internally consistent minimum meaningful difference', () => {
    const mmd = shipped.minimumMeaningfulDifference;
    expect(mmd.queries).toBe(shipped.queries.length);
    expect(mmd.recallResolution).toBeCloseTo(1 / shipped.queries.length, 12);
    expect(mmd.statement.length).toBeGreaterThan(0);
  });

  it('should set domain only on domain-filtered queries', () => {
    const mismatched = shipped.queries.filter(
      query => (query.domain === null) !== (query.axis !== 'domain-filtered')
    );
    expect(mismatched.map(query => query.id)).toEqual([]);
  });

  it('should load the shipped v1 artefact, which declares no type, with type null', () => {
    expect(shipped.queries.every(query => query.type === null)).toBe(true);
  });

  it('should keep every domain-filtered judgement inside its own declared domain', () => {
    const filtered = shipped.queries.filter(query => query.domain !== null);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every(query => query.relevantAtomIds.length > 0)).toBe(true);
  });
});

describe('parseGoldenSet', () => {
  it('should reject an axis outside the closed vocabulary', () => {
    const bad = documentWith({
      queries: [{ ...validDocument.queries[0], axis: 'fuzzy-match' }],
    });
    expect(() => parseGoldenSet(bad)).toThrow(/field "axis" MUST be one of/);
  });

  it('should reject a query whose domain field is absent rather than null', () => {
    const { domain: _omitted, ...withoutDomain } = validDocument.queries[0]!;
    expect(() => parseGoldenSet(documentWith({ queries: [withoutDomain] }))).toThrow(
      /field "domain" MUST be a string or null/
    );
  });

  it('should read an absent type field as null, so a pre-type artefact still loads', () => {
    const set = parseGoldenSet(documentWith({}));
    expect(set.queries[0]?.type).toBeNull();
  });

  it('should keep a declared type string', () => {
    const set = parseGoldenSet(
      documentWith({ queries: [{ ...validDocument.queries[0], type: 'adr' }] })
    );
    expect(set.queries[0]?.type).toBe('adr');
  });

  it('should reject a type field that is neither a string nor null', () => {
    const bad = documentWith({ queries: [{ ...validDocument.queries[0], type: 7 }] });
    expect(() => parseGoldenSet(bad)).toThrow(/field "type" MUST be a string or null/);
  });

  it('should reject an empty relevantAtomIds list', () => {
    const bad = documentWith({ queries: [{ ...validDocument.queries[0], relevantAtomIds: [] }] });
    expect(() => parseGoldenSet(bad)).toThrow(/relevantAtomIds/);
  });

  it('should reject a recallResolution that is not 1 over the query count', () => {
    const bad = documentWith({
      minimumMeaningfulDifference: { queries: 1, recallResolution: 0.5, statement: 'wrong' },
    });
    expect(() => parseGoldenSet(bad)).toThrow(/minimumMeaningfulDifference MUST state/);
  });

  it('should reject a declared query count that disagrees with the list length', () => {
    const bad = documentWith({
      minimumMeaningfulDifference: { queries: 50, recallResolution: 0.02, statement: 'stale' },
    });
    expect(() => parseGoldenSet(bad)).toThrow(/minimumMeaningfulDifference MUST state/);
  });

  it('should reject duplicate query ids', () => {
    const bad = JSON.stringify({
      ...validDocument,
      minimumMeaningfulDifference: { queries: 2, recallResolution: 0.5, statement: 'two' },
      queries: [validDocument.queries[0], validDocument.queries[0]],
    });
    expect(() => parseGoldenSet(bad)).toThrow(/query ids MUST be unique/);
  });
});

describe('validateGoldenSetAgainstCorpus', () => {
  it('should fail loudly and name a relevantAtomIds entry the corpus does not declare', () => {
    const set = parseGoldenSet(
      documentWith({
        queries: [{ ...validDocument.queries[0], relevantAtomIds: ['no-such-atom-id'] }],
      })
    );
    expect(() => validateGoldenSetAgainstCorpus(set, corpusIds)).toThrow(/no-such-atom-id/);
  });

  it('should accept the shipped set against the real corpus', () => {
    expect(() => validateGoldenSetAgainstCorpus(shipped, corpusIds)).not.toThrow();
  });
});
