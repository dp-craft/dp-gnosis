import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { BeirDoc } from './beir.js';
import { buildProfile, fileNameFor, materializeCorpus, toMarkdown } from './corpus.js';

const root = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-corpus-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const docs: readonly BeirDoc[] = [
  { id: '10009203', title: 'Alpha', text: 'first body' },
  { id: 'MED-2.a_b-1', title: 'Beta', text: 'second body' },
];

describe('toMarkdown', () => {
  it('renders the title as the single H1 and the text as the body', () => {
    expect(toMarkdown(docs[0]!)).toBe('# Alpha\n\nfirst body\n');
  });
});

describe('materializeCorpus', () => {
  const target = resolve(root, 'corpus-md');
  const written = materializeCorpus(docs, target);

  it('writes one <docid>.md per document', () => {
    expect(written.docCount).toBe(2);
    expect(readFileSync(resolve(target, '10009203.md'), 'utf8')).toBe('# Alpha\n\nfirst body\n');
    expect(readFileSync(resolve(target, 'MED-2.a_b-1.md'), 'utf8')).toBe('# Beta\n\nsecond body\n');
  });

  it('returns a reversible id <-> filename map', () => {
    expect(written.fileNameById.get('10009203')).toBe('10009203.md');
    expect(written.idByFileName.get('10009203.md')).toBe('10009203');
    const roundTrip = docs.map(doc => written.idByFileName.get(written.fileNameById.get(doc.id)!));
    expect(roundTrip).toEqual(docs.map(doc => doc.id));
  });

  it('agrees with the basename an atom origin path carries', () => {
    const origin = `corpus-md/${written.fileNameById.get('10009203')!}`;
    expect(basename(origin, '.md')).toBe('10009203');
  });

  it('creates the target directory when it does not exist', () => {
    const nested = resolve(root, 'a/b/c');
    expect(materializeCorpus(docs, nested).docCount).toBe(2);
  });

  it('counts the documents actually present on disk, not the ones it wrote', () => {
    const target = resolve(root, 'present-count');
    expect(materializeCorpus(docs, target).presentFileCount).toBe(2);
  });
});

describe('materializeCorpus on a shrunken corpus', () => {
  it('removes a document file the corpus no longer claims', () => {
    const target = resolve(root, 'shrunk');
    materializeCorpus(docs, target);
    const shrunk = materializeCorpus([docs[0]!], target);
    expect(existsSync(resolve(target, 'MED-2.a_b-1.md'))).toBe(false);
    expect(existsSync(resolve(target, '10009203.md'))).toBe(true);
    expect(shrunk.docCount).toBe(1);
    expect(shrunk.presentFileCount).toBe(1);
  });

  it('removes a stale document seeded by an earlier, larger corpus', () => {
    const target = resolve(root, 'preseeded');
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, 'ghost-doc.md'), '# Ghost\n\nstale body\n', 'utf8');
    expect(materializeCorpus(docs, target).presentFileCount).toBe(2);
    expect(existsSync(resolve(target, 'ghost-doc.md'))).toBe(false);
  });

  it('refuses loudly when an entry is not a generated document', () => {
    const target = resolve(root, 'unprunable');
    mkdirSync(resolve(target, 'nested'), { recursive: true });
    expect(() => materializeCorpus(docs, target)).toThrow(/not generated documents.*nested/s);
    expect(() => materializeCorpus(docs, target)).toThrow(
      expect.objectContaining({ cause: 'dp-gnosis-bench/unprunable-corpus-dir' })
    );
  });

  it('never deletes outside the dataset directory it was given', () => {
    const sibling = resolve(root, 'ds-b/docs');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(resolve(sibling, 'sibling-doc.md'), '# Sibling\n\nbody\n', 'utf8');
    const own = resolve(root, 'ds-a/docs');
    materializeCorpus(docs, own);
    writeFileSync(resolve(root, 'ds-a/corpus-manifest.json'), '{}', 'utf8');
    materializeCorpus([docs[0]!], own);
    expect(existsSync(resolve(sibling, 'sibling-doc.md'))).toBe(true);
    expect(existsSync(resolve(root, 'ds-a/corpus-manifest.json'))).toBe(true);
  });
});

describe('fileNameFor', () => {
  it('throws a named fix for an id containing a slash', () => {
    expect(() => fileNameFor('leetcode/problem/1')).toThrow(
      /not filename-safe.*dataset fetcher/s
    );
  });

  it('rejects an empty id and path traversal', () => {
    expect(() => fileNameFor('')).toThrow(/not filename-safe/);
    expect(() => fileNameFor('../escape')).toThrow(/not filename-safe/);
  });

  it('writes nothing when an id is unsafe', () => {
    const target = resolve(root, 'unsafe');
    expect(() => materializeCorpus([{ id: 'a/b', title: 't', text: 'x' }], target)).toThrow(
      /not filename-safe/
    );
  });
});

describe('buildProfile', () => {
  const profile = buildProfile({
    datasetId: 'nfcorpus',
    workDir: '/work/nfcorpus',
    corpusDirName: 'corpus-md',
    atomMaxChars: 4000,
  });

  it('uses only the shipped domain and type vocabulary', () => {
    expect(profile.domains).toEqual(['runner', 'standards', 'adr', 'docs', 'claude']);
    expect(profile.types).toEqual(['knowledge', 'vendor-doc']);
    expect(profile.domainRules).toEqual([{ prefix: 'corpus-md/', domain: 'docs' }]);
    expect(profile.typeRules).toEqual([{ prefix: 'corpus-md/', type: 'vendor-doc' }]);
    expect(profile.defaultType).toBe('vendor-doc');
  });

  it('never derives a domain from the dataset id', () => {
    expect(profile.domains).not.toContain('nfcorpus');
    expect(profile.domainRules[0]?.domain).not.toBe('nfcorpus');
  });

  it('declares absolute, per-dataset locations off the repo vault', () => {
    expect(profile.name).toBe('dp-gnosis-bench-nfcorpus');
    expect(profile.repoRoot).toBe('/work/nfcorpus');
    expect(profile.corpusRoots).toEqual(['corpus-md']);
    expect(isAbsolute(profile.atomsDir!)).toBe(true);
    expect(isAbsolute(profile.indexPath!)).toBe(true);
    expect(profile.atomsDir).toBe('/work/nfcorpus/nfcorpus-atoms');
    expect(profile.indexPath).toBe('/work/nfcorpus/nfcorpus-index');
  });

  it('leaves atomMaxChars undefined when the manifest omits it', () => {
    const bare = buildProfile({
      datasetId: 'scifact',
      workDir: '/work/scifact',
      corpusDirName: 'corpus-md',
    });
    expect(bare.atomMaxChars).toBeUndefined();
    expect(profile.atomMaxChars).toBe(4000);
  });
});
