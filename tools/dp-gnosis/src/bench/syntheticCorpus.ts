/**
 * Deterministic synthetic atoms for the ceiling rungs (1 000 / 10 000).
 *
 * `Math.random()` is FORBIDDEN here: a benchmark whose corpus differs between
 * machines and between days cannot be compared to an earlier report, which is
 * the whole point of persisting one. Every word is derived from an FNV-1a hash
 * of `seed:index:slot`, so generation is a pure function of `(count, seed)` —
 * no mutable PRNG state, no ordering dependency, identical bytes everywhere.
 *
 * The vocabulary is small on purpose: a realistic inverted index needs terms
 * that RECUR across documents, and a corpus of unique nonsense tokens would
 * measure a degenerate posting-list shape no real vault has.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AtomFrontmatter } from '../atom.js';
import { serializeAtom } from '../atom.js';
import { atomDomains } from '../vocabulary.js';
import { sequential } from './sequential.js';

const VOCAB: readonly string[] = [
  'retrieval', 'adapter', 'ranking', 'index', 'lexical', 'vector', 'atom', 'vault',
  'query', 'token', 'corpus', 'recall', 'latency', 'harness', 'gate', 'runner',
  'contract', 'boundary', 'selector', 'store', 'container', 'renderer', 'snapshot', 'coverage',
  'schema', 'migration', 'persistence', 'stream', 'session', 'provider', 'proxy', 'telemetry',
];
const FALLBACK_WORD = 'atom';
const FALLBACK_DOMAIN = 'runner';
const TITLE_WORDS = 4;
const BODY_WORDS = 48;
const ID_DIGITS = 6;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** One generated atom: its id, its filename, and its serialized file content. */
export interface SyntheticAtom {
  readonly id: string;
  readonly fileName: string;
  readonly content: string;
}

const hash32 = (text: string): number =>
  [...text].reduce(
    (hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0,
    FNV_OFFSET
  );

/** Which atom's words are being drawn: the pure coordinates of one document. */
interface AtomSeed {
  readonly seed: number;
  readonly index: number;
}

const wordAt = (at: AtomSeed, slot: number): string =>
  VOCAB[hash32(`${at.seed}:${at.index}:${slot}`) % VOCAB.length] ?? FALLBACK_WORD;

const words = (at: AtomSeed, count: number, offset: number): string =>
  Array.from({ length: count }, (_unused, slot) => wordAt(at, slot + offset)).join(' ');

/** The domain this seed lands on, read from the ACTIVE profile at call time. */
const domainAt = (index: number): string => {
  const domains = atomDomains();
  return domains[index % domains.length] ?? FALLBACK_DOMAIN;
};

const frontmatterFor = (at: AtomSeed, id: string): AtomFrontmatter => ({
  type: 'knowledge',
  id,
  title: words(at, TITLE_WORDS, 0),
  x_domain: domainAt(at.index),
  status: 'stable',
  sources: [`synthetic://${at.seed}/${at.index}`],
});

const atomAt = (at: AtomSeed): SyntheticAtom => {
  const id = `syn-${at.seed}-${String(at.index).padStart(ID_DIGITS, '0')}`;
  const body = `${words(at, BODY_WORDS, TITLE_WORDS)}\n`;
  return { id, fileName: `${id}.md`, content: serializeAtom(frontmatterFor(at, id), body) };
};

/** Pure: the same `(count, seed)` always yields byte-identical atoms. */
export const generateSyntheticAtoms = (count: number, seed: number): readonly SyntheticAtom[] =>
  Array.from({ length: count }, (_unused, index) => atomAt({ seed, index }));

/**
 * Write the atoms into `dir`, one file at a time. Sequential rather than
 * `Promise.all`: 10 000 concurrent opens exhausts the file-descriptor limit.
 */
export const writeSyntheticCorpus = async (
  dir: string,
  atoms: readonly SyntheticAtom[]
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await sequential(atoms.length, async index => {
    const atom = atoms[index];
    return atom === undefined ? undefined : await writeFile(join(dir, atom.fileName), atom.content, 'utf8');
  });
};
