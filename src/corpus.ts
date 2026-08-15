/**
 * BEIR documents → a markdown corpus dp-gnosis can ingest, plus the throwaway
 * ingest profile that keeps the run off the repo vault.
 *
 * One document → one `<id>.md`: the BEIR `title` as the top heading, the BEIR
 * `text` as the body — byte-identical to the shape the recorded SciFact
 * baseline measured (`prepareScifactCorpus.ts:toMarkdown`). Nothing else is
 * added: a probe of the chunker must not invent structure the corpus lacks.
 *
 * The filename IS the mapping back to the document: `score` recovers the doc id
 * from the retrieved atom's `originPaths` basename. So an id is VALIDATED, never
 * sanitised — a rewritten filename would break that mapping silently. BRIGHT ids
 * contain `/`; its fetcher maps them to safe ids before they reach this layer.
 *
 * The profile's vocabulary is the SHIPPED one (`docs` / `vendor-doc`). The
 * manifest's `domain` field MUST NOT flow in here: `tools/dp-gnosis/src/config.ts`
 * freezes `ATOM_DOMAINS` at import time and `fts5Adapter.asDomain` narrows
 * against it, so an atom with an unknown domain is dropped at index time — an
 * empty index and zero results, with no error anywhere.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { IngestProfile } from '../../dp-gnosis/src/ingestProfile.js';
import type { BeirDoc } from './beir.js';

const MARKDOWN_EXT = '.md';

/** Ids safe as a filesystem basename, and short enough for any filesystem. */
const DOC_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** The shipped vocabularies — mirrors `config.ts` `ATOM_DOMAINS` / `ATOM_TYPES`. */
const PROFILE_DOMAINS: readonly string[] = ['runner', 'standards', 'adr', 'docs', 'claude'];
const PROFILE_TYPES: readonly string[] = ['knowledge', 'vendor-doc'];
const PROFILE_DOMAIN = 'docs';
const PROFILE_TYPE = 'vendor-doc';
const PROFILE_DEFAULT_TYPE = 'vendor-doc';

/** `error.cause` when the corpus directory holds something materialization cannot own. */
export const UNPRUNABLE_CORPUS_DIR_CAUSE = 'dp-gnosis-bench/unprunable-corpus-dir';

/** How many foreign entry names a refusal names before it stops listing. */
const NAMED_FOREIGN_ENTRIES = 5;

/** What `materializeCorpus` wrote, and how to get from an id to its file and back. */
export interface MaterializedCorpus {
  readonly dir: string;
  readonly docCount: number;
  /**
   * Document files OBSERVED in `dir` after the write and the prune — read back
   * from disk, never inferred from `docs`. It is the only number that can
   * disagree with `docCount`, and that disagreement is the corruption signal.
   */
  readonly presentFileCount: number;
  readonly fileNameById: ReadonlyMap<string, string>;
  readonly idByFileName: ReadonlyMap<string, string>;
}

/** Where one dataset's throwaway instance keeps its corpus, atoms and index. */
export interface ProfileSpec {
  readonly datasetId: string;
  /** Absolute directory owning this dataset's generated files. */
  readonly workDir: string;
  /** `workDir`-relative directory holding the generated markdown. */
  readonly corpusDirName: string;
  readonly atomMaxChars?: number | undefined;
}

/** Title as the single H1, text as the body — the shape a BEIR doc actually has. */
export const toMarkdown = (doc: BeirDoc): string => `# ${doc.title}\n\n${doc.text}\n`;

/** The basename an atom's `originPaths` will carry for this document. */
export const fileNameFor = (docId: string): string => {
  if (!DOC_ID_PATTERN.test(docId)) {
    throw new Error(
      `dp-gnosis-bench corpus: document id ${JSON.stringify(docId)} is not filename-safe — ` +
        'map it to an id matching /^[A-Za-z0-9._-]{1,200}$/ in the dataset fetcher, ' +
        'keeping the mapping so qrels can be rewritten to the safe ids'
    );
  }
  return `${docId}${MARKDOWN_EXT}`;
};

