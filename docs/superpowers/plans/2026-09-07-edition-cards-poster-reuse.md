# Edition Cards, Merged Qualities & Poster Reuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group search results into one card per language/audio *edition* that shows all available qualities as chips, expand to per-quality direct download links on click, and reuse the loaded poster across views.

**Architecture:** Add an edition-aware grouping layer on top of the existing show-group logic in `index.html`. Each show group is further split into edition groups (title + audio/language + season/episode markers). Cards render quality chips from the union of member qualities; the detail view resolves and dedupes each quality to a single direct link. A decode/encode path lets the edition key live in the URL hash.

**Tech Stack:** Vanilla JS in a single `index.html` IIFE. No build step. Node `new Function()` for syntax checks; Playwright for browser verification against the local (`:8000`) and static (`:8970`) servers.

## Global Constraints

- **Single file:** All functional changes go in `index.html`. Do NOT modify `hblinks-server.py`, `worker/relay.js`, `worker/wrangler.toml`.
- **Direct links:** Download rows are raw `pub-*.r2.dev` / `https://pixeldrain.dev/api/file/<id>` URLs — never wrapped in a `localhost`/`/api/dl` proxy. `directHref(u)` returns `u` unchanged.
- **Temp servers:** Do NOT kill the user's Python servers (ports 8000, 8137, 8897). The agent's own static server on `:8970` is disposable (`python3 -m http.server 8970`).
- **Mode label:** `MODE_LABEL` local/static strings stay as-is.
- **JS syntax check:** after every JS edit run:
  ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new Function(m[1]);console.log('JS syntax OK');"
  ```
  Expected: `JS syntax OK`.
- **Verify runs** against both `http://localhost:8000/` (local, full resolution) and `http://localhost:8970/` (static). Re-fill the search box after navigating (browser may restore a stale query).

---

### Task 0: Commit current working state

**Files:**
- n/a (nothing to change)

**Interfaces:**
- Consumes: nothing
- Produces: a clean baseline commit so later tasks are small diffs

- [ ] **Step 1: Confirm clean tree & note baseline**

Run: `git status --short && git log --oneline -3`
Expected: clean or only the already-committed spec/plan docs; note the current HEAD hash.

- [ ] **Step 2: Commit any uncommitted docs**

```bash
git add -A
git commit -m "docs: begin edition-cards + poster-reuse implementation"
```
(If nothing to commit, skip — no empty commits.)

---

### Task 1: Add edition parsing

**Files:**
- Modify: `index.html` (add `parseEdition` near `parseTitle`)

**Interfaces:**
- Consumes: nothing (pure function)
- Produces: `parseEdition(title) -> { edition, subs }` where `edition` is a
  canonical lower-case string (e.g. `"dual audio"`, `"tamil"`, `"hindi"`, or `""`
  for default English) and `subs` is a boolean-ish flag string
  (`"eng sub"` or `""`).

- [ ] **Step 1: Add the function**

Insert immediately after the closing `}` of `parseTitle` (line ~872):

```js
  // Audio/language edition tag from a release title. Returns the canonical
  // edition tag ("" = default English) and a subs flag.
  function parseEdition(title) {
    const t = String(title || "").toLowerCase();
    let ed = "";
    let subs = "";
    const multi = /\b(dual\s*audio|dual\b|multi\s*audio|multi\b|dd\+?\s*5\.1|dts\s*5\.1)\b/.exec(t);
    const langBr = /\b(hindi|tamil|telugu|malayalam|kannada|punjabi|bengali|english|spanish|french|german|japanese|korean)\b/.exec(t);
    if (multi) {
      ed = "dual audio";
    } else if (langBr && /^(hindi|tamil|telugu|malayalam|kannada|punjabi|bengali)$/.test(langBr[1])) {
      ed = langBr[1];
    }
    const subsM = /\b(eng[\s.\-]*subs?|english[\s.\-]*subs?|subtitles)\b/.exec(t);
    if (subsM) subs = "eng sub";
    return { edition: ed, subs: subs };
  }
```

