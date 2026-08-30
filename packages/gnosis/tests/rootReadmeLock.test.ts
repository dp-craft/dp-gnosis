/**
 * Locks the ROOT `README.md` — the product front page — against the repository
 * it describes. `readmeFlags.test.ts` locks the CLI README to `FLAGS`; the root
 * README had no lock at all, and measured 2026-08-29 it carried three defects of
 * one class — a claim about the repository that the repository contradicts:
 *
 *   - it cross-referenced `§ Rephrasing`, a section that does not exist in it;
 *   - it named `lancedb` among adapters that "work on any install", while
 *     `@lancedb/lancedb` is a devDependency a consumer never receives;
 *   - it named a document count the recorded baselines contradict.
 *
 * Each assertion below therefore reads a fact out of the README's PROSE and one
 * out of the repository, and fails naming the direction — because the fixes
 * differ: "the README lies" and "the manifest moved" are not the same edit.
 * Every extractor is a pure function over text so the failing direction can be
 * demonstrated against a deliberately broken input, not only against the file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT_README = join(REPO_ROOT, 'README.md');
const GNOSIS_MANIFEST = join(REPO_ROOT, 'packages/gnosis/package.json');

/**
 * Fenced blocks are STRIPPED before anything is parsed. Measured while writing
 * this file: over the raw text the ``` fences pair with the inline backticks
 * around them, and 12 cited markdown paths were read as 1 — the vacuity guard
 * below is what caught it. A shell transcript is not prose about the repository.
 */
const withoutCodeFences = (text: string): string => text.replace(/^```[\s\S]*?^```/gm, '');

const readme = withoutCodeFences(readFileSync(ROOT_README, 'utf8'));
const manifest = JSON.parse(readFileSync(GNOSIS_MANIFEST, 'utf8')) as {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
};

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const backticked = (text: string): readonly string[] =>
  [...text.matchAll(/`([^`]+)`/g)].flatMap(match => (match[1] === undefined ? [] : [match[1]]));

/** Blank-line separated blocks: a paragraph, a bullet list, or a table row. */
const blocksOf = (text: string): readonly string[] =>
  text.split(/\n\s*\n/).map(squash).filter(block => block.length > 0);

/* 1. Every markdown path the front page cites. */

const citedMarkdownPaths = (text: string): readonly string[] =>
  [...new Set(backticked(text).filter(token => token.endsWith('.md')))].sort();

const missingPaths = (paths: readonly string[], root: string): readonly string[] =>
  paths.filter(path => !existsSync(join(root, path)));

/* 2. Self-references. */

/**
 * A `§ …` reference points into ANOTHER file when its block names that file:
 * `packages/gnosis/OPTIONAL.md § Setting up the reranker`, or the second
 * reference in "…are in `packages/gnosis/QUERYING.md` § Query rephrasing. …copy
 * that file's § LLM integration prompt verbatim", which names its subject only
 * as "that file". The exclusion unit is therefore the whole BLOCK, not the
 * sentence: a cross-file reference may name its file in a neighbouring sentence,
 * and treating that as a self-reference would fail the lock on correct prose.
 * The cost is under-checking — a self-reference inside a block that also cites a
 * file goes unverified — which is the safe direction for a documentation gate.
 */
const isCrossFileBlock = (block: string): boolean => /`[^`]+\.md`/.test(block);

/**
 * A reference runs from `§` to the end of the sentence, a closing paren, or a
 * table cell wall. It MUST NOT stop at `?` — `§ Is \`--rerank\` worth it?` names
 * a heading whose question mark is part of it.
 */
const referencesIn = (block: string): readonly string[] =>
  [...block.matchAll(/§\s+([^|)]*?)(?=\.\s|\.$|\)|\||$)/g)]
    .flatMap(match => (match[1] === undefined ? [] : [squash(match[1])]))
    .filter(reference => reference.length > 0);

const selfReferences = (text: string): readonly string[] =>
  blocksOf(text)
    .filter(block => !isCrossFileBlock(block))
    .flatMap(referencesIn);

