/**
 * The interview — the questions, in the order a first run has to answer them,
 * and nothing else. It reads the filesystem only to VALIDATE an answer as it
 * arrives; it writes nothing and it runs nothing.
 *
 * The order is not cosmetic. Each step's answer narrows the next: the corpus
 * directories decide what domains exist, the language decides which analysis
 * chain is recommended AND whether a smaller rerank pool may be offered at all,
 * and the adapter decides whether extra packages are needed before anything can
 * be built. Asking them in any other order would mean asking a question whose
 * recommendation is not yet computable, and a recommendation the tool cannot
 * justify is a guess wearing a default's clothes.
 *
 * A corpus root is checked for markdown AS IT IS ENTERED rather than at first
 * ingest. `CONFIGURATION.md` § 4 makes an empty root fail loudly, which is
 * right — but failing at the end of a wizard, after every other question has
 * been answered, spends the user's whole session to report a typo.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { DECLARED_TYPES } from '../../config.js';
import { expandUserPath } from '../../env.js';
import { DEFAULT_EXCLUDED_TYPES, DEFAULT_TYPE, domainOf } from '../../instance.js';
import type { AnalyzerId } from '../../query.js';
import type { AdapterName } from '../adapter.js';
import type { Choice } from './advice.js';
import { ADAPTER_CHOICES, ANALYZER_CHOICES, describeChoice, PRF_ADVICE } from './advice.js';
import { excludePrefix, nearestGitignore, translatable } from './gitignore.js';
import type { RootAnswer } from './plan.js';
import type { Preset, PresetSelections } from './preset.js';
import { CUSTOM_PRESET, PRESETS, presetSelections, presetTable } from './preset.js';
import type { Option, Prompter } from './prompts.js';
import type { RerankPreference } from './rerankFlow.js';
import { note, section } from './screen.js';

/** The markdown suffix ingest walks for. */
const MD = '.md';

/** How deep the "does this directory hold any markdown?" check descends. */
const SCAN_DEPTH = 4;

/**
 * A bounded recursive count. It is bounded because the answer needed is "any,
 * or none" — walking a 100 000-file tree to print an exact number would make
 * the wizard feel broken at exactly the moment it is trying to feel helpful.
 */
const countMarkdown = (dir: string, depth: number = SCAN_DEPTH): number => {
  if (depth < 0 || !existsSync(dir)) return 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.filter(entry => entry.isFile() && entry.name.endsWith(MD)).length;
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .reduce((total, entry) => total + countMarkdown(join(dir, entry.name), depth - 1), here);
};

/** Why the PATH itself cannot be a corpus root, before anything is counted. */
const pathProblem = (path: string): string | undefined => {
  if (!isAbsolute(path)) return 'that path is relative — write it in full, or start it with ~/, so the scope cannot move with the shell';
  if (!existsSync(path)) return `${path} does not exist`;
  if (!statSync(path).isDirectory()) return `${path} is not a directory`;
  return undefined;
};

const emptyProblem = (path: string): string =>
  `${path} holds no markdown within ${String(SCAN_DEPTH)} levels — an ingest over it would walk nothing, and a silently empty corpus is how a vault comes to answer nothing while every check stays green`;

/** A typed root, resolved: either a reason to re-ask, or the path and what was found in it. */
type RootCheck =
  | { readonly ok: false; readonly problem: string }
  | { readonly ok: true; readonly path: string; readonly markdown: number };

const checkRoot = (typed: string): RootCheck => {
  const path = expandUserPath(typed);
  const problem = pathProblem(path);
  if (problem !== undefined) return { ok: false, problem };
  const markdown = countMarkdown(path);
  return markdown === 0 ? { ok: false, problem: emptyProblem(path) } : { ok: true, path, markdown };
};

/**
 * What the scan found, said back. The count is a FLOOR, not a total: the same
 * bound that keeps {@link countMarkdown} from walking a huge tree also stops it
 * below anything deeper than {@link SCAN_DEPTH}, so reporting it as an exact
 * figure would understate a deep corpus and be believed.
 */
const foundLine = (path: string, markdown: number): string =>
  `  found at least ${String(markdown)} markdown files in ${path} — the check stops at ${String(SCAN_DEPTH)} levels deep, so a deeper tree holds more`;

