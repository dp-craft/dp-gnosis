import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BeirDataset } from '../manifest.js';
import { describeDerivation, ensureVaultDataset, parseGoldenSet, readAtomDocs } from './vault.js';

const atom = (id: string, title: string, body: string): string =>
  `---\ntype: knowledge\nid: ${id}\ntitle: ${title}\nx_domain: docs\nstatus: stable\nsources:\n  - src/${id}.md\n---\n${body}`;

const stage = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-vault-'));
  const atomsDir = resolve(root, 'atoms');
  mkdirSync(resolve(atomsDir, 'nested'), { recursive: true });
  writeFileSync(resolve(atomsDir, 'alpha.md'), atom('alpha', 'Alpha', '# Alpha\n\nalpha body\n'));
  writeFileSync(resolve(atomsDir, 'nested', 'beta.md'), atom('beta', 'Beta', 'beta body\n'));
  writeFileSync(
    resolve(root, 'golden.json'),
    JSON.stringify({
      version: 1,
      queries: [
        { id: 'q-001', query: 'alpha question', relevantAtomIds: ['alpha', 'gone'] },
        { id: 'q-002', query: 'beta question', relevantAtomIds: ['beta'] },
      ],
    })
  );
  return root;
};

const entryFor = (root: string): BeirDataset => ({
  id: 'vault',
  format: 'beir-local',
  source: 'data/vault',
  qrels: 'test',
  domain: 'personal-vault',
  docShape: 'atom',
  enabled: true,
  layers: [],
  derive: { atoms: resolve(root, 'atoms'), golden: resolve(root, 'golden.json') },
});

describe('parseGoldenSet', () => {
  it('reads the hand-authored entries', () => {
    const queries = parseGoldenSet(
      { queries: [{ id: 'q-1', query: 'text', relevantAtomIds: ['a'] }] },
      'golden.json'
    );

    expect(queries).toEqual([{ id: 'q-1', query: 'text', relevantAtomIds: ['a'] }]);
  });

  it('names the fix when the file carries no queries array', () => {
    expect(() => parseGoldenSet({ version: 1 }, 'golden.json')).toThrow(/queries/);
  });
});

describe('readAtomDocs', () => {
  it('reads every atom under the directory, id from the filename', () => {
    const root = stage();

    const docs = readAtomDocs(resolve(root, 'atoms'));

    expect(docs.map(doc => doc.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('drops a body heading that only repeats the atom title', () => {
    const root = stage();

    const docs = readAtomDocs(resolve(root, 'atoms'));
    const alpha = docs.find(doc => doc.id === 'alpha');

    expect(alpha?.title).toBe('Alpha');
    expect(alpha?.text).toBe('alpha body\n');
  });
});

describe('ensureVaultDataset', () => {
  it('writes the BEIR layout at the entry source and counts unreachable gold', () => {
    const root = stage();
    const suiteRoot = resolve(root, 'suite');
    const entry = entryFor(root);

    const derived = ensureVaultDataset(entry, suiteRoot);

    expect(derived.dir).toBe(resolve(suiteRoot, 'data/vault'));
    expect(derived.docCount).toBe(2);
    expect(derived.queryCount).toBe(2);
    expect(derived.judgmentCount).toBe(3);
    expect(derived.unreachableCount).toBe(1);
    expect(readFileSync(resolve(derived.dir, 'queries.jsonl'), 'utf8')).toContain('alpha question');
  });

  it('keeps the unreachable judgment in the qrels so recall stays honest', () => {
    const root = stage();
    const suiteRoot = resolve(root, 'suite');

    const derived = ensureVaultDataset(entryFor(root), suiteRoot);
    const qrels = readFileSync(resolve(derived.dir, 'qrels', 'test.tsv'), 'utf8');

    expect(qrels.split('\n')[0]).toBe('query-id\tcorpus-id\tscore');
    expect(qrels).toContain('q-001\tgone\t1');
    expect(qrels).toContain('q-001\talpha\t1');
  });

  it('reports the recall ceiling as the macro mean of the reachable share', () => {
    const root = stage();

    const derived = ensureVaultDataset(entryFor(root), resolve(root, 'suite'));

    // q-001 has 1 of 2 gold atoms present, q-002 has 1 of 1 → mean 0.75.
    expect(derived.recallCeiling).toBeCloseTo(0.75);
    expect(describeDerivation('vault', derived)).toContain('1 unreachable');
    expect(describeDerivation('vault', derived)).toContain('0.7500');
  });

  it('re-derives on every call, so a changed vault is never measured stale', () => {
    const root = stage();
    const suiteRoot = resolve(root, 'suite');
    const entry = entryFor(root);
    ensureVaultDataset(entry, suiteRoot);

    writeFileSync(resolve(root, 'atoms', 'gamma.md'), atom('gamma', 'Gamma', 'gamma body\n'));
    const derived = ensureVaultDataset(entry, suiteRoot);

    expect(derived.docCount).toBe(3);
    expect(readFileSync(resolve(derived.dir, 'corpus.jsonl'), 'utf8')).toContain('"gamma"');
  });
});
