import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { EXIT_OK, EXIT_USAGE } from '../src/cli/outcome.js';
import { clearUserConfigCache } from '../src/userConfig.js';

/**
 * A user's `config.json` is read while the CLI resolves its locations. When it
 * is malformed the read REFUSES — correctly, since falling back would serve a
 * root the user never asked for — but the refusal MUST arrive as the CLI's own
 * usage failure: exit 2, one line naming the file. It escaped as an unhandled
 * exception once, printing a raw stack trace and an internal `dist/` path.
 *
 * And `--help` MUST work regardless: it is the command a user reaches for when
 * something is wrong, which is exactly when the config file is broken.
 */
const CONFIG_HOME_VAR = 'XDG_CONFIG_HOME';

let previous: string | undefined;

const useConfig = (text: string): string => {
  const home = mkdtempSync(join(tmpdir(), 'gnosis-cli-cfg-'));
  mkdirSync(join(home, 'dp-gnosis'));
  const path = join(home, 'dp-gnosis', 'config.json');
  writeFileSync(path, text, 'utf8');
  process.env[CONFIG_HOME_VAR] = home;
  clearUserConfigCache();
  return path;
};

beforeEach(() => {
  previous = process.env[CONFIG_HOME_VAR];
});

afterEach(() => {
  if (previous === undefined) delete process.env[CONFIG_HOME_VAR];
  else process.env[CONFIG_HOME_VAR] = previous;
  clearUserConfigCache();
});

describe('a malformed config.json is a USAGE failure, never a crash', () => {
  it('refuses invalid JSON with exit 2 and no stack trace', async () => {
    const path = useConfig('{ this is not json');
    const result = await runCli(['retrieve', 'zustand selector']);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    // A stack FRAME, i.e. `\n    at ...` — the parser's own "at position 2" is not one.
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('refuses a relative dataRoot by name, with the correction', async () => {
    const path = useConfig(JSON.stringify({ dataRoot: 'benchmark-data' }));
    const result = await runCli(['retrieve', 'zustand selector']);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain('dataRoot');
    expect(result.stderr).toContain('absolute path');
  });

  it('reports the refusal as data in --json mode', async () => {
    useConfig('{ this is not json');
    const result = await runCli(['retrieve', 'x', '--json']);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: EXIT_USAGE });
  });
});

describe('--help survives a broken config.json', () => {
  it('prints usage and exits 0', async () => {
    useConfig('{ this is not json');
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain('retrieve');
    expect(result.stderr).toBe('');
  });

  it('exits 0 for a bare invocation too', async () => {
    useConfig(JSON.stringify({ dataRoot: 'benchmark-data' }));
    const result = await runCli([]);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
  });
});
