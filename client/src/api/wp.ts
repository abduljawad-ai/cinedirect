/**
 * WordPress REST API client for hblinks.co.
 *
 * Fetches posts from the WP REST API, strips HTML from titles, and
 * extracts classified hub links (with nearest quality labels) plus every
 * raw link from the post body.
 *
 * All methods fail soft: network errors, timeouts, and malformed payloads
 * resolve to empty results instead of throwing.
 */

import type { HostKind, HubLink, Post, Quality, RawPost } from "@shared/types";

import { stripHtml } from "../core/parsing";
import { withRevalidation } from "../state/persistence";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const WP_SEARCH_URL = "https://hblinks.co/wp-json/wp/v2/posts";

/** Default page size for a single posts request. */
const DEFAULT_PER_PAGE = 100;

/** Default request timeout (ms). */
const DEFAULT_TIMEOUT = 15000;

/** Quality-tier tokens as they appear in post copy / link anchor text. */
const QUALITY_RE = /\b(2160p|4k|1080p|720p|480p|360p)\b/gi;

/** How far around a link a quality label is still considered "theirs" (chars). */
const QUALITY_WINDOW = 120;

/**
 * Host classifications. Each family is matched by a single regex against
 * the full URL; the first pattern to win decides the {@link HostKind}.
 */
const HOST_PATTERNS: ReadonlyArray<{ kind: HostKind; re: RegExp }> = [
  { kind: "hubcdn", re: /hubcdn\.sbs\//i },
  { kind: "hubdrive", re: /hubdrive\.tips\//i },
  { kind: "hubcloud", re: /hubcloud\.(?:cx|ist)\//i },
  { kind: "r2", re: /\.r2\.dev\//i },
  { kind: "gdrive", re: /(?:video-downloads\.googleusercontent\.com|drive\.google\.com)\//i },
  { kind: "s3", re: /\.r2\.cloudflarestorage\.com\//i },
  { kind: "pixeldrain", re: /pixeldrain\.(?:com|dev)\//i },
  { kind: "gofile", re: /gofile\.io\/d\//i },
];

/** Anchor `href` attribute, double- or single-quoted. */
const HREF_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/* ------------------------------------------------------------------ */
/*  Client options                                                     */
/* ------------------------------------------------------------------ */

interface WpClientOptions {
  perPage?: number;
  timeout?: number;
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

/** Classify a URL into a host family by matching every host pattern. */
function classifyHost(url: string): HostKind {
  for (const p of HOST_PATTERNS) {
    if (p.re.test(url)) return p.kind;
  }
  return "unknown";
}

/** Dedupe an array of strings, preserving first-seen order. */
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Dedupe hub links by URL, preserving first-seen order. */
function uniqueHubs(hubs: HubLink[]): HubLink[] {
  const seen = new Set<string>();
  const out: HubLink[] = [];
  for (const h of hubs) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
  }
  return out;
}

/**
 * Decode HTML character references.
 *
 * Uses the browser's DOM parser when available; falls back to a manual
 * replacement for non-browser environments (SSR, tests).
 */
function decodeEntities(s: string): string {
  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }
  return s
    .replace(/&#(\d+);/g, (_: string, d: string): string => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_: string, h: string): string => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Strip tags and decode entities from a rendered WP title. */
function cleanTitle(rendered: string): string {
  return decodeEntities(stripHtml(rendered));
}

/**
 * Find the quality label closest to a link's `<a>` tag.
 *
 * Scans a window of content around the tag (both before and after) and
 * returns the quality token with the smallest absolute distance to the
 * link's center, or `null` when the nearest token sits outside the window.
 */
function nearestQuality(
  content: string,
  linkStart: number,
  linkEnd: number,
): Quality | null {
  const winStart = Math.max(0, linkStart - QUALITY_WINDOW);
  const win = content.slice(winStart, linkEnd + QUALITY_WINDOW);
  const linkCenter = (linkStart + linkEnd) / 2;

  QUALITY_RE.lastIndex = 0;
  let best: Quality | null = null;
  let bestDist = Infinity;
  let m: RegExpExecArray | null;
  while ((m = QUALITY_RE.exec(win)) !== null) {
    const dist = Math.abs(winStart + m.index + m[0].length / 2 - linkCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = m[0].toUpperCase() as Quality;
    }
  }
  return bestDist <= QUALITY_WINDOW ? best : null;
}

/* ------------------------------------------------------------------ */
/*  extractLinks                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract and classify every link from rendered WP post content.
 *
 * - Every absolute `http(s)` href is collected into `all`.
 * - Links belonging to a known host family become hub links. `hubcdn`
 *   holds all classified hubs (hubcdn / hubdrive / hubcloud / r2 / gdrive
 *   / s3 / pixeldrain / gofile), each mapped to the nearest quality label.
 *
 * @example
 * ```ts
 * extractLinks(`<p>1080p <a href="https://hubcdn.sbs/file/x">Download</a></p>`)
 * // => { hubcdn: [{ url: "https://hubcdn.sbs/file/x", quality: "1080P", kind: "hubcdn" }], all: ["https://hubcdn.sbs/file/x"] }
 * ```
 */
export function extractLinks(contentRendered: string): {
  hubcdn: HubLink[];
  all: string[];
} {
  const content = typeof contentRendered === "string" ? contentRendered : "";
  const hubs: HubLink[] = [];
  const all: string[] = [];

  HREF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HREF_RE.exec(content)) !== null) {
    const url = (m[1] ?? m[2] ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;

    all.push(url);
    const kind = classifyHost(url);
    if (kind === "unknown") continue;

    hubs.push({
      url,
      kind,
      quality: nearestQuality(content, m.index, HREF_RE.lastIndex),
    });
  }

  return { hubcdn: uniqueHubs(hubs), all: unique(all) };
}

/* ------------------------------------------------------------------ */
/*  WpClient                                                           */
/* ------------------------------------------------------------------ */

/**
 * Client for the hblinks.co WordPress posts API.
 *
 * Fetches posts (optionally filtered by `search`), strips HTML from
 * titles, extracts hub links from the body, and returns enriched
 * {@link Post} objects. Any request failure resolves to an empty array.
 */
export class WpClient {
  private baseUrl: string;
  private perPage: number;
  private timeout: number;

  constructor(options?: WpClientOptions) {
    this.baseUrl = WP_SEARCH_URL;
    this.perPage = options?.perPage ?? DEFAULT_PER_PAGE;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Fetch posts from the WP REST API, enriched with extracted links. */
  async search(query?: string): Promise<Post[]> {
    const q = (query ?? "").trim();
    return withRevalidation<Post[]>(
      "api-cache",
      `wp:${q || "all"}`,
      async () => {
        try {
          const url = new URL(this.baseUrl);
          url.searchParams.set("per_page", String(this.perPage));
          url.searchParams.set("_fields", "id,title,link,date,content");
          if (q) url.searchParams.set("search", q);

          const res = await fetchWithTimeout(url.toString(), this.timeout);
          if (!res.ok) return [];

          const data: unknown = await res.json();
          if (!Array.isArray(data)) return [];

          return data.map((item): Post => {
            const rp = item as Partial<RawPost>;
            const { hubcdn: direct, all } = extractLinks(
              rp.content?.rendered ?? "",
            );
            return {
              id: rp.id ?? 0,
              title: cleanTitle(rp.title?.rendered ?? ""),
              link: rp.link ?? "",
              date: rp.date ?? "",
              direct,
              allLinks: all,
            };
          });
        } catch {
          return [];
        }
      },
      10 * 60 * 1000,
    );
  }
}