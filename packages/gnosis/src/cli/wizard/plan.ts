/**
 * The wizard's PURE core: the answers a user gave, turned into exactly what
 * will be written and run. It performs no I/O and asks no questions.
 *
 * The split exists for two reasons.
 *
 * It is what makes the wizard testable. A terminal app whose decisions live
 * inside its prompt callbacks can only be tested by driving a terminal; with
 * the decisions here, the whole of them is a function call, and the prompt
 * layer left over is thin enough to test with a scripted fake.
 *
 * It is also what makes the wizard's central safety rule expressible: NOTHING
 * is written until the user has confirmed a rendered summary. A plan is a
 * value, so it can be shown, refused and dropped. A wizard that wrote each
 * answer as it arrived would leave a half-configured instance behind on the
 * first `Ctrl-C` — and a half-configured instance is one that ingests, exits 0
 * and answers nothing.
 *
 * Every default it fills in is the SHIPPED one, read from its owner. A wizard
 * that offered a different default would be moving a measured constant through
 * a menu, which no menu is allowed to do.
 */
import { isAbsolute } from 'node:path';

import { DECLARED_TYPES, RERANK_K_INIT } from '../../config.js';
import { expandUserPath } from '../../env.js';
import { sourceIdentity } from '../../ingest.js';
import type { ProfileRoot } from '../../instance.js';
import { profileTemplate } from '../../instance.js';
import { SERVED_PRF_PARAMS } from '../../prf.js';
import type { AnalyzerId } from '../../query.js';
import type { AdapterName } from '../adapter.js';

/** One corpus directory and the domain its atoms are labelled with. */
export interface RootAnswer {
  /** As the user typed it — absolute or `~/`-prefixed. */
  readonly path: string;
  /** A member of the profile's `domains` vocabulary. */
  readonly domain: string;
}

/**
 * The reranker this instance will use, once a probe has PROVED it discriminates.
 *
 * A discriminated union rather than one shape with optional halves: the two
 * backends are answered by different questions and written as different keys,
 * and a `url` on a local answer (or a `modelPath` on a served one) would be a
 * field nothing reads and nothing maintains. Every consumer must handle both,
 * which is the point.
 */
export type RerankAnswer =
  | {
    readonly backend: 'http';
    /** Where the probe passed. */
    readonly url: string;
    /** The id THAT server serves it under. */
    readonly model: string;
    readonly poolK: number;
  }
  | {
    readonly backend: 'local';
    /** The GGUF the in-process engine loaded and probed. Absolute. */
    readonly modelPath: string;
    /** What the file is, for the summary alone — never written as `rerank.model`. */
    readonly model: string;
    readonly poolK: number;
  };

/** The three chat hops, each an id the user picked from what the server advertises. */
export interface ChatAnswer {
  readonly rephrase?: string | undefined;
  readonly synthesize?: string | undefined;
  readonly enrich?: string | undefined;
}

/** Everything the wizard asked, in one value. */
export interface WizardAnswers {
  /** Absent when the user kept this machine's resolved default. */
  readonly dataRoot?: string | undefined;
  readonly roots: readonly RootAnswer[];
  readonly excludePaths: readonly string[];
  readonly defaultType: string;
  readonly excludedTypes: readonly string[];
  readonly analyzer: AnalyzerId;
  readonly adapter: AdapterName;
  readonly prf: boolean;
  /** Absent when the user declined the reranker, or no probe passed. */
  readonly rerank?: RerankAnswer | undefined;
  readonly chat?: ChatAnswer | undefined;
}

/** Where this instance's artefacts go — resolved by the caller, not guessed here. */
export interface PlanLocations {
  readonly profilePath: string;
  readonly atomsDir: string;
  readonly indexPath: string;
  readonly repoRoot: string;
}

/** What will be written and what will then be run. */
export interface WizardPlan {
  readonly locations: PlanLocations;
  /** The profile file's contents, ready to serialise. */
  readonly profile: Readonly<Record<string, unknown>>;
  /** The keys to MERGE into `config.json`. Empty when this machine needs none. */
  readonly configPatch: Readonly<Record<string, unknown>>;
}

/** A refusal the wizard raises before it has written anything. */
export type PlanResult =
  | { readonly ok: true; readonly plan: WizardPlan }
  | { readonly ok: false; readonly error: string };

const NO_ROOTS =
  'this instance would have no corpus at all — an instance whose ingest walks nothing answers nothing on its first search; name at least one directory of markdown';

const relativeRoot = (path: string): string =>
  `corpus directory "${path}" is relative — write it as an absolute path (or start it with ~/), so the scope cannot move with the shell`;

const unknownType = (type: string): string =>
  `"${type}" is not one of the declared atom types (${DECLARED_TYPES.join(', ')})`;

