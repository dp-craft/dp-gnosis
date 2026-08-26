import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  buildFts5Index,
  createFts5Adapter,
  INDEX_SCHEMA_VERSION
} from '../src/adapters/fts5Adapter.js';
import {
  DEFAULT_FIELD_WEIGHTS,
  ENRICHMENT_COLUMNS,
  type EnrichmentColumnSpec,
  type FieldWeights,
  parseEnrichmentColumns
} from '../src/config.js';
import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentRecord,
  serializeEnrichmentRecord
} from '../src/enrichment.js';
import type { KnowledgePort, RetrievedAtom } from '../src/port.js';
import { analyzeToText } from '../src/query.js';

/** Parse-or-throw: a fixture naming an unknown column is a broken test, not an arm. */
const parseColumns = (raw: string): EnrichmentColumnSpec => {
  const parsed = parseEnrichmentColumns(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.spec;
};

const NOW = new Date('2026-08-22T00:00:00.000Z');
const MODEL = 'qwen35b-a3b-q5km-ctx130k-mtp-frog-coding';

interface AtomSpec {
  readonly file: string;
  readonly id: string;
  readonly body: string;
}

/**
 * Bodies chosen so the UNENRICHED ranking is decided by term frequency alone,
 * and so one atom does NOT carry the probe term at all — that atom is what makes
 * a weighted enrichment column observable.
 */
const FIXTURE: readonly AtomSpec[] = [
  { file: 'a.md', id: 'atom-a', body: 'zustand selector selector stability in the store' },
  { file: 'b.md', id: 'atom-b', body: 'immutable spread updates for a plain record' },
  { file: 'c.md', id: 'atom-c', body: 'a selector reads one slice of the store' },
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

const writeFixture = (): void =>
  FIXTURE.forEach(spec => writeFileSync(resolve(atomsDir, spec.file), atomText(spec), 'utf8'));

const enrichmentFor = (spec: AtomSpec, questions: readonly string[]): EnrichmentRecord => ({
  key: atomKeyOf(spec.body),
  docKey: docKeyOf(`docs/${spec.file}`),
  variant: 'solo',
  unit: 'atom',
  id: spec.id,
  source: spec.file,
  short: `short note for ${spec.id}`,
  long: `a longer paragraph describing ${spec.id} at some length`,
  doc_description: 'a document about client state management',
  keywords: ['state', 'store'],
  entities: ['useShallow'],
  questions,
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: MODEL,
});

/** `atom-b` is the ONLY atom whose enrichment carries the probe term. */
const writeSidecar = (): void => {
  const records = [
    enrichmentFor(FIXTURE[0] as AtomSpec, ['how is state read?']),
    enrichmentFor(FIXTURE[1] as AtomSpec, [
      'what makes a selector stable?',
      'when does a selector re-run?',
      'which selector returns a new object?',
    ]),
    enrichmentFor(FIXTURE[2] as AtomSpec, ['what is a slice?']),
  ];
  writeFileSync(sidecarPath, records.map(serializeEnrichmentRecord).join(''), 'utf8');
};

const port = (fieldWeights?: FieldWeights): KnowledgePort =>
  createFts5Adapter({ atomsDir, indexPath, now: NOW, ...(fieldWeights && { fieldWeights }) });

interface Scored {
  readonly id: string;
  readonly score: number;
}

const scored = async (fieldWeights?: FieldWeights): Promise<readonly Scored[]> => {
  const instance = port(fieldWeights);
  const result = await instance.retrieve('selector', { k: 10 });
  instance.close?.();
  return result.atoms.map((atom: RetrievedAtom) => ({ id: atom.id, score: atom.score }));
};

/**
 * The PRE-CHANGE writer, reproduced: ONE `body` column, no enrichment columns,
 * no `index_meta`. It reads back as `porter-fold` and passes the version gate on
 * absence, so it is a usable reference for what the ranking WAS.
 */
const buildOneColumnIndex = (): void => {
  rmSync(indexPath, { force: true });
  mkdirSync(dirname(indexPath), { recursive: true });
  const db = new Database(indexPath);
  db.exec('CREATE TABLE atom_meta(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL)');
  db.exec('CREATE VIRTUAL TABLE atom_fts USING fts5(body, content=\'\', detail=full)');
  const meta = db.prepare('INSERT INTO atom_meta(rowid, id, path) VALUES (?, ?, ?)');
  const fts = db.prepare('INSERT INTO atom_fts(rowid, body) VALUES (?, ?)');
  db.transaction(() =>
    [...FIXTURE]
      .sort((left, right) => (left.file < right.file ? -1 : 1))
      .forEach((spec, index) => {
        meta.run(index + 1, spec.id, spec.file);
        fts.run(index + 1, analyzeToText(spec.body, 'porter-fold'));
      })
  )();
  db.close();
};

const metaValue = (key: string): string | undefined => {
  const db = new Database(indexPath, { readonly: true });
  const row = db.prepare('SELECT value AS value FROM index_meta WHERE key = ?').get(key) as
    | { readonly value: string }
    | undefined;
  db.close();
  return row?.value;
};

const setMeta = (key: string, value: string): void => {
  const db = new Database(indexPath);
  db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run(value, key);
  db.close();
};

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'gnosis-fts5-enrich-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  sidecarPath = resolve(root, 'enrichment.jsonl');
  mkdirSync(atomsDir, { recursive: true });
  writeFixture();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * THE REGRESSION CONTRACT of the seven-column schema.
 *
 * fts5's `bm25()` normalises by the row's TOTAL token count across ALL columns,
 * so a weight of 0 does NOT on its own make an enriched index score like an
 * unenriched one — a populated column lengthens the row and moves every score.
 * What DOES hold is the case that ships by default: with no sidecar every
 * enrichment column is empty, an empty column contributes no tokens, and the
 * seven-column index must therefore score IDENTICALLY to the one-column index
 * every recorded fts5 number was measured on.
 */
describe('fts5 seven-column schema — no sidecar reproduces the one-column ranking', () => {
  it('returns the same ids AND the same scores as the pre-change one-column writer', async () => {
    buildFts5Index({ atomsDir, indexPath });
    const sevenColumn = await scored();

    buildOneColumnIndex();
    const oneColumn = await scored();

    expect(sevenColumn).toEqual(oneColumn);
    expect(sevenColumn.map(row => row.id)).toEqual(['atom-a', 'atom-c']);
    expect(sevenColumn.every(row => row.score > 0)).toBe(true);
  });

  it('is reproducible: two builds over the same corpus score identically', async () => {
    buildFts5Index({ atomsDir, indexPath });
    const first = await scored();
    buildFts5Index({ atomsDir, indexPath });

    expect(await scored()).toEqual(first);
  });

  it('leaves enrichment columns empty when the named sidecar file does not exist', async () => {
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: resolve(root, 'absent.jsonl') });
    const withAbsent = await scored();

    buildOneColumnIndex();

    expect(withAbsent).toEqual(await scored());
  });

  /**
   * The mechanism named above, asserted rather than assumed: a POPULATED
   * enrichment column moves the scores even at weight 0. This is what makes the
   * empty-column case above a real guarantee instead of a coincidence.
   */
  it('DOES move the scores once a sidecar populates those columns, even at weight 0', async () => {
    buildFts5Index({ atomsDir, indexPath });
    const bare = await scored();

    writeSidecar();
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });
    const enriched = await scored();

    expect(enriched).not.toEqual(bare);
    expect(enriched.filter(row => row.score > 0).map(row => row.id)).toEqual(['atom-a', 'atom-c']);
  });
});

