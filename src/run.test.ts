import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ATOM_MAX_CHARS,
  DEFAULT_EXCLUDED_TYPES,
  DEFAULT_FIELD_WEIGHTS,
  DEFAULT_RERANK_PRESET,
  EMBED_MODEL_ID,
  RERANK_DOC_MAX_CHARS,
  RERANK_FUSION_PRESETS,
  RERANK_K_INIT,
  RERANK_MODEL_ID,
  RERANK_RRF_K,
  RERANK_RRF_WEIGHT
} from '../../dp-gnosis/src/config.js';
import type {
  IndexState,
  KnowledgePort,
  RetrievedAtom,
  RetrieveOptions
} from '../../dp-gnosis/src/port.js';
import { DEFAULT_PRF_PARAMS } from '../../dp-gnosis/src/prf.js';
import { ANALYZERS, DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import { EXTRACT_STRATEGY } from '../../dp-gnosis/src/rerank.js';
import { SCALE_FIELDS, TREATMENT_FIELDS } from './compare.js';
import { UNREACHABLE_GOLD_CAUSE } from './fetch/vault.js';
import { type DatasetEntry, loadManifest } from './manifest.js';
import type { Qrel } from './metrics.js';
import {
  canonicalFieldWeights,
  type DatasetResult,
  DEFAULT_FIELD_WEIGHTS_TEXT,
  HISTORY_FILE,
  NO_TYPE_FILTER,
  readHistory,
  recordDataset,
  type RunProvenance
} from './report.js';
import {
  applyGate,
  BENCH_DEFAULT_ADAPTER,
  COLLAPSING_TOPICS_WARNING,
  collapsingTopicGroups,
  effectiveAtomMaxChars,
  firstPassDepth,
  goldIdsOf,
  main,
  MANIFEST_PATH,
  measureAndRecordAll,
  parseArgs,
  percentileMs,
  provenanceOf,
  queryDataset,
  type QueryOutcome,
  REFUSAL_EXIT_CODE,
  RERANK_POOL_BELOW_DEPTH_WARNING,
  rerankPoolOf,
  RUN_HELP,
  selectDatasets,
  selectionError,
  warnCollapsingTopics,
  warnRerankPoolBelowDepth
} from './run.js';

/** A second reranker id — any id the shipped constant is not. */
const OTHER_MODEL = 'jina-reranker-v2-base-multilingual';

describe('parseArgs', () => {
  it('defaults to every enabled dataset at depth 100 with no rerank', () => {
    expect(parseArgs([])).toEqual({
      only: [],
      depth: 100,
      rerank: false,
      compare: false,
      adapter: BENCH_DEFAULT_ADAPTER,
      rerankProfile: DEFAULT_RERANK_PRESET,
      rerankWeight: undefined,
      rerankFusion: RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
      analyzer: DEFAULT_ANALYZER,
      queryAdjacency: false,
      fieldWeights: DEFAULT_FIELD_WEIGHTS,
      enrichmentPath: undefined,
      prf: false,
      includeHistory: false,
    });
  });

  it('reads --only as a csv list and the remaining flags as switches', () => {
    expect(parseArgs(['--only', 'scifact, nfcorpus', '--depth', '20', '--rerank', '--compare']))
      .toEqual({
        only: ['scifact', 'nfcorpus'],
        depth: 20,
        rerank: true,
        compare: true,
        adapter: BENCH_DEFAULT_ADAPTER,
        rerankProfile: DEFAULT_RERANK_PRESET,
        rerankWeight: undefined,
        rerankFusion: RERANK_FUSION_PRESETS[DEFAULT_RERANK_PRESET],
        analyzer: DEFAULT_ANALYZER,
        queryAdjacency: false,
        fieldWeights: DEFAULT_FIELD_WEIGHTS,
        enrichmentPath: undefined,
        prf: false,
        includeHistory: false,
      });
  });

  it('reads --adapter as the registered adapter to measure', () => {
    expect(parseArgs(['--adapter', 'linear']).adapter).toBe('linear');
    expect(parseArgs(['--adapter', 'minisearch']).adapter).toBe('minisearch');
  });

  it('FAILS LOUDLY on an unknown adapter rather than falling back', () => {
    expect(() => parseArgs(['--adapter', 'faiss'])).toThrow(/faiss/);
    expect(() => parseArgs(['--adapter', 'faiss'])).toThrow(/fts5/);
  });

  it('reads --rerank-profile as a NAME the engine resolves into its fusion rule', () => {
    const options = parseArgs(['--rerank', '--rerank-profile', 'beir-ce']);
    expect(options.rerankProfile).toBe('beir-ce');
    expect(options.rerankFusion).toEqual({ kind: 'replace' });
  });

  it('FAILS LOUDLY on an unknown rerank profile, naming it and the known ones', () => {
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/monot5/);
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/shipped/);
    expect(() => parseArgs(['--rerank-profile', 'monot5'])).toThrow(/beir-ce/);
  });

  it('applies --rerank-weight as a raw override on the named preset', () => {
    const options = parseArgs(['--rerank', '--rerank-weight', '0.8']);
    expect(options.rerankWeight).toBe(0.8);
    expect(options.rerankFusion).toEqual({ kind: 'rrf', rrfK: RERANK_RRF_K, rerankWeight: 0.8 });
  });

  it('reads --rerank-model as the cross-encoder the arm is measured with', () => {
    expect(parseArgs(['--rerank', '--rerank-model', OTHER_MODEL]).rerankModel).toBe(OTHER_MODEL);
  });

  it('leaves --rerank-model unset on a plain --rerank run — the shipped model', () => {
    expect(parseArgs(['--rerank']).rerankModel).toBeUndefined();
  });

  /**
   * Without `--rerank` nothing reranks, so a recorded model id would name a
   * cross-encoder that never scored a document — a row indistinguishable from a
   * measured arm. It refuses instead, naming both flags.
   */
  it('REFUSES --rerank-model without --rerank, naming both flags', () => {
    expect(() => parseArgs(['--rerank-model', OTHER_MODEL])).toThrow(/--rerank-model/);
    expect(() => parseArgs(['--rerank-model', OTHER_MODEL])).toThrow(/requires --rerank/);
    expect(() => parseArgs(['--rerank-model', OTHER_MODEL])).toThrow(new RegExp(OTHER_MODEL));
  });

  it('reads --rerank-pool as the EXPLICIT candidate pool, engine floor bypassed', () => {
    expect(parseArgs(['--rerank', '--rerank-pool', '20']).rerankPool).toBe(20);
  });

  it('leaves --rerank-pool unset when it is not named — the old formula stands', () => {
    expect(parseArgs(['--rerank']).rerankPool).toBeUndefined();
    expect(parseArgs([]).rerankPool).toBeUndefined();
  });

  /**
   * Without `--rerank` nothing reranks, so the row would carry a pool label no
   * reranker ever scored — the `--rerank-model` failure one field over.
   */
  it('REFUSES --rerank-pool without --rerank, naming both flags', () => {
    expect(() => parseArgs(['--rerank-pool', '20'])).toThrow(/--rerank-pool/);
    expect(() => parseArgs(['--rerank-pool', '20'])).toThrow(/requires --rerank/);
  });

  it('REFUSES a non-integer, zero or negative pool, naming the constraint', () => {
    expect(() => parseArgs(['--rerank', '--rerank-pool', '2.5'])).toThrow(/2\.5/);
    expect(() => parseArgs(['--rerank', '--rerank-pool', '2.5'])).toThrow(/integer/);
    expect(() => parseArgs(['--rerank', '--rerank-pool', '0'])).toThrow(/integer/);
    expect(() => parseArgs(['--rerank', '--rerank-pool', '-5'])).toThrow(/integer/);
    expect(() => parseArgs(['--rerank', '--rerank-pool', 'deep'])).toThrow(/deep/);
  });

  it('reads --rerank-doc-max-chars and --rerank-extract as WHAT the reranker is shown', () => {
    const options = parseArgs([
      '--rerank',
      '--rerank-doc-max-chars',
      '4000',
      '--rerank-extract',
      'headtail',
    ]);
    expect(options.rerankDocMaxChars).toBe(4000);
    expect(options.rerankExtract).toBe('headtail');
  });

  it('leaves the doc window unset when neither is named — the shipped window stands', () => {
    expect(parseArgs(['--rerank']).rerankDocMaxChars).toBeUndefined();
    expect(parseArgs(['--rerank']).rerankExtract).toBeUndefined();
  });

  /**
   * Without `--rerank` nothing reranks, so the row would carry a width label no
   * cross-encoder ever read — the `--rerank-pool` failure one field over.
   */
  it('REFUSES the doc-window flags without --rerank, naming both flags', () => {
    expect(() => parseArgs(['--rerank-doc-max-chars', '4000'])).toThrow(/requires --rerank/);
    expect(() => parseArgs(['--rerank-extract', 'headtail'])).toThrow(/requires --rerank/);
  });

  it('REFUSES a non-integer, zero or negative doc width, naming the constraint', () => {
    const width = (value: string): (() => unknown) => (): unknown =>
      parseArgs(['--rerank', '--rerank-doc-max-chars', value]);
    expect(width('2.5')).toThrow(/2\.5/);
    expect(width('2.5')).toThrow(/integer/);
    expect(width('0')).toThrow(/integer/);
    expect(width('-5')).toThrow(/integer/);
    expect(width('wide')).toThrow(/wide/);
  });

  it('REFUSES an unknown extraction, naming the valid ones', () => {
    const thrown = (): unknown => parseArgs(['--rerank', '--rerank-extract', 'middle']);
    expect(thrown).toThrow(/middle/);
    expect(thrown).toThrow(/head/);
    expect(thrown).toThrow(/headtail/);
  });

  it('reads --budget and --served-k as the CONSUMER cap and the served window', () => {
    const options = parseArgs(['--budget', '16000', '--served-k', '5']);
    expect(options.tokenBudget).toBe(16000);
    expect(options.servedK).toBe(5);
  });

  it('leaves both unset when --budget is not named — the default path stands', () => {
    expect(parseArgs([]).tokenBudget).toBeUndefined();
    expect(parseArgs([]).servedK).toBeUndefined();
  });

  /**
   * Without `--budget` nothing is capped, yet the row would carry a served-window
   * label no presentation ever applied — the `--rerank-model` failure one flag over.
   */
  it('REFUSES --served-k without --budget, naming both flags', () => {
    expect(() => parseArgs(['--served-k', '5'])).toThrow(/--served-k/);
    expect(() => parseArgs(['--served-k', '5'])).toThrow(/--budget/);
  });

  it('REFUSES a non-integer, zero or negative budget, naming the constraint', () => {
    expect(() => parseArgs(['--budget', '2.5'])).toThrow(/2\.5/);
    expect(() => parseArgs(['--budget', '2.5'])).toThrow(/integer/);
    expect(() => parseArgs(['--budget', '0'])).toThrow(/integer/);
    expect(() => parseArgs(['--budget', '-5'])).toThrow(/integer/);
    expect(() => parseArgs(['--budget', 'wide'])).toThrow(/wide/);
  });

  it('REFUSES a non-integer, zero or negative served window too', () => {
    expect(() => parseArgs(['--budget', '16000', '--served-k', '0'])).toThrow(/integer/);
    expect(() => parseArgs(['--budget', '16000', '--served-k', '2.5'])).toThrow(/integer/);
    expect(() => parseArgs(['--budget', '16000', '--served-k', '-1'])).toThrow(/integer/);
  });

  it('defaults --analyzer to the engine chain every recorded run was measured on', () => {
    expect(parseArgs([]).analyzer).toBe(DEFAULT_ANALYZER);
    expect(DEFAULT_ANALYZER).toBe('porter-fold');
  });

  it('reads --analyzer as the chain the index is built with', () => {
    expect(parseArgs(['--analyzer', 'nostem-fold']).analyzer).toBe('nostem-fold');
    expect(parseArgs(['--analyzer', 'porter-nofold']).analyzer).toBe('porter-nofold');
  });

  it('FAILS LOUDLY on an unknown analyzer, naming it and every valid id', () => {
    expect(() => parseArgs(['--analyzer', 'snowball'])).toThrow(/snowball/);
    Object.keys(ANALYZERS).forEach(id => {
      expect(() => parseArgs(['--analyzer', 'snowball'])).toThrow(new RegExp(id));
    });
  });

  it('REFUSES a named analyzer on an adapter that does not honour it, naming both', () => {
    const argv = ['--adapter', 'linear', '--analyzer', 'nostem-fold'];
    expect(() => parseArgs(argv)).toThrow(/linear/);
    expect(() => parseArgs(argv)).toThrow(/nostem-fold/);
    expect(() => parseArgs(argv)).toThrow(/fts5/);
    expect(() => parseArgs(['--adapter', 'minisearch', '--analyzer', 'porter-nofold'])).toThrow(
      /minisearch/
    );
  });

  it('stamps the chain a hard-coded adapter RUNS when no --analyzer is given', () => {
    expect(parseArgs(['--adapter', 'linear']).analyzer).toBe('porter-fold');
    expect(parseArgs(['--adapter', 'linear']).adapter).toBe('linear');
    expect(parseArgs(['--adapter', 'minisearch']).analyzer).toBe('porter-fold');
  });

  it('ACCEPTS the hard-coded chain named explicitly on such an adapter', () => {
    expect(parseArgs(['--adapter', 'linear', '--analyzer', 'porter-fold']).analyzer).toBe(
      'porter-fold'
    );
  });

  it('REFUSES a chain such an adapter never runs, named explicitly', () => {
    const argv = ['--adapter', 'linear', '--analyzer', 'ident-porter-fold'];
    expect(() => parseArgs(argv)).toThrow(/linear/);
    expect(() => parseArgs(argv)).toThrow(/ident-porter-fold/);
    expect(() => parseArgs(['--adapter', 'lancedb', '--analyzer', 'ident-porter-fold'])).toThrow(
      /lancedb/
    );
  });

  it('keeps the waiver on the LITERAL chain, so a default move cannot widen it', () => {
    // The waived chain is what `linear` / `minisearch` implement in code
    // (`tokenize` + `stemTerm` = `porter-fold`), never whatever `DEFAULT_ANALYZER`
    // happens to name. The default currently names the same chain, so equality
    // with it proves nothing: pin the LITERAL, and prove the waiver did not widen
    // to a second chain the way it would if it followed the default.
    const waived = parseArgs(['--adapter', 'linear']).analyzer;
    expect(waived).toBe('porter-fold');
    expect(() => parseArgs(['--adapter', 'linear', '--analyzer', 'ident-porter-fold'])).toThrow(
      /linear/
    );
  });

  it('accepts a named analyzer on fts5, the one adapter that builds its index with it', () => {
    expect(parseArgs(['--adapter', 'fts5', '--analyzer', 'nostem-fold']).analyzer).toBe(
      'nostem-fold'
    );
    Object.keys(ANALYZERS).forEach(id => {
      expect(parseArgs(['--adapter', 'fts5', '--analyzer', id]).analyzer).toBe(id);
    });
  });

  it('defaults --query-adjacency OFF, the treatment every recorded run was measured without', () => {
    expect(parseArgs([]).queryAdjacency).toBe(false);
  });

  it('reads --query-adjacency as a switch', () => {
    expect(parseArgs(['--query-adjacency']).queryAdjacency).toBe(true);
    expect(parseArgs(['--adapter', 'fts5', '--query-adjacency']).queryAdjacency).toBe(true);
  });

  it('REFUSES --query-adjacency on an adapter that does not honour it, naming both', () => {
    const argv = ['--adapter', 'linear', '--query-adjacency'];
    expect(() => parseArgs(argv)).toThrow(/linear/);
    expect(() => parseArgs(argv)).toThrow(/--query-adjacency/);
    expect(() => parseArgs(argv)).toThrow(/fts5/);
    expect(() => parseArgs(['--adapter', 'minisearch', '--query-adjacency'])).toThrow(
      /minisearch/
    );
    expect(() => parseArgs(['--adapter', 'lancedb', '--query-adjacency'])).toThrow(/lancedb/);
  });

  it('leaves the flagless invocation on a non-fts5 adapter alone — every legacy run', () => {
    expect(parseArgs(['--adapter', 'linear']).queryAdjacency).toBe(false);
  });

  it('defaults --prf OFF, the treatment every recorded run was measured without', () => {
    expect(parseArgs([]).prf).toBe(false);
    expect(parseArgs([]).prfDocs).toBeUndefined();
    expect(parseArgs([]).prfTerms).toBeUndefined();
    expect(parseArgs([]).prfAlpha).toBeUndefined();
  });

  it('reads --prf as a switch', () => {
    expect(parseArgs(['--prf']).prf).toBe(true);
    expect(parseArgs(['--adapter', 'fts5', '--prf']).prf).toBe(true);
  });

  it('REFUSES --prf on an adapter that does not honour it, naming both', () => {
    expect(() => parseArgs(['--adapter', 'linear', '--prf'])).toThrow(/linear/);
    expect(() => parseArgs(['--adapter', 'linear', '--prf'])).toThrow(/--prf/);
    expect(() => parseArgs(['--adapter', 'minisearch', '--prf'])).toThrow(/fts5/);
  });

  it('reads the three RM3 knobs when --prf names them', () => {
    const options = parseArgs([
      '--prf',
      '--prf-docs',
      '5',
      '--prf-terms',
      '8',
      '--prf-alpha',
      '0.3',
    ]);
    expect(options.prfDocs).toBe(5);
    expect(options.prfTerms).toBe(8);
    expect(options.prfAlpha).toBe(0.3);
  });

  it('REFUSES an RM3 knob without --prf — nothing would expand', () => {
    expect(() => parseArgs(['--prf-docs', '5'])).toThrow(/--prf/);
    expect(() => parseArgs(['--prf-terms', '8'])).toThrow(/--prf/);
    expect(() => parseArgs(['--prf-alpha', '0.3'])).toThrow(/--prf/);
  });

  it('REFUSES a fractional, zero or negative feedback size rather than clamping it', () => {
    expect(() => parseArgs(['--prf', '--prf-docs', '0'])).toThrow(/--prf-docs/);
    expect(() => parseArgs(['--prf', '--prf-docs', '2.5'])).toThrow(/--prf-docs/);
    expect(() => parseArgs(['--prf', '--prf-terms', '-1'])).toThrow(/--prf-terms/);
  });

  it('REFUSES an alpha outside 0…1 rather than clamping it', () => {
    expect(() => parseArgs(['--prf', '--prf-alpha', '1.5'])).toThrow(/--prf-alpha/);
    expect(() => parseArgs(['--prf', '--prf-alpha', '-0.1'])).toThrow(/--prf-alpha/);
    expect(() => parseArgs(['--prf', '--prf-alpha', 'nope'])).toThrow(/--prf-alpha/);
  });

  /**
   * The bench measures what the CLI SERVES: the excluded types are subtracted at
   * the DERIVE step, so an unflagged run no longer projects an atom no user can
   * be shown. OFF is the aligned default; the flag restores the full corpus.
   */
  it('defaults --include-history OFF, so the run measures the SERVABLE corpus', () => {
    expect(parseArgs([]).includeHistory).toBe(false);
  });

  it('reads --include-history as a switch, restoring the full corpus arm', () => {
    expect(parseArgs(['--include-history']).includeHistory).toBe(true);
  });

  it('reads --layer as the suite layer to run', () => {
    expect(parseArgs(['--layer', 'smoke']).layer).toBe('smoke');
    expect(parseArgs([]).layer).toBeUndefined();
  });

  it('FAILS LOUDLY on an unknown layer, naming it and the valid ones', () => {
    expect(() => parseArgs(['--layer', 'tier1'])).toThrow(/tier1/);
    expect(() => parseArgs(['--layer', 'tier1'])).toThrow(/smoke.*par.*full/s);
  });

  it('FAILS LOUDLY on a non-numeric --rerank-weight rather than measuring NaN', () => {
    expect(() => parseArgs(['--rerank-weight', 'half'])).toThrow(/half/);
  });

  it('FAILS LOUDLY when a weight is overridden on a preset that has no weight term', () => {
    expect(() => parseArgs(['--rerank-profile', 'beir-ce', '--rerank-weight', '0.8'])).toThrow(
      /beir-ce/
    );
  });

  it('reads --hybrid-weight as the DENSE leg weight of the hybrid route fusion', () => {
    expect(parseArgs(['--adapter', 'lancedb-hybrid', '--hybrid-weight', '0.8']).hybridWeight).toBe(
      0.8
    );
    expect(
      parseArgs(['--adapter', 'lancedb-hybrid-full', '--hybrid-weight', '0']).hybridWeight
    ).toBe(0);
  });

  it('defaults --hybrid-weight to unset, which is the shipped leg fusion', () => {
    expect(parseArgs([]).hybridWeight).toBeUndefined();
    expect(parseArgs(['--adapter', 'lancedb-hybrid']).hybridWeight).toBeUndefined();
  });

  it('FAILS LOUDLY on an out-of-range --hybrid-weight, naming the flag and the range', () => {
    const argv = ['--adapter', 'lancedb-hybrid', '--hybrid-weight', '1.5'];
    expect(() => parseArgs(argv)).toThrow(/--hybrid-weight/);
    expect(() => parseArgs(argv)).toThrow(/1\.5/);
    expect(() => parseArgs(argv)).toThrow(/0.*1/);
    expect(() => parseArgs(['--adapter', 'lancedb-hybrid', '--hybrid-weight', '-0.1'])).toThrow(
      /--hybrid-weight/
    );
    expect(() => parseArgs(['--adapter', 'lancedb-hybrid', '--hybrid-weight', 'half'])).toThrow(
      /half/
    );
  });

  /**
   * It is a TREATMENT field, so a row carrying it on an adapter that fuses no
   * legs would label an arm the run never measured.
   */
  it('REFUSES --hybrid-weight on an adapter with no leg fusion, naming both', () => {
    const argv = ['--adapter', 'fts5', '--hybrid-weight', '0.8'];
    expect(() => parseArgs(argv)).toThrow(/--hybrid-weight/);
    expect(() => parseArgs(argv)).toThrow(/fts5/);
    expect(() => parseArgs(argv)).toThrow(/lancedb-hybrid/);
  });

  it('leaves the RERANK fusion weight untouched — two fusions, two flags', () => {
    const options = parseArgs([
      '--adapter',
      'lancedb-hybrid',
      '--hybrid-weight',
      '0.8',
      '--rerank',
      '--rerank-weight',
      '0.2',
    ]);
    expect(options.hybridWeight).toBe(0.8);
    expect(options.rerankWeight).toBe(0.2);
    expect(options.rerankFusion).toEqual({ kind: 'rrf', rrfK: RERANK_RRF_K, rerankWeight: 0.2 });
  });

  it('MERGES --field-weights over the default, leaving an unnamed column alone', () => {
    const options = parseArgs(['--field-weights', 'questions=2,keywords=0.5']);
    expect(options.fieldWeights).toEqual({
      ...DEFAULT_FIELD_WEIGHTS,
      questions: 2,
      keywords: 0.5,
    });
    expect(options.fieldWeights.body).toBe(DEFAULT_FIELD_WEIGHTS.body);
  });

  it('FAILS LOUDLY on an unknown --field-weights column, naming the real ones', () => {
    const argv = ['--field-weights', 'title=2'];
    expect(() => parseArgs(argv)).toThrow(/title/);
    expect(() => parseArgs(argv)).toThrow(/questions/);
  });

  it('FAILS LOUDLY on a non-finite weight rather than scoring the index with NaN', () => {
    expect(() => parseArgs(['--field-weights', 'body=nope'])).toThrow(/finite/);
    expect(() => parseArgs(['--field-weights', 'body='])).toThrow(/finite/);
  });

  it('REFUSES --field-weights on an adapter that weights no columns', () => {
    const argv = ['--adapter', 'linear', '--field-weights', 'questions=2'];
    expect(() => parseArgs(argv)).toThrow(/--field-weights/);
    expect(() => parseArgs(argv)).toThrow(/linear/);
    expect(() => parseArgs(argv)).toThrow(/fts5/);
  });

  it('reads --enrichment as the sidecar the index build joins in', () => {
    expect(parseArgs(['--enrichment', '/tmp/enrichment.jsonl']).enrichmentPath).toBe(
      '/tmp/enrichment.jsonl'
    );
  });

  it('REFUSES --enrichment on an adapter with no enrichment columns to merge into', () => {
    const argv = ['--adapter', 'minisearch', '--enrichment', '/tmp/enrichment.jsonl'];
    expect(() => parseArgs(argv)).toThrow(/--enrichment/);
    expect(() => parseArgs(argv)).toThrow(/minisearch/);
    expect(() => parseArgs(argv)).toThrow(/fts5/);
  });
});

