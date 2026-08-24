/**
 * THE one document-id mapping in this suite: a published dataset id → the
 * filename-safe id every layer below `beir.ts` uses.
 *
 * It exists because the corpus FILENAME is the mapping back to the document —
 * `score.ts` recovers the doc id from a retrieved atom's `originPaths` basename,
 * so `corpus.ts:fileNameFor` validates rather than sanitises. Anything an id
 * space carries beyond `[A-Za-z0-9._-]` has to be mapped BEFORE it reaches that
 * layer, and mapped by the SAME function on the corpus side and the qrels side —
 * two id spaces that disagree would mis-join qrels silently and score a corpus
 * nobody measured.
 *
 * BRIGHT ids are paths (`insects/Proximate_causation.txt`) and `webis-touche2020`
 * ids embed an ISO timestamp (`c67482ba-2019-04-18T13:32:05Z-00000-000`, all
 * 382,545 of them carrying a `:`). Both go through this function; it was BRIGHT's
 * `surrogateId`, promoted here unchanged so no second sanitiser can drift from it.
 *
 * MEASURED, on the 18 corpora on disk 2026-08-15: every id of every dataset
 * except `webis-touche2020` already lies in `[A-Za-z0-9_-]`, so this is the
 * IDENTITY on all of them — scifact, nfcorpus, arguana, trec-covid, scidocs,
 * fiqa, the vault family and every BRIGHT split map to themselves, byte for byte.
 * On `webis-touche2020` it is injective: 382,545 ids, 0 collisions.
 */
import { createHash } from 'node:crypto';

/** Everything outside the filename-safe set `corpus.ts` accepts becomes `_`. */
const UNSAFE_CHARS = /[^A-Za-z0-9_-]/g;
const SAFE_REPLACEMENT = '_';

/** The length half of `corpus.ts:DOC_ID_PATTERN` — a mapped id MUST fit it. */
const MAX_ID_LENGTH = 200;

/**
 * Hex chars of the raw id's sha256 kept when a mapped id is truncated. Character
 * sanitising alone does not bound LENGTH, and BRIGHT ids are URLs: the
 * `sustainable_living` split carries ids of 261 chars, which `fileNameFor`
 * rejects outright. Truncating alone would silently MERGE two documents sharing
 * a 200-char prefix — a whole tracking-parameter URL family does — so the tail
 * is a digest of the raw id, making the mapped id unique and stable across
 * re-fetches.
 */
const ID_HASH_CHARS = 8;
const ID_HASH_SEPARATOR = '-';
const TRUNCATED_PREFIX_LENGTH = MAX_ID_LENGTH - ID_HASH_CHARS - ID_HASH_SEPARATOR.length;

const rawIdDigest = (rawId: string): string =>
  createHash('sha256').update(rawId, 'utf8').digest('hex').slice(0, ID_HASH_CHARS);

/**
 * A published document id → the filename-safe id this suite uses everywhere.
 * Deterministic, total and idempotent on its own output, so the corpus, the
 * qrels and the exclusions can each map independently and still agree.
 */
export const safeDocId = (rawId: string): string => {
  const safe = rawId.replace(UNSAFE_CHARS, SAFE_REPLACEMENT);
  if (safe.length <= MAX_ID_LENGTH) return safe;
  return `${safe.slice(0, TRUNCATED_PREFIX_LENGTH)}${ID_HASH_SEPARATOR}${rawIdDigest(rawId)}`;
};

const collisionMessage = (first: string, second: string, mapped: string): string =>
  `dp-gnosis-bench corpus: document ids ${JSON.stringify(first)} and ${JSON.stringify(second)} ` +
  `both map to the filename-safe id ${JSON.stringify(mapped)}. The two documents would merge ` +
  'into one file and every metric for this dataset would be wrong, so this refuses rather than ' +
  'scoring a corpus that is not the one named. Give the dataset fetcher an id mapping that ' +
  'keeps them distinct.';

/**
 * REFUSE a corpus whose ids stop being distinct once mapped. A merge is exactly
 * the failure this project keeps meeting — a component producing nothing (here:
 * one document instead of two) and the pipeline recording it as data — so it
 * fails loudly, naming both ORIGINAL ids, rather than degrading a metric quietly.
 *
 * The same id twice is a duplicate row, not a merge, and is left to the
 * doc-count/file-count check in `corpus.ts`.
 */
export const assertNoIdCollisions = (rawIds: readonly string[]): void => {
  rawIds.reduce((seen, rawId) => {
    const mapped = safeDocId(rawId);
    const previous = seen.get(mapped);
    if (previous !== undefined && previous !== rawId) {
      throw new Error(collisionMessage(previous, rawId, mapped));
    }
    return seen.set(mapped, rawId);
  }, new Map<string, string>());
};
