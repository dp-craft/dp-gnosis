import { readFileSync } from 'node:fs';
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

  // AC delta: the BEIR Tier-1 expansion adds four external `beir-zip` entries
  // (`trec-covid`, `scidocs`, `fiqa`, `webis-touche2020`), so the external-BEIR count
  // moves 3 → 7 and the total 16 → 20. BRIGHT (9), vault (2) and the vault arms (2)
  // are untouched. The external list is asserted in MANIFEST ORDER — `webis-touche2020`
  // is the archive id (touche2020.zip is a 404) and `ensureBeirDataset` resolves
  // `<dataDir>/<id>/corpus.jsonl`, so a renamed id would break the fetch, not this test.
  it('carries seven external BEIR, nine BRIGHT, two vault and two vault-arm entries', () => {
    const ids = entries.map(e => e.id);
    const isVault = (id: string): boolean => id === 'vault' || id.startsWith('vault-');
    const external = ids.filter(id => !id.startsWith('bright-') && !isVault(id));

    expect(entries.filter(e => e.format === 'bright')).toHaveLength(9);
    expect(external).toEqual([
      'nfcorpus',
      'scifact',
      'arguana',
      'trec-covid',
      'scidocs',
      'fiqa',
      'webis-touche2020',
    ]);
    expect(ids.filter(id => isVault(id) && !id.endsWith('-rephrased'))).toEqual([
      'vault',
      'vault-hu',
    ]);
    expect(ids.filter(id => id.endsWith('-rephrased'))).toEqual([
      'vault-rephrased',
      'vault-hu-rephrased',
    ]);
    expect(entries).toHaveLength(7 + 9 + 2 + 2);
  });

  // AC delta: the T-04 projection fix gives a title-only record a non-empty chunk body,
  // so `trec-covid` clears the 90% document-coverage gate and joins the default suite —
  // 17 → 18 enabled. The only entries still disabled are the two rephrased arms, which
  // are run by `--only` and MUST stay out of a bare `npm run gnosis:bench`.
  it('enables eighteen of the twenty entries, each having a fetcher', () => {
    const disabled = entries.filter(e => !e.enabled).map(e => e.id);

    expect(disabled).toEqual(['vault-rephrased', 'vault-hu-rephrased']);
    expect(enabledDatasets(entries)).toHaveLength(18);
  });

  // The four vault-family entries are the only ones that DERIVE their BEIR layout,
  // and each must name an atoms dir and a golden set — half a derivation is a typo.
  it('gives each vault entry a derive block naming atoms and a golden set', () => {
    const derived = entries.filter(e => e.format === 'beir-local' && e.derive !== undefined);

    expect(derived.map(e => e.id)).toEqual([
      'vault',
      'vault-hu',
      'vault-rephrased',
      'vault-hu-rephrased',
    ]);
    expect(derived.every(e => e.format === 'beir-local' && e.derive!.atoms.length > 0)).toBe(true);
    expect(derived.every(e => e.format === 'beir-local' && e.derive!.golden.length > 0)).toBe(true);
  });

  // The rephrased arms exist to isolate QUERY PHRASING. Same corpus, different
  // query text: if the atoms path ever drifts apart, the arm silently measures a
  // corpus difference instead — the exact defect class this suite guards.
  it.each([
    ['vault-rephrased', 'vault'],
    ['vault-hu-rephrased', 'vault-hu'],
  ])('pairs %s to %s: same atoms corpus, different golden set', (armId, baseId) => {
    const deriveOf = (id: string): { atoms: string; golden: string } => {
      const found = entries.find(e => e.id === id);
      if (found === undefined || found.format !== 'beir-local' || found.derive === undefined) {
        throw new Error(`${id} is not a derived beir-local entry`);
      }
      return { atoms: found.derive.atoms, golden: found.derive.golden };
    };
    const arm = deriveOf(armId);
    const base = deriveOf(baseId);

    expect(arm.atoms).toBe(base.atoms);
    expect(arm.golden).not.toBe(base.golden);
  });

  // Enabling an arm would silently change what a bare `npm run gnosis:bench`
  // measures — they are run with `--only <id>`.
  it('ships both rephrased arms disabled, so the default suite is unchanged', () => {
    const arms = entries.filter(e => e.id.endsWith('-rephrased'));

    expect(arms.map(e => e.id)).toEqual(['vault-rephrased', 'vault-hu-rephrased']);
    expect(arms.map(e => e.enabled)).toEqual([false, false]);
  });

  // AC delta: trec-covid ships ENABLED once the T-04 projection fix keeps its 42,139
  // title-only records. What makes enabling it SAFE is exactly that history, so the
  // manifest comment must still carry it — otherwise a later contributor who breaks the
  // projection sees a plain enabled entry and no trace of the coverage gate it once
  // failed, nor of the 12.71% of relevant judgments that were unreachable.
  it('ships trec-covid enabled with the coverage-gate history stated in the manifest', () => {
    const trecCovid = entries.find(e => e.id === 'trec-covid');
    const raw: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const rawEntries = (raw as { datasets: readonly { id: string; comment?: string }[] }).datasets;
    const comment = rawEntries.find(e => e.id === 'trec-covid')?.comment ?? '';

    expect(trecCovid?.enabled).toBe(true);
    expect(comment).toMatch(/coverage/i);
    expect(comment).toMatch(/42,139/);
    expect(comment).toMatch(/12\.71%/);
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