describe('the field-weight and enrichment provenance', () => {
  /**
   * The value is compared FIELD BY FIELD in `history.jsonl`, so what a run stamps
   * has to be a stable STRING in `FTS_COLUMNS` order — an object would compare by
   * key order and JSON shape rather than by the weights themselves.
   */
  it('stamps the weights canonically, in FTS_COLUMNS order', () => {
    expect(canonicalFieldWeights(DEFAULT_FIELD_WEIGHTS)).toBe(
      'body=1,short=0,long=0,doc_desc=0,keywords=0,entities=0,questions=0'
    );
  });

  it('stamps a merged arm as the SAME string for two runs of that arm', () => {
    const first = parseArgs(['--field-weights', 'questions=2']);
    const second = parseArgs(['--field-weights', 'questions=2']);
    expect(canonicalFieldWeights(first.fieldWeights)).toBe(
      canonicalFieldWeights(second.fieldWeights)
    );
  });

  /**
   * The backfill's other half: a run that names NEITHER flag must stamp exactly
   * what every recorded row is read as, so an unflagged run today and a row
   * recorded before the columns existed compare EQUAL rather than as two arms.
   */
  it('stamps an UNFLAGGED run as the body-only, unenriched arm', () => {
    const provenance = provenanceOf(parseArgs([]), 'abc1234');
    expect(provenance.fieldWeights).toBe(DEFAULT_FIELD_WEIGHTS_TEXT);
    expect(parseArgs([]).enrichmentPath).toBeUndefined();
  });
});

