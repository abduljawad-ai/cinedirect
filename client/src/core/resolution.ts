/**
 * Link resolution engine for CineDirect.
 *
 * Resolves hub wrapper links (hubcdn / hubdrive / hubcloud) down to their
 * bare direct file URLs and classifies raw direct URLs (R2, S3, GDrive,
 * Pixeldrain). Resolution is memoized per URL and mode-aware:
 *
 * - **local / relay** — hub wrappers resolve through `/api/resolve` (the
 *   Python server or Cloudflare relay): hubcdn's page fetch + base64 reurl
 *   decode, hubdrive's AJAX POST, and hubcloud's multi-hop chain all need a
 *   CORS-free server. Raw direct URLs resolve client-side in every mode.
 * - **static** — hubcdn is resolved in-browser via the r.jina.ai reader;
 *   hubdrive / hubcloud (server-side chains only) return null so the UI
 *   falls back to a "Via redirect" row.
 */

import type {
  AppMode,
  EditionGroup,
  HostKind,
  HubLink,
  Quality,
  QualityRow,
  ResolveBatchResponse,
  ResolvedLink,
  ResolveResponse,
} from "@shared/types";

import { HOST_TAGS, QUALITY_RANK } from "@shared/types";

/* ------------------------------------------------------------------ */
/*  Consts & helpers                                                   */
/* ------------------------------------------------------------------ */

/** Minimum spacing between r.jina.ai reader requests (ms). */
const READER_SPACING = 1100;

/** Maximum attempts per reader request before giving up. */
const READER_MAX_ATTEMPTS = 3;

/** Default timeout for a single reader fetch (ms). */
const READER_TIMEOUT = 25000;

/** Maximum URLs per batched /api/resolve request. */
const BATCH_MAX = 20;

/** Promise-style sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch wrapper that aborts after `ms` milliseconds. */
async function resolveFetch(
  url: string,
  ms: number,
  init?: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() =>
    clearTimeout(t),
  );
}

/**
 * Fetch a raw page through the public r.jina.ai reader.
 *
 * `X-Return-Format: html` is required so hubcdn's raw `<script>` block (the
 * one carrying `var reurl`) stays visible; plain markdown mangles it.
 */
function readerRequest(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch("https://r.jina.ai/" + encodeURIComponent(url), {
    headers: { "X-Return-Format": "html" },
    signal: ctl.signal,
  }).finally(() => clearTimeout(t));
}

/** Quality rank used for sorting; `-1` for unknown. */
function rankOf(q: Quality | null | undefined): number {
  if (!q) return -1;
  return QUALITY_RANK[q] ?? -1;
}

