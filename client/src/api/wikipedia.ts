/**
 * Wikipedia poster client for CineDirect.
 *
 * Locates a film / TV show's Wikipedia article through a short list of
 * search variants, picks the best-matching article title, and returns its
 * lead-image thumbnail URL.
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

const THUMB_API =
  "https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&formatversion=2&origin=*&redirects=1&pithumbsize=600&titles=";

/** A single hit from the Wikipedia full-text search API. */
interface WikiSearchResponse {
  query?: { search?: Array<{ title: string }> };
}

/** Page lookup response carrying the lead-image thumbnail. */
interface WikiThumbResponse {
  query?: { pages?: Array<{ title: string; thumbnail?: { source?: string } }> };
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

/* ------------------------------------------------------------------ */
/*  pickArticle                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pick the search result whose title best matches the requested `name`.
 *
 * Scoring favours exact / prefix title matches, penalises list, category,
 * and disambiguation pages, and rewards proper film / TV article suffixes:
 * - exact match          +200
 * - title starts with name / name starts with title   +80 / +60
 * - `(film)` / `(TV series)` suffix  +40
 * - shared title tokens  +10 each
 * - non-article markers  -500
 *
 * Returns an empty `title` when no hit scores above zero.
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
  const target = normalize(name);
  const targetTokens = target.split(/\s+/).filter(Boolean);

  let best = "";
  let bestScore = 0;

  for (const hit of hits) {
    const raw = hit?.title ?? "";
    const t = normalize(raw);
    if (!t) continue;

    let score = 0;

    // Skip list / category / disambiguation / metadata pages.
    if (NON_ARTICLE_RE.test(raw)) score -= 500;

    // Exact match wins outright; partial title overlap scores less.
    if (t === target) score += 200;
    else if (t.startsWith(target)) score += 80;
    else if (target.startsWith(t)) score += 60;

    // A proper film / TV article suffix confirms a well-formed article.
    if (ARTICLE_SUFFIX_RE.test(raw.toLowerCase())) score += 40;

    // Token overlap bonus.
    const tokens = new Set(
      t.split(/\s+/).filter(Boolean),
    );
    for (const tok of targetTokens) {
      if (tokens.has(tok)) score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      best = raw;
    }
  }

  return { title: bestScore > 0 ? best : "" };
}

/* ------------------------------------------------------------------ */
/*  WikipediaClient                                                    */
/* ------------------------------------------------------------------ */

/**
 * Client for the English Wikipedia Action API.
 *
 * {@link getPoster} tries a short list of search variants and returns the
 * first thumbnail that resolves, or `null` if none do.
 */
export class WikipediaClient {
  private cache: Map<string, string | null>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Fetch a poster thumbnail URL for `name`, optionally disambiguated by
   * its release `year`.
   *
   * Search variants tried, in order:
   * 1. `name` + `year` + "film"
   * 2. `name` + "film"
   * 3. `name` + "TV series"
   * 4. `name` alone
   */
  async getPoster(name: string, year?: string): Promise<string | null> {
    const key = `${name}|${year ?? ""}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const poster = await withRevalidation<string | null>(
      "poster-cache",
      `wiki:${key}`,
      async () => {
        for (const variant of this.variantsFor(name, year)) {
          const title = await this.searchBestTitle(variant, name);
          if (!title) continue;

          const thumb = await this.thumbnailFor(title);
          if (thumb) return thumb;
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
    const variants = [];
    if (year) variants.push(`${n} ${year} film`);
    variants.push(`${n} film`, `${n} TV series`, n);
    return variants;
  }

  /** Search one variant and return the best-matching article title. */
  private async searchBestTitle(query: string, name: string): Promise<string> {
    try {
      const res = await fetchWithTimeout(
        SEARCH_API + encodeURIComponent(query),
        WIKI_TIMEOUT,
      );
      if (!res.ok) return "";

      const data = (await res.json()) as WikiSearchResponse;
      const hits = data?.query?.search ?? [];
      if (hits.length === 0) return "";
      return pickArticle(
        hits.map((h) => ({ title: h.title })),
        name,
      ).title;
    } catch {
      return "";
    }
  }

  /** Fetch the lead-image thumbnail URL for an article title. */
  private async thumbnailFor(title: string): Promise<string | null> {
    try {
      const res = await fetchWithTimeout(
        THUMB_API + encodeURIComponent(title),
        WIKI_TIMEOUT,
      );
      if (!res.ok) return null;

      const data = (await res.json()) as WikiThumbResponse;
      const page = data?.query?.pages?.find((p) => p.thumbnail?.source);
      const source = page?.thumbnail?.source;
      if (!source) return null;
      return source.replace(/^http:\/\//i, "https://");
    } catch {
      return null;
    }
  }
}