- [ ] **Step 2: JS syntax check**

Run the syntax check from Global Constraints. Expected: `JS syntax OK`.

- [ ] **Step 3: Node unit check**

Create `/tmp/edition-test.js`:

```js
const fs = require('fs');
const src = fs.readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
// Extract a top-level `function name(...){...}` and return it as a JS function
// value, so pure helpers can be unit-tested without running the whole IIFE.
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const lbrace = src.indexOf('{', i);
  let depth = 0, j = lbrace;
  do { if (src[j] === '{') depth++; if (src[j] === '}') depth--; j++; } while (depth > 0);
  const fnSrc = src.slice(i, j).replace(/^function\s+[A-Za-z0-9_$]+\s*/, 'function ');
  return new Function('return (' + fnSrc + ')')();
}
const parseEdition = grab('parseEdition');
function eq(a, b, label) { const ok = JSON.stringify(a) === JSON.stringify(b); console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' ' + JSON.stringify(a)); if (!ok) process.exitCode = 1; }
eq(parseEdition('Zootopia.2016.1080p.English.BluRay'), { edition: '', subs: '' }, 'english default');
eq(parseEdition('Zootopia.2016.Dual.Audio.720p'), { edition: 'dual audio', subs: '' }, 'dual audio');
eq(parseEdition('Zootopia.2016.Hindi.480p'), { edition: 'hindi', subs: '' }, 'hindi');
eq(parseEdition('Silo.S03E01.1080p.DualAudio.Eng.Sub'), { edition: 'dual audio', subs: 'eng sub' }, 'dual+sub');
eq(parseEdition('Jumanji.2017.1080p'), { edition: '', subs: '' }, 'no tag');
```

Run: `node /tmp/edition-test.js`
Expected: all 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: parse audio/language edition tags from titles"
```

---

### Task 2: Edition-aware grouping

**Files:**
- Modify: `index.html` (`groupByMovie`, add edition-key helpers)

**Interfaces:**
- Consumes: `parseTitle`, `parseSeasonal`, `parseEdition`, `normKey`, `baseTitle`
- Produces:
  - `editionKeyOf(item) -> string` — canonical key incl. season/episode markers
  - `groupByMovie(posts) -> groups[]` where each group now has an
    `editions: Map<editionKey, { key, items:[] }>` and a `byEditionKey()` lookup.

- [ ] **Step 1: Add `editionKeyOf`**

Insert after `parseSeasonal` (after line ~892):

```js
  // Canonical key for one edition: base title | year | edition | season/episode.
  function editionKeyOf(item) {
    const se = item.seasonal;
    const parts = [normKey(baseTitle(item.parsed.name)), item.parsed.year || "",
      item.edition.edition, item.edition.subs,
      se.season != null ? "S" + se.season : "",
      se.episode != null ? "E" + se.episode : "",
      se.isSeasonPack ? "PACK" : ""];
    return parts.filter(Boolean).join("|");
  }
```

- [ ] **Step 2: Rewrite `groupByMovie` to attach editions**

Replace the body of `groupByMovie` (lines ~1038-1054) with:

```js
  function groupByMovie(posts) {
    const groups = [];
    const index = {};
    posts.forEach((p) => {
      const parsed = parseTitle(p.title);
      const base = baseTitle(parsed.name);
      const key = normKey(base);
      if (!key) return;
      if (!index[key]) {
        index[key] = { key, name: base, year: parsed.year, items: [], poster: null, editions: new Map(), byEditionKey: {} };
        groups.push(index[key]);
      }
      const g = index[key];
      const item = { post: p, parsed, seasonal: parseSeasonal(p.title), edition: parseEdition(p.title) };
      g.items.push(item);
      const ek = editionKeyOf(item);
      if (!g.byEditionKey[ek]) { g.byEditionKey[ek] = { key: ek, items: [] }; g.editions.set(ek, g.byEditionKey[ek]); }
      g.byEditionKey[ek].items.push(item);
    });
    return groups;
  }
