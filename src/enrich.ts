/**
 * `enrich` — the generation half of ingest-time enrichment, and the only place
 * a model is asked to produce indexable text.
 *
 * It runs OUTSIDE `ingest` by construction (plan § 2): `ingest` stays the drift
 * baseline — same corpus, byte-identical atoms — and enrichment merges at INDEX
 * time from a sidecar. Nothing here writes an atom.
 *
 * Four properties are load-bearing.
 *
 * FIVE model fields, six record fields. `entities` is DETERMINISTIC (plan D2b):
 * it is a verbatim copy of literal tokens the fragment already contains, which
 * a regex does exactly and a model does approximately. Asking for it would buy
 * paraphrase risk and output tokens for a value that is not a judgement.
 *
 * SEQUENTIAL, never concurrent. Measured on the served generator: six parallel
 * calls aggregate 89.1 tok/s against ~97 tok/s sequential. Concurrency is not a
 * lever here, and it would interleave appends into a file whose whole
 * resumability rests on whole lines arriving whole.
 *
 * APPEND-ONLY, so an interrupted run resumes. A record already fresh for this
 * body, prompt version and model is SKIPPED without a call; anything else is
 * generated and appended. The later record for an id wins on read, so a
 * re-generation supersedes without a rewrite.
 *
 * STOP on the first refusal. A schema-invalid or refused answer ends the run
 * carrying its message, and no partial record is ever written: half a record is
 * indexed as search text just as readily as a whole one, and nothing downstream
 * could tell them apart.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Atom } from './atom.js';
import { parseAtom } from './atom.js';
import type { ChatProvider, ChatRequest } from './chat.js';
import type { EnrichmentFields, EnrichmentRecord } from './enrichment.js';
import {
  atomKeyOf,
  docKeyOf,
  ENRICHMENT_PROMPT_VERSION,
  isEnrichmentFresh,
  loadEnrichmentSidecar,
  serializeEnrichmentRecord
} from './enrichment.js';

/**
 * The extraction contract, `promptVersion` 1. One shared prefix per run, so
 * llama.cpp's prefix cache serves it from call 2 (measured: 623 of 832 prompt
 * tokens cached) — its LENGTH is therefore nearly free, and it MUST NOT be
 * shortened for cost. Only a change to what it ASKS FOR justifies an edit, and
 * that edit bumps {@link ENRICHMENT_PROMPT_VERSION}, which makes every record
 * written under the old wording stale rather than silently reusable.
 *
 * Rule 3 exists because it is the method's published failure mode: a generated
 * prefix that is a near-verbatim paraphrase of the fragment injects no new
 * context and moves nothing. Rule 5 is Doc2Query++'s coverage constraint —
 * their finding is that questions spanning the document's TOPICS beat many more
 * questions at one topic, and SECTIONS supplies that topic decomposition for
 * free from the document's own heading chain.
 *
 * `entities` is deliberately ABSENT from the field contract: {@link extractEntities}
 * produces it from the fragment itself.
 */
export const ENRICHMENT_SYSTEM_PROMPT: string = [
  'You are an INDEXING EXTRACTOR for a BM25 lexical search engine. You do not chat,',
  'explain, or add prose outside the schema.',
  '',
  'INPUT: one FRAGMENT of a larger document, its PATH, its TITLE, and SECTIONS — the',
  'heading chain of every section of that document.',
  '',
  'Your output is indexed as search text. It is judged on ONE criterion: does it add',
  'words a user\'s query would plausibly use that the fragment does NOT already',
  'contain? Repeating the fragment\'s own wording adds nothing and is a failure.',
  '',
  'RULES',
  '1. LANGUAGE: write every field in the FRAGMENT\'s own dominant language. Do not translate.',
  '2. GROUNDING: every claim MUST be supported by the fragment or its title/path/sections.',
  '   Never infer facts not present. If a field has no grounded content, return an empty',
  '   string or empty array.',
  '3. NO PARAPHRASE: `short` and `long` MUST NOT be near-verbatim restatements of the',
  '   fragment\'s opening sentence.',
  '4. SPECIFIC NOUNS: prefer concrete subjects (file names, symbols, model ids, error',
  '   codes, standards) over generic ones ("the system", "the document").',
  '5. COVERAGE: `questions` MUST spread across the DISTINCT aspects the fragment raises,',
  '   not restate one aspect many ways. Two questions answered by the same sentence are',
  '   one wasted question.',
  '6. NO MARKUP: plain text only. No markdown, no bullets, no quotes around whole fields.',
  '',
  'FIELD CONTRACT',
  '- short: ONE sentence, max 25 words. The line shown in a result list. States WHAT THIS',
  '  FRAGMENT ASSERTS, not what the document is about.',
  '- long: 2 to 4 sentences. Situates this fragment inside the whole document: which',
  '  SECTION it belongs to, what decision or fact it carries, what a reader would come',
  '  here for. This is the field allowed to add outside context from PATH, TITLE, SECTIONS.',
  '- doc_description: 1 to 2 sentences describing the WHOLE DOCUMENT, inferred from PATH,',
  '  TITLE and SECTIONS. Identical across fragments of one document is expected and correct.',
  '- keywords: exactly 10 entries. Noun phrases a searcher would type. Include SYNONYMS and',
  '  ALTERNATE SPELLINGS the fragment does not use (e2e / end-to-end; LLM / language model;',
  '  heart attack / myocardial infarction). Lowercase unless a proper noun. No duplicates,',
  '  no stopword-only entries, no phrases longer than 4 words.',
  '- questions: 12 to 15 natural questions this fragment ANSWERS, phrased in a USER\'s words,',
  '  not the document\'s. Each must be answerable from the fragment alone. Vary the opening',
  '  word. End each with a question mark.',
].join('\n');

