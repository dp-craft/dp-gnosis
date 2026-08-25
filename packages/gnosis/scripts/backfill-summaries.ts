/**
 * Backfill a one-line `<!-- LLM-PRIMARY: … -->` summary into source documents
 * that declared none, and patch the resulting `summary:` scalar into the atoms
 * those documents ALREADY produced.
 *
 * Why it patches instead of re-ingesting. A re-ingest would rewrite the whole
 * vault, folding in every unrelated document change since the last ingest and
 * destroying the byte-identity control this task depends on. So the script does
 * the narrowest possible thing: it writes ONE comment into the source, then
 * inserts EXACTLY ONE frontmatter line into each of that source's atoms, and it
 * verifies that claim line-by-line before writing (`patchAtomSummary`). Any
 * other difference leaves the atom untouched and is recorded as a failure.
 *
 * The summary text is sanitized so it is byte-identical to what `ingest.ts`
 * would recover from the comment written here — that round-trip is the point of
 * `sanitizeSummary`, and `tests/backfillSummaries.test.ts` asserts it.
 *
 *   npx tsx packages/gnosis/scripts/backfill-summaries.ts --dry-run --json
 *
 * Exit codes: 0 every target resolved · 3 partial (something failed, all
 * recorded) · 2 usage error.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Atom, parseAtom, serializeAtom } from '../src/atom.js';

/** One line of plain text, no markdown, no comment markers — see `sanitizeSummary`. */
export const SYSTEM_PROMPT = [
  'You summarize a technical document in exactly one line of plain text.',
  'State what the document is and when a reader should open it.',
  'Use at most 200 characters.',
  'Output the line only: no markdown, no quotes, no preamble, no trailing notes.',
  'Never output the characters <!-- or -->.',
].join(' ');

const MAX_SUMMARY_CHARS = 240;
const SUMMARY_MARKER = '<!-- LLM-PRIMARY:';
const COMMENT_MARKER_RE = /<!--|-->/g;
const WHITESPACE_RUN_RE = /\s+/g;
/** The recovery regex `ingest.ts` uses — mirrored so the round-trip test is exact. */
const INGEST_SUMMARY_RE = /<!--\s*LLM-PRIMARY:\s*([\s\S]*?)-->/;
const PROGRESS_EVERY = 25;
const MAX_TOKENS = 120;
const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const P95 = 0.95;
const MEDIAN = 0.5;
const EXIT_PARTIAL = 3;
const EXIT_USAGE = 2;

const DEFAULTS = {
  atomsDir: 'dp-gnosis/vault/atoms',
  model: 'qwen35b-a3b-q5km-ctx130k-mtp-sharp-coding',
  url: 'http://127.0.0.1:9292',
  headChars: 4000,
} as const;

const USAGE = `backfill-summaries — generate a one-line LLM-PRIMARY summary per source document
  --atoms-dir <dir>   atoms directory (default ${DEFAULTS.atomsDir})
  --repo-root <dir>   root the atom source paths are relative to (default cwd)
  --model <id>        chat model id (default ${DEFAULTS.model})
  --url <base>        OpenAI-compatible base url (default ${DEFAULTS.url})
  --head-chars <n>    characters of the document sent to the model (default ${DEFAULTS.headChars})
  --limit <n>         process at most n source documents
  --dry-run           compute everything, write nothing
  --json              print the whole report as one JSON object on stdout
  --help              this text
exit 0 all resolved · 3 partial (failures recorded) · 2 usage error
`;

/* ------------------------------------------------------------------ summary */

const truncateAtWord = (text: string): string => {
  const head = text.slice(0, MAX_SUMMARY_CHARS);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim();
};

/**
 * The one place summary text is normalized: comment markers removed (they would
 * close the comment early), whitespace collapsed to single spaces, trimmed, and
 * capped at a word boundary. Empty in, `undefined` out — a blank summary line is
 * worse than none.
 */
export const sanitizeSummary = (raw: string): string | undefined => {
  const collapsed = raw.replace(COMMENT_MARKER_RE, '').replace(WHITESPACE_RUN_RE, ' ').trim();
  const capped = collapsed.length > MAX_SUMMARY_CHARS ? truncateAtWord(collapsed) : collapsed;
  return capped.length > 0 ? capped : undefined;
};