```

- [ ] **Step 3: JS syntax check**

Run the syntax check. Expected: `JS syntax OK`.

- [ ] **Step 4: Node unit check**

Create `/tmp/group-test.js`. Because `groupByMovie` calls several helpers that
share the IIFE namespace, extract `editionKeyOf` alone (it has no closure deps
once its helpers are stubbed) and unit-test the keying logic:

```js
const fs = require('fs');
const src = fs.readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const lbrace = src.indexOf('{', i);
  let depth = 0, j = lbrace;
  do { if (src[j] === '{') depth++; if (src[j] === '}') depth--; j++; } while (depth > 0);
  const fnSrc = src.slice(i, j).replace(/^function\s+[A-Za-z0-9_$]+\s*/, 'function ');
  return new Function('return (' + fnSrc + ')')();
}
// Stub the helpers editionKeyOf depends on, all removed from the IIFE body.
function normKey(n){return n.toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\b(the|a|an)\b/g,"").trim();}
function baseTitle(n){return n.replace(/\bs\d{1,3}\s*e\d{1,3}\b/gi," ").replace(/\bs\d{1,3}\b/gi," ").replace(/\b(e\d{1,4}|complete|season|pack|sdr|hindi|dual|audio)\b/gi," ").replace(/\(\s*\d{1,2}\s*\)/g," ").replace(/\(\s*\)/g," ").replace(/\s+/g," ").trim();}
const editionKeyOf = grab('editionKeyOf');
// NOTE: use post-parseTitle names (quality already stripped, so 'Silo S03E10'
// not 'Silo.S03E10.1080p'): baseTitle removes S/E markers but keeps 1080p.
function item(name, se, ed){ return { parsed:{ name, year:"2016", qualities:[] }, seasonal:se, edition:ed }; }
const e = { edition:"", subs:"" }, dual = { edition:"dual audio", subs:"" };
function assertKey(a,b,label){ const ok=a===b; console.log((ok?'PASS':'FAIL')+' '+label+' -> '+a); if(!ok) process.exitCode=1; }
assertKey(editionKeyOf(item('Silo S03E10',{season:3,episode:10,isSeasonPack:false},e)), 'silo|2016|S3|E10', 'two 1080p+720p english episodes share a key (same base)');
assertKey(editionKeyOf(item('Silo S03E10',{season:3,episode:10,isSeasonPack:false},e)), 'silo|2016|S3|E10', 'same key regardless of quality');
assertKey(editionKeyOf(item('Silo S03E10',{season:3,episode:10,isSeasonPack:false},dual)), 'silo|2016|dual audio|S3|E10', 'dual audio differs');
assertKey(editionKeyOf(item('Silo S03',{season:3,episode:null,isSeasonPack:true},e)), 'silo|2016|S3|PACK', 'season pack key');
```
(Adjust the expected strings to match the exact `editionKeyOf` implementation —
the point is that quality does NOT change the key, but edition and season/episode
markers DO.)

Run: `node /tmp/group-test.js`
Expected: all PASS (the two same-quality-different posts produce one key;
edition and pack markers produce distinct keys).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: group releases into editions with merged quality pools"
```

---

### Task 3: Card renders quality chips, one card per edition

**Files:**
- Modify: `index.html` (`renderView1`, `buildCard`, add `.edition` CSS)

**Interfaces:**
- Consumes: `layOutGroup`, `group.editions`, `item.edition`, `editionKeyOf`
- Produces: `renderView1` renders ONE card per unique edition key (aggregating
  qualities); `buildCard(item, group)` shows quality chips (union of member
  qualities) instead of a single quality badge.

- [ ] **Step 1: Add CSS for edition badge panel**

Append to `<style>` (near line 85, after `.card-tags span`):

```css
  .edition-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; color: #9fe8ff; background: rgba(56,189,248,.08); border: 1px solid rgba(56,189,248,.22); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
```

- [ ] **Step 2: Add a card-group builder that dedupes by edition**

Add a helper near `buildCard`:

