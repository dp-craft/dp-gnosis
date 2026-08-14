import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { BrightDataset } from './manifest.js';
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

  it('defaults a bright entry to "long" granularity, so older entries keep working', () => {
    const parsed = parseManifest(wrap(entry({ format: 'bright', split: 'pony' })));
    expect(parsed[0]).toMatchObject({ granularity: 'long' });
  });

  it('reads granularity: "passage" — the same queries against the gold passages', () => {
    const parsed = parseManifest(
      wrap(entry({ format: 'bright', split: 'biology', granularity: 'passage' }))
    );
    expect(parsed[0]).toMatchObject({ granularity: 'passage' });
  });

  it('names the fix when a bright entry has an unknown granularity', () => {
    expect(() =>
      parseManifest(wrap(entry({ format: 'bright', split: 'pony', granularity: 'chunk' })))
    ).toThrow(/invalid "granularity" "chunk".*"long".*"passage"/s);
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

  // AC delta: the eight long-document BRIGHT splits gain ONE passage-granularity
  // twin (bright-biology-passages), so the counts move 11 → 12 and 8 → 9.
  it('carries the three BEIR entries plus nine BRIGHT entries', () => {
    expect(entries).toHaveLength(12);
    expect(entries.filter(e => e.format === 'bright')).toHaveLength(9);
  });

  // AC delta: every entry is enabled now that both fetchers exist. Before them,
  // only the three datasets already on disk or hand-fetchable could run.
  it('enables every entry, each of the twelve having a fetcher', () => {
    expect(enabledDatasets(entries)).toHaveLength(12);
  });

  it('caps BRIGHT atoms at 4000 chars — its documents are whole web pages', () => {
    expect(entries.filter(e => e.format === 'bright').map(e => e.atomMaxChars)).toEqual(
      Array.from({ length: 9 }, () => 4000)
    );
  });

  it('states granularity on every BRIGHT entry, exactly one of them passage-level', () => {
    const bright = entries.filter((e): e is BrightDataset => e.format === 'bright');
    expect(bright.filter(e => e.granularity === 'long')).toHaveLength(8);
    expect(bright.filter(e => e.granularity === 'passage').map(e => e.id)).toEqual([
      'bright-biology-passages',
    ]);
  });

  it('has unique ids', () => {
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  });
});