/** The summary `ingest.ts` would recover from a document, byte for byte. */
export const recoverSummary = (documentText: string): string | undefined => {
  const raw = INGEST_SUMMARY_RE.exec(documentText)?.[1] ?? '';
  const collapsed = raw.replace(WHITESPACE_RUN_RE, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
};

/** Prepends the comment. A document that already declares one is returned VERBATIM. */
export const insertSummaryComment = (documentText: string, summary: string): string =>
  documentText.includes(SUMMARY_MARKER)
    ? documentText
    : `${SUMMARY_MARKER} ${summary} -->\n\n${documentText}`;

/* --------------------------------------------------------------------- atom */

/** The outcome of patching one atom; a refusal leaves the file untouched. */
export type PatchAtomResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const insertionIndex = (before: readonly string[], after: readonly string[]): number => {
  const index = before.findIndex((line, position) => line !== after[position]);
  return index < 0 ? before.length : index;
};

/** True only when `after` is `before` with ONE `line` inserted and nothing else moved. */
const isSingleInsertion = (
  before: readonly string[],
  after: readonly string[],
  line: string
): boolean => {
  const at = insertionIndex(before, after);
  return after[at] === line && before.slice(at).join('\n') === after.slice(at + 1).join('\n');
};

const rewriteAtom = (atom: Atom, summary: string, original: string): PatchAtomResult => {
  const text = serializeAtom({ ...atom.frontmatter, summary }, atom.body);
  return isSingleInsertion(original.split('\n'), text.split('\n'), `summary: ${summary}`)
    ? { ok: true, text }
    : { ok: false, error: 'unexpected-rewrite' };
};

/**
 * Insert `summary:` into one atom. The serialized result is diffed against the
 * input line-by-line: a re-serialization that would touch anything BUT the new
 * line is refused, because this script has no mandate to rewrite atoms.
 */
export const patchAtomSummary = (atomText: string, summary: string): PatchAtomResult => {
  const parsed = parseAtom(atomText);
  if (!parsed.ok) return { ok: false, error: `parse-failed: ${parsed.error}` };
  return parsed.atom.frontmatter.summary === undefined
    ? rewriteAtom(parsed.atom, summary, atomText)
    : { ok: false, error: 'already-has-summary' };
};

/* ------------------------------------------------------------------ targets */

/** Source documents needing a summary, and the summary-less atoms each produced. */
export interface BackfillTargets {
  readonly sources: readonly string[];
  readonly atomsBySource: ReadonlyMap<string, readonly string[]>;
}

interface NamedAtom {
  readonly name: string;
  readonly atom: Atom;
}

const summarylessAtom = (text: string): Atom | undefined => {
  const parsed = parseAtom(text);
  return parsed.ok && parsed.atom.frontmatter.summary === undefined ? parsed.atom : undefined;
};

const readNamedAtom = (atomsDir: string, name: string): NamedAtom | undefined => {
  const atom = summarylessAtom(readFileSync(join(atomsDir, name), 'utf8'));
  return atom === undefined ? undefined : { name, atom };
};

const groupBySource = (entries: readonly NamedAtom[]): ReadonlyMap<string, readonly string[]> =>
  entries.reduce<Map<string, readonly string[]>>((map, entry) => {
    const source = entry.atom.frontmatter.sources[0] ?? '';
    return source.length === 0 ? map : map.set(source, [...(map.get(source) ?? []), entry.name]);
  }, new Map());

/** Scan an atoms directory. Unparseable and already-summarized atoms are ignored. */
export const collectTargets = (atomsDir: string): BackfillTargets => {
  const named = readdirSync(atomsDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => readNamedAtom(atomsDir, name))
    .filter((entry): entry is NamedAtom => entry !== undefined);
  const atomsBySource = groupBySource(named);
  return { sources: [...atomsBySource.keys()].sort(), atomsBySource };
};

/* ---------------------------------------------------------------- generator */

/** A successful generation, with whatever accounting the server reported. */
export interface GenerateOk {
  readonly ok: true;
  readonly summary: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly promptPerSecond?: number | undefined;
}

/** A refusal. It is recorded and the document is skipped — never a throw. */
export interface GenerateFailure {
  readonly ok: false;
  readonly error: string;
}

/** Injected so the suite needs no network. */
export type SummaryGenerator = (
  repoRelPath: string,
  headText: string
) => Promise<GenerateOk | GenerateFailure>;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const readNumber = (
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): number | undefined => {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
};

const firstChoice = (payload: unknown): Readonly<Record<string, unknown>> | undefined => {
  const choices = asRecord(payload)?.['choices'];
  return Array.isArray(choices) ? asRecord(choices[0]) : undefined;
};

const readContent = (payload: unknown): string | undefined => {
  const content = asRecord(firstChoice(payload)?.['message'])?.['content'];
  return typeof content === 'string' ? content : undefined;
};

const chatBody = (model: string, repoRelPath: string, headText: string): unknown => ({
  model,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Document path: ${repoRelPath}\n\n${headText}` },
  ],
  max_tokens: MAX_TOKENS,
  temperature: 0,
  // MANDATORY and measured: this is a reasoning model, and without it the text
  // lands in `reasoning_content` while `message.content` comes back EMPTY.
  chat_template_kwargs: { enable_thinking: false },
});

type PostResult = { readonly ok: true; readonly payload: unknown } | GenerateFailure;

const postChat = async (endpoint: string, body: unknown): Promise<PostResult> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))));
  if (response instanceof Error) return { ok: false, error: `network: ${response.message}` };
  if (!response.ok) return { ok: false, error: `http-${response.status}` };
  const payload = await response.json().catch(() => undefined);
  return payload === undefined ? { ok: false, error: 'invalid-json' } : { ok: true, payload };
};

const section = (payload: unknown, key: string): Readonly<Record<string, unknown>> | undefined =>
  asRecord(asRecord(payload)?.[key]);

const generatedFrom = (payload: unknown, content: string): GenerateOk => ({
  ok: true,
  summary: content,
  promptTokens: readNumber(section(payload, 'usage'), 'prompt_tokens') ?? 0,
  completionTokens: readNumber(section(payload, 'usage'), 'completion_tokens') ?? 0,
  promptPerSecond: readNumber(section(payload, 'timings'), 'prompt_per_second'),
});

const toGenerated = (payload: unknown): GenerateOk | GenerateFailure => {
  const content = readContent(payload);
  return content === undefined || content.trim().length === 0
    ? { ok: false, error: 'empty-content' }
    : generatedFrom(payload, content);
};

/** The shipped generator: one chat completion per document, failures returned not thrown. */
export const createHttpGenerator = (model: string, url: string): SummaryGenerator => {
  return async (repoRelPath, headText) => {
    const posted = await postChat(`${url}/v1/chat/completions`, chatBody(model, repoRelPath, headText));
    return posted.ok ? toGenerated(posted.payload) : posted;
  };
};

/* ------------------------------------------------------------------ options */

/** Everything `runBackfill` needs; the generator is injected. */
export interface BackfillOptions {
  readonly atomsDir: string;
  readonly repoRoot: string;
  readonly headChars: number;
  readonly dryRun: boolean;
  readonly generate: SummaryGenerator;
  readonly limit?: number | undefined;
}

/** One atom that refused its patch. */
export interface AtomFailure {
  readonly atom: string;
  readonly error: string;
}

/** What happened to one source document. */
export interface DocumentOutcome {
  readonly source: string;
  readonly status: 'generated' | 'already-annotated' | 'failed';
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  readonly atomsPatched: number;
  readonly atomFailures: readonly AtomFailure[];
}

/** Wall-clock accounting. The COLD call is measured apart and excluded from the rest. */
export interface BackfillTiming {
  readonly coldMs: number;
  readonly count: number;
  readonly wallSeconds: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly docsPerMinute: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly meanPromptTokensPerSecond: number;
}

/** The whole run, printable as one JSON object under `--json`. */
export interface BackfillReport {
  readonly dryRun: boolean;
  readonly totalSources: number;
  readonly processed: number;
  readonly generated: number;
  readonly alreadyAnnotated: number;
  readonly failed: number;
  readonly atomsPatched: number;
  readonly atomFailures: number;
  readonly documents: readonly DocumentOutcome[];
  readonly timing: BackfillTiming;
}

/* -------------------------------------------------------------------- timing */

interface Sample {
  readonly ms: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly promptPerSecond: number | undefined;
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

const quantile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const warmTiming = (warm: readonly Sample[], coldMs: number): BackfillTiming => {
  const sorted = [...warm.map(s => s.ms)].sort((a, b) => a - b);
  const wallSeconds = sum(sorted) / MILLIS_PER_SECOND;
  const rates = warm.map(s => s.promptPerSecond).filter((r): r is number => r !== undefined);
  return {
    coldMs,
    count: warm.length,
    wallSeconds,
    meanMs: ratio(sum(sorted), sorted.length),
    medianMs: quantile(sorted, MEDIAN),
    p95Ms: quantile(sorted, P95),
    docsPerMinute: ratio(warm.length * SECONDS_PER_MINUTE, wallSeconds),
    promptTokens: sum(warm.map(s => s.promptTokens)),
    completionTokens: sum(warm.map(s => s.completionTokens)),
    meanPromptTokensPerSecond: ratio(sum(rates), rates.length),
  };
};

const timingOf = (samples: readonly Sample[]): BackfillTiming =>
  warmTiming(samples.slice(1), samples[0]?.ms ?? 0);

/* --------------------------------------------------------------------- run */

interface SourceResult {
  readonly outcome: DocumentOutcome;
  readonly sample: Sample | undefined;
}

interface PatchTally {
  readonly atomsPatched: number;
  readonly atomFailures: readonly AtomFailure[];
}

const EMPTY_TALLY: PatchTally = { atomsPatched: 0, atomFailures: [] };

const patchOne = async (
  path: string,
  summary: string,
  dryRun: boolean
): Promise<string | undefined> => {
  const patched = patchAtomSummary(await readFile(path, 'utf8'), summary);
  if (!patched.ok) return patched.error;
  if (!dryRun) await writeFile(path, patched.text, 'utf8');
  return undefined;
};

const tally = (previous: PatchTally, atom: string, error: string | undefined): PatchTally =>
  error === undefined
    ? { ...previous, atomsPatched: previous.atomsPatched + 1 }
    : { ...previous, atomFailures: [...previous.atomFailures, { atom, error }] };

const patchAtoms = async (
  atoms: readonly string[],
  summary: string,
  options: BackfillOptions
): Promise<PatchTally> =>
  await atoms.reduce<Promise<PatchTally>>(
    async (previous, atom) =>
      tally(
        await previous,
        atom,
        await patchOne(join(options.atomsDir, atom), summary, options.dryRun)
      ),
    Promise.resolve(EMPTY_TALLY)
  );

const failedOutcome = (source: string, error: string): SourceResult => ({
  outcome: { source, status: 'failed', error, atomsPatched: 0, atomFailures: [] },
  sample: undefined,
});

const resolvedOutcome = async (
  source: string,
  summary: string,
  context: { readonly atoms: readonly string[]; readonly options: BackfillOptions; readonly status: DocumentOutcome['status'] }
): Promise<DocumentOutcome> => ({
  source,
  status: context.status,
  summary,
  ...(await patchAtoms(context.atoms, summary, context.options)),
});

const sampleOf = (generated: GenerateOk, ms: number): Sample => ({
  ms,
  promptTokens: generated.promptTokens,
  completionTokens: generated.completionTokens,
  promptPerSecond: generated.promptPerSecond,
});

/** Already annotated: never re-generated. Its atoms are still patched from the comment it carries. */
const takeExisting = async (
  source: string,
  text: string,
  context: { readonly atoms: readonly string[]; readonly options: BackfillOptions }
): Promise<SourceResult> => {
  const summary = recoverSummary(text);
  if (summary === undefined) {
    return {
      outcome: { source, status: 'already-annotated', atomsPatched: 0, atomFailures: [] },
      sample: undefined,
    };
  }
  const status: DocumentOutcome['status'] = 'already-annotated';
  return {
    outcome: await resolvedOutcome(source, summary, { ...context, status }),
    sample: undefined,
  };
};

const writeSource = async (path: string, text: string, options: BackfillOptions): Promise<void> => {
  if (!options.dryRun) await writeFile(path, text, 'utf8');
};

const takeGenerated = async (
  source: string,
  generated: GenerateOk,
  context: { readonly atoms: readonly string[]; readonly options: BackfillOptions; readonly text: string; readonly ms: number }
): Promise<SourceResult> => {
  const summary = sanitizeSummary(generated.summary);
  const sample = sampleOf(generated, context.ms);
  if (summary === undefined) return { ...failedOutcome(source, 'empty-summary'), sample };
  const path = join(context.options.repoRoot, source);
  await writeSource(path, insertSummaryComment(context.text, summary), context.options);
  const status: DocumentOutcome['status'] = 'generated';
  return { outcome: await resolvedOutcome(source, summary, { ...context, status }), sample };
};

const generateFor = async (
  source: string,
  text: string,
  context: { readonly atoms: readonly string[]; readonly options: BackfillOptions }
): Promise<SourceResult> => {
  const startedAt = Date.now();
  const generated = await context.options.generate(source, text.slice(0, context.options.headChars));
  const ms = Date.now() - startedAt;
  return generated.ok
    ? await takeGenerated(source, generated, { ...context, text, ms })
    : {
        ...failedOutcome(source, generated.error),
        sample: { ms, promptTokens: 0, completionTokens: 0, promptPerSecond: undefined },
      };
};

const readSource = async (path: string): Promise<string | undefined> =>
  await readFile(path, 'utf8').catch(() => undefined);

const processSource = async (
  source: string,
  atoms: readonly string[],
  options: BackfillOptions
): Promise<SourceResult> => {
  const text = await readSource(join(options.repoRoot, source));
  if (text === undefined) return failedOutcome(source, 'read-failed');
  return text.includes(SUMMARY_MARKER)
    ? await takeExisting(source, text, { atoms, options })
    : await generateFor(source, text, { atoms, options });
};

interface RunState {
  readonly outcomes: readonly DocumentOutcome[];
  readonly samples: readonly Sample[];
}

const EMPTY_RUN: RunState = { outcomes: [], samples: [] };

interface RunContext {
  readonly sources: readonly string[];
  readonly targets: BackfillTargets;
  readonly options: BackfillOptions;
  readonly startedAt: number;
}

const reportProgress = (context: RunContext, done: number): void => {
  const elapsed = (Date.now() - context.startedAt) / MILLIS_PER_SECOND;
  const eta = ratio(elapsed, done) * (context.sources.length - done);
  process.stderr.write(
    `[backfill] ${done}/${context.sources.length} elapsed ${elapsed.toFixed(1)}s eta ${eta.toFixed(1)}s\n`
  );
};

const maybeProgress = (context: RunContext, done: number): void => {
  if (done % PROGRESS_EVERY === 0) reportProgress(context, done);
};

const appendResult = (state: RunState, result: SourceResult): RunState => ({
  outcomes: [...state.outcomes, result.outcome],
  samples: result.sample === undefined ? state.samples : [...state.samples, result.sample],
});

const advance = async (state: RunState, context: RunContext, index: number): Promise<RunState> => {
  const source = context.sources[index] ?? '';
  const atoms = context.targets.atomsBySource.get(source) ?? [];
  const next = appendResult(state, await processSource(source, atoms, context.options));
  maybeProgress(context, index + 1);
  return next;
};

const countBy = (outcomes: readonly DocumentOutcome[], status: DocumentOutcome['status']): number =>
  outcomes.filter(outcome => outcome.status === status).length;

const composeReport = (state: RunState, context: RunContext): BackfillReport => ({
  dryRun: context.options.dryRun,
  totalSources: context.targets.sources.length,
  processed: state.outcomes.length,
  generated: countBy(state.outcomes, 'generated'),
  alreadyAnnotated: countBy(state.outcomes, 'already-annotated'),
  failed: countBy(state.outcomes, 'failed'),
  atomsPatched: sum(state.outcomes.map(outcome => outcome.atomsPatched)),
  atomFailures: sum(state.outcomes.map(outcome => outcome.atomFailures.length)),
  documents: state.outcomes,
  timing: timingOf(state.samples),
});

/**
 * Process every target source IN ORDER — one llama-swap slot, and a stable order
 * makes a partial run resumable. Nothing is written under `dryRun`.
 */
export const runBackfill = async (options: BackfillOptions): Promise<BackfillReport> => {
  const targets = collectTargets(options.atomsDir);
  const sources =
    options.limit === undefined ? targets.sources : targets.sources.slice(0, options.limit);
  const context: RunContext = { sources, targets, options, startedAt: Date.now() };
  const state = await sources.reduce<Promise<RunState>>(
    async (previous, _source, index) => await advance(await previous, context, index),
    Promise.resolve(EMPTY_RUN)
  );
  return composeReport(state, context);
};

/* ---------------------------------------------------------------------- cli */

const VALUE_FLAGS = ['atoms-dir', 'repo-root', 'model', 'url', 'head-chars', 'limit'] as const;
const BOOLEAN_FLAGS = ['dry-run', 'json', 'help'] as const;

interface ArgState {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly pending: string | undefined;
  readonly error: string | undefined;
}

const EMPTY_ARGS: ArgState = {
  values: new Map(),
  flags: new Set(),
  pending: undefined,
  error: undefined,
};

const withValue = (state: ArgState, key: string, value: string): ArgState => ({
  ...state,
  values: new Map([...state.values, [key, value]]),
  pending: undefined,
});

const startFlag = (state: ArgState, token: string): ArgState => {
  const name = token.slice(2);
  if (VALUE_FLAGS.some(flag => flag === name)) return { ...state, pending: name };
  if (BOOLEAN_FLAGS.some(flag => flag === name)) {
    return { ...state, flags: new Set([...state.flags, name]) };
  }
  return { ...state, error: `unknown flag: ${token}` };
};

const takeToken = (state: ArgState, token: string): ArgState => {
  if (state.pending !== undefined) return withValue(state, state.pending, token);
  return token.startsWith('--') ? startFlag(state, token) : { ...state, error: `unexpected argument: ${token}` };
};

const stepToken = (state: ArgState, token: string): ArgState =>
  state.error === undefined ? takeToken(state, token) : state;

const parseArgs = (argv: readonly string[]): ArgState => {
  const state = argv.reduce(stepToken, EMPTY_ARGS);
  return state.pending === undefined
    ? state
    : { ...state, error: `--${state.pending} requires a value` };
};

const positiveInt = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

interface ResolvedLimits {
  readonly headChars: number;
  readonly limit: number | undefined;
}

const resolveLimits = (state: ArgState): ResolvedLimits | undefined => {
  const headChars = positiveInt(state.values.get('head-chars'), DEFAULTS.headChars);
  const limit = positiveInt(state.values.get('limit'), 0);
  if (headChars === undefined || limit === undefined) return undefined;
  return { headChars, limit: limit === 0 ? undefined : limit };
};

const value = (state: ArgState, key: string, fallback: string): string =>
  state.values.get(key) ?? fallback;

const buildOptions = (state: ArgState): BackfillOptions | string => {
  const limits = resolveLimits(state);
  if (limits === undefined) return 'expected a positive integer for --head-chars / --limit';
  return {
    atomsDir: value(state, 'atoms-dir', DEFAULTS.atomsDir),
    repoRoot: value(state, 'repo-root', process.cwd()),
    headChars: limits.headChars,
    dryRun: state.flags.has('dry-run'),
    generate: createHttpGenerator(
      value(state, 'model', DEFAULTS.model),
      value(state, 'url', DEFAULTS.url)
    ),
    limit: limits.limit,
  };
};

const printReport = (report: BackfillReport, json: boolean): void => {
  const line = json
    ? JSON.stringify(report)
    : `sources ${report.processed}/${report.totalSources} generated ${report.generated} already ${report.alreadyAnnotated} failed ${report.failed} atoms ${report.atomsPatched} atom-failures ${report.atomFailures}`;
  process.stdout.write(`${line}\n`);
};

const exitCodeFor = (report: BackfillReport): number =>
  report.failed + report.atomFailures > 0 ? EXIT_PARTIAL : 0;

const usageExit = (message: string): number => {
  process.stderr.write(`backfill-summaries: ${message}\n${USAGE}`);
  return EXIT_USAGE;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const state = parseArgs(argv);
  if (state.error !== undefined) return usageExit(state.error);
  if (state.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const options = buildOptions(state);
  if (typeof options === 'string') return usageExit(options);
  const report = await runBackfill(options);
  printReport(report, state.flags.has('json'));
  return exitCodeFor(report);
};

const entry = process.argv[1];
const isMain = entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
