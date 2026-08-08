/**
 * Corpus preparation for the benchmark.
 *
 * Every corpus the bench measures is a WORKING COPY under the bench work
 * directory, never the live vault. Two reasons, both load-bearing:
 * (a) the single-atom incremental-update metric MUTATES the corpus, and a
 *     benchmark that edits `gnosis/atoms/` is a benchmark that corrupts the
 *     thing it measures;
 * (b) an index built beside a copy cannot be left stale against the real vault.
 */
import { cp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SyntheticAtom } from './syntheticCorpus.js';
import { generateSyntheticAtoms, writeSyntheticCorpus } from './syntheticCorpus.js';

const MARKDOWN_EXT = '.md';

/** One prepared corpus the bench runs every adapter over. */
export interface BenchCorpus {
  readonly label: string;
  readonly atomsDir: string;
  readonly atomCount: number;
  /**
   * Whether recall/MRR are meaningful here. FALSE for synthetic rungs: the
   * golden set names atoms of the REAL vault, so a synthetic corpus would score
   * a structural 0 that reads as a quality finding but measures nothing. Those
   * rungs are latency/size ceilings only.
   */
  readonly scoresMetrics: boolean;
}

const countAtoms = async (dir: string): Promise<number> => {
  const entries = await readdir(dir).catch(() => []);
  return entries.filter(name => name.endsWith(MARKDOWN_EXT)).length;
};

/** Copy the real seed vault into the work dir, replacing any earlier copy. */
export const materializeRealCorpus = async (
  sourceDir: string,
  workDir: string,
  label: string
): Promise<BenchCorpus> => {
  const atomsDir = join(workDir, `corpus-${label}`);
  await rm(atomsDir, { recursive: true, force: true });
  await cp(sourceDir, atomsDir, { recursive: true });
  return { label, atomsDir, atomCount: await countAtoms(atomsDir), scoresMetrics: true };
};

/** Generate a deterministic synthetic rung of `count` atoms. */
export const materializeSyntheticCorpus = async (
  workDir: string,
  count: number,
  seed: number
): Promise<BenchCorpus> => {
  const label = `synthetic-${count}`;
  const atomsDir = join(workDir, `corpus-${label}`);
  await rm(atomsDir, { recursive: true, force: true });
  await writeSyntheticCorpus(atomsDir, generateSyntheticAtoms(count, seed));
  return { label, atomsDir, atomCount: count, scoresMetrics: false };
};

/** The one atom written and removed to time an incremental update. */
const PROBE: SyntheticAtom = generateSyntheticAtoms(1, 0)[0] ?? {
  id: 'probe',
  fileName: 'probe.md',
  content: '',
};

const probePath = (corpus: BenchCorpus): string => join(corpus.atomsDir, `update-probe-${PROBE.fileName}`);

/** Add one atom to the corpus, so the next index build has one atom of delta. */
export const addUpdateProbe = async (corpus: BenchCorpus): Promise<void> =>
  await writeFile(probePath(corpus), PROBE.content, 'utf8');

/** Remove the probe, restoring the corpus to its measured state. */
export const removeUpdateProbe = async (corpus: BenchCorpus): Promise<void> =>
  await unlink(probePath(corpus)).catch(() => undefined);
