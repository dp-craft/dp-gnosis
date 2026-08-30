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
  /** Set on the one option the wizard pre-selects. */
  readonly recommended?: true;
}

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
    pro: 'the measured champion and the path every recorded baseline was measured on; fast, no extra packages, nothing to serve',
    con: 'its BM25 k1/b are compiled into SQLite and cannot be tuned',
    recommended: true,
  },
  {
    value: 'minisearch',
    title: 'minisearch — a pure-JS lexical index',
    pro: 'no native module at all; useful where better-sqlite3 will not build',
    con: 'its own tokenizer and field setup, so its ranking is not the one the baselines describe',
  },
  {
    value: 'linear',
    title: 'linear — the reference BM25 implementation',
    pro: 'exact, tunable (BM25 k1 and b), and the yardstick the other adapters are read against',
    con: 'slow by construction — it re-reads the corpus on every search, and it builds no persistent index',
  },
  {
    value: 'lancedb',
    title: 'lancedb — LanceDB full-text, deliberately frozen',
    pro: 'a v2-readiness probe kept reproducible on purpose',
    con: 'BM25 only — no embeddings and no vector column — and frozen, so it is not a route to improve',
  },
  {
    value: 'lancedb-vec',
    title: 'lancedb-vec — dense only (research)',
    pro: 'the dense control arm; on some corpora the dense signal genuinely wins',
    con: 'a research route, not a shipped one: it needs an embedding server and a ~1.1 GB model, and its sign FLIPS by corpus — measured harmful on the English product corpus',
  },
  {
    value: 'lancedb-hybrid',
    title: 'lancedb-hybrid — dense fused with lexical (research)',
    pro: 'the best-measured of the three dense routes',
    con: 'still not shipped: every dense win is FIRST-STAGE and unproven through the reranker, and it costs an embedding server, a vector column, a cache and a fusion path',
  },
  {
    value: 'lancedb-hybrid-full',
    title: 'lancedb-hybrid-full — the same fusion, untruncated pool (research)',
    pro: 'raises first-stage recall as forecast',
    con: 'converts none of that recall into ranking quality, at a substantially higher rerank cost; recorded evidence, not a route to use',
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
    pro: 'the shipped chain and what every English baseline was measured on: Porter stemming plus accent folding',
    con: 'stems English morphology only; a Hungarian corpus loses badly to it',
    recommended: true,
  },
  {
    value: 'ident-porter-fold',
    title: 'ident-porter-fold — English, identifier-aware',
    pro: 'splits code identifiers into their parts, so a corpus full of symbol names becomes reachable',
    con: 'its mechanism is identifier handling, NOT vocabulary coverage — on prose it buys nothing',
  },
  {
    value: 'hulight-fold',
    title: 'hulight-fold — Hungarian',
    pro: 'a large measured gain on Hungarian corpora, both technical and prose',
    con: 'a measured LOSS on English — it MUST stay corpus-scoped and never become the global default',
  },
  {
    value: 'ident-hulight-fold',
    title: 'ident-hulight-fold — Hungarian, identifier-aware',
    pro: 'the best measured chain on a Hungarian corpus that CONTAINS code identifiers',
    con: 'on Hungarian prose without identifiers the plain hulight-fold measured better — the language alone MUST NOT pick this',
  },
  {
    value: 'nostem-fold',
    title: 'nostem-fold — folding only, no stemming',
    pro: 'an ablation arm: exact tokens, accents folded',
    con: 'no morphology at all; recorded for comparison, not for serving',
  },
  {
    value: 'porter-nofold',
    title: 'porter-nofold — stemming without folding',
    pro: 'an ablation arm isolating the folding stage',
    con: 'an accented query then fails to match its unaccented form',
  },
  {
    value: 'nostem-nofold',
    title: 'nostem-nofold — raw tokens',
    pro: 'the null ablation: split and lowercase, nothing else',
    con: 'no morphology and no folding; the weakest arm on every corpus measured',
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
  pro: 'RM3 pseudo-relevance feedback is a served default on the shipped profiles — pure SQLite, no network hop, and it closes a vocabulary gap (the right document under different words)',
  con: 'it cannot close a RELATIONAL gap, and on a corpus where queries already use the documents’ own words it buys little',
} as const;

/** What the wizard says about the reranker before asking whether to set one up. */
export const RERANK_ADVICE = {
  pro: 'the single largest quality lever the tool has after query phrasing, and the difference between judging gnosis at BM25-only and judging what it actually does',
  con: 'it needs a reranker model and it is the slow hop — a search that reranks a pool of 100 costs seconds, not milliseconds',
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
