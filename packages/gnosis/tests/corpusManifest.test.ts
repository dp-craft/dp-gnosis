/**
 * The manifest's SOURCE identity — the half that guards corpus→atoms.
 *
 * `atomCount`/`digest` prove two ATOM sets are the same. They say nothing about
 * the source documents those atoms were derived from, so a source edited after
 * the last ingest left no trace anywhere: a word deleted on disk still answered,
 * a word added returned nothing, and every gate stayed green.
 * `sourceCount`/`sourceDigest` record the same aggregate identity one hop
 * upstream — content-hashed, never mtime-stamped, so a `git pull` or a `touch`
 * cannot raise a false drift.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { CorpusManifest, ManifestSource } from '../src/corpusManifest.js';
import {
  buildCorpusManifest,
  readManifestDigest,
  readManifestSourceIdentity,
  serializeCorpusManifest,
} from '../src/corpusManifest.js';

const ALPHA: ManifestSource = {
  sourcePath: 'docs/alpha.md',
  text: '# Alpha\n\nzustand selector stability\n',
};

const BETA: ManifestSource = {
  sourcePath: 'docs/beta.md',
  text: '# Beta\n\nplaywright locator policy\n',
};

const SOURCES: readonly ManifestSource[] = [ALPHA, BETA];

const manifestOf = (sources: readonly ManifestSource[]): CorpusManifest =>
  buildCorpusManifest({ profile: 'manifest-test', atoms: [], sources, skipped: 0, duplicates: 0 });

describe('the manifest source identity', () => {
  it('records how many source documents the atoms were derived from', () => {
    expect(manifestOf(SOURCES).sourceCount).toBe(2);
  });

  it('is INDEPENDENT of the order the sources were discovered in', () => {
    expect(manifestOf([BETA, ALPHA]).sourceDigest).toBe(manifestOf(SOURCES).sourceDigest);
  });

  it('MOVES when a source body changes, with no path and no count moving', () => {
    const edited = [ALPHA, { ...BETA, text: `${BETA.text}revised\n` }];
    expect(manifestOf(edited).sourceCount).toBe(manifestOf(SOURCES).sourceCount);
    expect(manifestOf(edited).sourceDigest).not.toBe(manifestOf(SOURCES).sourceDigest);
  });

  it('MOVES when a source is renamed, with every body unchanged', () => {
    const renamed = [{ ...ALPHA, sourcePath: 'docs/gamma.md' }, BETA];
    expect(manifestOf(renamed).sourceDigest).not.toBe(manifestOf(SOURCES).sourceDigest);
  });

  it('is a hash and not a clock — the same bodies summarised twice agree', () => {
    expect(manifestOf([ALPHA, BETA]).sourceDigest).toBe(manifestOf(SOURCES).sourceDigest);
  });
});

describe('a manifest written BEFORE the source fields existed', () => {
  let root = '';
  let atomsDir = '';

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-manifest-'));
    atomsDir = resolve(root, 'atoms');
    mkdirSync(atomsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeManifestFile = (body: string): void =>
    writeFileSync(resolve(root, 'corpus-manifest.json'), body, 'utf8');

  const writeLegacy = (): void => {
    const { sourceCount, sourceDigest, ...legacy } = manifestOf(SOURCES);
    writeManifestFile(`${JSON.stringify(legacy, null, 2)}\n`);
  };

  it('still yields the ATOM digest — no existing reader is broken by the new keys', () => {
    writeLegacy();
    expect(readManifestDigest(atomsDir)).toBe(manifestOf(SOURCES).digest);
  });

  it('yields NO source identity, so the check reads as unavailable and never as drift', () => {
    writeLegacy();
    expect(readManifestSourceIdentity(atomsDir)).toBeUndefined();
  });

  it('yields the recorded source identity once a current manifest is written', () => {
    writeManifestFile(serializeCorpusManifest(manifestOf(SOURCES)));
    expect(readManifestSourceIdentity(atomsDir)).toEqual({
      sourceCount: 2,
      sourceDigest: manifestOf(SOURCES).sourceDigest,
    });
  });

  it('yields no source identity when no manifest sits beside the atoms directory', () => {
    expect(readManifestSourceIdentity(atomsDir)).toBeUndefined();
  });
});
