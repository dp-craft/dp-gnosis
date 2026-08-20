/**
 * The two documentation locks over the flag vocabulary, as PURE functions so
 * each one can be proved against synthetic drift without mutating a real file.
 *
 * Gap (b), measured: README § Flags advertised `--rerank-weight` default `0.5`
 * for a day after `RERANK_RRF_WEIGHT` became `0.75`, and every gate stayed
 * green — the name lock never read the DEFAULT column's content. The binding
 * here is DECLARED per flag ({@link DEFAULT_OWNERS}) rather than sniffed out of
 * cells that look numeric, and it is asserted exhaustive over `FLAGS`, so a new
 * flag cannot land without stating which case it is.
 *
 * Gap (a): the `dp-gnosis-search` skill names flags in prose with no lock, so a
 * renamed flag leaves it instructing a caller to pass something the CLI now
 * exits 2 on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import { DEFAULT_MAX_PER_DOC } from '../src/cli/grouping.js';
import {
  DEFAULT_BUDGET_MODE,
  DEFAULT_EXCLUDED_TYPES,
  DEFAULT_RERANK_PRESET,
  RERANK_MODEL_ID,
  RERANK_RRF_WEIGHT,
  RETRIEVE_TOKEN_BUDGET
} from '../src/config.js';
import { ATOMS_DIR, GOLDEN_SET_PATH, INDEX_DIR, REPO_ROOT } from '../src/paths.js';

/** Who owns a documented default: a constant, or deliberately nothing. */
export type DefaultOwner =
  | { readonly kind: 'constant'; readonly constant: string; readonly value: string }
  | { readonly kind: 'unowned'; readonly why: string };

const owned = (constant: string, value: string | number): DefaultOwner => ({
  kind: 'constant',
  constant,
  value: String(value),
});

const unowned = (why: string): DefaultOwner => ({ kind: 'unowned', why });

const repoRelative = (absolute: string): string => relative(REPO_ROOT, absolute);

/**
 * EXHAUSTIVE over `FLAGS` — asserted, not assumed. A flag whose default no
 * constant owns is declared as such WITH its reason, so "no constant" is a
 * stated decision rather than an omission.
 */
export const DEFAULT_OWNERS: Readonly<Record<string, DefaultOwner>> = {
  '--adapter': owned('DEFAULT_ADAPTER (src/cli/adapter.ts)', DEFAULT_ADAPTER),
  '--atoms-dir': owned('ATOMS_DIR (src/paths.ts)', repoRelative(ATOMS_DIR)),
  '--index-path': owned('INDEX_DIR (src/paths.ts)', repoRelative(INDEX_DIR)),
  '--repo-root': unowned('the repo root is discovered from the CLI location, not a documented value'),
  '--profile': unowned('no default profile exists — the cell states the built-in defaults apply'),
  '--golden-set': owned('GOLDEN_SET_PATH (src/paths.ts)', repoRelative(GOLDEN_SET_PATH)),
  '-k': unowned('DEFAULT_K is a module-private literal in src/cli/retrieveCommand.ts'),
  '--format': unowned('the default output mode is a literal in the formatter, not a config constant'),
  '--type': unowned('unset by default — the vocabulary is profile-derived and printed by --help'),
  '--exclude-type': owned('DEFAULT_EXCLUDED_TYPES (src/config.ts)', DEFAULT_EXCLUDED_TYPES.join(', ')),
  '--include-history': unowned('boolean, off by default'),
  '--budget-mode': owned('DEFAULT_BUDGET_MODE (src/config.ts)', DEFAULT_BUDGET_MODE),
  '--max-tokens': owned('RETRIEVE_TOKEN_BUDGET (src/config.ts)', RETRIEVE_TOKEN_BUDGET),
  '--min-relevance': unowned('unset by default — an opt-in floor with no constant'),
  '--rerank': unowned('boolean, off by default'),
  '--rerank-model': owned('RERANK_MODEL_ID (src/config.ts)', RERANK_MODEL_ID),
  '--rerank-profile': owned('DEFAULT_RERANK_PRESET (src/config.ts)', DEFAULT_RERANK_PRESET),
  '--rerank-weight': owned('RERANK_RRF_WEIGHT (src/config.ts)', RERANK_RRF_WEIGHT),
  '--rephrase': unowned('boolean, off by default'),
  '--max-per-doc': owned('DEFAULT_MAX_PER_DOC (src/cli/grouping.ts)', DEFAULT_MAX_PER_DOC),
  '--flat': unowned('boolean, off by default — grouping is on unless it is passed'),
  '--synthesize': unowned('boolean, off by default'),
  '--json': unowned('boolean, off by default'),
  '--help': unowned('boolean, off by default'),
  '-h': unowned('boolean, off by default'),
};

