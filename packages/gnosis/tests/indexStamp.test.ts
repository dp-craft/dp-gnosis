/**
 * The corpus stamp: a STALE index is refused, never answered from.
 *
 * The property under test is a REFUSAL, so every case here asserts on the
 * reported fields — `indexState`, `count`, `exitCode`, the note — rather than on
 * prose. `count: 0` with `confidence: none` is a legitimate ANSWER ("it is not
 * in the vault"), and a refusal MUST NOT be readable as that: the last two cases
 * pin the two side by side.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  buildFts5Index,
  createFts5Adapter,
  INDEX_SCHEMA_VERSION
} from '../src/adapters/fts5Adapter.js';
import { runRetrieveCommand } from '../src/cli/retrieveCommand.js';
import { buildCorpusManifest, serializeCorpusManifest } from '../src/corpusManifest.js';
import type { KnowledgePort, RetrievalResult } from '../src/port.js';
import { DEFAULT_ANALYZER } from '../src/query.js';
import type { AnalyzerId } from '../src/query.js';
import { activeProfile } from '../src/vocabulary.js';

const NOW = new Date('2026-08-20T00:00:00.000Z');

let root = '';
let atomsDir = '';
let indexPath = '';
let manifestPath = '';

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

const writeAtom = (id: string, body: string): void => {
  writeFileSync(resolve(atomsDir, `${id}.md`), atomText(id, body), 'utf8');
};

/** The manifest ingest would have written beside this atoms dir. */
const writeManifest = (atoms: readonly { id: string; body: string }[]): void => {
  const manifest = buildCorpusManifest({
    profile: 'test',
    atoms: atoms.map(atom => ({
      id: atom.id,
      type: 'knowledge',
      domain: 'runner',
      content: atomText(atom.id, atom.body),
    })),
    sources: [],
    skipped: 0,
    duplicates: 0,
  });
  writeFileSync(manifestPath, serializeCorpusManifest(manifest), 'utf8');
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
  db.prepare('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)').run(key, value);
  db.close();
};

const dropMeta = (key: string): void => {
  const db = new Database(indexPath);
  db.prepare('DELETE FROM index_meta WHERE key = ?').run(key);
  db.close();
};

const retrieve = async (query: string): Promise<RetrievalResult> => {
  const port: KnowledgePort = createFts5Adapter({ atomsDir, indexPath, now: NOW });
  const result = await port.retrieve(query, { k: 5 });
  port.close?.();
  return result;
};

const retrieveCommand = async (query: string): ReturnType<typeof runRetrieveCommand> =>
  await runRetrieveCommand({
    adapter: 'fts5',
    atomsDir,
    indexPath,
    repoRoot: root,
    flags: {},
    positionals: [query],
    corpusRoots: ['docs'],
    profile: activeProfile(),
  });