const headingsOf = (text: string): readonly string[] =>
  text
    .split('\n')
    .filter(line => /^#{2,3} /.test(line))
    .map(line => squash(line.replace(/^#{2,3} /, '')));

const danglingReferences = (text: string): readonly string[] => {
  const headings = new Set(headingsOf(text));
  return selfReferences(text).filter(reference => !headings.has(reference));
};

/* 3. The dependency claim. */

const CLAIM = 'are the only required dependencies';

const claimedDependencies = (text: string): readonly string[] => {
  const block = blocksOf(text).find(candidate => candidate.includes(CLAIM));
  const sentence = (block ?? '').split(CLAIM)[0] ?? '';
  return [...new Set(backticked(sentence))].sort();
};

/* 4. Adapters claimed to need no extra install. */

const INSTALLABLE_CLAIM = 'work on any install';

/**
 * DECLARED, not inferred: the npm package each named adapter needs at runtime.
 * `null` means the adapter is implemented in this package's own TypeScript and
 * needs nothing installed. Asserted exhaustive over the claim below, so a new
 * adapter cannot be advertised as install-free without stating what backs it.
 */
const ADAPTER_PACKAGES: Readonly<Record<string, string | null>> = {
  fts5: 'better-sqlite3',
  linear: null,
  minisearch: 'minisearch',
  lancedb: '@lancedb/lancedb',
};

const adaptersClaimedInstallable = (text: string): readonly string[] => {
  const block = blocksOf(text).find(candidate => candidate.includes(INSTALLABLE_CLAIM));
  const after = (block ?? '').split(INSTALLABLE_CLAIM)[1] ?? '';
  const clause = after.split(/\.\s/)[0] ?? '';
  return [...new Set(backticked(clause))].sort();
};

const adaptersBackedByDevDependency = (
  claimed: readonly string[],
  packages: Readonly<Record<string, string | null>>,
  devDependencies: Readonly<Record<string, string>>
): readonly string[] =>
  claimed.filter(adapter => {
    const backing = packages[adapter];
    return typeof backing === 'string' && backing in devDependencies;
  });

describe('every markdown path the root README cites exists', () => {
  const cited = citedMarkdownPaths(readme);

  it('resolves each cited path against the repository root', () => {
    expect(
      missingPaths(cited, REPO_ROOT),
      'the root README cites a document that is not in the repository — ' +
        'fix the path or write the document'
    ).toEqual([]);
  });

  it('finds a non-empty set of cited paths, so an empty match cannot pass vacuously', () => {
    expect(cited.length).toBeGreaterThan(10);
  });

  it('names a path that does not resolve', () => {
    expect(missingPaths(['handbook/NO-SUCH-DOC.md'], REPO_ROOT)).toEqual([
      'handbook/NO-SUCH-DOC.md',
    ]);
  });
});

describe('every § self-reference resolves to one of the README\'s own headings', () => {
  it('points each self-reference at a heading that exists', () => {
    expect(
      danglingReferences(readme),
      'the root README cross-references a section of ITSELF that does not exist ' +
        '(the `§ Rephrasing` defect) — rename the reference or add the heading'
    ).toEqual([]);
  });

  it('finds the self-references, so an empty match cannot pass vacuously', () => {
    expect(selfReferences(readme)).toEqual([
      'Ask with keywords, not with a question',
      'Is `--rerank` worth it?',
    ]);
  });

  it('excludes a reference whose block names another file', () => {
    const block = 'see `packages/gnosis/OPTIONAL.md` § Setting up the reranker. Copy that file\'s § LLM integration prompt.';
    expect(selfReferences(block)).toEqual([]);
  });

  it('keeps a question mark that belongs to the heading', () => {
    expect(referencesIn('a verdict (§ Is `--rerank` worth it?). The engine has none.')).toEqual([
      'Is `--rerank` worth it?',
    ]);
  });

  it('reads a reference that wraps across a newline', () => {
    const wrapped = 'the lever (§ Ask with keywords,\nnot with a question). You can do that by hand.';
    expect(danglingReferences(`## Ask with keywords, not with a question\n\n${wrapped}`)).toEqual(
      []
    );
  });

  it('names a self-reference with no matching heading', () => {
    expect(danglingReferences('## Query rephrasing\n\nthe rules (§ Rephrasing) apply.')).toEqual([
      'Rephrasing',
    ]);
  });
});

describe('README § Install names exactly the required dependencies, both directions', () => {
  const claimed = claimedDependencies(readme);
  const declared = Object.keys(manifest.dependencies).sort();

  it('claims every dependency the manifest declares', () => {
    expect(
      declared.filter(name => !claimed.includes(name)),
      'packages/gnosis/package.json declares a dependency the README does not name — ' +
        'a reader sizing the install is misled'
    ).toEqual([]);
  });

  it('claims no dependency the manifest does not declare', () => {
    expect(
      claimed.filter(name => !declared.includes(name)),
      'the README names a required dependency that is not in packages/gnosis/package.json — ' +
        'delete it from the README or declare it'
    ).toEqual([]);
  });

  it('parses a non-empty claim, so an empty-set match cannot pass vacuously', () => {
    expect(claimed).toEqual(['@inquirer/prompts', 'better-sqlite3', 'minisearch', 'stemmer']);
  });
});

describe('no adapter is advertised as install-free unless its package really ships', () => {
  const claimed = adaptersClaimedInstallable(readme);

  it('parses the adapters the README says work on any install', () => {
    expect(claimed).toEqual(['fts5', 'linear', 'minisearch']);
  });

  it('declares a backing package for every adapter it can name', () => {
    expect(
      claimed.filter(adapter => !(adapter in ADAPTER_PACKAGES)),
      'ADAPTER_PACKAGES must stay exhaustive over the adapters the README advertises — ' +
        'declare the new one with its npm package, or null if this package implements it'
    ).toEqual([]);
  });

  it('backs each advertised adapter with a real dependency, never a devDependency', () => {
    expect(
      adaptersBackedByDevDependency(claimed, ADAPTER_PACKAGES, manifest.devDependencies),
      'the README says an adapter works on any install, but its package is a devDependency — ' +
        'a consumer install never receives it (the `lancedb` defect)'
    ).toEqual([]);
  });

  it('catches an adapter advertised on a devDependency', () => {
    expect(
      adaptersBackedByDevDependency(['lancedb'], ADAPTER_PACKAGES, manifest.devDependencies)
    ).toEqual(['lancedb']);
  });
});
