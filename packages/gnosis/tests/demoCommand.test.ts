import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { atomsDir, DEMO_CORPUS_ROOTS, demoAtomsDir, demoIndexDir, demoProfilePath, indexDir, packageDir, runtimeRoot } from '../src/paths.js';
import { clearUserConfigCache } from '../src/userConfig.js';

/** Both homes are redirected, so the run cannot read or write the developer's own state. */
const redirectHomes = (): void => {
  const data = mkdtempSync(join(tmpdir(), 'gnosis-demo-data-'));
  const config = mkdtempSync(join(tmpdir(), 'gnosis-demo-cfg-'));
  mkdirSync(join(config, 'dp-gnosis'), { recursive: true });
  process.env.DP_GNOSIS_DATA_HOME = data;
  process.env.DP_GNOSIS_CONFIG_HOME = config;
  clearUserConfigCache();
};

const parse = (stdout: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== 'object' || value === null) throw new Error(`not an object: ${stdout}`);
  return value as Record<string, unknown>;
};

const hop = (payload: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = payload[key];
  if (typeof value !== 'object' || value === null) throw new Error(`hop "${key}" missing`);
  return value as Record<string, unknown>;
};

const HOME_VARS = ['DP_GNOSIS_DATA_HOME', 'DP_GNOSIS_CONFIG_HOME'] as const;

