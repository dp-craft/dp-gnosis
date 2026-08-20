/**
 * The dp-gnosis consumer contract — the shape a caller of `answer --json` reads.
 *
 * This module is a LEAF by hard rule: it declares ZERO dependencies, because a
 * consumer package compiling it under its own `rootDir` (e.g.
 * `tools/task-dag/tsconfig.build.json`) fails with TS6059 the moment this file
 * pulls in a symbol from outside that root. Every type below is therefore
 * self-contained syntax — primitives, literal unions, object and array types.
 */

/** `0` all asked-for work happened, `2` bad usage, `3` a partial result. */
export type GnosisExitCode = 0 | 2 | 3;

/** What a caller asks for. Every field but `query` is optional. */
export interface GnosisRequest {
  readonly query: string;
  readonly k?: number;
  readonly adapter?: string;
  readonly types?: readonly string[];
  readonly domains?: readonly string[];
  readonly maxTokens?: number;
  readonly budgetMode?: 'bytes' | 'tokens';
  readonly rerank?: boolean;
  readonly rephrase?: boolean;
  readonly minRelevance?: number;
  readonly maxPerDoc?: number;
  readonly synthesize?: boolean;
}

/**
 * One atom the budget could not admit. It states the SIZE beside the identity:
 * a caller deciding whether to raise the budget or read the file directly is
 * making a decision about magnitude.
 */
export interface GnosisSkippedAtom {
  readonly id: string;
  readonly sourcePath: string;
  readonly estimatedTokens: number;
}

/** One delivered atom. */
export interface GnosisAtom {
  readonly id: string;
  readonly title: string;
  /** Widened to `string`: the atom-domain vocabulary is runtime-derived. */
  readonly domain: string;
  /** Widened to `string`: the atom-type vocabulary is runtime-derived. */
  readonly type: string;
  readonly body: string;
  readonly score: number;
  readonly firstPassScore?: number;
  readonly rerankScore?: number;
  readonly sourcePath: string;
  readonly originPaths: readonly string[];
  readonly originIndex?: number;
  readonly originCount?: number;
  readonly headingChain?: string;
  readonly summary?: string;
  readonly matchedTerms: readonly string[];
  /**
   * Grounding text, not answer material — every delivered atom carries a
   * snippet or a body; never a bare handle.
   */
  readonly snippet: string;
  readonly scoreNormalised: number | null;
  /** Reserved for R4.2 — not populated yet. */
  readonly originStartLine?: number;
  /** Reserved for R4.2 — not populated yet. */
  readonly originEndLine?: number;
}

/** The `--json` payload of `answer`. */
export interface GnosisAnswer {
  readonly command: string;
  readonly adapter: string;
  readonly query: string;
  /** Present ONLY when `--rephrase` rewrote the query. */
  readonly queryRewritten?: string;
  readonly k: number;
  readonly mode: string;
  readonly indexState: 'ready' | 'empty' | 'stale' | 'unavailable' | 'mismatched';
  readonly count: number;
  readonly documents: number;
  readonly poolSize: number;
  readonly budgetMode: 'bytes' | 'tokens';
  readonly maxTokens: number;
  readonly packTokens: number;
  readonly confidence: 'none' | 'weak' | 'ok';
  readonly pack: string;
  readonly citations: readonly string[];
  readonly atoms: readonly GnosisAtom[];
  readonly skipped: readonly GnosisSkippedAtom[];
  readonly neutralised: number;
  /** Present ONLY on a `--synthesize` run, together with `answer`. */
  readonly synthesized?: boolean;
  readonly answer?: string | null;
  readonly note?: string;
}
