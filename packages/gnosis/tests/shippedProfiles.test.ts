import { readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/cli.js';
import { CORPUS_ROOTS_ENV_VAR, corpusRootStatements } from '../src/config.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { profilesDir } from '../src/paths.js';
import { atomTypes } from '../src/vocabulary.js';

/**
 * The shipped profiles directory — enumerated, so a future profile is covered
 * too. Taken from `profilesDir()`, which names the SHIPPED directory and takes
 * no root. `dirname(ingestProfilePath())` would follow the user's own profile
 * into `configHome()` on any machine that has run `dp-gnosis init`, and judge
 * that directory instead — collecting nothing here, so the suite would pass
 * vacuously.
 */
const PROFILES_DIR = profilesDir();

const profilePaths: readonly string[] = readdirSync(PROFILES_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => join(PROFILES_DIR, name));

const loaded: readonly (readonly [string, IngestProfile])[] = profilePaths.map(path => [
  basename(path),
  loadIngestProfile(path),
]);

const profileByName = (name: string): IngestProfile => {
  const found = loaded.find(([, profile]) => profile.name === name);
  if (found === undefined) throw new Error(`no shipped profile named "${name}"`);
  return found[1];
};

/** The shipped type vocabulary, widened to string for a membership test. */
const SHIPPED_TYPES: readonly string[] = atomTypes();

const duplicatesOf = (values: readonly string[]): readonly string[] =>
  values.filter((value, index) => values.indexOf(value) !== index);

describe('shipped profiles', () => {
  it('collects a non-empty shipped set containing default.profile.json, so no run passes vacuously', () => {
    const names = loaded.map(([file]) => file);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('default.profile.json');
  });

  it('ships the two worked-proof profiles beside the default', () => {
    const names = loaded.map(([file]) => file);
    expect(names).toContain('web-research.profile.json');
    expect(names).toContain('hu-tax.profile.json');
  });

  it('loads every shipped profile through loadIngestProfile without throwing', () => {
    profilePaths.forEach(path => {
      expect(() => loadIngestProfile(path)).not.toThrow();
    });
  });

  it('declares a name, domains, an atomsDir and an indexPath on the new profiles', () => {
    (['web-research', 'hu-tax'] as const).forEach(name => {
      const profile = profileByName(name);
      expect(profile.name).toBe(name);
      expect(profile.domains.length).toBeGreaterThan(0);
      expect(profile.atomsDir).toBeTruthy();
      expect(profile.indexPath).toBeTruthy();
    });
  });

  it('gives no two shipped profiles the same atomsDir', () => {
    const dirs = loaded
      .map(([, profile]) => profile.atomsDir)
      .filter((value): value is string => value !== undefined)
      .map(value => resolve(value));
    expect(duplicatesOf(dirs)).toEqual([]);
  });

  it('gives no two shipped profiles the same indexPath', () => {
    const paths = loaded
      .map(([, profile]) => profile.indexPath)
      .filter((value): value is string => value !== undefined)
      .map(value => resolve(value));
    expect(duplicatesOf(paths)).toEqual([]);
  });

  it('names only shipped atomTypes(), so no type is silently relabelled at read time', () => {
    loaded.forEach(([file, profile]) => {
      const unknown = profile.types.filter(type => !SHIPPED_TYPES.includes(type));
      expect({ file, unknown }).toEqual({ file, unknown: [] });
    });
  });

  // AC delta (D4): the previous assertion was `rejects.toThrow(...)` — an
  // uncaught throw reaching the process as exit 1, outside the documented
  // 0/2/3 exit vocabulary a caller MUST branch on. A misconfigured corpus root
  // is a USAGE error, so the contract is now exit 2 with the message on stderr,
  // and the message must name all THREE places the scope can be set.
  it('refuses ingest with exit 2 when a corpus root matches no markdown, naming that root and every remedy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gnosis-unmounted-'));
    const profilePath = join(dir, 'unmounted.profile.json');
    await writeFile(
      profilePath,
      JSON.stringify({
        name: 'unmounted',
        domains: ['hu-tax'],
        types: ['knowledge'],
        defaultType: 'knowledge',
        domainRules: [{ prefix: 'analizis', domain: 'hu-tax' }],
        typeRules: [],
        segmentRules: [],
        repoRoot: dir,
        corpusRoots: ['analizis'],
        atomsDir: join(dir, 'atoms'),
        indexPath: join(dir, 'index.db'),
      }),
      'utf8'
    );
    const result = await runCli(['ingest', '--profile', profilePath]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/corpus root "analizis" matched no markdown files/);
    expect(result.stderr).toContain('CORPUS_ROOTS (src/config.ts)');
    expect(result.stderr).toContain('the profile\'s corpusRoots');
    expect(result.stderr).toContain(CORPUS_ROOTS_ENV_VAR);
    expect(result.stdout).toBe('');
  });

  /**
   * The refusal above names three places a corpus root can be stated, but
   * CORPUS_ROOTS lives in TypeScript source that an install does not ship, so
   * naming it there is a dead end rather than a remedy. The two branches are
   * pinned side by side deliberately, because they are one rule and they change
   * together: the test above proves the checkout wording end to end through the
   * CLI, this one proves what is dropped for an install.
   */
  it('drops src/config.ts from the remedies, so an installed reader is not sent to a source file their instance does not ship', () => {
    const statements = corpusRootStatements(true);

    expect(statements).not.toContain('src/config.ts');
    expect(statements).toContain('the profile\'s corpusRoots');
    expect(statements).toContain(CORPUS_ROOTS_ENV_VAR);
  });

  it('lets web-research declare a domain the default profile does not know', () => {
    const declared = profileByName('web-research').domains;
    const shipped = profileByName('default').domains;
    expect(declared.some(domain => !shipped.includes(domain))).toBe(true);
  });
});
