/**
 * Retrieval and authoring policy constants. Deliberately separate from
 * `paths.ts` (SRP): that module owns WHERE things live, this one owns the
 * limits and vocabulary an atom must satisfy.
 *
 * The vocabularies and the path→label tables are DATA, loaded from the shipped
 * ingest profile (`profiles/default.profile.json`); this module only narrows
 * them to the union types the rest of the package is written against.
 */
import type { IngestProfile } from './ingestProfile.js';
import { domainForPath, loadIngestProfile, typeForPath } from './ingestProfile.js';
import { INGEST_PROFILE_PATH } from './paths.js';

/**
 * Hard write-time cap on a single atom's body.
 *
 * Derivation: the injection budget is 2–3k tokens and a query returns top-k
 * 3–5 atoms, so one atom must stay near ~1000 tokens — 4000 characters at the
 * conventional 4 chars/token. Measured in CHARACTERS on purpose: it needs no
 * tokenizer dependency and is byte-deterministic across models.
 */
export const ATOM_MAX_CHARS = 4000;

/**
 * What the chunker aims for, leaving headroom so a sub-split (heading prefix,
 * source trailer) still lands under `ATOM_MAX_CHARS`.
 */
export const ATOM_CHUNK_TARGET_CHARS = 3200;

/**
 * Per-block escape hatch above `ATOM_MAX_CHARS`, for a single INDIVISIBLE
 * fenced block only.
 *
 * A fenced block has no readable interior boundary: measured on the benchmark
 * corpus, one oversize ASCII box diagram was cut into 16 parts that each began
 * and ended mid-figure, and 9 such cut sites produced 61 atoms nobody can read.
 * Emitting such a block whole is strictly better than emitting 16 fragments, so
 * up to this ceiling the chunker keeps it intact; a fenced block ABOVE the
 * ceiling is still split, because at some size a fragment beats an atom that
 * cannot be injected at all.
 *
 * 8000 is twice `ATOM_MAX_CHARS`, which is the largest single item the current
 * reranker batch can hold. RAISING it requires the reranker's PHYSICAL batch
 * (`-ub`) to rise with it — an atom longer than the physical batch is dropped
 * at score time rather than ranked badly, so the two numbers move together.
 */
export const ATOM_FENCE_MAX_CHARS = 8000;

/**
 * Opens a fenced block: three or more backticks or tildes, after at most three
 * spaces of indentation (four would make the line an indented code block).
 */
