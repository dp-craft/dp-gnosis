/**
 * `doctor` — one read-only pass over an instance, naming every state that is
 * otherwise QUIET.
 *
 * It REPORTS and it REPAIRS NOTHING. That is the whole contract: the states
 * worth finding here (a stale index that answers as `ready`, an atoms directory
 * another profile owns, a domain whose files all failed to parse) are states a
 * repair would erase before anyone could read them — and a "read-only" audit
 * that re-ran a production stage has already destroyed a corpus in this project
 * once. Nothing below opens a writable handle or creates a path.
 *
 * It also does not change how anything is SERVED. The stamped-digest-with-absent
 * manifest state is reported as a fault here while `fts5Adapter`'s refusal chain
 * keeps serving it exactly as it did — narrowing that chain is a separate,
 * separately-approvable change.
 *
 * Every remedy string comes from `invocation.ts`, so a refusal names a command
 * THIS caller can actually run rather than a repo script an installed user has
 * no access to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import type { IndexStamp } from '../adapters/fts5Adapter.js';
import { carriedAnalyzer, INDEX_SCHEMA_VERSION, readIndexStamp } from '../adapters/fts5Adapter.js';
import { lanceDbAvailability } from '../adapters/lanceDbAdapter.js';
import { miniSearchAvailability } from '../adapters/miniSearchAdapter.js';
import type { SourceIdentity } from '../corpusManifest.js';
import {
  manifestPathFor,
  readManifestDigest,
  readManifestSourceIdentity,
  sourceIdentityOf,
} from '../corpusManifest.js';
import { DECLARED_TYPES, foreignVocabularyMessage, foreignVocabularyValue } from '../config.js';
import { DP_GNOSIS_HOME_VARS, configHome, statedVar } from '../env.js';
import { ATOMS_OWNER_FILE, loadCorpus } from '../ingest.js';
import { ingestCommand, indexRebuildCommand } from '../invocation.js';
import { dataRoot } from '../paths.js';
import { loadUserConfig } from '../userConfig.js';
import type { AdapterName } from './adapter.js';
import { hasPersistentIndex } from './adapter.js';
import type { CommandContext } from './context.js';
import { atomsCensus, droppedDomains } from './domainCensus.js';
import type { LocationFact } from './locations.js';
import { locationOrigins } from './locations.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL } from './outcome.js';

/**
 * `fault` is a state that answers wrongly or not at all; `warn` is a state that
 * answers as its author asked but NOT as they may have believed — a precedence
 * loss. `unknown` is a check that could not RUN: the evidence it compares was
 * never recorded, or cannot be read. Only a fault moves the exit code, because
 * a warn is a fact about the configuration, not a defect in it — and an
 * `unknown` reported as either would be exactly the failure this project
 * exists to police, a component that produced nothing recorded as data.
 */
export type CheckStatus = 'ok' | 'warn' | 'fault' | 'unknown';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/**
 * The corpus as it stands on disk RIGHT NOW, or the reason it could not be
 * walked. A corpus root that matches nothing makes `loadCorpus` refuse, and
 * that refusal is this check being unavailable — not a corpus that drifted.
 */
type SourceScan =
  | { readonly ok: true; readonly identity: SourceIdentity }
  | { readonly ok: false; readonly reason: string };

/** Whether the selected adapter's optional dependency actually loaded. */
interface AdapterAvailability {
  readonly available: boolean;
  readonly reason?: string | undefined;
}

/** Everything read from disk and the environment, gathered ONCE at the boundary. */
interface DoctorFacts {
  readonly context: CommandContext;
  readonly locations: readonly LocationFact[];
  readonly manifestPath: string;
  readonly manifestDigest: string | undefined;
  /** The source identity the last ingest RECORDED; `undefined` on a manifest predating it. */
  readonly manifestSources: SourceIdentity | undefined;
  /** The source identity recomputed NOW, over the scope ingest itself walks. */
  readonly sources: SourceScan;
  readonly indexExists: boolean;
  /** The three identity keys, or `undefined` when no readable index carries them. */
  readonly stamp: IndexStamp | undefined;
  readonly owner: string | undefined;
  readonly dropped: readonly string[];
  readonly availability: AdapterAvailability;
  readonly env: NodeJS.ProcessEnv;
}

