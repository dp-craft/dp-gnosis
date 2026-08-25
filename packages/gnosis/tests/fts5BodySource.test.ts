/**
 * `--body-source` — the fts5 `body` column built from GENERATED text instead of
 * the atom body ("search only by long summary").
 *
 * Two properties are under test, and the second is the one this project polices:
 *
 * 1. The DEFAULT is today's build, unchanged — same rows, same stamps, same
 *    ranking. Every recorded fts5 number was measured there.
 * 2. A generated-body build over atoms with NO sidecar record produces an index
 *    whose `body` column is EMPTY for those atoms — a silent all-empty index.
 *    It is COUNTED into the index's own stamp, so the count describes what was
 *    BUILT rather than what was offered.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  buildFts5Index,
  createFts5Adapter,
  readEmptyBodyAtoms
} from '../src/adapters/fts5Adapter.js';
import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentRecord,
  serializeEnrichmentRecord
} from '../src/enrichment.js';
import type { KnowledgePort } from '../src/port.js';
import { analyzeToText } from '../src/query.js';

const NOW = new Date('2026-08-25T00:00:00.000Z');
const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
}

/**
 * The probe terms are DISJOINT across the three texts: `zustand` lives only in
 * an atom body, `hydration` only in a `long` summary, `middleware` only in the
 * keywords. So each query names exactly which text the `body` column holds.
 */
const FIXTURE: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-a', body: 'zustand selector stability in the store' },
  { file: 'b.md', id: 'atom-b', body: 'zustand immutable spread updates' },
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
  long: `hydration of the persisted store described for ${spec.id}`,
  doc_description: 'a document about client state management',
  keywords: ['middleware', 'persist'],
  entities: ['useShallow'],
  questions: ['what is a slice?'],
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
});

/** Only the atoms named get a record — the rest have NO generated body at all. */
const writeSidecar = (specs: readonly AtomSpec[]): void =>
  writeFileSync(
    sidecarPath,
    specs.map(enrichmentFor).map(serializeEnrichmentRecord).join(''),
    'utf8'
  );

const port = (): KnowledgePort => createFts5Adapter({ atomsDir, indexPath, now: NOW });

const hits = async (query: string): Promise<readonly string[]> => {
  const instance = port();
  const result = await instance.retrieve(query, { k: 10 });
  instance.close?.();
  return result.atoms.map(atom => atom.id);
};

/**
 * Atoms whose `body` COLUMN holds the term. Column-scoped on purpose: a bare
 * `MATCH` hits any column, so a term sitting in `long` at weight 0 would still
 * answer and prove nothing about what `body` was built from.
 */
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
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-fts5-body-source-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the default body source is the atom body, unchanged', () => {
  it('holds the atom body and stamps no body-source rows at all', () => {
    writeSidecar(FIXTURE);

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(bodyHits('zustand')).toEqual(['atom-a', 'atom-b']);
    expect(bodyHits('hydration')).toEqual([]);
    expect(stampKeys()).toEqual(['analyzer', 'enrichment_records', 'schema_version']);
    expect(readEmptyBodyAtoms(indexPath)).toBeUndefined();
  });

  it('builds the same index whether the default is named or left absent', () => {
    writeSidecar(FIXTURE);
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });
    const absent = stampKeys();

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, bodySource: 'atom' });

    expect(stampKeys()).toEqual(absent);
    expect(bodyHits('zustand')).toEqual(['atom-a', 'atom-b']);
  });
});

describe('a generated body REPLACES the atom body', () => {
  it('indexes the long summary alone under "long"', () => {
    writeSidecar(FIXTURE);

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, bodySource: 'long' });

    expect(bodyHits('hydration')).toEqual(['atom-a', 'atom-b']);
    expect(bodyHits('zustand')).toEqual([]);
    expect(bodyHits('middleware')).toEqual([]);
  });

  it('adds the keywords under "long+keywords"', () => {
    writeSidecar(FIXTURE);

    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      bodySource: 'long+keywords',
    });

    expect(bodyHits('hydration')).toEqual(['atom-a', 'atom-b']);
    expect(bodyHits('middleware')).toEqual(['atom-a', 'atom-b']);
    expect(bodyHits('zustand')).toEqual([]);
  });
});

describe('an atom with no sidecar record has an EMPTY generated body', () => {
  it('counts it into the index stamp rather than reporting a plausible build', () => {
    writeSidecar([FIXTURE[0] as AtomSpec]);

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath, bodySource: 'long' });

    expect(readEmptyBodyAtoms(indexPath)).toBe(1);
  });

  it('counts EVERY atom when no sidecar was named at all', async () => {
    buildFts5Index({ atomsDir, indexPath, bodySource: 'long' });

    expect(readEmptyBodyAtoms(indexPath)).toBe(FIXTURE.length);
    expect(await hits('zustand')).toEqual([]);
  });
});