const FENCE_OPEN_RE = /^ {0,3}(?:`{3,}|~{3,})/;

/** The ingest heading line, the ONE line a body may carry before its fence. */
const BODY_HEADING_RE = /^# /;

const contentLines = (body: string): readonly string[] =>
  body.split('\n').filter(line => line.trim().length > 0);

/**
 * `true` when the body IS one indivisible fenced block — the chunker's escape
 * hatch, seen from the far end.
 *
 * The heading line is skipped before the test because ingest prepends `# chain`
 * to the chunker's output: measured on the benchmark corpus a 5053-character
 * diagram atom presents to the validator as heading-first, so testing line 1
 * alone would refuse exactly the atom the escape hatch exists to keep whole.
 * Only ONE leading heading is skipped — prose under a heading is still prose.
 */
const opensWithFence = (body: string): boolean => {
  const lines = contentLines(body);
  const first = lines[0] ?? '';
  return FENCE_OPEN_RE.test(BODY_HEADING_RE.test(first) ? (lines[1] ?? '') : first);
};

/**
 * The cap this body must satisfy — the ONE place the fence escape hatch is
 * decided, imported by every module that enforces a body length. A second copy
 * of the fence test is how the writer and the validator end up disagreeing
 * about the same atom.
 *
 * `maxChars` is the running instance's cap (a profile's `atomMaxChars`, else
 * the shipped one), and the fence hatch is the LARGER of the two limits: a
 * fenced block must never be held to a tighter cap than ordinary prose.
 */
export const bodyMaxChars = (body: string, maxChars: number = ATOM_MAX_CHARS): number =>
  opensWithFence(body) ? Math.max(ATOM_FENCE_MAX_CHARS, maxChars) : maxChars;

/**
 * Body floor below which a chunk is not an atom of its own.
 *
 * The floor is enforced by `canAbsorb`, which since the `sameBranch` guard
 * merges ONLY within one heading branch, so raising it cannot fuse unrelated
 * sections: at 200 characters, 799 of the 2 471 under-floor sections are
 * genuine lead-ins folded into their own branch, and the remaining 1 672 —
 * siblings, uncles and last sections — are simply left as their own atoms.
 * (The earlier "one-line lead-ins" reading of the under-floor population is
 * falsified: of 325 under-floor sections only 37, 11.4%, were followed by a
 * deeper heading; 238 were siblings, 41 uncles and 9 a document's last
 * section.)
 *
 * 200 was chosen because the reranker's narrowest measured extraction window
 * is 100–300 characters, so a body under 200 cannot fill even one window while
 * still occupying a candidate slot.
 *
 * Measured in CHARACTERS against the RAW chunk body, before ingest prepends
 * the heading line — measuring the prefixed body would let the prefix mask an
 * empty atom.
 */
export const ATOM_MIN_CHARS = 200;

/**
 * Default injection budget for one `retrieve` call, in the unit
 * `estimateTokens` returns — UTF-8 BYTES, not tokenizer tokens.
 *
 * It is a byte bound because no tokenizer is a dependency here, and the byte
 * count is a PROVEN upper bound on the real token count (see `estimateTokens`).
 * The price is measured: on the repo top-5 median the bound reads 6 190 where
 * Qwen counts 1 520 tokens — 4.1x reserve — and 5 272 vs 1 959 in Hungarian,
 * 2.7x. A caller who knows its own window passes `--max-tokens`.
 *
 * 16000 is measured (2026-08-13, full curve in
 * `docs/benchmarks/2026-08-13-dp-gnosis-evolution-and-maturity-analysis.md`
 * §5.3): raising the budget from 8000 lifts delivered recall@10 from 0.4373 to
 * 0.5330 against an unlimited-budget ceiling of 0.5420, and the median count of
 * top-10 atoms actually admitted from 6.5 to 10.0. So 16000 bytes recovers 91%
 * of the recall the 8000 default was discarding, and ~3900 real tokens
 * (16000 ÷ 4.1) still sits inside the 2000–4000 token band published for
 * retrieved knowledge in a pipeline that filters.
 *
 * Unrelated to `ATOM_FENCE_MAX_CHARS`: that one caps a single atom's CHARACTERS
 * at write time, this one caps a whole result's BYTES at read time. They move
 * independently.
 */
export const RETRIEVE_TOKEN_BUDGET = 16000;

/**
 * The reranker `retrieve --rerank` calls, served by llama-swap under this id.
 * One id, one model: the measured configuration below was measured against
 * THIS model, so serving another one under the flag would report its numbers.
 */
export const RERANK_MODEL_ID = 'bge-reranker-v2-m3';

/** llama-swap's OpenAI-compatible base URL, overridden by {@link RERANK_URL_ENV_VAR}. */
export const RERANK_DEFAULT_URL = 'http://127.0.0.1:9292';

/** Environment override for {@link RERANK_DEFAULT_URL}, read in `resolveRerankUrl` alone. */
export const RERANK_URL_ENV_VAR = 'DP_GNOSIS_RERANK_URL';

/**
 * First-pass depth: how many candidates the reranker reorders. Measured
 * (2026-08-13,
 * `docs/benchmarks/2026-08-13-dp-gnosis-evolution-and-maturity-analysis.md`
 * §5.1) — it is the pool the fusion below was measured over, so it moves with
 * {@link RERANK_RRF_K} and {@link RERANK_RRF_WEIGHT}, never alone.
 */
export const RERANK_K_INIT = 20;

/**
 * Characters of an atom body sent to the reranker, taken from the HEAD.
 * The measured extraction: `extractDoc(body, 'head', 2000)`.
 */
export const RERANK_DOC_MAX_CHARS = 2000;

/**
 * The RRF rank constant, and the weight the RERANKED order carries against the
 * first-pass order (the first pass carries `1 - weight`):
 * `score(d) = 0.5/(20 + rank_rerank(d)) + 0.5/(20 + rank_firstpass(d))`.
 *
 * FUSED, not pure — these three numbers are measured, not taste. Pure
 * reranking REGRESSES MRR (0.6078 → 0.5737); the fused cell improves all four
 * metrics over the first-pass floor (r@10 / r@20 / nDCG@10 / MRR):
 *
 *   first pass (floor)      0.5420 / 0.6990 / 0.6176 / 0.6078
 *   RRF K=20, w_rerank=0.5  0.5760 / 0.6990 / 0.6464 / 0.6270
 */
export const RERANK_RRF_K = 20;

/** See {@link RERANK_RRF_K} — the two are one measured pair. */
export const RERANK_RRF_WEIGHT = 0.5;

/**
 * How the reranked order is combined with the first-pass order.
 *
 * `rrf` fuses the two; `replace` discards the first-pass order entirely and
 * emits the reranker's. Two members, because two protocols exist — this is a
 * closed set, not an extension point.
 */
export type RerankFusion =
  | { readonly kind: 'rrf'; readonly rrfK: number; readonly rerankWeight: number }
  | { readonly kind: 'replace' };

/**
 * The named rerank protocols. A name — not a bare number pair — is what a run
 * records, so a non-standard configuration cannot be published as a standard
 * one by accident.
 *
 * `shipped` is what every recorded rerank number was measured under, and is
 * the default: {@link RERANK_RRF_K} / {@link RERANK_RRF_WEIGHT}.
 *
 * `beir-ce` is the published BEIR BM25+CE protocol — the cross-encoder's order
 * REPLACES the first pass. It exists to make our numbers comparable with that
 * baseline, NOT because it retrieves better: pure reranking is the arm the
 * measurement above rejected for serving.
 */
export const RERANK_FUSION_PRESETS = {
  shipped: { kind: 'rrf', rrfK: RERANK_RRF_K, rerankWeight: RERANK_RRF_WEIGHT },
  'beir-ce': { kind: 'replace' },
} as const satisfies Readonly<Record<string, RerankFusion>>;

/** The name a caller may ask for. */
export type RerankPresetName = keyof typeof RERANK_FUSION_PRESETS;

/** Every valid preset name, for a caller that must reject an unknown one. */
export const RERANK_PRESET_NAMES = Object.keys(RERANK_FUSION_PRESETS) as readonly RerankPresetName[];

/** The protocol a caller that names none gets — today's shipped behaviour. */
export const DEFAULT_RERANK_PRESET: RerankPresetName = 'shipped';

/**
 * Hard cap on how many terms a constructed retrieval query may carry.
 *
 * A task's targets, test contract and spec excerpts together run to thousands
 * of tokens, and BM25 scores a 2000-token blob nothing like a focused query:
 * every additional low-IDF term adds score mass to documents that match it
 * incidentally. 32 keeps the query in the range lexical scoring was designed
 * for while still admitting several distinct identifiers per input section.
 */
export const QUERY_MAX_TERMS = 32;

/**
 * The smoothing term of the BM25 inverse-document-frequency formula
 * `ln(1 + (N - n + 0.5) / (n + 0.5))`, where N is the corpus size and n the
 * number of documents containing the term. It appears on both sides of that
 * fraction and is ONE quantity, so it is owned here and imported by every
 * scorer — a per-file copy would let the two implementations drift apart.
 */
export const BM25_IDF_SMOOTHING = 0.5;

/**
 * The repo-relative roots ingest walks — the corpus SCOPE, stated explicitly
 * rather than implied by whatever `SOURCE_ROOT_DOMAINS` happens to list. Scope
 * (what is read) and labelling (what domain a read file gets) are two
 * decisions, and conflating them means widening either one silently widens the
 * other.
 *
 * An entry containing `*` is a glob resolved against the repo root and
 * contributes the matching FILES; every other entry is a directory walked
 * recursively. `RUNNER-*.md` is the repo-root runner doc set, which has no
 * containing directory of its own.
 *
 * Scope covers the whole authored knowledge base, not `doc/` alone: the frozen
 * golden set draws 46 of its 103 atoms from `claude-artifacts/` and 30 from the
 * repo-root `RUNNER-*.md` files, so a `doc/`-only corpus leaves most of the
 * benchmark unscoreable.
 */
export const CORPUS_ROOTS: readonly string[] = ['doc', 'claude-artifacts', 'RUNNER-*.md'];

/** Comma-separated override of `CORPUS_ROOTS`, read in `resolveCorpusRoots` alone. */
export const CORPUS_ROOTS_ENV_VAR = 'DP_GNOSIS_CORPUS_ROOTS';

const ROOT_SEPARATOR = ',';

/**
 * The ONE place the corpus scope is resolved. Every caller imports this instead
 * of reading the environment itself: a second `process.env` read is how one
 * command ends up indexing a different corpus than the command beside it.
 * An unset, empty or all-blank override falls back to `fallback`, which is the
 * profile's own scope when it declared one and `CORPUS_ROOTS` when it did not —
 * the env override therefore outranks a profile exactly as a flag does.
 */
const declaredRoots = (
  env: Readonly<Record<string, string | undefined>>
): readonly string[] =>
  (env[CORPUS_ROOTS_ENV_VAR] ?? '')
    .split(ROOT_SEPARATOR)
    .map(root => root.trim())
    .filter(root => root.length > 0);

export const resolveCorpusRoots = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback: readonly string[] = CORPUS_ROOTS
): readonly string[] => {
  const declared = declaredRoots(env);
  return declared.length > 0 ? declared : fallback;
};

