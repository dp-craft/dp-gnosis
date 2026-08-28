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
import { CORPUS_ROOTS_ENV_VAR, resolveCorpusRoots } from '../config.js';
import type { IngestProfile } from '../ingestProfile.js';
import { atomsDir, REPO_ROOT } from '../paths.js';
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

/** Which tier supplied a resolved location — the precedence rule, made readable. */
export type LocationOrigin = 'flag' | 'env' | 'profile' | 'default';

/**
 * The PROFILE field each knob is stated as. A union rather than four loose
 * strings: a diagnostic filters on these names, and a typo in that filter reads
 * as "this knob never qualifies" — a check that silently stops checking.
 */
export type LocationProfileKey = 'atomsDir' | 'indexPath' | 'repoRoot' | 'corpusRoots';

/**
 * One resolved knob, WITH the statement it came from and the profile statement
 * it beat. The second field is what makes a silent precedence loss reportable:
 * a value alone cannot say that a profile declared something else.
 */
export interface LocationFact {
  readonly knob: string;
  /** The PROFILE field name for the same knob — what a profile actually states. */
  readonly profileKey: LocationProfileKey;
  readonly value: string;
  readonly origin: LocationOrigin;
  /** What the profile declared for this knob, whether or not it won. */
  readonly declared: string | undefined;
}

const originOf = (flag: string | undefined, declared: string | undefined): LocationOrigin =>
  flag !== undefined ? 'flag' : declared !== undefined ? 'profile' : 'default';

/** Every statement about one path knob, before precedence is read off them. */
interface PathKnob {
  readonly knob: string;
  readonly profileKey: LocationProfileKey;
  readonly flag: string | undefined;
  readonly declared: string | undefined;
  readonly value: string;
}

const pathFact = (knob: PathKnob): LocationFact => ({
  knob: knob.knob,
  profileKey: knob.profileKey,
  value: knob.value,
  origin: originOf(knob.flag, knob.declared),
  declared: knob.declared,
});

/** No fallback at all, so a non-empty result proves the ENVIRONMENT stated one. */
const NO_ROOTS: readonly string[] = [];

const corpusOrigin = (
  env: NodeJS.ProcessEnv,
  declared: readonly string[] | undefined
): LocationOrigin =>
  resolveCorpusRoots(env, NO_ROOTS).length > 0
    ? 'env'
    : declared !== undefined
      ? 'profile'
      : 'default';

const ROOT_LIST_SEPARATOR = ', ';

/**
 * The same four knobs {@link resolveLocations} produces, each labelled with the
 * tier that supplied it. Stated HERE, beside the precedence rule itself, so a
 * diagnostic reports the order the CLI actually applies rather than a second
 * reading of it.
 */
export const locationOrigins = (
  flags: FlagValues,
  profile: IngestProfile,
  locations: ResolvedLocations,
  env: NodeJS.ProcessEnv = process.env
): readonly LocationFact[] => [
  pathFact({
    knob: ATOMS_DIR_FLAG,
    profileKey: 'atomsDir',
    flag: stringFlag(flags, ATOMS_DIR_FLAG),
    declared: profile.atomsDir,
    value: locations.atomsDir,
  }),
  pathFact({
    knob: INDEX_PATH_FLAG,
    profileKey: 'indexPath',
    flag: stringFlag(flags, INDEX_PATH_FLAG),
    declared: profile.indexPath,
    value: locations.indexPath,
  }),
  pathFact({
    knob: REPO_ROOT_FLAG,
    profileKey: 'repoRoot',
    flag: stringFlag(flags, REPO_ROOT_FLAG),
    declared: profile.repoRoot,
    value: locations.repoRoot,
  }),
  {
    knob: CORPUS_ROOTS_ENV_VAR,
    profileKey: 'corpusRoots',
    value: locations.corpusRoots.join(ROOT_LIST_SEPARATOR),
    origin: corpusOrigin(env, profile.corpusRoots),
    declared: profile.corpusRoots?.join(ROOT_LIST_SEPARATOR),
  },
];

export const resolveLocations = (
  flags: FlagValues,
  adapter: AdapterName,
  profile: IngestProfile
): ResolvedLocations => ({
  atomsDir: pick(stringFlag(flags, ATOMS_DIR_FLAG), profile.atomsDir, atomsDir()),
  indexPath: pick(stringFlag(flags, INDEX_PATH_FLAG), profile.indexPath, defaultIndexPath(adapter)),
  repoRoot: pick(stringFlag(flags, REPO_ROOT_FLAG), profile.repoRoot, REPO_ROOT),
  corpusRoots: resolveCorpusRoots(process.env, profile.corpusRoots),
});