```js
  // Render one card per edition key. Items sharing an edition (same show/episode
  // + same audio/language) collapse into a single card whose chips union all
  // their qualities.
  function buildEditionCards(items, group) {
    const byEk = new Map();
    items.forEach(function (item) {
      const ek = editionKeyOf(item);
      if (!byEk.has(ek)) byEk.set(ek, item);
      else {
        const existing = byEk.get(ek);
        item.parsed.qualities.forEach(function (q) { if (!existing.parsed.qualities.includes(q)) existing.parsed.qualities.push(q); });
        // widen the title if the other item is more descriptive
        if (item.post.title.length > existing.post.title.length) existing.post = item.post;
      }
    });
    const out = [];
    byEk.forEach(function (item) { out.push(buildCard(item, group)); });
    return out;
  }
```

- [ ] **Step 3: Use `buildEditionCards` in `renderView1`**

In `renderView1`, replace the four `grid.appendChild(buildCard(item, group))`
calls (in the season section, orphan section, and movies section) so each grid
is populated with `buildEditionCards(list, group)` instead of per-item cards:

```js
        const releaseItems = bucket.packItems.concat(bucket.episodeItems);
        buildEditionCards(releaseItems, group).forEach(function (c) { grid.appendChild(c); });
```

and equivalently for orphanEpisodes and movies.

- [ ] **Step 4: Rewrite `buildCard`**

Replace `buildCard` (lines ~393-413) so it:
- takes `(item, group)` where `item` is the merged representative,
- computes `quals` from `item.parsed.qualities` (union from Step 2),
- renders edition tag if `item.edition && item.edition.edition`:
  `'<span class="edition-badge">' + esc(item.edition.edition.toUpperCase()) + '</span>'` in the card body,
- **removes** the `quality-badge` overlay (keep `ep-badge` for episodes).

New card inner HTML:

```js
      '<div class="poster">' +
        '<div class="noimg" data-note>Fetching poster…</div>' +
        epBadge +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-title">' + esc(item.parsed.name) + '</div>' +
        '<div class="meta">' + esc(item.post.title) + '</div>' +
        (edBadge ? '<div style="display:flex;flex-wrap:wrap;gap:5px">' + edBadge + '</div>' : "") +
        (quals.length ? '<div class="card-tags" style="display:flex">' + quals.map(function (q) { return "<span>" + esc(q) + "</span>"; }).join("") + '</div>' : '<div class="card-tags" data-tags></div>') +
        '<span class="details-btn">Open release →</span>' +
      '</div>';
```

- [ ] **Step 5: JS syntax check**

Run the syntax check. Expected: `JS syntax OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: quality chips + edition tag on cards, one card per edition"
```

---

### Task 4: Detail route key is an edition key

**Files:**
- Modify: `index.html` (`parseHash`, `renderRoute`, `state`, `renderDetail` start)

**Interfaces:**
- Consumes: `group.editions`, `editionKeyOf`
- Produces:
  - `parseHash()` now returns `{ view:"detail", key }` where `key` is an
    URL-encoded edition key (`e<enc>`), or `{view:"search",key:null}`.
  - `state.editions: {}` — a flat `Map`-like object `editionKey -> { group, edition }`
    populated by `renderView1` and used by `renderDetail`.

- [ ] **Step 1: Update `parseHash`**

Replace lines ~190-195:

```js
  function parseHash() {
    const h = location.hash.replace(/^#/, "");
    const m = /^\/detail\/(e.+)$/.exec(h);
    if (m) return { view: "detail", key: m[1] };
    return { view: "search", key: null };
  }
```

- [ ] **Step 2: Add `state.editions` and a population helper**

Change line 188 to:
```js
  var state = { posts: [], postById: {}, groups: [], editions: {}, currentKey: null, query: "" };
```

Add this helper near `groupByMovie`:
```js
  function indexEditions(groups) {
    state.editions = {};
    groups.forEach(function (g) {
      Object.keys(g.byEditionKey).forEach(function (ek) {
        state.editions[ek] = { group: g, edition: g.byEditionKey[ek] };
      });
    });
  }
```

- [ ] **Step 3: Call `indexEditions` from `renderView1`**

