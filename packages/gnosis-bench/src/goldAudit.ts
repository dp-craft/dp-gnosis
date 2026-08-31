/**
 * The GOLD AUDIT arithmetic — pure, no I/O, no engine, no GPU.
 *
 * It answers one question about a corpus that has already been ingested: how
 * many judged documents did the exact-body dedupe remove from the indexed
 * corpus, and how many relevant judgments can therefore never be won by ANY
 * ranking. That number is a ceiling on the dataset's recall, and a ceiling that
 * is not stated beside the metric it bounds gets read as quality
 * (GNOSIS-GUIDE § Landmines, "ingest dedupe silently orphans a gold id").
 *
 * Two rules it holds to:
 *
 * 1. Everything is counted at DOCUMENT granularity, on the ids `readQrels`
 *    produces and `score.ts` rolls a retrieved atom up to. An atom id is lossy
 *    and would count a different population.
 * 2. `rePointQrels` produces a NEW qrels map and never touches the one it is
 *    given. The golden set on disk is the measuring instrument and MUST NOT be
 *    edited in passing — the re-pointed variant exists only to score an already
 *    recorded run against, so the size of the distortion can be reported.
 */
import type { DuplicateLink } from './engine.js';
import type { Qrel } from './metrics.js';

/** What one dataset's audit measured. Every field is a COUNT of documents or judgments. */
export interface GoldAudit {
  readonly datasetId: string;
  /** Documents the corpus file holds — the ingest's input population. */
  readonly corpusDocs: number;
  /** Corpus documents an indexed atom still points back to. */
  readonly representedDocs: number;
  /** Corpus documents no indexed atom reaches: `corpusDocs - representedDocs`. */
  readonly orphanedDocs: number;
  /** Of those, the ones at least one topic judges relevant. */
  readonly orphanedJudgedDocs: number;
  /** Relevant (topic, document) pairs naming an orphaned document — unwinnable. */
  readonly lostJudgments: number;
  /** Topics holding at least one lost judgment. */
  readonly affectedTopics: number;
  /** Relevant (topic, document) pairs in the whole golden set, the denominator. */
  readonly totalRelevantJudgments: number;
}

/** The facts one audit is computed from; all four come from disk, none from a guess. */
export interface GoldAuditInput {
  readonly datasetId: string;
  readonly corpusDocIds: readonly string[];
  /** Document ids reachable from the atoms that were written — read off the atoms dir. */
  readonly representedDocIds: readonly string[];
  readonly qrels: ReadonlyMap<string, Qrel>;
}

/** A judged pair — grade 0 is a JUDGED non-relevant document and names no gold. */
const isRelevant = (graded: readonly [string, number]): boolean => graded[1] > 0;

const relevantDocsOf = (qrel: Qrel): readonly string[] =>
  [...qrel].filter(isRelevant).map(pair => pair[0]);

const orphanedIds = (input: GoldAuditInput): readonly string[] => {
  const represented = new Set(input.representedDocIds);
  return [...new Set(input.corpusDocIds)].filter(id => !represented.has(id));
};

/** Per topic, the relevant documents that no longer exist in the indexed corpus. */
const lostPerTopic = (
  qrels: ReadonlyMap<string, Qrel>,
  orphaned: ReadonlySet<string>
): readonly (readonly string[])[] =>
  [...qrels.values()].map(qrel => relevantDocsOf(qrel).filter(id => orphaned.has(id)));

const totalRelevant = (qrels: ReadonlyMap<string, Qrel>): number =>
  [...qrels.values()].reduce((sum, qrel) => sum + relevantDocsOf(qrel).length, 0);

/** `error.cause` when the corpus the audit was handed holds no document. */
export const GOLD_AUDIT_NO_CORPUS_CAUSE = 'dp-gnosis-bench/gold-audit-empty-corpus';

/** `error.cause` when the golden set carries no relevant judgment to bound. */
export const GOLD_AUDIT_NO_JUDGMENTS_CAUSE = 'dp-gnosis-bench/gold-audit-no-relevant-judgments';