/** Classify a URL into a host family. */
function hostKindOf(url: string): HostKind {
  if (/hubcdn\.sbs\//.test(url)) return "hubcdn";
  if (/hubdrive\.tips\//.test(url)) return "hubdrive";
  if (/hubcloud\.(?:cx|ist)\//.test(url)) return "hubcloud";
  if (/\.r2\.cloudflarestorage\.com\//.test(url)) return "s3";
  if (
    /(?:video-downloads\.googleusercontent\.com|drive\.google\.com)\//.test(url)
  ) {
    return "gdrive";
  }
  if (/\.r2\.dev\//.test(url)) return "r2";
  if (/pixeldrain\.(?:com|dev)\//.test(url)) return "pixeldrain";
  if (/gofile\.io\/d\//.test(url)) return "gofile";
  return "unknown";
}

/** Display tag for a host, e.g. "HubCDN" or "Pixeldrain". */
export function hostTagOf(url: string): string {
  return HOST_TAGS[hostKindOf(url)];
}

/** Direct download URLs are handed out as-is (no proxy wrapping). */
export function directHref(url: string): string {
  return url;
}

/** Collect every distinct hub link in an edition, preserving order. */
export function editionHubs(edition: EditionGroup): HubLink[] {
  const seen = new Set<string>();
  const out: HubLink[] = [];
  for (const item of edition.items) {
    for (const hub of item.post.direct) {
      if (seen.has(hub.url)) continue;
      seen.add(hub.url);
      out.push(hub);
    }
  }
  return out;
}

/**
 * Extract the bare file URL from a hubcdn `dl/?link=...` wrapper URL.
 */
function unwrapDl(url: string): string {
  if (!url) return url;
  const m = /link=([^&]+)/.exec(url);
  if (!m) return url;
  let v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep as-is */
  }
  return v;
}

/** Extract the quality tier from a filename, if any. */
function simpleQuality(name: string): Quality | null {
  const m = /\b(480p|720p|1080p|2160p|4k)\b/i.exec(name || "");
  return m ? (m[1].toUpperCase() as Quality) : null;
}

/** Outcome of resolving every hub link for one edition. */
export interface ResolveResult {
  rows: QualityRow[];
  best: ResolvedLink | null;
  results: (ResolvedLink | null)[];
}

/** One hub link's live resolution status, kept in edition hub order. */
export type HubSlotStatus =
  | { hub: HubLink; status: "pending"; row: null }
  | { hub: HubLink; status: "done"; row: ResolvedLink | null };

/** Progress snapshot emitted while an edition's links are resolving. */
export interface EditionProgress {
  /** Fixed-length slot list aligned with the input hubs (order preserved). */
  slots: HubSlotStatus[];
  /** Deduped, quality-sorted rows produced so far. */
  rows: QualityRow[];
  /** Hubs still resolving (these render as skeleton slots). */
  pending: HubLink[];
}

function isPending(
  s: HubSlotStatus,
): s is Extract<HubSlotStatus, { status: "pending" }> {
  return s.status === "pending";
}

/* ------------------------------------------------------------------ */
/*  Resolver                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolves hub wrapper and raw direct URLs to direct file links.
 *
 * A `Resolver` is created per application mode and kept alive for the rest
 * of the session: it memoizes per-URL results and serializes reader
 * requests so r.jina.ai's free tier is never burst-fired.
 */
export class Resolver {
  /** Relay base URL (empty in local mode) — public metadata. */
  readonly relayUrl: string;

  /** Memo cache keyed by the source URL. */
  private memo = new Map<string, Promise<ResolvedLink | null>>();

  /** Serialized chain of reader requests (r.jina.ai rate limiting). */
  private readerQueue: Promise<unknown> = Promise.resolve();

  /** Timestamp of the last reader request, used for spacing. */
  private readerLast = 0;

  private readonly mode: AppMode;
  private readonly apiFn: (path: string) => string;

  constructor(opts: {
    mode: AppMode;
    relayUrl: string;
    apiFn: (path: string) => string;
  }) {
    this.mode = opts.mode;
    this.relayUrl = opts.relayUrl;
    this.apiFn = opts.apiFn;
  }

  /* --------------------------- core methods ------------------------- */

  /**
   * Resolve a single URL to its direct file link (memoized).
   *
   * Dispatch is by host pattern: hubcdn / hubdrive / hubcloud wrapper pages
   * resolve via the server (reader or `null` fallbacks in static mode);
   * every other URL is treated as a raw direct link.
   */
  resolveOne(url: string): Promise<ResolvedLink | null> {
    const mem = this.memo.get(url);
    if (mem) return mem;
    const p = (async () => {
      if (/hubcdn\.sbs\/file\//i.test(url)) return this.resolveHubcdn(url);
      if (/hubdrive\.tips\/file\//i.test(url)) return this.resolveHubdrive(url);
      if (/hubcloud\.(?:cx|ist)\/drive\//i.test(url))
        return this.resolveHubcloud(url);
      return this.resolveRaw(url);
    })();
    this.memo.set(url, p);
    return p;
  }

  /**
   * Resolve every hub link of an edition, deduplicate by direct URL, and
   * sort into display rows (best quality first).
   *
   * In local / relay modes, hub wrapper links are batched into one
   * `/api/resolve` request (a single rate-limit unit, ordered results);
   * in static mode every link resolves through the serialized reader queue.
   */
  async resolveHubs(
    hubs: HubLink[],
    _archiveUrl: string,
  ): Promise<ResolveResult> {
    const results = await this.resolveMany(hubs.map((h) => h.url));
    const withQuality = results.map((r, i) => {
      if (!r) return null;
      return r.quality ? r : { ...r, quality: hubs[i]?.quality ?? null };
    });
    return {
      rows: this.qualityRows(withQuality),
      best: this.bestOf(withQuality),
      results: withQuality,
    };
  }

  /**
   * Resolve many URLs, preserving the input order (duplicates are
   * resolved once and broadcast to every occurrence).
   *
   * Raw direct links (R2, GDrive, S3) always resolve client-side with zero
   * upstream network; hub wrapper links go through the batched `/api/resolve`
   * in local / relay modes and the serialized reader queue in static mode.
   */
  resolveMany(urls: string[]): Promise<(ResolvedLink | null)[]> {
    if (urls.length === 0) return Promise.resolve([]);
    const out = new Array<ResolvedLink | null>(urls.length).fill(null);
    const byUrl = new Map<string, number[]>();
    const unique: string[] = [];
    urls.forEach((u, i) => {
      const idx = byUrl.get(u);
      if (idx) idx.push(i);
      else {
        byUrl.set(u, [i]);
        unique.push(u);
      }
    });
    return this.resolveUnique(unique).then((resolved) => {
      resolved.forEach((r, k) => {
        for (const i of byUrl.get(unique[k])!) out[i] = r;
      });
      return out;
    });
  }

  /**
   * Resolve an edition's hub links in parallel (capped by `atOnce`), invoking
   * `onProgress` with the latest {@link EditionProgress} after every settled
   * link plus once up front with every slot still pending — so the detail view
   * can paint its skeleton rows immediately and fill them in as links land.
   *
   * `pending` carries the hubs that have not settled yet; a settled hub that
   * produced no link simply disappears (its gap is hidden by the rows that
   * dedupe around it). Returns the final deduped, quality-sorted rows.
   */
  async resolveEditionProgressive(
    hubs: HubLink[],
    onProgress: (p: EditionProgress) => void,
    atOnce = 6,
  ): Promise<QualityRow[]> {
    const slots: HubSlotStatus[] = hubs.map((hub) => ({
      hub,
      status: "pending",
      row: null,
    }));
    const emit = (): EditionProgress => ({
      slots: slots.slice(),
      rows: this.qualityRows(
        slots.map((s) => (s.status === "done" ? s.row : null)),
      ),
      pending: slots.filter(isPending).map((s) => s.hub),
    });

    // Skeleton-first: report the pending slots before any network talk so the
    // view paints placeholders on the very first tick.
    onProgress(emit());

    await this.mapPool(hubs, atOnce, async (hub, i) => {
      const r = await this.resolveOne(hub.url);
      slots[i] = {
        hub,
        status: "done",
        row: r ? (r.quality ? r : { ...r, quality: hub.quality ?? null }) : null,
      };
      onProgress(emit());
    });

    return this.qualityRows(
      slots.map((s) => (s.status === "done" ? s.row : null)),
    );
  }

  /** Run `fn` over `items` in parallel, capped at `atOnce` concurrent calls. */
  private async mapPool<T, R>(
    items: T[],
    atOnce: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const limit = Math.max(1, Math.min(atOnce, items.length));
    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i], i);
        }
      }),
    );
    return out;
  }

  /** Clear the URL memo cache (between searches / mode changes). */
  resetMemo(): void {
    this.memo.clear();
  }

  /* ------------------------- public utilities ----------------------- */

  /**
   * Fetch a raw page through the r.jina.ai reader.
   *
   * All reader requests share one serialized queue that guarantees at least
   * {@link READER_SPACING} ms between requests, retries HTTP 429 responses
   * with exponential backoff (1.5s x attempt), and gives up after
   * {@link READER_MAX_ATTEMPTS} attempts.
   */
  rawPageViaReader(url: string, timeout = READER_TIMEOUT): Promise<string> {
    const job = this.readerQueue.then(async () => {
      const wait = this.readerLast
        ? READER_SPACING - (Date.now() - this.readerLast)
        : 0;
      if (wait > 0) await sleep(wait);
      this.readerLast = Date.now();
      for (let attempt = 0; attempt < READER_MAX_ATTEMPTS; attempt++) {
        try {
          const rr = await readerRequest(url, timeout);
          if (rr.status === 429) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          if (!rr.ok) return "";
          return await rr.text();
        } catch {
          if (attempt < READER_MAX_ATTEMPTS - 1) await sleep(700);
        }
      }
      return "";
    });
    this.readerQueue = job.catch(() => {});
    return job;
  }

  /** Pixeldrain file metadata (size, filename, quality). */
  async pixInfo(id: string): Promise<{
    size: number | null;
    filename: string;
    quality: Quality | null;
  }> {
    let size: number | null = null;
    let filename = "";
    try {
      const r = await resolveFetch(
        "https://pixeldrain.dev/api/file/" + id + "/info",
        10000,
      );
      if (r.ok) {
        const info = (await r.json()) as { name?: string; size?: number };
        if (info && info.name) {
          filename = info.name;
          size = info.size && info.size > 0 ? info.size : null;
        }
      }
    } catch {
      /* the row still works, just without extras */
    }
    return { size, filename, quality: simpleQuality(filename) };
  }

  /** Display tag for a resolved link's host. */

  /**
   * Dedupe resolved links by their direct URL and sort into display rows,
   * best quality first.
   */
  qualityRows(results: (ResolvedLink | null)[]): QualityRow[] {
    const seen = new Set<string>();
    const out: QualityRow[] = [];
    for (const r of results) {
      if (!r || !r.direct) continue;
      if (seen.has(r.direct)) continue;
      seen.add(r.direct);
      out.push({
        quality: r.quality,
        direct: r.direct,
        size: r.size,
        hostTag: hostTagOf(r.direct),
      });
    }
    return out.sort((a, b) => rankOf(b.quality) - rankOf(a.quality));
  }

  /** Highest-quality resolved link, or null. */
  bestOf(results: (ResolvedLink | null)[]): ResolvedLink | null {
    let best: ResolvedLink | null = null;
    for (const r of results) {
      if (!r || !r.direct) continue;
      if (!best || rankOf(r.quality) > rankOf(best.quality)) best = r;
    }
    return best;
  }

  /* ------------------------- private resolvers ---------------------- */

  /** True when a URL is a hub wrapper (resolves server-side / via reader). */
  private isHubWrapper(url: string): boolean {
    return (
      /hubcdn\.sbs\/file\//i.test(url) ||
      /hubdrive\.tips\/file\//i.test(url) ||
      /hubcloud\.(?:cx|ist)\/drive\//i.test(url)
    );
  }

  /** Resolve a de-duplicated list of URLs, preserving order. */
  private async resolveUnique(
    urls: string[],
  ): Promise<(ResolvedLink | null)[]> {
    if (urls.length === 0) return [];
    const out = new Array<ResolvedLink | null>(urls.length).fill(null);

    // Raw direct links (R2 / GDrive / S3 / Pixeldrain) never touch the server.
    const rawIdx: number[] = [];
    const wrapIdx: number[] = [];
    urls.forEach((u, i) => (this.isHubWrapper(u) ? wrapIdx : rawIdx).push(i));

    const rawResults = await this.resolveEach(rawIdx.map((i) => urls[i]));
    rawResults.forEach((r, k) => {
      out[rawIdx[k]] = r;
    });

    if (wrapIdx.length === 0) return out;

    // Hub wrappers: batched API call (local/relay) or per-URL resolution.
    const wrapped = wrapIdx.map((i) => urls[i]);
    let results: (ResolvedLink | null)[];
    if (this.mode === "static" || wrapped.length === 1) {
      results = await this.resolveEach(wrapped);
    } else {
      results = await this.batchViaApi(wrapped);
    }
    results.forEach((r, k) => {
      out[wrapIdx[k]] = r;
    });
    return out;
  }

  /** Resolve URLs one at a time through the memoized per-URL resolver. */
  private resolveEach(urls: string[]): Promise<(ResolvedLink | null)[]> {
    return Promise.all(urls.map((u) => this.resolveOne(u)));
  }

  /**
   * Resolve hub wrapper URLs through a single batched `/api/resolve` POST
   * (chunked at {@link BATCH_MAX} per request). Any API failure falls back
   * to per-URL resolution so a broken relay never blanks the UI. Results are
   * memoized per URL.
   */
  private async batchViaApi(
    urls: string[],
  ): Promise<(ResolvedLink | null)[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < urls.length; i += BATCH_MAX) {
      chunks.push(urls.slice(i, i + BATCH_MAX));
    }
    const out = new Array<ResolvedLink | null>(urls.length).fill(null);
    try {
      await Promise.all(
        chunks.map(async (chunk, ci) => {
          const r = await resolveFetch(this.apiFn("/api/resolve"), 60000, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: chunk }),
          });
          if (!r.ok) throw new Error("batch resolve status " + r.status);
          const data = (await r.json()) as ResolveBatchResponse;
          if (
            !data ||
            !Array.isArray(data.results) ||
            data.results.length !== chunk.length
          ) {
            throw new Error("malformed batch resolve payload");
          }
          data.results.forEach((res, i) => {
            const idx = ci * BATCH_MAX + i;
            if (res) out[idx] = res as ResolvedLink;
          });
        }),
      );
    } catch {
      const fallback = await this.resolveEach(urls);
      fallback.forEach((r, i) => {
        out[i] = r;
      });
    }
    urls.forEach((u, i) => {
      this.memo.set(u, Promise.resolve(out[i]));
    });
    return out;
  }

  private resolveHubcdn(url: string): Promise<ResolvedLink | null> {
    if (this.mode === "static") return this.resolveHubcdnStatic(url);
    return this.resolveViaApi(url);
  }

  private resolveHubdrive(url: string): Promise<ResolvedLink | null> {
    if (this.mode === "static") return Promise.resolve(null);
    return this.resolveViaApi(url);
  }

  private resolveHubcloud(url: string): Promise<ResolvedLink | null> {
    if (this.mode === "static") return Promise.resolve(null);
    return this.resolveViaApi(url);
  }

  /** Ask the server / relay to resolve a hub wrapper URL. */
  private async resolveViaApi(url: string): Promise<ResolvedLink | null> {
    try {
      const r = await resolveFetch(
        this.apiFn("/api/resolve?url=" + encodeURIComponent(url)),
        45000,
      );
      if (!r.ok) return null;
      const data = (await r.json()) as ResolveResponse;
      return data && data.direct ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Client-side hubcdn.sbs/file resolution via the r.jina.ai reader:
   * page -> `var reurl` -> base64 `r=` param (or dl wrapper) -> bare URL.
   */
  private async resolveHubcdnStatic(url: string): Promise<ResolvedLink | null> {
    let html = "";
    try {
      html = await this.rawPageViaReader(url);
    } catch {
      return null;
    }
    const m = /var\s+reurl\s*=\s*"([^"]+)"/s.exec(html);
    if (!m) return null;
    const reurl = m[1].replace(/\\\//g, "/");

    let wrapper: string | null = null;
    const rb = /[?&]r=([A-Za-z0-9+/=_-]+)/.exec(reurl);
    if (rb) {
      try {
        const b64 = rb[1];
        const pad = (4 - (b64.length % 4)) % 4;
        wrapper = atob(
          b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad),
        );
      } catch {
        wrapper = null;
      }
    } else if (reurl.includes("hubcdn.sbs/dl/")) {
      wrapper = reurl;
    }

    if (wrapper && wrapper.includes("hubcdn.sbs/dl/")) {
      const dl = unwrapDl(wrapper);
      const px = dl.match(/pixeldrain\.(?:com|dev)\/api\/file\/([A-Za-z0-9]+)/);
      if (px) {
        const info = await this.pixInfo(px[1]);
        return {
          direct: dl,
          size: info.size,
          filename: info.filename,
          quality: info.quality,
        };
      }
      return { direct: dl, size: null, filename: null, quality: null };
    }
    return null;
  }

  /**
   * URLs that are already the direct file link need no wrapper decode —
   * return them as-is (Pixeldrain `/u/` pages become `/api/file/` first;
   * GDrive, S3 presigned, and R2 buckets pass straight through).
   */
  private async resolveRaw(url: string): Promise<ResolvedLink | null> {
    const pu = /pixeldrain\.(?:com|dev)\/u\/([A-Za-z0-9]+)/.exec(url);
    if (pu) {
      const info = await this.pixInfo(pu[1]);
      return {
        direct: "https://pixeldrain.dev/api/file/" + pu[1],
        size: info.size,
        filename: info.filename,
        quality: info.quality,
      };
    }
    const papi = /pixeldrain\.(?:com|dev)\/api\/file\/([A-Za-z0-9]+)/.exec(url);
    if (papi) {
      const info = await this.pixInfo(papi[1]);
      return {
        direct: "https://pixeldrain.dev/api/file/" + papi[1],
        size: info.size,
        filename: info.filename,
        quality: info.quality,
      };
    }
    if (
      /(?:video-downloads\.googleusercontent\.com|drive\.google\.com)\//.test(
        url,
      )
    ) {
      return { direct: url, size: null, filename: null, quality: null };
    }
    if (
      /(?:\.r2\.cloudflarestorage\.com|pub-[0-9a-f]+\.r2\.dev|\.r2\.dev)\//.test(
        url,
      )
    ) {
      return { direct: url, size: null, filename: null, quality: null };
    }
    if (/gofile\.io\/d\//.test(url)) return null;
    return null;
  }
}
