import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomsDir, dataRoot, isInstalled, repoRoot, runtimeRoot, vaultRoot } from '../src/paths.js';
import { clearUserConfigCache } from '../src/userConfig.js';

beforeEach(() => clearUserConfigCache());

/** An XDG config HOME whose `dp-gnosis/` directory holds no `config.json` at all. */
const emptyConfigDir = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-cfg-'));
  mkdirSync(join(home, 'dp-gnosis'));
  return home;
};

/** The file `configHome()` reads, under an XDG config home. */
const configFile = (home: string): string => join(home, 'dp-gnosis', 'config.json');

/** An XDG config home whose `config.json` holds the given raw text. */
const configDirWith = (text: string): string => {
  const home = emptyConfigDir();
  writeFileSync(configFile(home), text, 'utf8');
  return home;
};

const envWith = (configDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  XDG_CONFIG_HOME: configDir,
  ...extra,
});

describe('isInstalled', () => {
  it('is true only when a node_modules PATH SEGMENT contains the package', () => {
    expect(isInstalled('/usr/local/lib/node_modules/@dp/gnosis/dist')).toBe(true);
    expect(isInstalled('/home/u/proj/node_modules/@dp/gnosis/dist')).toBe(true);
  });

  it('is false in a checkout, and false for a mere substring match', () => {
    expect(isInstalled('/home/u/dp-gnosis/packages/gnosis/src')).toBe(false);
    expect(isInstalled('/home/u/my_node_modules_backup/gnosis/src')).toBe(false);
    expect(isInstalled('/home/u/node_modulesx/gnosis/src')).toBe(false);
  });
});

describe('dataRoot — runtime root resolution order', () => {
  it('falls back to repoRoot() in a checkout with no override and no config file', () => {
    expect(dataRoot(envWith(emptyConfigDir()), 'linux')).toBe(repoRoot());
  });

  it('reads dataRoot from config.json when no environment override is set', () => {
    const dir = configDirWith(JSON.stringify({ dataRoot: '/srv/gnosis-data' }));
    expect(dataRoot(envWith(dir), 'linux')).toBe('/srv/gnosis-data');
  });

  it('lets DP_GNOSIS_DATA_HOME outrank the config file', () => {
    const dir = configDirWith(JSON.stringify({ dataRoot: '/srv/gnosis-data' }));
    expect(dataRoot(envWith(dir, { DP_GNOSIS_DATA_HOME: '/x/data' }), 'linux')).toBe('/x/data/dp-gnosis');
  });

  /**
   * XDG_DATA_HOME is a SHARED setting — it redirects every application at once,
   * and countless Linux shells export it with no intent about gnosis. It MUST
   * NOT outrank anything gnosis-specific, and MUST NOT beat a checkout.
   */
  it('does NOT let XDG_DATA_HOME outrank the config file', () => {
    const dir = configDirWith(JSON.stringify({ dataRoot: '/srv/gnosis-data' }));
    expect(dataRoot(envWith(dir, { XDG_DATA_HOME: '/x/share' }), 'linux')).toBe('/srv/gnosis-data');
  });

  it('does NOT let XDG_DATA_HOME relocate a checkout', () => {
    const env = envWith(emptyConfigDir(), { XDG_DATA_HOME: '/x/share' });
    expect(dataRoot(env, 'linux')).toBe(repoRoot());
  });

  it('ignores a blank override, which carries no path', () => {
    const dir = emptyConfigDir();
    expect(dataRoot(envWith(dir, { DP_GNOSIS_DATA_HOME: '  ' }), 'linux')).toBe(repoRoot());
  });
});

describe('dataRoot — a malformed config REFUSES, naming the file', () => {
  it('refuses invalid JSON rather than falling back silently', () => {
    const dir = configDirWith('{ not json');
    expect(() => dataRoot(envWith(dir), 'linux')).toThrow(configFile(dir));
  });

  it('refuses a non-object document', () => {
    const dir = configDirWith('[]');
    expect(() => dataRoot(envWith(dir), 'linux')).toThrow(configFile(dir));
  });

  it('refuses a relative dataRoot by name', () => {
    const dir = configDirWith(JSON.stringify({ dataRoot: 'benchmark-data' }));
    expect(() => dataRoot(envWith(dir), 'linux')).toThrow(/dataRoot/);
    expect(() => dataRoot(envWith(dir), 'linux')).toThrow(configFile(dir));
  });

  it('refuses a non-string dataRoot', () => {
    const dir = configDirWith(JSON.stringify({ dataRoot: 7 }));
    expect(() => dataRoot(envWith(dir), 'linux')).toThrow(configFile(dir));
  });
});

describe('the checkout is UNCHANGED', () => {
  it('keeps the vault and cache under the repository root', () => {
    expect(vaultRoot()).toBe(`${repoRoot()}/benchmark-data/vault`);
    expect(atomsDir()).toBe(`${repoRoot()}/benchmark-data/vault/atoms`);
    expect(runtimeRoot()).toBe(`${repoRoot()}/benchmark-data/cache`);
  });

  /**
   * The regression that matters most: a developer who exports XDG_DATA_HOME —
   * common on Linux — MUST still ingest, index and retrieve against
   * `<repo>/benchmark-data`. Every recorded number depends on it, and `ingest`
   * both writes and PRUNES, so a wrong root is destructive and silent.
   */
  it('keeps the checkout vault put even when XDG_DATA_HOME is exported', () => {
    const previous = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = '/x/share';
    try {
      expect(vaultRoot()).toBe(`${repoRoot()}/benchmark-data/vault`);
      expect(atomsDir()).toBe(`${repoRoot()}/benchmark-data/vault/atoms`);
    } finally {
      if (previous === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = previous;
    }
  });

  it('resolves the vault against the resolved data root', () => {
    expect(vaultRoot()).toBe(`${dataRoot()}/benchmark-data/vault`);
    expect(isInstalled()).toBe(false);
  });
});

/**
 * A path lookup is a DEFAULT PARAMETER on a dozen exported functions, so an
 * unmemoised config read would put a `readFileSync` behind every one of them.
 * Proved without mocking `fs`: the file is DELETED after the first resolution,
 * so a second read could only produce the fallback root.
 */
describe('the config file is read at most once per process', () => {
  it('serves every later lookup from the memoised read', () => {
    const home = configDirWith(JSON.stringify({ dataRoot: '/srv/gnosis-data' }));
    const env = envWith(home);
    expect(dataRoot(env, 'linux')).toBe('/srv/gnosis-data');

    rmSync(configFile(home));
    const lookups = Array.from({ length: 50 }, () => dataRoot(env, 'linux'));
    expect(new Set(lookups)).toEqual(new Set(['/srv/gnosis-data']));
  });

  it('re-reads once the cache is explicitly dropped', () => {
    const home = configDirWith(JSON.stringify({ dataRoot: '/srv/gnosis-data' }));
    const env = envWith(home);
    expect(dataRoot(env, 'linux')).toBe('/srv/gnosis-data');

    rmSync(configFile(home));
    clearUserConfigCache();
    expect(dataRoot(env, 'linux')).toBe(repoRoot());
  });
});
