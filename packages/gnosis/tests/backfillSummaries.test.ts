/**
 * SUMMARY BACKFILL (T2.8) — the four claims the script makes about safety:
 * the sanitized text round-trips through the ingest recovery regex unchanged,
 * a source is annotated exactly once, an atom gains EXACTLY ONE frontmatter
 * line or is left untouched, and a failed generation writes nothing at all.
 *
 * No network: `runBackfill` takes its generator by injection. Every fixture is
 * a temp tree — the real vault is shared and must never be pointed at here.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type BackfillOptions,
  collectTargets,
  type GenerateFailure,
  type GenerateOk,
  insertSummaryComment,
  patchAtomSummary,
  runBackfill,
  sanitizeSummary,
  type SummaryGenerator
} from '../scripts/backfill-summaries.js';

/** The recovery `ingest.ts` performs, re-implemented here so the round-trip is checked, not assumed. */
const INGEST_SUMMARY_RE = /<!--\s*LLM-PRIMARY:\s*([\s\S]*?)-->/;

const ingestRecover = (documentText: string): string | undefined => {
  const raw = INGEST_SUMMARY_RE.exec(documentText)?.[1] ?? '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
};

const atomText = (id: string, source: string, extra = ''): string =>
  `---\ntype: doc\nid: ${id}\ntitle: T ${id}\nx_domain: gnosis\n${extra}status: draft\nsources:\n  - ${source}\n---\nBody of ${id}.\n`;

interface Fixture {
  readonly root: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'gnosis-backfill-'));
  return { root, atomsDir: join(root, 'atoms') };
};

const okGenerator = (summary: string): SummaryGenerator => {
  const result: GenerateOk = {
    ok: true,
    summary,
    promptTokens: 100,
    completionTokens: 20,
    promptPerSecond: 500,
  };
  return async () => await Promise.resolve(result);
};

const failingGenerator = (error: string): SummaryGenerator => {
  const result: GenerateFailure = { ok: false, error };
  return async () => await Promise.resolve(result);
};

const optionsFor = (fixture: Fixture, generate: SummaryGenerator, dryRun = false): BackfillOptions => ({
  atomsDir: fixture.atomsDir,
  repoRoot: fixture.root,
  headChars: 4000,
  dryRun,
  generate,
});

const buildTree = async (fixture: Fixture): Promise<void> => {
  await mkdir(fixture.atomsDir, { recursive: true });
  await mkdir(join(fixture.root, 'docs'), { recursive: true });
  await writeFile(join(fixture.root, 'docs', 'a.md'), '# A\n\nAlpha text.\n', 'utf8');
  await writeFile(join(fixture.atomsDir, 'a-1.md'), atomText('a-1', 'docs/a.md'), 'utf8');
  await writeFile(join(fixture.atomsDir, 'a-2.md'), atomText('a-2', 'docs/a.md'), 'utf8');
};

describe('sanitizeSummary', () => {
  it('collapses whitespace and strips comment markers', () => {
    expect(sanitizeSummary('  <!-- one\n  two   three -->\t')).toBe('one two three');
  });

  it('truncates at the last word boundary at or before 240 characters', () => {
    const word = 'alpha ';
    const long = word.repeat(60).trim();
    const capped = sanitizeSummary(long) ?? '';
    expect(capped.length).toBeLessThanOrEqual(240);
    expect(capped.endsWith('alpha')).toBe(true);
    expect(long.startsWith(capped)).toBe(true);
  });

  it('returns undefined when nothing survives', () => {
    expect(sanitizeSummary('  <!-- -->  ')).toBeUndefined();
    expect(sanitizeSummary('')).toBeUndefined();
  });

  it('round-trips byte-identically through the ingest recovery regex', () => {
    const summary = sanitizeSummary('  A   guide\nto the   engine -->  ') ?? '';
    const document = insertSummaryComment('# Doc\n', summary);
    expect(ingestRecover(document)).toBe(summary);
  });
});

describe('insertSummaryComment', () => {
  it('prepends the comment and preserves the rest byte for byte', () => {
    const body = '# Doc\n\nline\n';
    expect(insertSummaryComment(body, 'S')).toBe(`<!-- LLM-PRIMARY: S -->\n\n${body}`);
  });

  it('is a no-op on an already-annotated document', () => {
    const annotated = '<!-- LLM-PRIMARY: kept -->\n\n# Doc\n';
    expect(insertSummaryComment(annotated, 'new')).toBe(annotated);
  });
});

describe('patchAtomSummary', () => {
  it('inserts exactly one summary line and changes nothing else', () => {
    const before = atomText('a-1', 'docs/a.md');
    const patched = patchAtomSummary(before, 'Sum');
    expect(patched.ok).toBe(true);
    const after = patched.ok ? patched.text : '';
    const added = after.split('\n').filter(line => !before.split('\n').includes(line));
    expect(added).toEqual(['summary: Sum']);
    expect(after.split('\n').length).toBe(before.split('\n').length + 1);
  });

  it('refuses an atom whose re-serialization would move other lines', () => {
    const reordered =
      '---\nstatus: draft\ntype: doc\nid: a-9\ntitle: T\nx_domain: gnosis\nsources:\n  - docs/a.md\n---\nBody.\n';
    const patched = patchAtomSummary(reordered, 'Sum');
    expect(patched).toEqual({ ok: false, error: 'unexpected-rewrite' });
  });

  it('refuses an atom that already declares a summary', () => {
    const withSummary = atomText('a-1', 'docs/a.md', 'summary: Existing\n');
    expect(patchAtomSummary(withSummary, 'Sum')).toEqual({
      ok: false,
      error: 'already-has-summary',
    });
  });

  it('refuses an unparseable atom', () => {
    const patched = patchAtomSummary('not an atom', 'Sum');
    expect(patched.ok).toBe(false);
    expect(patched.ok ? '' : patched.error).toContain('parse-failed');
  });
});

