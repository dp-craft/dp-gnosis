/**
 * The amend point — the ONE place an already-given answer can be changed.
 *
 * The wizard writes nothing until the summary is confirmed, so the summary is
 * the last moment at which a wrong answer costs nothing to correct. That, and
 * not a back button, is what this module is: it re-asks ONE question, hands the
 * new answer back, and the caller rebuilds the plan and renders the summary
 * again. Recursion, no loop, no second state model over the interview.
 *
 * Every row here re-runs the interview's OWN function — `askRoots`,
 * `askExclusions`, `askTypes`, `askMatching`, `askPool`. A row that re-asked a
 * question in its own words would be a second owner of that question's wording,
 * its default and its validation, and the two would drift.
 *
 * Two answers are deliberately NOT on the menu, and the menu says why rather
 * than leaving them silently absent:
 *
 * **The data root.** Its value gates the two `instanceRefusal` checks — an
 * existing profile, and an atoms directory already holding atoms — and those
 * ran before the first question. Re-asking it here would carry the whole
 * interview onto a root nothing has checked.
 *
 * **The reranker setup.** It downloads a model file and starts a server, and
 * both outlive an abort; re-entering that rung to change a menu answer would
 * fetch or spawn again. Its POOL DEPTH asks nothing of the network, so that one
 * answer IS amendable and is offered whenever a reranker was configured.
 */
import type { CorpusAnswers } from './flow.js';
import { askExclusions, askMatching, askRoots, askTypes, rerankPreference } from './flow.js';
import type { RerankAnswer } from './plan.js';
import type { Option, Prompter } from './prompts.js';
import type { RerankResult } from './rerankFlow.js';
import { askPool } from './rerankFlow.js';

/** Every answer the summary is built from, as it stands between amendments. */
export interface Draft {
  readonly corpus: CorpusAnswers;
  readonly rerank: RerankResult;
}

/** One amendable answer: how it reads on the menu, and what re-asking it does. */
interface Amendment {
  readonly label: string;
  readonly reask: (prompter: Prompter, repoRoot: string, draft: Draft) => Promise<Draft>;
}

const amendRoots = async (prompter: Prompter, _repoRoot: string, draft: Draft): Promise<Draft> => ({
  ...draft,
  corpus: { ...draft.corpus, roots: await askRoots(prompter) },
});

/**
 * The exclusions are re-asked against the roots CURRENTLY in the draft, so an
 * amended corpus offers the `.gitignore` files those directories reach. The
 * reverse is deliberately not done: amending the roots does NOT re-ask the
 * exclusions, because a re-ask nobody asked for is another screen to press
 * Enter through — and this menu is here for exactly that.
 */
const amendExclusions = async (prompter: Prompter, repoRoot: string, draft: Draft): Promise<Draft> => ({
  ...draft,
  corpus: { ...draft.corpus, excludePaths: await askExclusions(prompter, repoRoot, draft.corpus.roots) },
});

const amendTypes = async (prompter: Prompter, _repoRoot: string, draft: Draft): Promise<Draft> => ({
  ...draft,
  corpus: { ...draft.corpus, ...(await askTypes(prompter)) },
});

const amendMatching = async (prompter: Prompter, _repoRoot: string, draft: Draft): Promise<Draft> => {
  const matching = await askMatching(prompter);
  return {
    ...draft,
    corpus: { ...draft.corpus, language: matching.language, preset: matching.preset },
  };
};

/**
 * Built AROUND the answer that already exists, rather than guarding for one:
 * the row is only offered when a reranker was configured, so closing over that
 * answer is what makes the "no reranker" case unrepresentable instead of a
 * branch that can never run.
 */
const poolAmendment = (configured: RerankAnswer): Amendment => ({
  label: 'Reranker candidate pool',
  reask: async (prompter, _repoRoot, draft) => ({
    ...draft,
    rerank: {
      ...draft.rerank,
      rerank: { ...configured, poolK: await askPool(prompter, rerankPreference(draft.corpus)) },
    },
  }),
});

const AMENDMENTS: readonly Amendment[] = [
  { label: 'Corpus directories and their labels', reask: amendRoots },
  { label: 'Paths to skip', reask: amendExclusions },
  { label: 'Atom types', reask: amendTypes },
  { label: 'How text is matched', reask: amendMatching },
];

const amendmentsFor = (draft: Draft): readonly Amendment[] => {
  const configured = draft.rerank.rerank;
  return configured === undefined ? AMENDMENTS : [...AMENDMENTS, poolAmendment(configured)];
};

/** One clause each for the two answers this menu cannot offer, and why. */
const NOT_AMENDABLE: readonly string[] = [
  '',
  '  The data root is not on this list because its value gates the two checks for an existing instance, and those already ran.',
  '  The reranker setup is not on this list because it downloads files and starts servers; only its candidate pool depth is re-askable.',
];

const AMEND_QUESTION = 'Which answer should be changed?';

const amendmentOption = (amendment: Amendment): Option<Amendment> => ({
  value: amendment,
  name: amendment.label,
});

/** Pick one answer, re-ask exactly it, and hand the whole draft back amended. */
export const amend = async (prompter: Prompter, repoRoot: string, draft: Draft): Promise<Draft> => {
  prompter.say(NOT_AMENDABLE);
  const chosen = await prompter.select<Amendment>(
    AMEND_QUESTION,
    amendmentsFor(draft).map(amendmentOption)
  );
  return await chosen.reask(prompter, repoRoot, draft);
};
