/**
 * Wikipedia poster client for CineDirect.
 *
 * Posters are resolved entirely from Wikipedia (no TMDB, no TVMaze, no
 * CineDirect API). Genuine poster key-art is *portrait* (2:3), but a
 * Wikipedia article's lead image is often a landscape title card or cast
 * photo instead, so every candidate is accepted only when it is
 * portrait-shaped; anything else is skipped rather than shown as a wrong
 * "poster".
 *
 * Resolution per show:
 *  1. Try a short ladder of search variants (`{name} {year} film`, `{name}
 *     film`, `{name} TV series`, `{name}`).
 *  2. In each variant, rank the hits with {@link pickRanked}; skip
 *     disambiguation pages; evaluate the best real article.
 *  3. Keep the article's lead image **only if portrait**.
 *
 * All lookups are cached per (name, year) — including `null` misses — and
 * every failure resolves to `null` instead of throwing.
 */

/* ------------------------------------------------------------------ */
/*  Constants & types                                                  */
/* ------------------------------------------------------------------ */

import { withRevalidation } from "../state/persistence";

const WIKI_TIMEOUT = 10000;

const SEARCH_API =
  "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&origin=*&srlimit=10&srsearch=";

/** Lead image + page flags (is the page a disambiguation page?) in one call. */
const PAGE_API =
  "https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|pageprops&format=json&formatversion=2&origin=*&redirects=1&pithumbsize=600&ppprop=disambiguation&titles=";

/** A single hit from the Wikipedia full-text search API. */
interface WikiSearchResponse {
  query?: { search?: Array<{ title: string }> };
}

/** Page lookup carrying the lead image thumbnail and the dab flag. */
interface WikiPageResponse {
  query?: {
    pages?: Array<{
      pageprops?: { disambiguation?: string };
      thumbnail?: { source?: string; width?: number; height?: number };
    }>;
  };
}

/** Title markers that indicate a hit is not a proper article. */
const NON_ARTICLE_RE =
  /\b(?:list of|category|disambiguation|wikidata|template|file|wikipedia|index)\b/i;

/** Suffix of a well-formed film / TV article. */
const ARTICLE_SUFFIX_RE = /\((?:film|television series|tv series)\)$/;

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

/** Normalise a string for title matching (lowercase, alphanumeric tokens). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Strip any query string (Wikipedia may append tracking params). */
export function cleanImageUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  const fragment = hashIdx === -1 ? "" : url.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const queryIdx = beforeHash.indexOf("?");
  const base = queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx);
  return base + fragment;
}

/**
 * A poster candidate is genuine key-art only when it is portrait-shaped
 * (taller than wide). Title cards, logos and cast photos are landscape or
 * square, so they are rejected here.
 */
export function isPortraitish(
  width: number | undefined,
  height: number | undefined,
): boolean {
  if (!width || !height) return false;
  return height > width;
}

/* ------------------------------------------------------------------ */
/*  Article selection                                                  */
/* ------------------------------------------------------------------ */

/** Score a single search hit against the requested `name`. */
function scoreHit(title: string, target: string): number {
  const t = normalize(title);
  if (!t) return 0;

  let score = 0;

  // Skip list / category / disambiguation / metadata pages.
  if (NON_ARTICLE_RE.test(title)) score -= 500;

  // Exact match wins outright; partial title overlap scores less.
  if (t === target) score += 200;
  else if (t.startsWith(target)) score += 80;
  else if (target.startsWith(t)) score += 60;

  // A proper film / TV article suffix confirms a well-formed article.
  if (ARTICLE_SUFFIX_RE.test(title.toLowerCase())) score += 40;

  // Token overlap bonus.
  const targetTokens = new Set(target.split(/\s+/).filter(Boolean));
  const hitTokens = new Set(t.split(/\s+/).filter(Boolean));
  for (const tok of targetTokens) {
    if (hitTokens.has(tok)) score += 10;
  }

  return score;
}

/**
 * Rank search hits against `name`, best first. Only hits scoring above zero
 * are returned; scoring favours exact / prefix title matches, penalises
 * list/category/disambiguation pages, and rewards `(film)` / `(TV series)`
 * suffixes.
 *
 * @example
 * ```ts
 * pickRanked([{ title: "Silo (TV series)" }, { title: "Silo (disambiguation)" }], "Silo")
 * // => ["Silo (TV series)"]
 * ```
 */