/** The name the server echoes for the strict schema — one call, one shape. */
export const ENRICHMENT_SCHEMA_NAME = 'atom_enrichment';

/**
 * The five fields the MODEL produces. `additionalProperties: false` plus a
 * `required` naming all five is what makes `strict: true` a real contract: the
 * decoder cannot emit a sixth field, and it cannot omit one.
 */
export const ENRICHMENT_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['short', 'long', 'doc_description', 'keywords', 'questions'],
  properties: {
    short: { type: 'string' },
    long: { type: 'string' },
    doc_description: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
};

/** Stated when the atom's frontmatter carries no heading chain (plan D12b). */
export const NO_SECTIONS = '(none)';

/**
 * What makes a token an EXACT literal a user might PASTE — the `entities`
 * column, as patterns rather than as an instruction a model may paraphrase.
 * Modelled on the rare-term patterns `rephrase.ts` guards a query with, but a
 * separate set: that one decides whether to REWRITE a question, this one
 * decides what to INDEX, and welding them would make one file's tuning move the
 * other's behaviour.
 */
const ENTITY_PATTERNS: readonly RegExp[] = [
  /** camelCase / PascalCase boundary — `forEachLocale`, `buildFts5Index`. */
  /\p{Ll}\p{Lu}/u,
  /** snake_case — `origin_index`, `RUNNER_EVAL_CAPTURE`. */
  /[\p{L}\p{N}]_[\p{L}\p{N}]/u,
  /** A path — `db/idb.ts`, `src/cli/args.ts`. */
  /[\p{L}\p{N}]\/[\p{L}\p{N}]/u,
  /** `name.ext` — `package.json`, `config.yaml`. */
  /^[\p{L}\p{N}_-]+\.[A-Za-z]{1,6}$/u,
  /** A command-line flag — `--rerank`, `-k`. */
  /^--?[\p{L}\p{N}]/u,
  /** A dotted version — `1.2`, `v0.33.0`. */
  /^v?\p{N}+(?:\.\p{N}+)+$/u,
  /** A URL. */
  /^[a-z][a-z0-9+.-]*:\/\//iu,
  /** A number carrying a unit — `8192`ns style: `35.9tok`, `2000ms`, `50%`. */
  /^\p{N}+(?:[.,]\p{N}+)?(?:[\p{L}%]{1,8})$/u,
  /** ALLCAPS of three or more — `RRF`, `BM25`, `FTS5`. */
  /^[A-Z][A-Z\p{N}]{2,}$/u,
];

