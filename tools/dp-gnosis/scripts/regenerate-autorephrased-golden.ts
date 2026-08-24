/**
 * Regenerate a FROZEN auto-rephrased arm golden from its base golden.
 *
 * Why this exists. `golden-set-autorephrased.v2.json` and
 * `golden-set-hu-autorephrased.v1.json` hold rewrites produced by prompt **v1**
 * through the shipped `--rephrase` path. `REPHRASE_PROMPT_VERSION` is now `v2`,
 * so those files are evidence about a prompt that no longer exists and the
 * "re-measurement is one bench run" claim only holds once they are regenerated.
 * No committed producer existed — the originals were made by an ad-hoc loop, and
 * an ad-hoc loop is not a reproducible route.
 *
 * It calls the model, so it needs llama-swap serving `REPHRASE_MODEL_ID` on
 * `RERANK_DEFAULT_URL` (a GPU). It writes ONE file, the one named by `--out`.
 *
 *   npx tsx tools/dp-gnosis/scripts/regenerate-autorephrased-golden.ts \
 *     --base tools/dp-gnosis/golden/golden-set.v2.json \
 *     --out  tools/dp-gnosis/golden/golden-set-autorephrased.v2.json
 *
 * It goes through `rephraseQuery` itself rather than the CLI, so the rewrite is
 * the SHIPPED one — including the rule-5 guard, which returns a query unchanged
 * and never reaches the model. A reimplementation of the prompt here would
 * measure something the tool does not do.
 *
 * `variant` / `variantNote` are carried over from the existing `--out` file:
 * they are authored prose about the arm, not a derived value, and regenerating
 * MUST NOT silently reword them. Everything else is re-derived — `rephrasedFrom`
 * from the base query, `rephraseChanged` from the comparison, and the model and
 * prompt version from the live constants, so the file always states which prompt
 * produced it.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { REPHRASE_PROMPT_VERSION } from '../src/config.js';
import { rephraseQuery, resolveRephraseModel } from '../src/rephrase.js';

interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly rephrasedFrom?: string;
  readonly rephraseChanged?: boolean;
}

interface Golden {
  readonly queries: readonly GoldenQuery[];
  readonly variant?: string;
  readonly variantNote?: string;
}

const readGolden = async (path: string): Promise<Golden & Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Golden & Record<string, unknown>;

const flag = (argv: readonly string[], name: string): string => {
  const value = argv[argv.indexOf(`--${name}`) + 1];
  if (argv.indexOf(`--${name}`) < 0 || value === undefined) {
    throw new Error(`regenerate-autorephrased-golden: --${name} <path> is required`);
  }
  return value;
};

/** A refusal FAILS the regeneration: a half-rewritten golden is a silent arm defect. */
const rewriteOne = async (topic: GoldenQuery): Promise<GoldenQuery> => {
  const outcome = await rephraseQuery(topic.query);
  if (!outcome.ok) throw new Error(`${topic.id}: ${outcome.error}`);
  return {
    ...topic,
    query: outcome.rewritten,
    rephrasedFrom: topic.query,
    rephraseChanged: outcome.rewritten !== topic.query,
  };
};

/** Sequential on purpose — one llama-swap slot, and the order is the golden's. */
const rewriteAll = async (topics: readonly GoldenQuery[]): Promise<readonly GoldenQuery[]> =>
  await topics.reduce<Promise<readonly GoldenQuery[]>>(
    async (previous, topic) => [...(await previous), await rewriteOne(topic)],
    Promise.resolve([])
  );

const main = async (argv: readonly string[]): Promise<void> => {
  const base = await readGolden(flag(argv, 'base'));
  const existing = await readGolden(flag(argv, 'out'));
  const queries = await rewriteAll(base.queries);
  const regenerated = {
    ...base,
    variant: existing.variant,
    variantNote: existing.variantNote,
    queries,
    rephrasedCount: queries.filter(topic => topic.rephraseChanged === true).length,
    rephraseModel: resolveRephraseModel(),
    rephrasePromptVersion: REPHRASE_PROMPT_VERSION,
  };
  await writeFile(flag(argv, 'out'), `${JSON.stringify(regenerated, null, 2)}\n`, 'utf8');
  process.stdout.write(`rewrote ${queries.length} topics under prompt ${REPHRASE_PROMPT_VERSION}\n`);
};

await main(process.argv.slice(2));