/**
 * The SHIPPED ingest profile: the ONE place the vocabularies and the
 * path→label tables are authored. Loaded once at module init, so a missing or
 * malformed data file stops the process with the defect named instead of
 * relabelling a whole corpus from built-in values.
 */
export const DEFAULT_INGEST_PROFILE: IngestProfile = loadIngestProfile(INGEST_PROFILE_PATH);

/**
 * The shipped vocabularies restated as literal tuples, and for ONE reason: they
 * are what gives `AtomDomain` / `AtomType` their union types, which every
 * filter, adapter and CLI flag is typed against. They decide nothing — the
 * profile is still the source, and `expectVocabulary` refuses to start when the
 * two disagree, so a value is added to the data file and mirrored here.
 */
const DECLARED_DOMAINS = ['runner', 'standards', 'adr', 'docs', 'claude'] as const;

const DECLARED_TYPES = [
  'knowledge',
  'feature-log',
  'paper',
  'benchmark',
  'review',
  'adr',
  'brainstorm',
  'vendor-doc',
  'teaching',
  'meta',
  'runner-rule',
  'standard',
  'research',
  'plan',
  'lessons-learned',
] as const;

const expectVocabulary = <T extends readonly string[]>(
  actual: readonly string[],
  declared: T,
  field: string
): T => {
  if (actual.length !== declared.length || declared.some((value, index) => actual[index] !== value)) {
    throw new Error(
      `ingest profile "${INGEST_PROFILE_PATH}" declares ${field} ${actual.join(' | ')}, while src/config.ts mirrors ${declared.join(' | ')} — a vocabulary value MUST be present in both, or the TypeScript union lies about what a valid label is`
    );
  }
  return declared;
};