describe('fts5 field weights', () => {
  it('re-ranks by a weighted enrichment column: the questions atom overtakes the body atom', async () => {
    writeSidecar();
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    const byBody = (await scored()).map(row => row.id);
    const byQuestions = (
      await scored({ ...DEFAULT_FIELD_WEIGHTS, questions: 20 })
    ).map(row => row.id);

    expect(byBody[0]).toBe('atom-a');
    expect(byQuestions[0]).toBe('atom-b');
  });

  it('keeps the default weights body-only, so an unweighted call is today\'s ranking', async () => {
    writeSidecar();
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(await scored(DEFAULT_FIELD_WEIGHTS)).toEqual(await scored());
  });

  it('REFUSES a non-finite weight instead of formatting NaN into the statement', async () => {
    buildFts5Index({ atomsDir, indexPath });

    const attempt = async (): Promise<unknown> =>
      await port({ ...DEFAULT_FIELD_WEIGHTS, keywords: Number.NaN }).retrieve('selector', {
        k: 5,
      });

    await expect(attempt()).rejects.toThrow(/field weight for "keywords" is NaN/);
  });
});

describe('fts5 enrichment stamp', () => {
  it('stamps enrichment_records as "0" when no sidecar was passed', () => {
    buildFts5Index({ atomsDir, indexPath });

    expect(metaValue('enrichment_records')).toBe('0');
  });

  it('stamps the number of sidecar records actually merged', () => {
    writeSidecar();

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(metaValue('enrichment_records')).toBe(String(FIXTURE.length));
  });

  it('counts only records that JOINED an indexed atom', () => {
    writeFileSync(
      sidecarPath,
      serializeEnrichmentRecord(
        enrichmentFor({ file: 'z.md', id: 'atom-never-indexed', body: 'x' }, ['?'])
      ),
      'utf8'
    );

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(metaValue('enrichment_records')).toBe('0');
  });
});

/**
 * The § 13 gate: the seven-column schema is a NEW index shape, so a file stamped
 * with the one-column version must be REFUSED, not read. Reading it would search
 * an index whose column layout this build's `bm25()` weight vector does not
 * describe — a full ranking under exit 0 over a scorer that means something else.
 */