describe('percentileMs', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('takes the nearest rank over the ascending samples', () => {
    expect(percentileMs(samples, 0.5)).toBe(50);
    expect(percentileMs(samples, 0.95)).toBe(100);
  });

  it('sorts before ranking, so arrival order cannot change the answer', () => {
    expect(percentileMs([90, 10, 50], 0.5)).toBe(50);
  });

  it('is 0 when no query was timed', () => {
    expect(percentileMs([], 0.95)).toBe(0);
  });
});

describe('effectiveAtomMaxChars', () => {
  const entry = (atomMaxChars?: number): DatasetEntry => ({
    id: 'scifact',
    format: 'beir-local',
    source: './data/scifact',
    qrels: 'test',
    domain: 'scientific-claims',
    docShape: 'abstract',
    atomMaxChars,
    enabled: true,
    layers: [],
  });

  it('resolves the ENGINE default when the manifest is silent, never null', () => {
    // Recording null would make two runs straddling a change to the engine
    // default look like one scale, and compare.ts would subtract across them.
    expect(effectiveAtomMaxChars(entry())).toBe(ATOM_MAX_CHARS);
  });

  it('uses the manifest value when the entry sets one', () => {
    expect(effectiveAtomMaxChars(entry(1234))).toBe(1234);
  });
});

