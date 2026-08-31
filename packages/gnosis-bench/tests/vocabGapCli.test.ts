/**
 * `gnosis:vocabgap` — the offline aggregate of C11a.
 *
 * What is pinned: ONE JSONL record per topic, carrying the per-term posting
 * table and the gap it implies. The per-topic shape is what makes a partial run
 * readable and what joins the report back to a qrels file by `topicId`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFts5Index } from '../../gnosis/src/adapters/fts5Adapter.js';
import {
  main,
  readTopics,
  VOCAB_GAP_EXIT_OK,
  VOCAB_GAP_EXIT_REFUSED,
  VOCAB_GAP_EXIT_USAGE,
  VOCAB_GAP_NO_TOPICS_CAUSE,
  type VocabGapRecord,
  vocabGapReport
} from '../src/vocabGapCli.js';

let root = '';
let atomsDir = '';
let indexPath = '';
let queriesPath = '';
let outPath = '';

const ATOMS: readonly { readonly id: string; readonly body: string }[] = [
  { id: 'atom-a', body: 'zustand selector stability rules for a store' },
  { id: 'atom-b', body: 'a policy against abuse of the locator escape hatch' },
];

const atomText = (id: string, body: string): string =>
  [
    '---',
    'type: knowledge',
    `id: ${id}`,
    `title: title of ${id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - docs/src.md',
    '---',
    body,
    '',
  ].join('\n');

const TOPICS: readonly { readonly _id: string; readonly text: string }[] = [
  { _id: 'q1', text: 'zustand selector' },
  { _id: 'q2', text: 'borogove mimsy' },
  { _id: 'q3', text: 'abuse of a locator' },
];

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-vocabgapcli-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  queriesPath = resolve(root, 'queries.jsonl');
  outPath = resolve(root, 'report.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  ATOMS.forEach(atom =>
    writeFileSync(resolve(atomsDir, `${atom.id}.md`), atomText(atom.id, atom.body), 'utf8')
  );
  buildFts5Index({ atomsDir, indexPath });
  writeFileSync(queriesPath, TOPICS.map(topic => JSON.stringify(topic)).join('\n') + '\n', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readTopics', () => {
  /**
   * An all-blank queries file yields `topics = []`, `serialize([])` writes a bare
   * newline and the tool exits 0 — a report of nothing, recorded as data.
   */
  it('refuses a queries file that names no topic at all, with a named cause', () => {
    writeFileSync(queriesPath, '\n   \n\n', 'utf8');
    const act = (): unknown => readTopics(queriesPath);
    expect(act).toThrow(expect.objectContaining({ cause: VOCAB_GAP_NO_TOPICS_CAUSE }));
  });
});

describe('vocabGapReport', () => {
  it('emits one record per topic, in the order the queries file states them', () => {
    const records = vocabGapReport(indexPath, readTopics(queriesPath));
    expect(records).toHaveLength(TOPICS.length);
    expect(records.map(record => record.topicId)).toEqual(['q1', 'q2', 'q3']);
    expect(records.map(record => record.query)).toEqual(TOPICS.map(topic => topic.text));
  });

  it('carries the per-term posting table, the gap terms and both counts', () => {
    const records = vocabGapReport(indexPath, readTopics(queriesPath));
    expect(records[0]).toEqual({
      topicId: 'q1',
      query: 'zustand selector',
      terms: [
        { term: 'zustand', postings: 1 },
        { term: 'selector', postings: 1 },
      ],
      gapTerms: [],
      gapCount: 0,
      termCount: 2,
    });
    expect(records[1]?.gapTerms).toEqual(['borogov', 'mimsi']);
    expect(records[1]?.gapCount).toBe(2);
  });

  it('does not re-analyse: the non-idempotent stem reads as PRESENT', () => {
    const records = vocabGapReport(indexPath, readTopics(queriesPath));
    expect(records[2]?.terms).toContainEqual({ term: 'abus', postings: 1 });
    expect(records[2]?.gapTerms).toEqual([]);
  });
});

describe('main', () => {
  it('writes one JSON object per line to --out and exits 0', () => {
    const code = main(['--index', indexPath, '--queries', queriesPath, '--out', outPath]);
    expect(code).toBe(VOCAB_GAP_EXIT_OK);
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(TOPICS.length);
    const parsed = lines.map(line => JSON.parse(line) as VocabGapRecord);
    expect(parsed.map(record => record.topicId)).toEqual(['q1', 'q2', 'q3']);
  });

  /**
   * The argv was usable and both files were readable — what failed is the DATA,
   * so the code has to separate it from a mistyped invocation.
   */
  it('exits refused, not usage, when the queries file names no topic', () => {
    writeFileSync(queriesPath, '\n   \n\n', 'utf8');
    expect(main(['--index', indexPath, '--queries', queriesPath])).toBe(VOCAB_GAP_EXIT_REFUSED);
  });

  it('refuses an invocation missing either explicit source', () => {
    expect(main(['--index', indexPath])).toBe(VOCAB_GAP_EXIT_USAGE);
    expect(main(['--queries', queriesPath])).toBe(VOCAB_GAP_EXIT_USAGE);
  });
});
