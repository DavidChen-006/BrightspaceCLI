/**
 * Bounded fan-out with per-item failure isolation (PRD 9: "half the data beats none").
 * Results come back in input order; a failing item records its error and never aborts the
 * others. The pool itself never throws.
 */

export type PoolResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function boundedPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
