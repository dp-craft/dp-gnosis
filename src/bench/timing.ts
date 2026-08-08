/**
 * Timing and heap sampling, with the methodology attached to the numbers.
 *
 * A single sample is not a latency claim, so every measurement carries its
 * `warmupIterations` / `measuredIterations` / `samples` alongside p50 and p95,
 * and the report prints them. Warmup passes are discarded: the first call
 * through a code path pays JIT and filesystem-cache cost that the steady state
 * does not.
 *
 * The population is per-CALL, not per-pass: one pass runs every query thunk
 * once, and the durations of ALL calls across all measured passes form the
 * distribution. Averaging a pass first would erase the tail that p95 exists to
 * show.
 *
 * Heap is `process.memoryUsage().heapUsed` sampled immediately AFTER each
 * measured call — a peak over discrete post-call samples, not a continuous
 * profile, and it is not GC-controlled. It bounds what a caller retains between
 * calls; it MUST NOT be read as an allocation total.
 */
import { sequential } from './sequential.js';

/** How many passes are thrown away, and how many are kept. */
export interface TimingPolicy {
  readonly warmupIterations: number;
  readonly measuredIterations: number;
}

/** One measured distribution plus the methodology that produced it. */
export interface TimingSample {
  readonly samples: number;
  readonly warmupIterations: number;
  readonly measuredIterations: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly peakHeapBytes: number;
}

/** One unit of work to time. Its return value is deliberately ignored. */
export type Thunk = () => Promise<unknown>;

/** A duration paired with the value the timed call produced. */
export interface Timed<T> {
  readonly ms: number;
  readonly value: T;
}

const NOOP: Thunk = () => Promise.resolve(undefined);

const P50 = 0.5;
const P95 = 0.95;
const MINIMUM = 0;
const MAXIMUM = 1;

interface Observation {
  readonly ms: number;
  readonly heapBytes: number;
}

/** Time one call and produce its value — for one-shot costs (index build). */
export const timeValue = async <T>(fn: () => Promise<T>): Promise<Timed<T>> => {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
};

const observe = async (thunk: Thunk): Promise<Observation> => {
  const start = performance.now();
  await thunk();
  return { ms: performance.now() - start, heapBytes: process.memoryUsage().heapUsed };
};

const runPass = async (thunks: readonly Thunk[]): Promise<readonly Observation[]> =>
  await sequential(thunks.length, index => observe(thunks[index] ?? NOOP));

/** Nearest-rank percentile over an ASCENDING array; 0 for an empty population. */
export const percentile = (ascending: readonly number[], fraction: number): number => {
  const rank = Math.ceil(fraction * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return ascending[index] ?? 0;
};

const summarize = (
  observations: readonly Observation[],
  policy: TimingPolicy
): TimingSample => {
  const ascending = observations.map(o => o.ms).sort((a, b) => a - b);
  return {
    samples: ascending.length,
    warmupIterations: policy.warmupIterations,
    measuredIterations: policy.measuredIterations,
    p50Ms: percentile(ascending, P50),
    p95Ms: percentile(ascending, P95),
    minMs: percentile(ascending, MINIMUM),
    maxMs: percentile(ascending, MAXIMUM),
    peakHeapBytes: observations.reduce((peak, o) => Math.max(peak, o.heapBytes), 0),
  };
};

/** Warm up, then measure every thunk `measuredIterations` times, in order. */
export const measureAll = async (
  thunks: readonly Thunk[],
  policy: TimingPolicy
): Promise<TimingSample> => {
  await sequential(policy.warmupIterations, () => runPass(thunks));
  const passes = await sequential(policy.measuredIterations, () => runPass(thunks));
  return summarize(passes.flat(), policy);
};