/** Inline code spans of a markdown fragment. */
const codeSpans = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/`([^`]+)`/g)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]]
  );

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A default cell states a value only when a CODE SPAN carries it as a whole
 * token — so a documented `0.75` cannot satisfy a constant of `0.7`, and cell
 * prose that merely happens to contain the digits cannot pass either.
 */
const cellStates = (cell: string, value: string): boolean => {
  const bounded = new RegExp(`(^|[^0-9A-Za-z._-])${escapeRegExp(value)}([^0-9A-Za-z._-]|$)`);
  return codeSpans(cell).some(span => bounded.test(span));
};

const driftLine = (flag: string, owner: DefaultOwner, cell: string | undefined): string =>
  `${flag}: README default cell ${JSON.stringify(cell ?? '<no row>')} does not state ` +
  `${owner.kind === 'constant' ? owner.constant : ''} = ${JSON.stringify(owner.kind === 'constant' ? owner.value : '')}`;

/** Every constant-owned default whose README cell no longer states the constant. */
export const defaultCellDrift = (
  cellByFlag: ReadonlyMap<string, string>,
  owners: Readonly<Record<string, DefaultOwner>>
): readonly string[] =>
  Object.entries(owners).flatMap(([flag, owner]) =>
    owner.kind === 'constant' && !cellStates(cellByFlag.get(flag) ?? '', owner.value)
      ? [driftLine(flag, owner, cellByFlag.get(flag))]
      : []
  );

/** `.claude/skills/dp-gnosis-search/SKILL.md` — outside the package, resolved from the repo root. */
export const SKILL_PATH: string = resolve(
  REPO_ROOT,
  '.claude',
  'skills',
  'dp-gnosis-search',
  'SKILL.md'
);

/**
 * Tokens the skill names precisely BECAUSE the CLI refuses them (`--types` is
 * documented as exit 2). Each is asserted absent from `FLAGS`, so this list
 * cannot become an escape hatch for a flag that really exists.
 */
export const SKILL_REFUSED_FLAGS: readonly string[] = ['--types'];

/** A lock whose subject can vanish is not a lock: the absence names the path. */
export const readSkillOrFail = (): string => {
  if (!existsSync(SKILL_PATH))
    throw new Error(
      `the dp-gnosis-search skill is missing at ${SKILL_PATH} — this lock has no subject; ` +
        'restore the file or delete the lock deliberately'
    );
  return readFileSync(SKILL_PATH, 'utf8');
};

const FLAG_SHAPE = /^--?[a-z0-9][a-z0-9-]*$/;

/** Fenced blocks are transcripts, not claims about the vocabulary. */
const withoutFences = (markdown: string): string => markdown.replace(/```[\s\S]*?```/g, '');

/** Flag-shaped tokens inside the skill's CODE SPANS — prose dashes are ignored. */
export const skillFlagTokens = (prose: string): readonly string[] =>
  [
    ...new Set(
      codeSpans(withoutFences(prose))
        .flatMap(span => span.split(/[\s,]+/))
        .filter(token => FLAG_SHAPE.test(token))
    ),
  ].sort();

/** Flags the skill names that the CLI does not accept. One direction only. */
export const phantomSkillFlags = (
  prose: string,
  implemented: ReadonlySet<string>,
  refused: readonly string[]
): readonly string[] =>
  skillFlagTokens(prose).filter(token => !implemented.has(token) && !refused.includes(token));
