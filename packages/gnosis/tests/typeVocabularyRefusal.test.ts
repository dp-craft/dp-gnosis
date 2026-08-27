/**
 * A profile that names a type this build does not define is REFUSED — and the
 * refusal has to reach the person who can act on it.
 *
 * Two audiences, two wordings. A user who edited the profile `init` wrote for
 * them has no `src/config.ts` to open, so naming one is not a remedy; a
 * checkout, where the SHIPPED profile and the mirrored tuple genuinely
 * disagree, is exactly the case where naming it is the remedy. Either way the
 * refusal MUST arrive as one line at the exit code the contract defines for bad
 * input — never as an uncaught stack trace at exit 1.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { DECLARED_TYPES, expectVocabulary, isVocabularyError } from '../src/config.js';
import { profilesDir, USER_PROFILE_FILE } from '../src/paths.js';
import { resetActiveProfile } from '../src/vocabulary.js';

const CONFIG_HOME_VAR = 'XDG_CONFIG_HOME';

const SHIPPED = resolve(profilesDir(), 'default.profile.json');

const FOREIGN = 'recipe';

let previous: string | undefined;

/** A config home laid out as `init` leaves it, with no user profile in it. */
const emptyConfigHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-vocab-refusal-'));
  mkdirSync(join(home, 'dp-gnosis'));
  process.env[CONFIG_HOME_VAR] = home;
  return home;
};

/** The shipped profile, copied where `init` writes it, plus one type of the user's own. */
const userProfileDeclaring = (type: string): string => {
  const path = join(emptyConfigHome(), 'dp-gnosis', USER_PROFILE_FILE);
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8')) as { types: readonly string[] };
  writeFileSync(path, JSON.stringify({ ...shipped, types: [...shipped.types, type] }, null, 2), 'utf8');
  return path;
};

const refusalFor = (types: readonly string[]): Error => {
  try {
    expectVocabulary(types, DECLARED_TYPES, 'types');
  } catch (error) {
    return error as Error;
  }
  throw new Error('expectVocabulary accepted a foreign type');
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

describe('a foreign type is refused as a TAGGED usage failure', () => {
  it('tags the refusal so a caller can render it instead of letting it escape', () => {
    emptyConfigHome();
    expect(isVocabularyError(refusalFor(['knowledge', FOREIGN]))).toBe(true);
  });

  it('tags the empty-vocabulary refusal the same way', () => {
    emptyConfigHome();
    expect(isVocabularyError(refusalFor([]))).toBe(true);
  });
});

describe('the wording a PROFILE AUTHOR reads', () => {
  it('names the profile file, the offending value and the permitted ones', () => {
    const path = userProfileDeclaring(FOREIGN);
    const message = refusalFor(['knowledge', FOREIGN]).message;
    expect(message).toContain(path);
    expect(message).toContain(FOREIGN);
    expect(message).toContain(DECLARED_TYPES.join(' | '));
  });

  it('states the vocabulary is fixed and MUST NOT send the user to TypeScript source', () => {
    userProfileDeclaring(FOREIGN);
    const message = refusalFor(['knowledge', FOREIGN]).message;
    expect(message).toMatch(/fixed/i);
    expect(message).not.toContain('src/config.ts');
    expect(message).not.toMatch(/TypeScript/i);
  });
});

describe('the wording a CHECKOUT reads, where the shipped profile and the tuple disagree', () => {
  it('names src/config.ts, which is the remedy only in that case', () => {
    emptyConfigHome();
    const message = refusalFor(['knowledge', FOREIGN]).message;
    expect(message).toContain('src/config.ts');
    expect(message).toContain(DECLARED_TYPES.join(' | '));
  });
});

describe('the CLI renders it as a clean refusal', () => {
  it('exits 2 with no stack frames when the user profile declares a foreign type', async () => {
    userProfileDeclaring(FOREIGN);
    const result = await runCli(['retrieve', 'bm25']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(FOREIGN);
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain('src/config.ts');
  });
});
