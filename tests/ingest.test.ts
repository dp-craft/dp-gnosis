import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATOM_MAX_CHARS } from '../src/config.js';
import { ingest } from '../src/ingest.js';

interface Fixture {
  readonly root: string;
  readonly standards: string;
  readonly out: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-ingest-'));
  const standards = join(root, 'claude-artifacts', 'standards');
  await mkdir(standards, { recursive: true });
  const out = join(root, 'out');
  return { root, standards, out };
};

const writeDoc = async (dir: string, name: string, text: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return path;
};

const readAll = async (dir: string): Promise<ReadonlyMap<string, string>> => {
  const names = [...(await readdir(dir))].sort();
  const entries = await Promise.all(
    names.map(async (name): Promise<readonly [string, string]> => [
      name,
      await readFile(join(dir, name), 'utf8'),
    ])
  );
  return new Map(entries);
};

const bodyOf = (text: string): string => text.split('\n---\n').slice(1).join('\n---\n');

const DOC = '# Layered Test Model\n\nintro text\n\n## Unit tier\n\nfast tests\n';

describe('ingest', () => {
  it('turns a fixture doc into one atom file per chunk', async () => {
    const fixture = await makeFixture();
    const source = await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    const summary = await ingest({
      sources: [source],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect(summary.skipped).toEqual([]);
    const files = await readAll(fixture.out);
    expect([...files.keys()]).toEqual([
      'ts-testing-layered-test-model-unit-tier.md',
      'ts-testing-layered-test-model.md',
    ]);
    const first = files.get('ts-testing-layered-test-model.md') ?? '';
    expect(first).toContain('type: knowledge\n');
    expect(first).toContain('status: stable\n');
    expect(first).toContain('x_domain: standards\n');
    expect(first).toContain('title: Layered Test Model\n');
    expect(first).not.toContain('stale_after');
    expect(first).not.toContain('verified_');
    expect(bodyOf(first)).toBe('intro text\n');
  });

  it('records the repo-relative source path, never an absolute one', async () => {
    const fixture = await makeFixture();
    const source = await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);

    await ingest({ sources: [source], outputDir: fixture.out, repoRoot: fixture.root });

    const files = await readAll(fixture.out);
    const first = files.get('ts-testing-layered-test-model.md') ?? '';
    expect(first).toContain('sources:\n  - claude-artifacts/standards/TS-TESTING.md\n');
    expect(first).not.toContain(fixture.root);
  });

  it('produces byte-identical output when re-run over unchanged input', async () => {
    const fixture = await makeFixture();
    const source = await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    const options = { sources: [source], outputDir: fixture.out, repoRoot: fixture.root };

    await ingest(options);
    const firstRun = await readAll(fixture.out);
    const second = await ingest(options);
    const secondRun = await readAll(fixture.out);

    expect(second.written).toBe(2);
    expect(second.skipped).toEqual([]);
    expect([...secondRun.entries()]).toEqual([...firstRun.entries()]);
  });

  it('resolves identically-slugifying headings to distinct ids, independent of input order', async () => {
    const fixture = await makeFixture();
    const alpha = await writeDoc(
      join(fixture.standards, 'alpha'),
      'X.md',
      '# Gate Contract\n\nalpha body\n'
    );
    const beta = await writeDoc(
      join(fixture.standards, 'beta'),
      'X.md',
      '# gate  contract!\n\nbeta body\n'
    );

    const forward = await ingest({
      sources: [alpha, beta],
      outputDir: join(fixture.root, 'fwd'),
      repoRoot: fixture.root,
    });
    const reverse = await ingest({
      sources: [beta, alpha],
      outputDir: join(fixture.root, 'rev'),
      repoRoot: fixture.root,
    });

    expect(forward.written).toBe(2);
    expect(reverse.written).toBe(2);
    const fwd = await readAll(join(fixture.root, 'fwd'));
    const rev = await readAll(join(fixture.root, 'rev'));
    expect([...fwd.keys()].length).toBe(2);
    expect([...rev.entries()]).toEqual([...fwd.entries()]);
    expect([...fwd.keys()].every(name => name.startsWith('x-gate-contract-'))).toBe(true);
  });

  it('refuses a source outside every declared ingest root and names the correction', async () => {
    const fixture = await makeFixture();
    const source = await writeDoc(join(fixture.root, 'notes'), 'stray.md', DOC);

    const summary = await ingest({
      sources: [source],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    const reason = summary.skipped[0]?.reasons.join(' ') ?? '';
    expect(summary.skipped[0]?.source).toBe('notes/stray.md');
    expect(reason).toContain('claude-artifacts/standards/');
    expect(reason).toContain('SOURCE_ROOT_DOMAINS');
  });

  it('keeps every written atom under the body cap by sub-splitting an oversize section', async () => {
    const fixture = await makeFixture();
    const paragraphs = Array.from(
      { length: 200 },
      (_unused, index) => `paragraph ${index} ${'x'.repeat(60)}`
    ).join('\n\n');
    const source = await writeDoc(
      fixture.standards,
      'BIG.md',
      `# Huge Section\n\n${paragraphs}\n`
    );

    const summary = await ingest({
      sources: [source],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBeGreaterThan(1);
    expect(summary.skipped).toEqual([]);
    const files = await readAll(fixture.out);
    expect([...files.values()].every(text => bodyOf(text).length <= ATOM_MAX_CHARS)).toBe(true);
    expect(new Set(files.keys()).size).toBe(summary.written);
  });

  it('skips and reports a refused source while still writing the valid ones', async () => {
    const fixture = await makeFixture();
    const good = await writeDoc(fixture.standards, 'TS-TESTING.md', DOC);
    const stray = await writeDoc(join(fixture.root, 'notes'), 'stray.md', DOC);

    const summary = await ingest({
      sources: [stray, good],
      outputDir: fixture.out,
      repoRoot: fixture.root,
    });

    expect(summary.written).toBe(2);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.source).toBe('notes/stray.md');
    expect([...(await readAll(fixture.out)).keys()]).toEqual([
      'ts-testing-layered-test-model-unit-tier.md',
      'ts-testing-layered-test-model.md',
    ]);
  });
});
