/**
 * Streaming line reader for the corpus files.
 *
 * `readFileSync(path,'utf8')` cannot read a BEIR corpus of Tier-1 size: Node
 * caps a single string at 0x1fffffe8 (~0.5 GB) and `webis-touche2020` is
 * 0.69 GB across 382,545 documents, so the read threw before any parsing
 * happened. Both corpus readers go through this module instead, which decodes
 * the file in chunks and never materialises it as one string.
 *
 * The line semantics are the ones the previous
 * `readFileSync(...).split('\n').filter(l => l.trim().length > 0)` expression
 * had, and `lines.test.ts` pins them against that expression verbatim: split on
 * `\n` only (so a CRLF file keeps its `\r` inside the line, exactly as before),
 * drop lines that are empty after `trim()`, preserve file order.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** One read at a time; the file is consumed sequentially and never held whole. */
const CHUNK_BYTES = 1 << 20;

type Step<T> = (acc: T, line: string) => T;

interface FoldState<T> {
  readonly acc: T;
  /** Bytes after the last `\n` of the previous chunk — a line split in two. */
  readonly pending: string;
}

const keepNonEmpty =
  <T>(step: Step<T>): Step<T> =>
    (acc, line) =>
      line.trim().length > 0 ? step(acc, line) : acc;

/** Folds the complete lines of `text`, carrying the unterminated remainder. */
const advance = <T>(state: FoldState<T>, text: string, step: Step<T>): FoldState<T> => {
  const parts = (state.pending + text).split('\n');
  return {
    pending: parts[parts.length - 1] ?? '',
    acc: parts.slice(0, -1).reduce(keepNonEmpty(step), state.acc),
  };
};

/**
 * The one imperative loop in this module. A chunked read is inherently stateful
 * — each `readSync` advances the file position and may end mid-character — and
 * the alternative (one string, then `.split`) is the defect this module exists
 * to remove. The mutable state is confined to these two bindings.
 */
const foldChunks = <T>(fd: number, seed: T, step: Step<T>): FoldState<T> => {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let state: FoldState<T> = { acc: seed, pending: '' };
  let bytes = readSync(fd, buffer, 0, CHUNK_BYTES, null);
  while (bytes > 0) {
    state = advance(state, decoder.write(buffer.subarray(0, bytes)), step);
    bytes = readSync(fd, buffer, 0, CHUNK_BYTES, null);
  }
  return advance(state, decoder.end(), step);
};

/** Streams `path`, folding every line whose `trim()` is non-empty, in file order. */
const foldNonEmptyLines = <T>(path: string, seed: T, step: Step<T>): T => {
  const fd = openSync(path, 'r');
  try {
    const state = foldChunks(fd, seed, step);
    return keepNonEmpty(step)(state.acc, state.pending);
  } finally {
    closeSync(fd);
  }
};

/**
 * One `push` per line rather than `[...acc, x]`: the spread is O(n²) and a
 * 382,545-line corpus makes it unusable. The array is created by the fold and
 * never escapes it until it is complete.
 */
const collect =
  <T>(project: (line: string) => T): Step<T[]> =>
    (acc, line) => {
      acc.push(project(line));
      return acc;
    };

/** Every non-empty line of `path`, projected, in file order. */
export const mapNonEmptyLines = <T>(path: string, project: (line: string) => T): readonly T[] =>
  foldNonEmptyLines<T[]>(path, [], collect(project));

/** How many lines of `path` are non-empty after `trim()`. */
export const countNonEmptyLines = (path: string): number =>
  foldNonEmptyLines<number>(path, 0, acc => acc + 1);