const CORPUS_EXPLANATION = [
  'A corpus directory is a folder of markdown that gnosis reads. Add as many as you like — you are asked again after each one.',
  'Symlinked directories inside a corpus root are followed, so a folder of links to projects elsewhere works.',
  'Each directory gets a DOMAIN LABEL. It rides with every atom from that directory, appears on every result, and `--domain <label>` narrows a search to that project alone. The default is the directory\'s own name.',
];

const TYPES_EXPLANATION = [
  'Every atom carries a TYPE. Rules in the profile can assign one from the document\'s path; the default below is what a document gets when no rule claims it.',
  'Hiding a type is a DISPLAY default only — those documents are still ingested and still indexed, and `--include-history` brings them back into results.',
];

const MATCHING_EXPLANATION = [
  'These four answers decide how your words are matched against your documents. They are stamped into the index, so changing one later means rebuilding it.',
];

const PRESET_EXPLANATION = [
  'A preset answers the rest of the interview for you. It only PRE-SELECTS a row each menu already offers — every question is still asked, every row is still choosable, and nothing gnosis ships with is changed by picking one.',
];

const ADD_MORE = 'Add another corpus directory?';

/** One root, re-asked until it is usable. */
const askRoot = async (prompter: Prompter, ordinal: number): Promise<string> => {
  const typed = await prompter.input(
    ordinal === 0 ? 'Corpus directory (absolute, or ~/…)' : 'Next corpus directory'
  );
  const checked = checkRoot(typed);
  if (!checked.ok) {
    prompter.say([`  ${checked.problem}`]);
    return await askRoot(prompter, ordinal);
  }
  prompter.say([foundLine(checked.path, checked.markdown)]);
  return checked.path;
};

/** Its domain — the label every atom from it carries into every result. */
const askDomain = async (prompter: Prompter, root: string): Promise<RootAnswer> => ({
  path: root,
  domain: await prompter.input(`Domain label for ${root}`, domainOf(root)),
});

/** Every corpus directory and its domain label — the whole of section 1's answer. */
export const askRoots = async (
  prompter: Prompter,
  collected: readonly RootAnswer[] = []
): Promise<readonly RootAnswer[]> => {
  const root = await askRoot(prompter, collected.length);
  const answered = [...collected, await askDomain(prompter, root)];
  return (await prompter.confirm(ADD_MORE, false)) ? await askRoots(prompter, answered) : answered;
};

/** A menu row: the title, with `describeChoice` underneath the highlighted one. */
const optionOf = <T extends string>(choice: Choice<T>): Option<T> => ({
  value: choice.value,
  name: choice.title,
  description: describeChoice(choice),
});

const recommended = <T extends string>(choices: readonly Choice<T>[]): T | undefined =>
  choices.find(choice => choice.recommended === true)?.value;

/** One menu over an advice table, pre-selected on the recommended row. */
const pick = async <T extends string>(
  prompter: Prompter,
  message: string,
  choices: readonly Choice<T>[]
): Promise<T> => await prompter.select(message, choices.map(optionOf), recommended(choices));

const LANGUAGE_NOTE = [
  '',
  'The analysis chain is a property of your DOCUMENTS, not of the tool, and it is',
  'stamped into the index — changing it later takes a rebuild. A second LANGUAGE',
  'needs its own profile and its own index; a second PROJECT does not.',
];

/** Language and identifiers, which together choose the chain. */
export interface LanguageAnswer {
  readonly hungarian: boolean;
  readonly analyzer: AnalyzerId;
}

const askHungarian = async (prompter: Prompter): Promise<boolean> =>
  await prompter.select<boolean>(
    'What language are the documents mostly in?',
    [
      { value: false, name: 'English (or another Latin-script language)' },
      { value: true, name: 'Hungarian' },
    ],
    false
  );

const askIdentifiers = async (prompter: Prompter): Promise<boolean> =>
  await prompter.confirm(
    'Do they contain code identifiers — function names, flags, snake_case or dotted paths?',
    false
  );

/** One preset row: its title, with its summary under the highlighted one. */
const presetOption = (preset: Preset): Option<Preset> => ({
  value: preset,
  name: preset.title,
  description: `  ${preset.summary}`,
});

