/**
 * `--fuse-legs` — the three-leg fusion as a REAL route.
 *
 * The properties worth asserting are the ones no measured run can show: that the
 * route computes the FORECAST's fusion rather than a second one, that the
 * atom-identity tie-break is the one the docblock claims, that every refusal is
 * loud, and — the load-bearing one — that absent the flag nothing moved.
 */
import { describe, expect, it } from 'vitest';

import type { IndexState, KnowledgePort, RetrievedAtom } from '../../gnosis/src/port.js';
import { DEFAULT_PRF_PARAMS } from '../../gnosis/src/prf.js';
import { SCALE_FIELDS, TREATMENT_FIELDS, treatmentChanges } from '../src/compare.js';
import { rrfFuse, rrfScored } from '../src/fuseForecast.js';
import { type HistoryRow, NO_FUSE_LEGS } from '../src/report.js';
import {
  FUSE_LEG_CATALOG,
  fuseLegAtoms,
  type FuseLegPort,
  fuseLegsLabelOf,
  parseArgs,
  provenanceOf,
  queryDataset
} from '../src/run.js';

const THREE_LEGS = 'fts5,linear,fts5+prf';

const atomOf = (id: string, score: number): RetrievedAtom => ({
  id,
  title: id,
  domain: 'docs',
  type: 'knowledge',
  body: id,
  score,
  sourcePath: `atoms/${id}.md`,
  originPaths: [`docs/${id}.md`],
});

describe('--fuse-legs refusals', () => {
  it('names the catalog on an unknown leg', () => {
    expect(() => parseArgs(['--fuse-legs', 'fts5,bm25f'])).toThrow(
      /unknown --fuse-legs leg "bm25f".*fts5, linear, fts5\+prf/s
    );
  });

  it('refuses a fusion of fewer than two legs', () => {
    expect(() => parseArgs(['--fuse-legs', 'fts5'])).toThrow(/names 1 leg\(s\).*at least 2/s);
    expect(() => parseArgs(['--fuse-legs', ''])).toThrow(/names 0 leg\(s\).*at least 2/s);
  });

  it('refuses a repeated leg rather than deduping it in silence', () => {
    expect(() => parseArgs(['--fuse-legs', 'fts5,fts5'])).toThrow(
      /names leg "fts5" twice.*doubles its own share/s
    );
  });

  it('refuses --adapter beside the flag, naming both', () => {
    expect(() => parseArgs(['--adapter', 'linear', '--fuse-legs', THREE_LEGS])).toThrow(
      /--adapter "linear" cannot be combined with --fuse-legs/
    );
    expect(() => parseArgs(['--adapter', 'fts5', '--fuse-legs', THREE_LEGS])).not.toThrow();
  });

  it('refuses --prf beside the flag, naming both', () => {
    expect(() => parseArgs(['--prf', '--fuse-legs', THREE_LEGS])).toThrow(
      /--prf cannot be combined with --fuse-legs.*fts5\+prf/s
    );
  });

  it('accepts the RM3 knobs without --prf exactly when a prf leg is named', () => {
    expect(parseArgs(['--fuse-legs', THREE_LEGS, '--prf-alpha', '0.25']).prfAlpha).toBe(0.25);
    expect(() => parseArgs(['--fuse-legs', 'fts5,linear', '--prf-alpha', '0.25'])).toThrow(
      /--prf-alpha "0.25" requires --prf/
    );
  });
});

describe('fuseLegs provenance', () => {
  it('is a TREATMENT field, so a fusion change is an ARM COMPARISON', () => {
    expect(TREATMENT_FIELDS).toContain('fuseLegs');
    expect(SCALE_FIELDS).not.toContain('fuseLegs');
  });

  it('records the canonical csv in the ORDER the flag listed the legs', () => {
    const reversed = 'fts5+prf,linear,fts5';
    expect(fuseLegsLabelOf(parseArgs(['--fuse-legs', reversed]))).toBe(reversed);
    expect(provenanceOf(parseArgs(['--fuse-legs', THREE_LEGS]), 'sha').fuseLegs).toBe(THREE_LEGS);
  });

  it('backfills a row recorded before the field existed to `none`', () => {
    const legacy = { fuseLegs: undefined } as unknown as HistoryRow;
    const unfused = { fuseLegs: undefined } as unknown as HistoryRow;
    const fused = { fuseLegs: THREE_LEGS } as unknown as HistoryRow;
    expect(treatmentChanges(legacy, unfused)).toEqual([]);
    expect(treatmentChanges(legacy, fused)).toEqual([
      { field: 'fuseLegs', previous: NO_FUSE_LEGS, latest: THREE_LEGS },
    ]);
  });
});