describe('fts5 schema version gate', () => {
  it('stamps the seven-column schema as version 2', () => {
    buildFts5Index({ atomsDir, indexPath });

    expect(INDEX_SCHEMA_VERSION).toBe('2');
    expect(metaValue('schema_version')).toBe('2');
  });

  it('REFUSES a v1-stamped index and searches nothing', async () => {
    buildFts5Index({ atomsDir, indexPath });
    setMeta('schema_version', '1');

    const result = await port().retrieve('selector', { k: 5 });

    expect(result.atoms).toEqual([]);
    expect(result.indexState).toBe('mismatched');
    expect(result.indexRefusal).toContain('schema_version is "1"');
    expect(result.indexRefusal).toContain('"2"');
  });
});

/**
 * `--enrichment-columns` — WHICH of the six enrichment columns a build populates.
 *
 * The schema is fixed by `FTS_COLUMNS`, so an unselected column is not dropped;
 * it is written EMPTY. That is the only form the selection can take and still be
 * measurable: an empty column contributes no token, so `bm25()`'s length
 * normalisation sees exactly the index an arm that never generated that column
 * would have produced.
 */
const COLUMN_PROBES: readonly (readonly [string, string])[] = [
  ['short', 'note'],
  ['long', 'paragraph'],
  ['doc_desc', 'document'],
  ['keywords', 'state'],
  ['entities', 'useShallow'],
  ['questions', 'stable'],
];

/** How many rows carry `term` IN `column` — the direct read of what was populated. */
const rowsMatching = (column: string, term: string): number => {
  const db = new Database(indexPath, { readonly: true });
  const row = db
    .prepare('SELECT count(*) AS n FROM atom_fts WHERE atom_fts MATCH ?')
    .get(`${column} : ${analyzeToText(term, 'porter-fold')}`) as { readonly n: number };
  db.close();
  return row.n;
};

const populatedColumns = (): readonly string[] =>
  COLUMN_PROBES.filter(([column, term]) => rowsMatching(column, term) > 0).map(([column]) => column);

describe('fts5 --enrichment-columns', () => {
  it('populates every enrichment column by default, and stamps NOTHING', () => {
    writeSidecar();

    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });

    expect(populatedColumns()).toEqual(COLUMN_PROBES.map(([column]) => column));
    expect(metaValue('enrichment_columns')).toBeUndefined();
  });

  it('builds the SAME index when `all` is named explicitly — no stamp, same scores', async () => {
    writeSidecar();
    buildFts5Index({ atomsDir, indexPath, enrichmentPath: sidecarPath });
    const byDefault = await scored();

    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      enrichmentColumns: parseColumns('all'),
    });

    expect(await scored()).toEqual(byDefault);
    expect(metaValue('enrichment_columns')).toBeUndefined();
  });

  it('leaves ALL SIX empty under `none`, while the body column is untouched', async () => {
    writeSidecar();
    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      enrichmentColumns: parseColumns('none'),
    });
    const withNone = await scored();

    expect(populatedColumns()).toEqual([]);
    expect(rowsMatching('body', 'selector')).toBe(2);
    expect(metaValue('enrichment_columns')).toBe('none');

    buildOneColumnIndex();
    expect(withNone).toEqual(await scored());
  });

  it('populates EXACTLY the named subset and no other column', () => {
    writeSidecar();

    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      enrichmentColumns: parseColumns('questions,keywords'),
    });

    expect(populatedColumns()).toEqual(['keywords', 'questions']);
    expect(rowsMatching('body', 'selector')).toBe(2);
  });

  it('stamps the subset in DECLARATION order, so two spellings of one arm compare equal', () => {
    writeSidecar();

    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      enrichmentColumns: parseColumns('questions,keywords'),
    });

    expect(metaValue('enrichment_columns')).toBe('keywords,questions');
    expect(parseColumns('keywords,questions').label).toBe('keywords,questions');
  });

  it('REFUSES `body` by its own wording — that column belongs to --body-source', () => {
    const parsed = parseEnrichmentColumns('body,questions');

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toMatch(/--body-source/);
  });

  it('REFUSES an unknown name, listing the vocabulary', () => {
    const parsed = parseEnrichmentColumns('summaries');

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toMatch(/summaries/);
    expect(parsed.ok === false && parsed.reason).toMatch(/doc_desc/);
  });

  it('REFUSES an EMPTY entry rather than reading `questions,` as one column', () => {
    expect(parseEnrichmentColumns('questions,').ok).toBe(false);
  });

  it('collapses a subset naming all six to the default, which stamps nothing', () => {
    writeSidecar();

    buildFts5Index({
      atomsDir,
      indexPath,
      enrichmentPath: sidecarPath,
      enrichmentColumns: parseColumns(ENRICHMENT_COLUMNS.join(',')),
    });

    expect(metaValue('enrichment_columns')).toBeUndefined();
  });
});
