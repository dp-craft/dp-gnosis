/**
 * Offline decomposition of an ALREADY-RECORDED run: for one topic, how much of
 * the nDCG deficit is ORDERING (the relevant document was retrieved and ranked
 * badly) and how much is RECALL (it was never retrieved at all).
 *
 * This module runs no retrieval and starts no benchmark — it reads the persisted
 * TREC run files (`results/runs/*.trec`) and re-scores them.
 *
 * Every score comes from `metrics.ts`, which is externally attested against
 * `pytrec_eval`. The oracle is expressed as `ndcgAt` over a REORDERED ranking
 * rather than as a second DCG implementation, so the two can never drift.
 */

import { mapNonEmptyLines } from './lines.js';
import { ndcgAt, precisionAt, type Qrel, recallAt } from './metrics.js';

/**
 * Re-exported, not re-implemented: `metrics.ts` owns every scoring formula and
 * is the module `pytrec_eval` attests, so a second P@k here could drift from the
 * one the recorded runs were measured with.
 */
export { precisionAt };

/** How many relevant documents the topic has, at any grade above 0. */
const relevantCountOf = (qrel: Qrel): number =>
  [...qrel.values()].filter(grade => grade > 0).length;

const gradeOf = (qrel: Qrel, docId: string): number => qrel.get(docId) ?? 0;

const retrievedRelevantOf = (ranking: readonly string[], qrel: Qrel): number =>
  ranking.filter(docId => gradeOf(qrel, docId) > 0).length;

/**
 * The best nDCG@k reachable by REORDERING what this ranking actually retrieved —
 * the whole ranking, not just its top `k`. The IDCG denominator is unchanged, so
 * the score stays below 1 exactly when a relevant document is missing entirely.
 */
export const oracleNdcgAt = (ranking: readonly string[], qrel: Qrel, k: number): number =>
  ndcgAt(
    [...ranking].sort((a, b) => gradeOf(qrel, b) - gradeOf(qrel, a)),
    qrel,
    k
  );

/** 1-based rank of the first relevant document; `undefined` when none was retrieved. */
export const firstRelevantRank = (
  ranking: readonly string[],
  qrel: Qrel
): number | undefined => {
  const index = ranking.findIndex(docId => gradeOf(qrel, docId) > 0);
  return index === -1 ? undefined : index + 1;
};

/**
 * True when the ranking holds FEWER than `min(k, relevantCount)` relevant
 * documents — nDCG@k then cannot reach 1 however the ranking is reordered, so the
 * deficit is not the ordering's fault.
 */
export const isRecallLimited = (ranking: readonly string[], qrel: Qrel, k: number): boolean =>
  retrievedRelevantOf(ranking, qrel) < Math.min(k, relevantCountOf(qrel));

/**
 * One topic's deficit, split. `ndcg + orderingLoss + recallLoss === 1` by
 * construction: the oracle is the boundary between the two causes.
 */
export interface TopicForensics {
  readonly relevantCount: number;
  readonly retrievedRelevant: number;
  readonly ndcg: number;
  readonly oracleNdcg: number;
  readonly precision: number;
  readonly recall: number;
  readonly firstRelevantRank: number | undefined;
  readonly recallLimited: boolean;
  /** What a perfect reordering of the SAME retrieved set would recover. */
  readonly orderingLoss: number;
  /** What no reordering can recover — the documents that were never retrieved. */
  readonly recallLoss: number;
}

export const topicForensics = (
  ranking: readonly string[],
  qrel: Qrel,
  k: number
): TopicForensics => {
  const ndcg = ndcgAt(ranking, qrel, k);
  const oracleNdcg = oracleNdcgAt(ranking, qrel, k);
  return {
    relevantCount: relevantCountOf(qrel),
    retrievedRelevant: retrievedRelevantOf(ranking, qrel),
    ndcg,
    oracleNdcg,
    precision: precisionAt(ranking, qrel, k),
    recall: recallAt(ranking, qrel, k),
    firstRelevantRank: firstRelevantRank(ranking, qrel),
    recallLimited: isRecallLimited(ranking, qrel, k),
    orderingLoss: oracleNdcg - ndcg,
    recallLoss: 1 - oracleNdcg,
  };
};

/** One TREC run line, reduced to the two fields a ranking needs. */
interface RunPosting {
  readonly queryId: string;
  readonly docId: string;
}

/** `qid Q0 docid rank score tag`, whitespace-separated; short of docid is malformed. */
const parseRunLine = (line: string): RunPosting | undefined => {
  const [queryId, , docId] = line.trim().split(/\s+/);
  return queryId === undefined || docId === undefined ? undefined : { queryId, docId };
};

/** `error.cause` when a run file holds a line short of the docid column. */
export const MALFORMED_RUN_LINE_CAUSE = 'dp-gnosis-bench/malformed-run-line';

const malformedLineMessage = (absPath: string, lineNumber: number, line: string): string =>
  `dp-gnosis-bench: malformed TREC run line in ${absPath} at line ${lineNumber} — ` +
  `expected at least 3 whitespace-separated fields (qid Q0 docid), got "${line.trim()}"`;

/**
 * A truncated write must not enter a ranking as data, and it must not be dropped
 * either: a silently shorter ranking is scored as the ranking the run produced.
 * The number is the 1-based position among the file's NON-EMPTY lines, which is
 * the file line number for every run file this suite writes.
 */
const postingAt = (absPath: string): ((line: string, index: number) => RunPosting) =>
  (line, index) => {
    const posting = parseRunLine(line);
    if (posting === undefined) {
      throw new Error(malformedLineMessage(absPath, index + 1, line), {
        cause: MALFORMED_RUN_LINE_CAUSE,
      });
    }
    return posting;
  };

const appendPosting = (
  run: Map<string, readonly string[]>,
  posting: RunPosting
): Map<string, readonly string[]> =>
  run.set(posting.queryId, [...(run.get(posting.queryId) ?? []), posting.docId]);

/**
 * A persisted run file as `qid -> docids in FILE ORDER`. The file is already
 * written in descending-score order, so no re-sort happens here — re-sorting is
 * how `trec_eval` silently substitutes an alphabetical ranking. A malformed line
 * THROWS, naming the file and the line.
 */
export const readRunFile = (absPath: string): ReadonlyMap<string, readonly string[]> =>
  mapNonEmptyLines(absPath, line => line)
    .map(postingAt(absPath))
    .reduce(appendPosting, new Map<string, readonly string[]>());