const ALWAYS_AVAILABLE = async (): Promise<AdapterAvailability> => ({ available: true });

/**
 * Total over the vocabulary, so a new adapter cannot be added without stating
 * how its availability is probed — an unprobed one would report as healthy.
 */
const AVAILABILITY_PROBES: Readonly<Record<AdapterName, () => Promise<AdapterAvailability>>> = {
  linear: ALWAYS_AVAILABLE,
  fts5: ALWAYS_AVAILABLE,
  minisearch: miniSearchAvailability,
  lancedb: lanceDbAvailability,
  'lancedb-vec': lanceDbAvailability,
  'lancedb-hybrid': lanceDbAvailability,
  'lancedb-hybrid-full': lanceDbAvailability,
};

/** An unreadable or non-fts5 index states no stamp — never a defaulted one. */
const stampOf = (context: CommandContext): IndexStamp | undefined => {
  if (context.adapter !== 'fts5' || !existsSync(context.indexPath)) return undefined;
  try {
    return readIndexStamp(context.indexPath);
  } catch {
    return undefined;
  }
};

const ownerOf = (atomsDir: string): string | undefined => {
  try {
    const owner = readFileSync(join(atomsDir, ATOMS_OWNER_FILE), 'utf8').trim();
    return owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Walked through `loadCorpus` and never through a second hand-rolled walk: the
 * comparison is only worth anything if `doctor` reads EXACTLY the scope ingest
 * reads — the same `corpusRoots`, `excludePaths` and source identities. A
 * private walk here would diverge the day either of those moves, and report a
 * drift nobody could reproduce. Read-only: `loadCorpus` opens nothing writable.
 */
const scanSources = async (context: CommandContext): Promise<SourceScan> => {
  try {
    const loaded = await loadCorpus(context.repoRoot, context.corpusRoots, context.profile);
    return { ok: true, identity: sourceIdentityOf(loaded) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

const gather = async (context: CommandContext): Promise<DoctorFacts> => ({
  context,
  locations: locationOrigins(context.flags, context.profile, context),
  manifestPath: manifestPathFor(context.atomsDir),
  manifestDigest: readManifestDigest(context.atomsDir),
  manifestSources: readManifestSourceIdentity(context.atomsDir),
  sources: await scanSources(context),
  indexExists: existsSync(context.indexPath),
  stamp: stampOf(context),
  owner: ownerOf(context.atomsDir),
  dropped: droppedDomains(atomsCensus(context.atomsDir, context.profile.domains)),
  availability: await AVAILABILITY_PROBES[context.adapter](),
  env: process.env,
});

const check = (name: string, status: CheckStatus, detail: string): DoctorCheck => ({
  name,
  status,
  detail,
});

const rebuild = (facts: DoctorFacts): string =>
  `rebuild it with \`${indexRebuildCommand(facts.context.adapter)}\``;

const reingest = (facts: DoctorFacts): string =>
  `re-run \`${ingestCommand()}\` then \`${indexRebuildCommand(facts.context.adapter)}\``;

const locationLine = (fact: LocationFact): string =>
  `${fact.knob} = ${fact.value} (from the ${fact.origin})`;

const locationChecks = (facts: DoctorFacts): readonly DoctorCheck[] => [
  check('locations', 'ok', facts.locations.map(locationLine).join('; ')),
];

const indexChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  if (!hasPersistentIndex(facts.context.adapter)) {
    return [check('index', 'ok', `${facts.context.adapter} keeps no persistent index`)];
  }
  return facts.indexExists
    ? [check('index', 'ok', `index present at ${facts.context.indexPath}`)]
    : [check('index', 'fault', `no index at ${facts.context.indexPath} — ${rebuild(facts)}`)];
};

const DIGEST = 'corpus-digest';

/**
 * The audit's worst state, and the reason `doctor` exists: an index that CARRIES
 * a `corpus_digest` proves a manifest existed when it was built, so the file's
 * absence NOW is a removal rather than an absence of record — and the adapter,
 * which cannot tell those apart, keeps serving at exit 0.
 */
const absentManifest = (facts: DoctorFacts, stamped: string): DoctorCheck =>
  check(
    DIGEST,
    'fault',
    `the index carries corpus_digest ${stamped} while ${facts.manifestPath} is ABSENT — drift detection is OFF and a stale or foreign index answers as ready; ${reingest(facts)}`
  );

const unstamped = (facts: DoctorFacts, manifest: string | undefined): DoctorCheck =>
  manifest === undefined
    ? check(DIGEST, 'warn', `neither the index nor ${facts.manifestPath} carries a corpus digest — drift detection is OFF`)
    : check(DIGEST, 'fault', `the index carries NO corpus_digest stamp while ${facts.manifestPath} carries ${manifest}; ${rebuild(facts)}`);

const digestVerdict = (facts: DoctorFacts, stamped: string, manifest: string): DoctorCheck =>
  stamped === manifest
    ? check(DIGEST, 'ok', `corpus_digest ${stamped} matches ${facts.manifestPath}`)
    : check(DIGEST, 'fault', `the stamped corpus_digest ${stamped} disagrees with ${manifest} in ${facts.manifestPath} — the index describes a different corpus; ${reingest(facts)}`);

const digestChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  if (!facts.indexExists || facts.stamp === undefined) return [];
  const stamped = facts.stamp.corpusDigest;
  if (stamped === undefined) return [unstamped(facts, facts.manifestDigest)];
  return facts.manifestDigest === undefined
    ? [absentManifest(facts, stamped)]
    : [digestVerdict(facts, stamped, facts.manifestDigest)];
};

const SOURCES = 'corpus-sources';

/**
 * The corpus→atoms verdict. A disagreement is a WARN and never a fault: a
 * corpus ahead of its atoms is the normal transient state of anyone editing
 * their notes, and a `doctor` that exited 3 mid-edit would teach its reader to
 * ignore it. What it must not do is stay silent — that silence is the defect
 * this check closes, where a word deleted on disk still answered at exit 0.
 */
const sourceVerdict = (
  facts: DoctorFacts,
  recorded: SourceIdentity,
  live: SourceIdentity
): DoctorCheck =>
  recorded.sourceDigest === live.sourceDigest
    ? check(SOURCES, 'ok', `${live.sourceCount} source document(s) match the ${recorded.sourceCount} source document(s) recorded in ${facts.manifestPath}`)
    : check(SOURCES, 'warn', `the corpus now holds ${live.sourceCount} source document(s) while the atoms in ${facts.context.atomsDir} were built from ${recorded.sourceCount} source document(s) recorded in ${facts.manifestPath} — the atoms are BEHIND their sources; ${reingest(facts)}`);

const unrecordedSources = (facts: DoctorFacts): DoctorCheck =>
  check(SOURCES, 'unknown', `${facts.manifestPath} records no source identity — it was written before ingest stamped one, so corpus drift CANNOT be judged until the next \`${ingestCommand()}\``);

const unwalkableSources = (facts: DoctorFacts, reason: string): DoctorCheck =>
  check(SOURCES, 'unknown', `the corpus could not be walked, so nothing can be compared with ${facts.manifestPath}: ${reason}`);

const sourceChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  if (facts.manifestSources === undefined) return [unrecordedSources(facts)];
  if (!facts.sources.ok) return [unwalkableSources(facts, facts.sources.reason)];
  return [sourceVerdict(facts, facts.manifestSources, facts.sources.identity)];
};

const schemaChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  const version = facts.stamp?.schemaVersion;
  if (version === undefined || version === INDEX_SCHEMA_VERSION) return [];
  return [
    check(
      'schema-version',
      'fault',
      `the index stamp schema_version is "${version}" and this build reads only "${INDEX_SCHEMA_VERSION}"; ${rebuild(facts)}`
    ),
  ];
};

/**
 * Judged through `carriedAnalyzer`, the adapter's own rule, and never off the
 * raw stamp: an UNSTAMPED index states no chain but CARRIES one, and reading
 * the absence as "nothing to compare" reported a clean bill of health over an
 * instance whose every retrieve refused.
 */
const analyzerChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  const declared = facts.context.profile.defaultAnalyzer;
  if (declared === undefined || facts.stamp === undefined) return [];
  const built = carriedAnalyzer(facts.stamp.analyzer);
  if (built === declared) return [];
  const unstamped =
    facts.stamp.analyzer === undefined
      ? ' (it carries no analyzer stamp, and only that chain ever produced an unstamped index)'
      : '';
  return [
    check(
      'analyzer',
      'fault',
      `the index was built with analyzer "${built}"${unstamped} while the profile declares defaultAnalyzer "${declared}" — every retrieve REFUSES, because the query side reads the chain off the INDEX; ${rebuild(facts)}`
    ),
  ];
};

