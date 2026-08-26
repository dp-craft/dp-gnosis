/**
 * Track W's producer, tested on FIXTURES rather than the real index: the whole
 * point of splitting term selection and filler removal out of the I/O is that
 * the rules can be pinned without a 3 605-document corpus in the loop.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EnrichmentRecord } from '../../gnosis/src/enrichment.js';
import {
  commonestTerms,
  documentFrequencies,
  documentKeyOf,
  idfQuestions,
  questionTokenCount,
  rarestTerms,
  readSidecar,
  withoutFillerTerms,
  withQuestions
} from '../src/deterministicEnrichment.js';

const VOCAB = [
  { term: 'zebra', doc: 1 },
  { term: 'alpha', doc: 1 },
  { term: 'cancer', doc: 5 },
  { term: 'the', doc: 900 },
  { term: 'of', doc: 900 },
  { term: 'studi', doc: 800 },
];

const FREQUENCY = documentFrequencies(VOCAB);

const RECORD: EnrichmentRecord = {
  docKey: 'dk',
  doc_description: 'a description',
  entities: ['3.25', '95%'],
  id: 'med-10-statin-use-and-breast-cancer-survival',
  key: 'k',
  keywords: ['statin', 'survival'],
  long: 'a long summary',
  model: 'some-model',
  promptVersion: 1,
  questions: ['What is the risk?'],
  short: 'a short summary',
  source: 'med-10-statin-use-and-breast-cancer-survival.md',
  unit: 'atom',
  variant: 'solo',
};

describe('rarestTerms', () => {
  it('picks the RAREST terms first, not the commonest', () => {
    expect(rarestTerms(['the', 'cancer', 'zebra'], FREQUENCY, 2)).toEqual(['zebra', 'cancer']);
  });

  it('breaks a document-frequency tie lexicographically, never by Map order', () => {
    const inserted = rarestTerms(['zebra', 'alpha'], FREQUENCY, 2);
    const reversed = rarestTerms(['alpha', 'zebra'], FREQUENCY, 2);
    expect(inserted).toEqual(['alpha', 'zebra']);
    expect(reversed).toEqual(inserted);
  });

  it('yields ALL distinct terms when the document has fewer than N', () => {
    expect(rarestTerms(['cancer', 'cancer', 'zebra'], FREQUENCY, 86)).toEqual(['zebra', 'cancer']);
  });

  it('drops a term the index does not hold — its posting list is empty', () => {
    expect(rarestTerms(['unseen', 'cancer'], FREQUENCY, 86)).toEqual(['cancer']);
  });
});

describe('idfQuestions', () => {
  it('is a SINGLE element holding one space-joined string, rarest first', () => {
    expect(idfQuestions(['the', 'cancer', 'zebra'], FREQUENCY, 3)).toEqual(['zebra cancer the']);
  });

  it('is empty when the document contributes no indexed term', () => {
    expect(idfQuestions(['unseen'], FREQUENCY, 86)).toEqual([]);
  });
});

describe('commonestTerms', () => {
  it('ranks by HIGHEST document frequency, ties broken lexicographically', () => {
    expect(commonestTerms(VOCAB, 3)).toEqual(['of', 'the', 'studi']);
  });
});

describe('withoutFillerTerms', () => {
  const filler = new Set(['the', 'of', 'studi']);

  it('drops exactly the listed terms and nothing else', () => {
    expect(withoutFillerTerms(['What studies of the risk?'], filler, 'porter-fold'))
      .toEqual(['What risk?']);
  });

  it('keeps each surviving question as its own element', () => {
    expect(withoutFillerTerms(['the cancer', 'of statin'], filler, 'porter-fold'))
      .toEqual(['cancer', 'statin']);
  });

  it('DROPS a question that empties out', () => {
    expect(withoutFillerTerms(['the of studies', 'cancer'], filler, 'porter-fold'))
      .toEqual(['cancer']);
  });
});

describe('withQuestions', () => {
  it('mutates ONE field and passes every other through unchanged', () => {
    const mutated = withQuestions(RECORD, ['replaced']);
    expect(mutated.questions).toEqual(['replaced']);
    expect({ ...mutated, questions: RECORD.questions }).toEqual(RECORD);
  });
});

describe('documentKeyOf', () => {
  it('joins on the LONGEST corpus id the sidecar id starts with', () => {
    const corpus = new Map([['med-10', 'a'], ['med-1000', 'b']]);
    expect(documentKeyOf('med-1000-neurobehavioral-function', corpus)).toBe('med-1000');
    expect(documentKeyOf('med-10-statin-use', corpus)).toBe('med-10');
  });

  it('is undefined when nothing joins', () => {
    expect(documentKeyOf('nfc-7-something', new Map([['med-10', 'a']]))).toBeUndefined();
  });
});

describe('questionTokenCount', () => {
  it('counts whitespace tokens across the whole column', () => {
    expect(questionTokenCount(['one two', 'three'])).toBe(3);
    expect(questionTokenCount([])).toBe(0);
  });
});

describe('readSidecar', () => {
  it('SKIPS and COUNTS a malformed line instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detenrich-'));
    const path = join(dir, 'enrichment.jsonl');
    const good = JSON.stringify(RECORD);
    writeFileSync(path, `${good}\nnot json at all\n{"id":"x"}\n\n`, 'utf8');
    const read = readSidecar(path);
    expect(read.records.map(r => r.id)).toEqual([RECORD.id]);
    expect(read.skipped).toBe(2);
  });
});