export function pickRanked(
  hits: Array<{ title: string }>,
  name: string,
): string[] {
  const target = normalize(name);
  return hits
    .map((h) => ({ title: h?.title ?? "", score: scoreHit(h?.title ?? "", target) }))
    .filter((h) => h.title && h.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((h) => h.title);
}

/**
 * Pick the single best search hit for `name` (the head of {@link pickRanked}).
 *
 * Returns an empty `title` when no candidate scores above zero.
 *
 * @example
 * ```ts
 * pickArticle([{ title: "Silo (TV series)" }, { title: "Silo (disambiguation)" }], "Silo")
 * // => { title: "Silo (TV series)" }
 * ```
 */
export function pickArticle(
  hits: Array<{ title: string }>,
  name: string,
): { title: string } {
  return { title: pickRanked(hits, name)[0] ?? "" };
}

/* ------------------------------------------------------------------ */
/*  WikipediaClient                                                    */
/* ------------------------------------------------------------------ */

/**
 * Client for the English Wikipedia API. {@link getPoster} resolves a show
 * to an article, then to its portrait lead image (if any).
 */
export class WikipediaClient {
  private cache: Map<string, string | null>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Fetch a poster URL for `name`, optionally disambiguated by its release
   * `year`. Only portrait key-art is returned — landscape title cards are
   * discarded — and only Wikipedia is consulted.
   */
  async getPoster(name: string, year?: string): Promise<string | null> {
    // `wiki2:` key prefix: the pipeline no longer serves the landscape
    // Wikipedia "title card" thumbnails cached by older builds, so cached
    // URLs are versioned (old entries are pruned by the boot `clearStale`).
    const key = `wiki2:${name}|${year ?? ""}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const poster = await withRevalidation<string | null>(
      "poster-cache",
      key,
      async () => {
        for (const variant of this.variantsFor(name, year)) {
          const ranked = await this.searchRanked(variant, name);
          for (const title of ranked) {
            const page = await this.pageInfo(title);
            // Disambiguation pages end up titled "Reacher" and must never
            // supply a poster — try the next-best hit of this variant.
            if (page.disambiguation) continue;

            // Real article found: accept only a portrait lead image, then
            // move on to the next search variant.
            if (
              page.thumbnail &&
              isPortraitish(page.thumbnail.width, page.thumbnail.height)
            ) {
              return cleanImageUrl(page.thumbnail.source ?? "");
            }
            break;
          }
        }
        return null;
      },
      7 * 24 * 60 * 60 * 1000,
      false, // serve from cache indefinitely; clearStale() evicts on boot.
    );
    this.cache.set(key, poster);
    return poster;
  }

  /** Ordered list of search queries to try for a name + optional year. */
  private variantsFor(name: string, year?: string): string[] {
    const n = (name || "").trim();
    const variants: string[] = [];
    if (year) variants.push(`${n} ${year} film`);
    variants.push(`${n} film`, `${n} TV series`, n);
    return variants;
  }

  /** Search one variant and return its best-matching titles, best first. */
  private async searchRanked(query: string, name: string): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(
        SEARCH_API + encodeURIComponent(query),
        WIKI_TIMEOUT,
      );
      if (!res.ok) return [];

      const data = (await res.json()) as WikiSearchResponse;
      return pickRanked(data?.query?.search ?? [], name);
    } catch {
      return [];
    }
  }

  /**
   * Head-of-article metadata in one request: the lead image thumbnail and
   * whether the page is a disambiguation page.
   */
  private async pageInfo(
    title: string,
  ): Promise<{
    thumbnail: { source?: string; width?: number; height?: number } | null;
    disambiguation: boolean;
  }> {
    try {
      const res = await fetchWithTimeout(
        PAGE_API + encodeURIComponent(title),
        WIKI_TIMEOUT,
      );
      if (!res.ok) return { thumbnail: null, disambiguation: false };

      const data = (await res.json()) as WikiPageResponse;
      const page = data?.query?.pages?.[0];
      return {
        thumbnail: page?.thumbnail ?? null,
        disambiguation: Boolean(page?.pageprops?.disambiguation),
      };
    } catch {
      return { thumbnail: null, disambiguation: false };
    }
  }
}