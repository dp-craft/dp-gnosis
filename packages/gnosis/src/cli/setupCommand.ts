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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveChatModel } from '../chat.js';
import { RERANK_MODEL_ID } from '../config.js';
import { configHome } from '../env.js';
import { resolveRephraseModel } from '../rephrase.js';
import { cliInvocation } from '../invocation.js';
import type { RerankHealth } from '../rerank.js';
import { rerankCatalogue, rerankHealth, rerankUrlFact } from '../rerank.js';
import { resolveSynthesizeModel } from '../synthesize.js';
import { userConfigPath } from '../userConfig.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_OK, EXIT_PARTIAL, usageError } from './outcome.js';
import { RERANK_MODEL_FLAG } from './retrieveCommand.js';

/** The verb, named here so `cli.ts` registers and scopes it from one place. */
export const SETUP_COMMAND = 'setup';

/** Ollama's OpenAI-compatible address — the second machine a reranker is served on. */
export const OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * How many ids one run may probe. Each probe may pay a cold model load, so the
 * cap is what keeps `setup` a command rather than an afternoon.
 */
export const MAX_PROBED_MODELS = 3;

/** The substring that makes an id worth a probe. Case-insensitive by design. */
const RERANKER_MARK = 'rerank';

const NOT_A_RERANKER = 'the id does not name a reranker';

const BEYOND_CAP = `beyond the ${String(MAX_PROBED_MODELS)}-model probe cap`;


const SELECTION_RULE =
  `selection: the shipped id ${RERANK_MODEL_ID} is probed FIRST whenever the server serves it — every recorded baseline was measured at that model — then the remaining rerank-marked ids in lexicographic order; the FIRST that passes is written and probing stops there`;

const REMEDY = 'packages/gnosis/OPTIONAL.md § Serving it has the llama-swap config to copy';

/** One id that was not probed, and why it was not — never a silent drop. */
interface Skipped {
  readonly id: string;
  readonly why: string;
}

/** One id that WAS probed, with the health verdict it produced. */
interface Probed {
  readonly model: string;
  readonly health: RerankHealth;
}

type ServerResult =
  | { readonly ok: true; readonly baseUrl: string; readonly models: readonly string[] }
  | { readonly ok: false; readonly tried: readonly string[] };

/** The addresses to try, in order: the resolved one, then Ollama's. */
const candidateUrls = (): readonly string[] => {
  const resolved = rerankUrlFact().value;
  return resolved === OLLAMA_URL ? [resolved] : [resolved, OLLAMA_URL];
};

const askServer = async (baseUrl: string, tried: readonly string[]): Promise<ServerResult> => {
  const catalogue = await rerankCatalogue(baseUrl);
  return catalogue.ok
    ? { ok: true, baseUrl, models: catalogue.models }
    : { ok: false, tried: [...tried, `${baseUrl} (${catalogue.cause})`] };
};

/** The first address that answers `GET /v1/models`, else every failure in order. */
const findServer = async (urls: readonly string[]): Promise<ServerResult> =>
  await urls.reduce<Promise<ServerResult>>(
    async (pending, url) => {
      const soFar = await pending;
      return soFar.ok ? soFar : await askServer(url, soFar.tried);
    },
    Promise.resolve({ ok: false, tried: [] })
  );

/**
 * What one run will probe, and what it deliberately will not.
 *
 * The three ways an id is left out are reported DIFFERENTLY, and the split is
 * ACTIONABILITY, not tidiness.
 *
 * An id the CAP left out is a rerank-capable model this run did not try, and
 * the reader can act on it — name it with `--rerank-model`. So it is ITEMISED,
 * one line each.
 *
 * An id the NAME FILTER left out (a chat model) and an id `--rerank-model`
 * excluded are both noise the reader can do nothing with. Measured against a
 * real llama-swap, they were 20+ lines burying the single line that matters, on
 * the default path every user takes. So each class collapses into one COUNTED
 * summary — counted, never dropped, because an id that vanished from the report
 * reads as an id that failed.
 */
interface Candidates {
  readonly probe: readonly string[];
  readonly skipped: readonly Skipped[];
  readonly summary: string | undefined;
}

const skippedFor = (models: readonly string[], probe: readonly string[], why: (id: string) => string): readonly Skipped[] =>
  [...models]
    .filter(id => !probe.includes(id))
    .sort()
    .map(id => ({ id, why: why(id) }));

/** One counted line, or nothing at all when there is nothing to count. */
const summaryLine = (count: number, noun: string, why: string): string | undefined =>
  count === 0 ? undefined : `  ${String(count)} ${noun} id${count === 1 ? '' : 's'} not probed — ${why}`;

const restrictedSummary = (others: number, requested: string): string | undefined =>
  summaryLine(others, 'other served', `${RERANK_MODEL_FLAG} named ${requested}`);

const namedCandidates = (models: readonly string[], requested: string): Candidates => ({
  probe: [requested],
  skipped: [],
  summary: restrictedSummary(models.filter(id => id !== requested).length, requested),
});

/**
 * The shipped id goes FIRST when it is served. Alphabetical order alone put
 * `bge-reranker-v2-m3` — superseded at `92d683e2` — ahead of it, so a real
 * server's four rerank-marked ids exhausted the cap before the champion was
 * reached and `setup` reported success over a model no recorded baseline uses.
 * It also makes the common case ONE probe rather than three, and each probe can
 * pay a cold model load.
 */
const orderShippedFirst = (named: readonly string[]): readonly string[] =>
  named.includes(RERANK_MODEL_ID)
    ? [RERANK_MODEL_ID, ...named.filter(id => id !== RERANK_MODEL_ID)]
    : named;

const filteredCandidates = (models: readonly string[]): Candidates => {
  const named = orderShippedFirst([...models].filter(id => id.toLowerCase().includes(RERANKER_MARK)).sort());
  const probe = named.slice(0, MAX_PROBED_MODELS);
  return {
    probe,
    skipped: skippedFor(named, probe, () => BEYOND_CAP),
    summary: summaryLine(models.length - named.length, 'served', NOT_A_RERANKER),
  };
};

const selectCandidates = (models: readonly string[], requested: string | undefined): Candidates =>
  requested === undefined ? filteredCandidates(models) : namedCandidates(models, requested);

const passed = (probed: readonly Probed[]): Probed | undefined =>
  probed.find(entry => entry.health.kind === 'healthy');

/** Sequential by construction, and it STOPS at the first pass — each probe costs a load. */
const probeCandidates = async (baseUrl: string, ids: readonly string[]): Promise<readonly Probed[]> =>
  await ids.reduce<Promise<readonly Probed[]>>(async (pending, model) => {
    const done = await pending;
    if (passed(done) !== undefined) return done;
    return [...done, { model, health: await rerankHealth({ baseUrl, model }) }];
  }, Promise.resolve([]));

/** The whole file as written, so a key this build does not read still survives. */
const readRaw = (path: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
};

interface Written {
  readonly path: string;
  readonly replaced: unknown;
}

const writeRerank = (url: string, model: string): Written => {
  const path = userConfigPath(configHome());
  const existing = readRaw(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, rerank: { url, model } }, null, 2)}\n`, 'utf8');
  return { path, replaced: existing['rerank'] };
};

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
    ...replacedLine(written.replaced),
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
  const written = writeRerank(baseUrl, winner.model);
  const rest = [...probed.map(verdictLine), ...skipLines(skipped, candidates.summary)];
  return {
    exitCode: EXIT_OK,
    data: {
      command: SETUP_COMMAND,
      url: baseUrl,
      model: winner.model,
      configPath: written.path,
      replaced: written.replaced,
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
