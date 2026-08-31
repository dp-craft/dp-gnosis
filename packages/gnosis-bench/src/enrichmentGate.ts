/**
 * The E2 PILOT GATE — `docs/plans/2026-08-22-1709-dp-gnosis-ingest-enrichment.md`
 * § 11.2, computed over an enrichment sidecar that has ALREADY been written.
 *
 * It is a MEASUREMENT script: it reads the sidecar and the atoms it names,
 * prints numbers, and exits. It writes nothing, mutates nothing, calls no model
 * and runs no benchmark — so it can be re-run over a half-finished pilot as
 * often as wanted without disturbing the run that is producing it.
 *
 * WHY IT USES THE ENGINE'S OWN ANALYZER. Every gate below asks whether a stem
 * "occurs in the fragment". A second stemmer would answer that question about a
 * vocabulary the index has never seen, so a keyword the index treats as present
 * could be counted novel here (or the reverse) and the whole novel-term
 * mechanism would be measured against the wrong dictionary. `analyze(text,
 * 'porter-fold')` is the SAME function the fts5 build and the query path call,
 * so "absent from the fragment" means here exactly what it means at retrieval.
 *
 * WHAT IT REFUSES TO HIDE. An atom file the sidecar names but that cannot be
 * read, and a record whose fragment cannot be parsed, are REPORTED by id and
 * excluded from the rates by name — never silently dropped into a denominator.
 * "A component produced nothing and the pipeline recorded it as data" is this
 * project's recurring failure, and a quietly shrinking denominator is that
 * failure wearing a percentage sign.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. Gate (d) has NO reference arm: phase T0
 * was skipped, so there is no prior measurement to take a "within 20 % relative"
 * distance from. The (d) block therefore prints ABSOLUTE rates and says so.
 * The novel-term definition is also printed BOTH ways — the plan's wording ("the
 * keyword whose stem does not occur") is ambiguous between "shares no stem at
 * all" and "has at least one stem absent", and the two differ by a large factor
 * on multi-word keywords. Picking one silently would over- or under-state the
 * mechanism the whole treatment rests on.
 *
 * EXIT CODES: 0 — the measurement ran (a FAILING gate still exits 0; the verdict
 * is the printed text, not the status). 2 — unusable invocation or an
 * unreadable atoms directory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseAtom } from '../../gnosis/src/atom.js';
import {
  type EnrichmentRecord,
  loadEnrichmentSidecar
} from '../../gnosis/src/enrichment.js';
import { analyze } from '../../gnosis/src/query.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';

/** The measurement ran and the report was written. */
export const ENRICHMENT_GATE_EXIT_OK = 0;

/** Unusable invocation, or the sidecar/atoms directory could not be read. */
export const ENRICHMENT_GATE_EXIT_USAGE = 2;

/** § 11.2 (c): fewer than 12 of 100 offenders passes. Scaled when N is not 100. */
export const GATE_OFFENDER_LIMIT_PER_100 = 12;

/** § 11.2 (c): a shared run of this many CONSECUTIVE stems is near-verbatim. */
export const PARAPHRASE_RUN_STEMS = 8;

/** The paraphrase comparison window: the fragment's opening sentences. */
export const OPENING_SENTENCES = 2;

/** § 5 schema: `short` is capped at this many words. */
export const SHORT_MAX_WORDS = 25;

/** § 5 schema: exactly this many keywords. */
export const KEYWORDS_EXPECTED = 10;

/** § 5 schema: the inclusive question-count band. */
export const QUESTIONS_MIN = 12;
export const QUESTIONS_MAX = 15;

/** How many offending ids to name per line — enough to start a diagnosis. */
const IDS_SHOWN = 5;

const ANALYZER = 'porter-fold';
const SENTENCE_SPLIT = /(?<=[.!?])\s+/u;
const WORD_SPLIT = /\s+/u;

/**
 * The document-level generality predicate. A `short` that talks ABOUT the
 * document ("this fragment describes…") instead of about its subject carries no
 * retrievable vocabulary — it is the failure § 11.2 (c) counts.
 */
