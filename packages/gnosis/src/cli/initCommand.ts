/**
 * `init` — the first-run command: create the directories this machine's data
 * root implies, and write a profile the owner can then EDIT.
 *
 * Four rules shape it.
 *
 * It takes the corpus directories as POSITIONALS and refuses when given none.
 * Writing a profile with no corpus scope would produce an instance whose first
 * `ingest` walks nothing and whose first `retrieve` answers nothing — a
 * component that produced nothing, recorded as data, on the very first run.
 *
 * It REFUSES a second run rather than overwriting. The profile is the file the
 * owner edits (domains, rules, exclusions), so re-writing it from a template is
 * a silent loss of exactly the work `init` exists to start.
 *
 * It writes NO owner marker, and REFUSES an atoms directory that already holds
 * `*.md` files. The marker means "this profile wrote these atoms"; ownership is
 * earned by writing them, and `ingest.ts:claimOutputDir` adopts an unmarked
 * directory on the first real ingest. An `init` that marked the directory while
 * writing zero atoms claimed atoms it had never seen — and the next `ingest`
 * then pruned them as orphans, destroying a corpus `init` had exited 0 over.
 *
 * It ends by naming `ingest` THEN `index`, spelled through `invocation.ts`.
 * They are one operation in two commands and the second is the forgotten half:
 * an ingest alone leaves the index carrying the old digest and every later query
 * refuses.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { DECLARED_TYPES } from '../config.js';
import { expandUserPath } from '../env.js';
import { ATOMS_OWNER_FILE } from '../ingest.js';
import { cliInvocation } from '../invocation.js';
import { dataRoot, USER_PROFILE_NAME, userProfilePath } from '../paths.js';
import { DEFAULT_ADAPTER } from './adapter.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import { REPO_ROOT_FLAG } from './locations.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

/** The type a source no rule claims takes — one of {@link DECLARED_TYPES}. */
const DEFAULT_TYPE = 'knowledge';

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
const domainOf = (root: string): string => {
  const label = basename(root).toLowerCase().replace(NON_LABEL, '-').replace(EDGE_DASHES, '');
  return label.length > 0 ? label : FALLBACK_DOMAIN;
};

/** What `init` serialises. Plain data — the loader is what validates it. */
const profileFor = (
  roots: readonly string[],
  paths: InstancePaths,
  repoRoot: string
): Readonly<Record<string, unknown>> => ({
  'comment:editing': 'Edit this file to shape your instance: add a domain to `domains` before any rule may name it, and claim a directory with a `domainRules` prefix. A source under no prefix is REFUSED, never guessed.',
  name: USER_PROFILE_NAME,
  domains: [...new Set(roots.map(domainOf))],
  types: DECLARED_TYPES,
  defaultType: DEFAULT_TYPE,
  domainRules: roots.map(root => ({ prefix: root, domain: domainOf(root) })),
  typeRules: [],
  segmentRules: [],
  repoRoot,
  corpusRoots: roots,
  atomsDir: paths.atomsPath,
  indexPath: paths.indexPath,
});

/** The corpus roots this run was given, each expanded exactly as ingest expands one. */
type RootsResult =
  | { readonly ok: true; readonly roots: readonly string[] }
  | { readonly ok: false; readonly error: string };

const NO_ROOTS_ERROR = (): string =>
  `init takes at least one corpus directory — the documents this instance searches; run \`${cliInvocation()} init <dir> [dir…]\``;

/**
 * A relative directory is REFUSED by name rather than resolved against the
 * shell's working directory, matching `env.ts:requireAbsolute`: a corpus scope
 * that moves with the caller's terminal is a different vault per terminal.
 */
const relativeRootError = (root: string): string =>
  `init: corpus directory "${root}" is relative — write it as an absolute path (or start it with ~/), so the scope cannot move with the shell`;

const resolveRoots = (positionals: readonly string[]): RootsResult => {
  if (positionals.length === 0) return { ok: false, error: NO_ROOTS_ERROR() };
  const roots = positionals.map(expandUserPath);
  const offender = roots.find(root => !isAbsolute(root));
  return offender === undefined
    ? { ok: true, roots }
    : { ok: false, error: relativeRootError(offender) };
};

/** Where the three artefacts of one instance live, resolved once per run. */
interface InstancePaths {
  readonly profilePath: string;
  readonly atomsPath: string;
  readonly indexPath: string;
  readonly ownerPath: string;
}

const instancePaths = (context: CommandContext): InstancePaths => ({
  profilePath: userProfilePath(),
  atomsPath: context.atomsDir,
  indexPath: context.indexPath,
  ownerPath: join(context.atomsDir, ATOMS_OWNER_FILE),
});

