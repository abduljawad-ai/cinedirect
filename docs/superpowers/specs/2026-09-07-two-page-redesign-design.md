# CineDirect Two-Page Redesign — Design Spec

Date: 2026-09-07
Status: Approved

## 1. Overview

CineDirect is currently a single search page that renders every release as a
card with inline direct-download links. This redesign splits the app into two
in-page views ("pages"):

- **View 1 — Search/Results**: search box plus results grouped into shows,
  season headers, and episode cards.
- **View 2 — Detail**: a full "page" for a single selected release, showing
  rich metadata (poster, synopsis, genres, rating), a clean list of every
  available quality as a direct download, and a Source button.

It is implemented as an in-page SPA with hash routing so it keeps working on
static hosting (GitHub Pages) with working back-button, refresh, and history.

## 2. Decisions (from brainstorming)

- View 1 shows season headers with episode cards visible beneath them, plus ONE
  card per complete-season post.
- View 2 = a detail page per movie/episode release.
- Movie screenshots are NOT obtainable: hblinks.co posts and the hubcdn /
  pixeldrain file hosts contain no screenshots (only logos); the live HDHub4u
  site is behind a JS/Cloudflare challenge and the r.jina.ai reader returns only
  a generic overview and strips images (verified by testing). Instead, View 2
  uses TVMaze metadata for the "see what it's about" preview.
- Direct download links resolve only when a card is opened on View 2 (not on
  the results page), keeping View 1 fast.
- Direct links are NOT wrapped in a localhost `/api/dl` proxy. Pixeldrain
  `/api/file/<id>` and `pub-*.r2.dev` URLs download the file directly (verified
  one-click download).

## 3. Architecture

Single `index.html`, in-page SPA with hash routing:

- `#/` — search/results view.
- `#/detail/<key>` — detail view for a release key.

A small router listens to `hashchange`, renders the matching view, and supports
the browser Back button, page refresh, and forwards/backwards history.

Data flow:

1. On search, fetch hblinks.co WP API posts (existing logic).
2. Group posts by show and season (see §5).
3. Render View 1 cards (posters + quality badges only — no link resolution).
4. On card click, navigate to `#/detail/<key>`.
5. View 2 loads metadata (TVMaze) and resolves all quality links for the
   release, then renders the detail page.

## 4. Metadata source: TVMaze

- Keyless API, returns `access-control-allow-origin: *` (verified), so it works
  directly from static hosting.
- Provides: poster/large image, synopsis (summary), genres, premiered year,
  rating, network, type, language.
- Query by show name, cache in memory.
- Fallback: if TVMaze misses, reuse the existing Wikipedia/TVMaze poster
  resolution and render a generic detail (title + links only).

## 5. View 1 — Search/Results grouping

Parse each post title for season/episode markers:

- `S01`, `S02`, `S03`, … → season number.
- Complete-season posts (e.g. `Silo.S03.1080p`, ambiguous `Silo.S03`) →
  a complete-season card.
- Individual episode posts (e.g. `Silo.S03E10`) → episode cards under their
  season header.
- No season marker → treated as a standalone movie card.

Render order within a show group:

- Show title header (e.g. "Silo (2023)").
- For each season (ascending): a **season header** ("Season 3").
  - Episode cards beneath it.
  - Any complete-season card for that season.
- Cards show poster thumbnail, title, quality badges, episode number where
  applicable, and a prominent Details button.
- **No link resolution on View 1** — cards are lightweight.

## 6. View 2 — Detail page

Full-screen detail for one release:

- **Hero**: large TVMaze poster (left) + title, year, genres, rating,
  synopsis, and metadata chips (right).
- **Download section**: one row per unique quality (480P / 720P / 1080P /
  2160P), mirror-deduped. Each row = label ("720P · 1.4 GB") + **Download**
  button pointing at the direct URL.
- If no quality resolves: a single **"Via redirect"** row (opens the source
  redirect page).
- **Source** button always present (opens the source release page).
- **Back** button returning to the results (preserving search/scroll via hash).

## 7. Resolution pipeline (reused, unchanged core)

All existing resolution machinery is reused:

- **Local mode** (`MODE === "local"`): Python server `/api/resolve` returns real
  direct links (hubcdn → r2.dev; hubdrive/hubcloud → pixeldrain). Verified.
- **Relay mode**: same API via the Cloudflare worker when deployed.
- **Static mode**: `resolveHubcdnStatic` (r.jina.ai reader + base64 unwrap →
  `pub-*.r2.dev`); pixeldrain `/api/file/<id>` direct; hubdrive/hubcloud →
  null (those rows show "Via redirect").
- Per-quality rows, mirror-deduped (480P once, 720P once, etc.).
- Direct links: raw r2.dev / pixeldrain `/api/file/<id>` — one-click download,
  no localhost proxy.

## 8. Error handling & edge cases

- Detail for a release whose data changed → graceful "links unavailable, open
  source" fallback.
- TVMaze miss → poster fallback + generic detail; links still work.
- Reader 429 throttling already handled; reused for View 2 resolution.
- Unknown-quality resolved links become "Direct" rows (deduped by URL) so no
  working link is lost.
- Empty/blank search handled as today.

## 9. Testing

- JS syntax check after each edit (existing `new Function` pattern).
- Playwright browser verification in **local mode** and **static mode**:
  - View 1: season grouping, episode cards, complete-season card.
  - View 2: hero metadata + per-quality rows, no duplicate qualities,
    correct "Via redirect" fallback.
  - Hash routing: back button, refresh, browser history.
  - A real one-click download on a pixeldrain/r2 link.
- Confirm no regressions in the existing direct-link behavior.

## 10. Out of scope

- Movie screenshots (unobtainable from any reachable source, verified).
- TMDB (requires an API key/account); TVMaze chosen instead.
- Server-side worker deployment (user runs `wrangler deploy`); design still
  supports relay mode when configured.
