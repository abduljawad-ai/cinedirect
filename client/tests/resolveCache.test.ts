import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheDB } from '../src/state/persistence';
import {
  cacheRows,
  getCachedRows,
  hasCachedRows,
  RESOLVE_CACHE_TTL,
} from '../src/state/resolveCache';
import type { QualityRow } from '@shared/types';

const ROW: QualityRow = {
  quality: '1080P',
  direct: 'https://pub-a.r2.dev/a.mkv',
  size: 1024,
  hostTag: 'R2',
};

describe('resolveCache', () => {
  const db = CacheDB.getInstance();

  beforeEach(async () => {
    await db.clearAll();
  });

  it('round-trips rows through the in-memory mirror and IndexedDB', async () => {
    await cacheRows('movie|1080p', [ROW]);
    expect(hasCachedRows('movie|1080p')).toBe(true);
    expect(await getCachedRows('movie|1080p')).toEqual([ROW]);

    const stored = await db.get<{ rows: QualityRow[]; timestamp: number }>(
      'resolve-cache',
      'movie|1080p',
    );
    expect(stored?.rows).toEqual([ROW]);
  });

  it('returns null for unknown editions', async () => {
    expect(await getCachedRows('missing-key')).toBeNull();
    expect(hasCachedRows('missing-key')).toBe(false);
  });

  it('does not store empty row sets', async () => {
    await cacheRows('empty-ed', []);
    expect(hasCachedRows('empty-ed')).toBe(false);
    expect(await getCachedRows('empty-ed')).toBeNull();
  });

  it('treats stale expired entries as misses', async () => {
    // Written straight into IDB (bypassing the session mirror) so the stale
    // envelope is the only source for this key.
    await db.set('resolve-cache', 'stale-key', {
      rows: [ROW],
      timestamp: Date.now() - RESOLVE_CACHE_TTL - 1000,
    });
    expect(await getCachedRows('stale-key')).toBeNull();
  });

  it('serves fresh persisted entries on a new session', async () => {
    // Simulates a reload: mirror is cold (no memory hit) but IDB has a fresh
    // copy written by the previous session.
    await db.set('resolve-cache', 'fresh-key', {
      rows: [ROW],
      timestamp: Date.now(),
    });
    expect(await getCachedRows('fresh-key')).toEqual([ROW]);
  });
});