export const isDocumentLevelGenerality = (short: string): boolean =>
  /\b(this|the)\s+(document|fragment|text|passage|article|section)\b/i.test(short);

/**
 * The longest run of CONSECUTIVE stems shared by two analyzed texts — a classic
 * longest-common-substring scan carried as one row of the DP table at a time, so
 * the whole matrix is never held. Returns a stem count, not a ratio: § 11.2 (c)
 * is stated as an absolute run length.
 */
export const maxStemRun = (a: readonly string[], b: readonly string[]): number => {
  const zero: readonly number[] = b.map(() => 0);
  const state = a.reduce<{ readonly prev: readonly number[]; readonly best: number }>(
    (acc, stem) => {
      const row = b.map((other, j) => (other === stem ? (acc.prev[j - 1] ?? 0) + 1 : 0));
      return { prev: row, best: row.reduce((max, run) => Math.max(max, run), acc.best) };
    },
    { prev: zero, best: 0 }
  );
  return state.best;
};

/** The fragment window the paraphrase gate compares against. */
export const openingSentences = (body: string, count: number): string =>
  body.trim().split(SENTENCE_SPLIT).slice(0, count).join(' ');

/** One record joined to the fragment the model actually read. */
interface Resolved {
  readonly record: EnrichmentRecord;
  readonly fragment: string;
}