/** Sentence and markdown punctuation is not part of the term. */
const bareEntity = (token: string): string =>
  token.replace(/^[("'`[\]{*_<]+/u, '').replace(/[?!.,;:)"'`[\]{}*_>]+$/u, '');

const isEntity = (token: string): boolean =>
  token.length > 1 && ENTITY_PATTERNS.some(pattern => pattern.test(token));

/**
 * The literal tokens of a fragment, VERBATIM: case and inner punctuation are
 * preserved, duplicates are dropped, and the order is the order they appear in.
 * Deterministic by construction — the same body yields the same array on every
 * machine, with no call and no cost.
 */
export const extractEntities = (body: string): readonly string[] => [
  ...new Set(body.split(/\s+/u).map(bareEntity).filter(isEntity)),
];

/** One atom as the walk found it: where it lives, and what it holds. */
export interface AtomEntry {
  /** Atoms-dir-relative `.md` path — the `source` the record is stamped with. */
  readonly rel: string;
  readonly atom: Atom;
}

/** The SOURCE DOCUMENT this atom was cut from; the atom file itself when none. */
const sourceDocOf = (entry: AtomEntry): string => entry.atom.frontmatter.sources[0] ?? entry.rel;

/**
 * The user message, exactly as plan § 5 states it. SECTIONS is the atom's own
 * `heading_chain` — the document's authored facet structure, which is what rule
 * 5's coverage constraint spans.
 */
export const enrichmentUserMessage = (entry: AtomEntry): string =>
  [
    `PATH: ${sourceDocOf(entry)}`,
    `TITLE: ${entry.atom.frontmatter.title}`,
    `SECTIONS: ${entry.atom.frontmatter.heading_chain ?? NO_SECTIONS}`,
    '',
    'FRAGMENT:',
    entry.atom.body,
  ].join('\n');

const chatRequestFor = (entry: AtomEntry): ChatRequest => ({
  system: ENRICHMENT_SYSTEM_PROMPT,
  user: enrichmentUserMessage(entry),
  schema: ENRICHMENT_SCHEMA,
  schemaName: ENRICHMENT_SCHEMA_NAME,
});

const MARKDOWN_EXT = '.md';

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const markdownPaths = (atomsDir: string): readonly string[] =>
  existsSync(atomsDir)
    ? readdirSync(atomsDir, { recursive: true, encoding: 'utf8' })
        .filter(rel => rel.endsWith(MARKDOWN_EXT))
        .filter(rel => statSync(resolve(atomsDir, rel)).isFile())
        .sort(compareStrings)
    : []
  ;

const toEntry = (atomsDir: string, rel: string): AtomEntry | undefined => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, rel), 'utf8'));
  return parsed.ok ? { rel, atom: parsed.atom } : undefined;
};

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/** Sorted by relative path, so a resumed run walks the same order it stopped in. */
const collectAtoms = (atomsDir: string): readonly AtomEntry[] =>
  markdownPaths(atomsDir)
    .map(rel => toEntry(atomsDir, rel))
    .filter(isDefined);

/** The five fields as the model returned them, before `entities` is added. */
interface ModelFields {
  readonly short: string;
  readonly long: string;
  readonly doc_description: string;
  readonly keywords: readonly string[];
  readonly questions: readonly string[];
}

const isRecordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const stringField = (source: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
};

const listField = (
  source: Readonly<Record<string, unknown>>,
  name: string
): readonly string[] | undefined => {
  const value = source[name];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
};

/** The three prose fields, once each has proved to be a string. */
type ProseFields = Pick<ModelFields, 'short' | 'long' | 'doc_description'>;

/** The two list fields, added to prose that already checked out. */
const withLists = (
  source: Readonly<Record<string, unknown>>,
  prose: ProseFields
): ModelFields | undefined => {
  const keywords = listField(source, 'keywords');
  const questions = listField(source, 'questions');
  return keywords === undefined || questions === undefined
    ? undefined
    : { ...prose, keywords, questions };
};

const withProse = (source: Readonly<Record<string, unknown>>): ModelFields | undefined => {
  const short = stringField(source, 'short');
  const long = stringField(source, 'long');
  const doc_description = stringField(source, 'doc_description');
  return short === undefined || long === undefined || doc_description === undefined
    ? undefined
    : withLists(source, { short, long, doc_description });
};

/**
 * The answer re-checked in OUR types. `strict: true` already constrains the
 * decoder, but a provider that silently did not honour it would otherwise reach
 * the sidecar — and a wrong field is indistinguishable from a right one once it
 * is a column.
 */
const toModelFields = (value: unknown): ModelFields | undefined =>
  isRecordValue(value) ? withProse(value) : undefined;

const fieldsFor = (entry: AtomEntry, model: ModelFields): EnrichmentFields => ({
  ...model,
  entities: extractEntities(entry.atom.body),
});

const recordFor = (entry: AtomEntry, model: ModelFields, generator: string): EnrichmentRecord => ({
  ...fieldsFor(entry, model),
  key: atomKeyOf(entry.atom.body),
  docKey: docKeyOf(sourceDocOf(entry)),
  variant: 'solo',
  unit: 'atom',
  id: entry.atom.frontmatter.id,
  source: entry.rel,
  promptVersion: ENRICHMENT_PROMPT_VERSION,
  model: generator,
});

const schemaFailure = (entry: AtomEntry, generator: string): string =>
  `enrich: the answer for atom "${entry.atom.frontmatter.id}" (${entry.rel}) did not match the ` +
  `enrichment schema — "${generator}" did not honour response_format json_schema strict; ` +
  'no record was written, so re-running `enrich` retries exactly this atom.';

/** What one generation contributed, and the message that ended the run. */
interface RunState {
  readonly enriched: number;
  readonly failure: string | undefined;
}

const START: RunState = { enriched: 0, failure: undefined };