const fail = (message: string, cause: string): never => {
  throw new Error(message, { cause });
};

const noCorpusMessage = (datasetId: string): string =>
  `dp-gnosis-bench: dataset "${datasetId}" was audited against ZERO corpus documents. Every ` +
  'count in the block — orphans, lost judgments, topics affected — would print 0 and read as a ' +
  'corpus with no recall ceiling, which is what an unread corpus file looks like too.';

const noJudgmentsMessage = (datasetId: string): string =>
  `dp-gnosis-bench: dataset "${datasetId}" was audited against a golden set holding no RELEVANT ` +
  'judgment. The ceiling this audit reports is a share of that denominator, so the block would ' +
  'state 0 lost of 0 — an unmeasurable cell printed as a measured zero.';

/**
 * The two populations the whole audit is a fraction of. Judged over the WHOLE
 * set, exactly as `assertPortSound` judges its probe: a topic whose relevant
 * documents all survived is a real result, and only a corpus or a golden set
 * that is empty END TO END refuses.
 */
const assertAuditable = (input: GoldAuditInput): void => {
  if (new Set(input.corpusDocIds).size === 0) {
    fail(noCorpusMessage(input.datasetId), GOLD_AUDIT_NO_CORPUS_CAUSE);
  }
  if (totalRelevant(input.qrels) === 0) {
    fail(noJudgmentsMessage(input.datasetId), GOLD_AUDIT_NO_JUDGMENTS_CAUSE);
  }
};

/**
 * The audit. `representedDocs` is intersected with the corpus rather than taken
 * as given: an atoms directory left by a DIFFERENT corpus would otherwise inflate
 * the represented count and hide the very orphans this exists to find.
 */
export const auditGold = (input: GoldAuditInput): GoldAudit => {
  assertAuditable(input);
  const orphaned = new Set(orphanedIds(input));
  const lost = lostPerTopic(input.qrels, orphaned);
  const lostIds = new Set(lost.flat());
  return {
    datasetId: input.datasetId,
    corpusDocs: new Set(input.corpusDocIds).size,
    representedDocs: new Set(input.corpusDocIds).size - orphaned.size,
    orphanedDocs: orphaned.size,
    orphanedJudgedDocs: lostIds.size,
    lostJudgments: lost.reduce((sum, ids) => sum + ids.length, 0),
    affectedTopics: lost.filter(ids => ids.length > 0).length,
    totalRelevantJudgments: totalRelevant(input.qrels),
  };
};

const survivorByOrphan = (links: readonly DuplicateLink[]): ReadonlyMap<string, string> =>
  new Map(links.map(link => [link.orphanDocId, link.survivorDocId]));

/**
 * One topic's judgments with every orphaned document id moved onto the document
 * whose byte-identical body survived. A collision — the survivor already judged
 * by this topic — keeps the HIGHER grade, because the two ids name one body and
 * the stronger judgment is the one the topic actually expressed about it.
 */
const rePointQrel = (qrel: Qrel, survivors: ReadonlyMap<string, string>): Qrel =>
  [...qrel].reduce((acc, [docId, grade]) => {
    const target = survivors.get(docId) ?? docId;
    return acc.set(target, Math.max(acc.get(target) ?? grade, grade));
  }, new Map<string, number>());

/**
 * The qrels variant a recorded run is re-scored against. It is a DIAGNOSTIC, not
 * a golden set: it swaps which SOURCE FILE is gold, so it MUST NOT be written
 * back over the judgments on disk.
 */
export const rePointQrels = (
  qrels: ReadonlyMap<string, Qrel>,
  links: readonly DuplicateLink[]
): ReadonlyMap<string, Qrel> => {
  const survivors = survivorByOrphan(links);
  return new Map([...qrels].map(([topicId, qrel]) => [topicId, rePointQrel(qrel, survivors)]));
};
