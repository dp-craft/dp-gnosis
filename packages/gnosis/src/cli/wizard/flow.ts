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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { DECLARED_TYPES } from '../../config.js';
import { expandUserPath } from '../../env.js';
import { DEFAULT_EXCLUDED_TYPES, DEFAULT_TYPE, domainOf } from '../../instance.js';
import type { AnalyzerId } from '../../query.js';
import type { AdapterName } from '../adapter.js';
import type { Choice } from './advice.js';
import { ADAPTER_CHOICES, ANALYZER_CHOICES, analyzerFor, PRF_ADVICE } from './advice.js';
import type { RootAnswer } from './plan.js';
import type { Option, Prompter } from './prompts.js';

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

/** Why a directory the user typed cannot be a corpus root, or nothing. */
const rootProblem = (typed: string): string | undefined => {
  const path = expandUserPath(typed);
  if (!isAbsolute(path)) return 'that path is relative — write it in full, or start it with ~/, so the scope cannot move with the shell';
  if (!existsSync(path)) return `${path} does not exist`;
  if (!statSync(path).isDirectory()) return `${path} is not a directory`;
  return countMarkdown(path) === 0
    ? `${path} holds no markdown within ${String(SCAN_DEPTH)} levels — an ingest over it would walk nothing, and a silently empty corpus is how a vault comes to answer nothing while every check stays green`
    : undefined;
};

const ADD_MORE = 'Add another corpus directory?';

/** One root, re-asked until it is usable. */
const askRoot = async (prompter: Prompter, ordinal: number): Promise<string> => {
  const typed = await prompter.input(
    ordinal === 0 ? 'Corpus directory (absolute, or ~/…)' : 'Next corpus directory'
  );
  const problem = rootProblem(typed);
  if (problem === undefined) return expandUserPath(typed);
  prompter.say([`  ${problem}`]);
  return await askRoot(prompter, ordinal);
};

/** Its domain — the label every atom from it carries into every result. */
const askDomain = async (prompter: Prompter, root: string): Promise<RootAnswer> => ({
  path: root,
  domain: await prompter.input(`Domain label for ${root}`, domainOf(root)),
});

const askRoots = async (
  prompter: Prompter,
  collected: readonly RootAnswer[] = []
): Promise<readonly RootAnswer[]> => {
  const root = await askRoot(prompter, collected.length);
  const answered = [...collected, await askDomain(prompter, root)];
  return (await prompter.confirm(ADD_MORE, false)) ? await askRoots(prompter, answered) : answered;
};

/** A menu row: the title, with the pro and con underneath the highlighted one. */
const optionOf = <T extends string>(choice: Choice<T>): Option<T> => ({
  value: choice.value,
  name: choice.title,
  description: `  + ${choice.pro}\n  − ${choice.con}`,
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

const askLanguage = async (prompter: Prompter): Promise<LanguageAnswer> => {
  prompter.say(LANGUAGE_NOTE);
  const hungarian = await prompter.select<boolean>(
    'What language are the documents mostly in?',
    [
      { value: false, name: 'English (or another Latin-script language)' },
      { value: true, name: 'Hungarian' },
    ],
    false
  );
  const identifiers = await prompter.confirm(
    'Do they contain code identifiers — function names, flags, snake_case or dotted paths?',
    false
  );
  const suggested = analyzerFor(hungarian, identifiers);
  prompter.say([`  → recommended chain: ${suggested}`]);
  return { hungarian, analyzer: await pick(prompter, 'Analysis chain', ordered(ANALYZER_CHOICES, suggested)) };
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

const askTypes = async (prompter: Prompter): Promise<{
  readonly defaultType: string;
  readonly excludedTypes: readonly string[];
}> => {
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
}

const askExclusions = async (prompter: Prompter): Promise<readonly string[]> => {
  const typed = await prompter.input(
    'Paths to skip inside those directories, comma separated (blank for none)',
    ''
  );
  return typed
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
};

const askPrf = async (prompter: Prompter): Promise<boolean> => {
  prompter.say(['', `  + ${PRF_ADVICE.pro}`, `  − ${PRF_ADVICE.con}`]);
  return await prompter.confirm('Serve pseudo-relevance feedback by default?', true);
};

/** The whole corpus half of the interview, in the one order it can be asked in. */
export const askCorpus = async (prompter: Prompter): Promise<CorpusAnswers> => {
  const roots = await askRoots(prompter);
  const excludePaths = await askExclusions(prompter);
  const types = await askTypes(prompter);
  const language = await askLanguage(prompter);
  const adapter = await pick(prompter, 'Ranking adapter', ADAPTER_CHOICES);
  return {
    roots,
    excludePaths,
    ...types,
    language,
    adapter,
    prf: await askPrf(prompter),
  };
};
