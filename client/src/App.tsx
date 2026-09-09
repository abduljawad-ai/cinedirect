import { h, Fragment } from "preact";
import { useEffect, useCallback, useRef } from "preact/hooks";
import { SearchBar } from "./components/SearchBar";
import { ResultsGrid } from "./components/ResultsGrid";
import { DetailView } from "./components/DetailView";
import { SkeletonCard } from "./components/SkeletonCard";
import { ToastContainer } from "./components/Toast";
import { HashRouter, parseHash } from "./routing/router";
import {
  groupsSignal,
  querySignal,
  loadingSignal,
  editionsSignal,
  currentKeySignal,
  toastsSignal,
  routeSignal,
  modeSignal,
  detailStateSignal,
  setResults,
  setLoading,
  setMode,
  setRoute,
  setDetailState,
  showToast,
  dismissToast,
} from "./state/store";
import { WpClient } from "./api/wp";
import { Resolver, editionHubs } from "./core/resolution";
import { groupByMovie, indexEditions, layOutGroup } from "./core/grouping";
import { WikipediaClient } from "./api/wikipedia";
import { TvMazeClient } from "./api/tvmaze";
import { CacheDB } from "./state/persistence";
import {
  cacheRows,
  getCachedRows,
  hasCachedRows,
  RESOLVE_CACHE_TTL,
} from "./state/resolveCache";
import { editionKeyOf } from "./core/parsing";
import type {
  ShowGroup,
  AppMode,
  EditionIndexEntry,
  HubLink,
  ReleaseItem,
} from "@shared/types";

/* ------------------------------------------------------------------ */
/*  Singletons                                                        */
/* ------------------------------------------------------------------ */

const wp = new WpClient();
const wikiClient = new WikipediaClient();
const tvMazeClient = new TvMazeClient();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Build the full URL for a CineDirect API path given the current mode. */
function apiFn(path: string): string {
  const m = modeSignal.value;
  if (m === "relay") {
    const relay = (import.meta.env.VITE_RELAY_URL ?? "").replace(/\/+$/, "");
    if (relay) return relay + path;
  }
  // local mode (and static fallback) hit the same-origin API path.
  return path;
}

/** Returns a Resolver matching the current mode (kept for the session). */
function getResolver(resolverRef: { current: Resolver | null }): Resolver {
  if (!resolverRef.current) {
    resolverRef.current = new Resolver({
      mode: modeSignal.value,
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
      apiFn,
    });
  }
  return resolverRef.current;
}