describe('firstPassDepth', () => {
  it('widens the first pass to the engine RERANK_K_INIT when reranking below it', () => {
    expect(firstPassDepth(5, true)).toBe(RERANK_K_INIT);
  });

  it('leaves a depth above RERANK_K_INIT alone, reranking and BM25 alike', () => {
    expect(firstPassDepth(100, true)).toBe(100);
    expect(firstPassDepth(5, false)).toBe(5);
  });

  /**
   * The whole point of the flag: the engine constant is a SERVING default, not a
   * floor the measuring instrument may impose on itself.
   */
  it('honours an explicit pool BELOW the engine RERANK_K_INIT, floor bypassed', () => {
    expect(RERANK_K_INIT).toBeGreaterThan(20);
    expect(firstPassDepth(100, true, 20)).toBe(20);
    expect(rerankPoolOf(parseArgs(['--depth', '100', '--rerank', '--rerank-pool', '20']))).toBe(20);
  });

  it('reproduces the old formula exactly when no pool is named', () => {
    expect(rerankPoolOf(parseArgs(['--depth', '20', '--rerank']))).toBe(RERANK_K_INIT);
    expect(rerankPoolOf(parseArgs(['--depth', '20']))).toBe(20);
  });
});

describe('selectDatasets', () => {
  const manifest = loadManifest(MANIFEST_PATH);

  it('selects exactly the enabled entries when --only is silent', () => {
    const selection = selectDatasets(manifest, []);
    expect(selection.entries.map(entry => entry.id)).toEqual(
      manifest.filter(entry => entry.enabled).map(entry => entry.id)
    );
    expect(selection.unknown).toEqual([]);
  });

  it('honours an --only id that names a disabled entry', () => {
    const selection = selectDatasets(manifest, ['vault-hu-rephrased']);
    expect(selection.entries.map(entry => entry.id)).toEqual(['vault-hu-rephrased']);
    expect(selection.entries[0]?.enabled).toBe(false);
    expect(selection.unknown).toEqual([]);
  });

  it('reports an --only id that matches no manifest entry', () => {
    const selection = selectDatasets(manifest, ['vault', 'vault-typo']);
    expect(selection.entries.map(entry => entry.id)).toEqual(['vault']);
    expect(selection.unknown).toEqual(['vault-typo']);
  });

  it('selects exactly the layer members when --layer is given alone', () => {
    const selection = selectDatasets(manifest, [], 'smoke');
    expect(selection.entries.map(entry => entry.id)).toEqual([
      'nfcorpus',
      'scifact',
      'vault',
      'vault-hu',
    ]);
    expect(selection.unknown).toEqual([]);
  });

  it('INTERSECTS --layer with --only', () => {
    const selection = selectDatasets(manifest, ['scifact'], 'par');
    expect(selection.entries.map(entry => entry.id)).toEqual(['scifact']);
    expect(selection.unknown).toEqual([]);
  });

  // A known id outside the layer is NOT unknown — reporting it as a typo would
  // send the reader after the wrong defect. The empty intersection is the error.
  it('empties the selection when --only names a known id outside --layer', () => {
    const selection = selectDatasets(manifest, ['vault'], 'par');
    expect(selection.entries).toEqual([]);
    expect(selection.unknown).toEqual([]);
    expect(selectionError(selection)).toMatch(/--layer par with --only vault/);
  });
});

