/**
 * Detects a COMPILED build that is older than the source it was built from —
 * in a development checkout, and nowhere else.
 *
 * This is `GNOSIS-RULES.md` § The failure class in its cheapest form: a stale
 * `dist/` produces plausible output for behaviour `src/` has already changed,
 * and nothing anywhere says so. It really happened — a build from `0bfa1cf` was
 * run after `src/` had advanced two commits and produced three bug reports
 * about defects that were already fixed. The component was stale; the pipeline
 * recorded its output as data.
 *
 * WHERE IT LIVES (COMMON.md § Code Placement). Two entry points in two modules
 * now carry the same exposure — the CLI (`cli/buildFreshness.ts`, which wraps
 * this fact in a `CommandOutcome`) and the MCP bin (`mcp/main.ts`, which cannot
 * carry one: its stdout IS the protocol stream). A helper with consumers in two
 * modules moves up out of either, so the FACT sits here at `src/` and each entry
 * point owns only its own presentation. It borrows `packageDir()` and
 * `isInstalled()` from `paths.ts` rather than re-deriving either — a second
 * derivation is a second owner — and it takes the refusal EXIT CODE from
 * `cli/outcome.ts`, the module that owns the exit-code vocabulary, rather than
 * minting a second literal 3.
 *
 * That import is a real edge: `mcp/main.ts` → this module → `cli/outcome.ts`,
 * so `mcp/` DOES reach `cli/`, transitively. It is accepted deliberately rather
 * than unnoticed. `outcome.ts` owns the exit-code vocabulary and imports
 * nothing itself, so no cycle results and the dependency is one constant wide —
 * which is cheaper than a second spelling of the refusal code that could drift
 * from the one every other command exits with.
 *
 * WHEN IT NO-OPS, and why each case must:
 *   - running from `src/` (via `tsx`: `npm run gnosis`, `npm run setup`, and
 *     every vitest suite) — there is no build, so nothing can be stale. The
 *     decision is made from THIS MODULE'S OWN location, the only evidence that
 *     survives being copied anywhere;
 *   - running from an INSTALL (`paths.ts:isInstalled`) — an installed tree
 *     carries `dist/` with no `src/` beside it, so the comparison has no second
 *     operand and a consumer must never be refused;
 *   - anything unreadable — an fs failure means "cannot tell", and cannot-tell
 *     MUST let the command run, and MUST let the MCP server serve. A guard that
 *     refuses on its own malfunction is worse than the defect it guards.
 * Each no-op returns BEFORE any stat, so the walk costs nothing off the one
 * path it applies to.
 *
 * WHY `dist/cli/main.js` IS THE BUILD'S TIMESTAMP, and not the newest emitted
 * `.js`: the newest emitted file reads FRESH after a partial rebuild — recompile
 * one module by hand and the whole `dist/` claims that module's mtime. The CLI
 * entry point is written by `npm run build` (a full `tsc -p tsconfig.build.json`)
 * and by nothing else, so it dates the last COMPLETE build. One stat, no
 * directory walk. It dates the build for the MCP bin too: the same single `tsc`
 * emits both entry points, so either one dates the other.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_PARTIAL } from './cli/outcome.js';
import { isInstalled, packageDir } from './paths.js';

const BUILD_DIR = 'dist';
const SOURCE_DIR = 'src';
const SOURCE_EXT = '.ts';
const BUILD_ENTRY = join(BUILD_DIR, 'cli', 'main.js');

/**
 * Exit 3, not 2: the argv was fine. This is `EXIT_PARTIAL`'s "refused / state
 * mismatch" reading — the same one `index` uses when its digest disagrees with
 * the manifest's — and both entry points refuse with it, so an agent driving
 * either surface reads one code for one condition.
 */
export const STALE_BUILD_EXIT = EXIT_PARTIAL;

/** Where the RUNNING copy of this module sits, and the package it belongs to. */
export interface BuildSite {
  readonly moduleDir: string;
  readonly packageDir: string;
}

