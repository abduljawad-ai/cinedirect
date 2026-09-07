# CineDirect Two-Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single-page CineDirect app into two in-page views — a search view (season headers + episode/complete-season cards) and a detail view (TVMaze metadata + per-quality direct links) — using hash routing and resolving links only when a card is opened.

**Architecture:** Keep everything in the one `index.html`. Hoist the existing resolution engine out of `doSearch` into a shared IIFE-level `Resolve` module so both the search render path and the detail view can use it. Add a tiny hash router (`#/` search, `#/detail/<key>` detail) that swaps two view containers. View 1 renders lightweight cards (no link resolution); View 2 resolves links and shows metadata when opened.

**Tech Stack:** Vanilla JS (no framework), single `index.html`, hblinks.co WordPress REST API as the data source, TVMaze REST API for metadata (keyless, CORS `*`), Python server / Cloudflare relay / r.jina.ai reader for link resolution (existing). Testing via Node syntax check + Playwright browser checks (no test framework exists in this repo).

## Global Constraints

- Target file: `index.html` (all functional changes in this one file). `hblinks-server.py` and `worker/relay.js` are NOT modified by this plan.
- Direct links are raw `pub-*.r2.dev` or pixeldrain `https://pixeldrain.dev/api/file/<id>` URLs — never wrapped in a `/api/dl` localhost proxy (spec §2).
- Resolution happens ONLY on View 2 (spec §2, §5). View 1 cards show posters + quality badges parsed from the title only.
- Movie screenshots are out of scope (unobtainable — spec §2); the "see what's in it" preview is TVMaze metadata.
- Per-quality rows are mirror-deduped — each quality (480P/720P/1080P/2160P) appears at most once (spec §6).
- If no quality resolves, a single "Via redirect" row links to the source page (spec §6).
- Hash routes: `#/` (search) and `#/detail/p<postId>` (detail). Back button and refresh must work.
- Existing resolution behavior (local/relay/static modes) must keep working unchanged.
- Design spec: `docs/superpowers/specs/2026-09-07-two-page-redesign-design.md`.

---

### Task 0: Commit the current working state

**Files:**
- Modify: none (commit only)

**Interfaces:**
- Consumes: nothing
- Produces: a clean starting point for the refactor

- [ ] **Step 1: Verify tree state**

Run: `cd /home/jawad/Desktop/hblinks-tool && git status --short`
Expected: `M README.md`, `M index.html` (the already-done link-dedupe work + README).

- [ ] **Step 2: Commit existing work**

```bash
git add index.html README.md
git commit -m "feat: per-quality deduped direct links, no localhost proxy"
```

- [ ] **Step 3: Confirm clean**

Run: `git status --short`
Expected: empty output.

---

### Task 1: Hoist the resolution engine into a shared `Resolve` module

**Files:**
- Modify: `index.html` (entire resolution block, currently lines ~575–871 inside `doSearch`)

**Interfaces:**
- Consumes: outer-scope `api(path)`, `MODE`, `modeReady`, `sleep(ms)`, `directHref(u)`, `esc(s)`, `formatBytes(n)` (all already IIFE-scoped)
- Produces:
  - `Resolve.hubs(hubs, archiveUrl)` → `Promise<{ rows: Array<{direct,size,quality,filename,_qual}>, best: {...}|null, results: [...] }>` — resolves every mirror in parallel, attaches post-HTML quality labels (`_qual`), returns deduped per-quality `rows` sorted best-first, `best` (highest-quality result), and raw `results`.
  - `Resolve.qualityRows(results)` → sorted deduped rows (same logic as current `qualityRows`).
  - `Resolve.bestOf(results)` → best result or null.
  - `Resolve.resetMemo()` → clears `resolveMemo` (called on each new search so a failed mirror can retry later — mirrors are cached per URL, and ARCHIVE links from stale searches must not poison the detail view).

**Why:** View 2 must resolve links, but today the whole engine lives inside `doSearch`'s closure. It must become module-scoped before View 2 can call it.

- [ ] **Step 1: Move the resolution block into a module**

Take these existing pieces from their current location inside `doSearch` (after the poster worker, before `async function resolveCard`) and move them to IIFE scope (between `const posterCache = new Map();` and `function stripHtml`) wrapped in an IIFE assigned to `const Resolve`:

- `QUAL_RANK`, `rankOf(q)`
- `resolveFetch(url, ms)`
- `PUB_READER`, `_readerQueue`, `_readerLast`, `readerRequest(url, ms)`, `rawPageViaReader(url, ms)`, `READER_SPACING`
- `resolveMemo = {}`
- `simpleQuality(name)`, `pixInfo(id)`
- `unwrapBare(dl)`
- `resolveHubcdnStatic(url)`, `resolveHubdriveStatic()`, `resolveHubcloudStatic()`, `resolveOneStatic(url)`
- `resolveOne(url)`
- `qualityRows(results)`, `bestResult(results)`

The module (exact code):