const TYPE_VOCABULARY = 'type-vocabulary';

/**
 * The state that made `doctor` useless: a profile naming a type this build does
 * not define made every `retrieve` refuse, while this pass reported a clean
 * bill of health. It is read with the SAME rule the query path refuses on, and
 * worded with the same message, so the diagnostic and the refusal cannot drift.
 */
const typeVocabularyChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  const foreign = foreignVocabularyValue(facts.context.profile.types, DECLARED_TYPES);
  if (foreign === undefined) return [];
  return [
    check(
      TYPE_VOCABULARY,
      'fault',
      foreignVocabularyMessage('types', foreign, DECLARED_TYPES, facts.context.profilePath)
    ),
  ];
};

const ownerChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  const expected = facts.context.profile.name;
  if (facts.owner === undefined) {
    return [check('owner', 'warn', `${facts.context.atomsDir} carries no ${ATOMS_OWNER_FILE} marker — the next ingest will claim it`)];
  }
  return facts.owner === expected
    ? [check('owner', 'ok', `${facts.context.atomsDir} is owned by profile "${expected}"`)]
    : [check('owner', 'fault', `${facts.context.atomsDir} is owned by profile "${facts.owner}", not "${expected}" — an ingest as "${expected}" would prune every atom "${facts.owner}" wrote`)];
};

