import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExtract } from '../scripts/extract-summaries.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import {
  loadSummarySidecar,
  parseSummarySidecar,
  serializeSummarySidecar,
  SUMMARY_SIDECAR_VERSION
} from '../src/summarySidecar.js';
import { activeProfile } from '../src/vocabulary.js';

const STANDARDS_ROOT = 'claude-artifacts/standards';
const BODY =
  'prose about the layered test model written at enough length that this section stands on its own as an atom of the corpus rather than folding into a neighbour of its own document';

const sidecarText = (summaries: Readonly<Record<string, string>>): string =>
  JSON.stringify({ version: SUMMARY_SIDECAR_VERSION, summaries });

const makeTree = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-sidecar-'));
  await mkdir(join(root, STANDARDS_ROOT), { recursive: true });
  return root;
};

const hashTree = async (dir: string): Promise<ReadonlyMap<string, string>> => {
  const names = [...(await readdir(dir))].sort();
  const entries = await Promise.all(
    names.map(async (name): Promise<readonly [string, string]> => [
      name,
      createHash('sha256').update(await readFile(join(dir, name))).digest('hex'),
    ])
  );
  return new Map(entries);
};

describe('parseSummarySidecar', () => {
  it('reads a well-formed sidecar into a path → summary map', () => {
    const parsed = parseSummarySidecar(sidecarText({ 'doc/A.md': 'about A', 'doc/B.md': 'about B' }));

    expect([...parsed]).toEqual([
      ['doc/A.md', 'about A'],
      ['doc/B.md', 'about B'],
    ]);
  });

  it('refuses text that is not JSON, naming what it found', () => {
    expect(() => parseSummarySidecar('{ not json')).toThrow(/not valid JSON/);
  });

  it('refuses a missing version rather than assuming the current one', () => {
    expect(() => parseSummarySidecar(JSON.stringify({ summaries: {} }))).toThrow(
      new RegExp(`version .*undefined.*${SUMMARY_SIDECAR_VERSION}`)
    );
  });

  it('refuses a version it does not know', () => {
    expect(() =>
      parseSummarySidecar(JSON.stringify({ version: SUMMARY_SIDECAR_VERSION + 1, summaries: {} }))
    ).toThrow(new RegExp(`version .*${SUMMARY_SIDECAR_VERSION + 1}`));
  });

  it('refuses a summaries field that is not a plain object', () => {
    expect(() =>
      parseSummarySidecar(JSON.stringify({ version: SUMMARY_SIDECAR_VERSION, summaries: [] }))
    ).toThrow(/"summaries"/);
  });

  it('refuses a non-string summary value, naming the key', () => {
    expect(() =>
      parseSummarySidecar(
        JSON.stringify({ version: SUMMARY_SIDECAR_VERSION, summaries: { 'doc/A.md': 7 } })
      )
    ).toThrow(/doc\/A\.md/);
  });
});

describe('serializeSummarySidecar', () => {
  it('sorts keys and ends with exactly one newline', () => {
    const text = serializeSummarySidecar(new Map([['doc/B.md', 'b'], ['doc/A.md', 'a']]));

    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('doc/A.md')).toBeLessThan(text.indexOf('doc/B.md'));
    expect(text.includes('\n  "version"')).toBe(true);
  });

  it('is byte-stable across two serializations of the same map', () => {
    const map = new Map([['doc/B.md', 'b'], ['doc/A.md', 'a']]);

    expect(serializeSummarySidecar(map)).toBe(serializeSummarySidecar(map));
  });

  it('round-trips through the parser', () => {
    const map = new Map([['doc/A.md', 'a'], ['doc/B.md', 'b']]);

    expect([...parseSummarySidecar(serializeSummarySidecar(map))]).toEqual([...map]);
  });
});

describe('loadSummarySidecar', () => {
  it('treats an absent file as an empty map — the pre-migration state', async () => {
    const root = await makeTree();

    expect([...loadSummarySidecar(join(root, 'missing.json'))]).toEqual([]);
  });

  it('reads a written sidecar back', async () => {
    const root = await makeTree();
    const path = join(root, 'summaries.json');
    await writeFile(path, serializeSummarySidecar(new Map([['doc/A.md', 'a']])), 'utf8');

    expect([...loadSummarySidecar(path)]).toEqual([['doc/A.md', 'a']]);
  });

  it('propagates a read error that is not absence', async () => {
    const root = await makeTree();

    expect(() => loadSummarySidecar(root)).toThrow();
  });
});

describe('extract-summaries', () => {
  const profileFor = (root: string): IngestProfile => ({
    ...activeProfile(),
    repoRoot: root,
    corpusRoots: [STANDARDS_ROOT],
  });

  const writeCorpus = async (root: string): Promise<void> => {
    const dir = join(root, STANDARDS_ROOT);
    await writeFile(join(dir, 'A.md'), `<!-- LLM-PRIMARY: about A -->\n\n# A\n\n${BODY}\n`, 'utf8');
    await writeFile(join(dir, 'B.md'), `# B\n\n${BODY}\n`, 'utf8');
  };

  it('writes one entry per document that declares a comment, and counts the rest', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const outPath = join(root, 'summaries.json');

    const report = await runExtract({ profile: profileFor(root), outPath, dryRun: false });

    expect(report.scanned).toBe(2);
    expect(report.found).toBe(1);
    expect(report.missing).toEqual([`${STANDARDS_ROOT}/B.md`]);
    expect([...loadSummarySidecar(outPath)]).toEqual([[`${STANDARDS_ROOT}/A.md`, 'about A']]);
  });

  it('is idempotent — a second run over an unchanged corpus writes the same bytes', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const outPath = join(root, 'summaries.json');
    const options = { profile: profileFor(root), outPath, dryRun: false };

    await runExtract(options);
    const first = await readFile(outPath, 'utf8');
    await runExtract(options);

    expect(await readFile(outPath, 'utf8')).toBe(first);
  });

  it('writes nothing under --dry-run and never touches a source document', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const outPath = join(root, 'summaries.json');
    const before = await hashTree(join(root, STANDARDS_ROOT));

    const report = await runExtract({ profile: profileFor(root), outPath, dryRun: true });

    expect(report.found).toBe(1);
    expect([...loadSummarySidecar(outPath)]).toEqual([]);
    expect(await hashTree(join(root, STANDARDS_ROOT))).toEqual(before);
  });

  it('creates the sidecar parent directory before writing — a fresh tree declares one that does not exist', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const outPath = join(root, 'summaries', 'default.json');

    const report = await runExtract({ profile: profileFor(root), outPath, dryRun: false });

    expect(report.found).toBe(1);
    expect([...loadSummarySidecar(outPath)]).toEqual([[`${STANDARDS_ROOT}/A.md`, 'about A']]);
  });

  it('creates neither the directory nor the file under --dry-run', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const outPath = join(root, 'summaries', 'default.json');

    await runExtract({ profile: profileFor(root), outPath, dryRun: true });

    expect(existsSync(join(root, 'summaries'))).toBe(false);
    expect(existsSync(outPath)).toBe(false);
  });

  it('leaves every source document byte-identical on a real write', async () => {
    const root = await makeTree();
    await writeCorpus(root);
    const before = await hashTree(join(root, STANDARDS_ROOT));

    await runExtract({ profile: profileFor(root), outPath: join(root, 'summaries.json'), dryRun: false });

    expect(await hashTree(join(root, STANDARDS_ROOT))).toEqual(before);
  });
});