/** Narrow a profile-declared label to its union member, refusing anything else. */
const expectMember = <T extends string>(value: string, vocabulary: readonly T[], field: string): T => {
  const known = vocabulary.find(member => member === value);
  if (known === undefined) {
    throw new Error(
      `ingest profile "${INGEST_PROFILE_PATH}" resolved ${field} "${value}", outside the closed vocabulary — replace it with one of ${vocabulary.join(' | ')}`
    );
  }
  return known;
};

/**
 * The closed `x_domain` vocabulary. An unknown domain is REFUSED at write
 * time: a free-form string fragments on typos and makes an atom silently
 * invisible to every domain-filtered query.
 */
export const ATOM_DOMAINS = expectVocabulary(DEFAULT_INGEST_PROFILE.domains, DECLARED_DOMAINS, 'domains');

/** A member of the closed domain vocabulary. */
export type AtomDomain = (typeof ATOM_DOMAINS)[number];

/** One mechanical assignment rule: repo-relative path prefix → domain. */
export interface SourceRootDomain {
  readonly prefix: string;
  readonly domain: AtomDomain;
}

/**
 * The shipped source→domain assignment table, as declared in the profile data
 * file (`profiles/default.profile.json`, `domainRules`). Ingest MUST derive
 * `x_domain` from this alone, so re-running over unchanged input reproduces
 * identical domains — no per-atom judgement, hence no drift between two
 * ingests of the same corpus. Resolution is longest-prefix-wins; the rows keep
 * their declaration order here so a caller may render the table as authored.
 */
