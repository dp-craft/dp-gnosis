/**
 * `--keyword-filter novel` — the fts5 build dropping keywords that merely
 * RE-EMIT body vocabulary.
 *
 * Three properties are under test:
 *
 * 1. The DEFAULT is today's build, BYTE FOR BYTE — the file produced with the
 *    flag absent and the file produced with `none` named are compared as bytes,
 *    not as stamp keys, because every recorded fts5 number is reproducible only
 *    from an unchanged index.
 * 2. A keyword whose every analysed term is already in the atom body stops
 *    reaching the `keywords` column, while one carrying a new term still does.
 * 3. What was kept and what was dropped is STAMPED into the index, so the echo
 *    rate is read off the build rather than assumed from another corpus.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index, readKeywordCensus } from '../src/adapters/fts5Adapter.js';
import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentRecord,
  serializeEnrichmentRecord
} from '../src/enrichment.js';
import { analyzeToText } from '../src/query.js';

const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
  readonly keywords: readonly string[];
}

/**
 * `selector` and `stores` are pure BODY ECHO — `stores` only after stemming, so
 * the comparison has to run through the analyzer rather than over raw strings.
 * `middleware` is novel. `selector stability` is a MULTI-TERM keyword whose every
 * term echoes, and `persisted selector` carries one novel term, so the
 * "every term already present" rule is exercised in both directions.
 */
const FIXTURE: readonly AtomSpec[] = [
  {
    file: 'a.md',
    id: 'atom-a',
    body: 'zustand selector stability across many stores',
    keywords: ['selector', 'stores', 'middleware', 'selector stability', 'persisted selector'],
  },
  {
    file: 'b.md',
    id: 'atom-b',
    body: 'immutable spread updates for a plain record',
    keywords: ['spread', 'hydration'],
  },
];

let root = '';
let atomsDir = '';
let indexPath = '';
let sidecarPath = '';

const atomText = (spec: AtomSpec): string =>
  [
    '---',
    'type: knowledge',
    `id: ${spec.id}`,
    `title: title of ${spec.id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - https://example.com/src',
    '---',
    spec.body,
    '',
  ].join('\n');

const enrichmentFor = (spec: AtomSpec): EnrichmentRecord => ({
  key: atomKeyOf(spec.body),
  docKey: docKeyOf(`docs/${spec.file}`),
  variant: 'solo',
  unit: 'atom',
  id: spec.id,
  source: spec.file,
  short: `short note for ${spec.id}`,
  long: `a longer paragraph describing ${spec.id} at some length`,
  doc_description: 'a document about client state management',
  keywords: [...spec.keywords],
  entities: ['useShallow'],
  questions: ['what is a slice?'],
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
});

const writeSidecar = (): void =>
  writeFileSync(
    sidecarPath,
    FIXTURE.map(enrichmentFor).map(serializeEnrichmentRecord).join(''),
    'utf8'
  );

/** Atoms whose `keywords` COLUMN holds the term — column-scoped, never a bare MATCH. */
const keywordHits = (term: string): readonly string[] => {
  const db = new Database(indexPath, { readonly: true });
  const rows = db
    .prepare(
      'SELECT m.id AS id FROM atom_fts JOIN atom_meta m ON m.rowid = atom_fts.rowid ' +
        'WHERE atom_fts MATCH ? ORDER BY m.rowid'
    )
    .all(`keywords : ${analyzeToText(term, 'porter-fold')}`) as readonly { readonly id: string }[];
  db.close();
  return rows.map(row => row.id);
};

const bodyHits = (term: string): readonly string[] => {
  const db = new Database(indexPath, { readonly: true });
  const rows = db
    .prepare(
      'SELECT m.id AS id FROM atom_fts JOIN atom_meta m ON m.rowid = atom_fts.rowid ' +
        'WHERE atom_fts MATCH ? ORDER BY m.rowid'
    )
    .all(`body : ${analyzeToText(term, 'porter-fold')}`) as readonly { readonly id: string }[];
  db.close();
  return rows.map(row => row.id);
};

const stampKeys = (): readonly string[] => {
  const db = new Database(indexPath, { readonly: true });
  const rows = db.prepare('SELECT key AS key FROM index_meta').all() as readonly {
    readonly key: string;
  }[];
  db.close();
  return rows.map(row => row.key).sort();
};

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-fts5-keyword-filter-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
  writeSidecar();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the default keyword filter leaves the build byte-identical', () => {
  it('produces the SAME BYTES whether the default is named or left absent', () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });
    const absent = readFileSync(indexPath);

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, keywordFilter: 'none' });

    expect(readFileSync(indexPath).equals(absent)).toBe(true);
  });

  it('stamps no keyword-filter rows at all, and keeps every echoed keyword', () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(stampKeys()).toEqual(['analyzer', 'enrichment_records', 'schema_version']);
    expect(readKeywordCensus(indexPath)).toBeUndefined();
    expect(keywordHits('selector')).toEqual(['atom-a']);
  });
});

describe('the novel filter drops keywords whose EVERY term echoes the body', () => {
  it('keeps a keyword with a new term and drops one entirely present in the body', () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, keywordFilter: 'novel' });

    expect(keywordHits('middleware')).toEqual(['atom-a']);
    expect(keywordHits('hydration')).toEqual(['atom-b']);
    expect(keywordHits('selector')).toEqual(['atom-a']);
    expect(keywordHits('stores')).toEqual([]);
    expect(keywordHits('spread')).toEqual([]);
  });

  it('leaves the body column untouched — the filter reads it, never rewrites it', () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, keywordFilter: 'novel' });

    expect(bodyHits('zustand')).toEqual(['atom-a']);
    expect(bodyHits('stores')).toEqual(['atom-a']);
  });
});

describe('the build STAMPS what it kept and what it dropped', () => {
  it('reads the census back off the index rather than recounting the sidecar', () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, keywordFilter: 'novel' });

    expect(stampKeys()).toEqual([
      'analyzer',
      'enrichment_records',
      'keyword_filter',
      'keywords_dropped',
      'keywords_kept',
      'schema_version',
    ]);
    // `middleware` + `persisted selector` on atom-a, `hydration` on atom-b.
    expect(readKeywordCensus(indexPath)).toEqual({ kept: 3, dropped: 4 });
  });
});