const writeDoc = (targetDir: string, doc: BeirDoc): readonly [string, string] => {
  const fileName = fileNameFor(doc.id);
  writeFileSync(resolve(targetDir, fileName), toMarkdown(doc), 'utf8');
  return [doc.id, fileName];
};

const unprunableMessage = (dir: string, names: readonly string[]): string =>
  `dp-gnosis-bench corpus: ${dir} holds ${names.length} entries that are not generated ` +
  `documents (${names.slice(0, NAMED_FOREIGN_ENTRIES).join(', ')}). Materialization cannot ` +
  'guarantee the directory holds exactly this corpus without deleting them, and it MUST NOT ' +
  'delete anything it did not write. Point the dataset at a directory it owns exclusively, ' +
  'or remove the foreign entries by hand.';

/**
 * The document files currently in `dir`. Refuses rather than guess: an entry that
 * is not a plain `<id>.md` file is something materialization never wrote, so it
 * can neither keep it (the corpus would be wrong) nor delete it safely.
 */
const presentDocFiles = (dir: string): readonly string[] => {
  const entries = readdirSync(dir, { withFileTypes: true });
  const foreign = entries.filter(entry => !entry.isFile() || !entry.name.endsWith(MARKDOWN_EXT));
  if (foreign.length > 0) {
    throw new Error(
      unprunableMessage(
        dir,
        foreign.map(entry => entry.name)
      ),
      { cause: UNPRUNABLE_CORPUS_DIR_CAUSE }
    );
  }
  return entries.map(entry => entry.name);
};

/**
 * Delete every document the CURRENT corpus does not claim. A corpus that shrank
 * used to leave its dropped documents behind forever, and ingest kept indexing
 * them as distractors — measured on `vault-hu`: 114 stale files, +0.05 nDCG@10
 * once removed, larger than any treatment effect on that corpus. Deletion is
 * scoped to `dir`'s OWN entries (`readdir` names carry no separator), so it can
 * never reach the parent, where `writeManifest` keeps `corpus-manifest.json`.
 */
const pruneStaleDocs = (dir: string, keep: ReadonlySet<string>): void => {
  const stale = presentDocFiles(dir).filter(name => !keep.has(name));
  stale.forEach(name => rmSync(resolve(dir, name), { force: true }));
};

/** Write one `<docid>.md` per document; return the reversible id ↔ filename map. */
export const materializeCorpus = (
  docs: readonly BeirDoc[],
  targetDir: string
): MaterializedCorpus => {
  mkdirSync(targetDir, { recursive: true });
  const pairs = docs.map(doc => writeDoc(targetDir, doc));
  const fileNameById = new Map(pairs);
  pruneStaleDocs(targetDir, new Set(fileNameById.values()));
  return {
    dir: targetDir,
    docCount: pairs.length,
    presentFileCount: presentDocFiles(targetDir).length,
    fileNameById,
    idByFileName: new Map(pairs.map(([id, fileName]) => [fileName, id])),
  };
};

/**
 * The throwaway profile for one dataset, as an in-memory object — `ingest()`
 * takes it directly, so nothing is written to disk and nothing depends on the
 * process's working directory. Every location is absolute for the same reason.
 */
export const buildProfile = (spec: ProfileSpec): IngestProfile => ({
  name: `dp-gnosis-bench-${spec.datasetId}`,
  domains: PROFILE_DOMAINS,
  types: PROFILE_TYPES,
  defaultType: PROFILE_DEFAULT_TYPE,
  domainRules: [{ prefix: `${spec.corpusDirName}/`, domain: PROFILE_DOMAIN }],
  typeRules: [{ prefix: `${spec.corpusDirName}/`, type: PROFILE_TYPE }],
  segmentRules: [],
  repoRoot: spec.workDir,
  corpusRoots: [spec.corpusDirName],
  atomsDir: resolve(spec.workDir, `${spec.datasetId}-atoms`),
  indexPath: resolve(spec.workDir, `${spec.datasetId}-index`),
  atomMaxChars: spec.atomMaxChars,
});