/** A file, the mtime it carries, and that mtime rendered once. */
export interface Stamped {
  readonly path: string;
  readonly mtimeMs: number;
  readonly iso: string;
}

/** The two operands of a verdict that came out STALE. */
export interface StaleBuild {
  readonly build: Stamped;
  readonly source: Stamped;
}

/** An fs failure is not a verdict — it is the absence of one. */
const attempt = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const stamped = (path: string, mtimeMs: number): Stamped => ({
  path,
  mtimeMs,
  iso: new Date(mtimeMs).toISOString(),
});

const stampedFile = (path: string): Stamped => stamped(path, statSync(path).mtimeMs);

const newer = (left: Stamped, right: Stamped): Stamped =>
  right.mtimeMs > left.mtimeMs ? right : left;

/**
 * The newest `.ts` anywhere under `src/`. An empty or unreadable tree yields an
 * mtime of 0, which loses every comparison — i.e. "cannot tell, so run".
 */
const newestSource = (sourceDir: string): Stamped | undefined =>
  attempt(() =>
    readdirSync(sourceDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(SOURCE_EXT))
      .map(entry => stampedFile(join(entry.parentPath, entry.name)))
      .reduce(newer, stamped(sourceDir, 0))
  );

/** Compiled and in a checkout — the only situation in which a build can be stale. */
const isCheckedOutBuild = (site: BuildSite): boolean =>
  `${site.moduleDir}${sep}`.startsWith(`${resolve(site.packageDir, BUILD_DIR)}${sep}`) &&
  !isInstalled(site.moduleDir);

const stampsFor = (site: BuildSite): StaleBuild | undefined => {
  const build = attempt(() => stampedFile(resolve(site.packageDir, BUILD_ENTRY)));
  const source = newestSource(resolve(site.packageDir, SOURCE_DIR));
  return build === undefined || source === undefined ? undefined : { build, source };
};

const runningSite = (): BuildSite => ({
  moduleDir: dirname(fileURLToPath(import.meta.url)),
  packageDir: packageDir(),
});

/** Absent stamps are "cannot tell", which is NOT stale. */
const isStale = (stamps: StaleBuild | undefined): stamps is StaleBuild =>
  stamps !== undefined && stamps.source.mtimeMs > stamps.build.mtimeMs;

/**
 * The staleness FACT: the two files and their mtimes when the running build is
 * older than its source, `undefined` when it is fresh, not compiled, installed,
 * or unreadable. `site` is a parameter so a test can point the check at a temp
 * fixture with authored mtimes instead of depending on the working tree's.
 */
export const staleBuild = (site: BuildSite = runningSite()): StaleBuild | undefined => {
  if (!isCheckedOutBuild(site)) return undefined;
  const stamps = stampsFor(site);
  return isStale(stamps) ? stamps : undefined;
};

/** The one wording both entry points print, so one condition reads one way. */
export const staleBuildMessage = (stale: StaleBuild): string =>
  [
    'Refusing to run: this compiled build is OLDER than src/, so it would serve behaviour the source has already changed.',
    `  build:      ${stale.build.path} (${stale.build.iso})`,
    `  newest src: ${stale.source.path} (${stale.source.iso})`,
    'Fix: run `npm run build` in packages/gnosis — or run from source, with `npm run gnosis` / `npm run setup`.',
  ].join('\n');

/** What a process needs to refuse: what to say, and what to exit with. */
export interface StaleBuildDiagnostic {
  readonly message: string;
  readonly exitCode: number;
}

/**
 * The refusal for an entry point that has no `CommandOutcome` to render — the
 * MCP bin, whose stdout is the protocol stream. Keeping the decision here keeps
 * `mcp/main.ts` a thin process binding and keeps this testable by direct call.
 */
export const staleBuildDiagnostic = (site?: BuildSite): StaleBuildDiagnostic | undefined => {
  const stale = staleBuild(site);
  return stale === undefined
    ? undefined
    : { message: staleBuildMessage(stale), exitCode: STALE_BUILD_EXIT };
};
