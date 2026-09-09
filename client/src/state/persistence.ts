import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DB_NAME = "cinedirect";
const DB_VERSION = 1;

interface CacheSchema extends DBSchema {
  "api-cache": {
    key: string;
    value: { data: unknown; timestamp: number };
  };
  "poster-cache": {
    key: string;
    value: { url: string; timestamp: number };
  };
  "meta-cache": {
    key: string;
    value: { data: unknown; timestamp: number };
  };
}

export type StoreName = "api-cache" | "poster-cache" | "meta-cache";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * String-keyed IndexedDB cache with three stores.
 *
 * Raw values are stored/returned as-is; the timestamp envelope
 * (`{ data, timestamp }`) is managed by {@link withRevalidation}.
 */
export class CacheDB {
  private db: Promise<IDBPDatabase<CacheSchema>>;
  private static instance?: CacheDB;

  static getInstance(): CacheDB {
    if (!CacheDB.instance) {
      CacheDB.instance = new CacheDB();
    }
    return CacheDB.instance;
  }

  private constructor() {
    this.db = this.open();
  }

  private open(): Promise<IDBPDatabase<CacheSchema>> {
    return openDB<CacheSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("api-cache")) {
          db.createObjectStore("api-cache");
        }
        if (!db.objectStoreNames.contains("poster-cache")) {
          db.createObjectStore("poster-cache");
        }
        if (!db.objectStoreNames.contains("meta-cache")) {
          db.createObjectStore("meta-cache");
        }
      },
    });
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    try {
      const db = await this.db;
      const value = await db.get(store, key);
      // Distinguish a real `undefined` (miss) from a stored `null` miss so
      // caching negative lookups stays correct.
      if (value === undefined) return undefined;
      return value as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(store: StoreName, key: string, value: T): Promise<void> {
    try {
      const db = await this.db;
      await db.put(store, value as never, key);
    } catch {
      // IndexedDB unavailable (private mode, quota) — fail soft.
    }
  }

  /** Return all entries (with their keys) in a store. */
  async getAll<T>(store: StoreName): Promise<Array<{ key: string; value: T }>> {
    try {
      const db = await this.db;
      const keys = await db.getAllKeys(store);
      const values = await db.getAll(store);
      return keys.map((k, i) => ({ key: String(k), value: values[i] as T }));
    } catch {
      return [];
    }
  }

  /** Wipe every store (used by tests and the "clear cache" affordance). */
  async clearAll(): Promise<void> {
    try {
      const db = await this.db;
      for (const store of ["api-cache", "poster-cache", "meta-cache"] as const) {
        await db.clear(store);
      }
    } catch {
      // Fail soft.
    }
  }

  async delete(store: StoreName, key: string): Promise<void> {
    try {
      const db = await this.db;
      await db.delete(store, key);
    } catch {
      // Fail soft.
    }
  }

  async clearStale(store: StoreName, maxAgeMs: number): Promise<void> {
    try {
      const db = await this.db;
      const cutoff = Date.now() - maxAgeMs;
      const keys = await db.getAllKeys(store);
      for (const key of keys) {
        if (typeof key !== "string") continue;
        const value = await db.get(store, key);
        if (
          value &&
          (value as { timestamp?: number }).timestamp !== undefined
        ) {
          const ts = (value as { timestamp: number }).timestamp;
          if (typeof ts === "number" && ts < cutoff) {
            await db.delete(store, key);
          }
        }
      }
    } catch {
      // Fail soft.
    }
  }
}

export async function withRevalidation<T>(
  store: StoreName,
  key: string,
  fetcher: () => Promise<T>,
  maxAgeMs = 5 * 60 * 1000,
  revalidate = true,
): Promise<T> {
  const db = CacheDB.getInstance();
  const cached = await db.get<CacheEntry<T>>(store, key);

  if (cached) {
    const fresh = Date.now() - cached.timestamp < maxAgeMs;
    if (fresh || !revalidate) {
      return cached.data;
    }
    // Stale — serve cache now, revalidate in background.
    queueMicrotask(async () => {
      try {
        const freshData = await fetcher();
        await db.set<CacheEntry<T>>(store, key, {
          data: freshData,
          timestamp: Date.now(),
        });
      } catch {
        // Keep stale cache on revalidation failure.
      }
    });
    return cached.data;
  }

  const data = await fetcher();
  await db.set<CacheEntry<T>>(store, key, { data, timestamp: Date.now() });
  return data;
}
