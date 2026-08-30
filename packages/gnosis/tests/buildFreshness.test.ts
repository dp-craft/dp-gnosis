import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildSite } from '../src/cli/buildFreshness.js';
import { staleBuildRefusal } from '../src/cli/buildFreshness.js';
import { runCli } from '../src/cli/cli.js';
import { EXIT_PARTIAL } from '../src/cli/outcome.js';

/**
 * Every mtime here is AUTHORED. The check must never be asserted against the
 * working tree's real timestamps — that would make the verdict depend on which
 * file was edited last.
 */
const OLD = new Date('2026-08-28T10:00:00.000Z');
const NEW = new Date('2026-08-30T09:00:00.000Z');

let pkg: string;

const write = (path: string, when: Date): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  utimesSync(path, when, when);
};

/** A checkout layout: `src/` beside `dist/`, with the two mtimes stated. */
const layout = (buildWhen: Date, sourceWhen: Date): void => {
  write(join(pkg, 'dist', 'cli', 'main.js'), buildWhen);
  write(join(pkg, 'src', 'cli', 'cli.ts'), sourceWhen);
};

const compiledSite = (): BuildSite => ({ moduleDir: join(pkg, 'dist', 'cli'), packageDir: pkg });

beforeEach(() => {
  pkg = mkdtempSync(join(tmpdir(), 'gnosis-freshness-'));
});

afterEach(() => rmSync(pkg, { recursive: true, force: true }));

describe('staleBuildRefusal', () => {
  it('refuses at exit 3 and names both mtimes and both remedies when dist is older than src', () => {
    layout(OLD, NEW);
    const outcome = staleBuildRefusal(compiledSite());
    expect(outcome?.exitCode).toBe(EXIT_PARTIAL);
    expect(outcome?.text).toContain('2026-08-28T10:00:00.000Z');
    expect(outcome?.text).toContain('2026-08-30T09:00:00.000Z');
    expect(outcome?.text).toContain('npm run build');
    expect(outcome?.text).toContain('npm run gnosis');
    expect(outcome?.text).toContain('npm run setup');
    expect(outcome?.data.buildMtime).toBe('2026-08-28T10:00:00.000Z');
    expect(outcome?.data.newestSourceMtime).toBe('2026-08-30T09:00:00.000Z');
  });

  it('lets a build newer than every source file run', () => {
    layout(NEW, OLD);
    expect(staleBuildRefusal(compiledSite())).toBeUndefined();
  });

  it('reads a partial rebuild of some other dist file as STALE, not fresh', () => {
    layout(OLD, NEW);
    write(join(pkg, 'dist', 'query.js'), new Date('2026-08-31T09:00:00.000Z'));
    expect(staleBuildRefusal(compiledSite())?.exitCode).toBe(EXIT_PARTIAL);
  });

  it('no-ops when running from src/, where there is no build to be stale', () => {
    layout(OLD, NEW);
    const fromSource: BuildSite = { moduleDir: join(pkg, 'src', 'cli'), packageDir: pkg };
    expect(staleBuildRefusal(fromSource)).toBeUndefined();
  });

  it('no-ops in an install, where node_modules is a path segment', () => {
    const installed = join(pkg, 'node_modules', 'dp-gnosis');
    write(join(installed, 'dist', 'cli', 'main.js'), OLD);
    write(join(installed, 'src', 'cli', 'cli.ts'), NEW);
    const site: BuildSite = { moduleDir: join(installed, 'dist', 'cli'), packageDir: installed };
    expect(staleBuildRefusal(site)).toBeUndefined();
  });

  it('no-ops when no src/ sits beside dist/', () => {
    write(join(pkg, 'dist', 'cli', 'main.js'), OLD);
    expect(staleBuildRefusal(compiledSite())).toBeUndefined();
  });

  it('cannot tell, so runs, when the build entry point is unreadable', () => {
    write(join(pkg, 'src', 'cli', 'cli.ts'), NEW);
    mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true });
    expect(staleBuildRefusal(compiledSite())).toBeUndefined();
  });
});

describe('runCli under the freshness guard', () => {
  it('is unaffected when the suite itself runs from src/', async () => {
    const result = await runCli(['--version']);
    expect(result.exitCode).toBe(0);
  });
});
