/**
 * The benchmark's read of the golden set: a CONTENT HASH plus a non-throwing
 * load.
 *
 * Schema, parsing and corpus validation are NOT re-implemented here — they are
 * owned by `src/goldenSet.ts`, and this module calls `loadVerifiedGoldenSet`,
 * the entry point that module names as the only one a benchmark may use. Two
 * things are added, and only two:
 *
 * 1. `sha256` of the file bytes. A persisted report has to be tied to the exact
 *    query set that produced it; `frozenAt` is authored text and an edited file
 *    can carry an unchanged one.
 * 2. A `Result` instead of a throw. The CLI must answer a bad `--golden-set`
 *    with exit 2 and a message naming the correction, not with a stack trace.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { GoldenSet } from '../goldenSet.js';
import { loadVerifiedGoldenSet } from '../goldenSet.js';

export type GoldenSetSourceResult =
  | { readonly ok: true; readonly set: GoldenSet; readonly hash: string }
  | { readonly ok: false; readonly error: string };

/** SHA-256 of the file CONTENT, so a report names the exact bytes it measured. */
export const hashGoldenSetText = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const verified = (path: string, atomsDir: string, raw: string): GoldenSetSourceResult => {
  try {
    return { ok: true, set: loadVerifiedGoldenSet(path, atomsDir), hash: hashGoldenSetText(raw) };
  } catch (error) {
    return { ok: false, error: `${messageOf(error)} — fix ${path}, or pass \`--golden-set <file>\`` };
  }
};

/**
 * Load and verify the golden set at `path` against the corpus at `atomsDir`.
 * The file is read once here for the hash; `loadVerifiedGoldenSet` reads it
 * again for the parse, which keeps the parsing contract in one module.
 */
export const readGoldenSetSource = async (
  path: string,
  atomsDir: string
): Promise<GoldenSetSourceResult> => {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  return raw === undefined
    ? {
        ok: false,
        error: `golden set not found at ${path} — pass \`--golden-set <file>\` pointing at the frozen query set`,
      }
    : verified(path, atomsDir, raw);
};