describe('selectionError', () => {
  it('names every unmatched id', () => {
    const message = selectionError({ entries: [], unknown: ['nope', 'also-nope'] });
    expect(message).toContain('nope');
    expect(message).toContain('also-nope');
  });

  it('refuses an empty selection', () => {
    expect(selectionError({ entries: [], unknown: [] })).toMatch(/no dataset/i);
  });

  it('passes a non-empty fully matched selection', () => {
    const selection = selectDatasets(loadManifest(MANIFEST_PATH), ['vault-hu-rephrased']);
    expect(selectionError(selection)).toBeUndefined();
  });
});

describe('provenanceOf — which reranker the row is attributed to', () => {
  /** The default is unchanged: `--rerank` alone still records the shipped id. */
  it('records the shipped model on a --rerank run that named none', () => {
    expect(provenanceOf(parseArgs(['--rerank']), 'sha').rerankModel).toBe(RERANK_MODEL_ID);
  });

  it('records a named model verbatim, so two model arms cannot read as one', () => {
    const provenance = provenanceOf(parseArgs(['--rerank', '--rerank-model', OTHER_MODEL]), 'sha');
    expect(provenance.rerankModel).toBe(OTHER_MODEL);
  });

  it('records NO model on a run that did not rerank', () => {
    expect(provenanceOf(parseArgs([]), 'sha').rerankModel).toBeUndefined();
  });

  it('stamps the EXPLICIT pool on rerankPool — one field, not a second', () => {
    const argv = ['--depth', '100', '--rerank', '--rerank-pool', '20'];
    expect(provenanceOf(parseArgs(argv), 'sha').rerankPool).toBe(20);
  });

  it('stamps the old formula on rerankPool when no pool is named', () => {
    expect(provenanceOf(parseArgs(['--depth', '20', '--rerank']), 'sha').rerankPool).toBe(
      RERANK_K_INIT
    );
    expect(provenanceOf(parseArgs(['--depth', '20']), 'sha').rerankPool).toBeUndefined();
  });

  /**
   * The EFFECTIVE fusion weight, never the raw flag. An unstamped row reads as
   * the LEGACY 0.5 in `compare.ts`, so a row measured at the shipped weight must
   * say so on its own line — otherwise a 0.5 arm and a 0.75 arm are subtracted.
   * A `replace` protocol has no weight term and records none.
   */
  it('stamps the EFFECTIVE rerank fusion weight, not just a named override', () => {
    expect(provenanceOf(parseArgs(['--rerank']), 'sha').rerankWeight).toBe(RERANK_RRF_WEIGHT);
    const named = parseArgs(['--rerank', '--rerank-weight', '0.25']);
    expect(provenanceOf(named, 'sha').rerankWeight).toBe(0.25);
    const replaced = parseArgs(['--rerank', '--rerank-profile', 'beir-ce']);
    expect(provenanceOf(replaced, 'sha').rerankWeight).toBeUndefined();
    expect(provenanceOf(parseArgs([]), 'sha').rerankWeight).toBeUndefined();
  });

  it('records the hybrid leg weight, so a swept weight is never silent', () => {
    const argv = ['--adapter', 'lancedb-hybrid', '--hybrid-weight', '0.8'];
    expect(provenanceOf(parseArgs(argv), 'sha').hybridWeight).toBe(0.8);
    expect(provenanceOf(parseArgs([]), 'sha').hybridWeight).toBeUndefined();
  });

  /**
   * The two parameters that decide WHAT the reranker is shown. An unstamped row
   * would let a change to either be subtracted as a like-for-like delta.
   */
  it('stamps the rerank doc window and extraction on a run that reranked', () => {
    const provenance = provenanceOf(parseArgs(['--rerank']), 'sha');
    expect(provenance.rerankDocMaxChars).toBe(RERANK_DOC_MAX_CHARS);
    expect(provenance.rerankExtract).toBe(EXTRACT_STRATEGY);
  });

  /**
   * The EFFECTIVE window, never the constant. A row reading `2000` while 4000
   * characters were scored is the provenance failure GNOSIS-GUIDE.md § Landmines
   * is built around — the arm would be subtracted as a like-for-like delta.
   */
  it('stamps the EFFECTIVE doc window a width arm named, not the shipped constant', () => {
    const argv = ['--rerank', '--rerank-doc-max-chars', '4000', '--rerank-extract', 'headtail'];
    const provenance = provenanceOf(parseArgs(argv), 'sha');
    expect(provenance.rerankDocMaxChars).toBe(4000);
    expect(provenance.rerankExtract).toBe('headtail');
  });

  /** Both are TREATMENT fields, so a width move is labelled, never subtracted. */
  it('keeps the doc window a treatment, so a width arm is an ARM COMPARISON', () => {
    expect(TREATMENT_FIELDS).toContain('rerankDocMaxChars');
    expect(TREATMENT_FIELDS).toContain('rerankExtract');
    expect(SCALE_FIELDS).not.toContain('rerankDocMaxChars');
    expect(SCALE_FIELDS).not.toContain('rerankExtract');
  });

  it('stamps NO doc window on a run that reranked nothing', () => {
    const provenance = provenanceOf(parseArgs([]), 'sha');
    expect(provenance.rerankDocMaxChars).toBeUndefined();
    expect(provenance.rerankExtract).toBeUndefined();
  });

  /**
   * The consumer cap and its window: stamped only on a run that ASKED for one,
   * so every already-recorded row stays byte-identical on both fields. The
   * window is stamped RESOLVED, exactly as `rerankModel` and `rerankPool` are —
   * a budgeted row whose window read `undefined` could not be told apart from a
   * row measured under another one.
   */
  it('stamps the budget and the RESOLVED served window on a budgeted run', () => {
    const provenance = provenanceOf(parseArgs(['--budget', '16000', '--served-k', '5']), 'sha');
    expect(provenance.tokenBudget).toBe(16000);
    expect(provenance.servedK).toBe(5);
  });

  it('resolves an unnamed served window to the run depth, the whole presentation', () => {
    const provenance = provenanceOf(parseArgs(['--depth', '20', '--budget', '16000']), 'sha');
    expect(provenance.servedK).toBe(20);
  });

  it('stamps NEITHER field on a run that named no budget', () => {
    const provenance = provenanceOf(parseArgs([]), 'sha');
    expect(provenance.tokenBudget).toBeUndefined();
    expect(provenance.servedK).toBeUndefined();
  });

  /**
   * The encoder is stamped only where one ran. A lexical row embedded nothing,
   * so naming a model on it would record a treatment it never applied.
   */
  it('stamps the embedding model on a dense route and on no other', () => {
    expect(provenanceOf(parseArgs(['--adapter', 'lancedb-vec']), 'sha').embedModel).toBe(
      EMBED_MODEL_ID
    );
    expect(provenanceOf(parseArgs(['--adapter', 'lancedb-hybrid']), 'sha').embedModel).toBe(
      EMBED_MODEL_ID
    );
    expect(provenanceOf(parseArgs(['--adapter', 'fts5']), 'sha').embedModel).toBeUndefined();
    expect(provenanceOf(parseArgs(['--adapter', 'lancedb']), 'sha').embedModel).toBeUndefined();
  });

  it('records the query-adjacency treatment on every row, applied or not', () => {
    expect(provenanceOf(parseArgs(['--query-adjacency']), 'sha').queryAdjacency).toBe(true);
    expect(provenanceOf(parseArgs([]), 'sha').queryAdjacency).toBe(false);
  });

  it('records the PRF treatment on every row, applied or not', () => {
    expect(provenanceOf(parseArgs(['--prf']), 'sha').prf).toBe(true);
    expect(provenanceOf(parseArgs([]), 'sha').prf).toBe(false);
  });

  it('records the RESOLVED RM3 knobs only on a row that expanded', () => {
    const on = provenanceOf(parseArgs(['--prf']), 'sha');
    expect(on.prfDocs).toBe(DEFAULT_PRF_PARAMS.fbDocs);
    expect(on.prfTerms).toBe(DEFAULT_PRF_PARAMS.fbTerms);
    expect(on.prfAlpha).toBe(DEFAULT_PRF_PARAMS.alpha);
    const off = provenanceOf(parseArgs([]), 'sha');
    expect(off.prfDocs).toBeUndefined();
    expect(off.prfTerms).toBeUndefined();
    expect(off.prfAlpha).toBeUndefined();
  });

  it('records an OVERRIDDEN knob as the value the run measured', () => {
    expect(provenanceOf(parseArgs(['--prf', '--prf-alpha', '0.25']), 'sha').prfAlpha).toBe(0.25);
  });

  /**
   * The EXCLUDED types are what the row has to name: they are the atoms the arm
   * could never return, and they are unrecoverable from the metrics afterwards.
   * Sorted, so two runs of the same arm stamp the same string.
   */
  it('records the effective EXCLUDED types as the typeFilter treatment, on both arms', () => {
    expect(provenanceOf(parseArgs([]), 'sha').typeFilter).toBe(
      [...DEFAULT_EXCLUDED_TYPES].sort().join(',')
    );
    expect(provenanceOf(parseArgs(['--include-history']), 'sha').typeFilter).toBe(NO_TYPE_FILTER);
  });
});

