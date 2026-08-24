/**
 * Ordered, one-at-a-time async iteration.
 *
 * Two callers need it and neither may use `Promise.all`: the timing harness
 * would measure N overlapping calls instead of N latencies, and the synthetic
 * corpus writer would dispatch 10 000 simultaneous `open` calls (EMFILE). It
 * lives here rather than in either module so the two cannot drift apart.
 */

/** Apply `fn` to each item in order, collecting the results. */
export const mapSequential = async <T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>
): Promise<readonly R[]> =>
  await items.reduce<Promise<readonly R[]>>(
    async (acc, item) => [...(await acc), await fn(item)],
    Promise.resolve([])
  );

/** Run `step` for indices `0..count-1` in order, collecting the results. */
export const sequential = async <T>(
  count: number,
  step: (index: number) => Promise<T>
): Promise<readonly T[]> =>
  await mapSequential(
    Array.from({ length: count }, (_unused, index) => index),
    step
  );