const ATOMS = [
  { id: 'atom-a', body: 'zustand selector stability rules' },
  { id: 'atom-b', body: 'playwright end to end locator policy' },
];

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-stamp-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  manifestPath = resolve(root, 'corpus-manifest.json');
  mkdirSync(atomsDir, { recursive: true });
  ATOMS.forEach(atom => writeAtom(atom.id, atom.body));
  writeManifest(ATOMS);
  buildFts5Index({ atomsDir, indexPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('index stamp — a fresh index', () => {
  it('carries the analyzer, the schema version and the corpus digest', () => {
    expect(metaValue('analyzer')).toBe(DEFAULT_ANALYZER);
    expect(metaValue('schema_version')).toBe(INDEX_SCHEMA_VERSION);
    expect(metaValue('corpus_digest')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('stamps the digest the manifest beside the atoms dir carries', () => {
    const manifest = buildCorpusManifest({
      profile: 'test',
      atoms: ATOMS.map(atom => ({
        id: atom.id,
        type: 'knowledge',
        domain: 'runner',
        content: atomText(atom.id, atom.body),
      })),
      sources: [],
      skipped: 0,
      duplicates: 0,
    });
    expect(metaValue('corpus_digest')).toBe(manifest.digest);
  });

  it('retrieves normally', async () => {
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('ready');
    expect(result.atoms.map(atom => atom.id)).toContain('atom-a');
    expect(result.indexRefusal).toBeUndefined();
  });
});

describe('index stamp — refusal', () => {
  it('refuses when the stamped digest disagrees with the manifest', async () => {
    writeAtom('atom-c', 'a third atom the index never saw');
    writeManifest([...ATOMS, { id: 'atom-c', body: 'a third atom the index never saw' }]);
    const stamped = metaValue('corpus_digest');
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('mismatched');
    expect(result.atoms).toEqual([]);
    expect(result.indexRefusal).toContain(stamped);
  });

  it('names both digests and the rebuild remedy', async () => {
    writeManifest([{ id: 'atom-a', body: 'a different corpus entirely' }]);
    const result = await retrieve('zustand selector');
    const note = result.indexRefusal ?? '';
    expect(note).toContain(metaValue('corpus_digest'));
    expect(note).toContain(
      buildCorpusManifest({
        profile: 'test',
        atoms: [
          {
            id: 'atom-a',
            type: 'knowledge',
            domain: 'runner',
            content: atomText('atom-a', 'a different corpus entirely'),
          },
        ],
        sources: [],
        skipped: 0,
        duplicates: 0,
      }).digest
    );
    expect(note).toContain('npm run gnosis -- index --adapter fts5');
  });

  it('refuses an index_meta table carrying NO corpus_digest — the pre-stamp shape', async () => {
    dropMeta('corpus_digest');
    dropMeta('schema_version');
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('mismatched');
    expect(result.atoms).toEqual([]);
    expect(result.indexRefusal).toContain('NO corpus_digest');
    expect(result.indexRefusal).toContain('npm run gnosis -- index --adapter fts5');
  });

  it('refuses a schema_version this build does not recognise', async () => {
    setMeta('schema_version', '99');
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('mismatched');
    expect(result.atoms).toEqual([]);
    expect(result.indexRefusal).toContain('"99"');
    expect(result.indexRefusal).toContain(`"${INDEX_SCHEMA_VERSION}"`);
  });

  /**
   * A `corpus_digest` stamp is written ONLY from a manifest read at build time,
   * so a stamped index PROVES a manifest existed then. Its absence now is a
   * REMOVAL, and treating it as "nothing to compare with" turns the drift guard
   * off for exactly the index that was stale enough for someone to delete it.
   */
  it('refuses a stamped index whose manifest has been REMOVED', async () => {
    const stamped = metaValue('corpus_digest');
    rmSync(manifestPath, { force: true });
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('mismatched');
    expect(result.atoms).toEqual([]);
    expect(result.indexRefusal).toContain(stamped);
    expect(result.indexRefusal).toContain(manifestPath);
    expect(result.indexRefusal).toContain('npm run gnosis -- index --adapter fts5');
  });

  it('surfaces the removed manifest through the CLI as exit 3, not an empty answer', async () => {
    rmSync(manifestPath, { force: true });
    const outcome = await retrieveCommand('zustand selector');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.data['indexState']).toBe('mismatched');
    expect(outcome.data['count']).toBe(0);
    expect(String(outcome.data['note'])).toContain('corpus-manifest.json');
  });

  it('does NOT refuse when no manifest sits beside the atoms dir', async () => {
    rmSync(manifestPath, { force: true });
    dropMeta('corpus_digest');
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('ready');
    expect(result.atoms.map(atom => atom.id)).toContain('atom-a');
  });
});

describe('index stamp — the CLI keeps a refusal apart from an empty answer', () => {
  it('refuses with a non-zero exit, a zero count and the reason in the note', async () => {
    writeManifest([{ id: 'atom-a', body: 'a different corpus entirely' }]);
    const outcome = await retrieveCommand('zustand selector');
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.data['indexState']).toBe('mismatched');
    expect(outcome.data['count']).toBe(0);
    expect(String(outcome.data['note'])).toContain('npm run gnosis -- index --adapter fts5');
  });

  it('states nothing about the vault on a refusal', async () => {
    writeManifest([{ id: 'atom-a', body: 'a different corpus entirely' }]);
    const outcome = await retrieveCommand('zustand selector');
    expect(String(outcome.data['note'])).not.toContain('nothing in the vault matched');
  });

  it('leaves a genuine empty result an ANSWER — exit 0 under a ready index', async () => {
    const outcome = await retrieveCommand('kubernetes helm chart rollout');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.data['indexState']).toBe('ready');
    expect(outcome.data['count']).toBe(0);
    expect(outcome.data['confidence']).toBe('none');
  });
});

describe('index stamp — the analyzer stamp is unchanged', () => {
  it('reads a pre-stamp index (no index_meta at all) as porter-fold', async () => {
    const db = new Database(indexPath);
    db.exec('DROP TABLE index_meta');
    db.close();
    rmSync(manifestPath, { force: true });
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('ready');
    expect(result.atoms.map(atom => atom.id)).toContain('atom-a');
  });

  it('refuses an analyzer id outside the known chains', async () => {
    setMeta('analyzer', 'not-a-chain');
    await expect(retrieve('zustand selector')).rejects.toThrow(/unknown analyzer "not-a-chain"/);
  });
});

/**
 * The THIRD stamp dimension. A profile may declare the chain its index is built
 * with (`defaultAnalyzer`); the index carries the chain it was actually built
 * with. When the two disagree the query side has always won silently — it reads
 * the stamp — so a profile could state one chain and be served by another with
 * no diagnostic anywhere. That is the project's failure class exactly: a stated
 * configuration was ignored and the pipeline recorded the result as data.
 *
 * The refusal reuses the corpus stamp's machinery, so it is `mismatched` with a
 * reason, never an answer.
 */
describe('index stamp — the analyzer the profile DECLARES', () => {
  const retrieveExpecting = async (
    expectedAnalyzer: AnalyzerId
  ): Promise<RetrievalResult> => {
    const port: KnowledgePort = createFts5Adapter({
      atomsDir,
      indexPath,
      now: NOW,
      expectedAnalyzer,
    });
    const result = await port.retrieve('zustand selector', { k: 5 });
    port.close?.();
    return result;
  };

  it('refuses when the index was built with a chain the profile does not declare', async () => {
    const result = await retrieveExpecting('ident-hulight-fold');
    expect(result.indexState).toBe('mismatched');
    expect(result.atoms).toHaveLength(0);
  });

  it('names the declared chain, the stamped chain and the rebuild remedy', async () => {
    const result = await retrieveExpecting('ident-hulight-fold');
    expect(result.indexRefusal).toContain('ident-hulight-fold');
    expect(result.indexRefusal).toContain(DEFAULT_ANALYZER);
    expect(result.indexRefusal).toContain('index --adapter fts5');
  });

  it('does NOT refuse when the declared chain is the one the index carries', async () => {
    const result = await retrieveExpecting(DEFAULT_ANALYZER);
    expect(result.indexState).toBe('ready');
    expect(result.indexRefusal).toBeUndefined();
    expect(result.atoms.map(atom => atom.id)).toContain('atom-a');
  });

  it('does NOT refuse when the profile declares no analyzer at all', async () => {
    const result = await retrieve('zustand selector');
    expect(result.indexState).toBe('ready');
    expect(result.indexRefusal).toBeUndefined();
  });

  it('surfaces the disagreement through the CLI as a refusal, not an empty answer', async () => {
    const outcome = await runRetrieveCommand({
      adapter: 'fts5',
      atomsDir,
      indexPath,
      repoRoot: root,
      flags: {},
      positionals: ['zustand selector'],
      corpusRoots: ['docs'],
      profile: { ...activeProfile(), defaultAnalyzer: 'ident-hulight-fold' },
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.data['indexState']).toBe('mismatched');
    expect(outcome.data['count']).toBe(0);
    expect(String(outcome.data['note'])).toContain('ident-hulight-fold');
  });
});
