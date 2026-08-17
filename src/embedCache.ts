/**
 * The embedding cache: a SIDECAR to the index it belongs to, one file per
 * vector, keyed by `(modelId, sha256(raw body))`.
 *
 * The model id is a DIRECTORY level, not a field inside the entry, so a model
 * change cannot be served from another model's vectors by any read path — it
 * simply misses and re-embeds. The digest is over the RAW body, the same bytes
 * `embed.ts` puts on the wire; a cache keyed on anything else would drift from
 * what it caches the moment analysis changed.
 *
 * Precedent: the stat-manifest digest the linear adapter already uses to decide
 * whether a derived artefact is still current.
 *
 * An unreadable or malformed entry is a MISS, never a substitute vector — the
 * cache is regenerable, so re-embedding is always the safe answer.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Appended to the index path — the cache sits beside the index it serves. */
const CACHE_SUFFIX = '.embed-cache';

/** The digest half of the key: sha256 of the RAW body, hex. */
export const embeddingCacheKey = (rawBody: string): string =>
  createHash('sha256').update(rawBody, 'utf8').digest('hex');

/** The model half of the key: `<indexPath>.embed-cache/<modelId>`. */
export const embeddingCacheDir = (indexPath: string, model: string): string =>
  join(`${indexPath}${CACHE_SUFFIX}`, model);

/** Read-through storage for one `(index, model)` pair. */
export interface EmbeddingCache {
  /** `undefined` on a miss, an unreadable entry, or a malformed one. */
  readonly get: (rawBody: string) => Promise<readonly number[] | undefined>;
  readonly put: (rawBody: string, vector: readonly number[]) => Promise<void>;
}

const isVector = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'number');

const readVector = async (path: string): Promise<readonly number[] | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isVector(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The sidecar for `indexPath` under `model`; created lazily on first write. */
export const createEmbeddingCache = (indexPath: string, model: string): EmbeddingCache => {
  const dir = embeddingCacheDir(indexPath, model);
  const entryPath = (rawBody: string): string => join(dir, `${embeddingCacheKey(rawBody)}.json`);
  return {
    get: async (rawBody: string) => await readVector(entryPath(rawBody)),
    put: async (rawBody: string, vector: readonly number[]): Promise<void> => {
      await mkdir(dir, { recursive: true });
      await writeFile(entryPath(rawBody), JSON.stringify(vector), 'utf8');
    },
  };
};
