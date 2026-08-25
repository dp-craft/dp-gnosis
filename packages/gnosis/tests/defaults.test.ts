/**
 * The serving defaults ARE the measured champion (`GNOSIS-BASELINES.md`
 * § Serving path, 2026-08-18 at `gitSha` b64d5bff): `fts5` + `qwen3-reranker-4b`
 * over a pool of 100, scoring `vault` nDCG@10 0.5040 and `vault-hu` 0.6929.
 *
 * These are the only assertions that fail when a default silently drifts away
 * from the arm it was measured under — a CLI serving one route while the suite
 * measures another publishes numbers nobody produced.
 */
import { BENCH_DEFAULT_ADAPTER } from '../../gnosis-bench/src/run.js';
import { DEFAULT_ADAPTER } from '../src/cli/adapter.js';
import { RERANK_K_INIT, RERANK_MODEL_ID } from '../src/config.js';

describe('serving defaults — the measured champion arm', () => {
  it('serves the adapter the bench measures, so the two cannot drift apart', () => {
    expect(DEFAULT_ADAPTER).toBe(BENCH_DEFAULT_ADAPTER);
  });

  it('reranks with the champion cross-encoder', () => {
    expect(RERANK_MODEL_ID).toBe('qwen3-reranker-4b');
  });

  it('floors the rerank pool at the champion depth', () => {
    expect(RERANK_K_INIT).toBe(100);
  });
});