const appendRecord = (sidecarPath: string, record: EnrichmentRecord): void => {
  mkdirSync(dirname(sidecarPath), { recursive: true });
  appendFileSync(sidecarPath, serializeEnrichmentRecord(record), 'utf8');
};

/** What `enrichAtoms` needs, and nothing it could resolve for itself. */
export interface EnrichAtomsOptions {
  readonly atomsDir: string;
  readonly sidecarPath: string;
  readonly provider: ChatProvider;
  /** At most this many NOT-yet-fresh atoms — the E2 pilot bound. */
  readonly limit?: number | undefined;
  /** Where a progress line goes. Absent = a silent run; the library writes nothing. */
  readonly onProgress?: ((line: string) => void) | undefined;
}

/** What the run did, in the four numbers the command reports. */
export interface EnrichmentReport {
  readonly atoms: number;
  readonly enriched: number;
  /** Already fresh for this body, prompt version and model — no call was made. */
  readonly skipped: number;
  /** Stale atoms a `--limit` left for the next run; `0` without one. */
  readonly deferred: number;
  /** The refusal that STOPPED the run; `undefined` when every target succeeded. */
  readonly failure: string | undefined;
}

const generateOne = async (
  state: RunState,
  entry: AtomEntry,
  options: EnrichAtomsOptions
): Promise<RunState> => {
  const outcome = await options.provider.complete(chatRequestFor(entry));
  if (!outcome.ok) return { ...state, failure: outcome.error };
  const fields = toModelFields(outcome.value);
  if (fields === undefined)
    return { ...state, failure: schemaFailure(entry, options.provider.id) };
  appendRecord(options.sidecarPath, recordFor(entry, fields, options.provider.id));
  return { enriched: state.enriched + 1, failure: undefined };
};

/** How often a long run says where it is. An 11-hour silent run is unreadable. */
export const PROGRESS_EVERY = 25;

const MS_PER_SECOND = 1000;

const seconds = (ms: number): string => `${Math.round(ms / MS_PER_SECOND)}s`;

/**
 * Done / total / elapsed / projected remaining, from the run's OWN measured
 * rate — never a configured estimate, which would keep reading plausibly while
 * the real rate collapsed.
 */
export const progressLine = (done: number, total: number, elapsedMs: number): string => {
  const remaining = done === 0 ? 0 : (elapsedMs / done) * (total - done);
  return `enrich: ${done}/${total} atoms · elapsed ${seconds(elapsedMs)} · remaining ~${seconds(remaining)}`;
};

/** Where the run stands, as the three numbers a progress line is built from. */
interface Progress {
  readonly done: number;
  readonly total: number;
  readonly startedAt: number;
}

const report = (options: EnrichAtomsOptions, at: Progress): void => {
  if (options.onProgress === undefined || at.done === 0 || at.done % PROGRESS_EVERY !== 0) return;
  options.onProgress(progressLine(at.done, at.total, Date.now() - at.startedAt));
};

/**
 * SEQUENTIAL by construction: each step awaits the previous state before it
 * calls, so no two generations are ever in flight. A failure short-circuits
 * every remaining step without calling.
 */
const generateAll = async (
  targets: readonly AtomEntry[],
  options: EnrichAtomsOptions
): Promise<RunState> => {
  const startedAt = Date.now();
  return await targets.reduce<Promise<RunState>>(async (previous, entry, index) => {
    const state = await previous;
    if (state.failure !== undefined) return state;
    report(options, { done: index, total: targets.length, startedAt });
    return await generateOne(state, entry, options);
  }, Promise.resolve(START));
};

const isFresh = (
  sidecar: ReadonlyMap<string, EnrichmentRecord>,
  entry: AtomEntry,
  generator: string
): boolean => {
  const record = sidecar.get(entry.atom.frontmatter.id);
  return (
    record !== undefined &&
    isEnrichmentFresh(record, atomKeyOf(entry.atom.body), ENRICHMENT_PROMPT_VERSION, generator)
  );
};

/**
 * Walk the atoms, skip what is already fresh, generate the rest one at a time,
 * appending each record as it lands. The sidecar is re-read at the start of
 * every run, so an interrupted run resumes from what it already wrote.
 */
export const enrichAtoms = async (options: EnrichAtomsOptions): Promise<EnrichmentReport> => {
  const entries = collectAtoms(options.atomsDir);
  const sidecar = loadEnrichmentSidecar(options.sidecarPath);
  const stale = entries.filter(entry => !isFresh(sidecar, entry, options.provider.id));
  const targets = options.limit === undefined ? stale : stale.slice(0, options.limit);
  const run = await generateAll(targets, options);
  return {
    atoms: entries.length,
    enriched: run.enriched,
    skipped: entries.length - stale.length,
    deferred: stale.length - targets.length,
    failure: run.failure,
  };
};