describe('fuseLegAtoms', () => {
  const LEG_A = [atomOf('a1', -1), atomOf('a2', -2), atomOf('a3', -3)];
  const LEG_B = [atomOf('a3', -0.5), atomOf('a1', -4)];

  it('reproduces rrfFuse exactly — the route does not re-derive the formula', () => {
    const share = 1 / 2;
    expect(fuseLegAtoms([LEG_A, LEG_B], 10).map(atom => atom.id)).toEqual(
      rrfFuse([LEG_A.map(a => a.id), LEG_B.map(a => a.id)], [share, share], 10)
    );
  });

  it('gives each fused atom its RRF score, not the leg BM25 score it arrived with', () => {
    const share = 1 / 2;
    const expected = rrfScored([LEG_A.map(a => a.id), LEG_B.map(a => a.id)], [share, share], 10);
    expect(fuseLegAtoms([LEG_A, LEG_B], 10).map(atom => atom.score)).toEqual(
      expected.map(entry => entry.score)
    );
  });

  it('takes each fused atom from the FIRST leg that returned it', () => {
    const first = [atomOf('shared', -1)];
    const second = [{ ...atomOf('shared', -9), title: 'from the second leg' }];
    expect(fuseLegAtoms([first, second], 10)[0]?.title).toBe('shared');
    expect(fuseLegAtoms([second, first], 10)[0]?.title).toBe('from the second leg');
  });

  it('truncates the union to the requested depth', () => {
    expect(fuseLegAtoms([LEG_A, LEG_B], 2)).toHaveLength(2);
  });
});

describe('the fused route reaches every leg port', () => {
  const portOf = (
    atoms: readonly RetrievedAtom[],
    seen: string[]
  ): KnowledgePort => ({
    name: 'fts5',
    retrieve: async (_query, options) => {
      seen.push(JSON.stringify(options.prf ?? null));
      return await Promise.resolve({ atoms, mode: 'fts5', indexState: 'ready' as IndexState });
    },
  });

  it('queries each leg with its OWN term model and fuses what came back', async () => {
    const seen: string[] = [];
    const legs: readonly FuseLegPort[] = [
      { label: 'fts5', port: portOf([atomOf('a1', -1)], seen), prf: undefined },
      { label: 'linear', port: portOf([atomOf('a2', -1)], seen), prf: undefined },
      { label: 'fts5+prf', port: portOf([atomOf('a1', -1)], seen), prf: DEFAULT_PRF_PARAMS },
    ];
    const outcome = await queryDataset(
      {
        port: portOf([], seen),
        options: parseArgs(['--fuse-legs', THREE_LEGS]),
        excluded: new Map(),
        legs,
      },
      [{ id: 'q1', text: 'lint:test-shape' }]
    );
    expect(seen).toEqual(['null', 'null', JSON.stringify(DEFAULT_PRF_PARAMS)]);
    // `a1` came back from two legs and `a2` from one, so `a1` leads the fusion.
    expect(outcome.rankings.get('q1')).toEqual(['a1', 'a2']);
  });
});

describe('absent the flag, nothing moved', () => {
  it('leaves the parsed options with no legs at all', () => {
    expect(parseArgs([]).fuseLegs).toBeUndefined();
    expect(parseArgs(['--depth', '20', '--rerank']).fuseLegs).toBeUndefined();
  });

  it('writes NO fuseLegs key on the recorded provenance', () => {
    const provenance = provenanceOf(parseArgs([]), 'sha');
    expect(provenance.fuseLegs).toBeUndefined();
    expect(JSON.stringify(provenance)).not.toContain('fuseLegs');
  });

  it('keeps the catalog the three legs the forecast fuses', () => {
    expect(FUSE_LEG_CATALOG.map(leg => leg.label)).toEqual(['fts5', 'linear', 'fts5+prf']);
  });
});
