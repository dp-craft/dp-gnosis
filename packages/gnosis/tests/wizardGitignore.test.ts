/**
 * The wizard reading a `.gitignore` into `excludePaths`.
 *
 * The property under test is the one that makes this safe: `excludePaths` is a
 * `startsWith` PREFIX (`ingest.ts:isExcluded`), not a glob, so a line that is
 * not a plain path MUST be reported as dropped rather than approximated. A
 * wildcard turned into a prefix would exclude documents nobody asked to lose,
 * and it would do it silently.
 *
 * The prefix assertions go through `sourceIdentity` — the one owner of the
 * naming rule (`CONFIGURATION.md` § 4.1). A hand-written expected string here
 * would be a second owner and would agree with the first only by luck.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { askCorpus } from '../src/cli/wizard/flow.js';
import { excludePrefix, nearestGitignore, translatable } from '../src/cli/wizard/gitignore.js';
import type { Option, Prompter } from '../src/cli/wizard/prompts.js';
import { sourceIdentity } from '../src/ingest.js';

/** A realistic file: every category the translation has to separate, in one text. */
const SAMPLE = [
  '# build output',
  '',
  'node_modules/',
  'dist/',
  '*.log',
  '!keep.md',
  '/build',
  'a/../b',
].join('\n');

/** `ingest.ts:isExcluded` — the matcher a generated prefix has to satisfy. */
const excludes = (prefixes: readonly string[], identity: string): boolean =>
  prefixes.some(prefix => identity.startsWith(prefix));

describe('translatable — which .gitignore lines ARE a path prefix', () => {
  it('should keep only the plain paths, stripped of their leading and trailing slash', () => {
    expect(translatable(SAMPLE).usable).toEqual(['node_modules', 'dist', 'build']);
  });

  it('should drop the comment, the blank, the wildcard, the negation and the .. line', () => {
    expect(translatable(SAMPLE).dropped).toEqual([
      '# build output',
      '',
      '*.log',
      '!keep.md',
      'a/../b',
    ]);
  });

  it('should account for every line exactly once, so nothing is silently lost', () => {
    const split = translatable(SAMPLE);
    expect(split.usable.length + split.dropped.length).toBe(SAMPLE.split('\n').length);
  });
});

describe('nearestGitignore — the closest file at or above a root', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-gitignore-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('should find a parent\'s .gitignore from a nested corpus root', () => {
    const repo = join(home, 'repo');
    const notes = join(repo, 'doc', 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'dist/\n', 'utf8');
    expect(nearestGitignore(notes)).toBe(join(repo, '.gitignore'));
  });

  it('should prefer the root\'s own file over the parent\'s', () => {
    const repo = join(home, 'repo');
    const notes = join(repo, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'dist/\n', 'utf8');
    writeFileSync(join(notes, '.gitignore'), 'drafts/\n', 'utf8');
    expect(nearestGitignore(notes)).toBe(join(notes, '.gitignore'));
  });

  it('should return undefined when the walk to the filesystem root finds none', () => {
    const notes = join(home, 'lone', 'notes');
    mkdirSync(notes, { recursive: true });
    expect(nearestGitignore(notes)).toBeUndefined();
  });
});

describe('excludePrefix — a prefix the ingest matcher actually excludes on', () => {
  it('should exclude a path under an in-repo entry and leave a sibling alone', () => {
    const repoRoot = '/repo';
    const prefixes = translatable(SAMPLE).usable.map(entry =>
      excludePrefix(repoRoot, repoRoot, entry)
    );
    expect(prefixes).toEqual(['node_modules', 'dist', 'build']);
    expect(excludes(prefixes, sourceIdentity(repoRoot, '/repo/dist/report.md'))).toBe(true);
    expect(excludes(prefixes, sourceIdentity(repoRoot, '/repo/doc/report.md'))).toBe(false);
  });

  it('should name an out-of-repo entry by its absolute path, as § 4.1 requires', () => {
    const repoRoot = '/data/gnosis';
    const prefix = excludePrefix(repoRoot, '/home/dev/proj', 'dist');
    expect(prefix).toBe(sourceIdentity(repoRoot, '/home/dev/proj/dist'));
    expect(excludes([prefix], sourceIdentity(repoRoot, '/home/dev/proj/dist/a.md'))).toBe(true);
    expect(excludes([prefix], sourceIdentity(repoRoot, '/home/dev/proj/doc/a.md'))).toBe(false);
  });
});

