/**
 * A `.gitignore` read as a source of `excludePaths`, and nothing more.
 *
 * `excludePaths` is NOT a glob. `ingest.ts:isExcluded` matches a prefix with
 * `startsWith` against the source IDENTITY, so only the subset of `.gitignore`
 * lines that ARE a plain path can be carried across. A wildcard, a negation or
 * a `..` line has no prefix that means the same thing, and inventing one would
 * exclude documents the user never asked to lose — silently, which is the
 * failure class this repository exists to police. Those lines are therefore
 * REPORTED as dropped rather than approximated.
 *
 * The prefix itself is built by {@link sourceIdentity}, the one owner of the
 * naming rule (`CONFIGURATION.md` § 4.1). A second implementation here would
 * be a second owner, and the two would disagree the first time a corpus root
 * moved out of the repo.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sourceIdentity } from '../../ingest.js';

const GITIGNORE = '.gitignore';

/**
 * The closest `.gitignore` at or above `root`, or undefined if the walk
 * reaches the filesystem root without finding one. The only I/O in this file.
 */
export const nearestGitignore = (root: string): string | undefined => {
  const candidate = join(root, GITIGNORE);
  if (existsSync(candidate)) return candidate;
  const parent = dirname(root);
  return parent === root ? undefined : nearestGitignore(parent);
};

/** What a `.gitignore` splits into: the lines that survive, and the lines that cannot. */
export interface Translation {
  readonly usable: readonly string[];
  readonly dropped: readonly string[];
}

/** A pattern character — its presence alone means the line is not a path prefix. */
const PATTERN = /[*?[]/;

const untranslatable = (line: string): boolean =>
  line.length === 0 ||
  line.startsWith('#') ||
  line.startsWith('!') ||
  PATTERN.test(line) ||
  line.includes('..');

/** A leading `/` anchors to the gitignore's own directory, which the prefix already is. */
const stripSlashes = (line: string): string => line.replace(/^\/+/, '').replace(/\/+$/, '');

/** PURE: the split, with no reading and no path resolution. */
export const translatable = (text: string): Translation => {
  const lines = text.split('\n').map(line => line.trim());
  return {
    usable: lines.filter(line => !untranslatable(line)).map(stripSlashes),
    dropped: lines.filter(untranslatable),
  };
};

/**
 * One `.gitignore` entry as an `excludePaths` prefix — repo-relative for a
 * source under `repoRoot`, absolute for one outside it.
 */
export const excludePrefix = (repoRoot: string, gitignoreDir: string, entry: string): string =>
  sourceIdentity(repoRoot, join(gitignoreDir, entry));