/** A record whose fragment could NOT be obtained, kept so it can be NAMED. */
interface Unresolved {
  readonly record: EnrichmentRecord;
  readonly reason: string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readFragment = (atomsDir: string, source: string): Resolved['fragment'] => {
  const parsed = parseAtom(readFileSync(resolve(atomsDir, source), 'utf8'));
  if (!parsed.ok) throw new Error(`unparseable atom: ${parsed.error}`);
  return parsed.atom.body;
};

const resolveOne = (atomsDir: string, record: EnrichmentRecord): Resolved | Unresolved => {
  try {
    return { record, fragment: readFragment(atomsDir, record.source) };
  } catch (error) {
    return { record, reason: messageOf(error) };
  }
};

const isResolved = (value: Resolved | Unresolved): value is Resolved =>
  Object.hasOwn(value, 'fragment');

const isUnresolved = (value: Resolved | Unresolved): value is Unresolved =>
  !isResolved(value);

const isBlank = (value: string): boolean => value.trim().length === 0;

/** Every field the schema requires to carry text, as text. */
const textFieldsOf = (record: EnrichmentRecord): readonly string[] => [
  record.short,
  record.long,
  record.doc_description,
  ...record.keywords,
  ...record.entities,
  ...record.questions,
];

const hasEmptyField = (record: EnrichmentRecord): boolean =>
  record.keywords.length === 0 ||
  record.questions.length === 0 ||
  textFieldsOf(record).some(isBlank);

const wordCount = (text: string): number =>
  text.trim().split(WORD_SPLIT).filter(word => word.length > 0).length;

const overLongShort = (record: EnrichmentRecord): boolean =>
  wordCount(record.short) > SHORT_MAX_WORDS;

const badQuestionCount = (record: EnrichmentRecord): boolean =>
  record.questions.length < QUESTIONS_MIN || record.questions.length > QUESTIONS_MAX;

const badKeywordCount = (record: EnrichmentRecord): boolean =>
  record.keywords.length !== KEYWORDS_EXPECTED;

/** A named offender set: how many, and the first few ids to look at. */
interface Offenders {
  readonly label: string;
  readonly ids: readonly string[];
}

const offendersOf = (
  label: string,
  records: readonly EnrichmentRecord[],
  predicate: (record: EnrichmentRecord) => boolean
): Offenders => ({ label, ids: records.filter(predicate).map(record => record.id) });

const countLine = (offenders: Offenders, total: number): string => {
  const shown = offenders.ids.slice(0, IDS_SHOWN);
  const tail = shown.length === 0 ? '' : `   first: ${shown.join(', ')}`;
  return `${offenders.label}: ${offenders.ids.length} / ${total}${tail}`;
};

/** A record's paraphrase run against its own fragment's opening sentences. */
const runOf = (entry: Resolved): number =>
  maxStemRun(
    analyze(entry.record.long, ANALYZER),
    analyze(openingSentences(entry.fragment, OPENING_SENTENCES), ANALYZER)
  );

const ratio = (part: number, whole: number): string =>
  whole === 0 ? 'n/a (no records)' : (part / whole).toFixed(4);

/** Fraction of `keywords` sharing NO stem at all with the fragment. */
const strictNovel = (keywords: readonly string[], stems: ReadonlySet<string>): number =>
  keywords.filter(keyword => analyze(keyword, ANALYZER).every(stem => !stems.has(stem)))
    .length;

/** Fraction of `keywords` with at least ONE stem absent from the fragment. */
const partialNovel = (keywords: readonly string[], stems: ReadonlySet<string>): number =>
  keywords.filter(keyword => analyze(keyword, ANALYZER).some(stem => !stems.has(stem)))
    .length;

/** The two counters a vocabulary reading accumulates over one record. */
interface Tally {
  readonly hits: number;
  readonly total: number;
}

const addTally = (a: Tally, b: Tally): Tally => ({
  hits: a.hits + b.hits,
  total: a.total + b.total,
});

const EMPTY_TALLY: Tally = { hits: 0, total: 0 };

const sumTallies = (tallies: readonly Tally[]): Tally => tallies.reduce(addTally, EMPTY_TALLY);

const questionTally = (questions: readonly string[], stems: ReadonlySet<string>): Tally => {
  const all = questions.flatMap(question => analyze(question, ANALYZER));
  return { hits: all.filter(stem => stems.has(stem)).length, total: all.length };
};

/** The three vocabulary readings for one resolved record. */
interface Vocabulary {
  readonly strict: Tally;
  readonly partial: Tally;
  readonly questions: Tally;
}

const vocabularyOf = (entry: Resolved): Vocabulary => {
  const stems = new Set(analyze(entry.fragment, ANALYZER));
  const keywords = entry.record.keywords;
  return {
    strict: { hits: strictNovel(keywords, stems), total: keywords.length },
    partial: { hits: partialNovel(keywords, stems), total: keywords.length },
    questions: questionTally(entry.record.questions, stems),
  };
};

/** The § 11.2 (c) threshold, scaled off 100 when the pilot is a different size. */
export const scaledLimit = (total: number): number =>
  (GATE_OFFENDER_LIMIT_PER_100 * total) / 100;

const gateLine = (label: string, offenders: number, total: number): string => {
  const limit = scaledLimit(total);
  const verdict = offenders < limit ? 'PASS' : 'FAIL';
  const scaled = total === 100 ? '' : ` (scaled to N=${total}: < ${limit.toFixed(2)})`;
  return `${label}: ${offenders} / ${total}   GATE: < ${GATE_OFFENDER_LIMIT_PER_100}${scaled}   ${verdict}`;
};

const headerLines = (sidecar: string, atomsDir: string, total: number): readonly string[] => [
  '== E2 pilot gate (§ 11.2) — enrichment sidecar measurement ==',
  `sidecar : ${sidecar}`,
  `atomsDir: ${atomsDir}`,
  `records : ${total}`,
  `analyzer: ${ANALYZER} (the engine's own — "stem occurs in the fragment" means here what it means in the index)`,
  '',
];

const unresolvedLines = (unresolved: readonly Unresolved[], total: number): readonly string[] => [
  '-- fragment resolution (reported, never silently dropped) --',
  `unreadable / unparseable atoms: ${unresolved.length} / ${total}`,
  ...unresolved.map(entry => `  MISSING  ${entry.record.id}  (${entry.record.source})  ${entry.reason}`),
  '',
];

const schemaLines = (records: readonly EnrichmentRecord[]): readonly string[] => [
  '-- (a) schema --',
  countLine(offendersOf('records with ANY empty field', records, hasEmptyField), records.length),
  countLine(
    offendersOf(`questions outside ${QUESTIONS_MIN}-${QUESTIONS_MAX}`, records, badQuestionCount),
    records.length
  ),
  countLine(
    offendersOf(`keywords != ${KEYWORDS_EXPECTED}`, records, badKeywordCount),
    records.length
  ),
  countLine(
    offendersOf(`short over ${SHORT_MAX_WORDS} words`, records, overLongShort),
    records.length
  ),
  '',
];

const paraphraseLines = (resolved: readonly Resolved[]): readonly string[] => {
  const runs = resolved.map(runOf);
  const verbatim = runs.filter(run => run >= PARAPHRASE_RUN_STEMS).length;
  const general = resolved.filter(entry => isDocumentLevelGenerality(entry.record.short)).length;
  return [
    '-- (c) paraphrase / generality — the PASS/FAIL gates --',
    gateLine(
      `long near-verbatim (run >= ${PARAPHRASE_RUN_STEMS} stems vs opening ${OPENING_SENTENCES} sentences)`,
      verbatim,
      resolved.length
    ),
    gateLine('short document-level generality', general, resolved.length),
    '',
  ];
};

const vocabularyLines = (resolved: readonly Resolved[]): readonly string[] => {
  const readings = resolved.map(vocabularyOf);
  const strict = sumTallies(readings.map(reading => reading.strict));
  const partial = sumTallies(readings.map(reading => reading.partial));
  const questions = sumTallies(readings.map(reading => reading.questions));
  const runs = resolved.map(runOf);
  return [
    '-- (d) vocabulary — ABSOLUTE rates --',
    'NO T0 reference exists to compare against: phase T0 was deliberately skipped, so there is',
    'no prior arm and the § 11.2 (d) "within 20 % relative" test CANNOT be evaluated here.',
    `novel-term rate STRICT  (keyword shares NO stem with the fragment): ${ratio(strict.hits, strict.total)}  (${strict.hits} / ${strict.total} keywords)`,
    `novel-term rate PARTIAL (keyword has >= 1 stem absent)            : ${ratio(partial.hits, partial.total)}  (${partial.hits} / ${partial.total} keywords)`,
    `question-overlap rate (question stems occurring in the fragment)  : ${ratio(questions.hits, questions.total)}  (${questions.hits} / ${questions.total} stems)`,
    `max paraphrase run observed                                       : ${runs.reduce((max, run) => Math.max(max, run), 0)} stems`,
    '',
  ];
};

/** The whole report, as lines — pure, so a test can read it without a process. */
export const gateReport = (
  sidecar: string,
  atomsDir: string,
  records: readonly EnrichmentRecord[]
): readonly string[] => {
  const entries = records.map(record => resolveOne(atomsDir, record));
  const resolved = entries.filter(isResolved);
  return [
    ...headerLines(sidecar, atomsDir, records.length),
    ...unresolvedLines(entries.filter(isUnresolved), records.length),
    ...schemaLines(records),
    ...paraphraseLines(resolved),
    ...vocabularyLines(resolved),
  ];
};

export const ENRICHMENT_GATE_HELP =
  'usage: npm run gnosis:enrichgate -- <sidecar.jsonl> <atomsDir>\n';

/**
 * Both inputs are POSITIONAL, so the only flag is `--help` — every other
 * `--token` reached the positional slots as if it were a path.
 */
export const ENRICHMENT_GATE_FLAGS: FlagSpec = { value: [], boolean: ['--help'] };

export const main = (argv: readonly string[]): number => {
  assertKnownFlags(argv, ENRICHMENT_GATE_FLAGS);
  const [sidecar, atomsDir] = argv;
  if (sidecar === undefined || atomsDir === undefined || argv.includes('--help')) {
    process.stdout.write(ENRICHMENT_GATE_HELP);
    return ENRICHMENT_GATE_EXIT_USAGE;
  }
  const records = [...loadEnrichmentSidecar(resolve(sidecar)).values()];
  process.stdout.write(`${gateReport(sidecar, atomsDir, records).join('\n')}\n`);
  return ENRICHMENT_GATE_EXIT_OK;
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
