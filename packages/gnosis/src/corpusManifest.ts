import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * THE CORPUS MANIFEST — the committable stand-in for an uncommittable corpus.
 *
 * The atoms vault is gitignored (`.gitignore`: `benchmark-data/vault/atoms/`) and is
 * rebuilt by re-ingest before every measurement, while the golden sets anchor
 * on atom ids INSIDE it. Nothing in the repo recorded which corpus a number was
 * measured against, so no measurement could be re-anchored from the repo alone.
 *
 * This file is what fixes that without version-controlling 11 345 atoms: an
 * AGGREGATE IDENTITY (one digest over every atom's id and content hash) that
 * proves two corpora are the same, plus the per-type and per-domain counts that
 * LOCALISE a drift to a bucket instead of merely flagging it. It is a summary,
 * never a per-atom list — a per-atom list is the vault again, in another file.
 *
 * DETERMINISM is the whole point and the reason for every choice here: sorted
 * ids, sorted bucket keys, no timestamp, no absolute path, no host name. Two
 * ingests of unchanged input MUST produce a byte-identical manifest, because a
 * manifest that changes on its own can neither confirm nor refute a re-anchor.
 */

/** File name of the manifest; the directory is the ingest run's business. */
export const CORPUS_MANIFEST_FILE = 'corpus-manifest.json';

/** Marks the hash function in the digest, so a later change of it is visible. */
const DIGEST_PREFIX = 'sha256:';

/**
 * A NUL cannot occur in an id, a source path or a hex digest, so no digest line
 * on either construction below can split wrongly. ONE constant: two names for
 * the same byte invited one of them to move alone, which would have changed a
 * digest without changing what it describes.
 */
const FIELD_SEPARATOR = '\u0000';

/** One written atom, reduced to exactly what the manifest summarises. */
export interface ManifestAtom {
  readonly id: string;
  readonly type: string;
  readonly domain: string;
  /** The atom file's exact bytes — what the content hash is taken over. */
  readonly content: string;
}

/**
 * One in-scope SOURCE document of the run, reduced to what its identity is
 * taken over. Structurally the front half of ingest's `LoadedSource`, so ingest
 * hands its already-read corpus straight in and the manifest costs it no extra
 * I/O.
 */
export interface ManifestSource {
  readonly sourcePath: string;
  /** The source file's exact text — what the content hash is taken over. */
  readonly text: string;
}

/**
 * The corpus→atoms identity: how many source documents an ingest read, and one
 * aggregate hash over their paths and bodies.
 *
 * CONTENT-hashed, never mtime-stamped. A `git pull` or a `touch` rewrites every
 * mtime in a tree without changing one byte a query can see, and a check that
 * cried wolf on those would be turned off within a day — which is the same as
 * not having it.
 */
export interface SourceIdentity {
  readonly sourceCount: number;
  readonly sourceDigest: string;
}

/** What a manifest is built from: the write set plus the run's own labels. */
export interface CorpusManifestInput {
  readonly profile: string;
  readonly atoms: readonly ManifestAtom[];
  /** Every source the run READ, mapped or not — the scope `loadCorpus` returns. */
  readonly sources: readonly ManifestSource[];
  readonly skipped: number;
  readonly duplicates: number;
}

/** Atom counts keyed by one label, in sorted key order. */
export type BucketCounts = Readonly<Record<string, number>>;

/** The committable identity of one ingested corpus. */
export interface CorpusManifest extends SourceIdentity {
  readonly profile: string;
  readonly atomCount: number;
  readonly digest: string;
  readonly byType: BucketCounts;
  readonly byDomain: BucketCounts;
  readonly skipped: number;
  /**
   * The exact-body duplicates inside `skipped` — its own field, never folded
   * into the skip count. Two corpora with the same `skipped` total mean
   * different things when one of them deduplicated 296 mirrored bodies and the
   * other refused 296 malformed sections, and a re-anchor has to tell them
   * apart.
   */
  readonly duplicates: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The pair list the aggregate digest is taken over: id and content hash, sorted
 * by id. Sorting is what makes the digest independent of the order ingest
 * happened to write in — the same corpus discovered in another order is the
 * same corpus, and a digest that disagreed would raise a false drift.
 */
const digestLines = (atoms: readonly ManifestAtom[]): readonly string[] =>
  [...atoms]
    .map(atom => `${atom.id}${FIELD_SEPARATOR}${sha256(atom.content)}`)
    .sort((left, right) => (left < right ? -1 : 1));

const aggregateDigest = (atoms: readonly ManifestAtom[]): string =>
  `${DIGEST_PREFIX}${sha256(digestLines(atoms).join('\n'))}`;

/**
 * The same construction as {@link digestLines}, one hop upstream: path and body
 * hash, sorted by the line, so the digest is independent of the order the
 * corpus walk happened to return.
 */
const sourceDigestLines = (sources: readonly ManifestSource[]): readonly string[] =>
  [...sources]
    .map(source => `${source.sourcePath}${FIELD_SEPARATOR}${sha256(source.text)}`)
    .sort((left, right) => (left < right ? -1 : 1));

/**
 * The corpus identity of a source set. Exported so `doctor` RECOMPUTES it with
 * the very function that recorded it — a second spelling of this construction
 * would disagree with the manifest and report every healthy instance as drifted.
 */
export const sourceIdentityOf = (sources: readonly ManifestSource[]): SourceIdentity => ({
  sourceCount: sources.length,
  sourceDigest: `${DIGEST_PREFIX}${sha256(sourceDigestLines(sources).join('\n'))}`,
});

/** Counts per distinct label, keys sorted so the serialized order is fixed. */
const tally = (labels: readonly string[]): BucketCounts =>
  Object.fromEntries(
    [...new Set(labels)]
      .sort()
      .map(label => [label, labels.filter(candidate => candidate === label).length])
  );

/** Build the manifest for one ingest run. Pure: same input, same manifest. */
export const buildCorpusManifest = (input: CorpusManifestInput): CorpusManifest => ({
  profile: input.profile,
  atomCount: input.atoms.length,
  digest: aggregateDigest(input.atoms),
  ...sourceIdentityOf(input.sources),
  byType: tally(input.atoms.map(atom => atom.type)),
  byDomain: tally(input.atoms.map(atom => atom.domain)),
  skipped: input.skipped,
  duplicates: input.duplicates,
});

/** Indented JSON with a trailing newline — a file a human reads and git diffs. */
export const serializeCorpusManifest = (manifest: CorpusManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** Where `writeManifest` puts the manifest for one atoms directory: one level up. */
export const manifestPathFor = (atomsDir: string): string =>
  join(dirname(atomsDir), CORPUS_MANIFEST_FILE);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * A manifest that cannot be parsed states NOTHING about the corpus, so it reads
 * as absent rather than as a disagreement: a truncated file mid-ingest MUST NOT
 * be reported as a corpus that drifted.
 */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The manifest beside `atomsDir` as a bare record, or `undefined` when it states nothing. */
const manifestRecord = (atomsDir: string): Readonly<Record<string, unknown>> | undefined => {
  const path = manifestPathFor(atomsDir);
  if (!existsSync(path)) return undefined;
  const value = parsed(readFileSync(path, 'utf8'));
  return isRecord(value) ? value : undefined;
};

/**
 * The aggregate digest recorded beside `atomsDir`, or `undefined` when no
 * manifest sits there. `undefined` is the "nothing to compare with" case and is
 * deliberately NOT an empty string — a caller must be able to tell an absent
 * manifest from one claiming an empty corpus.
 */
export const readManifestDigest = (atomsDir: string): string | undefined => {
  const value = manifestRecord(atomsDir)?.digest;
  return typeof value === 'string' ? value : undefined;
};

/**
 * The SOURCE identity recorded beside `atomsDir`, or `undefined` when the
 * manifest does not carry one — which every manifest written before this field
 * existed does not. That `undefined` means UNKNOWN, never "no sources": a fact
 * nobody recorded MUST NOT be reported as a corpus that drifted.
 */
export const readManifestSourceIdentity = (atomsDir: string): SourceIdentity | undefined => {
  const record = manifestRecord(atomsDir);
  const sourceCount = record?.sourceCount;
  const sourceDigest = record?.sourceDigest;
  return typeof sourceCount === 'number' && typeof sourceDigest === 'string'
    ? { sourceCount, sourceDigest }
    : undefined;
};