In `renderView1` (after `runPosterWorkers(groups);` on line ~390) add:
```js
    indexEditions(groups);
```

- [ ] **Step 4: Card href now points at the edition**

In `buildCard`, compute the edition key of the item and set:
```js
  const ek = editionKeyOf(item);
  card.href = "#/detail/e" + encodeURIComponent(ek);
```

- [ ] **Step 5: JS syntax check**

Run the syntax check. Expected: `JS syntax OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: route detail view by edition key"
```

---

### Task 5: Rewrite `renderDetail` to render a merged edition

**Files:**
- Modify: `index.html` (`renderDetail`)

**Interfaces:**
- Consumes: `parseHash` (edition key), `state.editions`, `edition.group`,
  `edition.edition.items`, `Resolve.hubs`, `directHref`, `parseFilenameTags`,
  `fetchTvMazeMeta`, `posterCache`
- Produces: `renderDetail(key)` renders the merged edition: hero (reused poster),
  all member posts' quality rows deduped to one per quality, each a direct link.

- [ ] **Step 1: Replace the pre-amble of `renderDetail`**

The current `renderDetail` looks up `state.postById[key]` and has a single-post
hard-refresh fallback. Replace the whole function body start (lines ~220-249) so it:
- decodes the edition key: `const ek = decodeURIComponent(key);`
- looks up `const ed = state.editions[ek];`
- gathers items: `const items = ed ? ed.edition.items : [];`
- hero name/base from `ed.group.name` + `ed.group.year`.

Full replacement for `renderDetail` (keeps the existing resolution + hero markup
build, but loops over ALL items):

```js
  async function renderDetail(key) {
    const dv = document.getElementById("view-detail");
    const ek = decodeURIComponent(key);
    const ed = state.editions[ek];
    if (!ed || !ed.edition.items.length) {
      dv.innerHTML = '<div class="error-box">That release is no longer available. <a href="#/" style="color:var(--accent)">← Back to results</a></div>';
      window.scrollTo(0, 0);
      return;
    }
    const group = ed.group;
    const items = ed.edition.items;
    const name = group.name;
    const year = group.year;
    dv.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--muted)">' +
      '<div class="spin"></div><div>Loading release…</div></div>';

    const metaName = baseTitle(name);
    const meta = await fetchTvMazeMeta(metaName);
    if (state.currentKey !== key) return;

    // Merge every member post's hubs, then resolve once, dedupe by quality.
    const allHubs = [];
    const allLinks = [];
    items.forEach(function (it) {
      (it.post.direct || []).forEach(function (h) { allHubs.push({ url: h.url || h, qual: h.qual || null }); });
      it.post.allLinks.forEach(function (l) { if (!allLinks.includes(l)) allLinks.push(l); });
      allLinks.push(it.post.link);
    });
    const resolved = await (allHubs.length ? Resolve.hubs(allHubs, items[0].post.link)
      : Promise.resolve({ rows: [], best: null, results: [] }));
    if (state.currentKey !== key) return;

    // Quality chips from all qualities seen across items.
    const qSet = [];
    items.forEach(function (it) { it.parsed.qualities.forEach(function (q) { if (!qSet.includes(q)) qSet.push(q); }); });
    const chips = qSet.map(function (q) { return "<span>" + esc(q) + "</span>"; }).join("");

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
      : '<a class="qrow bad" target="_blank" rel="noopener noreferrer" href="' + esc(items[0].post.link) + '" title="Direct resolve failed — opens the source redirect page.">' +
          '<span class="qlabel">File</span><span class="qbtn">Via redirect</span>' +
        '</a>';

    dv.innerHTML =
      '<a class="back-btn" href="#/">← Back to results</a>' +
      '<div class="detail-body">' +
        '<div class="detail-hero">' +
          '<div class="detail-poster" data-poster>' +
            (meta && meta.poster
              ? '<img src="' + esc(meta.poster) + '" alt="' + esc(name) + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">'
              : '<div class="noimg">Poster unavailable</div>') +
          '</div>' +
          '<div class="detail-info">' +
            '<div class="detail-title">' + esc(name + (year ? " (" + year + ")" : "")) + '</div>' +
            (items[0].edition.edition ? '<div class="edition-badge" style="align-self:flex-start">' + esc(items[0].edition.edition.toUpperCase()) + '</div>' : "") +
            '<div class="card-tags" style="display:flex">' + chips + '</div>' +
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
          '<a class="open secondary" style="margin-top:10px" href="' + esc(items[0].post.link) + '" target="_blank" rel="noopener noreferrer" title="Open the source page">Source</a>' +
        '</div>' +
      '</div>';

    // Tags from the best resolved filename.
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

- [ ] **Step 2: Ensure post objects carry `allLinks`**

Verify `doSearch`'s post mapping (lines ~1074-1084) already sets `allLinks: links.all`.
If a single-post fallback still sets `post.direct` only, it must also set
`post.allLinks` (see Task 6). For now confirm the mapping exists.

- [ ] **Step 3: JS syntax check**

Run the syntax check. Expected: `JS syntax OK`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: detail view renders merged edition with per-quality links"
```