/**
 * The flag is worthless unless it reaches `port.retrieve` — a run recording
 * `queryAdjacency: true` while querying without it is exactly the failure class
 * the refusal above exists to prevent, one layer down.
 */
describe('queryDataset — the treatment reaches the port', () => {
  const spyPort = (seen: RetrieveOptions[]): KnowledgePort => ({
    name: 'fts5',
    retrieve: async (_query: string, opts: RetrieveOptions) => {
      seen.push(opts);
      return await Promise.resolve({
        atoms: [],
        mode: 'fts5',
        indexState: 'ready' as IndexState,
      });
    },
  });

  const seenOptionsFor = async (argv: readonly string[]): Promise<readonly RetrieveOptions[]> => {
    const seen: RetrieveOptions[] = [];
    await queryDataset(
      { port: spyPort(seen), options: parseArgs(argv), excluded: new Map() },
      [{ id: 'q1', text: 'lint:test-shape' }]
    );
    return seen;
  };

  it('passes adjacency true when the flag is set', async () => {
    expect((await seenOptionsFor(['--query-adjacency']))[0]?.adjacency).toBe(true);
  });

  it('passes adjacency false when it is not', async () => {
    expect((await seenOptionsFor([]))[0]?.adjacency).toBe(false);
  });

  it('passes NO prf option when the flag is absent — the default path, byte for byte', async () => {
    expect((await seenOptionsFor([]))[0]?.prf).toBeUndefined();
  });

  it('passes the DEFAULT RM3 params when --prf is set alone', async () => {
    expect((await seenOptionsFor(['--prf']))[0]?.prf).toEqual(DEFAULT_PRF_PARAMS);
  });

  it('passes the OVERRIDDEN RM3 params the flags named', async () => {
    const argv = ['--prf', '--prf-docs', '3', '--prf-terms', '7', '--prf-alpha', '0.9'];
    expect((await seenOptionsFor(argv))[0]?.prf).toEqual({ fbDocs: 3, fbTerms: 7, alpha: 0.9 });
  });
});

/**
 * The scores are the ranking's SECOND projection, and the only failure mode that
 * matters is a silent misalignment: nothing downstream reads a score, so a
 * ranking and a score vector that describe different atoms would be invisible in
 * every metric. Each case below asserts the two agree through the REAL query
 * path — rollup, dedupe, exclusions and the presentation cap included.
 */
describe('queryDataset — the scores travel with the order they produced', () => {
  const scoredAtomFor = (index: number, docId: string, score: number): RetrievedAtom => ({
    id: `a${index}`,
    title: `atom ${index}`,
    domain: 'docs',
    type: 'knowledge',
    body: '0123456789',
    score,
    sourcePath: `atoms/a${index}.md`,
    originPaths: [`docs/${docId}.md`],
  });

  const portOf = (atoms: readonly RetrievedAtom[]): KnowledgePort => ({
    name: 'fts5',
    retrieve: async () =>
      await Promise.resolve({ atoms, mode: 'fts5', indexState: 'ready' as IndexState }),
  });

  const outcomeFor = async (
    atoms: readonly RetrievedAtom[],
    argv: readonly string[] = [],
    excluded: ReadonlyMap<string, readonly string[]> = new Map()
  ): Promise<QueryOutcome> =>
    await queryDataset({ port: portOf(atoms), options: parseArgs(argv), excluded }, [
      { id: 'q1', text: 'lint:test-shape' },
    ]);

  const ATOMS = [
    scoredAtomFor(1, 'd1', -2.5),
    scoredAtomFor(2, 'd2', -4.25),
    scoredAtomFor(3, 'd3', -6.125),
  ];

  it('records one score per ranked document, in the ranking order', async () => {
    const outcome = await outcomeFor(ATOMS);
    expect(outcome.documentScores.get('q1')).toEqual([
      { docId: 'd1', score: -2.5 },
      { docId: 'd2', score: -4.25 },
      { docId: 'd3', score: -6.125 },
    ]);
    expect(outcome.documentScores.get('q1')?.map(entry => entry.docId)).toEqual(
      outcome.rankings.get('q1')
    );
  });

  it('keeps the score of the atom that WON the rank when two atoms share a document', async () => {
    const shared = [scoredAtomFor(1, 'd1', -2.5), scoredAtomFor(2, 'd1', -9.5)];
    const outcome = await outcomeFor(shared);
    expect(outcome.documentScores.get('q1')).toEqual([{ docId: 'd1', score: -2.5 }]);
    expect(outcome.rankings.get('q1')).toEqual(['d1']);
  });

  it('drops an excluded document from the scores exactly as from the ranking', async () => {
    const outcome = await outcomeFor(ATOMS, [], new Map([['q1', ['d2']]]));
    expect(outcome.documentScores.get('q1')?.map(entry => entry.docId)).toEqual(['d1', 'd3']);
    expect(outcome.rankings.get('q1')).toEqual(['d1', 'd3']);
  });

  it('is truncated by the presentation budget exactly as the ranking is', async () => {
    const outcome = await outcomeFor(ATOMS, ['--budget', '20']);
    expect(outcome.documentScores.get('q1')?.map(entry => entry.docId)).toEqual(
      outcome.rankings.get('q1')
    );
    expect(outcome.documentScores.get('q1')).toHaveLength(2);
  });
});

/**
 * The budget is a PRESENTATION cap and it sits after the rerank, so it is
 * measurable only through the ranking a topic ends up with. `estimateTokens` is
 * the UTF-8 byte length, so a 10-character ASCII body costs exactly 10.
 */
