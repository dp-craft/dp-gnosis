/**
 * What each knowledge DOMAIN contributed to an index build: the `.md` files that
 * went in, and the atoms that came out.
 *
 * The whole-index gate (`indexCommand.ts`) compares two totals, so it sees only
 * the all-or-nothing case. A PARTIAL drop — one domain whose atoms the parser
 * refuses while the rest of the corpus indexes normally — produces a perfectly
 * plausible total and is invisible, which is this project's stated recurring
 * failure class: a component produced nothing and the pipeline recorded it as
 * data. Counting per domain is what makes that zero legible.
 *
 * The domain is read from the file's `x_domain` line even when the frontmatter
 * as a whole is REFUSED — a rejected atom still has to be attributed to the
 * domain that lost it, and an atom the parser accepts is exactly the atom an
 * index build writes, so the two counts here are the two real sides.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseAtom } from '../atom.js';

const MARKDOWN_EXT = '.md';

/** The declared domain of a file whose frontmatter the parser refuses as a whole. */
const DOMAIN_LINE = /^x_domain:[ \t]*(\S+)[ \t]*$/m;

/** One domain's two sides of the build. */
export interface DomainCount {
  readonly domain: string;
  /** `.md` files under the atoms dir declaring this domain. */
  readonly files: number;
  /** Of those, the ones an index build accepts as atoms. */
  readonly indexed: number;
}

/** The per-domain split, plus the totals it has to reconcile against. */
export interface AtomsCensus {
  readonly files: number;
  readonly indexed: number;
  /** Files declaring no domain at all — attributable to no row below. */
  readonly unattributed: number;
  readonly domains: readonly DomainCount[];
}

/** What one file contributes: the domain it claims, and whether it is indexable. */
interface FileFacts {
  readonly domain: string | undefined;
  readonly indexable: boolean;
}

/**
 * Counted exactly as the whole-index gate counts, so the census total and the
 * gate's file count can never disagree: every recursive `.md` entry, including
 * one nothing can read.
 */
const markdownPaths = (atomsDir: string): readonly string[] =>
  existsSync(atomsDir)
    ? readdirSync(atomsDir, { recursive: true, encoding: 'utf8' }).filter(rel =>
        rel.endsWith(MARKDOWN_EXT)
      )
    : [];

const factsOfText = (text: string): FileFacts => {
  const parsed = parseAtom(text);
  return parsed.ok
    ? { domain: parsed.atom.frontmatter.x_domain, indexable: true }
    : { domain: DOMAIN_LINE.exec(text)?.[1], indexable: false };
};

/** An unreadable entry contributes nothing and claims no domain — never a throw. */
const factsOf = (atomsDir: string, rel: string): FileFacts => {
  try {
    return factsOfText(readFileSync(resolve(atomsDir, rel), 'utf8'));
  } catch {
    return { domain: undefined, indexable: false };
  }
};

const countOf = (facts: readonly FileFacts[], domain: string): DomainCount => ({
  domain,
  files: facts.filter(fact => fact.domain === domain).length,
  indexed: facts.filter(fact => fact.domain === domain && fact.indexable).length,
});

/**
 * Every DECLARED domain appears, even at zero: a profile domain the corpus
 * never filled is a finding in its own right, and a row that only exists when
 * it is non-empty can never report one.
 */
const domainNames = (
  facts: readonly FileFacts[],
  declared: readonly string[]
): readonly string[] =>
  [
    ...new Set([
      ...declared,
      ...facts.flatMap(fact => (fact.domain === undefined ? [] : [fact.domain])),
    ]),
  ].sort();

export const atomsCensus = (atomsDir: string, declared: readonly string[]): AtomsCensus => {
  const facts = markdownPaths(atomsDir).map(rel => factsOf(atomsDir, rel));
  return {
    files: facts.length,
    indexed: facts.filter(fact => fact.indexable).length,
    unattributed: facts.filter(fact => fact.domain === undefined).length,
    domains: domainNames(facts, declared).map(domain => countOf(facts, domain)),
  };
};

/**
 * The domains that went in and came out with NOTHING. A domain with no files is
 * absent from this list on purpose — an empty domain is an empty corpus slice,
 * while files that produced no atoms is a drop.
 */
export const droppedDomains = (census: AtomsCensus): readonly string[] =>
  census.domains.filter(row => row.files > 0 && row.indexed === 0).map(row => row.domain);