```js
const Resolve = (function () {
  const QUAL_RANK = { "2160P": 4, "4K": 4, "1080P": 3, "720P": 2, "480P": 1, "360P": 0 };
  function rankOf(q) { return QUAL_RANK[q] != null ? QUAL_RANK[q] : -1; }

  function resolveFetch(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(function () { ctl.abort(); }, ms);
    return fetch(url, { signal: ctl.signal }).finally(function () { clearTimeout(t); });
  }

  var PUB_READER = "https://r.jina.ai/";
  function simpleQuality(name) {
    const m = /\b(480p|720p|1080p|2160p|4k)\b/i.exec(name || "");
    return m ? m[1].toUpperCase() : null;
  }
  async function pixInfo(id) {
    let size = null, filename = "";
    try {
      const r = await resolveFetch("https://pixeldrain.dev/api/file/" + id + "/info", 10000);
      if (r.ok) {
        const info = await r.json();
        if (info && info.name) { filename = info.name; size = info.size || null; }
      }
    } catch (e) { /* row still works, just without extras */ }
    return { size: size, filename: filename, quality: simpleQuality(filename) };
  }

  var _readerQueue = Promise.resolve();
  var _readerLast = 0;
  function readerRequest(url, ms) {
    const ctl = new AbortController();
    const to = setTimeout(function () { ctl.abort(); }, ms || 25000);
    return fetch(PUB_READER + encodeURIComponent(url), {
      headers: { "X-Return-Format": "html" },
      signal: ctl.signal
    }).finally(function () { clearTimeout(to); });
  }
  function rawPageViaReader(url, ms) {
    var job = _readerQueue.then(async function () {
      var now = Date.now();
      var wait = 0;
      if (_readerLast) {
        wait = READER_SPACING - (now - _readerLast);
        if (wait > 0) await sleep(wait);
      }
      _readerLast = Date.now();
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var rr = await readerRequest(url, ms);
          if (rr.status === 429) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          if (!rr.ok) return "";
          return await rr.text();
        } catch (e) {
          if (attempt < 2) await sleep(700);
        }
      }
      return "";
    });
    _readerQueue = job.catch(function () { /* keep chain alive */ });
    return job;
  }
  var READER_SPACING = 1100;

  var resolveMemo = {};

  function unwrapBare(dl) {
    const lm = /link=([^&]+)/.exec(dl || "");
    let v = lm ? lm[1] : dl;
    try { v = decodeURIComponent(v); } catch (e) { /* keep as-is */ }
    return v;
  }

  async function resolveHubcdnStatic(url) {
    let html = "";
    try { html = await rawPageViaReader(url, 25000); } catch (e) { return null; }
    const m = /var\s+reurl\s*=\s*"([^"]+)"/s.exec(html);
    if (!m) return null;
    const reurl = m[1].replace(/\\\//g, "/");
    let wrapper = null;
    const rb = /[?&]r=([A-Za-z0-9+/=_\-]+)/.exec(reurl);
    if (rb) {
      try {
        const b64 = rb[1];
        const pad = (4 - (b64.length % 4)) % 4;
        wrapper = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
      } catch (e) { wrapper = null; }
    } else if (reurl.indexOf("hubcdn.sbs/dl/") >= 0) {
      wrapper = reurl;
    }
    if (wrapper && wrapper.indexOf("hubcdn.sbs/dl/") >= 0) {
      const dl = unwrapBare(wrapper);
      const px = dl.match(/pixeldrain\.(?:com|dev)\/api\/file\/([A-Za-z0-9]+)/);
      if (px) {
        const info = await pixInfo(px[1]);
        return { direct: dl, size: info.size, filename: info.filename, quality: info.quality };
      }
      return { direct: dl, size: null, filename: null, quality: null };
    }
    return null;
  }

  async function resolveHubdriveStatic() { return null; }
  async function resolveHubcloudStatic() { return null; }

  async function resolveOneStatic(url) {
    const pd = url.match(/pixeldrain\.(?:com|dev)\/api\/file\/([A-Za-z0-9]+)/);
    if (pd) {
      const info = await pixInfo(pd[1]);
      return { direct: "https://pixeldrain.dev/api/file/" + pd[1], size: info.size, filename: info.filename, quality: info.quality };
    }
    if (/(hubcdn\.sbs)\/file\//i.test(url)) return resolveHubcdnStatic(url);
    if (/hubdrive\.tips\/file\//i.test(url)) return resolveHubdriveStatic(url);
    if (/hubcloud\.(cx|ist)\/drive\//i.test(url)) return resolveHubcloudStatic(url);
    return null;
  }

  async function resolveOne(url) {
    if (resolveMemo[url]) return resolveMemo[url];
    const p = (async function () {
      await modeReady;
      if (MODE === "static") return resolveOneStatic(url);
      try {
        const r = await resolveFetch(api("/api/resolve?url=" + encodeURIComponent(url)), 45000);
        if (!r.ok) return null;
        const data = await r.json();
        return data && data.direct ? data : null;
      } catch (e) { return null; }
    })();
    resolveMemo[url] = p;
    return p;
  }

  function qualityRows(results) {
    const byQ = {};
    const seen = {};
    results.forEach(function (r) {
      if (!r || !r.direct) return;
      const q = String(r.quality || r._qual || "").toUpperCase();
      if (q && rankOf(q) >= 0) {
        const key = String(q).toLowerCase();
        const cur = byQ[key];
        if (!cur || (r.quality && !cur.quality)) byQ[key] = r;
      } else if (!seen[r.direct]) {
        seen[r.direct] = true;
        byQ["__raw_" + r.direct] = { direct: r.direct, quality: r.quality || null, size: r.size, filename: r.filename };
      }
    });
    return Object.keys(byQ).map(function (k) { return byQ[k]; })
      .sort(function (a, b) { return rankOf((b.quality || b._qual || "").toUpperCase()) - rankOf((a.quality || a._qual || "").toUpperCase()); });
  }

  function bestOf(results) {
    let best = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.direct) continue;
      const q = r.quality || r._qual || "";
      if (!best || rankOf(String(q).toUpperCase()) > rankOf(String((best.quality || best._qual || "")).toUpperCase())) best = r;
    }
    return best;
  }

  async function hubs(hubs, archiveUrl) {
    const results = await Promise.all(hubs.map(function (h) {
      return resolveOne(h.url).then(function (r) {
        if (r) r._qual = r._qual || (h.qual || null);
        return r;
      });
    }));
    return { rows: qualityRows(results), best: bestOf(results), results: results };
  }

  function resetMemo() { resolveMemo = {}; }

  return { hubs: hubs, qualityRows: qualityRows, bestOf: bestOf, resetMemo: resetMemo };
})();
```

Note: `Resolve` must be defined in IIFE scope AFTER `modeReady` (`var modeReady = probeMode();` exists at line ~215) so `modeReady` is initialized when the module's closures run. Place it after the `directHref` function and before `parseFilenameTags`.

- [ ] **Step 2: Rewire `doSearch` to the module**

In `doSearch`, delete the moved block (the lines between the poster worker and `async function resolveCard`) plus `resolveCard`, `cardQueue`, `cardWorker` and their invocation. Replace the per-card resolution worker (the `cardQueue`/`cardWorker` section at the end of `doSearch`) with a single call that resolves all cards using the module:

```js
await Promise.all(cards.filter(function (c) { return c.hubs.length; })
  .map(async function (c) {
    const out = await Resolve.hubs(c.hubs, c.archive);
    if (id !== renderId) return;
    if (out.rows.length) paintRowsInto(c.card.querySelector(".actions"), out.rows);
    else paintFallbackRow(c);
    const best = out.best;
    if (best) {
      const badge = c.card.querySelector(".quality-badge");
      if (badge && best.quality) badge.textContent = best.quality;
      const sizeEl = c.card.querySelector("[data-size]");
      if (sizeEl && best.size) { sizeEl.textContent = formatBytes(best.size); sizeEl.style.display = "inline-block"; }
      const posterLink = c.card.querySelector(".poster-link");
      if (posterLink) posterLink.href = directHref(best.direct);
    }
  }));
```

Add two module-scoped UI helpers next to `Resolve` (used by both views):

```js
// Insert download rows into a container (best quality first), or a single
// "Via redirect" fallback row when nothing resolved.
function paintRowsInto(container, rows) {
  const source = container && container.querySelector(".open.secondary");
  if (!container) return;
  const old = container.querySelector(".qrow");
  if (old) old.remove();
  rows.forEach(function (rr) {
    const q = rr.quality || rr._qual || null;
    const parts = [];
    if (q) parts.push(q);
    if (rr.size) parts.push(formatBytes(rr.size));
    const a = document.createElement("a");
    a.className = "qrow done";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.href = directHref(rr.direct);
    a.title = "Direct link";
    a.innerHTML = '<span class="qlabel">' + esc(parts.length ? parts.join(" · ") : "Direct") + '</span>' +
                  '<span class="qbtn">Download</span>';
    container.insertBefore(a, source);
  });
}
function paintFallbackRow(c) {
  const row = c.card.querySelector(".qrow");
  if (!row) return;
  const qlabel = row.querySelector("[data-qlabel]");
  const qbtn = row.querySelector("[data-qbtn]");
  qlabel.textContent = c.quals !== "—" ? c.quals : "File";
  qbtn.textContent = "Via redirect";
  row.title = "Direct resolve failed — opens the source redirect page.";
  row.classList.add("bad");
}
```

Delete the now-unused `paintRows` and `paintFallback` closures inside `doSearch`.

- [ ] **Step 3: JS syntax check**

```bash
cd /home/jawad/Desktop/hblinks-tool && node -e "
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
new Function(m[1]);
console.log('JS syntax OK');
"
```
Expected: `JS syntax OK`.

- [ ] **Step 4: Browser regression check (local mode)**

