import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { enabledDatasets, loadManifest, parseManifest } from './manifest.js';

const MANIFEST = resolve(fileURLToPath(import.meta.url), '../../datasets.json');

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'x',
  format: 'beir-local',
  source: '/tmp/x',
  qrels: 'test',
  domain: 'demo',
  docShape: 'abstract',
  enabled: true,
  ...over,
});

const wrap = (...entries: Record<string, unknown>[]): unknown => ({ datasets: entries });

describe('parseManifest', () => {
  it('reads a beir-local entry with its optional fields', () => {
    const parsed = parseManifest(wrap(entry({ queryShape: 'long-form', atomMaxChars: 4000 })));
    expect(parsed).toEqual([
      {
        id: 'x',
        format: 'beir-local',
        source: '/tmp/x',
        qrels: 'test',
        domain: 'demo',
        docShape: 'abstract',
        queryShape: 'long-form',
        atomMaxChars: 4000,
        enabled: true,
      },
    ]);
  });

  it('reads a bright entry by its split', () => {
    const parsed = parseManifest(
      wrap({
        id: 'bright-pony',
        format: 'bright',
        split: 'pony',
        domain: 'programming-language',
        docShape: 'long-web-page',
        enabled: false,
      })
    );
    expect(parsed[0]).toMatchObject({ format: 'bright', split: 'pony', enabled: false });
  });

  it('names the fix when the format is unknown', () => {
    expect(() => parseManifest(wrap(entry({ format: 'csv' })))).toThrow(
      /unknown format "csv".*"beir-zip", "beir-local" or "bright"/s
    );
  });

  it('names the missing field when a beir entry has no qrels split', () => {
    const broken = entry();
    delete broken['qrels'];
    expect(() => parseManifest(wrap(broken))).toThrow(/datasets\[0\] has no "qrels"/);
  });

  it('names the missing field when a bright entry has no split', () => {
    expect(() => parseManifest(wrap(entry({ format: 'bright' })))).toThrow(
      /datasets\[0\] has no "split"/
    );
  });

  it('rejects a non-boolean enabled', () => {
    expect(() => parseManifest(wrap(entry({ enabled: 'yes' })))).toThrow(
      /no boolean "enabled".*true or false/s
    );
  });

  it('rejects a non-numeric atomMaxChars', () => {
    expect(() => parseManifest(wrap(entry({ atomMaxChars: '4000' })))).toThrow(
      /non-numeric "atomMaxChars"/
    );
  });

  it('rejects a root without a datasets array', () => {
    expect(() => parseManifest({})).toThrow(/no "datasets" array/);
    expect(() => parseManifest([])).toThrow(/root value is not an object/);
  });

  it('rejects a non-object entry', () => {
    expect(() => parseManifest(wrap('nfcorpus' as unknown as Record<string, unknown>))).toThrow(
      /datasets\[0\] is not an object/
    );
  });
});

describe('the shipped datasets.json', () => {
  const entries = loadManifest(MANIFEST);

  it('carries the three BEIR entries plus eight BRIGHT splits', () => {
    expect(entries).toHaveLength(11);
    expect(entries.filter(e => e.format === 'bright')).toHaveLength(8);
  });

  // AC delta: every entry is enabled now that both fetchers exist. Before them,
  // only the three datasets already on disk or hand-fetchable could run.
  it('enables every entry, each of the eleven having a fetcher', () => {
    expect(enabledDatasets(entries)).toHaveLength(11);
  });

  it('caps BRIGHT atoms at 4000 chars — its documents are whole web pages', () => {
    expect(entries.filter(e => e.format === 'bright').map(e => e.atomMaxChars)).toEqual(
      Array.from({ length: 8 }, () => 4000)
    );
  });

  it('has unique ids', () => {
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  });
});
