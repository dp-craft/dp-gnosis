/**
 * Extract every in-source `<!-- LLM-PRIMARY: … -->` comment into the SUMMARY
 * SIDECAR — the `source path → summary` table ingest resolves a document's
 * summary from when the document itself declares none.
 *
 * It READS the corpus and writes exactly one file: the sidecar. It removes
 * nothing from a source document; comment removal is a separate, owner-owned
 * decision, and doing it here would make an extraction run unrepeatable.
 *
 * The scope is not restated: the walk goes through `loadCorpus`, the same
 * function ingest walks with, so the two commands cannot read different
 * corpora. The extraction is `documentSummary` from `ingest.ts` for the same
 * reason — two regexes for one convention drift.
 *
 *   npx tsx tools/dp-gnosis/scripts/extract-summaries.ts --dry-run
 *
 * Exit codes: 0 written (or reported under `--dry-run`) · 2 usage error.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INGEST_PROFILE, resolveCorpusRoots } from '../src/config.js';
import { documentSummary, loadCorpus } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { PROFILES_DIR, REPO_ROOT } from '../src/paths.js';
import { serializeSummarySidecar } from '../src/summarySidecar.js';

const EXIT_USAGE = 2;
const PROFILE_SUFFIX = '.profile.json';

const USAGE = `extract-summaries — write the LLM-PRIMARY comments of the corpus into the summary sidecar
  --profile <name>   profile name (or path to a profile file); default the shipped one
  --out <path>       sidecar destination; default the profile's summarySidecar
  --dry-run          report counts, write nothing
  --help             this text
exit 0 ok · 2 unusable invocation
`;

/** Everything one extraction run needs; the profile carries its own corpus scope. */
export interface ExtractOptions {
  readonly profile: IngestProfile;
  readonly outPath: string;
  readonly dryRun: boolean;
}

/** What the run saw. `missing` is named, not counted, so a gap is actionable. */
export interface ExtractReport {
  readonly scanned: number;
  readonly found: number;
  readonly missing: readonly string[];
  readonly outPath: string;
  readonly dryRun: boolean;
}

interface Extracted {
  readonly sourcePath: string;
  readonly summary: string | undefined;
}

const summariesOf = (extracted: readonly Extracted[]): ReadonlyMap<string, string> =>
  new Map(
    extracted
      .filter((entry): entry is Extracted & { readonly summary: string } => entry.summary !== undefined)
      .map(entry => [entry.sourcePath, entry.summary])
  );

/**
 * The destination's parent is CREATED, not assumed: the sidecar a profile
 * declares lives in its own directory, and a first run over a fresh checkout
 * would otherwise die on ENOENT with nothing written. Never reached under
 * `dryRun`, which must leave the tree exactly as it found it.
 */
const writeSidecar = async (outPath: string, summaries: ReadonlyMap<string, string>): Promise<void> => {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeSummarySidecar(summaries), 'utf8');
};

/**
 * Walk the profile's corpus, extract, write. Under `dryRun` nothing is written
 * at all — the report is the whole output, so a run can be inspected before it
 * touches a tracked file.
 */
export const runExtract = async (options: ExtractOptions): Promise<ExtractReport> => {
  const repoRoot = options.profile.repoRoot ?? REPO_ROOT;
  const roots = resolveCorpusRoots(process.env, options.profile.corpusRoots);
  const loaded = await loadCorpus(repoRoot, roots, options.profile);
  const extracted = loaded.map(
    (source): Extracted => ({ sourcePath: source.sourcePath, summary: documentSummary(source.text) })
  );
  const summaries = summariesOf(extracted);
  if (!options.dryRun) await writeSidecar(options.outPath, summaries);
  return {
    scanned: extracted.length,
    found: summaries.size,
    missing: extracted.filter(entry => entry.summary === undefined).map(entry => entry.sourcePath),
    outPath: options.outPath,
    dryRun: options.dryRun,
  };
};

/* ---------------------------------------------------------------------- cli */