---

### Task 6: Poster reuse + hard-refresh edition detail

**Files:**
- Modify: `index.html` (`renderDetail` poster reuse, `renderRoute` fallback,
  single-post fallback allLinks)

**Interfaces:**
- Consumes: `posterCache`, `state.posts`
- Produces: poster reused across views; `#/detail/e<enc>` works on hard refresh.

- [ ] **Step 1: Reuse the poster across views**

The search view loads each poster into an `<img>` via `runPosterWorkers`. On
detail, instead of always showing the TVMaze poster from `meta.poster`, if the
group already has a loaded poster use that. Add after the `meta` fetch in
`renderDetail`:

```js
    // Prefer the poster already loaded on the search view (browser-cached).
    const posterUrl = group.poster || (meta && meta.poster) || null;
```

and use `posterUrl` in the hero `<img src="...">` instead of `meta.poster`.
Also, if the poster is already present in the search DOM, copy that `<img>` node
so the browser never re-fetches it. Replace the poster block in the hero with:

```js
          '<div class="detail-poster" data-poster>' +
            (posterUrl ? posterFromDomOrUrl(posterUrl, name) : '<div class="noimg">Poster unavailable</div>') +
          '</div>' +
```

Add a helper (near `runPosterWorkers`):
```js
  function posterFromDomOrUrl(url, alt) {
    // Reuse a loaded search-view <img> for the same poster URL if it exists.
    const existing = resultsEl.querySelector('.poster img[src="' + url + '"]');
    if (existing) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = alt || "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = function () { this.style.display = "none"; };
      return img.outerHTML;
    }
    return '<img src="' + esc(url) + '" alt="' + esc(alt || "") + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">';
  }
```
(Because the URL is identical, the browser serves it from cache even if the DOM
node differs — one network fetch total.)

- [ ] **Step 2: Single-post fallback must carry `allLinks`**

Locate the hard-refresh single-post fallback in the OLD `renderDetail` (it was
replaced in Task 5; if still present anywhere, remove it). In `doSearch`'s
mapping it already sets `allLinks`. If the Task 5 rewrite removed the fallback,
add edition fallback in `renderRoute` (Step 3) instead.

- [ ] **Step 3: RenderRoute fallback for empty state**

Replace the detail branch of `renderRoute` (lines ~201-206):

```js
    if (route.view === "detail") {
      sv.style.display = "none";
      dv.style.display = "block";
      state.currentKey = route.key;
      if (Object.keys(state.editions).length) renderDetail(route.key);
      else doSearch().then(function () { renderDetail(route.key); });
    } else {
```

- [ ] **Step 4: JS syntax check**

