/**
 * What the wizard SAYS about each choice — the pro, the con, and which option
 * is recommended.
 *
 * Every claim here is QUALITATIVE and every one routes to where its number
 * lives. That is a deliberate constraint, not laziness: `GNOSIS-RULES.md`
 * § Volatile facts records that a copied figure rots silently, and that this
 * repository's own governance files carried three stale ones at the same time.
 * A quality figure is a fact only WITH its corpus, serving config and sha, and
 * a wizard cannot carry those without becoming a second baseline file that
 * nobody updates.
 *
 * So the wizard says "the measured champion" and names
 * `handbook/GNOSIS-BASELINES.md`. It MUST NOT print an nDCG value.
 *
 * The recommendation rules are the shipped defaults, stated once. A wizard that
 * recommended anything else would be moving a measured constant through a menu.
 */
import type { AnalyzerId } from '../../query.js';
import type { AdapterName } from '../adapter.js';

/** One menu entry: what it is, what it costs, and whether it is the default. */
export interface Choice<T extends string> {
  readonly value: T;
  readonly title: string;
  readonly pro: string;
  readonly con: string;
  /** One clause naming WHO should pick this — printed above the pro and the con. */
  readonly when?: string;
  /** Set on the one option the wizard pre-selects. */
  readonly recommended?: true;
}

/**
 * One rendered menu row: WHO should pick it, then the pro and the con. The
 * `when` clause leads because it is the only line that answers the question the
 * reader actually has — a pro and a con describe an option, they do not say
 * whether it is theirs. Both menu builders (`flow.ts`, `rerankFlow.ts`) render
 * through this, so a row cannot acquire a second layout.
 */
export const describeChoice = <T extends string>(choice: Choice<T>): string =>
  [...(choice.when === undefined ? [] : [`  ${choice.when}`]), `  + ${choice.pro}`, `  − ${choice.con}`].join('\n');

/**
 * Ordered as a menu, not as `ADAPTER_NAMES`: the production route first, the
 * other lexical ones next, the research routes last and marked as such. They
 * are experiments a reader can re-run, NOT an upgrade that was left switched
 * off — `OPTIONAL.md` § What they measured is explicit that the measurement did
 * not favour them.
 */
export const ADAPTER_CHOICES: readonly Choice<AdapterName>[] = [
  {
    value: 'fts5',
    title: 'fts5 — SQLite full-text (production)',
    when: 'Pick this unless you have a reason not to: it is the default, and the one every published measurement of gnosis was made on.',
    pro: 'the fastest of the routes here, with nothing extra to install and nothing to keep running beside it',
    con: 'the two settings that control how it weighs a repeated word against a long document are built into SQLite, so they cannot be changed',
    recommended: true,
  },
  {
    value: 'minisearch',
    title: 'minisearch — a pure-JS lexical index',
    when: 'Pick this if the SQLite package will not build on your machine.',
    pro: 'plain JavaScript, so there is nothing to compile',
    con: 'it splits words and weighs fields in its own way, so its results are not the ones the published measurements describe',
  },
  {
    value: 'linear',
    title: 'linear — the reference BM25 implementation',
    when: 'Pick this if you are comparing how the routes rank, not searching day to day.',
    pro: 'a plain, exact implementation whose word-weighting settings you can change, and the yardstick the others are read against',
    con: 'slow by design — it re-reads every document on every search, and it saves no index to search again later',
  },
  {
    value: 'lancedb',
    title: 'lancedb — LanceDB full-text, deliberately frozen',
    when: 'Pick this only to reproduce the LanceDB comparison it was built for.',
    pro: 'left unchanged on purpose, so a result measured on it stays reproducible',
    con: 'word matching only, and frozen — nothing about it will be improved',
  },
  {
    value: 'lancedb-vec',
    title: 'lancedb-vec — dense only (research)',
    when: 'Pick this only if you are running an experiment; it is not a route to search with.',
    pro: 'it matches on meaning rather than on the words themselves, and on some collections that wins',
    con: 'an experiment, not a shipped route: it needs a separate embedding server and a large model file, and on the English collection it was measured on it ranked worse than the default',
  },
  {
    value: 'lancedb-hybrid',
    title: 'lancedb-hybrid — dense fused with lexical (research)',
    when: 'Pick this only if you are running an experiment; it is not a route to search with.',
    pro: 'the best measured of the three meaning-based routes — it combines meaning matching with word matching',
    con: 'still not shipped: everything measured in its favour comes from the first pass, and none of it has been shown to survive reranking; it also needs an embedding server, extra storage and a step that merges the two rankings',
  },
  {
    value: 'lancedb-hybrid-full',
    title: 'lancedb-hybrid-full — the same fusion, untruncated pool (research)',
    when: 'Pick this only to reproduce the larger-pool experiment it records.',
    pro: 'the first pass does find more of the right documents, exactly as predicted',
    con: 'none of those extra finds reached the top of the results, and reranking the larger pool costs substantially more time; it is recorded evidence, not a route to use',
  },
];