interface ArgState {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly pending: string | undefined;
  readonly error: string | undefined;
}

const VALUE_FLAGS = ['profile', 'out'] as const;
const BOOLEAN_FLAGS = ['dry-run', 'help'] as const;

const EMPTY_ARGS: ArgState = {
  values: new Map(),
  flags: new Set(),
  pending: undefined,
  error: undefined,
};

const startFlag = (state: ArgState, token: string): ArgState => {
  const name = token.slice(2);
  if (VALUE_FLAGS.some(flag => flag === name)) return { ...state, pending: name };
  if (BOOLEAN_FLAGS.some(flag => flag === name)) {
    return { ...state, flags: new Set([...state.flags, name]) };
  }
  return { ...state, error: `unknown flag: ${token}` };
};

const takeToken = (state: ArgState, token: string): ArgState => {
  if (state.pending !== undefined) {
    return { ...state, values: new Map([...state.values, [state.pending, token]]), pending: undefined };
  }
  return token.startsWith('--')
    ? startFlag(state, token)
    : { ...state, error: `unexpected argument: ${token}` };
};

const stepToken = (state: ArgState, token: string): ArgState =>
  state.error === undefined ? takeToken(state, token) : state;

const parseArgs = (argv: readonly string[]): ArgState => {
  const state = argv.reduce(stepToken, EMPTY_ARGS);
  return state.pending === undefined
    ? state
    : { ...state, error: `--${state.pending} requires a value` };
};

/**
 * A bare NAME resolves inside the shipped `profiles/` directory; anything
 * carrying a separator or a `.json` suffix is taken as a path, which is what the
 * CLI's own `--profile` accepts. One flag, both spellings, no guessing.
 */
const profilePath = (value: string): string =>
  value.includes('/') || value.endsWith('.json')
    ? resolve(value)
    : join(PROFILES_DIR, `${value}${PROFILE_SUFFIX}`);

const profileOf = (state: ArgState): IngestProfile => {
  const value = state.values.get('profile');
  return value === undefined ? DEFAULT_INGEST_PROFILE : loadIngestProfile(profilePath(value));
};

/** The sidecar the profile names, resolved against the effective repo root. */
const declaredOut = (profile: IngestProfile): string | undefined =>
  profile.summarySidecar === undefined
    ? undefined
    : join(profile.repoRoot ?? REPO_ROOT, profile.summarySidecar);

const outOf = (state: ArgState, profile: IngestProfile): string | undefined => {
  const flag = state.values.get('out');
  if (flag === undefined) return declaredOut(profile);
  return isAbsolute(flag) ? flag : resolve(flag);
};

const printReport = (report: ExtractReport): void => {
  process.stdout.write(
    `scanned ${report.scanned} found ${report.found} without-comment ${report.missing.length} out ${report.outPath}${report.dryRun ? ' (dry-run, nothing written)' : ''}\n`
  );
};

const usageExit = (message: string): number => {
  process.stderr.write(`extract-summaries: ${message}\n${USAGE}`);
  return EXIT_USAGE;
};

const runFor = async (state: ArgState, profile: IngestProfile): Promise<number> => {
  const outPath = outOf(state, profile);
  if (outPath === undefined) {
    return usageExit(`profile "${profile.name}" declares no summarySidecar — pass --out <path>`);
  }
  printReport(await runExtract({ profile, outPath, dryRun: state.flags.has('dry-run') }));
  return 0;
};

/** A malformed profile or an unreadable sidecar destination is a USAGE error, not a crash. */
const attempt = async (state: ArgState): Promise<number> => {
  try {
    return await runFor(state, profileOf(state));
  } catch (error) {
    return usageExit(error instanceof Error ? error.message : String(error));
  }
};

const main = async (argv: readonly string[]): Promise<number> => {
  const state = parseArgs(argv);
  if (state.error !== undefined) return usageExit(state.error);
  if (state.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  return await attempt(state);
};

const entry = process.argv[1];
const isMain = entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