/**
 * The base a RELATIVE corpus root and `summarySidecar` resolve against. Read
 * off the FLAG rather than the resolved context: with no flag the context still
 * falls back to the frozen `REPO_ROOT`, which an installed package resolves
 * inside `node_modules`, while an instance's own base is its data root.
 */
const initRepoRoot = (context: CommandContext): string =>
  stringFlag(context.flags, REPO_ROOT_FLAG) ?? dataRoot();

const existingInstance = (paths: InstancePaths): string | undefined => {
  if (existsSync(paths.profilePath)) return paths.profilePath;
  return existsSync(paths.ownerPath) ? paths.ownerPath : undefined;
};

/**
 * PARTIAL, not usage: the argv was well formed and nothing was written — what
 * stopped the run is the STATE of this machine, which is exactly what exit 3
 * says.
 */
const refuseExisting = (found: string): CommandOutcome => {
  const message = `init: this instance already exists — ${found} is present, and init MUST NOT overwrite a profile you have edited; edit it in place, or point DP_GNOSIS_DATA_HOME at a new root`;
  return { exitCode: EXIT_PARTIAL, data: { command: 'init', error: message }, text: message };
};

/** How many atom files the resolved atoms directory already holds. */
const atomFileCount = (atomsPath: string): number =>
  existsSync(atomsPath)
    ? readdirSync(atomsPath).filter(name => name.endsWith(MD_SUFFIX)).length
    : 0;

/**
 * Same exit as the sibling refusal, and for the same reason: the argv was well
 * formed, nothing was written, and what stopped the run is the STATE of this
 * machine. Naming the count is what makes the refusal actionable — the reader
 * has to know something is there before choosing another root.
 */
const refuseOccupied = (atomsPath: string, atoms: number): CommandOutcome => {
  const message = `init: ${atomsPath} already holds ${atoms} atom file${atoms === 1 ? '' : 's'} (*.md), and init MUST NOT adopt atoms it did not write — the next ingest would prune every one of them as an orphan; point DP_GNOSIS_DATA_HOME at a new root, or ingest with the profile that wrote them`;
  return { exitCode: EXIT_PARTIAL, data: { command: 'init', error: message }, text: message };
};

const writeInstance = (
  paths: InstancePaths,
  roots: readonly string[],
  repoRoot: string
): void => {
  mkdirSync(dirname(paths.profilePath), { recursive: true });
  mkdirSync(paths.atomsPath, { recursive: true });
  mkdirSync(dirname(paths.indexPath), { recursive: true });
  writeFileSync(
    paths.profilePath,
    `${JSON.stringify(profileFor(roots, paths, repoRoot), null, 2)}\n`,
    'utf8'
  );
};

const nextSteps = (profilePath: string): readonly string[] => [
  'Next, in this order — they are ONE operation in two commands, and the second is the forgotten half:',
  `  1. ${cliInvocation()} ingest --profile ${profilePath}`,
  `  2. ${cliInvocation()} index --adapter ${DEFAULT_ADAPTER} --profile ${profilePath}`,
  `  then check it: ${cliInvocation()} doctor --profile ${profilePath}`,
];

const initText = (paths: InstancePaths, roots: readonly string[]): string =>
  [
    `init: created an instance named "${USER_PROFILE_NAME}"`,
    `  profile   ${paths.profilePath}  (edit it — it decides what is ingested and how it is labelled)`,
    `  atoms     ${paths.atomsPath}`,
    `  index     ${paths.indexPath}`,
    `  corpus    ${roots.join(', ')}`,
    '',
    ...nextSteps(paths.profilePath),
  ].join('\n');

const created = (paths: InstancePaths, roots: readonly string[]): CommandOutcome => ({
  exitCode: EXIT_OK,
  data: {
    command: 'init',
    profilePath: paths.profilePath,
    atomsDir: paths.atomsPath,
    indexPath: paths.indexPath,
    corpusRoots: roots,
    next: nextSteps(paths.profilePath),
  },
  text: initText(paths, roots),
});

const initialise = (context: CommandContext, roots: readonly string[]): CommandOutcome => {
  const paths = instancePaths(context);
  const found = existingInstance(paths);
  if (found !== undefined) return refuseExisting(found);
  const atoms = atomFileCount(paths.atomsPath);
  if (atoms > 0) return refuseOccupied(paths.atomsPath, atoms);
  writeInstance(paths, roots, initRepoRoot(context));
  return created(paths, roots);
};

export const runInitCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const roots = resolveRoots(context.positionals);
  return roots.ok ? initialise(context, roots.roots) : usageError(roots.error);
};