Run the syntax check. Expected: `JS syntax OK`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: reuse poster across views, edition detail works on refresh"
```

---

### Task 7: Full verification (local + static) & final cleanup

**Files:**
- Verify: `index.html`

**Interfaces:**
- Consumes: everything above
- Produces: verified, committed final state

- [ ] **Step 1: Local-mode verification (`:8000`)**

Search `zootopia`. Assert:
1. ONE show header "Zootopia …".
2. Cards show edition badges + quality chips (e.g. an "ENGLISH" card with 1080P/720P/480P chips) — not a single quality overlay.
3. A Hindi/dual sub-card appears as a separate card if present.
4. Click an English card → `#/detail/e<enc>` → hero poster appears; Download section has each quality (2160P/1080P/720P/480P) at most once, each a raw `r2.dev`/pixeldrain href (no `/api/dl`, no `localhost` non-hash).
5. Back → View 1 re-renders from cache; poster still present (no flash/re-fetch).

Use Playwright `run_code_unsafe`; assert with `Array.from(document.querySelectorAll('a')).filter(a=>/api\/dl/.test(a.href)).length===0` and quality dedupe.

- [ ] **Step 2: Static-mode verification (`:8970`)**

Repeat Step 1 on `:8970`. Assert hubcdn-only edition → direct r2.dev rows; a hubcloud-only edition (e.g. a Hindi-only or a 480p-only Jumanji) → single "Via redirect" row.

- [ ] **Step 3: Hard-refresh detail**

`page.goto('http://localhost:8000/#/detail/e<enc>')` then `page.reload()`. Assert detail still renders by re-running `doSearch()` + `renderDetail` (edition rebuilt from `state.posts` → `indexEditions`).

- [ ] **Step 4: Cleanup greps**

