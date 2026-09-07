# CineDirect — Direct Movie Downloads

Search a movie and get **direct download links** for every available quality —
no timers, no captchas, no ads.

The page reads the post index from `hblinks.co` (WordPress), resolves each
`hubcdn.sbs/file`, `hubdrive.tips/file`, and `hubcloud.cx|ist/drive` link down
to the bare direct file URL (R2 / GDrive / Pixeldrain), and shows every quality
as a one-click download.

---

## How it runs — three modes

| Mode            | When it's used                          | What you get |
|-----------------|-----------------------------------------|--------------|
| **local**       | Running `hblinks-server.py`             | Full resolution **and** a `…/api/dl?src=…` streaming proxy for Pixeldrain (bypasses hotlink checks). |
| **relay**       | A Cloudflare Worker is deployed + `RELAY` is set | Same as local, but from Cloudflare's edge — works on GitHub Pages. |
| **static**      | No server, no relay                     | In-browser best effort. Hubcdn resolves **directly**; hubdrive/hubcloud fall back to their redirect pages; Pixeldrain links to the public `/u/` page. |

The mode is picked automatically on page load by probing `/api/ping` (local),
then `RELAY/api/ping` (relay), else static.

---

## Running locally

```bash
python3 hblinks-server.py 8000
# open http://localhost:8000/
```

`hblinks-server.py` serves the page **and** does the link resolution + a
Pixeldrain streaming proxy. Direct links then look like:

```
http://localhost:8000/api/dl?src=https%3A%2F%2Fpixeldrain.dev%2Fapi%2Ffile%2F...
```

---

## Deploying to GitHub Pages (the important part)

GitHub Pages can only host static files — it **cannot** run the Python resolver.
So for the deployed site to show real direct links (the `…/api/dl?src=…` style
W2 proxy links) you must deploy the **Cloudflare Worker relay**, which reimplements
the resolver at Cloudflare's edge.

### 1. Deploy the worker

```bash
cd worker
npx wrangler login
npx wrangler deploy          # uses wrangler.toml (name = "cinedirect-relay")
```

This prints a URL of the form `https://cinedirect-relay.<subdomain>.workers.dev`.

### 2. Point the page at the worker

In `index.html`, set the `RELAY` constant to that URL:

```js
var RELAY = "https://cinedirect-relay.<subdomain>.workers.dev";
```

### 3. Push to GitHub

GitHub Pages auto-builds from the repo. With `RELAY` set, the live site now
probes the worker, resolves every link to its direct file URL, and proxies
Pixeldrain downloads through `…/api/dl?src=…` exactly like local.

> **No worker?** The site still works in static mode but shows `Via redirect`
> rows for hubdrive/hubcloud and `/u/` links for Pixeldrain — it just can't
> hand out true direct blob URLs without a server.

### Testing an undeployed relay

```bash
cd worker
node harness.mjs 8300
```
then open the page with `?relay=http://localhost:8300`.

---

## Notes

- `RELAY` is empty by default; the `?relay=` query param overrides it for
  testing without editing the file.
- Worker is a plain Cloudflare Worker (`worker/relay.js`), deployable with
  Wrangler; see `worker/README` notes in code comments.
- The resolver caches successes in `hubcdn_resolve_cache.json` (local server)
  so repeat searches are instant. Transient failures are never cached.
