import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuildSite } from '../src/buildFreshness.js';
import { staleBuildDiagnostic } from '../src/buildFreshness.js';
import { EXIT_PARTIAL } from '../src/cli/outcome.js';

/**
 * Every mtime here is AUTHORED. An MCP client sees no output at all, so the
 * guard's verdict must depend on the fixture and never on which file in the
 * working tree happened to be edited last.
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
  write(join(pkg, 'src', 'mcp', 'main.ts'), sourceWhen);
};

/** The running copy of the shared module sits at `dist/`, not `dist/cli/`. */
const compiledSite = (): BuildSite => ({ moduleDir: join(pkg, 'dist'), packageDir: pkg });

beforeEach(() => {
  pkg = mkdtempSync(join(tmpdir(), 'gnosis-mcp-freshness-'));
});

afterEach(() => rmSync(pkg, { recursive: true, force: true }));

describe('staleBuildDiagnostic — what the MCP entry decides before it serves', () => {
  it('refuses a stale build at the CLI refusal exit code and names both mtimes', () => {
    layout(OLD, NEW);
    const diagnostic = staleBuildDiagnostic(compiledSite());
    expect(diagnostic?.exitCode).toBe(EXIT_PARTIAL);
    expect(diagnostic?.message).toContain('2026-08-28T10:00:00.000Z');
    expect(diagnostic?.message).toContain('2026-08-30T09:00:00.000Z');
    expect(diagnostic?.message).toContain('npm run build');
  });

  it('lets a build newer than every source file serve', () => {
    layout(NEW, OLD);
    expect(staleBuildDiagnostic(compiledSite())).toBeUndefined();
  });

  it('no-ops when running from src/, as tsx and every vitest run do', () => {
    layout(OLD, NEW);
    const fromSource: BuildSite = { moduleDir: join(pkg, 'src'), packageDir: pkg };
    expect(staleBuildDiagnostic(fromSource)).toBeUndefined();
  });

  it('no-ops in an install, where dist ships with no src beside it', () => {
    const installed = join(pkg, 'node_modules', 'dp-gnosis');
    write(join(installed, 'dist', 'cli', 'main.js'), OLD);
    write(join(installed, 'src', 'mcp', 'main.ts'), NEW);
    const site: BuildSite = { moduleDir: join(installed, 'dist'), packageDir: installed };
    expect(staleBuildDiagnostic(site)).toBeUndefined();
  });

  it('no-ops when no src/ sits beside dist/', () => {
    write(join(pkg, 'dist', 'cli', 'main.js'), OLD);
    expect(staleBuildDiagnostic(compiledSite())).toBeUndefined();
  });

  it('cannot tell, so serves, when the build entry point is unreadable', () => {
    write(join(pkg, 'src', 'mcp', 'main.ts'), NEW);
    mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true });
    expect(staleBuildDiagnostic(compiledSite())).toBeUndefined();
  });
});

describe('the MCP process binding', () => {
  const source = (): string =>
    readFileSync(fileURLToPath(new URL('../src/mcp/main.ts', import.meta.url)), 'utf8');

  it('consults the guard before serveStdio, and refuses on stderr with its exit code', () => {
    const text = source();
    expect(text).toContain('staleBuildDiagnostic(');
    expect(text).toContain('process.stderr.write');
    expect(text).toContain('process.exit(');
    expect(text.indexOf('serveStdio({')).toBeGreaterThan(text.indexOf('staleBuildDiagnostic('));
  });

  it('never writes a diagnostic to stdout, which is the protocol channel', () => {
    expect(source()).not.toContain('process.stdout.write');
  });
});
