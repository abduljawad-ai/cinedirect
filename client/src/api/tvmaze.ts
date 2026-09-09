/**
 * TVMaze metadata client for CineDirect.
 *
 * Fetches show metadata (summary, genres, year, rating, network) from the
 * TVMaze REST API. Posters are intentionally NOT sourced from TVMaze — they
 * come from Wikipedia/Wikidata via the show group. `getMeta` results are
 * cached per show name and every failure resolves to `null`.
 */

import type { TvMazeMeta } from "@shared/types";

import { stripHtml } from "../core/parsing";
import { withRevalidation } from "../state/persistence";

/* ------------------------------------------------------------------ */
/*  Constants & types                                                  */
/* ------------------------------------------------------------------ */

const TVMAZE_TIMEOUT = 10000;

const SHOW_URL = "https://api.tvmaze.com/singlesearch/shows?q=";

/** Canonical shape of a TVMaze show object. */
interface TvMazeShow {
  name: string;
  premiered?: string | null;
  summary?: string | null;
  rating?: { average?: number | null } | null;
  network?: { name?: string | null } | null;
  genres?: string[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Fetch wrapper that aborts after `ms` milliseconds. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Normalise a show name for use as a cache key. */
function cacheKey(name: string): string {
  return (name || "").trim().toLowerCase();
}

/** Map a TVMaze show object onto the shared {@link TvMazeMeta} shape. */
function mapMeta(show: TvMazeShow): TvMazeMeta {
  return {
    summary: stripHtml(show.summary ?? ""),
    genres: Array.isArray(show.genres) ? show.genres : [],
    year: show.premiered ? show.premiered.slice(0, 4) : "",
    rating: show.rating?.average ?? null,
    network: show.network?.name ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  TvMazeClient                                                       */
/* ------------------------------------------------------------------ */

/**
 * Client for the TVMaze REST API (text metadata only — posters come from
 * Wikipedia/Wikidata). {@link getMeta} fetches a single show via
 * `singlesearch` and caches the parsed {@link TvMazeMeta} (including a
 * cached `null` miss).
 */
export class TvMazeClient {
  private cache: Map<string, TvMazeMeta | null>;

  constructor() {
    this.cache = new Map();
  }

  /** Fetch metadata for a show by name (exact single-show lookup). */
  async getMeta(name: string): Promise<TvMazeMeta | null> {
    const key = cacheKey(name);
    if (this.cache.has(key)) return this.cache.get(key)!;

    const meta = await withRevalidation<TvMazeMeta | null>(
      "meta-cache",
      `tv:${key}`,
      async () => {
        try {
          const res = await fetchWithTimeout(
            SHOW_URL + encodeURIComponent(name),
            TVMAZE_TIMEOUT,
          );
          if (!res.ok) return null;
          const show = (await res.json()) as TvMazeShow;
          return mapMeta(show);
        } catch {
          return null;
        }
      },
      7 * 24 * 60 * 60 * 1000, // TVMaze metadata changes rarely.
      false, // serve from cache indefinitely; clearStale() evicts on boot.
    );
    this.cache.set(key, meta);
    return meta;
  }
}