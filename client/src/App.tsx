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
import { Resolver } from "./core/resolution";
import { groupByMovie, indexEditions } from "./core/grouping";
import { WikipediaClient } from "./api/wikipedia";
import { TvMazeClient } from "./api/tvmaze";
import type { ShowGroup, AppMode, EditionIndexEntry } from "@shared/types";

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

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function App() {
  const routerRef = useRef<HashRouter | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const metaCacheRef = useRef<
    Record<string, import("@shared/types").TvMazeMeta | null>
  >({});

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
      // Hard refresh: editions were wiped with page state. Navigate back to
      // search view where the user can re-run the query.
      setDetailState({
        key: null,
        loading: false,
        meta: null,
        rows: [],
        error: "Release index unavailable — please search again.",
      });
      setRoute({ view: "search", key: null });
      window.location.hash = "#/";
      return;
    }

    let cancelled = false;
    const { group, edition } = entry;
    setDetailState({ key: decodedKey, loading: true, meta: null, rows: [], error: null });

    (async () => {
      // TVMaze metadata (cached per show name).
      let meta: import("@shared/types").TvMazeMeta | null =
        metaCacheRef.current[group.name] ?? null;
      if (!meta) {
        try {
          meta = await tvMazeClient.getMeta(group.name);
        } catch {
          meta = null;
        }
        metaCacheRef.current[group.name] = meta;
      }

      // Resolve every hub in the edition → quality rows.
      const hubs = edition.items.reduce<{ url: string; qual: import("@shared/types").Quality | null }[]>(
        (acc, it) => {
          for (const h of it.post.direct) acc.push({ url: h.url, qual: h.quality });
          return acc;
        },
        [],
      );

      let rows: import("@shared/types").QualityRow[] = [];
      if (hubs.length) {
        const resolved = await getResolver(resolverRef).resolveHubs(
          hubs.map((h) => ({ url: h.url, quality: h.qual, kind: "unknown" as const })),
          edition.items[0]?.post.link ?? "",
        );
        rows = resolved.rows;
      }

      if (cancelled) return;
      setDetailState({
        key: decodedKey,
        loading: false,
        meta,
        rows,
        error: null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [detailKey]);

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
    if (!detailKey || !detailEntry) {
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
    } else {
      const detail = detailStateSignal.value;
      view = (
        <DetailView
          editionKey={detailKey}
          group={detailEntry.group}
          edition={detailEntry.edition}
          meta={detail.meta}
          rows={detail.rows}
          loading={detail.loading}
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