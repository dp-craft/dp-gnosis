/**
 * Artefact inventory — join every `results/history.jsonl` row to the two files
 * it names (`runPath`, `perTopicPath`) and report what is actually on disk.
 *
 * Why it exists: the offline analyses the improvement plan schedules (re-scoring
 * a recorded run, pairing two arms) can only touch a row whose artefacts still
 * exist. `results/runs/` and `results/per-topic/` are gitignored, so the history
 * log is a set of PROMISES about files nothing tracks. This script turns those
 * promises into measured facts, and — per `handbook/GNOSIS-GUIDE.md` § Landmines — dates
 * every artefact against its own row, because a stale untracked derived file
 * reads exactly like a code defect.
 *
 * It READS only. It never re-runs, moves or deletes an artefact, and it owns no
 * parsing of its own: `readHistory` (`../src/report.ts`) stays the single owner
 * of the JSONL format, malformed-line tolerance included.
 *
 * Exit codes (Script Exit-Code Contract):
 *   0  inventory produced
 *   2  bad input — unknown flag, or a results directory with no `history.jsonl`
 */
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HISTORY_FILE, type HistoryRow, readHistory } from '../src/report.js';

/**
 * How far an artefact's mtime may sit BEFORE its row's `ts` and still read as
 * normal. Artefacts are written as each dataset completes and the row naming
 * them is written after, so a small lead is the expected order; a large one
 * means the row points at a file some earlier run wrote.
 */
export const MTIME_LEAD_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/**
 * How far an artefact's mtime may sit AFTER its row's `ts`. A run's own datasets
 * finish over the run's wall time (a `full` layer takes about an hour), so a
 * generous lag is legitimate; beyond it the file was rewritten later.
 */
export const MTIME_LAG_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type MtimeVerdict = 'ok' | 'older-than-row' | 'newer-than-row';

export interface Artefact {
  /** The path the row recorded, relative to the results directory. */
  readonly path: string | undefined;
  readonly exists: boolean;
  readonly mtime: string | undefined;
  readonly bytes: number;
  readonly verdict: MtimeVerdict | undefined;
}

export interface InventoryEntry {
  readonly ts: string;
  readonly dataset: string;
  readonly gitSha: string;
  readonly adapter: string;
  readonly depth: number;
  readonly rerank: boolean;
  readonly rerankModel: string | undefined;
  readonly run: Artefact;
  readonly perTopic: Artefact;
  /** One line per artefact whose mtime is implausible against the row's `ts`. */
  readonly anomalies: readonly string[];
}

export interface InventoryTotals {
  readonly rows: number;
  readonly rescorable: number;
  readonly pairable: number;
  readonly missingRun: number;
  readonly missingPerTopic: number;
  readonly noRunPath: number;
  readonly noPerTopicPath: number;
  readonly anomalies: number;
  readonly runBytes: number;
  readonly perTopicBytes: number;
}

interface Stat {
  readonly mtimeMs: number;
  readonly bytes: number;
}

const statOrUndefined = (path: string): Stat | undefined => {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, bytes: stat.size };
  } catch {
    return undefined;
  }
};

/** Where an artefact's mtime sits relative to the row that names it. */
export const mtimeVerdict = (rowTsMs: number, mtimeMs: number): MtimeVerdict => {
  const delta = mtimeMs - rowTsMs;
  if (delta < -MTIME_LEAD_TOLERANCE_MS) return 'older-than-row';
  if (delta > MTIME_LAG_TOLERANCE_MS) return 'newer-than-row';
  return 'ok';
};

const ABSENT: Artefact = {
  path: undefined,
  exists: false,
  mtime: undefined,
  bytes: 0,
  verdict: undefined,
};

const describe = (resultsDir: string, rowTs: string, relPath: string | undefined): Artefact => {
  if (relPath === undefined) return ABSENT;
  const stat = statOrUndefined(resolve(resultsDir, relPath));
  if (stat === undefined) return { ...ABSENT, path: relPath };
  return {
    path: relPath,
    exists: true,
    mtime: new Date(stat.mtimeMs).toISOString(),
    bytes: stat.bytes,
    verdict: mtimeVerdict(Date.parse(rowTs), stat.mtimeMs),
  };
};

const anomalyOf = (label: string, artefact: Artefact): readonly string[] =>
  artefact.verdict === undefined || artefact.verdict === 'ok'
    ? []
    : [`${label} ${artefact.verdict} (${artefact.path} @ ${String(artefact.mtime)})`];

const toEntry = (resultsDir: string, row: HistoryRow): InventoryEntry => {
  const run = describe(resultsDir, row.ts, row.runPath);
  const perTopic = describe(resultsDir, row.ts, row.perTopicPath);
  return {
    ts: row.ts,
    dataset: row.dataset,
    gitSha: row.gitSha,
    adapter: row.adapter,
    depth: row.depth,
    rerank: row.rerank,
    rerankModel: row.rerankModel,
    run,
    perTopic,
    anomalies: [...anomalyOf('runs/', run), ...anomalyOf('per-topic/', perTopic)],
  };
};

/** Every well-formed history row, joined to the artefacts it names. */
export const buildInventory = (resultsDir: string): readonly InventoryEntry[] =>
  readHistory(resolve(resultsDir, HISTORY_FILE)).map(row => toEntry(resultsDir, row));