describe('queryDataset — the consumer budget caps the PRESENTED ranking', () => {
  const ATOM_BODY_TOKENS = 10;

  const atomFor = (index: number): RetrievedAtom => ({
    id: `a${index}`,
    title: `atom ${index}`,
    domain: 'docs',
    type: 'knowledge',
    body: '0123456789',
    score: 1 / index,
    sourcePath: `atoms/a${index}.md`,
    originPaths: [`docs/d${index}.md`],
  });

  const budgetPort = (): KnowledgePort => ({
    name: 'fts5',
    retrieve: async () =>
      await Promise.resolve({
        atoms: [atomFor(1), atomFor(2), atomFor(3)],
        mode: 'fts5',
        indexState: 'ready' as IndexState,
      }),
  });

  const rankingFor = async (argv: readonly string[]): Promise<readonly string[]> => {
    const outcome = await queryDataset(
      { port: budgetPort(), options: parseArgs(argv), excluded: new Map() },
      [{ id: 'q1', text: 'lint:test-shape' }]
    );
    return outcome.rankings.get('q1') ?? [];
  };

  /** The guard that every recorded row still re-runs: no flag, no truncation. */
  it('presents the WHOLE ranking when no budget is named', async () => {
    expect(await rankingFor([])).toEqual(['d1', 'd2', 'd3']);
  });

  it('admits only the atoms the budget holds, in rank order', async () => {
    expect(await rankingFor(['--budget', String(ATOM_BODY_TOKENS * 2)])).toEqual(['d1', 'd2']);
  });

  it('narrows the presentation to --served-k before the budget is charged', async () => {
    const argv = ['--budget', String(ATOM_BODY_TOKENS * 3), '--served-k', '1'];
    expect(await rankingFor(argv)).toEqual(['d1']);
  });
});

describe('main dataset selection', () => {
  it('exits non-zero and names the unknown id on stderr, measuring nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await main(['--only', 'vault-hu-typo'], 'sha');
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    stderr.mockRestore();
    stdout.mockRestore();
    expect(code).not.toBe(0);
    expect(written).toContain('vault-hu-typo');
  });

  // An empty layer/id intersection MUST fail loudly by name, exactly as an
  // unknown --only id does — never a silent no-op that exits 0 measuring nothing.
  it('exits non-zero naming both flags when --layer and --only intersect to nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const code = await main(['--layer', 'par', '--only', 'vault'], 'sha');
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    stderr.mockRestore();
    stdout.mockRestore();
    expect(code).not.toBe(0);
    expect(written).toContain('--layer par with --only vault');
  });

  // As with --adapter, the throw escapes main and kills the process non-zero
  // before a single dataset is touched.
  it('refuses an unknown --layer before measuring, naming it and the valid layers', async () => {
    await expect(main(['--layer', 'tier1'], 'sha')).rejects.toThrow(/tier1.*smoke.*par.*full/s);
  });
});

const FLAT_METRICS = {
  ndcg10: 0.5,
  recall10: 0.5,
  recall20: 0.5,
  recall100: 0.5,
  recall300: undefined,
  recall1000: undefined,
  precision5: 0.2,
  precision10: 0.15,
  allGoldInTop10: 1,
  map: 0.5,
  rPrecision: 0.4,
  rbpResidual: 0.3,
  mrr10: 0.5,
};

const resultFor = (dataset: string): DatasetResult => ({
  dataset,
  domain: 'test-domain',
  docShape: 'abstract',
  corpusBytes: 10,
  corpusLines: 2,
  atomMaxChars: 4000,
  topics: 1,
  docCount: 2,
  atomCount: 2,
  ingestMs: 1,
  queryMs: 1,
  queryP50Ms: 1,
  queryP95Ms: 1,
  metrics: FLAT_METRICS,
  metricsSd: FLAT_METRICS,
  perTopic: [{ queryId: 'q1', metrics: FLAT_METRICS }],
  rankings: new Map([['q1', ['doc-a']]]),
});

const testProvenance: RunProvenance = {
  ts: '2026-08-15T10:00:00.000Z',
  gitSha: 'sha1234',
  adapter: 'fts5',
  fieldWeights: DEFAULT_FIELD_WEIGHTS_TEXT,
  depth: 100,
  rerank: false,
  analyzer: DEFAULT_ANALYZER,
  queryAdjacency: false,
  prf: false,
  typeFilter: NO_TYPE_FILTER,
};

/**
 * The 2026-08-15 failure: a 67.5-minute run completed six datasets, died of an
 * OOM on the seventh, and wrote ZERO history rows because every artefact was
 * buffered to the end. The property that has to hold is per-dataset, not
 * per-run: when dataset N fails, 1…N−1 are already on disk.
 */