/**
 * The analysis chain, which is a property of the DOCUMENTS and not of the tool.
 *
 * `CONFIGURATION.md` § 6 owns the two consequences the wizard must state: it
 * takes effect only on a REBUILD, and a profile declaring a chain its index was
 * not built with is REFUSED rather than served silently.
 */
export const ANALYZER_CHOICES: readonly Choice<AnalyzerId>[] = [
  {
    value: 'porter-fold',
    title: 'porter-fold — English (default)',
    when: 'Pick this if your documents are mostly English, or another Latin-script language.',
    pro: 'the default, and what every English measurement used: it trims English word endings, so a search for one form of a word also finds its other forms, and it ignores accents on both sides',
    con: 'the endings it knows how to trim are English ones — a Hungarian collection is matched far worse by it',
    recommended: true,
  },
  {
    value: 'ident-porter-fold',
    title: 'ident-porter-fold — English, identifier-aware',
    when: 'Pick this if your documents are mostly English AND full of code — function names, flags, snake_case or dotted paths.',
    pro: 'it does what the English default does, and also splits a code identifier into its parts, so searching for one part reaches the document',
    con: 'splitting identifiers is all it adds; on ordinary prose it buys nothing over the English default',
  },
  {
    value: 'hulight-fold',
    title: 'hulight-fold — Hungarian',
    when: 'Pick this if your documents are mostly Hungarian prose.',
    pro: 'it trims Hungarian word endings, and it was measured better than the English default on Hungarian documents, technical and prose alike',
    con: 'on English documents it scored worse than the English default when measured, so it must not be used for an English collection',
  },
  {
    value: 'ident-hulight-fold',
    title: 'ident-hulight-fold — Hungarian, identifier-aware',
    when: 'Pick this if your documents are mostly Hungarian AND contain code identifiers.',
    pro: 'the best measured option on Hungarian documents that do contain code identifiers',
    con: 'on Hungarian prose without identifiers, plain hulight-fold measured better — the language alone must not decide this',
  },
  {
    value: 'nostem-fold',
    title: 'nostem-fold — folding only, no stemming',
    when: 'Pick this only if you want words matched as written, accents aside.',
    pro: 'nothing is trimmed off a word: a search matches what you typed, with accents ignored on both sides',
    con: 'a search for one form of a word will not find its other forms; kept for comparison, not for daily searching',
  },
  {
    value: 'porter-nofold',
    title: 'porter-nofold — stemming without folding',
    when: 'Pick this only to see what ignoring accents is worth on its own.',
    pro: 'English word endings are trimmed, and accented letters are kept exactly as written',
    con: 'a search typed without accents then fails to find the accented word',
  },
  {
    value: 'nostem-nofold',
    title: 'nostem-nofold — raw tokens',
    when: 'Pick this only as a do-nothing comparison against the others.',
    pro: 'words are split apart and lowercased, and nothing else is done to them',
    con: 'neither word endings nor accents are handled; it ranked worst on every collection it was measured on',
  },
];

/** The chain a language answer plus an identifier answer argues for. */
export const analyzerFor = (hungarian: boolean, identifiers: boolean): AnalyzerId => {
  if (hungarian) return identifiers ? 'ident-hulight-fold' : 'hulight-fold';
  return identifiers ? 'ident-porter-fold' : 'porter-fold';
};

/** The shipped pool depth, and the one alternative the measurement supports. */
const POOL_SHIPPED = 100;
const POOL_FAST = 60;

/**
 * Whether cutting the pool is offerable at all. `CONFIGURATION.md` § 9 measured
 * 100 → 60 as a large latency cut for no detectable quality loss on the English
 * corpus, and as a real loss on the Hungarian one — so it is offered for
 * English and withheld for Hungarian rather than offered with a warning.
 */
export const poolChoices = (hungarian: boolean): readonly Choice<string>[] =>
  hungarian
    ? [
        {
          value: String(POOL_SHIPPED),
          title: `${String(POOL_SHIPPED)} candidates — the shipped depth`,
          pro: 'what every recorded baseline used',
          con: 'the slower end of the tradeoff; on a Hungarian corpus, cutting it measured a real quality loss, so no smaller depth is offered here',
          recommended: true,
        },
      ]
    : [
        {
          value: String(POOL_SHIPPED),
          title: `${String(POOL_SHIPPED)} candidates — the shipped depth`,
          pro: 'what every recorded baseline used; raise it further only if you read deep into a result list',
          con: 'the reranker is the slow hop, and it pays for all 100',
          recommended: true,
        },
        {
          value: String(POOL_FAST),
          title: `${String(POOL_FAST)} candidates — the fast depth`,
          pro: 'roughly a 40 % latency cut on an English corpus, for no quality difference the measurement could detect',
          con: 'measured on English only; a Hungarian corpus loses real quality at this depth',
        },
      ];

