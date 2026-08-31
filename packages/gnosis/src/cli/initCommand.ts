/**
 * `init` — the first-run command: create the directories this machine's data
 * root implies, and write a profile the owner can then EDIT.
 *
 * Four rules shape it.
 *
 * It takes the corpus directories as POSITIONALS and refuses when given none.
 * Writing a profile with no corpus scope would produce an instance whose first
 * `ingest` walks nothing and whose first `search` answers nothing — a
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
import { isAbsolute } from 'node:path';

import { expandUserPath } from '../env.js';
import { sourceIdentity } from '../ingest.js';
import type { InstancePaths } from '../instance.js';
import {
  atomFileCount,
  DEFAULT_EXCLUDED_TYPES,
  DEFAULT_TYPE,
  domainOf,
  existingInstance,
  instancePaths,
  profileTemplate,
  writeInstance
} from '../instance.js';
import { cliInvocation } from '../invocation.js';
import { dataRoot, USER_PROFILE_NAME } from '../paths.js';
import { SERVED_PRF_PARAMS } from '../prf.js';
import { DEFAULT_ADAPTER } from './adapter.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import { REPO_ROOT_FLAG } from './locations.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

/** What `init` serialises. Plain data — the loader is what validates it. */
const profileFor = (
  roots: readonly string[],
  paths: InstancePaths,
  repoRoot: string
): Readonly<Record<string, unknown>> =>
  profileTemplate({
    roots: roots.map(root => ({ path: root, prefix: sourceIdentity(repoRoot, root), domain: domainOf(root) })),
    repoRoot,
    atomsDir: paths.atomsPath,
    indexPath: paths.indexPath,
    defaultType: DEFAULT_TYPE,
    excludedTypes: DEFAULT_EXCLUDED_TYPES,
    defaultPrf: SERVED_PRF_PARAMS,
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

/**
 * The base a RELATIVE corpus root and `summarySidecar` resolve against. Read
 * off the FLAG rather than the resolved context: with no flag the context still
 * falls back to the frozen `REPO_ROOT`, which an installed package resolves
 * inside `node_modules`, while an instance's own base is its data root.
 */
const initRepoRoot = (context: CommandContext): string =>
  stringFlag(context.flags, REPO_ROOT_FLAG) ?? dataRoot();

/**
 * PARTIAL, not usage: the argv was well formed and nothing was written — what
 * stopped the run is the STATE of this machine, which is exactly what exit 3
 * says.
 */
const refuseExisting = (found: string): CommandOutcome => {
  const message = `init: this instance already exists — ${found} is present, and init MUST NOT overwrite a profile you have edited; edit it in place, or point DP_GNOSIS_DATA_HOME at a new root`;
  return { exitCode: EXIT_PARTIAL, data: { command: 'init', error: message }, text: message };
};

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
  const paths = instancePaths(context.atomsDir, context.indexPath);
  const found = existingInstance(paths);
  if (found !== undefined) return refuseExisting(found);
  const atoms = atomFileCount(paths.atomsPath);
  if (atoms > 0) return refuseOccupied(paths.atomsPath, atoms);
  writeInstance(paths, profileFor(roots, paths, initRepoRoot(context)));
  return created(paths, roots);
};

export const runInitCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const roots = resolveRoots(context.positionals);
  return roots.ok ? initialise(context, roots.roots) : usageError(roots.error);
};