interface Reply {
  readonly match: RegExp;
  /** Consumed in order; the last one repeats, so a re-asked question can differ. */
  readonly answers: readonly unknown[];
}

/** A prompter that answers by question text; anything unscripted takes the offered default. */
const scripted = (
  replies: readonly Reply[]
): Prompter & { readonly said: readonly string[]; readonly asked: readonly string[] } => {
  const said: string[] = [];
  const asked: string[] = [];
  const used = new Map<Reply, number>();
  const reply = <T>(message: string, fallback: T): T => {
    asked.push(message);
    const found = replies.find(candidate => candidate.match.test(message));
    if (found === undefined) return fallback;
    const seen = used.get(found) ?? 0;
    used.set(found, seen + 1);
    return found.answers[Math.min(seen, found.answers.length - 1)] as T;
  };
  return {
    said,
    asked,
    say: lines => {
      said.push(...lines);
    },
    progress: line => {
      said.push(line);
    },
    select: async <T>(message: string, options: readonly Option<T>[], initial?: T): Promise<T> =>
      reply(message, initial === undefined ? (options[0] as Option<T>).value : initial),
    multiSelect: async <T>(
      message: string,
      _options: readonly Option<T>[],
      checked: readonly T[]
    ): Promise<readonly T[]> => reply<readonly T[]>(message, checked),
    confirm: async (message, initial) => reply(message, initial),
    input: async (message, initial) => reply(message, initial ?? ''),
  };
};

describe('askCorpus — the exclusion question with a .gitignore in reach', () => {
  let home = '';
  let repo = '';
  let notes = '';

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-gitignore-flow-'));
    repo = join(home, 'repo');
    notes = join(repo, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'a.md'), '# A\n\nBody.\n', 'utf8');
    writeFileSync(join(repo, '.gitignore'), SAMPLE, 'utf8');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('should pre-check every usable entry and merge it with the typed answer', async () => {
    const answers = await askCorpus(
      scripted([
        { match: /^Corpus directory/, answers: [notes] },
        { match: /^Add another corpus directory/, answers: [false] },
        { match: /^Paths to skip/, answers: ['vendor, dist'] },
      ]),
      repo
    );
    expect(answers.excludePaths).toEqual(['node_modules', 'dist', 'build', 'vendor']);
  });

  it('should treat an unchecked entry as declined', async () => {
    const answers = await askCorpus(
      scripted([
        { match: /^Corpus directory/, answers: [notes] },
        { match: /^Add another corpus directory/, answers: [false] },
        { match: /^Skip these paths/, answers: [['dist']] },
      ]),
      repo
    );
    expect(answers.excludePaths).toEqual(['dist']);
  });

  it('should say where the file is and how many of its lines it cannot use', async () => {
    const prompter = scripted([
      { match: /^Corpus directory/, answers: [notes] },
      { match: /^Add another corpus directory/, answers: [false] },
    ]);
    await askCorpus(prompter, repo);
    const transcript = prompter.said.join('\n');
    expect(transcript).toContain(join(repo, '.gitignore'));
    expect(transcript).toContain('3 of its lines are plain paths');
    expect(transcript).toContain('5 cannot be used');
  });

  it('should ask about one .gitignore once, however many roots it covers', async () => {
    const second = join(repo, 'more');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'b.md'), '# B\n\nBody.\n', 'utf8');
    const prompter = scripted([
      { match: /^Corpus directory/, answers: [notes] },
      { match: /^Next corpus directory/, answers: [second] },
      { match: /^Add another corpus directory/, answers: [true, false] },
    ]);
    const answers = await askCorpus(prompter, repo);
    expect(prompter.asked.filter(message => /^Skip these paths/.test(message))).toHaveLength(1);
    expect(answers.roots).toHaveLength(2);
  });

  it('should ask nothing extra and say nothing when no .gitignore is in reach', async () => {
    const lone = join(home, 'lone', 'notes');
    mkdirSync(lone, { recursive: true });
    writeFileSync(join(lone, 'c.md'), '# C\n\nBody.\n', 'utf8');
    const prompter = scripted([
      { match: /^Corpus directory/, answers: [lone] },
      { match: /^Add another corpus directory/, answers: [false] },
      { match: /^Paths to skip/, answers: ['vendor'] },
    ]);
    const answers = await askCorpus(prompter, join(home, 'lone'));
    expect(prompter.asked.some(message => /^Skip these paths/.test(message))).toBe(false);
    expect(prompter.said.join('\n')).not.toContain('.gitignore');
    expect(answers.excludePaths).toEqual(['vendor']);
  });
});