/**
 * The preset question, asked ONCE and after the two answers that feed it — the
 * language and the identifiers decide the chain, so a preset asked before them
 * could not pre-select one.
 *
 * Its answer is a set of `initial` values and nothing else. `custom` is on the
 * menu because a preset that could not be declined would be a default wearing a
 * question's clothes.
 */
const askPreset = async (
  prompter: Prompter,
  hungarian: boolean,
  identifiers: boolean
): Promise<PresetSelections> => {
  prompter.say([...presetTable(), ...note(PRESET_EXPLANATION)]);
  const chosen = await prompter.select<Preset>(
    'Which of these fits you?',
    [...PRESETS, CUSTOM_PRESET].map(presetOption),
    PRESETS.find(preset => preset.recommended === true)
  );
  return presetSelections(chosen, hungarian, identifiers);
};

/** Everything section 4 settles: the two language answers, the preset, the chain. */
export interface MatchingAnswers {
  readonly language: LanguageAnswer;
  readonly preset: PresetSelections;
}

export const askMatching = async (prompter: Prompter): Promise<MatchingAnswers> => {
  prompter.say([...section('How text is matched'), ...note(MATCHING_EXPLANATION)]);
  prompter.say(LANGUAGE_NOTE);
  const hungarian = await askHungarian(prompter);
  const preset = await askPreset(prompter, hungarian, await askIdentifiers(prompter));
  prompter.say([`  → recommended chain: ${preset.analyzer}`]);
  const analyzer = await pick(prompter, 'Analysis chain', ordered(ANALYZER_CHOICES, preset.analyzer));
  return { language: { hungarian, analyzer }, preset };
};

/**
 * The recommendation is moved to the top AND marked, rather than only marked:
 * a menu whose pre-selected row is the fifth one reads as a list the tool has
 * no opinion about.
 */
const ordered = <T extends string>(choices: readonly Choice<T>[], first: T): readonly Choice<T>[] => {
  const chosen = choices.find(choice => choice.value === first);
  if (chosen === undefined) return choices;
  return [
    { ...chosen, recommended: true as const },
    ...choices.filter(choice => choice.value !== first).map(choice => omitRecommended(choice)),
  ];
};

const omitRecommended = <T extends string>(choice: Choice<T>): Choice<T> => {
  const { recommended: _dropped, ...rest } = choice;
  return rest;
};

const typeOption = (type: string): Option<string> => ({ value: type, name: type });

const EXCLUDED_NOTE = [
  '',
  'Excluded types are a PRESENTATION default: they stay ingested and indexed, and',
  '--include-history brings them back. Uncheck a type to have it shown by default.',
];

export const askTypes = async (prompter: Prompter): Promise<{
  readonly defaultType: string;
  readonly excludedTypes: readonly string[];
}> => {
  prompter.say([...section('How documents are labelled'), ...note(TYPES_EXPLANATION)]);
  const defaultType = await prompter.select(
    'Default atom type — what a document gets when no rule claims it',
    DECLARED_TYPES.map(typeOption),
    DEFAULT_TYPE
  );
  prompter.say(EXCLUDED_NOTE);
  const excludedTypes = await prompter.multiSelect(
    'Types to hide from search results by default',
    DECLARED_TYPES.map(typeOption),
    DEFAULT_EXCLUDED_TYPES
  );
  return { defaultType, excludedTypes };
};

/** Everything the interview settles before the reranker question. */
export interface CorpusAnswers {
  readonly roots: readonly RootAnswer[];
  readonly excludePaths: readonly string[];
  readonly defaultType: string;
  readonly excludedTypes: readonly string[];
  readonly language: LanguageAnswer;
  readonly adapter: AdapterName;
  readonly prf: boolean;
  /** The reranker half's pre-selections, threaded on by the caller. */
  readonly preset: PresetSelections;
}

/** One `.gitignore` that covers at least one corpus root, already split. */
interface GitignoreOffer {
  readonly path: string;
  readonly directory: string;
  readonly usable: readonly string[];
  readonly droppedCount: number;
}

const offerFor = (root: string): GitignoreOffer | undefined => {
  const path = nearestGitignore(root);
  if (path === undefined) return undefined;
  const split = translatable(readFileSync(path, 'utf8'));
  return { path, directory: dirname(path), usable: split.usable, droppedCount: split.dropped.length };
};