const count = (
  entries: readonly InventoryEntry[],
  predicate: (entry: InventoryEntry) => boolean
): number => entries.filter(predicate).length;

const sum = (entries: readonly InventoryEntry[], of: (entry: InventoryEntry) => number): number =>
  entries.reduce((total, entry) => total + of(entry), 0);

/** The counts the retention decision (D4) and every offline analysis read. */
export const summarize = (entries: readonly InventoryEntry[]): InventoryTotals => ({
  rows: entries.length,
  rescorable: count(entries, entry => entry.run.exists),
  pairable: count(entries, entry => entry.perTopic.exists),
  missingRun: count(entries, entry => entry.run.path !== undefined && !entry.run.exists),
  missingPerTopic: count(
    entries,
    entry => entry.perTopic.path !== undefined && !entry.perTopic.exists
  ),
  noRunPath: count(entries, entry => entry.run.path === undefined),
  noPerTopicPath: count(entries, entry => entry.perTopic.path === undefined),
  anomalies: count(entries, entry => entry.anomalies.length > 0),
  runBytes: sum(entries, entry => entry.run.bytes),
  perTopicBytes: sum(entries, entry => entry.perTopic.bytes),
});

const COLUMNS: readonly string[] = [
  'ts',
  'dataset',
  'gitSha',
  'adapter',
  'depth',
  'rerank',
  'rerankModel',
  'runPath',
  'runExists',
  'runMtime',
  'runBytes',
  'perTopicPath',
  'perTopicExists',
  'perTopicMtime',
  'perTopicBytes',
  'anomalies',
];

const cell = (value: string | number | boolean | undefined): string =>
  value === undefined ? '-' : String(value);

const toTsvLine = (entry: InventoryEntry): string =>
  [
    entry.ts,
    entry.dataset,
    entry.gitSha,
    entry.adapter,
    entry.depth,
    entry.rerank,
    entry.rerankModel,
    entry.run.path,
    entry.run.exists,
    entry.run.mtime,
    entry.run.bytes,
    entry.perTopic.path,
    entry.perTopic.exists,
    entry.perTopic.mtime,
    entry.perTopic.bytes,
    entry.anomalies.join('; ') || '-',
  ]
    .map(cell)
    .join('\t');

/** The inventory as a TSV, header first — the form the write-up pastes. */
export const renderTsv = (entries: readonly InventoryEntry[]): string =>
  [COLUMNS.join('\t'), ...entries.map(toTsvLine)].join('\n');

const summaryLines = (totals: InventoryTotals): readonly string[] => [
  `rows: ${totals.rows}`,
  `re-scorable (.trec on disk): ${totals.rescorable}`,
  `pairable (per-topic TSV on disk): ${totals.pairable}`,
  `missing run file: ${totals.missingRun}   missing per-topic: ${totals.missingPerTopic}`,
  `no runPath recorded: ${totals.noRunPath}   no perTopicPath recorded: ${totals.noPerTopicPath}`,
  `mtime anomalies: ${totals.anomalies}`,
  `referenced bytes — runs: ${totals.runBytes}   per-topic: ${totals.perTopicBytes}`,
];

const HELP = `inventory-artefacts — join history.jsonl rows to the artefacts they name.

Usage: npx tsx packages/gnosis-bench/scripts/inventory-artefacts.ts [flags]

  --results <dir>   Results directory (default: <bench>/results)
  --format <fmt>    tsv (default) | summary
  --help            This text

Exit codes:
  0  inventory produced
  2  bad input — unknown flag, or a results directory with no history.jsonl
`;

interface Options {
  readonly resultsDir: string | undefined;
  readonly summaryOnly: boolean;
  readonly help: boolean;
  readonly bad: string | undefined;
}

const EMPTY_OPTIONS: Options = {
  resultsDir: undefined,
  summaryOnly: false,
  help: false,
  bad: undefined,
};

const withFlag = (options: Options, flag: string, value: string | undefined): Options => {
  if (flag === '--help') return { ...options, help: true };
  if (flag === '--results') return { ...options, resultsDir: value };
  if (flag === '--format') return { ...options, summaryOnly: value === 'summary' };
  return { ...options, bad: flag };
};

const parseArgs = (argv: readonly string[]): Options =>
  argv.reduce<Options>(
    (options, token, index) =>
      token.startsWith('--') ? withFlag(options, token, argv[index + 1]) : options,
    EMPTY_OPTIONS
  );

const emit = (entries: readonly InventoryEntry[], summaryOnly: boolean): void => {
  if (!summaryOnly) process.stdout.write(`${renderTsv(entries)}\n`);
  process.stdout.write(`${summaryLines(summarize(entries)).join('\n')}\n`);
};

/** Returns the process exit code; every failure names its cause on stderr. */
export const main = (argv: readonly string[], defaultResultsDir: string): number => {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.bad !== undefined) {
    process.stderr.write(`unknown flag: ${options.bad}\n${HELP}`);
    return 2;
  }
  const resultsDir = options.resultsDir ?? defaultResultsDir;
  if (statOrUndefined(resolve(resultsDir, HISTORY_FILE)) === undefined) {
    process.stderr.write(`no ${HISTORY_FILE} under ${resultsDir}\n`);
    return 2;
  }
  emit(buildInventory(resultsDir), options.summaryOnly);
  return 0;
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main(process.argv.slice(2), resolve(benchRoot, 'results'));
}
