/**
 * `setup` — configure the reranker in ONE non-interactive command: find the
 * server, find a model on it that actually discriminates, and write that pair
 * into `config.json`.
 *
 * Four rules shape it.
 *
 * It probes a BOUNDED set. `rerank.ts:PROBE_TIMEOUT_MS` is 300 s because a
 * llama-swap cold load was measured at minutes, so probing a served catalogue
 * of twenty models is an hour of foreground wait. Only ids whose NAME says
 * reranker are probed, at most {@link MAX_PROBED_MODELS} of them, and every id
 * left out is reported WITH the reason — a candidate silently dropped reads as
 * a candidate that failed.
 *
 * It REJECTS a model that fails `rerankHealth`, and that rejection is the whole
 * point: most published Qwen3-Reranker GGUFs answer HTTP 200 with well-formed
 * numbers around 4.5e-23 through a missing `cls.output.weight` head
 * (`OPTIONAL.md`). Writing one would configure a reranker that reranks nothing
 * while every later run exits 0 — a component that produced nothing, recorded
 * as data.
 *
 * It MERGES the file rather than replacing it. `config.json` also carries
 * `dataRoot`, and a setup command that relocated the user's vault as a side
 * effect of configuring a URL is exactly the silent-wrong-location failure the
 * config loader exists to police.
 *
 * It is NON-INTERACTIVE and its selection rule is stated in its own output:
 * candidates are probed in lexicographic id order and the FIRST that passes is
 * written. Probing stops there — every further probe costs a cold load.
 */
import { resolveChatModel } from '../chat.js';
import { RERANK_MODEL_ID } from '../config.js';
import { cliInvocation } from '../invocation.js';
import { resolveRephraseModel } from '../rephrase.js';
import { resolveSynthesizeModel } from '../synthesize.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import type { Candidates, Probed, Skipped, Written } from './rerankSetup.js';
import {
  candidateUrls,
  findServer,
  MAX_PROBED_MODELS,
  OLLAMA_URL,
  passed,
  probeCandidates,
  selectCandidates,
  writeUserConfig
} from './rerankSetup.js';
import { RERANK_MODEL_FLAG } from './retrieveCommand.js';

export { MAX_PROBED_MODELS, OLLAMA_URL };

/** The verb, named here so `cli.ts` registers and scopes it from one place. */
export const SETUP_COMMAND = 'setup';

const SELECTION_RULE =
  `selection: the shipped id ${RERANK_MODEL_ID} is probed FIRST whenever the server serves it — every recorded baseline was measured at that model — then the remaining rerank-marked ids in lexicographic order; the FIRST that passes is written and probing stops there`;

const REMEDY = 'packages/gnosis/OPTIONAL.md § Serving it has the llama-swap config to copy';

const verdictLine = (entry: Probed): string =>
  entry.health.kind === 'healthy'
    ? `  ${entry.model}  PASSED — relevant ${String(entry.health.relevantScore)}, irrelevant ${String(entry.health.irrelevantScore)}`
    : `  ${entry.model}  REJECTED — ${entry.health.detail}`;

const skippedLine = (skipped: Skipped): string => `  ${skipped.id}  not probed — ${skipped.why}`;

/** Every "what was left out" line this run owes its reader, in one place. */
const skipLines = (skipped: readonly Skipped[], summary: string | undefined): readonly string[] => [
  ...skipped.map(skippedLine),
  ...(summary === undefined ? [] : [summary]),
];

const probedData = (probed: readonly Probed[]): readonly Readonly<Record<string, unknown>>[] =>
  probed.map(entry => ({ model: entry.model, ...entry.health }));

const noServerOutcome = (tried: readonly string[]): CommandOutcome => {
  const message = `setup: no reranker server answered GET /v1/models — tried ${tried.join(', ')}; start llama-swap (or Ollama) on one of those addresses, then re-run \`${cliInvocation()} ${SETUP_COMMAND}\` — ${REMEDY}`;
  return { exitCode: EXIT_PARTIAL, data: { command: SETUP_COMMAND, error: message, tried }, text: message };
};

const nothingPassedText = (baseUrl: string, probed: readonly Probed[], left: readonly string[]): string =>
  [
    `setup: ${baseUrl} answered, but no candidate passed the two-document discrimination probe — nothing was written`,
    ...probed.map(verdictLine),
    ...left,
    REMEDY,
  ].join('\n');

