/**
 * TVMaze metadata client for CineDirect.
 *
 * Fetches show metadata (summary, genres, year, rating, network, poster)
 * from the TVMaze REST API. `getMeta` results are cached per show name;
 * both methods fail soft and resolve to `null` on any error or 404.
 */

import type { TvMazeMeta } from "@shared/types";

import { stripHtml } from "../core/parsing";
import { withRevalidation } from "../state/persistence";

/* ------------------------------------------------------------------ */
/*  Constants & types                                                  */
/* ------------------------------------------------------------------ */

const TVMAZE_TIMEOUT = 10000;

const SHOW_URL = "https://api.tvmaze.com/singlesearch/shows?q=";
const SEARCH_URL = "https://api.tvmaze.com/search/shows?q=";

/** Canonical shape of a TVMaze show object. */
interface TvMazeShow {
  name: string;
  premiered?: string | null;
  summary?: string | null;
  image?: { medium?: string | null; original?: string | null } | null;
  rating?: { average?: number | null } | null;
  network?: { name?: string | null } | null;
  genres?: string[];
}

/** Shape of one `/search/shows` result item. */
interface TvMazeSearchHit {
  score: number;
  show: TvMazeShow;
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

/** Force a `http://` poster URL onto `https://`. */
function normalizeUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^http:\/\//i, "https://");
}

/** Normalise a show name for use as a cache key. */
function cacheKey(name: string): string {
  return (name || "").trim().toLowerCase();
}

/** Map a TVMaze show object onto the shared {@link TvMazeMeta} shape. */
function mapMeta(show: TvMazeShow): TvMazeMeta {
  return {
    poster: normalizeUrl(show.image?.original ?? show.image?.medium ?? null),
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
 * Client for the TVMaze REST API.
 *
 * - {@link getMeta} fetches a single show via `singlesearch` and caches
 *   the parsed {@link TvMazeMeta} (including a cached `null` miss).
 * - {@link getPoster} searches all shows and returns the best match's
 *   poster URL without touching the metadata cache.
 */
export class TvMazeClient {
  private cache: Map<string, TvMazeMeta | null>;
  private posterCache: Map<string, string | null>;

  constructor() {
    this.cache = new Map();
    this.posterCache = new Map();
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

  /** Search all shows by name and return the best match's poster URL. */
  async getPoster(name: string): Promise<string | null> {
    const key = cacheKey(name);
    if (this.posterCache.has(key)) return this.posterCache.get(key)!;

    const poster = await withRevalidation<string | null>(
      "poster-cache",
      `tv:${key}`,
      async () => {
        try {
          const res = await fetchWithTimeout(
            SEARCH_URL + encodeURIComponent(name),
            TVMAZE_TIMEOUT,
          );
          if (!res.ok) return null;

          const data: unknown = await res.json();
          if (!Array.isArray(data) || data.length === 0) return null;

          // The API sorts results by relevance, so the first hit is the best.
          const best = data[0] as TvMazeSearchHit;
          return normalizeUrl(
            best.show?.image?.original ?? best.show?.image?.medium ?? null,
          );
        } catch {
          return null;
        }
      },
      7 * 24 * 60 * 60 * 1000,
      false,
    );
    this.posterCache.set(key, poster);
    return poster;
  }
}