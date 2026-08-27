import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ingestProfilePath, profilesDir, USER_PROFILE_FILE } from '../src/paths.js';
import { activeProfile, resetActiveProfile } from '../src/vocabulary.js';

/**
 * `init` writes the user's own profile into the config home, but a later
 * `retrieve` without `--profile` used to resolve the SHIPPED profile — someone
 * else's `defaultPrf`, `defaultExcludedTypes` and `domainRules` over the user's
 * own index, silently, at exit 0. The user's profile MUST win when it exists,
 * and a CHECKOUT (where it does not) MUST be byte-identical to before.
 */
const CONFIG_HOME_VAR = 'XDG_CONFIG_HOME';

const SHIPPED = resolve(profilesDir(), 'default.profile.json');

let previous: string | undefined;

/** A config home with a `dp-gnosis/` directory and no user profile in it. */
const emptyConfigHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-userprofile-'));
  mkdirSync(join(home, 'dp-gnosis'));
  process.env[CONFIG_HOME_VAR] = home;
  return home;
};

/** The same, plus a valid user profile written where `init` writes it. */
const configHomeWithUserProfile = (name: string): string => {
  const home = emptyConfigHome();
  const path = join(home, 'dp-gnosis', USER_PROFILE_FILE);
  const shipped: unknown = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...(shipped as object), name }, null, 2), 'utf8');
  return path;
};

beforeEach(() => {
  previous = process.env[CONFIG_HOME_VAR];
  resetActiveProfile();
});

afterEach(() => {
  if (previous === undefined) delete process.env[CONFIG_HOME_VAR];
  else process.env[CONFIG_HOME_VAR] = previous;
  resetActiveProfile();
});

describe('the user profile written by init outranks the shipped one', () => {
  it('resolves <configHome>/user.profile.json when that file exists', () => {
    const path = configHomeWithUserProfile('mine');
    expect(ingestProfilePath()).toBe(path);
  });

  it('is what the vocabulary reads, so the index is served under the user config', () => {
    configHomeWithUserProfile('mine');
    expect(activeProfile().name).toBe('mine');
  });

  it('leaves a CHECKOUT untouched — no user profile means the shipped one', () => {
    emptyConfigHome();
    expect(ingestProfilePath()).toBe(SHIPPED);
    expect(activeProfile().name).toBe('default');
  });

  it('copies of the shipped profile elsewhere are NOT picked up', () => {
    const home = emptyConfigHome();
    copyFileSync(SHIPPED, join(home, 'dp-gnosis', 'default.profile.json'));
    expect(ingestProfilePath()).toBe(SHIPPED);
  });
});
