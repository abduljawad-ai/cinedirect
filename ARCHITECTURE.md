# CineDirect — Architecture

Technical rewrite of the CineDirect demo. Feature behavior preserved;
implementation modernized (npm workspaces monorepo, TypeScript end to end,
tested).

## Repo map

```
client/                 Preact + Signals SPA (Vite, CSS Modules + CSS vars)
  src/
    main.tsx            Entry point
    App.tsx             Shell: routing, mode probe, search, detail loading
    api/                Data providers (wp, tvmaze, wikipedia), all cached
    core/               Pure logic: parsing, grouping, resolution
    components/         SearchBar, ResultsGrid, MovieCard, DetailView, …
    routing/            HashRouter + parseHash
    state/              Global signals (store) + IndexedDB persistence
    utils/              dom / fetch / format helpers
    styles/             CSS Modules + global design tokens
  tests/                Vitest unit tests (65)
  e2e/                  Playwright suites (8 scenarios, offline fixtures)
worker/                 Cloudflare Worker (TypeScript port of relay.js)
server/                 FastAPI backend (optional local/relay server)
shared/types.ts         Types shared by client + worker
```

## Client data flow

1. **Boot** (`App.tsx` start-up effect): parses `location.hash`, reads
   `?relay=`, clears stale IndexedDB caches (fire-and-forget), then probes the
   mode. After the probe it either auto-searches `"popular"` or, for a detail
   deep link, runs a narrowed search on the title embedded in the edition key —
   the edition index is offline after a hard refresh, so the search rebuilds it
   before the detail loader can succeed.
2. **Search** (`doSearch`): `wp.searchExpanded(q)` → `groupByMovie(posts)` →
   `indexEditions(groups)` → `resultsGroupSignal` + `editionsSignal`. Posters
   fire-and-forget via Wikipedia → TVMaze with a concurrency limit of 4.
   `searchExpanded` fetches up to 2 result pages (200 posts) and, when the query
   contains season/episode hints (`reacher s04`, `reacher s04e07`, …), also
   searches the base show name and filters client-side by the parsed hints —
   WordPress literal search alone drops or scatters episodes (`parsing.ts`:
   `parseSearchHints` / `filterByHints`). `parseSeasonal` understands
   dash-formatted episode codes (`S04-E07`), so each episode of a season
   groups into its own edition card instead of collapsing into one pack.