export const SOURCE_ROOT_DOMAINS: readonly SourceRootDomain[] = DEFAULT_INGEST_PROFILE.domainRules.map(
  rule => ({ prefix: rule.prefix, domain: expectMember(rule.domain, ATOM_DOMAINS, 'domainRules[].domain') })
);

/**
 * Resolve the domain for a repo-relative source path, or `undefined` when no
 * declared root claims it (such a source is out of scope for ingest).
 */
export const domainForSource = (repoRelativePath: string): AtomDomain | undefined => {
  const domain = domainForPath(DEFAULT_INGEST_PROFILE, repoRelativePath);
  return domain === undefined ? undefined : expectMember(domain, ATOM_DOMAINS, 'x_domain');
};

/**
 * The closed `type` vocabulary. Same reasoning as `ATOM_DOMAINS`: an unknown
 * type is REFUSED at write time, because a typo would make the atom silently
 * invisible to every type-filtered query.
 *
 * `knowledge` is the FALLBACK, not the norm — the directory an authored document
 * lives in already carries what kind of document it is (a decision record, a
 * benchmark run, a review), and collapsing all of them into one label discards
 * that. It stays in the vocabulary for the sources no rule below claims.
 *
 * A value here that NO rule claims is deliberate, not an oversight: it is
 * accepted on write while its directory convention is still unsettled, and a
 * guessed path rule would mislabel silently.
 */
export const ATOM_TYPES = expectVocabulary(DEFAULT_INGEST_PROFILE.types, DECLARED_TYPES, 'types');

/** A member of the closed type vocabulary. */
export type AtomType = (typeof ATOM_TYPES)[number];

/** The type of a source no prefix and no segment rule claims. */
export const DEFAULT_ATOM_TYPE: AtomType = expectMember(
  DEFAULT_INGEST_PROFILE.defaultType,
  ATOM_TYPES,
  'defaultType'
);

/** One mechanical assignment rule: repo-relative path prefix → type. */
export interface SourceRootType {
  readonly prefix: string;
  readonly type: AtomType;
}

/**
 * The shipped source→type assignment table, as declared in the profile data
 * file (`profiles/default.profile.json`, `typeRules`), and read exactly as
 * `SOURCE_ROOT_DOMAINS` is: longest-prefix-wins, so declaration order is
 * presentation only and a re-run over unchanged input reproduces identical
 * types. A segment rule (also in the profile) overrides every prefix rule.
 */
export const SOURCE_ROOT_TYPES: readonly SourceRootType[] = DEFAULT_INGEST_PROFILE.typeRules.map(
  rule => ({ prefix: rule.prefix, type: expectMember(rule.type, ATOM_TYPES, 'typeRules[].type') })
);

/**
 * Resolve the type for a repo-relative source path. Unlike the domain, an
 * unclaimed source is not out of scope — it simply keeps the `knowledge`
 * fallback.
 */
export const typeForSource = (repoRelativePath: string): AtomType =>
  expectMember(typeForPath(DEFAULT_INGEST_PROFILE, repoRelativePath), ATOM_TYPES, 'type');