describe('collectTargets', () => {
  it('groups summary-less atoms by source and omits fully summarized sources', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    await writeFile(
      join(fixture.atomsDir, 'b-1.md'),
      atomText('b-1', 'docs/b.md', 'summary: Already\n'),
      'utf8'
    );
    const targets = collectTargets(fixture.atomsDir);
    expect(targets.sources).toEqual(['docs/a.md']);
    expect(targets.atomsBySource.get('docs/a.md')).toEqual(['a-1.md', 'a-2.md']);
  });
});

describe('runBackfill', () => {
  it('writes the source comment and patches every atom of that source', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    const report = await runBackfill(optionsFor(fixture, okGenerator('  Alpha   doc  ')));
    expect(report.generated).toBe(1);
    expect(report.atomsPatched).toBe(2);
    const source = await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8');
    expect(source).toBe('<!-- LLM-PRIMARY: Alpha doc -->\n\n# A\n\nAlpha text.\n');
    const atom = await readFile(join(fixture.atomsDir, 'a-1.md'), 'utf8');
    expect(atom).toContain('summary: Alpha doc\n');
  });

  it('writes nothing under dryRun', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    const before = await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8');
    const report = await runBackfill(optionsFor(fixture, okGenerator('Alpha'), true));
    expect(report.generated).toBe(1);
    expect(report.atomsPatched).toBe(2);
    expect(await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8')).toBe(before);
    expect(await readFile(join(fixture.atomsDir, 'a-1.md'), 'utf8')).toBe(
      atomText('a-1', 'docs/a.md')
    );
  });

  it('leaves the source and its atoms untouched when generation fails', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    const report = await runBackfill(optionsFor(fixture, failingGenerator('http-500')));
    expect(report.failed).toBe(1);
    expect(report.atomsPatched).toBe(0);
    expect(report.documents[0]?.error).toBe('http-500');
    expect(await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8')).toBe('# A\n\nAlpha text.\n');
    expect(await readFile(join(fixture.atomsDir, 'a-2.md'), 'utf8')).toBe(
      atomText('a-2', 'docs/a.md')
    );
  });

  it('records an empty generated summary as a failure without writing', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    const report = await runBackfill(optionsFor(fixture, okGenerator('   ')));
    expect(report.failed).toBe(1);
    expect(report.documents[0]?.error).toBe('empty-summary');
    expect(await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8')).toBe('# A\n\nAlpha text.\n');
  });

  it('is idempotent — a second run finds no targets', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    await runBackfill(optionsFor(fixture, okGenerator('Alpha')));
    const second = await runBackfill(optionsFor(fixture, okGenerator('Beta')));
    expect(second.processed).toBe(0);
    expect(second.atomsPatched).toBe(0);
    expect(await readFile(join(fixture.root, 'docs', 'a.md'), 'utf8')).toContain('Alpha');
  });

  it('excludes the cold call from the warm timing statistics', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    await writeFile(join(fixture.root, 'docs', 'b.md'), '# B\n', 'utf8');
    await writeFile(join(fixture.root, 'docs', 'c.md'), '# C\n', 'utf8');
    await writeFile(join(fixture.atomsDir, 'b-1.md'), atomText('b-1', 'docs/b.md'), 'utf8');
    await writeFile(join(fixture.atomsDir, 'c-1.md'), atomText('c-1', 'docs/c.md'), 'utf8');
    const report = await runBackfill(optionsFor(fixture, okGenerator('Sum')));
    expect(report.generated).toBe(3);
    expect(report.timing.count).toBe(2);
    expect(report.timing.promptTokens).toBe(200);
    expect(report.timing.completionTokens).toBe(40);
    expect(report.timing.meanPromptTokensPerSecond).toBe(500);
    expect(report.timing.coldMs).toBeGreaterThanOrEqual(0);
  });

  it('patches atoms of an already-annotated source from its existing comment', async () => {
    const fixture = await makeFixture();
    await buildTree(fixture);
    await writeFile(
      join(fixture.root, 'docs', 'a.md'),
      '<!-- LLM-PRIMARY: Existing\n  line -->\n\n# A\n',
      'utf8'
    );
    const report = await runBackfill(optionsFor(fixture, failingGenerator('must-not-be-called')));
    expect(report.alreadyAnnotated).toBe(1);
    expect(report.atomsPatched).toBe(2);
    expect(await readFile(join(fixture.atomsDir, 'a-1.md'), 'utf8')).toContain(
      'summary: Existing line\n'
    );
  });
});