describe('demo — a ranked result over the tool\'s own shipped documentation', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    HOME_VARS.forEach(name => (saved[name] = process.env[name]));
    redirectHomes();
  });

  afterEach(() => {
    HOME_VARS.forEach(name => {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
    clearUserConfigCache();
  });

  it('exits 0 with real ranked hits from a clean data root', async () => {
    const result = await runCli(['demo', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = parse(result.stdout);
    expect(payload.command).toBe('demo');
    const search = hop(payload, 'search');
    expect(search.indexState).toBe('ready');
    expect(Number(search.count)).toBeGreaterThan(0);
    expect(Array.isArray(search.atoms) && search.atoms.length).toBeGreaterThan(0);
  }, 120_000);

  it('writes ONLY into the fixed demo subtree, never the default atoms or index paths', async () => {
    const result = await runCli(['demo', '--json']);
    const payload = parse(result.stdout);

    expect(payload.atomsDir).toBe(demoAtomsDir());
    expect(String(payload.indexPath).startsWith(demoIndexDir())).toBe(true);
    expect(readdirSync(demoAtomsDir()).length).toBeGreaterThan(0);
  }, 120_000);

  /**
   * The PROPERTY, not the string: a literal-path assertion would pass again the
   * next time the subtree moves somewhere equally wrong. Two things hold at
   * once — the demo subtree is derived and disposable, so it lives under
   * `runtimeRoot()` (the gitignored home `benchWorkDir` already uses, which is
   * why a checkout run leaves the working tree clean), AND it is never the
   * default vault paths `ingest` would claim, restamp and prune.
   */
  it('resolves under runtimeRoot() and never at or inside the default atoms or index paths', () => {
    const contains = (parent: string, child: string): boolean =>
      child === parent || child.startsWith(`${parent}${sep}`);

    expect(contains(runtimeRoot(), demoAtomsDir())).toBe(true);
    expect(contains(runtimeRoot(), demoIndexDir())).toBe(true);
    [atomsDir(), indexDir()].forEach(reserved => {
      [demoAtomsDir(), demoIndexDir()].forEach(demo => {
        expect(contains(reserved, demo)).toBe(false);
        expect(contains(demo, reserved)).toBe(false);
      });
    });
  });

  it('is idempotent — a second run produces the same count', async () => {
    const first = parse((await runCli(['demo', '--json'])).stdout);
    const second = await runCli(['demo', '--json']);

    expect(second.exitCode).toBe(0);
    expect(hop(parse(second.stdout), 'search').count).toBe(hop(first, 'search').count);
  }, 180_000);

  it('tells the reader where the demo data went and that their own corpus is untouched', async () => {
    const result = await runCli(['demo']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(demoAtomsDir());
    expect(result.stdout).toContain('untouched');
  }, 120_000);
});

/**
 * `demo` owns its paths BY DESIGN — the demo profile, the fixed `demo/` subtree
 * — so the four flags that state a location or an instance are ones it cannot
 * honour. Silently ignoring them under exit 0 is exactly the failure this CLI's
 * unknown-flag rule exists to prevent: the caller was told nothing, and the
 * directory they named was never written.
 */
describe('demo — the location and profile flags it CANNOT honour', () => {
  const REFUSED = ['--atoms-dir', '--index-path', '--repo-root', '--profile'] as const;

  REFUSED.forEach(flag => {
    it(`refuses ${flag} at exit 2 through the standard unknown-flag wording`, async () => {
      const result = await runCli(['demo', flag, '/tmp/dp-gnosis-should-not-be-used']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`unknown flag "${flag}"`);
      expect(result.stdout).toBe('');
    });
  });

  it('still honours --adapter and --json', async () => {
    const result = await runCli(['demo', '--adapter', 'fts5', '--json']);

    expect(result.exitCode).toBe(0);
    expect(parse(result.stdout).command).toBe('demo');
  }, 120_000);

  it('leaves the four flags working on the commands that DO honour them', async () => {
    const results = await Promise.all(
      REFUSED.map(flag => runCli(['doctor', flag, join(tmpdir(), 'dp-gnosis-not-demo')]))
    );

    results.forEach(result => expect(result.stderr).not.toContain('unknown flag'));
  });
});

/**
 * The invariant `paths.ts` states in prose beside {@link DEMO_CORPUS_ROOTS} —
 * "a new sibling document MUST be added to BOTH lists" — and which nothing
 * enforced. A document in the roots but under no `domainRules` prefix is
 * ingested and then dropped as unclaimed: `demo` reports every shipped document
 * ingested and answers from a subset, which is a component producing nothing
 * recorded as data.
 */
describe('demo — the shipped roots and the profile that claims them', () => {
  const claimedPrefixes = (): readonly string[] => {
    const raw: unknown = JSON.parse(readFileSync(demoProfilePath(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('demo profile is not an object');
    const rules = (raw as Record<string, unknown>)['domainRules'];
    if (!Array.isArray(rules)) throw new Error('demo profile states no domainRules');
    return rules.map(rule => String((rule as Record<string, unknown>)['prefix']));
  };

  it('claims every shipped root — no ingested document is dropped as unclaimed', () => {
    const claimed = new Set(claimedPrefixes());
    const unclaimed = DEMO_CORPUS_ROOTS.filter(root => !claimed.has(root));
    expect(unclaimed, `shipped in DEMO_CORPUS_ROOTS but claimed by no demo domainRule: ${unclaimed.join(', ')}`).toEqual([]);
  });

  it('claims nothing the demo does not ship — no rule points at an absent document', () => {
    const shipped = new Set(DEMO_CORPUS_ROOTS);
    const orphaned = claimedPrefixes().filter(prefix => !shipped.has(prefix));
    expect(orphaned, `claimed by a demo domainRule but absent from DEMO_CORPUS_ROOTS: ${orphaned.join(', ')}`).toEqual([]);
  });

  /**
   * The other half of the same prose invariant: a root the manifest does not
   * ship is present in a checkout and absent from an install, so the defect
   * appears only for the stranger running `demo` first — and appears as a
   * smaller corpus, never as an error.
   */
  it('ships every shipped root — package.json files carries each DEMO_CORPUS_ROOTS entry', () => {
    const manifest: unknown = JSON.parse(readFileSync(resolve(packageDir(), 'package.json'), 'utf8'));
    const files = (manifest as Record<string, unknown>)['files'];
    if (!Array.isArray(files)) throw new Error('package.json states no "files" array');

    const shipped = new Set(files.map(entry => String(entry)));
    const unshipped = DEMO_CORPUS_ROOTS.filter(root => !shipped.has(root));
    expect(unshipped, `in DEMO_CORPUS_ROOTS but not shipped by package.json "files": ${unshipped.join(', ')}`).toEqual([]);
  });
});
