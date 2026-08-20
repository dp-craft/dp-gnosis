/**
 * `answer` — the same retrieval as `retrieve`, delivered as a knowledge pack.
 *
 * It reuses {@link performRetrieval} whole: the ranking, the rerank, the
 * relevance floor, the budget and the exit-code contract are the retrieve
 * command's and MUST NOT be re-derived here, or two commands would answer the
 * same question with two rankings. What this file owns is the RENDERING — the
 * delimited containment block in `pack.ts` — and the two flags a pack cannot
 * honour.
 */
import type { RetrievedAtom } from '../port.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { ChargedText } from './counting.js';
import { explainAtoms } from './explain.js';
import { FORMAT_FLAG } from './format.js';
import { groupByDocument } from './grouping.js';
import type { CommandOutcome } from './outcome.js';
import { usageError } from './outcome.js';
import type { Pack } from './pack.js';
import { atomChunk, packChrome, renderPack, soleGroup } from './pack.js';
import type { BudgetedResult, RetrievalRun, RetrieveRequest } from './retrieveCommand.js';
import {
  effectiveQuery,
  FLAT_FLAG,
  noteLines,
  performRetrieval
} from './retrieveCommand.js';

/** This command's name, on its payload and on a refusal that renders no pack. */
const ANSWER_COMMAND = 'answer';

/**
 * `--flat` says "deliver the ranking ungrouped", and the pack is grouped by
 * source document BY CONSTRUCTION — a document header, then its atoms in
 * reading order. Honouring the flag would take the pack apart; ignoring it
 * would let a run carry a flag that did nothing under a success code.
 */
const flatRefusal = (): string =>
  `${FLAT_FLAG} is not accepted by ${ANSWER_COMMAND} — the knowledge pack is grouped by source document by construction, so an ungrouped pack does not exist and the flag would do nothing under a success code; drop it, or run \`retrieve ${FLAT_FLAG}\` for the ungrouped ranking`;

/**
 * The containment block IS the pack's delimited rendering. A second delimited
 * rendering would be a third format to keep in step with it, and the two would
 * disagree the first time one of them changed.
 */
const xmlRefusal = (): string =>
  `${FORMAT_FLAG} xml is not accepted by ${ANSWER_COMMAND} — the knowledge pack is already a delimited block carrying every atom body, so a second one would be a third rendering to keep in step; pass ${FORMAT_FLAG} text or ${FORMAT_FLAG} json`;

const flagRefusal = (context: CommandContext): string | undefined => {
  if (context.flags[FLAT_FLAG] === true) return flatRefusal();
  return stringFlag(context.flags, FORMAT_FLAG) === 'xml' ? xmlRefusal() : undefined;
};

/**
 * What one atom costs the PACK, not what its body costs.
 *
 * Every atom is charged its document header, including the ones that render
 * under a header a sibling already printed. The charge sees one atom at a time,
 * so which atom renders the header is not knowable when the budget runs — and
 * the header MOVES: if the budget skips the atom that would have printed it,
 * the next kept atom of that document prints it instead. Charging every atom is
 * the over-charge that makes both cases fit, which is the safe direction.
 */
const packCharge: ChargedText = (atom: RetrievedAtom): string =>
  atomChunk(atom, true, soleGroup(atom));

const packOf = (request: RetrieveRequest, budgeted: BudgetedResult, confidence: string): Pack =>
  renderPack({
    query: request.query,
    atoms: budgeted.result.atoms,
    confidence,
    tokens: budgeted.usedTokens,
    maxTokens: budgeted.maxTokens,
    budgetMode: request.budgetMode,
    skipped: budgeted.skipped,
    notes: noteLines(request, budgeted),
  });

/** Omitted entirely when no rewrite happened, mirroring `retrieve`'s payload. */
const rewrittenField = (request: RetrieveRequest): Readonly<Record<string, string>> =>
  request.queryRewritten === undefined ? {} : { queryRewritten: request.queryRewritten };

const noteField = (
  request: RetrieveRequest,
  budgeted: BudgetedResult
): Readonly<Record<string, string>> => {
  const lines = noteLines(request, budgeted);
  return lines.length > 0 ? { note: lines.join('\n') } : {};
};

/** The run's own facts, stated once and shared by both halves of the payload. */
const runFields = (run: RetrievalRun): Readonly<Record<string, unknown>> => ({
  command: ANSWER_COMMAND,
  adapter: run.request.context.adapter,
  query: run.request.query,
  ...rewrittenField(run.request),
  k: run.request.k,
  mode: run.budgeted.result.mode,
  indexState: run.budgeted.result.indexState,
  count: run.budgeted.result.atoms.length,
  documents: groupByDocument(run.budgeted.result.atoms).length,
  poolSize: run.budgeted.poolSize,
});

/**
 * The `--json` payload. It carries the pack VERBATIM beside the atoms it was
 * built from, so a caller can paste the block or read the fields, and every
 * `[^id]` in the block resolves to an entry of `atoms[]`.
 */
const payload = (run: RetrievalRun, pack: Pack): Readonly<Record<string, unknown>> => ({
  ...runFields(run),
  budgetMode: run.request.budgetMode,
  maxTokens: run.budgeted.maxTokens,
  packTokens: run.budgeted.usedTokens,
  confidence: run.confidence,
  pack: pack.text,
  citations: pack.citations,
  atoms: explainAtoms(effectiveQuery(run.request), run.budgeted.result.atoms),
  skipped: run.budgeted.skipped,
  neutralised: pack.neutralised,
  ...noteField(run.request, run.budgeted),
});

/**
 * The pack is the text rendering: there is no second human form. `xml` is
 * absent, and the command refuses `--format xml` rather than falling back.
 */
const rendered = (run: RetrievalRun): CommandOutcome => {
  const pack = packOf(run.request, run.budgeted, run.confidence);
  return { exitCode: run.exitCode, data: payload(run, pack), text: pack.text };
};

/**
 * The chrome is reserved BEFORE the fit, so the ceiling bounds the pack rather
 * than only the atoms inside it — a caller sizing `--max-tokens` to its context
 * window pastes the whole block, delimiters included.
 */
export const runAnswerCommand = async (context: CommandContext): Promise<CommandOutcome> => {
  const refusal = flagRefusal(context);
  if (refusal !== undefined) return usageError(refusal);
  const chrome = packChrome(context.positionals.join(' '));
  const outcome = await performRetrieval(context, packCharge, chrome);
  return outcome.ok ? rendered(outcome.run) : outcome.outcome;
};