const nothingPassed = (
  baseUrl: string,
  probed: readonly Probed[],
  candidates: Candidates
): CommandOutcome => {
  const { skipped } = candidates;
  const text = nothingPassedText(baseUrl, probed, skipLines(skipped, candidates.summary));
  return {
    exitCode: EXIT_PARTIAL,
    data: {
      command: SETUP_COMMAND,
      url: baseUrl,
      error: text,
      probed: probedData(probed),
      skipped,
      skippedSummary: candidates.summary,
    },
    text,
  };
};

/** The one key `setup` writes, so the report names the rerank block and nothing else. */
const replacedRerank = (written: Written): unknown => written.replaced['rerank'];

const replacedLine = (replaced: unknown): readonly string[] =>
  replaced === undefined ? [] : [`  replaced the previous rerank block: ${JSON.stringify(replaced)}`];

const configuredText = (
  winner: Probed,
  baseUrl: string,
  written: Written,
  rest: readonly string[]
): string =>
  [
    `setup: configured the reranker — ${winner.model} at ${baseUrl}`,
    `  written to ${written.path} (merged; every other key was kept)`,
    ...replacedLine(replacedRerank(written)),
    ...rest,
    SELECTION_RULE,
    `  use it with: ${cliInvocation()} search "<query>" --rerank`,
  ].join('\n');

const configured = (
  baseUrl: string,
  probed: readonly Probed[],
  candidates: Candidates,
  winner: Probed
): CommandOutcome => {
  const { skipped } = candidates;
  const written = writeUserConfig({ rerank: { url: baseUrl, model: winner.model } });
  const rest = [...probed.map(verdictLine), ...skipLines(skipped, candidates.summary)];
  return {
    exitCode: EXIT_OK,
    data: {
      command: SETUP_COMMAND,
      url: baseUrl,
      model: winner.model,
      configPath: written.path,
      replaced: replacedRerank(written),
      probed: probedData(probed),
      skipped,
      skippedSummary: candidates.summary,
    },
    text: configuredText(winner, baseUrl, written, rest),
  };
};

/**
 * One chat hop: the id it will ask for, and the `config.json` key that pins it.
 *
 * The three hops are REPORTED and never chosen. `setup` may write a reranker
 * because a two-document discrimination probe PROVES one discriminates; there
 * is no equivalent probe for a chat model, and an id picked because its name
 * looked right would configure a generator nobody measured, producing plausible
 * text — this repository's failure class exactly. So an unserved id is named,
 * with the key its owner must write by hand.
 */
interface ChatHop {
  readonly key: string;
  readonly id: string;
}

const chatHops = (): readonly ChatHop[] => [
  { key: 'models.rephrase', id: resolveRephraseModel() },
  { key: 'models.synthesize', id: resolveSynthesizeModel() },
  { key: 'models.enrich', id: resolveChatModel() },
];

const CHAT_PREAMBLE =
  'setup: chat hops are reported, never configured — no discrimination probe exists for a chat model, so these ids are yours to set';

const chatHopLine = (hop: ChatHop): string =>
  `  ${hop.id}  not served here — write "${hop.key}": "<an id this server advertises>" into config.json`;

/**
 * Every resolved chat id the catalogue just fetched does NOT advertise,
 * appended to whatever verdict the reranker probes produced — the two are
 * independent, so a run that configured a reranker and a run that configured
 * nothing owe their reader the same chat report.
 */
const withChatReport = (outcome: CommandOutcome, models: readonly string[]): CommandOutcome => {
  const unserved = chatHops().filter(hop => !models.includes(hop.id));
  if (unserved.length === 0) return outcome;
  return {
    ...outcome,
    data: { ...outcome.data, unservedChatModels: unserved },
    text: [outcome.text, CHAT_PREAMBLE, ...unserved.map(chatHopLine)].join('\n'),
  };
};

const runProbes = async (
  baseUrl: string,
  models: readonly string[],
  requested: string | undefined
): Promise<CommandOutcome> => {
  const candidates = selectCandidates(models, requested);
  const probed = await probeCandidates(baseUrl, candidates.probe);
  const winner = passed(probed);
  const outcome =
    winner === undefined
      ? nothingPassed(baseUrl, probed, candidates)
      : configured(baseUrl, probed, candidates, winner);
  return withChatReport(outcome, models);
};

const POSITIONAL_ERROR = `setup takes no arguments — it probes the servers this machine may run and writes what it finds; name one model with ${RERANK_MODEL_FLAG} <id> to probe that id alone`;

export const runSetupCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  if (context.positionals.length > 0) return usageError(POSITIONAL_ERROR);
  const server = await findServer(candidateUrls());
  if (!server.ok) return noServerOutcome(server.tried);
  return await runProbes(server.baseUrl, server.models, stringFlag(context.flags, RERANK_MODEL_FLAG));
};
