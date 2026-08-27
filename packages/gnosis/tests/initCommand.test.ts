/**
 * `init` — the first-run command, and the one place adoption of a data root is
 * made EXPLICIT rather than first-come.
 *
 * The two properties that matter: what it writes is a profile the loader
 * accepts (an `init` that emits a profile `ingest` then refuses is worse than
 * no `init` at all), and a second run over an existing instance REFUSES instead
 * of overwriting the corpus scope the owner edited.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CommandContext } from '../src/cli/context.js';
import { runInitCommand } from '../src/cli/initCommand.js';
import type { CommandOutcome } from '../src/cli/outcome.js';
import { configHome } from '../src/env.js';
import { ATOMS_OWNER_FILE } from '../src/ingest.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { cliInvocation } from '../src/invocation.js';
import { atomsDir, fts5IndexPath, USER_PROFILE_FILE } from '../src/paths.js';
import { clearUserConfigCache } from '../src/userConfig.js';
import { activeProfile } from '../src/vocabulary.js';

let home = '';
let corpusDir = '';

const contextWith = (positionals: readonly string[]): CommandContext => ({
  adapter: 'fts5',
  atomsDir: atomsDir(),
  indexPath: fts5IndexPath(),
  repoRoot: home,
  flags: {},
  positionals,
  corpusRoots: [],
  profile: activeProfile(),
});

const init = async (positionals: readonly string[] = [corpusDir]): Promise<CommandOutcome> =>
  await runInitCommand(contextWith(positionals));

const profilePath = (): string => join(configHome(), USER_PROFILE_FILE);

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-init-'));
  corpusDir = resolve(home, 'notes');
  writeFileSync(join(home, '.keep'), '', 'utf8');
  process.env['DP_GNOSIS_DATA_HOME'] = join(home, 'data');
  process.env['DP_GNOSIS_CONFIG_HOME'] = join(home, 'config');
  clearUserConfigCache();
});

afterEach(() => {
  delete process.env['DP_GNOSIS_DATA_HOME'];
  delete process.env['DP_GNOSIS_CONFIG_HOME'];
  clearUserConfigCache();
  rmSync(home, { recursive: true, force: true });
});

describe('init — a fresh instance', () => {
  it('exits 0 and creates the atoms directory under the resolved dataRoot', async () => {
    const outcome = await init();
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(atomsDir())).toBe(true);
    expect(atomsDir().startsWith(join(home, 'data'))).toBe(true);
  });

  it('writes a profile the loader ACCEPTS, carrying the corpus root it was given', async () => {
    await init();
    const profile = loadIngestProfile(profilePath());
    expect(profile.corpusRoots).toEqual([corpusDir]);
    expect(profile.atomsDir).toBe(atomsDir());
    expect(profile.indexPath).toBe(fts5IndexPath());
    expect(profile.domainRules.length).toBeGreaterThan(0);
    expect(profile.domains).toContain(profile.domainRules[0]?.domain);
    expect(profile.types).toContain(profile.defaultType);
  });

  it('writes NO owner marker — ownership is earned by writing atoms, not by init', async () => {
    await init();
    expect(existsSync(join(atomsDir(), ATOMS_OWNER_FILE))).toBe(false);
    expect(readdirSync(atomsDir())).toEqual([]);
  });

  it('ends by naming ingest THEN index, spelled for THIS caller', async () => {
    const outcome = await init();
    const ingestAt = outcome.text.indexOf(`${cliInvocation()} ingest`);
    const indexAt = outcome.text.indexOf(`${cliInvocation()} index`);
    expect(ingestAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(ingestAt);
  });
});

describe('init — refusals', () => {
  it('REFUSES a second run rather than overwriting the profile the owner edited', async () => {
    await init();
    const edited = `${readFileSync(profilePath(), 'utf8')}`;
    writeFileSync(profilePath(), edited.replace('"typeRules": []', '"typeRules": []'), 'utf8');
    const again = await init([resolve(home, 'other')]);
    expect(again.exitCode).toBe(3);
    expect(readFileSync(profilePath(), 'utf8')).toBe(edited);
  });

  it('REFUSES an atoms directory that already holds atoms it did not write, leaving it untouched', async () => {
    const atoms = atomsDir();
    mkdirSync(atoms, { recursive: true });
    const stray = join(atoms, 'pre-existing-atom.md');
    writeFileSync(stray, '---\nid: pre-existing-atom\n---\nbody\n', 'utf8');

    const outcome = await init();

    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain(atoms);
    expect(outcome.text).toContain('1');
    expect(outcome.text).toContain('DP_GNOSIS_DATA_HOME');
    expect(readdirSync(atoms)).toEqual(['pre-existing-atom.md']);
    expect(readFileSync(stray, 'utf8')).toBe('---\nid: pre-existing-atom\n---\nbody\n');
    expect(existsSync(profilePath())).toBe(false);
  });

  it('refuses with exit 2 when no corpus directory is named', async () => {
    const outcome = await init([]);
    expect(outcome.exitCode).toBe(2);
    expect(existsSync(profilePath())).toBe(false);
  });

  it('refuses a relative corpus directory by name rather than resolving it against the shell', async () => {
    const outcome = await init(['notes']);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.text).toContain('notes');
    expect(existsSync(profilePath())).toBe(false);
  });
});
