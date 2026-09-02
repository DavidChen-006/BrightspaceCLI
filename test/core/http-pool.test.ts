import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedPool, type PoolResult } from '../../src/core/http/index.js';

test('boundedPool returns one result per item, in input order, isolating failures', async () => {
  const results = await boundedPool([1, 2, 3, 4], 2, async (n) => {
    if (n % 2 === 0) throw new Error(`even ${n}`);
    return n * 10;
  });
  assert.deepEqual(results, [
    { ok: true, value: 10 },
    { ok: false, error: new Error('even 2') },
    { ok: true, value: 30 },
    { ok: false, error: new Error('even 4') },
  ] satisfies PoolResult<number>[]);
});

test('boundedPool never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const results = await boundedPool(items, 3, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2 + (i % 3)));
    inFlight -= 1;
    return i;
  });
  assert.equal(peak, 3);
  assert.deepEqual(
    results.map((r) => (r.ok ? r.value : -1)),
    items,
  );
});

test('boundedPool passes the index, handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await boundedPool([], 4, async () => 1), []);
  const seen: number[] = [];
  await boundedPool(['a', 'b'], 100, async (_item, index) => {
    seen.push(index);
  });
  assert.deepEqual(seen.sort(), [0, 1]);
});

test('boundedPool treats a limit below 1 as 1 (sequential) and captures non-Error throws', async () => {
  const order: number[] = [];
  const results = await boundedPool([1, 2, 3], 0, async (n) => {
    order.push(n);
    if (n === 2) throw 'string failure';
    return n;
  });
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results[1], { ok: false, error: 'string failure' });
});

test('boundedPool never throws even when fn throws synchronously', async () => {
  const results = await boundedPool([1], 2, () => {
    throw new Error('sync');
  });
  assert.equal(results[0]?.ok, false);
});