/** What the wizard says about pseudo-relevance feedback, which ships ON. */
export const PRF_ADVICE = {
  pro: 'Pseudo-relevance feedback means gnosis reads the first handful of results, takes the words that keep coming up in them, and searches again including those words — so a document that says what you meant in different words is still found. It is on by default, it runs inside SQLite, and it adds no model, no server and no network call',
  con: 'it helps only when the right document uses different words to yours; where your words and the document’s are the same and only the meaning connects them, it does nothing, and on a collection whose wording your searches already match it buys little',
} as const;

/** What the wizard says about the reranker before asking whether to set one up. */
export const RERANK_ADVICE = {
  pro: 'A reranker is a second pass: a language model reads your search and each candidate document and puts them in a better order. After phrasing the search itself, it is the largest quality gain the tool has',
  con: 'it needs a reranker model on this machine, and it is the slow part — a search that reranks the whole candidate pool takes seconds rather than being instant. You can skip it: search works without one, and `dp-gnosis setup` adds one later',
} as const;

/** How the downloaded GGUF is actually run: by a server, or by gnosis itself. */
export type RunMode = 'served' | 'local';

/**
 * The one axis this pair trades on is EASE against SPEED, and the wizard says
 * so in those words because that is the choice the user is actually making.
 *
 * `served` stays recommended, and it is not a preference: `RERANK_DEFAULT_BACKEND`
 * is `http` (`config.ts`), every recorded baseline in
 * `handbook/GNOSIS-BASELINES.md` was scored through a served endpoint, and the
 * in-process engine is deliberately UNCALIBRATED, so `--min-relevance` refuses
 * under it. Promoting the local one would need its own measured arm.
 *
 * Neither claim here carries a millisecond figure. Per-document cost spans more
 * than an order of magnitude between a GPU and a CPU, so a constant quoted from
 * one machine forecasts nothing about another — the wizard measures the machine
 * in front of it and shows the user THAT number instead.
 */
export const RUN_MODE_CHOICES: readonly Choice<RunMode>[] = [
  {
    value: 'served',
    title: 'Run it in a llama.cpp server — the faster, measured path',
    pro: 'the model stays resident, so every query pays only the scoring; it is the path every recorded baseline was measured on, and one llama-swap can share a GPU between the reranker and your chat models',
    con: 'a second process to install, start and keep alive — and gnosis does not own it, so a server that dies takes reranking with it until you restart it',
    recommended: true,
  },
  {
    value: 'local',
    title: 'Let gnosis load it in-process — the simpler install',
    pro: 'no server to install, start or keep running: one npm package and the .gguf, and an MCP client that launches dp-gnosis gets a reranker with nothing behind it',
    con: 'the model is loaded into THIS process, so a one-shot `dp-gnosis search` pays that load every run; it competes with any llama.cpp server for the same GPU; its scores are uncalibrated, so `--min-relevance` refuses under it; and its ranking QUALITY — the ORDER it puts the pool in, not the probability — is UNMEASURED: it loads, discriminates and reorders, but no paired benchmark arm has ever scored it, which is why the shipped default stays the served one and this is an available route rather than a promoted one (`OPTIONAL.md` § The in-process backend)',
  },
];

/**
 * What to expect from the in-process engine, by what the hardware probe saw.
 *
 * The `cpu` line names the probe's own limit rather than claiming there is no
 * GPU: `hardware.ts` reads `nvidia-smi`, so an AMD or Apple GPU is invisible to
 * it while llama.cpp would happily use one. Stating "no GPU" outright would be a
 * detector's blind spot reported as a fact about the machine — which is why
 * neither line is the last word. The timing that follows is measured HERE, and
 * it is what the user decides on.
 *
 * Both lines say WHO picks the hardware, because it is not the user:
 * `localReranker.ts` calls `getLlama()` with no options, so llama.cpp selects
 * whatever GPU backend the installed `node-llama-cpp` was built with, and falls
 * back to the CPU only when it finds none. No backend is NAMED to the user: the
 * build matrix is a property of the installed package, not of this file. That is
 * what makes the probe's blindness harmless — and it is also why no answer here
 * can force the CPU while a GPU is present.
 */
export const LOCAL_ENGINE_ADVICE = {
  gpu: 'a GPU was detected, which is where this engine is worth running — and gnosis passes llama.cpp no device options at all, so the engine takes that card by itself, with whatever GPU backend the installed node-llama-cpp was built with: there is nothing to configure, and equally no way to hold it on the CPU while the card is there',
  cpu: 'no NVIDIA GPU was detected — the check reads nvidia-smi, so an AMD or Apple GPU will not appear here. That blind spot is harmless, because the choice is not yours to make: gnosis passes llama.cpp no device options, so the engine uses whatever GPU backend the installed node-llama-cpp was built with, and the CPU only when it finds none. On a CPU this engine is more than an order of magnitude slower per document, which at the shipped pool of 100 means minutes per search rather than seconds. The wizard times it on this machine next, before anything is written',
} as const;