describe('measureAndRecordAll', () => {
  it('has already recorded datasets 1…N−1 when dataset N throws', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-run-'));
    const entries = loadManifest(MANIFEST_PATH).slice(0, 3);
    const failing = entries[2]?.id ?? '';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const results = await measureAndRecordAll(entries, {
      measure: async entry => {
        if (entry.id === failing) throw new Error('Reached heap limit Allocation failed');
        return resultFor(entry.id);
      },
      record: result => {
        recordDataset({ resultsDir: dir, provenance: testProvenance, result });
      },
    });
    stdout.mockRestore();
    stderr.mockRestore();
    const rows = readHistory(resolve(dir, HISTORY_FILE));
    expect(rows.map(row => row.dataset)).toEqual([entries[0]?.id, entries[1]?.id]);
    expect(results.map(result => result.dataset)).toEqual([entries[0]?.id, entries[1]?.id]);
    expect(rows.every(row => existsSync(resolve(dir, row.perTopicPath ?? '')))).toBe(true);
    expect(rows.every(row => existsSync(resolve(dir, row.runPath ?? '')))).toBe(true);
  });

  /**
   * A dataset FAILURE is recorded and the run continues; a REFUSAL is not a
   * failure of one dataset, it is a statement that the corpus cannot be scored.
   * Swallowing it would exit 1 — "some dataset failed" — and hide the exit-3
   * contract the unreachable-gold gate exists to state.
   */
  it('propagates a refusal instead of recording it as a dataset failure', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-refuse-'));
    const entries = loadManifest(MANIFEST_PATH).slice(0, 2);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const act = measureAndRecordAll(entries, {
      measure: () => {
        throw new Error('gold is unreachable', { cause: UNREACHABLE_GOLD_CAUSE });
      },
      record: result => {
        recordDataset({ resultsDir: dir, provenance: testProvenance, result });
      },
    });

    await expect(act).rejects.toThrow(
      expect.objectContaining({ cause: UNREACHABLE_GOLD_CAUSE })
    );
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe('the refusal exit code', () => {
  it('is 3, and --help states it', () => {
    expect(REFUSAL_EXIT_CODE).toBe(3);
    expect(RUN_HELP).toContain('  3  ');
  });
});

/**
 * The defect: the bench applies NO topic filter (`engine.ts` calls
 * `port.retrieve(text, { k })` with none), so two topics whose only difference is
 * an authored `domain`/`type` filter are ONE topic measured twice — every
 * macro-average double-counts it.
 */
describe('collapsingTopicGroups', () => {
  const gold = (...docIds: readonly string[]): Qrel =>
    new Map(docIds.map(docId => [docId, 1]));

  it('finds two topics sharing query text and gold set', () => {
    expect(
      collapsingTopicGroups(
        new Map([
          ['q-059', 'what did we decide'],
          ['q-060', 'what did we decide'],
        ]),
        new Map([
          ['q-059', gold('a', 'b')],
          ['q-060', gold('b', 'a')],
        ])
      )
    ).toEqual([['q-059', 'q-060']]);
  });

  it('is not a group when the query text matches but the gold set differs', () => {
    expect(
      collapsingTopicGroups(
        new Map([
          ['q-1', 'same text'],
          ['q-2', 'same text'],
        ]),
        new Map([
          ['q-1', gold('a', 'b')],
          ['q-2', gold('a', 'c')],
        ])
      )
    ).toEqual([]);
  });

  it('is not a group when the gold set matches but the query text differs', () => {
    expect(
      collapsingTopicGroups(
        new Map([
          ['q-1', 'one text'],
          ['q-2', 'other text'],
        ]),
        new Map([
          ['q-1', gold('a')],
          ['q-2', gold('a')],
        ])
      )
    ).toEqual([]);
  });

  // Grade 0 is a judged NON-relevant document (`metrics.ts` counts grade > 0), so
  // it MUST NOT make two different gold sets look identical, nor split two equal ones.
  it('ignores grade-0 judgments when comparing gold sets', () => {
    const queries = new Map([
      ['q-1', 'same text'],
      ['q-2', 'same text'],
    ]);
    expect(
      collapsingTopicGroups(
        queries,
        new Map([
          ['q-1', new Map([['a', 1], ['z', 0]])],
          ['q-2', new Map([['a', 1]])],
        ])
      )
    ).toEqual([['q-1', 'q-2']]);
    expect(
      collapsingTopicGroups(
        queries,
        new Map([
          ['q-1', new Map([['a', 1], ['z', 0]])],
          ['q-2', new Map([['a', 1], ['z', 1]])],
        ])
      )
    ).toEqual([]);
  });

  it('groups a three-way collapse as one group and orders ids and groups', () => {
    expect(
      collapsingTopicGroups(
        new Map([
          ['q-c', 'beta'],
          ['q-b', 'alpha'],
          ['q-a', 'alpha'],
          ['q-d', 'beta'],
          ['q-e', 'alpha'],
        ]),
        new Map([
          ['q-c', gold('x')],
          ['q-b', gold('a')],
          ['q-a', gold('a')],
          ['q-d', gold('x')],
          ['q-e', gold('a')],
        ])
      )
    ).toEqual([
      ['q-a', 'q-b', 'q-e'],
      ['q-c', 'q-d'],
    ]);
  });

  it('returns no groups for empty input', () => {
    expect(collapsingTopicGroups(new Map(), new Map())).toEqual([]);
  });
});

describe('warnCollapsingTopics', () => {
  const collapsing = (): readonly [ReadonlyMap<string, string>, ReadonlyMap<string, Qrel>] => [
    new Map([
      ['q-059', 'what did we decide'],
      ['q-060', 'what did we decide'],
    ]),
    new Map([
      ['q-059', new Map([['d1', 1]])],
      ['q-060', new Map([['d1', 1]])],
    ]),
  ];

  it('names the dataset, the group and the double-counting on stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const [queries, qrels] = collapsing();
    warnCollapsingTopics('vault', queries, qrels);
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    stderr.mockRestore();
    expect(written).toContain(COLLAPSING_TOPICS_WARNING);
    expect(written).toContain('vault');
    expect(written).toContain('q-059 + q-060');
    expect(written).toContain('double-counted');
  });

  it('writes nothing when no topic set collapses', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    warnCollapsingTopics(
      'vault-hu',
      new Map([['q-1', 'a']]),
      new Map([['q-1', new Map([['d1', 1]])]])
    );
    const calls = stderr.mock.calls.length;
    stderr.mockRestore();
    expect(calls).toBe(0);
  });
});

/**
 * A pool below the requested depth is a LEGITIMATE arm — it is what measuring a
 * small-pool reranker means — but every metric cut above the pool is capped by
 * it, so R@100 from a pool of 20 is R@20 under another name. Warned, never
 * refused, exactly as a collapsing topic group is.
 */
describe('warnRerankPoolBelowDepth', () => {
  const writtenFor = (argv: readonly string[]): string => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    warnRerankPoolBelowDepth(parseArgs(argv));
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    stderr.mockRestore();
    return written;
  };

  it('names the pool, the depth and the capping when the pool is smaller', () => {
    const written = writtenFor(['--depth', '100', '--rerank', '--rerank-pool', '20']);
    expect(written).toContain(RERANK_POOL_BELOW_DEPTH_WARNING);
    expect(written).toContain('20');
    expect(written).toContain('100');
    expect(written).toMatch(/capped/i);
  });

  it('writes nothing when the pool covers the depth, or no pool is named', () => {
    expect(writtenFor(['--depth', '20', '--rerank', '--rerank-pool', '50'])).toBe('');
    expect(writtenFor(['--depth', '20', '--rerank'])).toBe('');
    expect(writtenFor(['--depth', '20'])).toBe('');
  });
});

describe('the regression gate wiring', () => {
  const entries = [{ id: 'vault' } as DatasetEntry];

  it('leaves a run without the flags untouched — no gate, no output', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(applyGate(undefined, entries, 0)).toBe(0);
    expect(applyGate(undefined, entries, 1)).toBe(1);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('keeps a failed run\'s own exit code AND says the gate did not run', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(applyGate({ baseline: 'anything', failUnder: 0.01 }, entries, 1)).toBe(1);
    const printed = String(write.mock.calls[0]?.[0]);
    expect(printed).toContain('NOT RUN');
    expect(printed).toContain('exited 1');
    write.mockRestore();
  });

  it('documents exit 4 in --help', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await main(['--help'], 'sha')).toBe(0);
    expect(write.mock.calls[0]?.[0]).toContain('  4  the regression gate failed');
    write.mockRestore();
  });

  it('names both flags when only one of the pair is given', async () => {
    await expect(main(['--baseline', 'x'], 'sha')).rejects.toThrow(/--baseline.*--fail-under/s);
    await expect(main(['--fail-under', '0.01'], 'sha')).rejects.toThrow(/--baseline/);
  });

  it('states in --help that the flags come in a pair', () => {
    expect(RUN_HELP).toContain('--baseline');
    expect(RUN_HELP).toContain('--fail-under');
  });
});

/**
 * THE ROUTE from the golden set to the ingest dedupe. `IngestOptions.goldIds`
 * exists, but a field nobody passes changes nothing on the MEASURED path — the
 * gate is which datasets get one, and the ids come from the qrels the run
 * SCORES so the two can never name different documents.
 */
describe('goldIdsOf — which datasets tell the dedupe what is judged', () => {
  const qrels = (): ReadonlyMap<string, Qrel> =>
    new Map<string, Qrel>([
      ['q-1', new Map([['ts-debugging-rules', 1], ['60-debugging', 1]])],
      ['q-2', new Map([['ts-debugging-rules', 1], ['unjudged-neighbour', 0]])],
    ]);

  const beirLocal: DatasetEntry = {
    id: 'scifact',
    format: 'beir-local',
    source: './data/scifact',
    qrels: 'test',
    domain: 'scientific-claims',
    docShape: 'abstract',
    enabled: true,
    layers: [],
  };

  const derived: DatasetEntry = {
    ...beirLocal,
    id: 'vault',
    derive: { atoms: './data/vault-atoms', golden: './golden-set.v2.json' },
  };

  const bright: DatasetEntry = {
    id: 'bright-biology-passages',
    format: 'bright',
    split: 'biology',
    granularity: 'passage',
    domain: 'biology',
    docShape: 'passage',
    enabled: true,
    layers: [],
  };

  it('hands a DERIVED dataset every judged id, deduplicated across topics', () => {
    expect([...(goldIdsOf(derived, qrels()) ?? [])].sort()).toEqual([
      '60-debugging',
      'ts-debugging-rules',
    ]);
  });

  it('passes NOTHING for a BEIR dataset, so its ingest is unchanged', () => {
    expect(goldIdsOf(beirLocal, qrels())).toBeUndefined();
    expect(goldIdsOf(bright, qrels())).toBeUndefined();
  });
});
