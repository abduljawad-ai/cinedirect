# CineDirect — Direct Movie Downloads

Search a movie or TV show and get **direct download links** for every available
quality — no timers, no captchas, no ads.

This repository is the production rewrite of the CineDirect demo. It is a
**technical refactor only** — feature behavior and the HTML/CSS look are
preserved (only the implementation changed).

## What it does

- **Search** reads the post index from `hblinks.co` (WordPress REST API) and
  groups releases into shows → seasons → episodes, with a card for each
  complete-season pack. No links resolve on this view, so results load fast.
- **Detail** (`#/detail/e<editionKey>`) renders the TVMaze poster/synopsis plus
  one taggable download row per quality (2160P/1080P/720P/480P) and per direct
  link type (R2 / GDrive / Pixeldrain). This is the only view that resolves
  `hubcdn.sbs`, `hubdrive.tips`, and `hubcloud.cx|ist` links down to bare file
  URLs.
- **Instant download links**: the top results are pre-resolved in the
  background as soon as a search returns, and each edition keeps its resolved
  rows in a 24 h cache — so clicking a card shows its download links
  immediately instead of a blocking "loading" spinner. Resolving happens in
  batches (up to 20 links per request) and direct links are routed locally on
  the client.
- **Deep links** work on hard refresh: a narrowed search runs on boot and the
  edition index is rebuilt before the detail view renders (resolved rows come
  back from the local cache on repeat visits).

## Repository layout

npm workspaces monorepo (Node ≥ 20):

| Path       | What it is                                                         |
|------------|--------------------------------------------------------------------|
| `client/`  | Preact + Signals + CSS Modules static app (Vite)                   |
| `worker/`  | Cloudflare Worker, TypeScript port of `worker/relay.js` (JS original kept) |
| `server/`  | FastAPI backend (link resolution + optional Pixeldrain streaming proxy) |
| `shared/`  | Shared TypeScript types used by client and worker                  |
| `docs/`    | Design/analysis notes (`docs/superpowers/`)                        |

## How it runs — mode probing

| Mode    | When it's used                    | What you get |
|---------|-----------------------------------|--------------|
| `local` | `/api/health` answers on the same origin | Full resolution **and** a `…/api/dl?src=…` streaming proxy for Pixeldrain (bypasses hotlink checks). |
| `relay` | `VITE_RELAY_URL` is set **and** its `/api/health` answers | Same as local, resolved at Cloudflare's edge — works on GitHub Pages. |
| `static`| Neither is reachable              | In-browser best effort. Hubcdn resolves **directly**; hubdrive/hubcloud fall back to their redirect pages; Pixeldrain links to the public `/u/` page. |

The mode is auto-detected on page load by probing `/api/health`, then
`VITE_RELAY_URL/api/health`, else static. `?relay=<url>` in the query string
force-overrides the mode for testing an undeployed worker.

## Running locally

```bash
npm install

# Client dev server (port 3000, proxies /api → localhost:8000)
npm run dev:client

# FastAPI server (port 8000) — resolution + Pixeldrain proxy
pip install -r server/requirements-dev.txt
./.venv/bin/python server/run.py   # or: (cd server && python run.py)

# Cloudflare worker in dev (optional)
npm run dev:worker
```

Static build + preview:

```bash
npm run build
cd client && npx vite preview --port 4173
```

### Server environment variables

| Variable                  | Default | Purpose                                         |
|---------------------------|---------|-------------------------------------------------|
| `CINEDIRECT_RELAY_URL`    | —       | Relay worker URL the server proxies to          |
| `CINEDIRECT_TMDB_KEY`     | —       | TMDB API key for optional title metadata        |
| `CINEDIRECT_CACHE_DIR`    | —       | Directory for the resolution cache file         |
| `CINEDIRECT_CORS_ORIGINS` | `*`     | Comma-separated allowed origins                 |
| `CINEDIRECT_RATE_LIMIT`   | `30`    | Requests allowed per client IP window           |

## Deploying

CI runs lint, typecheck, 100+ unit tests, server checks (ruff/mypy/pytest), and
a Playwright e2e suite. On `main`, `.github/workflows/deploy.yml` publishes:

1. **Client → GitHub Pages** (`gh-pages -d dist`, relative asset base, hash
   routing — works under `<user>.github.io/<repo>`).
2. **Worker → Cloudflare** (`npm run deploy:worker`, requires the
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets). Optional KV
   caching: uncomment `kv_namespaces` in `worker/wrangler.toml` and provision
   the namespace first.
3. **Server image → GHCR** (`ghcr.io/<owner>/<repo>/cinedirect-server:latest`).

For the deployed site to hand out true direct links, deploy the **worker
relay** and rebuild the client with `VITE_RELAY_URL=https://cinedirect-relay.<subdomain>.workers.dev`.
Without a worker, the site still works in static mode (redirect/`/u/` links).

## Testing

```bash
npm run lint && npm run typecheck && npm test && npm run build   # all workspaces
npm run test:e2e          # Playwright (chromium + mobile emulation)
cd server && ./.venv/bin/ruff check . && ./.venv/bin/mypy app run.py && ./.venv/bin/python -m pytest -q
```

E2E tests intercept every remote API (`hblinks.co`, `tvmaze`, `wikipedia`) with
deterministic fixtures so the suite runs offline.

## Legal note

This is a hard link-collection tool for movies and TV shows. The refactor did
not change what it does or who it targets; a data-free dropdown/picker UI for a
different purpose is a separate future effort.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the internal design.