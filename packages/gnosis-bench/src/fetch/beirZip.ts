/**
 * `beir-zip` — download a BEIR archive once and unzip it into `data/`.
 *
 * The archives are the canonical ones from the BEIR authors' host, and each
 * expands to a directory named after the dataset (`nfcorpus.zip` →
 * `nfcorpus/corpus.jsonl`), which is exactly the layout `beir.ts` reads. So
 * nothing is moved or rewritten after the unzip: a rearranged tree would be one
 * more thing that could differ from the published dataset.
 *
 * IDEMPOTENCE is the load-bearing property. `corpus.jsonl` on disk means the
 * dataset is present, and the function returns before touching the network —
 * a benchmark that re-downloads 100 MB on every run is a benchmark nobody runs
 * twice. The presence check is the CORPUS file, not the directory: an aborted
 * unzip leaves a directory behind, and treating that as "done" would score a
 * truncated corpus and record the number as if it were comparable.
 *
 * `unzip` is used through `execFile` rather than a dependency: the tool is
 * present on every platform this suite runs on, and a zip reader would be a new
 * dependency carrying its own failure modes for a job the OS already does.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BeirDataset } from '../manifest.js';

const CORPUS_FILE = 'corpus.jsonl';
const UNZIP_BIN = 'unzip';

/** `-o` overwrite (a half-written tree must not prompt), `-q` quiet. */
const UNZIP_FLAGS: readonly string[] = ['-o', '-q'];

const downloadFailed = (entry: BeirDataset, status: number): string =>
  `dp-gnosis-bench: dataset "${entry.id}" download failed with HTTP ${status} ` +
  `for ${entry.source} — check the URL in datasets.json, or disable the entry`;

const missingCorpus = (entry: BeirDataset, dir: string): string =>
  `dp-gnosis-bench: dataset "${entry.id}" unzipped without producing ${dir}/${CORPUS_FILE} — ` +
  `the archive at ${entry.source} does not use the BEIR layout ` +
  `(<id>/corpus.jsonl, <id>/queries.jsonl, <id>/qrels/<split>.tsv); ` +
  'unpack it by hand and switch the entry to format "beir-local"';

const download = async (entry: BeirDataset, target: string): Promise<void> => {
  const response = await fetch(entry.source);
  if (!response.ok) throw new Error(downloadFailed(entry, response.status));
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
};

const unzip = async (zipPath: string, targetDir: string): Promise<void> =>
  new Promise((accept, reject) => {
    execFile(UNZIP_BIN, [...UNZIP_FLAGS, zipPath, '-d', targetDir], error =>
      error === null ? accept() : reject(error)
    );
  });

/**
 * The dataset's directory, downloading and unpacking it only when its
 * `corpus.jsonl` is absent. Returns `<dataDir>/<entry.id>`.
 */
export const ensureBeirDataset = async (
  entry: BeirDataset,
  dataDir: string
): Promise<string> => {
  const dir = resolve(dataDir, entry.id);
  if (existsSync(resolve(dir, CORPUS_FILE))) return dir;
  mkdirSync(dataDir, { recursive: true });
  const zipPath = resolve(dataDir, `${entry.id}.zip`);
  await download(entry, zipPath);
  await unzip(zipPath, dataDir);
  if (!existsSync(resolve(dir, CORPUS_FILE))) throw new Error(missingCorpus(entry, dir));
  return dir;
};