const domainChecks = (facts: DoctorFacts): readonly DoctorCheck[] =>
  facts.dropped.length === 0
    ? [check('domains', 'ok', 'every domain with files produced atoms')]
    : [
        check(
          'domains',
          'fault',
          `${facts.dropped.join(', ')} contributed files but ZERO indexable atoms — the parser refused every one; ${reingest(facts)}`
        ),
      ];

const adapterChecks = (facts: DoctorFacts): readonly DoctorCheck[] =>
  facts.availability.available
    ? [check('adapter', 'ok', `${facts.context.adapter} is available`)]
    : [
        check(
          'adapter',
          'fault',
          `${facts.context.adapter} is unavailable — ${facts.availability.reason ?? 'its optional dependency could not be loaded'}`
        ),
      ];

/** A tier that outranks the profile, so a profile statement here LOST silently. */
const OVERRIDING_ORIGINS: readonly string[] = ['flag', 'env'];

const overrideChecks = (facts: DoctorFacts): readonly DoctorCheck[] =>
  facts.locations
    .filter(fact => OVERRIDING_ORIGINS.includes(fact.origin) && fact.declared !== undefined)
    .map(fact =>
      check(
        `precedence:${fact.knob}`,
        'warn',
        `${fact.knob} came from the ${fact.origin} as "${fact.value}" and SILENTLY beats the profile's "${String(fact.declared)}"`
      )
    );

const DATA_HOME_VAR = 'DP_GNOSIS_DATA_HOME';

const dataRootChecks = (facts: DoctorFacts): readonly DoctorCheck[] => {
  const stated = statedVar(facts.env, DATA_HOME_VAR);
  const configured = loadUserConfig(configHome(facts.env)).dataRoot;
  if (stated === undefined || configured === undefined) return [];
  return [
    check(
      `precedence:${DATA_HOME_VAR}`,
      'warn',
      `${DATA_HOME_VAR}="${stated}" SILENTLY beats dataRoot "${configured}" in config.json; the resolved data root is ${dataRoot(facts.env)}`
    ),
  ];
};

