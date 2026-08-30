/**
 * Where ONE instance's three artefacts live — profile, atoms directory, index —
 * and the two facts that decide whether a run may create them.
 *
 * The three paths travel together because they are one instance: a profile that
 * named an atoms directory another profile owns, or an index beside atoms it
 * never saw, is the shared-work-directory failure this repository polices. So
 * they are resolved once, as a unit, by {@link instancePaths}.
 *
 * The two protecting refusals are DETECTED here and PHRASED by the caller.
 * {@link existingInstance} finds a profile or an owner marker already on this
 * machine — overwriting either silently loses the work the owner has done in
 * the file `init` exists to start. {@link atomFileCount} counts the `*.md`
 * files an atoms directory already holds — adopting atoms this profile never
 * wrote makes the next `ingest` prune every one of them as an orphan. Both are
 * plain facts about the filesystem, so any caller — `init` or an interactive
 * setup — reads the same state and owes its reader the same refusal.
 *
 * {@link profileTemplate} lives here for the same reason: a writer carrying its
 * own profile literal would be a second owner of the profile schema, and the
 * next key added would land in only one of them.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { DECLARED_TYPES } from './config.js';
import { ATOMS_OWNER_FILE } from './ingest.js';
import { USER_PROFILE_NAME, userProfilePath } from './paths.js';
import type { PrfParams } from './prf.js';

/** A corpus directory whose basename yields no usable label still needs one. */
const FALLBACK_DOMAIN = 'notes';

/** An atom file, as `ingest` writes and `pruneOrphans` considers one. */
const MD_SUFFIX = '.md';

const NON_LABEL = /[^a-z0-9]+/g;

const EDGE_DASHES = /^-+|-+$/g;

/**
 * One domain per corpus directory, named after the directory. Declared, never
 * guessed at ingest time: the rule table below is what assigns `x_domain`, and
 * a source under no prefix is refused rather than labelled by inference.
 */
export const domainOf = (root: string): string => {
  const label = basename(root).toLowerCase().replace(NON_LABEL, '-').replace(EDGE_DASHES, '');
  return label.length > 0 ? label : FALLBACK_DOMAIN;
};

/** What both writers tell the owner about the file they may now edit. */
const PROFILE_EDITING_COMMENT =
  'Edit this file to shape your instance: add a domain to `domains` before any rule may name it, and claim a directory with a `domainRules` prefix. A source under no prefix is REFUSED, never guessed.';
/** The type a source no rule claims takes — one of {@link DECLARED_TYPES}. */
export const DEFAULT_TYPE = 'knowledge';

/** The types a `search` subtracts unless asked otherwise — a PRESENTATION default, never a corpus one: they stay ingested and indexed. */
export const DEFAULT_EXCLUDED_TYPES: readonly string[] = ['feature-log', 'benchmark', 'review', 'brainstorm'];

/** One corpus root as the profile records it: what it is called, and what claims it. */
export interface ProfileRoot {
  /** Written to `corpusRoots`, in the form the caller was given it. */
  readonly path: string;
  /** The source IDENTITY a `domainRules` entry matches on — resolved by the caller. */
  readonly prefix: string;
  readonly domain: string;
}

/**
 * Everything a profile template needs that its writer decides. The four
 * optional keys are OMITTED when absent rather than written empty: a profile
 * key present with a null-ish value is a claim the loader would have to read.
 */
export interface ProfileTemplate {
  readonly roots: readonly ProfileRoot[];
  readonly repoRoot: string;
  readonly atomsDir: string;
  readonly indexPath: string;
  readonly defaultType: string;
  readonly excludedTypes: readonly string[];
  readonly defaultAnalyzer?: string | undefined;
  readonly excludePaths?: readonly string[] | undefined;
  readonly defaultPrf?: PrfParams | undefined;
  readonly rerankPoolK?: number | undefined;
}

const optionalKey = <T>(key: string, value: T | undefined): Readonly<Record<string, T>> =>
  value === undefined ? {} : { [key]: value };

/**
 * The ONE profile template. Both writers — `init` and the wizard — serialise
 * this shape, because a second template would be a second owner of the profile
 * schema, and the next key added would land in only one of them.
 */
export const profileTemplate = (
  template: ProfileTemplate
): Readonly<Record<string, unknown>> => ({
  'comment:editing': PROFILE_EDITING_COMMENT,
  name: USER_PROFILE_NAME,
  domains: [...new Set(template.roots.map(root => root.domain))],
  types: DECLARED_TYPES,
  defaultType: template.defaultType,
  domainRules: template.roots.map(root => ({ prefix: root.prefix, domain: root.domain })),
  typeRules: [],
  segmentRules: [],
  repoRoot: template.repoRoot,
  corpusRoots: template.roots.map(root => root.path),
  atomsDir: template.atomsDir,
  indexPath: template.indexPath,
  ...optionalKey('defaultAnalyzer', template.defaultAnalyzer),
  ...optionalKey('defaultPrf', template.defaultPrf),
  defaultExcludedTypes: template.excludedTypes,
  ...optionalKey('excludePaths', template.excludePaths),
  ...optionalKey('rerankPoolK', template.rerankPoolK),
});

/** Where the three artefacts of one instance live, resolved once per run. */
export interface InstancePaths {
  readonly profilePath: string;
  readonly atomsPath: string;
  readonly indexPath: string;
  readonly ownerPath: string;
}

export const instancePaths = (atomsDir: string, indexPath: string): InstancePaths => ({
  profilePath: userProfilePath(),
  atomsPath: atomsDir,
  indexPath,
  ownerPath: join(atomsDir, ATOMS_OWNER_FILE),
});

export const existingInstance = (paths: InstancePaths): string | undefined => {
  if (existsSync(paths.profilePath)) return paths.profilePath;
  return existsSync(paths.ownerPath) ? paths.ownerPath : undefined;
};

/** How many atom files the resolved atoms directory already holds. */
export const atomFileCount = (atomsPath: string): number =>
  existsSync(atomsPath)
    ? readdirSync(atomsPath).filter(name => name.endsWith(MD_SUFFIX)).length
    : 0;

export const writeInstance = (
  paths: InstancePaths,
  profile: Readonly<Record<string, unknown>>
): void => {
  mkdirSync(dirname(paths.profilePath), { recursive: true });
  mkdirSync(paths.atomsPath, { recursive: true });
  mkdirSync(dirname(paths.indexPath), { recursive: true });
  writeFileSync(paths.profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
};
