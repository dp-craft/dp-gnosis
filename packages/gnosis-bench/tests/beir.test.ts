import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { type BeirDoc, readCorpus, readQrels, readQueries, readQueryFacets } from '../src/beir.js';
import { safeDocId } from '../src/docId.js';

const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-beir-'));

writeFileSync(
  resolve(dir, 'corpus.jsonl'),
  [
    JSON.stringify({ _id: 'd1', title: 'Alpha', text: 'first body' }),
    '',
    JSON.stringify({ _id: 'd2', title: 'Beta', text: 'second body', extra: 1 }),
    JSON.stringify({ _id: '', title: 'no id', text: 'dropped' }),
    JSON.stringify({ _id: 'd3', text: 'no title' }),
  ].join('\n'),
  'utf8'
);
writeFileSync(
  resolve(dir, 'queries.jsonl'),
  [
    JSON.stringify({ _id: 'q1', text: 'does alpha work' }),
    JSON.stringify({ _id: 'q2', text: 'what about beta' }),
  ].join('\n'),
  'utf8'
);
mkdirSync(resolve(dir, 'qrels'), { recursive: true });
writeFileSync(
  resolve(dir, 'qrels/test.tsv'),
  ['query-id\tcorpus-id\tscore', 'q1\td1\t1', 'q1\td2\t2', 'q2\td2\t1', ''].join('\n'),
  'utf8'
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readCorpus', () => {
  const docs = readCorpus(dir);

  it('projects _id/title/text and skips blank lines', () => {
    expect(docs.slice(0, 2)).toEqual([
      { id: 'd1', title: 'Alpha', text: 'first body' },
      { id: 'd2', title: 'Beta', text: 'second body' },
    ]);
  });

  it('drops a row without an _id and defaults a missing title to empty', () => {
    expect(docs.map(d => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(docs[2]).toEqual({ id: 'd3', title: '', text: 'no title' });
  });
});

describe('readQueries', () => {
  it('maps query id to text', () => {
    const queries = readQueries(dir);
    expect(queries.get('q1')).toBe('does alpha work');
    expect(queries.size).toBe(2);
  });
});

describe('readQueryFacets', () => {
  const facetDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-beir-facet-'));
  afterAll(() => rmSync(facetDir, { recursive: true, force: true }));

  it('is EMPTY for a BEIR dataset, which authors no facet at all', () => {
    expect(readQueryFacets(dir).size).toBe(0);
  });

  it('reads only the facets a row actually carries', () => {
    writeFileSync(
      resolve(facetDir, 'queries.jsonl'),
      [
        JSON.stringify({ _id: 'q1', text: 'a', axis: 'synonym', domain: 'vault', type: 'lookup' }),
        JSON.stringify({ _id: 'q2', text: 'b', axis: 'exact-keyword' }),
        JSON.stringify({ _id: 'q3', text: 'c' }),
      ].join('\n'),
      'utf8'
    );

    const facets = readQueryFacets(facetDir);

    expect(facets.get('q1')).toEqual({ axis: 'synonym', domain: 'vault', type: 'lookup' });
    expect(facets.get('q2')).toEqual({ axis: 'exact-keyword' });
    expect(facets.has('q3')).toBe(false);
  });
});

/**
 * The jsonl readers stream (`lines.ts`) instead of reading one string. These
 * pin the projection against the file shapes that distinguish a chunked reader
 * from the old `readFileSync(...).split('\n')` one.
 */
describe('readCorpus over awkward file shapes', () => {
  const shapeDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-beir-shape-'));
  afterAll(() => rmSync(shapeDir, { recursive: true, force: true }));

  const corpusOf = (content: string): readonly BeirDoc[] => {
    const dataDir = mkdtempSync(resolve(shapeDir, 'd-'));
    writeFileSync(resolve(dataDir, 'corpus.jsonl'), content, 'utf8');
    return readCorpus(dataDir);
  };

  const rows = [
    JSON.stringify({ _id: 'd1', title: 'Alpha', text: 'first' }),
    JSON.stringify({ _id: 'd2', title: '', text: '' }),
    JSON.stringify({ title: 'no id at all', text: 'dropped' }),
    JSON.stringify({ _id: 'd3', title: 'Gamma', text: 'árvíztűrő tükörfúrógép' }),
  ];
  const expected: readonly BeirDoc[] = [
    { id: 'd1', title: 'Alpha', text: 'first' },
    { id: 'd2', title: '', text: '' },
    { id: 'd3', title: 'Gamma', text: 'árvíztűrő tükörfúrógép' },
  ];

  it('reads a file with a trailing newline', () => {
    expect(corpusOf(`${rows.join('\n')}\n`)).toEqual(expected);
  });

  it('reads a file with no trailing newline', () => {
    expect(corpusOf(rows.join('\n'))).toEqual(expected);
  });

  it('reads a file with blank lines interspersed', () => {
    expect(corpusOf(`\n${rows.join('\n\n')}\n\n`)).toEqual(expected);
  });

  it('tolerates CRLF, as JSON.parse ignores the trailing carriage return', () => {
    expect(corpusOf(`${rows.join('\r\n')}\r\n`)).toEqual(expected);
  });
});

/**
 * `webis-touche2020` ids embed an ISO timestamp, so all 382,545 carry a `:` and
 * `corpus.ts:fileNameFor` rejects every one. Corpus and qrels MUST go through the
 * SAME mapping, or scoring would join nothing at all.
 */
describe('readCorpus / readQrels over unsafe ids', () => {
  const toucheDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-beir-unsafe-'));
  afterAll(() => rmSync(toucheDir, { recursive: true, force: true }));

  const rawA = 'c67482ba-2019-04-18T13:32:05Z-00000-000';
  const rawB = '197beaca-2019-04-18T11:28:59Z-00001-000';
  const safeA = 'c67482ba-2019-04-18T13_32_05Z-00000-000';

  writeFileSync(
    resolve(toucheDir, 'corpus.jsonl'),
    [
      JSON.stringify({ _id: rawA, title: 'Alpha', text: 'first body' }),
      JSON.stringify({ _id: rawB, title: 'Beta', text: 'second body' }),
    ].join('\n'),
    'utf8'
  );
  mkdirSync(resolve(toucheDir, 'qrels'), { recursive: true });
  writeFileSync(
    resolve(toucheDir, 'qrels/test.tsv'),
    ['query-id\tcorpus-id\tscore', `1\t${rawA}\t2`, `1\t${rawB}\t0`, ''].join('\n'),
    'utf8'
  );

  it('maps corpus ids onto the filename-safe set', () => {
    expect(readCorpus(toucheDir).map(d => d.id)).toEqual([safeA, safeDocId(rawB)]);
  });

  it('rewrites the qrels corpus-id through the same function, so the join holds', () => {
    const qrels = readQrels(toucheDir, 'test');
    const corpusIds = new Set(readCorpus(toucheDir).map(d => d.id));
    expect([...(qrels.get('1') ?? new Map()).keys()].every(id => corpusIds.has(id))).toBe(true);
    expect(qrels.get('1')?.get(safeA)).toBe(2);
  });

  it('refuses a corpus whose ids would merge, naming both originals', () => {
    const clashDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-beir-clash-'));
    writeFileSync(
      resolve(clashDir, 'corpus.jsonl'),
      [JSON.stringify({ _id: 'a:b', text: 'x' }), JSON.stringify({ _id: 'a/b', text: 'y' })].join(
        '\n'
      ),
      'utf8'
    );
    expect(() => readCorpus(clashDir)).toThrow(/"a:b".*"a\/b"|"a\/b".*"a:b"/s);
    rmSync(clashDir, { recursive: true, force: true });
  });
});

describe('readQrels', () => {
  const qrels = readQrels(dir, 'test');

  it('skips the header row and groups grades per query', () => {
    expect(qrels.size).toBe(2);
    expect(qrels.get('q1')?.get('d1')).toBe(1);
    expect(qrels.get('q1')?.get('d2')).toBe(2);
    expect(qrels.get('q2')?.get('d2')).toBe(1);
  });

  it('has no entry for the header text', () => {
    expect(qrels.has('query-id')).toBe(false);
  });

  it('reads the split named by the caller', () => {
    writeFileSync(resolve(dir, 'qrels/train.tsv'), 'query-id\tcorpus-id\tscore\nq9\td1\t1\n', 'utf8');
    expect([...readQrels(dir, 'train').keys()]).toEqual(['q9']);
  });
});