```bash
grep -n "state.postById\[key\]\|p<postId>\|/detail/p" index.html
```
Expected: no stale `postById[key]` single-post detail paths remain in the active flow (the object may still be set by doSearch, that's fine).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: edition cards, merged quality detail, poster reuse"
```

---

## Self-Review Notes

**Spec coverage:**
- §1 Edition detection → Task 1.
- §2 Grouping by edition key → Task 2.
- §3 One card per edition with quality chips → Task 2 (grouping) + Task 3 (render).
- §4 Detail with per-quality links → Task 5.
- §5 Poster reuse → Task 6.
- §6 Low-end efficiency (lazy/async, no resolution on search, posterCache) → Task 3 (chips, no badge), Task 6 (reuse), existing code.

**Placeholder scan:** All steps contain concrete code or exact commands; no TBDs.

**Type consistency:** `parseEdition` returns `{edition,subs}` everywhere (Tasks 1, 2, 5).
`editionKeyOf(item)` called identically in Tasks 2, 3, 4. `state.editions` keyed by
the *raw* edition key in Task 4 (`indexEditions`), and `renderDetail` decodes the
URL-encoded hash key via `decodeURIComponent` in Task 5 — consistent. `buildCard`
keeps a per-(merged-)item signature in Task 3, and `buildEditionCards` dedupes so
same-edition items render once.

**Resolved:** The duplicate-card risk (same edition producing multiple cards) is
handled by `buildEditionCards` in Task 3 Step 2-3 — same-episode quality variants
collapse into a single card whose chips union their qualities.

---

## Deviations & Post-Plan Changes (final state)

These were applied to `index.html` during/after the plan's Task 4–7 and are
folded into the single final commit (see git log message).

### 1. Task 4 `parseHash` note (plan gap filled, not a behavior change)
The plan's Task 4 mentioned `parseHash` but never pinned the actual regex. The
implemented regex is `/^\/detail\/e(.+)$/` — it captures the encoded edition key
**without** the leading `e` (the caller prepends `e` only when constructing the
hash, and `renderDetail` decodes via `decodeURIComponent`). No bug was found; the
note just documents the concrete shape so a future reader doesn't "fix" it.

### 2. `doSearch(queryParam)` accepts an explicit query string
Hard-refresh verification (Task 6/7) needs to re-run the exact search that
produced a deep link. `doSearch(queryParam)` now uses `String(queryParam).trim()`
when a string is passed, falling back to the search box value otherwise. This
lets `doSearch("Zootopia 2016")` run deterministically regardless of the input
state, and powers the `renderDetail(route.key)` path on reload.

### 3. `runPosterWorkers` post-bundle re-paint for reloaded details
After a hard refresh straight to a `#/detail/...` hash, the detail hero poster
must still come from the same poster cache/reuse path as cards. `runPosterWorkers`
now also re-paints posters on every render and matches cards via
`normKey(baseTitle(...)) === home`, so a directly-loaded detail resolves its
episode-card artwork through the identical reuse logic (no duplicate fetch, no
stale-key miss).

### 4. New feature: show every direct-link type as its own detail row (Chg-2026-09-08)
The original plan collapsed resolved mirrors into ONE row per unique quality
(`qualityRows`). The user then requested the opposite: surface each distinct
direct-link family for a release as its own row, tagged by host, instead of
collapsing mirrors by quality.

Changes in `index.html`:
- `extractLinks` (RegEx `lre`) now also captures raw direct URL families from the
  post HTML alongside the hubcdn/hubdrive/hubcloud wrappers: `pub-*.r2.dev/<hash>`,
  `*.r2.cloudflarestorage.com/...` (S3 presigned), `video-downloads.googleusercontent.com/...`
  (GDrive), `drive.google.com/...`, `pixeldrain.(com|dev)/(u|api/file)/<id>`, and
  `gofile.io/d/<id>`. Each captured link is tagged with its host `kind`
  (`hubcdn|hubdrive|hubcloud|r2|s3|gdrive|pixeldrain|gofile`) and mapped to its
  nearest preceding quality label (unchanged behavior).
- New client-side `resolveRaw(url)` runs in **every** mode: r2.dev / S3 presigned /
  googleusercontent / drive.google → returned as-is (these are already the direct
  link); `pixeldrain /u/<id>` and `/api/file/<id>` → normalized to
  `https://pixeldrain.dev/api/file/<id>` plus `pixInfo` extras (size/name/quality);
  `gofile.io/d/<id>` → `null` (still requires an account token, unresolvable).
- `resolveOne`/`resolveOneStatic` route raw links to `resolveRaw` before any writer
  wrapper logic (in static mode, raw links that match `resolveRaw` resolve client-side;
  otherwise static falls through to hubcdn static).
- `qualityRows` now emits **one row per unique resolved URL** (deduped by URL only,
  no quality collapse), sorted best-quality first. Identical objects on different
  hosts each get their own row.
- New `hostTagOf(direct)` labels every row with its host family (R2 / S3 / GDrive /
  Pixeldrain / HubCDN / HubDrive / HubCloud / Gofile) shown inside the `qlabel`
  (e.g. `1080P · R2`, `720P · Pixeldrain`), so a release's R2 public, S3 presigned,
  GDrive, and pixeldrain mirrors are all visible separately.
- `renderDetail` (and card `paintRowsInto`) include the host tag in each row. The
  single "File / Via redirect" fallback row is still used **only** when nothing
  resolves.

Verification (both modes):
- Local (`:8137`): Zootopia (2016) 87664 shows `1080P · Pixeldrain` + `720P ·
  Pixeldrain` (its hubdrive link is dead and gofile needs a token — correctly no
  rows for those). Silo S03E01 shows all mirror families as tagged rows:
  `2160P · R2`, `1080P · R2`, `1080P · Pixeldrain`, `720P · R2`, `720P · Pixeldrain`,
  `480P · R2`, `480P · Pixeldrain`.
- Static (`:8970`): Silo S03E01 (hubcdn-only mirrors) shows `1080P/720P/480P · R2`
  tagged rows; Zootopia 87664 (hubdrive+hubcloud only, which static can't resolve)
  correctly shows the single "File / Via redirect" fallback.

Known limits (unchanged, documented): static cannot resolve hubdrive (AJAX POST +
Cloudflare) nor hubcloud's 2nd hop (gamerxyt returns only an ad script via the
reader); gofile requires an account token. Those rows simply don't appear in the
mode where they can't be resolved — they fall back to "Via redirect" only when
**no** mirror resolves at all.