`curl -sL http://localhost:8000/ | grep -c "Resolve"` should be ≥ 2. Then in a browser at `http://localhost:8000/`, search `silo s03`, wait 20s. Expected: every card still shows per-quality "Download" rows (or "Via redirect"), no duplicates per quality, no console exceptions.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "refactor: hoist resolution engine into shared Resolve module"
```

---

### Task 2: Seasonal parsing + show layout helpers

**Files:**
- Modify: `index.html` (add two pure functions near `parseTitle`; add a node test file under `/tmp`)

**Interfaces:**
- Consumes: `parseTitle(title)` → `{ raw, name, year, qualities }` (existing), `normKey(s)` (existing)
- Produces:
  - `parseSeasonal(title)` → `{ season: number|null, episode: number|null, isSeasonPack: boolean }`
  - `layOutGroup(group)` → `{ name, year, seasonList, orphanEpisodes, movies }` where
    - `seasonList`: `Array<{ season:number, episodeItems:Array<item>, packItems:Array<item> }>` sorted ascending by season; episodeItems sorted by episode number; packItems sorted by best quality rank first
    - `orphanEpisodes`, `movies`: arrays of items
    - `item` = `{ post, parsed, seasonal, key }` (key = `"p" + post.id`)

- [ ] **Step 1: Write the node unit test first**

Create `/tmp/seasonal-test.js`:

```js
const fs = require("fs");
const html = fs.readFileSync("/home/jawad/Desktop/hblinks-tool/index.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const src = m[1];
// Extract the two pure functions by name so we can unit-test them in node.
function grab(fnName) {
  const i = src.indexOf("function " + fnName);
  if (i < 0) throw new Error("missing " + fnName);
  const start = src.indexOf("{", i);
  let depth = 0, j = start, inStr = null, inTpl = false;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (inStr) { if (ch === inStr && src[j - 1] !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  return "(function " + fnName + src.slice(start, j + 1) + ")";
}
global.normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(the|a|an)\b/g, "").trim();
global.parseTitle = eval(grab("parseTitle"));
global.parseSeasonal = eval(grab("parseSeasonal"));

const assert = require("assert");
// parseSeasonal
assert.deepStrictEqual(parseSeasonal("Silo S03E10 1080p"), { season: 3, episode: 10, isSeasonPack: false });
assert.deepStrictEqual(parseSeasonal("Silo S03 1080p"), { season: 3, episode: null, isSeasonPack: true });
assert.deepStrictEqual(parseSeasonal("Jumanji 2017 720p"), { season: null, episode: null, isSeasonPack: false });
assert.deepStrictEqual(parseSeasonal("Sil S03E01-E05"), { season: 3, episode: null, isSeasonPack: true });

// layOutGroup
const mkItem = (t, id) => ({ post: { id, title: t, link: "https://x/" + id, date: "2026-01-01", direct: [], allLinks: [] }, parsed: parseTitle(t), seasonal: parseSeasonal(t), key: "p" + id });
const group = {
  name: "Silo", year: "2023", key: "silo",
  items: [
    mkItem("Silo.S03.1080p", 1),
    mkItem("Silo.S03E10.720p", 2),
    mkItem("Silo.S03E09.480p", 3),
    mkItem("Silo.S01E01.1080p", 4),
    mkItem("A.Standalone.720p", 5),
    mkItem("Silo.S03E10.2160p", 6)
  ]
};
global.layOutGroup = eval(grab("layOutGroup"));
const laid = layOutGroup(group);
assert.strictEqual(laid.seasonList.length, 2); // S01, S03
assert.strictEqual(laid.seasonList[0].season, 1);
assert.strictEqual(laid.seasonList[1].season, 3);
const s3 = laid.seasonList[1];
assert.strictEqual(s3.episodeItems.length, 3);  // E09, E10(720), E10(2160)
assert.strictEqual(s3.episodeItems[0].seasonal.episode, 9);
assert.strictEqual(s3.packItems.length, 1);
assert.strictEqual(laid.movies.length, 1);
console.log("seasonal tests PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node /tmp/seasonal-test.js`
Expected: FAIL with `Error: missing parseSeasonal`.

- [ ] **Step 3: Implement `parseSeasonal` and `layOutGroup`**

Add after `parseTitle` (line ~306):

```js
// Season/episode markers from a release title.
//   "Silo.S03E10.1080p" -> { season:3, episode:10, isSeasonPack:false }
//   "Silo.S03.1080p"    -> { season:3, episode:null, isSeasonPack:true }
function parseSeasonal(title) {
  const t = String(title || "").toUpperCase();
  const s = /\bS(\d{1,2})\b/.exec(t);
  const e = /\bE(\d{1,3})\b/.exec(t);
  const season = s ? parseInt(s[1], 10) : null;
  const episode = e ? parseInt(e[1], 10) : null;
  // A season number without an episode number = a whole-season pack
  // ("S03", "S03.COMPLETE", "S03E01-E05" all collapse to the season).
  const isSeasonPack = season !== null && episode === null;
  return { season, episode, isSeasonPack };
}

function qualRankOf(item) {
  const qs = item.parsed.qualities;
  const rankMap = { "2160P": 4, "4K": 4, "1080P": 3, "720P": 2, "480P": 1, "360P": 0 };
  let best = -1;
  qs.forEach(function (q) { const r = rankMap[q] != null ? rankMap[q] : -1; if (r > best) best = r; });
  return best;
}

// Organize one show group into seasons + standalone cards.
function layOutGroup(group) {
  const seasonMap = new Map();
  const orphanEpisodes = [];
  const movies = [];
  group.items.forEach(function (item) {
    const se = item.seasonal;
    if (se.season !== null) {
      if (!seasonMap.has(se.season)) seasonMap.set(se.season, { season: se.season, episodeItems: [], packItems: [] });
      const bucket = seasonMap.get(se.season);
      if (se.isSeasonPack) bucket.packItems.push(item);
      else bucket.episodeItems.push(item);
    } else if (se.episode !== null) {
      orphanEpisodes.push(item);
    } else {
      movies.push(item);
    }
  });
  const seasonList = Array.from(seasonMap.values()).sort(function (a, b) { return a.season - b.season; });
  seasonList.forEach(function (b) {
    b.episodeItems.sort(function (a, c) { return (a.seasonal.episode || 0) - (c.seasonal.episode || 0); });
    b.packItems.sort(function (a, c) { return qualRankOf(c) - qualRankOf(a); });
  });
  return { name: group.name, year: group.year, seasonList: seasonList, orphanEpisodes: orphanEpisodes, movies: movies };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node /tmp/seasonal-test.js`
Expected: `seasonal tests PASS`.

- [ ] **Step 5: JS syntax check**

Run the syntax check from Task 1 Step 3. Expected: `JS syntax OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: season/episode parsing and show layout helpers"
```

---

### Task 3: View containers + hash router skeleton

**Files:**
- Modify: `index.html` (body markup, CSS additions, router + state)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - DOM: `#view-search`, `#view-detail` containers inside `.container`
  - `state` object: `{ posts, postById, groups, currentKey, query }`
  - `parseHash()` → `{ view: "search" } | { view: "detail", key }`
  - `renderRoute()` — swaps views; detail stub until Task 6
  - `openDetail(postId)` — sets `state.currentKey`, remembers scroll, sets `location.hash`
  - `goHome()` — sets `location.hash = "#/"`

- [ ] **Step 1: Add view container markup**

Replace the `#results` line in the body (line ~123):

```html
<div id="view-search">
  <div id="status" class="status"><div class="spin"></div><div>Ready…</div></div>
  <div id="results"></div>
  <div class="footer-note">
    Movie artwork is shown via Wikipedia and TVMaze. All download buttons point to the source release pages.
    Only download content you are authorised to access.
  </div>
</div>
<div id="view-detail" style="display:none"></div>
```

(Note: `#status` and `#results` move inside `#view-search`; the mode label `#mode` stays above.)

- [ ] **Step 2: Add CSS**

Append to the `<style>` block (before the closing `</style>`):

```css
  #view-search { display: block; }
  #view-detail { min-height: 60vh; }
  .back-btn {
    display: inline-flex; align-items: center; gap: 8px; margin: 6px 0 18px;
    padding: 9px 16px; font-size: 13px; font-weight: 600; color: var(--text);
    background: rgba(255,255,255,.04); border: 1px solid var(--border); border-radius: 9px;
    text-decoration: none; transition: border-color .15s, background .15s;
  }
  .back-btn:hover { border-color: var(--accent); background: rgba(255,255,255,.07); }
  .detail-body { display: flex; flex-direction: column; gap: 22px; }
```

- [ ] **Step 3: Add router + state**

Near the top of the IIFE (after the element refs `qInput`/`btn`/`statusEl`/`resultsEl`):

```js
var state = { posts: [], postById: {}, groups: [], currentKey: null, query: "" };

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  const m = /^\/detail\/(p\d+)$/.exec(h);
  if (m) return { view: "detail", key: m[1] };
  return { view: "search", key: null };
}

function openDetail(postId) {
  state.currentKey = "p" + postId;
  state.scrollTop = window.scrollY;
  location.hash = "#/detail/p" + postId;
}

function goHome() {
  location.hash = "#/";
}

function renderRoute() {
  const route = parseHash();
  const sv = document.getElementById("view-search");
  const dv = document.getElementById("view-detail");
  if (route.view === "detail") {
    sv.style.display = "none";
    dv.style.display = "block";
    renderDetail(route.key);   // stub in this task, real in Task 6
  } else {
    dv.style.display = "none";
    sv.style.display = "block";
    if (state.query) {
      qInput.value = state.query;
      // Re-render cached results without refetching the API.
      if (state.groups.length) renderView1(state.groups, state.query);
      else doSearch();
    }
  }
}
window.addEventListener("hashchange", renderRoute);
```

Add a stub `renderDetail` (replaced in Task 6) and a temporary `renderView1` alias so nothing throws during this task. The stub:

```js
function renderDetail(key) {
  const dv = document.getElementById("view-detail");
  dv.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">' +
    '<a class="back-btn" href="#/">← Back to results</a><br><br>Detail view (built in a later task) for <b>' + esc(key) + '</b></div>';
}
```

For `renderView1`, until Task 5 does the real rebuild, point it at re-running the existing search render — add this temporary alias (deleted in Task 5):

```js
function renderView1(groups, query) {
  doSearch(); // temporary — replaced by the real view-1 render in Task 5
}
```

- [ ] **Step 4: Wire search input to the router**

On page load, if the hash is `#/`, show the search view; if it's a detail hash from a refresh, `renderRoute` handles it. Change the initial `statusEl.innerHTML` bootstrap line (bottom of IIFE) to also call `renderRoute()` once:

```js
statusEl.innerHTML = '<div class="hint" style="padding:0">Enter a movie title above. e.g. <b>Inception</b>, <b>Jeevan</b>. Release details open with one click.</div>';
renderRoute();
```

- [ ] **Step 5: JS syntax check**

Run the syntax check from Task 1 Step 3. Expected: `JS syntax OK`.

- [ ] **Step 6: Browser check**

Open `http://localhost:8970/#/` and `http://localhost:8970/#/detail/p123456` directly. Expected: search view renders normally for `#/`; detail stub (back link + "Detail view") renders for the detail hash; clicking `← Back to results` returns to `#/`.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: hash router with search/detail view containers"
```

---

### Task 4: TVMaze metadata fetch

**Files:**
- Modify: `index.html` (add `fetchTvMazeMeta` next to `fetchPoster`)

**Interfaces:**
- Consumes: `normKey(s)`, `stripHtml(s)` (existing)
- Produces: `fetchTvMazeMeta(name)` → `Promise<{ poster, summary, genres, year, rating, network } | null>`, cached in `metaCache` keyed by `normKey(name)`

- [ ] **Step 1: Implement**

Add after `fetchPoster` (line ~407):

```js
const metaCache = new Map();
async function fetchTvMazeMeta(name) {
  const key = normKey(name);
  if (metaCache.has(key)) return metaCache.get(key);
  let out = null;
  try {
    const r = await fetch("https://api.tvmaze.com/singlesearch/shows?q=" + encodeURIComponent(name));
    if (r.ok) {
      const d = await r.json();
      out = {
        poster: (d.image && (d.image.original || d.image.medium)) || null,
        summary: d.summary ? stripHtml(d.summary) : "",
        genres: d.genres || [],
        year: d.premiered ? String(d.premiered).slice(0, 4) : "",
        rating: (d.rating && d.rating.average) || null,
        network: (d.network && d.network.name) || null
      };
    }
  } catch (e) { out = null; }
  metaCache.set(key, out);
  return out;
}
```

- [ ] **Step 2: JS syntax check**

Run the syntax check from Task 1 Step 3. Expected: `JS syntax OK`.

- [ ] **Step 3: Browser check**

In the browser at `http://localhost:8970/`, run in the console:

```js
fetchTvMazeMeta("Silo").then((m) => console.log("META", m && m.name, !!m, m && m.summary.slice(0, 60)));
```

Wait — `fetchTvMazeMeta` is inside the IIFE, so it is not reachable from the console. Verify instead by temporarily adding after the bootstrap line: `fetchTvMazeMeta("Silo").then(function (m) { console.log("TVMAZE", m); });`. Expected: console shows `TVMAZE { poster, summary, genres, year, rating, network }` (poster non-null for "Silo"). Remove this temporary line before committing.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: TVMaze metadata fetch for detail view"
```

---

### Task 5: Rebuild View 1 (season headers + cards, no inline resolution)

**Files:**
- Modify: `index.html` (doSearch render path, CSS)

**Interfaces:**
- Consumes: `layOutGroup(group)`, `parseSeasonal(title)`, `Resolve.resetMemo()`, `fetchPoster(name, year)`, `posterCache`
- Produces: `renderView1(groups, query)` — renders the full search view into `#results`; `buildCard(item, group)` — returns a card element; cards are `<a href="#/detail/p<postId>">` so hash navigation works without JS click handlers. The Task 3 temporary `renderView1` alias is replaced.

- [ ] **Step 1: Rewrite the doSearch render path**

Replace everything inside `doSearch` from `const grid = document.createElement("div");` through the end of the resolution worker section (lines ~492–871) with:

```js
    renderView1(groups, query);
    state.groups = groups;
    state.posts = posts;
    state.query = query;
    Resolve.resetMemo();
```

Store `state.postById` earlier in `doSearch`, right after `posts` is computed (line ~455):

```js
      state.postById = {};
      posts.forEach(function (p) { state.postById["p" + p.id] = p; });
```

- [ ] **Step 2: Implement `renderView1`**

Add at IIFE scope (after `layOutGroup`):

```js
function renderView1(groups, query) {
  resultsEl.innerHTML = "";
  statusEl.style.display = "none";
  const stats = document.createElement("div");
  stats.className = "stats";
  const totalPosts = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
  stats.innerHTML = 'Found <b>' + groups.length + '</b> title(s) — <b>' + totalPosts + '</b> release(s). ' +
    'Open a release to see every quality as a direct download.';
  resultsEl.appendChild(stats);

  groups.forEach(function (group) {
    const laid = layOutGroup(group);
    const showHeading = document.createElement("div");
    showHeading.className = "show-header";
    showHeading.textContent = laid.name + (laid.year ? " (" + laid.year + ")" : "");
    resultsEl.appendChild(showHeading);

    const backdrop = document.createElement("div");
    backdrop.className = "season-block";

    // Season sections
    laid.seasonList.forEach(function (bucket) {
      const h = document.createElement("div");
      h.className = "season-header";
      h.textContent = "Season " + bucket.season;
      backdrop.appendChild(h);

      const grid = document.createElement("div");
      grid.className = "results-grid";
      var releaseItems = bucket.packItems.concat(bucket.episodeItems);
      releaseItems.forEach(function (item) { grid.appendChild(buildCard(item, group)); });
      backdrop.appendChild(grid);
    });

    // Orphan episodes (have an episode number but no season in the title)
    if (laid.orphanEpisodes.length) {
      const h = document.createElement("div");
      h.className = "season-header";
      h.textContent = "Episodes";
      backdrop.appendChild(h);
      const grid = document.createElement("div");
      grid.className = "results-grid";
      laid.orphanEpisodes.forEach(function (item) { grid.appendChild(buildCard(item, group)); });
      backdrop.appendChild(grid);
    }

    // Standalone movies
    if (laid.movies.length) {
      const grid = document.createElement("div");
      grid.className = "results-grid";
      laid.movies.forEach(function (item) { grid.appendChild(buildCard(item, group)); });
      backdrop.appendChild(grid);
    }

    resultsEl.appendChild(backdrop);
  });

  runPosterWorkers(groups);
}
```

- [ ] **Step 3: Implement `buildCard`**

Add at IIFE scope:

```js
function buildCard(item, group) {
  const quals = item.parsed.qualities.length ? item.parsed.qualities.join(" · ") : "—";
  const ep = item.seasonal.episode;
  const epBadge = ep ? '<span class="ep-badge">E' + String(ep).padStart(2, "0") + '</span>' : "";
  const card = document.createElement("a");
  card.className = "card detail-card";
  card.href = "#/detail/p" + item.post.id;
  card.innerHTML =
    '<div class="poster">' +
      '<div class="noimg" data-note>Fetching poster…</div>' +
      '<span class="quality-badge">' + esc(quals) + '</span>' +
      epBadge +
    '</div>' +
    '<div class="card-body">' +
      '<div class="card-title">' + esc(item.parsed.name) + '</div>' +
      '<div class="meta">' + esc(item.post.title) + '</div>' +
      '<div class="card-tags" data-tags></div>' +
      '<span class="details-btn">Open release →</span>' +
    '</div>';
  return card;
}
```

- [ ] **Step 4: Implement `runPosterWorkers`**

Adapt the existing poster worker (it currently lives inside `doSearch`) into IIFE scope so View 1 re-renders reuse it:

```js
function runPosterWorkers(groups) {
  const cards = Array.from(resultsEl.querySelectorAll(".detail-card"));
  const CONC = 4;
  let i = 0;
  async function worker() {
    while (i < groups.length) {
      const group = groups[i++];
      if (group.poster) continue;
      group.poster = await fetchPoster(group.name, group.year);
      const imgs = Array.from(resultsEl.querySelectorAll(".detail-card"));
      const home = (group.key || "").toLowerCase();
      imgs.forEach(function (card) {
        const title = card.querySelector(".card-title");
        if (title && normKey(title.textContent) === home) {
          const note = card.querySelector("[data-note]");
          const poster = card.querySelector(".poster");
          if (group.poster) {
            const img = document.createElement("img");
            img.loading = "lazy";
            img.decoding = "async";
            img.alt = group.name;
            img.src = group.poster;
            img.onerror = function () { if (note) note.textContent = "Poster unavailable"; };
            if (note) note.remove();
            poster.appendChild(img);
          } else if (note) {
            const init = group.name.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join("") || "?";
            poster.classList.add("ph");
            note.innerHTML = '<div class="phinit">' + esc(init) + '</div>';
          }
        }
      });
    }
  }
  return Promise.all(Array.from({ length: Math.min(CONC, groups.length) }, worker));
}
```

Simpler alternative for Step 4 if the matching is fiddly: keep the existing inline poster worker in `doSearch` UNCHANGED and call `renderView1` to render cards first, then run posters after. If you use the inline version instead, note that `renderView1` re-render on Back re-runs it (harmless — `c.group.poster` is cached and skips refetch). The `runPosterWorkers` above is the recommended version.

- [ ] **Step 5: Add View-1 CSS**

Append to `<style>`:

```css
  .show-header {
    margin: 26px 2px 10px; font-size: 17px; font-weight: 700; letter-spacing: -0.3px;
    border-left: 4px solid var(--accent); padding-left: 12px;
  }
  .season-block { margin-bottom: 8px; }
  .season-header {
    margin: 18px 2px 10px; font-size: 13px; font-weight: 700; color: var(--muted);
    text-transform: uppercase; letter-spacing: 1px;
  }
  .ep-badge {
    position: absolute; bottom: 10px; left: 10px; background: rgba(0,0,0,.78);
    color: #ffb98f; font-size: 11px; font-weight: 700; padding: 4px 9px;
    border-radius: 6px; border: 1px solid rgba(255,107,53,.3);
  }
  .details-btn {
    display: block; text-align: center; padding: 9px 8px; font-size: 13px; font-weight: 600;
    color: var(--accent); background: rgba(255,107,53,.08);
    border: 1px solid rgba(255,107,53,.25); border-radius: 8px; margin-top: 4px;
  }
  a.detail-card { text-decoration: none; color: inherit; }
  a.detail-card:hover .details-btn { background: var(--accent); color: #fff; }
```

- [ ] **Step 6: Delete the temporary `renderView1` alias**

The Task 3 stub `function renderView1(groups, query) { doSearch(); }` must be removed; the real one above replaces it. Also delete the leftover `paintRows`/`paintFallback` closures and the old poster-worker block inside `doSearch` if not already removed in Task 1.

- [ ] **Step 7: JS syntax check**

Run the syntax check from Task 1 Step 3. Expected: `JS syntax OK`.

- [ ] **Step 8: Browser check (local + static)**

Local: `http://localhost:8000/`, search `silo`. Expected: show header "Silo (2023)" with "Season 3" header; episode cards (E09, E10…) each with quality badge and "Open release →"; NO download rows on View 1; clicking a card changes the hash to `#/detail/p…` and shows the stub (Task 6 wires the real detail).
Static: same on `http://localhost:8970/`.

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "feat: view 1 season grouping with episode cards, no inline resolution"
```

---

### Task 6: Implement the detail view (View 2)

**Files:**
- Modify: `index.html` (replace stub `renderDetail`, add CSS)

**Interfaces:**
- Consumes: `state.postById`, `parseTitle(title)`, `parseSeasonal(title)`, `fetchTvMazeMeta(name)`, `Resolve.hubs(hubs, archiveUrl)`, `paintRowsInto(container, rows)`, `directHref(u)`, `formatBytes(n)`, `esc(s)`, `parseFilenameTags(name)`
- Produces: `renderDetail(key)` — async, renders hero + metadata + resolved quality rows into `#view-detail`; scrolls to top; re-checks `state.currentKey` after each await (stale guard)

- [ ] **Step 1: Replace the stub `renderDetail`**

```js
async function renderDetail(key) {
  const dv = document.getElementById("view-detail");
  const post = state.postById[key];
  if (!post) {
    dv.innerHTML = '<div class="error-box">That release is no longer available. <a href="#/" style="color:var(--accent)">← Back to results</a></div>';
    window.scrollTo(0, 0);
    return;
  }
  dv.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--muted)">' +
    '<div class="spin"></div><div>Loading release…</div></div>';

  const item = { post: post, parsed: parseTitle(post.title), seasonal: parseSeasonal(post.title) };
  const meta = await fetchTvMazeMeta(item.parsed.name);
  if (state.currentKey !== key) return;

  const hubs = (post.direct || []).map(function (h) { return { url: h.url || h, qual: h.qual || null }; });
  const resolved = await (hubs.length ? Resolve.hubs(hubs, post.link)
    : Promise.resolve({ rows: [], best: null, results: [] }));
  if (state.currentKey !== key) return;

  const badgeLine = item.parsed.qualities.length ? item.parsed.qualities.join(" · ") : null;
  const rowsHtml = resolved.rows.length
    ? resolved.rows.map(function (rr) {
        const q = rr.quality || rr._qual || null;
        const parts = [];
        if (q) parts.push(q);
        if (rr.size) parts.push(formatBytes(rr.size));
        return '<a class="qrow done" target="_blank" rel="noopener noreferrer" href="' + esc(directHref(rr.direct)) + '" title="Direct link">' +
                 '<span class="qlabel">' + esc(parts.length ? parts.join(" · ") : "Direct") + '</span>' +
                 '<span class="qbtn">Download</span>' +
               '</a>';
      }).join("")
    : '<a class="qrow bad" target="_blank" rel="noopener noreferrer" href="' + esc(post.link) + '" title="Direct resolve failed — opens the source redirect page.">' +
        '<span class="qlabel">' + esc(badgeLine || "File") + '</span>' +
        '<span class="qbtn">Via redirect</span>' +
      '</a>';

  dv.innerHTML =
    '<a class="back-btn" href="#/">← Back to results</a>' +
    '<div class="detail-body">' +
      '<div class="detail-hero">' +
        '<div class="detail-poster">' +
          (meta && meta.poster
            ? '<img src="' + esc(meta.poster) + '" alt="' + esc(item.parsed.name) + '" onerror="this.style.display=\'none\'">'
            : '<div class="noimg">Poster unavailable</div>') +
        '</div>' +
        '<div class="detail-info">' +
          '<div class="detail-title">' + esc(item.parsed.name + (item.parsed.year ? " (" + item.parsed.year + ")" : "")) + '</div>' +
          '<div class="meta">' + esc(post.title) + '</div>' +
          (badgeLine ? '<div class="card-tags" style="display:flex">' + badgeLine.split(" · ").map(function (q) { return "<span>" + esc(q) + "</span>"; }).join("") + '</div>' : "") +
          (meta ? '<div class="detail-chips">' +
                    ([meta.year ? meta.year : "", meta.genres.join(", "), meta.rating ? "★ " + meta.rating : "", meta.network || ""]
                      .filter(Boolean).map(function (c) { return '<span>' + esc(c) + '</span>'; }).join("")) +
                  '</div>' : "") +
          (meta && meta.summary ? '<div class="detail-synopsis">' + esc(meta.summary) + '</div>' : "") +
        '</div>' +
      '</div>' +
      '<div class="detail-links">' +
        '<div class="season-header" style="margin-top:0">Download</div>' +
        '<div class="actions">' + rowsHtml + '</div>' +
        '<a class="open secondary" style="margin-top:10px" href="' + esc(post.link) + '" target="_blank" rel="noopener noreferrer" title="Open the source page">Source</a>' +
      '</div>' +
    '</div>';

  // Tags from the best resolved filename (codec, audio, subs…).
  if (resolved.best && resolved.best.filename) {
    const tags = parseFilenameTags(resolved.best.filename);
    if (tags.length) {
      const tagBox = dv.querySelector(".detail-info");
      const chip = document.createElement("div");
      chip.className = "card-tags";
      chip.style.display = "flex";
      chip.style.marginTop = "6px";
      chip.innerHTML = tags.map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("");
      tagBox.appendChild(chip);
    }
  }
  window.scrollTo(0, 0);
}
```

- [ ] **Step 2: Add detail CSS**

Append to `<style>`:

```css
  .detail-hero { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; }
  .detail-poster { width: 220px; max-width: 40vw; flex: 0 0 auto; }
  .detail-poster img { width: 100%; border-radius: 14px; border: 1px solid var(--border); display: block; }
  .detail-poster .noimg { aspect-ratio: 2/3; border: 1px solid var(--border); border-radius: 14px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
  .detail-info { flex: 1; min-width: 260px; display: flex; flex-direction: column; gap: 8px; }
  .detail-title { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
  .detail-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .detail-chips span { font-size: 11px; font-weight: 600; color: #c8d6e5; background: rgba(255,255,255,.05); border: 1px solid var(--border); padding: 4px 10px; border-radius: 999px; }
  .detail-synopsis { font-size: 13.5px; line-height: 1.6; color: #c3d0de; }
  .detail-links { margin-top: 6px; }
  .detail-links .actions { max-width: 640px; }
  @media (max-width: 560px) { .detail-hero { flex-direction: column; align-items: stretch; } .detail-poster { width: 100%; max-width: 240px; margin: 0 auto; } }
```

- [ ] **Step 3: Delete the stub `renderDetail`**

Remove the Task 3 stub.

- [ ] **Step 4: JS syntax check**

Run the syntax check from Task 1 Step 3. Expected: `JS syntax OK`.

- [ ] **Step 5: Browser check (local mode)**

`http://localhost:8000/` → search `silo s03` → click the "Silo S03E10" card. Expected: hash becomes `#/detail/p<postId>`; hero shows poster + title + synopsis + chips; Download section shows per-quality rows (2160P/1080P/720P/480P, each once) with direct links; no duplicates. Click any Download row → file download starts (r2.dev) or pixeldrain page. Click "← Back to results" → returns to View 1 with the same results (no refetch), and "Open release →" cards still present.

- [ ] **Step 6: Browser check (static mode)**

Same flow on `http://localhost:8970/`. Expected: hero + metadata appear; hubcdn-only releases resolve to r2.dev "Download" rows; a hubcloud-only release (e.g. `Silo.S03.1080p` movie card) shows a single "Via redirect" row pointing at the source page. No `/api/dl` or `localhost` URLs anywhere.

- [ ] **Step 7: Back-button scroll + refresh**

From detail, press browser Back. Expected: returns to `#/`, View 1 re-renders from cache, query preserved in the input. Refresh on a `#/detail/…` URL: detail re-renders (posts re-fetched via `doSearch` on load? If `state.posts` is empty on hard refresh, `renderRoute` must fall back to `doSearch()` first with the stored query — see Task 7 Step 1 which makes hard-refresh-detail work by falling back to a fetch of the default listing and matching the post id).

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: view 2 detail page with metadata and resolved quality rows"
```

---

### Task 7: Hard-refresh detail support, cleanup, and full verification

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces: nothing new — final polish + verification

- [ ] **Step 1: Make direct detail-URL refresh work**

On hard refresh at `#/detail/p<id>`, `state.posts` is empty, so `renderRoute` (detail branch) calls `renderDetail` with no cached post. Fix by making the detail branch ensure posts are loaded: change `renderRoute` so that when `route.view === "detail"` and `state.posts.length === 0`, it first runs `doSearch()` (default fetch), then calls `renderDetail(route.key)`:

```js
if (route.view === "detail") {
  sv.style.display = "none";
  dv.style.display = "block";
  if (state.posts.length) renderDetail(route.key);
  else doSearch().then(function () { renderDetail(route.key); });
}
```

Make `doSearch` return its promise (it is already `async` — just `return` at the end, e.g. `return renderView1(groups, query);` or simply ensure the async function resolves when done; if `doSearch` currently swallows errors, wrap the call site with `.catch(function () {})`).

- [ ] **Step 2: Remove leftover cruft**

Verify these are gone from `doSearch` and the IIFE:
- `paintRows`, `paintFallback` closure definitions (replaced by module helpers in Task 1)
- the temporary `renderView1` alias from Task 3
- the Task 3 `renderDetail` stub
- old `cardQueue`/`cardWorker` inline resolution
- any remaining reference to `qrow` rendering in the View-1 path

Grep: `grep -n "cardQueue\|cardWorker\|paintFallback(c)\|function paintRows\b" index.html` → expect no matches.

- [ ] **Step 3: Mode label + footer copy**

Update `MODE_LABEL` (unchanged semantics) and the footer note inside `#view-search` if desired. Also update the initial hint text (Task 3 Step 4 already did). Verify the mode label still appears after the probe.

- [ ] **Step 4: Full local-mode verification (Playwright)**

At `http://localhost:8000/`:
1. Search `silo` → expect "Silo (2023)" header, "Season 3" header, episode cards E01–E10 and at least one "S03 (Complete)" pack card.
2. Click S03E10 card → detail with 2160P/1080P/720P/480P rows (each once). No `localhost`/`/api/dl` hrefs anywhere.
3. Every quality label appears at most once per detail page: evaluate `document.querySelectorAll('.detail-links .qlabel')` and assert no duplicated quality tokens.
4. Browser Back → View 1 restored, query `silo` still in the input.
5. Full-page refresh while ON the detail hash → detail still renders.

- [ ] **Step 5: Full static-mode verification (Playwright)**

Repeat Step 4 at `http://localhost:8970/`:
1. Search `jumanji` → expect one "Jumanji" show with movie cards (or a season if the release has season tags).
2. Open a hubcloud-only release → single "Via redirect" row (no Download rows).
3. Open a hubcdn release → per-quality Download rows with `pub-*.r2.dev` hrefs.
4. Assert zero `http://localhost` or `/api/dl?` hrefs on the page: `Array.from(document.querySelectorAll('a')).filter(a => /localhost|api\/dl/.test(a.href)).length === 0`.

- [ ] **Step 6: One-click download check**

On a resolved Download row (r2.dev in static or local mode), click it. Expected: browser begins a file download (Playwright download event) rather than navigating to an error page.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: two-page redesign — search + detail views with hash routing"
```

- [ ] **Step 8: Update README (optional)**

If the README describes the old card-with-inline-links behavior, update the relevant lines to describe the two-view flow. Commit separately:

```bash
git add README.md
git commit -m "docs: describe two-view search/detail flow"
```

---

## Self-Review Notes

**Spec coverage:**
- §5 View 1 season headers + episode + complete-season cards → Task 2 (layout helpers) + Task 5 (render).
- §6 View 2 detail page (hero, metadata, per-quality rows, via-redirect fallback, source, back) → Task 4 (TVMaze) + Task 6.
- §3 hash routing, back/refresh → Task 3 (router) + Task 7 Step 1.
- §7 resolution reused on View 2 only → Task 1 (hoist) + Task 5 (remove from View 1) + Task 6.
- §2 screenshots out of scope, TVMaze preview → Task 4.
- §8 error handling (post gone, TVMaze miss, via-redirect fallback) → Task 6 `renderDetail` + Task 7.

**Placeholder scan:** All steps contain concrete code, exact anchors, or exact commands. No "TBD"/"handle edge cases" placeholders.

**Type consistency:**
- `parseSeasonal` returns `{ season, episode, isSeasonPack }` — used identically in Tasks 2, 5, 6.
- `layOutGroup` returns `{ seasonList:[{season, episodeItems, packItems}], orphanEpisodes, movies }` — Task 5 consumes exactly these names.
- `Resolve.hubs` returns `{ rows, best, results }` — Tasks 1, 6 consume exactly these.
- `paintRowsInto(container, rows)` / `paintFallbackRow(c)` — Task 1 defines, Task 6 uses `paintRowsInto` (Task 6 renders rows inline in `renderDetail` HTML instead of calling the helper — acceptable, both produce `.qrow` markup; the helper remains for any inline reuse).
- `renderView1(groups, query)` — Task 3 stub, Task 5 replaces, Task 7 removes the stub.
- `fetchTvMazeMeta(name)` → `{ poster, summary, genres, year, rating, network } | null` — Task 4 defines, Task 6 consumes.
- `state.postById` keyed `"p" + post.id`, matching `parseHash` regex `p\d+`, `openDetail` construction, and `buildCard` hrefs.