/**
 * One offer per `.gitignore` FILE, not per root: two roots inside the same
 * repository resolve to the same file, and asking twice about the same lines
 * would read as two different questions.
 */
const gitignoreOffers = (roots: readonly RootAnswer[]): readonly GitignoreOffer[] => {
  const found = roots
    .map(root => offerFor(root.path))
    .filter((offer): offer is GitignoreOffer => offer !== undefined);
  return found.filter((offer, index) => found.findIndex(seen => seen.path === offer.path) === index);
};

const offerNote = (offer: GitignoreOffer): readonly string[] => [
  '',
  `  found ${offer.path}`,
  `  ${String(offer.usable.length)} of its lines are plain paths and can be skipped; ${String(offer.droppedCount)} cannot be used —`,
  '  a blank, a comment, a wildcard or a negation is not expressible as a path prefix, which is all an exclusion is.',
];

const entryOption = (entry: string): Option<string> => ({ value: entry, name: entry });

/** The entries of ONE `.gitignore`, offered pre-checked; unchecking is how one is declined. */
const askOffer = async (
  prompter: Prompter,
  repoRoot: string,
  offer: GitignoreOffer
): Promise<readonly string[]> => {
  prompter.say(offerNote(offer));
  if (offer.usable.length === 0) return [];
  const chosen = await prompter.multiSelect(
    `Skip these paths, from ${offer.path}?`,
    offer.usable.map(entryOption),
    offer.usable
  );
  return chosen.map(entry => excludePrefix(repoRoot, offer.directory, entry));
};

const askOffers = async (
  prompter: Prompter,
  repoRoot: string,
  pending: readonly GitignoreOffer[],
  collected: readonly string[] = []
): Promise<readonly string[]> => {
  const [head, ...rest] = pending;
  if (head === undefined) return collected;
  const chosen = await askOffer(prompter, repoRoot, head);
  return await askOffers(prompter, repoRoot, rest, [...collected, ...chosen]);
};

const typedExclusions = (typed: string): readonly string[] =>
  typed
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

export const askExclusions = async (
  prompter: Prompter,
  repoRoot: string,
  roots: readonly RootAnswer[]
): Promise<readonly string[]> => {
  const fromGitignore = await askOffers(prompter, repoRoot, gitignoreOffers(roots));
  const typed = await prompter.input(
    'Paths to skip inside those directories, comma separated (blank for none)',
    ''
  );
  return [...fromGitignore, ...typedExclusions(typed)].filter(
    (entry, index, all) => all.indexOf(entry) === index
  );
};

const askPrf = async (prompter: Prompter, initial: boolean): Promise<boolean> => {
  prompter.say(['', `  + ${PRF_ADVICE.pro}`, `  − ${PRF_ADVICE.con}`]);
  return await prompter.confirm('Serve pseudo-relevance feedback by default?', initial);
};

/** The whole corpus half of the interview, in the one order it can be asked in. */
export const askCorpus = async (prompter: Prompter, repoRoot: string): Promise<CorpusAnswers> => {
  prompter.say([...section('What to index'), ...note(CORPUS_EXPLANATION)]);
  const roots = await askRoots(prompter);
  const excludePaths = await askExclusions(prompter, repoRoot, roots);
  const types = await askTypes(prompter);
  const matching = await askMatching(prompter);
  const adapter = await pick(prompter, 'Ranking adapter', ordered(ADAPTER_CHOICES, matching.preset.adapter));
  return {
    roots,
    excludePaths,
    ...types,
    language: matching.language,
    preset: matching.preset,
    adapter,
    prf: await askPrf(prompter, matching.preset.prf),
  };
};

/**
 * What the preset chose, handed to the reranker half. It is derived HERE, from
 * the answers this module owns, rather than restated by each caller: the
 * language answer and the preset both live on {@link CorpusAnswers}, and a
 * second derivation could disagree with the first once an amend has re-asked
 * either of them.
 */
export const rerankPreference = (corpus: CorpusAnswers): RerankPreference => ({
  hungarian: corpus.language.hungarian,
  rerank: corpus.preset.rerank,
  poolK: corpus.preset.poolK,
});