async function probeMode(): Promise<AppMode> {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
    if (r.ok) return "local";
  } catch {
    /* not local */
  }
  const relay = import.meta.env.VITE_RELAY_URL;
  if (relay) {
    try {
      const r = await fetch(`${relay}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) return "relay";
    } catch {
      /* relay down */
    }
  }
  return "static";
}

const CONCURRENCY = 4;

/** Best-effort poster fetch for every show group (Wikipedia → TVMaze). */
async function fetchPosters(groups: ShowGroup[]): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    while (i < groups.length) {
      const g = groups[i++];
      if (g.poster) continue;
      try {
        const url =
          (await wikiClient.getPoster(g.name, g.year)) ??
          (await tvMazeClient.getPoster(g.name));
        if (url) g.poster = url;
      } catch {
        /* poster fetch is best-effort */
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, groups.length) }, () => next()),
  );
}

/* ---- background link pre-resolution ------------------------------ */

/** How many card editions are pre-resolved after a search. */
const RESOLVE_PREFETCH_LIMIT = 12;

/** Parallel editions resolved at once during the background prefetch. */
const RESOLVE_PREFETCH_CONCURRENCY = 3;

/** ReleaseItems in the exact card render order used by ResultsGrid. */
function cardOrderItems(group: ShowGroup): ReleaseItem[] {
  const layout = layOutGroup(group);
  return [
    ...layout.seasonList.flatMap((b) => [...b.episodeItems, ...b.packItems]),
    ...layout.orphanEpisodes,
    ...layout.movies,
  ];
}

/**
 * Best-effort background resolution of the first `limit` card editions (in
 * render order). Clicking a pre-resolved card opens fully loaded — no wait —
 * because rows are written to the resolve-cache and shared with any in-flight
 * click through the resolver's per-URL memo. Direct links (R2/GDrive/S3)
 * resolve with zero upstream; hub wrappers batch through /api/resolve.
 */
async function prefetchResolutions(
  groups: ShowGroup[],
  editions: Record<string, EditionIndexEntry>,
  resolver: Resolver,
  limit = RESOLVE_PREFETCH_LIMIT,
): Promise<void> {
  const targets: { key: string; hubs: HubLink[] }[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of cardOrderItems(group)) {
      const key = editionKeyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = editions[key];
      const hubs = entry ? editionHubs(entry.edition) : item.post.direct;
      if (hubs.length) targets.push({ key, hubs });
      if (targets.length >= limit) break;
    }
    if (targets.length >= limit) break;
  }

  let i = 0;
  async function worker(): Promise<void> {
    while (i < targets.length) {
      const target = targets[i++];
      if (hasCachedRows(target.key)) continue;
      const { rows } = await resolver.resolveHubs(target.hubs, "");
      await cacheRows(target.key, rows);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(RESOLVE_PREFETCH_CONCURRENCY, targets.length) },
      () => worker(),
    ),
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function App() {
  const routerRef = useRef<HashRouter | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  /* ---- search action -------------------------------------------- */

  const doSearch = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const q = (query ?? querySignal.value ?? "").trim();
      querySignal.value = q;
      const posts = await wp.search(q);
      if (posts.length === 0) {
        showToast("info", "No results found.");
        setLoading(false);
        setResults([], [], q);
        return;
      }
      const groups = groupByMovie(posts).slice(0, 120);
      const editions = indexEditions(groups);
      setResults(groups, posts, q);
      editionsSignal.value = editions;
      setLoading(false);
      fetchPosters(groups); // fire-and-forget, updates group.poster in place
      // Pre-resolve the first few card editions so top clicks open instantly.
      prefetchResolutions(groups, editions, getResolver(resolverRef)).catch(
        () => {},
      );
      getResolver(resolverRef).resetMemo();
    } catch (err) {
      setLoading(false);
      showToast(
        "error",
        err instanceof Error ? err.message : "Search failed. Please try again.",
      );
    }
  }, []);

  /* ---- router -------------------------------------------------- */

  useEffect(() => {
    const router = new HashRouter({
      onRouteChange: (route) => {
        setRoute(route);
        if (route.view === "detail" && route.key) {
          currentKeySignal.value = route.key;
        }
      },
    });
    routerRef.current = router;
    return () => {
      router.destroy();
      routerRef.current = null;
    };
  }, []);

  /* ---- detail loading effect ------------------------------------ */

  const route = routeSignal.value;
  const detailKey = route.view === "detail" ? route.key : null;

  useEffect(() => {
    if (!detailKey) return;

    const decodedKey = decodeURIComponent(detailKey);
    const entry: EditionIndexEntry | undefined =
      editionsSignal.value[decodedKey];

    if (!entry) {
      // Hard refresh: the in-memory edition index is rebuilt by the boot
      // search (startup effect). Keep the detail view loading until the
      // index repopulates; bail out to search after a grace period.
      setDetailState({
        key: decodedKey,
        loading: true,
        meta: null,
        rows: [],
        error: null,
        resolving: false,
      });
      const grace = window.setTimeout(() => {
        if (!editionsSignal.value[decodedKey]) {
          setDetailState({
            key: null,
            loading: false,
            meta: null,
            rows: [],
            error: "Release not found — please search again.",
            resolving: false,
          });
          setRoute({ view: "search", key: null });
          window.location.hash = "#/";
        }
      }, 8000);
      return () => window.clearTimeout(grace);
    }

    let cancelled = false;
    const { group, edition } = entry;
    const hubs = editionHubs(edition);
    const resolver = getResolver(resolverRef);

    // Paint instantly — the hero renders while links resolve / stream in.
    setDetailState({
      key: decodedKey,
      loading: false,
      meta: null,
      rows: [],
      error: null,
      resolving: hubs.length > 0,
    });

    // Metadata is independent of link resolution — stream it in as a patch.
    (async () => {
      const meta = await tvMazeClient.getMeta(group.name).catch(() => null);
      if (cancelled) return;
      setDetailState({ key: decodedKey, meta });
    })();

    (async () => {
      // Cache-first: an already-resolved edition opens fully loaded.
      const cached = await getCachedRows(decodedKey);
      if (cancelled) return;
      if (cached) {
        setDetailState({ key: decodedKey, rows: cached, resolving: false });
        return;
      }
      if (!hubs.length) {
        setDetailState({ key: decodedKey, rows: [], resolving: false });
        return;
      }
      // Progressive: rows stream in as each hub link settles, so direct
      // links appear immediately while hub wrappers are still resolving.
      const rows = await resolver.resolveEditionProgressive(hubs, (partial) => {
        if (cancelled) return;
        setDetailState({ key: decodedKey, rows: partial, resolving: true });
      });
      if (cancelled) return;
      setDetailState({ key: decodedKey, rows, resolving: false });
      await cacheRows(decodedKey, rows);
    })().catch(() => {
      if (cancelled) return;
      setDetailState({ key: decodedKey, rows: [], resolving: false });
    });

    return () => {
      cancelled = true;
    };
  }, [detailKey, editionsSignal.value]);

  /* ---- pick the entry for the current detail route (if any) ----- */

  let detailEntry: EditionIndexEntry | null = null;
  if (detailKey) {
    detailEntry =
      editionsSignal.value[decodeURIComponent(detailKey)] ?? null;
  }

  /* ---- startup ------------------------------------------------- */

  useEffect(() => {
    const hash = parseHash();
    setRoute(hash);
    if (hash.view === "detail" && hash.key) {
      currentKeySignal.value = hash.key;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const relayParam = urlParams.get("relay") ?? "";

    // Drop expired cache entries once per session (fail-soft if IndexedDB
    // is unavailable).
    CacheDB.getInstance()
      .clearStale("api-cache", 30 * 60 * 1000)
      .catch(() => undefined);
    CacheDB.getInstance()
      .clearStale("poster-cache", 7 * 24 * 60 * 60 * 1000)
      .catch(() => undefined);
    CacheDB.getInstance()
      .clearStale("meta-cache", 7 * 24 * 60 * 60 * 1000)
      .catch(() => undefined);
    CacheDB.getInstance()
      .clearStale("resolve-cache", RESOLVE_CACHE_TTL)
      .catch(() => undefined);

    let cancelled = false;
    probeMode().then((mode) => {
      if (cancelled) return;
      // A ?relay=... query param overrides any other mode: it tells the
      // page to talk to a specific (possibly undeployed) worker.
      setMode(relayParam ? "relay" : mode);
      if (hash.view === "detail" && hash.key) {
        // Hard refresh wipes the edition index; re-run a narrow search for
        // the target title so the detail route has data to render.
        const rawKey = decodeURIComponent(hash.key);
        const title = String(rawKey.split("|")[0] || "").trim();
        if (title) doSearch(title);
      } else if (!relayParam) {
        doSearch(querySignal.value || "popular");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [doSearch]);

  /* ---- render the current route --------------------------------- */

  const loading = loadingSignal.value;

  let view: h.JSX.Element;
  if (route.view === "detail") {
    if (!detailKey) {
      view = (
        <div class="app-error" role="alert">
          <p>
            {detailStateSignal.value.error ??
              "Release not found. Please search again."}
          </p>
          <button
            onClick={() => {
              routerRef.current?.navigate("/");
              setRoute({ view: "search", key: null });
            }}
          >
            Back to search
          </button>
        </div>
      );
    } else if (!detailEntry) {
      // Hard refresh: the edition index is still being rebuilt by the boot
      // search. Keep a lightweight loading state instead of flashing an error.
      view = (
        <div class="detail-loading" role="status" aria-live="polite">
          <span class="app-spinner" aria-hidden="true" />
          <p>Loading release…</p>
        </div>
      );
    } else {
      const detail = detailStateSignal.value;
      // Guard against a one-frame flash of the previous edition's rows: only
      // trust state whose key matches the navigation target.
      const detailIsCurrent = detail.key === decodeURIComponent(detailKey);
      view = (
        <DetailView
          editionKey={detailKey}
          group={detailEntry.group}
          edition={detailEntry.edition}
          meta={detailIsCurrent ? detail.meta : null}
          rows={detailIsCurrent ? detail.rows : []}
          loading={detail.loading}
          resolving={detailIsCurrent ? detail.resolving : true}
          onBack={() => {
            routerRef.current?.navigate("/");
            setRoute({ view: "search", key: null });
          }}
        />
      );
    }
  } else {
    view = (
      <Fragment>
        <SearchBar
          onSearch={doSearch}
          loading={loading}
          initialQuery={querySignal.value}
        />
        {loading ? (
          <div class="app-grid">
            <SkeletonCard count={12} />
          </div>
        ) : (
          <ResultsGrid groups={groupsSignal.value} query={querySignal.value} />
        )}
      </Fragment>
    );
  }

  return (
    <div class="app-shell">
      <header class="app-header">
        <h1 class="app-title">
          <a href="#/" class="app-title-link">
            CineDirect
          </a>
        </h1>
      </header>
      <main class="app-main">{view}</main>
      <ToastContainer toasts={toastsSignal.value} onDismiss={dismissToast} />
    </div>
  );
}