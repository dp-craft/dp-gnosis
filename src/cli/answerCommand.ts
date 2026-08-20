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
import type { GnosisAnswer } from '../api.js';
import type { RetrievedAtom } from '../port.js';
import { fabricatedCitations, synthesizeAnswer } from '../synthesize.js';
import { stringFlag } from './args.js';
import type { CommandContext } from './context.js';
import type { ChargedText } from './counting.js';
import { explainAtoms } from './explain.js';
import { FORMAT_FLAG } from './format.js';
import { groupByDocument } from './grouping.js';
import type { CommandOutcome } from './outcome.js';
import { EXIT_PARTIAL, usageError } from './outcome.js';
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

/**
 * Every note the pack and the payload report, from the run's own notes plus
 * whatever the synthesis added. One helper, because a refusal the pack prints
 * and the `note` key omits — or the reverse — would make the two renderings
 * disagree about the same run.
 */
const notesOf = (
  request: RetrieveRequest,
  budgeted: BudgetedResult,
  extra: readonly string[]
): readonly string[] => [...noteLines(request, budgeted), ...extra];

const packOf = (run: RetrievalRun, extra: readonly string[]): Pack =>
  renderPack({
    query: run.request.query,
    atoms: run.budgeted.result.atoms,
    confidence: run.confidence,
    tokens: run.budgeted.usedTokens,
    maxTokens: run.budgeted.maxTokens,
    budgetMode: run.request.budgetMode,
    skipped: run.budgeted.skipped,
    notes: notesOf(run.request, run.budgeted, extra),
  });

/** Omitted entirely when no rewrite happened, mirroring `retrieve`'s payload. */
const rewrittenField = (request: RetrieveRequest): Pick<GnosisAnswer, 'queryRewritten'> =>
  request.queryRewritten === undefined ? {} : { queryRewritten: request.queryRewritten };

/**
 * `answer` only, OPT-IN: synthesise an answer over the pack with a local chat
 * model. Refused on every other command through the unknown-flag path — a
 * `retrieve` has no pack to synthesise over, and a flag that did nothing under
 * a success code is the failure that path exists to prevent.
 */
export const SYNTHESIZE_FLAG = '--synthesize';

/**
 * What the synthesis contributed. `answer` is `null` whenever nothing may be
 * rendered — the flag was absent, or the model was refused — and `refusal`
 * carries the message the run reports for it.
 */
interface Synthesis {
  /** Whether `--synthesize` was passed at all — what gates the reported keys. */
  readonly requested: boolean;
  readonly answer: string | null;
  readonly refusal: string | undefined;
}

/** The flag was not passed: nothing synthesised, nothing refused, nothing reported. */
const NO_SYNTHESIS: Synthesis = { requested: false, answer: null, refusal: undefined };

/** A refusal is a note the pack prints and the payload's `note` key carries. */
const extraNotes = (synthesis: Synthesis): readonly string[] =>
  synthesis.refusal === undefined ? [] : [synthesis.refusal];

/**
 * Reported only when the flag was PASSED, mirroring `queryRewritten`: a payload
 * for a run that never asked for a synthesis stays byte-identical, so the
 * documented key set of a plain `answer` is unchanged.
 */
const synthesisFields = (synthesis: Synthesis): Pick<GnosisAnswer, 'synthesized' | 'answer'> =>
  synthesis.requested
    ? { synthesized: synthesis.answer !== null, answer: synthesis.answer }
    : {};

/**
 * The hard fail. An answer citing an id the pack does not contain is DISCARDED
 * whole — not printed, not put in the payload — because a fabricated `[^id]`
 * reads exactly like a sourced claim and the reader has no way to tell them
 * apart. The pack is still real output and the synthesis was refused, which is
 * precisely what {@link EXIT_PARTIAL} means; rendering it under exit 0 is the
 * failure this check exists to prevent.
 */
const fabricatedRefusal = (ids: readonly string[]): string =>
  `${SYNTHESIZE_FLAG}: the synthesised answer was DISCARDED — it cited ${ids.length} footnote id(s) that this knowledge pack does not contain (${ids.join(', ')}); every [^atom-id] MUST be copied verbatim from the pack, so the answer is not shown and only the pack below is; re-run to synthesise again, or drop ${SYNTHESIZE_FLAG} to take the pack alone`;

/**
 * `INSUFFICIENT` needs no citation and passes here untouched: an answer citing
 * nothing fabricates nothing, and refusing to answer from a pack that does not
 * hold the answer is the correct outcome, not a fault.
 */
const validated = (answer: string, citations: readonly string[]): Synthesis => {
  const fabricated = fabricatedCitations(answer, citations);
  return fabricated.length === 0
    ? { requested: true, answer, refusal: undefined }
    : { requested: true, answer: null, refusal: fabricatedRefusal(fabricated) };
};

/** The question as TYPED — a rewrite is a search string, never what was asked. */
const synthesisFor = async (run: RetrievalRun, pack: Pack): Promise<Synthesis> => {
  const outcome = await synthesizeAnswer(run.request.query, pack.text);
  return outcome.ok
    ? validated(outcome.answer, pack.citations)
    : { requested: true, answer: null, refusal: outcome.error };
};

const noteField = (
  run: RetrievalRun,
  extra: readonly string[]
): Pick<GnosisAnswer, 'note'> => {
  const lines = notesOf(run.request, run.budgeted, extra);
  return lines.length > 0 ? { note: lines.join('\n') } : {};
};

/** The run's own facts, stated once and shared by both halves of the payload. */
const runFields = (
  run: RetrievalRun
): Pick<
  GnosisAnswer,
  | 'command'
  | 'adapter'
  | 'query'
  | 'queryRewritten'
  | 'k'
  | 'mode'
  | 'indexState'
  | 'count'
  | 'documents'
  | 'poolSize'
> => ({
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
const payload = (
  run: RetrievalRun,
  pack: Pack,
  synthesis: Synthesis
): GnosisAnswer => ({
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
  ...synthesisFields(synthesis),
  ...noteField(run, extraNotes(synthesis)),
});

/**
 * The pack is the text rendering: there is no second human form. `xml` is
 * absent, and the command refuses `--format xml` rather than falling back.
 *
 * A synthesised answer renders ABOVE the pack, separated by a blank line: the
 * answer is what was asked for and the pack below it is the evidence for it,
 * in the order a reader checks them. The pack's own bytes are untouched.
 */
const rendered = (run: RetrievalRun, synthesis: Synthesis): CommandOutcome => {
  const pack = packOf(run, extraNotes(synthesis));
  return {
    exitCode: synthesis.refusal === undefined ? run.exitCode : EXIT_PARTIAL,
    data: payload(run, pack, synthesis),
    text: synthesis.answer === null ? pack.text : `${synthesis.answer}\n\n${pack.text}`,
  };
};

/**
 * The synthesis step, or the absence of one. `requested` is carried separately
 * from the result because a run WITHOUT the flag must stay byte-identical: it
 * reports no `synthesized` / `answer` keys at all, exactly as an unrephrased
 * run reports no `queryRewritten`.
 */
const answered = async (run: RetrievalRun, requested: boolean): Promise<CommandOutcome> => {
  if (!requested) return rendered(run, NO_SYNTHESIS);
  return rendered(run, await synthesisFor(run, packOf(run, [])));
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
  if (!outcome.ok) return outcome.outcome;
  return await answered(outcome.run, context.flags[SYNTHESIZE_FLAG] === true);
};