/**
 * `defaultType` and `defaultExcludedTypes` are checked against the SHIPPED
 * vocabulary rather than against the profile's own `types`, because a
 * profile-only type is unusable as a filter: `--type` validates against the
 * shipped set, so writing one would produce a profile whose exclusion silently
 * matches nothing.
 */
const declared = (type: string): boolean => DECLARED_TYPES.some(known => known === type);

const validate = (answers: WizardAnswers): string | undefined => {
  if (answers.roots.length === 0) return NO_ROOTS;
  const relative = answers.roots.map(root => expandUserPath(root.path)).find(path => !isAbsolute(path));
  if (relative !== undefined) return relativeRoot(relative);
  return [answers.defaultType, ...answers.excludedTypes].filter(type => !declared(type)).map(unknownType)[0];
};

/**
 * The `domainRules` prefix is the source's IDENTITY, not its raw path:
 * `CONFIGURATION.md` § 4.1 makes a source under `repoRoot` identify by its
 * relative path and everything else by its absolute one, and a prefix written
 * in the other form matches nothing while ingest refuses every file under it.
 */
const domainRule = (root: RootAnswer, repoRoot: string): ProfileRoot => ({
  path: root.path,
  prefix: sourceIdentity(repoRoot, expandUserPath(root.path)),
  domain: root.domain,
});

const optionalKey = <T>(key: string, value: T | undefined): Readonly<Record<string, T>> =>
  value === undefined ? {} : { [key]: value };

/** The pool depth is written only when it DIFFERS from the shipped one. */
const poolKey = (rerank: RerankAnswer | undefined): number | undefined =>
  rerank === undefined || rerank.poolK === RERANK_K_INIT ? undefined : rerank.poolK;

const buildProfile = (
  answers: WizardAnswers,
  locations: PlanLocations
): Readonly<Record<string, unknown>> =>
  profileTemplate({
    roots: answers.roots.map(root => domainRule(root, locations.repoRoot)),
    repoRoot: locations.repoRoot,
    atomsDir: locations.atomsDir,
    indexPath: locations.indexPath,
    defaultType: answers.defaultType,
    excludedTypes: answers.excludedTypes,
    defaultAnalyzer: answers.analyzer,
    ...(answers.excludePaths.length === 0 ? {} : { excludePaths: answers.excludePaths }),
    ...(answers.prf ? { defaultPrf: SERVED_PRF_PARAMS } : {}),
    rerankPoolK: poolKey(answers.rerank),
  });

const chatPatch = (chat: ChatAnswer | undefined): Readonly<Record<string, unknown>> => {
  if (chat === undefined) return {};
  const models = {
    ...optionalKey('rephrase', chat.rephrase),
    ...optionalKey('synthesize', chat.synthesize),
    ...optionalKey('enrich', chat.enrich),
  };
  return Object.keys(models).length === 0 ? {} : { models };
};

/**
 * `dataRoot` is written ONLY when the user chose a non-default one. Writing the
 * resolved default would pin a path that this machine already derives, and
 * `CONFIGURATION.md` § 1.1 makes that derivation the thing a checkout depends
 * on — a pinned copy would survive a move of the checkout and point at nothing.
 */
/**
 * `rerank.model` is written ONLY on the served answer, and its absence from the
 * local one is load-bearing rather than an omission. `RERANK_CALIBRATION`
 * (`config.ts`) is keyed by model ID and was measured against the SERVED
 * endpoint; writing the same id beside `backend: "local"` would let a local raw
 * score be read through a scale nothing measured against this engine — a
 * calibrated-looking probability for a calibration that never happened.
 * `rerank.ts:rerankCalibrationKey` refuses the key under this backend anyway;
 * not writing it means the file does not claim otherwise either.
 */
const rerankPatch = (rerank: RerankAnswer | undefined): Readonly<Record<string, unknown>> => {
  if (rerank === undefined) return {};
  return rerank.backend === 'http'
    ? { rerank: { url: rerank.url, model: rerank.model } }
    : { rerank: { backend: 'local', modelPath: rerank.modelPath } };
};

const buildConfigPatch = (answers: WizardAnswers): Readonly<Record<string, unknown>> => ({
  ...optionalKey('dataRoot', answers.dataRoot),
  ...rerankPatch(answers.rerank),
  ...chatPatch(answers.chat),
});

/** The whole plan, or the first refusal that stops it. Writes nothing. */
export const buildPlan = (answers: WizardAnswers, locations: PlanLocations): PlanResult => {
  const error = validate(answers);
  return error === undefined
    ? { ok: true, plan: { locations, profile: buildProfile(answers, locations), configPatch: buildConfigPatch(answers) } }
    : { ok: false, error };
};
