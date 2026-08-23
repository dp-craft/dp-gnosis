import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { BrightDataset } from './manifest.js';
import { datasetsInLayer, enabledDatasets, loadManifest, parseManifest } from './manifest.js';

const MANIFEST = resolve(fileURLToPath(import.meta.url), '../../datasets.json');

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'x',
  format: 'beir-local',
  source: '/tmp/x',
  qrels: 'test',
  domain: 'demo',
  docShape: 'abstract',
  enabled: true,
  layers: [],
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
        layers: [],
      },
    ]);
  });

  it('reads the layers an entry declares, in the order it declares them', () => {
    const parsed = parseManifest(wrap(entry({ layers: ['smoke', 'par', 'full'] })));
    expect(parsed[0]?.layers).toEqual(['smoke', 'par', 'full']);
  });

  // Required, not optional-with-a-default: an entry that omitted the key would be
  // invisible to every layered run while looking like one nobody had classified.
  it('names the fix when an entry declares no layers at all', () => {
    const broken = entry();
    delete broken['layers'];
    expect(() => parseManifest(wrap(broken))).toThrow(
      /datasets\[0\] has no "layers" array.*"layers": \[\].*"smoke", "par" or "full"/s
    );
  });

  it('accepts an explicit empty layers list — no layered run touches that entry', () => {
    expect(parseManifest(wrap(entry({ layers: [] })))[0]?.layers).toEqual([]);
  });

  it('names the fix when an entry declares an unknown layer', () => {
    expect(() => parseManifest(wrap(entry({ layers: ['tier1'] })))).toThrow(
      /datasets\[0\]\.layers has an unknown layer "tier1".*"smoke", "par" or "full"/s
    );
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
        layers: [],
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

  // AC delta: the AUTO rephrasing arms add two vault-arm entries
  // (`vault-autorephrased`, `vault-hu-autorephrased`) — the same corpora and judgments
  // with the query text rewritten by the shipped `--rephrase` path instead of by hand.
  // The vault arms move 2 → 4 and the total 20 → 22; external BEIR (7), BRIGHT (9) and
  // vault (2) are untouched. The external list is asserted in MANIFEST ORDER —
  // `webis-touche2020` is the archive id (touche2020.zip is a 404) and `ensureBeirDataset`
  // resolves `<dataDir>/<id>/corpus.jsonl`, so a renamed id would break the fetch, not this test.
  //
  // AC delta: `arguana-sub` adds one external BEIR entry (`beir-local`, `source:
  // data/arguana-sub`) — a 250-topic / 1542-doc subsample of `arguana`, the measurement
  // scaffold for the ingest-enrichment ablation, where a full enrichment pass costs ~2h
  // instead of ~11h. It moves external BEIR 7 → 8 and the total 22 → 23; BRIGHT (9), vault
  // (2) and the vault arms (4) are untouched. It ships `enabled: false` with `layers: []`
  // — the same precedent as the four rephrased arms — so the default suite and every
  // layered run are unchanged.
  it('carries eight external BEIR, nine BRIGHT, two vault and four vault-arm entries', () => {
    const ids = entries.map(e => e.id);
    const isVault = (id: string): boolean => id === 'vault' || id.startsWith('vault-');
    const isArm = (id: string): boolean => /-(auto)?rephrased$/.test(id);
    const external = ids.filter(id => !id.startsWith('bright-') && !isVault(id));

    expect(entries.filter(e => e.format === 'bright')).toHaveLength(9);
    expect(external).toEqual([
      'nfcorpus',
      'scifact',
      'arguana',
      'arguana-sub',
      'trec-covid',
      'scidocs',
      'fiqa',
      'webis-touche2020',
    ]);
    expect(ids.filter(id => isVault(id) && !isArm(id))).toEqual(['vault', 'vault-hu']);
    expect(ids.filter(isArm)).toEqual([
      'vault-rephrased',
      'vault-autorephrased',
      'vault-hu-rephrased',
      'vault-hu-autorephrased',
    ]);
    expect(entries).toHaveLength(8 + 9 + 2 + 4);
  });

  // AC delta: the T-04 projection fix gives a title-only record a non-empty chunk body,
  // so `trec-covid` clears the 90% document-coverage gate and joins the default suite —
  // 17 → 18 enabled. The only entries still disabled are the four rephrased arms, which
  // are run by `--only` and MUST stay out of a bare `npm run gnosis:bench`.
  it('enables eighteen of the twenty-three entries, each having a fetcher', () => {
    const disabled = entries.filter(e => !e.enabled).map(e => e.id);

    expect(disabled).toEqual([
      'arguana-sub',
      'vault-rephrased',
      'vault-autorephrased',
      'vault-hu-rephrased',
      'vault-hu-autorephrased',
    ]);
    expect(enabledDatasets(entries)).toHaveLength(18);
  });

  // The six vault-family entries are the only ones that DERIVE their BEIR layout,
  // and each must name an atoms dir and a golden set — half a derivation is a typo.
  it('gives each vault entry a derive block naming atoms and a golden set', () => {
    const derived = entries.filter(e => e.format === 'beir-local' && e.derive !== undefined);

    expect(derived.map(e => e.id)).toEqual([
      'vault',
      'vault-hu',
      'vault-rephrased',
      'vault-autorephrased',
      'vault-hu-rephrased',
      'vault-hu-autorephrased',
    ]);
    expect(derived.every(e => e.format === 'beir-local' && e.derive!.atoms.length > 0)).toBe(true);
    expect(derived.every(e => e.format === 'beir-local' && e.derive!.golden.length > 0)).toBe(true);
  });

  // The rephrased arms exist to isolate QUERY PHRASING. Same corpus, different
  // query text: if the atoms path ever drifts apart, the arm silently measures a
  // corpus difference instead — the exact defect class this suite guards.
  it.each([
    ['vault-rephrased', 'vault'],
    ['vault-autorephrased', 'vault'],
    ['vault-hu-rephrased', 'vault-hu'],
    ['vault-hu-autorephrased', 'vault-hu'],
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
  it('ships all four rephrased arms disabled with empty layers, so the default suite is unchanged', () => {
    const arms = entries.filter(e => /-(auto)?rephrased$/.test(e.id));

    expect(arms.map(e => e.id)).toEqual([
      'vault-rephrased',
      'vault-autorephrased',
      'vault-hu-rephrased',
      'vault-hu-autorephrased',
    ]);
    expect(arms.map(e => e.enabled)).toEqual([false, false, false, false]);
    expect(arms.map(e => e.layers)).toEqual([[], [], [], []]);
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

  // datasets.json is the ONE owner of the layer membership (plan D5) — nothing
  // restates it in an npm script, so these three lists are the whole definition.
  it('ships smoke as the four sub-minute datasets', () => {
    expect(datasetsInLayer(entries, 'smoke').map(e => e.id)).toEqual([
      'nfcorpus',
      'scifact',
      'vault',
      'vault-hu',
    ]);
  });

  it('ships par as the six Tier-1 BM25 datasets, trec-covid among them', () => {
    expect(datasetsInLayer(entries, 'par').map(e => e.id)).toEqual([
      'nfcorpus',
      'scifact',
      'arguana',
      'trec-covid',
      'scidocs',
      'fiqa',
    ]);
  });

  // `full` is `par` plus webis-touche2020 — the rerank-REGRESSION control, whose
  // 40-minute ingest only the arm-bearing layer earns back.
  it('ships full as par plus webis-touche2020, and nothing else', () => {
    const par = datasetsInLayer(entries, 'par').map(e => e.id);
    expect(datasetsInLayer(entries, 'full').map(e => e.id)).toEqual([...par, 'webis-touche2020']);
  });

  // The cost asymmetry is measured, not preferred: a later contributor moving
  // webis-touche2020 into `par` must meet the numbers that kept it out.
  it('records why webis-touche2020 is full-only, in measured terms', () => {
    const raw: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const rawEntries = (raw as { datasets: readonly { id: string; comment?: string }[] }).datasets;
    const comment = rawEntries.find(e => e.id === 'webis-touche2020')?.comment ?? '';

    expect(comment).toMatch(/2,413 s/);
    expect(comment).toMatch(/3,776 topics/);
    expect(comment).toMatch(/rerank regression/i);
  });

  // Plan risk R4 assumed a ~10 min ingest for trec-covid; it measures 270 s.
  it('records why trec-covid IS in par, against the plan risk that doubted it', () => {
    const raw: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const rawEntries = (raw as { datasets: readonly { id: string; comment?: string }[] }).datasets;
    const comment = rawEntries.find(e => e.id === 'trec-covid')?.comment ?? '';

    expect(comment).toMatch(/270 s/);
    expect(comment).toMatch(/R4/);
  });

  it('has unique ids', () => {
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  });
});
