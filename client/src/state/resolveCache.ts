/**
 * Per-edition direct-link resolution cache.
 *
 * Keyed by the canonical (decoded) edition key. Writes and reads are mirrored
 * in an in-memory `Map` so a click can hit a fresh result synchronously;
 * IndexedDB persistence makes repeat visits and deep-link hard refreshes
 * instant. Entries older than {@link RESOLVE_CACHE_TTL} expire (the editor
 * clears them on boot via `clearStale`).
 */

import type { QualityRow } from "@shared/types";

import { CacheDB } from "./persistence";

const STORE = "resolve-cache" as const;

/** How long a resolved row set is trusted before re-resolving. */
export const RESOLVE_CACHE_TTL = 24 * 60 * 60 * 1000;

interface CacheEnvelope {
  rows: QualityRow[];
  timestamp: number;
}

/** In-memory mirror for synchronous reads on click. */
const memory = new Map<string, QualityRow[]>();

/** True when a fresh copy is available in the session mirror. */
export function hasCachedRows(key: string): boolean {
  return memory.has(key);
}

/** Rows for an edition key, or `null` on miss / stale / unavailable IDB. */
export async function getCachedRows(key: string): Promise<QualityRow[] | null> {
  const sessionHit = memory.get(key);
  if (sessionHit) return sessionHit;

  const db = CacheDB.getInstance();
  const entry = await db.get<CacheEnvelope>(STORE, key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > RESOLVE_CACHE_TTL) return null;

  memory.set(key, entry.rows);
  return entry.rows;
}

/** Persist rows for an edition (empty row sets are remembered, not stored). */
export async function cacheRows(
  key: string,
  rows: QualityRow[],
): Promise<void> {
  if (!rows.length) return;
  memory.set(key, rows);
  const db = CacheDB.getInstance();
  await db.set<CacheEnvelope>(STORE, key, {
    rows,
    timestamp: Date.now(),
  });
}