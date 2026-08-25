/**
 * `enrich` — generate the enrichment sidecar for the atoms of one profile.
 *
 * It is a THIRD verb between `ingest` and `index`, not a step inside either.
 * `ingest` MUST stay model-free (plan § 2) so the same corpus produces
 * byte-identical atoms, and `index` MUST build with an ABSENT sidecar so
 * enrichment stays strictly additive. This command is the only place a
 * generator is called, and the only place a JSONL sidecar is written.
 *
 * The sidecar defaults BESIDE the atoms directory rather than inside it: an
 * atoms directory is stamped with its owning profile and pruned wholesale on
 * re-ingest, and a sidecar living there would be destroyed by the very command
 * whose output it survives (GNOSIS-GUIDE.md § Landmines, shared work
 * directory). One profile, one atoms dir, one sidecar beside it.
 *
 * A refusal is a PARTIAL result, never a failure of the whole run: whatever
 * landed before it is on disk and valid, and the next run resumes there. Exit 3
 * says exactly that, and the message names the correction.
 */
import { dirname, resolve } from 'node:path';

import { createHttpChatProvider } from '../chat.js';
import type { EnrichmentReport } from '../enrich.js';
import { enrichAtoms } from '../enrich.js';
import { ENRICHMENT_PROMPT_VERSION } from '../enrichment.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';

/**
 * The sidecar path. Shared with `index`, which READS the file this command
 * WRITES — one flag for one artefact, so the two commands cannot be pointed at
 * different files by accident.
 */
export const ENRICHMENT_FLAG = '--enrichment';

/** The E2 pilot bound: enrich at most n atoms that are not already fresh. */
export const LIMIT_FLAG = '--limit';

/** The generator id, overriding the shipped one for this run alone. */
export const ENRICH_MODEL_FLAG = '--enrich-model';

/** The file name the sidecar takes beside the atoms directory. */
export const ENRICHMENT_FILE_NAME = 'enrichment.jsonl';

/** Beside the atoms directory, never inside it — a re-ingest prunes that tree. */
export const defaultEnrichmentPath = (atomsDir: string): string =>
  resolve(dirname(atomsDir), ENRICHMENT_FILE_NAME);

const limitError = (raw: string): string =>
  `${LIMIT_FLAG} must be a positive integer — got "${raw}"; pass e.g. \`${LIMIT_FLAG} 100\` to enrich a pilot batch, or omit it to enrich every stale atom`;

type LimitResult =
  | { readonly ok: true; readonly limit: number | undefined }
  | { readonly ok: false; readonly error: string };

const parseLimit = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const resolveLimit = (raw: string | undefined): LimitResult => {
  if (raw === undefined) return { ok: true, limit: undefined };
  const limit = parseLimit(raw);
  return limit === undefined ? { ok: false, error: limitError(raw) } : { ok: true, limit };
};

/** One progress line per {@link PROGRESS_EVERY} atoms, on stderr. */
const writeProgress = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const deferredNote = (report: EnrichmentReport): string =>
  report.deferred === 0
    ? ''
    : `; ${report.deferred} stale atom(s) left for the next run by ${LIMIT_FLAG}`;

const summaryText = (report: EnrichmentReport, sidecar: string): string =>
  `enrich: ${report.enriched} enriched, ${report.skipped} already fresh of ${report.atoms} atom(s) → ${sidecar}${deferredNote(report)}`;

const textOf = (report: EnrichmentReport, sidecar: string): string =>
  report.failure === undefined
    ? summaryText(report, sidecar)
    : `${summaryText(report, sidecar)}\n${report.failure}`;

/** What one enrichment run reports. `model` and `promptVersion` are the
 * staleness key every record was written under, so a reader can tell which
 * contract the sidecar now holds. */
const outcomeFor = (
  report: EnrichmentReport,
  sidecar: string,
  model: string
): CommandOutcome => ({
  exitCode: report.failure === undefined ? EXIT_OK : EXIT_PARTIAL,
  data: {
    command: 'enrich',
    model,
    promptVersion: ENRICHMENT_PROMPT_VERSION,
    atoms: report.atoms,
    enriched: report.enriched,
    skipped: report.skipped,
    sidecar,
    ...(report.failure === undefined ? {} : { note: report.failure }),
  },
  text: textOf(report, sidecar),
});

/** The sidecar this run reads and appends to — the flag, else the default. */
export const enrichmentPathOf = (context: CommandContext): string =>
  stringFlag(context.flags, ENRICHMENT_FLAG) ?? defaultEnrichmentPath(context.atomsDir);

const run = async (context: CommandContext, limit: number | undefined): Promise<CommandOutcome> => {
  const sidecarPath = enrichmentPathOf(context);
  const model = stringFlag(context.flags, ENRICH_MODEL_FLAG);
  const provider = createHttpChatProvider(model === undefined ? {} : { model });
  const report = await enrichAtoms({
    atomsDir: context.atomsDir,
    sidecarPath,
    provider,
    limit,
    onProgress: writeProgress,
  });
  return outcomeFor(report, sidecarPath, provider.id);
};

export const runEnrichCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const limit = resolveLimit(stringFlag(context.flags, LIMIT_FLAG));
  return limit.ok ? await run(context, limit.limit) : usageError(limit.error);
};