3. **Results render**: `ResultsGrid` lays each `ShowGroup` out via
   `layOutGroup` (season buckets, orange episodes, movies, packs), then shapes
   the layout by the query's parsed hints (`filterLayoutForHints`). No hints
   (`reacher`) → collapsed seasons: each season renders as a button ("Show
   episodes ›") instead of episode cards; clicking refines the search to
   `reacher s4`. Season hint (`reacher s04`) → that season and all its
   episodes. Episode hint (`reacher s04e07`) → only that episode; packs are
   hidden. Cards link to `#/detail/e<encodeURIComponent(editionKey)>`.
   Quality variants of the same edition (e.g. "Silo S01E01 1080p" + "… 720p")
   collapse into a single card with merged quality chips. `parseTitle` strips
   release-group/codec noise (including `HDHub4u`, `WEB-DL`) so group names
   read as the bare show title.
4. **Search prefetch** (`prefetchResolutions`): after every search the first
   12 unique edition keys in the ResultsGrid render order are resolved in the
   background (concurrency 3) and written to the resolve-cache, so clicking a
   top card shows its download links immediately.
5. **Detail load** (separate effect keyed on `[detailKey, editionsSignal]`):
   paints instantly — the view is never gated behind a full-screen spinner.
   `resolving` is set while download links are still outstanding; metadata is
   patched independently. Rows come from the resolved recent results and then
   from `resolveEditionProgressive` (serial per-hub, streaming `onRows` after
   each hub) if the edition was not already resolved. Progressively rendered
   rows are written to the resolve-cache on completion. While the index is
   missing (hard refresh) a lightweight waiting state renders until the boot
   search repopulates it; an 8 s grace timer bounces back to search otherwise.
6. **Mode & resolver** (`apiFn` / `Resolver`): `local` → same-origin `/api/…`;
   `relay` → `VITE_RELAY_URL + path`; `static` → in-browser hubcdn unwrap only.

## Instant download links

- **Client-side routing** (`resolveMany`): raw direct links (R2 / GDrive / S3
  / Pixeldrain) never touch the network — they are resolved locally and
  broadcast to duplicate submissions of the same URL.
- **Batch resolve** (`batchViaApi`): hub wrappers (hubcdn.sbs / hubdrive.tips /
  hubcloud) POST up to 20 URLs at once to `/api/resolve` (single request, one
  rate-limit unit on the server/worker); results keep the request order and
  per-item failures become `null`. Partial chunks for lists > 20; batch failure
  falls back to per-link resolution. Static mode has no batch API and resolves
  one hub at a time.
- **Resolve cache** (`state/resolveCache.ts`): resolved `QualityRow[]` per
  canonical edition key, 24 h TTL (`RESOLVE_CACHE_TTL`), mirrored in memory and
  in IndexedDB (`resolve-cache` store). Empty results are never stored; stale
  entries are treated as misses; boot clears expired rows. This makes deep-link
  hard reloads fast after a previous visit.

## Edition keys

`editionKeyOf(item)` builds a canonical, shareable key:
`normKey(baseTitle) | year | edition | subs | S<n> | E<n> | PACK`
(empty parts omitted). It is the value after `#/detail/e` and the key into
`editionsSignal`; the hard-refresh boot search derives its query from the key's
first segment.

## Caching

- **IndexedDB** (`state/persistence.ts`): `CacheDB` + `withRevalidation`.
  - `api-cache` — WordPress search responses, 10 min TTL, revalidates.
  - `meta-cache` — TVMaze metadata, 7 days, no revalidation.
- `poster-cache` — poster URLs (Wikipedia/TVMaze), 7 days.
   - `resolve-cache` — resolved download links per edition, 24 h TTL (boot
     `clearStale` eviction).
   - `get` distinguishes a *miss* (`undefined`) from a *cached `null`* (negative
     results) so nulls are not refetched.
- **Server** (`server/app/services/cache.py`): JSON resolution cache on disk;
  transient failures never cached.
- **Worker/KV**: optional; the `kv_namespaces` binding in `wrangler.toml` is
  commented out until a namespace is provisioned.

## Modes recap (client `probeMode`)

`/api/health` → `local` · `VITE_RELAY_URL/api/health` → `relay` · else `static`.
`?relay=` overrides for local testing of an undeployed worker.

## Server (FastAPI)

- `app/main.py` — `create_app()`, lifespan, SPA static serving.
- `app/api/routes.py` — `/api/health`, `/api/search`, `/api/resolve` (batch
  `POST {urls:[…]}` too, cap 20, order preserved, per-item `null`),
  `/api/dl` (Pixeldrain streaming proxy).
- `app/middleware/` — CORS from env, in-memory per-IP rate limit.
- `app/services/` — resolver, JSON cache, optional TMDB metadata.
- Env: `CINEDIRECT_RELAY_URL`, `CINEDIRECT_TMDB_KEY`, `CINEDIRECT_CACHE_DIR`,
  `CINEDIRECT_CORS_ORIGINS`, `CINEDIRECT_RATE_LIMIT`.

## Worker (Cloudflare)

Faithful TypeScript port of `worker/relay.js` (the original stays in the repo
as the reference contract). Key behaviors, all covered by 36 unit tests:

- `r=` query param base64-decodes to the target URL; a decoded value that does
  not contain `hubcdn.sbs/dl/` is intentionally rejected (matching relay.js).
- Batch `POST /api/resolve` with `{urls:[…]}` (cap 20) resolves each URL in
  order, returning `ResolveBatchResponse` with per-item `null` on failure, as
  one rate-limited request; the legacy `GET ?url=` form is unchanged and stays
  the single-URL entry point.
- Rate limiting keyed on `CF-Connecting-IP`.
- `env.ALLOWED_ORIGINS` drives CORS headers.

## Testing strategy

| Layer    | Tool          | Where                          |
|----------|---------------|--------------------------------|
| Unit     | Vitest        | `client/tests/`, `worker/tests/` |
| Server   | pytest/ruff/mypy | `server/tests/`              |
| E2E      | Playwright    | `client/e2e/` (chromium + mobile, offline route fixtures) |

CI (`.github/workflows/ci.yml`) runs all of the above; deploys
(`deploy.yml`) publish the client to GitHub Pages, the worker to Cloudflare,
and the server image to GHCR.

## Dependency advisory triage (September 2026)

`npm audit` state: **0 critical** — down from 17. Runtime search/detail code
depends on no vulnerable packages; the 5 remaining entries are dev-tooling
only:

| Package | Severity | Chain | Why it stays |
|---------|----------|-------|--------------|
| `wrangler` / `miniflare` / `sharp` | high | worker devDependency → miniflare `5...alpha` → sharp `0.35.2` | No patched wrangler release exists (`4.130.0` is latest). Local `wrangler dev` tooling only; the deployed worker runs Cloudflare's platform build, not this npm tree. |
| `vite` | high | dev-server `.map` path traversal / Windows `launch-editor` | Fix is `>8.2.2`, not yet released. Dev server is not exposed in deployment (static build is served). |
| `esbuild` | moderate | stale `0.21.5` hoisted from `@prefresh/vite`'s pinned `vite@5` | esbuild `serve()` (the vulnerable API) is never used; build uses esbuild's transform/bundle paths. |

Re-check after upstream releases (`npm audit`) before any major dev-tooling
bump.