const blankVar = (env: NodeJS.ProcessEnv, name: string): boolean =>
  env[name] !== undefined && statedVar(env, name) === undefined;

const blankVarChecks = (facts: DoctorFacts): readonly DoctorCheck[] =>
  DP_GNOSIS_HOME_VARS.filter(name => blankVar(facts.env, name)).map(name =>
    check(
      `precedence:${name}`,
      'warn',
      `${name} is SET BUT BLANK, which reads as unset — the default location is in effect, not one you named`
    )
  );

/**
 * A profile path that leaves the data root is what makes `dataRoot()` moot.
 *
 * Containment is a PATH question, judged with `relative()` exactly as
 * `ingest.ts:sourceIdentity` judges one. A prefix test got it wrong in both
 * directions: it read a SIBLING of the data root as inside it (`/x/data-old`
 * starts with `/x/data`), and it read every RELATIVE location as an absolute
 * path outside. A relative one is not judged here at all -- it resolves
 * against the profile file's own directory, which this pass does not know.
 */
const escapesDataRoot = (facts: DoctorFacts, declared: string | undefined): boolean => {
  if (declared === undefined || !isAbsolute(declared)) return false;
  const within = relative(dataRoot(facts.env), declared);
  return within.startsWith('..') || isAbsolute(within);
};

/**
 * Where the CORPUS lives is the user's own choice — `init` itself writes a
 * corpusRoots outside the data root — so a path there says nothing about
 * precedence. Only the knobs the data root is supposed to lay out qualify.
 */
const LAID_OUT_BY_DATA_ROOT: readonly string[] = ['atomsDir', 'indexPath', 'repoRoot'];

const escapeChecks = (facts: DoctorFacts): readonly DoctorCheck[] =>
  facts.locations
    .filter(fact => LAID_OUT_BY_DATA_ROOT.includes(fact.profileKey))
    .filter(fact => fact.origin === 'profile' && escapesDataRoot(facts, fact.declared))
    .map(fact =>
      check(
        `precedence:${fact.knob}`,
        'warn',
        `the profile states ${fact.profileKey} = "${String(fact.declared)}", an absolute path OUTSIDE the resolved data root ${dataRoot(facts.env)} — the data root does not decide where this lands`
      )
    );

const CHECKS: readonly ((facts: DoctorFacts) => readonly DoctorCheck[])[] = [
  locationChecks,
  indexChecks,
  digestChecks,
  sourceChecks,
  schemaChecks,
  analyzerChecks,
  typeVocabularyChecks,
  ownerChecks,
  domainChecks,
  adapterChecks,
  overrideChecks,
  dataRootChecks,
  blankVarChecks,
  escapeChecks,
];

const countOf = (checks: readonly DoctorCheck[], status: CheckStatus): number =>
  checks.filter(entry => entry.status === status).length;

const checkLine = (entry: DoctorCheck): string =>
  `  [${entry.status}] ${entry.name}: ${entry.detail}`;

const doctorText = (checks: readonly DoctorCheck[]): string =>
  [
    `doctor: ${countOf(checks, 'fault')} fault(s), ${countOf(checks, 'warn')} warning(s)`,
    ...checks.map(checkLine),
  ].join('\n');

/**
 * A fault is a PARTIAL, not a usage failure: the argv was well formed and the
 * pass completed — what it found is that some of the instance does not work.
 */
const outcomeOf = (checks: readonly DoctorCheck[]): CommandOutcome => ({
  exitCode: countOf(checks, 'fault') === 0 ? EXIT_OK : EXIT_PARTIAL,
  data: {
    command: 'doctor',
    faults: countOf(checks, 'fault'),
    warnings: countOf(checks, 'warn'),
    checks,
  },
  text: doctorText(checks),
});

export const runDoctorCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const facts = await gather(context);
  return outcomeOf(CHECKS.flatMap(builder => builder(facts)));
};
