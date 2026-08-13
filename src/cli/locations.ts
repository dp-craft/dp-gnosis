/**
 * The ONE place the four location knobs are resolved, and the ONE place the
 * precedence rule is stated: FLAG > PROFILE > DEFAULT.
 *
 * That order is what keeps every existing call site working untouched. A caller
 * that passes no `--profile` reads the shipped profile, which declares no
 * location at all, so all four fall through to the built-in defaults — the exact
 * values the CLI used before profiles carried locations. A caller that passes
 * both a profile and a flag gets the flag, because an argument typed on the
 * command line is the more specific statement of intent.
 *
 * `corpusRoots` has no flag of its own; its explicit override is the
 * `DP_GNOSIS_CORPUS_ROOTS` environment variable, which `resolveCorpusRoots`
 * ranks above the fallback handed to it. So the same three tiers apply there.
 */
import { resolveCorpusRoots } from '../config.js';
import type { IngestProfile } from '../ingestProfile.js';
import { ATOMS_DIR, REPO_ROOT } from '../paths.js';
import type { AdapterName } from './adapter.js';
import { defaultIndexPath } from './adapter.js';
import type { FlagValues } from './args.js';
import { stringFlag } from './args.js';

/** Where one invocation reads its corpus and writes its atoms and index. */
export interface ResolvedLocations {
  readonly atomsDir: string;
  readonly indexPath: string;
  readonly repoRoot: string;
  readonly corpusRoots: readonly string[];
}

export const ATOMS_DIR_FLAG = '--atoms-dir';
export const INDEX_PATH_FLAG = '--index-path';
export const REPO_ROOT_FLAG = '--repo-root';

/** The precedence rule itself, stated once and applied to every path knob. */
const pick = (
  flag: string | undefined,
  declared: string | undefined,
  fallback: string
): string => flag ?? declared ?? fallback;

export const resolveLocations = (
  flags: FlagValues,
  adapter: AdapterName,
  profile: IngestProfile
): ResolvedLocations => ({
  atomsDir: pick(stringFlag(flags, ATOMS_DIR_FLAG), profile.atomsDir, ATOMS_DIR),
  indexPath: pick(stringFlag(flags, INDEX_PATH_FLAG), profile.indexPath, defaultIndexPath(adapter)),
  repoRoot: pick(stringFlag(flags, REPO_ROOT_FLAG), profile.repoRoot, REPO_ROOT),
  corpusRoots: resolveCorpusRoots(process.env, profile.corpusRoots),
});
