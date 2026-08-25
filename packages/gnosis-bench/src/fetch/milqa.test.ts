import { describe, expect, it } from 'vitest';

import { buildMilqaFiles, MILQA_SPLIT_FILES, slugify } from './milqa.js';

const paragraph = (
  section: string,
  context: string,
  qas: readonly { readonly question: string; readonly is_impossible?: boolean }[]
): unknown => ({ section, context, qas });

/** Train: two articles, one of them with an accented title and two sections. */
const TRAIN: unknown = {
  data: [
    {
      title: 'Abszint',
      paragraphs: [
        paragraph('', 'Az abszint egy ital.', [{ question: 'Mi az abszint?' }]),
        paragraph('Nevének eredete', 'A francia absinthe szó.', [
          { question: 'Honnan   ered\na neve?' },
          { question: 'Ki találta fel?', is_impossible: true },
        ]),
      ],
    },
    {
      title: 'A 14. dalai láma könyvei',
      paragraphs: [paragraph('', 'A listán szereplő művek.', [{ question: 'Ki a láma?' }])],
    },
  ],
};

/** Test overlaps train on `Abszint` — same contexts, one repeated question. */
const TEST: unknown = {
  data: [
    {
      title: 'Abszint',
      paragraphs: [
        paragraph('', 'Az abszint egy ital.', [
          { question: 'Mi az abszint?' },
          { question: 'Milyen ital?' },
        ]),
        paragraph('Története', 'Az eredete ismeretlen.', [{ question: 'Mikor keletkezett?' }]),
      ],
    },
  ],
};

const lines = (body: string): readonly string[] => body.trimEnd().split('\n');

const parsed = (body: string): readonly Record<string, string>[] =>
  lines(body).map(line => JSON.parse(line) as Record<string, string>);

describe('slugify', () => {
  it('strips Hungarian diacritics and collapses runs of separators', () => {
    expect(slugify('A 14. dalai láma könyvei')).toBe('a-14-dalai-lama-konyvei');
    expect(slugify('Abszint')).toBe('abszint');
  });
});

describe('MILQA_SPLIT_FILES', () => {
  it('pins the two dated split files, train before test', () => {
    expect(MILQA_SPLIT_FILES).toEqual([
      'train.MILQA-2023-03-27.squad.s.json',
      'test.MILQA-2023-03-27.squad.s.json',
    ]);
  });
});

describe('buildMilqaFiles', () => {
  const files = buildMilqaFiles([TRAIN, TEST]);
  const docs = parsed(files.corpus);
  const queries = parsed(files.queries);

  it('deduplicates paragraphs across the splits, first occurrence winning', () => {
    expect(docs.map(doc => doc['_id'])).toEqual([
      'abszint-p00',
      'abszint-p01',
      'a-14-dalai-lama-konyvei-p00',
      'abszint-p02',
    ]);
  });

  it('titles a row with its section and heads its text with the article', () => {
    expect(docs[1]).toEqual({
      _id: 'abszint-p01',
      title: 'Nevének eredete',
      text: '# Abszint > Nevének eredete\n\nA francia absinthe szó.',
    });
    expect(docs[0]).toEqual({
      _id: 'abszint-p00',
      title: 'Abszint',
      text: '# Abszint\n\nAz abszint egy ital.',
    });
  });

  it('drops is_impossible questions and collapses question whitespace', () => {
    const texts = queries.map(query => query['text']);
    expect(texts).not.toContain('Ki találta fel?');
    expect(texts).toContain('Honnan ered a neve?');
  });

  it('numbers queries from mq-00001 and stamps the reporting axis', () => {
    expect(queries[0]).toEqual({
      _id: 'mq-00001',
      text: 'Mi az abszint?',
      axis: 'hungarian-wiki-qa',
    });
    expect(queries.map(query => query['_id'])).toEqual([
      'mq-00001',
      'mq-00002',
      'mq-00003',
      'mq-00004',
      'mq-00005',
    ]);
  });

  it('drops a repeated (question, document) pair the split overlap creates', () => {
    expect(queries.filter(query => query['text'] === 'Mi az abszint?')).toHaveLength(1);
  });

  it('emits one grade-1 qrels row per query, aligned to its paragraph', () => {
    expect(lines(files.qrels)).toEqual([
      'query-id\tcorpus-id\tscore',
      'mq-00001\tabszint-p00\t1',
      'mq-00002\tabszint-p01\t1',
      'mq-00003\ta-14-dalai-lama-konyvei-p00\t1',
      'mq-00004\tabszint-p00\t1',
      'mq-00005\tabszint-p02\t1',
    ]);
  });
});
