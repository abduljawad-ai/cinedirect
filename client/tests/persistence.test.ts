import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheDB, withRevalidation } from '../src/state/persistence';

describe('CacheDB', () => {
  const db = CacheDB.getInstance();

  beforeEach(async () => {
    await db.clearAll();
  });

  it('stores and reads values round-trip', async () => {
    await db.set('api-cache', 'k', { hello: 1 });
    const value = await db.get<{ hello: number }>('api-cache', 'k');
    expect(value).toEqual({ hello: 1 });
  });

  it('returns undefined for missing keys', async () => {
    expect(await db.get('api-cache', 'missing')).toBeUndefined();
  });

  it('preserves null-equivalent payloads (null misses)",', async () => {
    await db.set('meta-cache', 'nullish', null);
    expect(await db.get('meta-cache', 'nullish')).toBeNull();
  });

  it('deletes entries', async () => {
    await db.set('api-cache', 'gone', { x: 1 });
    await db.delete('api-cache', 'gone');
    expect(await db.get('api-cache', 'gone')).toBeUndefined();
  });

  it('clearStale removes only expired entries', async () => {
    await db.set('api-cache', 'old', { data: 1, timestamp: Date.now() - 999_999 });
    await db.set('api-cache', 'fresh', { data: 2, timestamp: Date.now() });
    await db.clearStale('api-cache', 60_000);
    expect(await db.get('api-cache', 'old')).toBeUndefined();
    expect(await db.get('api-cache', 'fresh')).toBeDefined();
  });
});

describe('withRevalidation', () => {
  const db = CacheDB.getInstance();

  beforeEach(async () => {
    await db.clearAll();
  });

  it('fetches and caches on first call', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return ['a'];
    };
    const first = await withRevalidation('api-cache', 'r1', fetcher);
    expect(first).toEqual(['a']);
    const second = await withRevalidation('api-cache', 'r1', fetcher);
    expect(second).toEqual(['a']);
    expect(calls).toBe(1);
  });

  it('serves fresh cache without calling fetcher', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 'v1';
    };
    await withRevalidation('api-cache', 'r2', fetcher);
    await withRevalidation('api-cache', 'r2', fetcher);
    expect(calls).toBe(1);
  });

  it('serves stale cache and revalidates in background when fresh treats data as stale', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 'v2';
    };
    // Write a stale entry directly.
    await db.set('api-cache', 'r3', {
      data: 'v1',
      timestamp: Date.now() - 100_000,
    });
    const value = await withRevalidation('api-cache', 'r3', fetcher, 60_000, true);
    expect(value).toBe('v1'); // stale served immediately
    // Background revalidation eventually lands.
    await new Promise((r) => setTimeout(r, 30));
    const updated = await db.get<{ data: string }>('api-cache', 'r3');
    expect(updated?.data).toBe('v2');
    expect(calls).toBe(1);
  });

  it('keeps stale cache forever when revalidate=false', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 'never';
    };
    await db.set('api-cache', 'r4', {
      data: 'v0',
      timestamp: Date.now() - 100_000,
    });
    const value = await withRevalidation('api-cache', 'r4', fetcher, 60_000, false);
    expect(value).toBe('v0');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
  });
});