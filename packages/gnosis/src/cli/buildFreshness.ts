/**
 * Refuses to run a COMPILED build that is older than the source it was built
 * from — in a development checkout, and nowhere else.
 *
 * This is `GNOSIS-RULES.md` § The failure class in its cheapest form: a stale
 * `dist/` produces plausible output for behaviour `src/` has already changed,
 * and nothing anywhere says so. It really happened — a build from `0bfa1cf` was
 * run after `src/` had advanced two commits and produced three bug reports
 * about defects that were already fixed. The component was stale; the pipeline
 * recorded its output as data.
 *
 * WHERE IT LIVES (COMMON.md §II). `paths.ts` owns path RESOLUTION — "where does
 * X live" — and nothing else; it deliberately has no policy and no `Outcome`
 * vocabulary. This module owns a different single concern, "is the running
 * build fresh enough to trust", and it answers in the CLI's own currency, a
 * `CommandOutcome`. Folding it into `paths.ts` would give that module a second
 * responsibility AND a dependency on `cli/outcome.ts`, inverting the layer
 * direction. Its one consumer is `cli.ts`, so per COMMON.md § Code Placement it
 * sits beside it rather than in a shared lib; the remedies it prints are CLI
 * vocabulary too. It borrows `packageDir()` and `isInstalled()` from `paths.ts`
 * rather than re-deriving either — a second derivation is a second owner.
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
 *     MUST let the command run. A guard that refuses on its own malfunction is
 *     worse than the defect it guards.
 * Each no-op returns BEFORE any stat, so the walk costs nothing off the one
 * path it applies to.
 *
 * WHY `dist/cli/main.js` IS THE BUILD'S TIMESTAMP, and not the newest emitted
 * `.js`: the newest emitted file reads FRESH after a partial rebuild — recompile
 * one module by hand and the whole `dist/` claims that module's mtime. The CLI
 * entry point is written by `npm run build` (a full `tsc -p tsconfig.build.json`)
 * and by nothing else, so it dates the last COMPLETE build. It is also the file
 * actually being executed. One stat, no directory walk.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInstalled, packageDir } from '../paths.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_PARTIAL } from './outcome.js';

const BUILD_DIR = 'dist';
const SOURCE_DIR = 'src';
const SOURCE_EXT = '.ts';
const BUILD_ENTRY = join(BUILD_DIR, 'cli', 'main.js');

/** Where the RUNNING copy of this module sits, and the package it belongs to. */
export interface BuildSite {
  readonly moduleDir: string;
  readonly packageDir: string;
}

/** A file and the mtime it carries. */
interface Stamped {
  readonly path: string;
  readonly mtimeMs: number;
}

interface Stamps {
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

const stampedFile = (path: string): Stamped => ({ path, mtimeMs: statSync(path).mtimeMs });

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
      .reduce(newer, { path: sourceDir, mtimeMs: 0 })
  );

/** Compiled and in a checkout — the only situation in which a build can be stale. */
const isCheckedOutBuild = (site: BuildSite): boolean =>
  `${site.moduleDir}${sep}`.startsWith(`${resolve(site.packageDir, BUILD_DIR)}${sep}`) &&
  !isInstalled(site.moduleDir);

const stampsFor = (site: BuildSite): Stamps | undefined => {
  const build = attempt(() => stampedFile(resolve(site.packageDir, BUILD_ENTRY)));
  const source = newestSource(resolve(site.packageDir, SOURCE_DIR));
  return build === undefined || source === undefined ? undefined : { build, source };
};

const iso = (mtimeMs: number): string => new Date(mtimeMs).toISOString();

const messageFor = (stamps: Stamps): string =>
  [
    'Refusing to run: this compiled build is OLDER than src/, so it would serve behaviour the source has already changed.',
    `  build:      ${stamps.build.path} (${iso(stamps.build.mtimeMs)})`,
    `  newest src: ${stamps.source.path} (${iso(stamps.source.mtimeMs)})`,
    'Fix: run `npm run build` in packages/gnosis — or run from source, with `npm run gnosis` / `npm run setup`.',
  ].join('\n');

/**
 * Exit 3, not 2: the argv was fine. This is `EXIT_PARTIAL`'s "refused / state
 * mismatch" reading — the same one `index` uses when its digest disagrees with
 * the manifest's — and it reuses that vocabulary rather than minting a code no
 * caller has a rule for.
 */
const refusal = (stamps: Stamps): CommandOutcome => ({
  exitCode: EXIT_PARTIAL,
  data: {
    error: messageFor(stamps),
    build: stamps.build.path,
    buildMtime: iso(stamps.build.mtimeMs),
    newestSource: stamps.source.path,
    newestSourceMtime: iso(stamps.source.mtimeMs),
  },
  text: messageFor(stamps),
});

const runningSite = (): BuildSite => ({
  moduleDir: dirname(fileURLToPath(import.meta.url)),
  packageDir: packageDir(),
});

/** Absent stamps are "cannot tell", which is NOT stale. */
const isStale = (stamps: Stamps | undefined): stamps is Stamps =>
  stamps !== undefined && stamps.source.mtimeMs > stamps.build.mtimeMs;

/**
 * The refusal to serve a stale build, or `undefined` when the build is fresh,
 * not compiled, installed, or unreadable. `site` is a parameter so a test can
 * point the check at a temp fixture with authored mtimes instead of depending
 * on the working tree's.
 */
export const staleBuildRefusal = (site: BuildSite = runningSite()): CommandOutcome | undefined => {
  if (!isCheckedOutBuild(site)) return undefined;
  const stamps = stampsFor(site);
  return isStale(stamps) ? refusal(stamps) : undefined;
};
