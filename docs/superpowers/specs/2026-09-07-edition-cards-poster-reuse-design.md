# CineDirect — Edition Cards, Merged Qualities & Poster Reuse

Date: 2026-09-07
Status: Approved

## Problem

The current two-view redesign groups search results into one card per *release post*.
When a movie exists at several qualities (480p, 720p, 1080p, 2160p) the user sees
multiple noisy cards, each stamped with a single quality. The user wants:

- **One card per edition** (title + audio/language version), showing **all**
  available qualities for that edition as chips on the card.
- Clicking the card opens the detail view with a **separate download link per
  quality** (480p, 720p, 1080p, 2160p / 4K), each a direct link.
- Different language/audio editions (English, Dual Audio, Tamil, etc.) appear as
  **separate cards**.
- The poster must load **once** and be **reused** across search → detail → back,
  to save data and speed up low-end browsers.

## Design

### 1. Edition detection — `parseEdition(title)`

Extract an audio/language tag from a release title. Detection markers (case
insensitive), searched in priority order:

- `Dual Audio` / `DualAudio` / `DD+5.1` variants
- `Dual`, `Multi Audio`
- An explicit language in square brackets: `[English]`, `[Hindi]`, `[Tamil]`,
  `[Telugu]`, `[Malayalam]`, `[Kannada]`, `[Punjabi]`, `[Bengali]`
- `English`, `Hindi`, `Tamil`, `Telugu`, `Malayalam`, `Kannada`, `Punjabi`
  followed by `Sub(s)`, `Dubbed`, `Audio`, or standing alone near the quality tag
- Subtitle-only tags (`Eng Sub`, `Subtitles`) are kept as a separate `subs` field

Return `{ edition, subs }` where `edition` is a canonical lower-case tag string
(empty string when none detected → treated as the default "English" edition).

### 2. Grouping — edition key

Within each show group, releases are grouped by an **edition key**:

```
editionKey = normKey(baseTitle) | year | editionTag | season | episode | isSeasonPack
```

So:
- `Zootopia 1080p English` + `Zootopia 720p English` → same key → one English card
  (qualities merged: 1080P · 720P)
- `Zootopia Dual Audio 1080p` → different key → separate Dual Audio card
- `Silo S03E01 1080p English` + `Silo S03E01 720p English` → one card (qualities merged)

Season/episode markers stay in the key so episode cards remain distinct.

### 3. View 1 — one card per edition

`renderView1` builds a card **per edition group** (not per post):

- Card shows: poster, title, subtitle line, and a row of **quality chips**
  (480P · 720P · 1080P · 2160P) built from the union of all member posts' qualities.
- No quality-as-title badge; pure chip badges only.
- Clicking navigates to `#/detail/e<editionKey>`.
- No link resolution on this view.

### 4. View 2 — detail with all quality links

`renderDetail(editionKey)` renders the merged edition:

- Looks up all posts in the edition group.
- Resolves the union of their hubs (**only on open**) → one deduplicated
  per-quality list → each quality renders as its own Download row with the raw
  direct URL (r2.dev / pixeldrain), deduplicated so each quality appears once.
- Falls back to `Via redirect` when a quality can't resolve.
- TVMaze metadata + poster shown as before.

### 5. Poster reuse

Posters are fetched once per show and cached (key = `normKey(name)|year`).

- View 1 loads each poster into an `<img loading="lazy" decoding="async">`.
- The **same poster URL is reused** in the detail view, so the browser serves it
  from its HTTP/disk cache — no second network request.
- If the poster is already present in the search DOM, the detail view reuses that
  loaded image resource directly (no re-download).
- Back to search → cards are already cached in `state.groups`; no re-fetch.

### 6. Efficiency for low-end / slow browsers

- Posters: `loading="lazy"`, `decoding="async"`, `fetch-priority` where supported.
- No poster re-fetch when a group is already in `posterCache`.
- Detail view resolves links only for the opened edition, and `Resolve.resetMemo()`
  is called once per new search.
- Search view stays resolve-free (fast first paint).

### Interface changes

| Function | Change |
|---|---|
| `parseEdition(title)` | new — returns `{ edition, subs }` |
| `groupByMovie` / grouping | group by edition key; attach aggregated memories |
| `renderView1` | builds edition cards with quality chips |
| `buildCard` | takes an edition group; renders chips |
| `renderDetail(key)` | key is now `e<editionKey>`; merges posts, dedupes qualities |
| `parseHash` | accepts `e<...>` detail keys (edition key URL-encoded in the hash) |
| poster pipeline | reuse `posterCache` + DOM image across views |

Edition keys contain `|` and normKey characters, so when placing one in the hash
(`#/detail/e<editionKey>`) it is `encodeURIComponent`-ed, and `parseHash`/`renderDetail`
decode it back before doing a map lookup. A `Map<editionKey, editionGroup>` is kept in
`state` so the detail view can find its edition purely from the decoded key — even on
a hard refresh, where the group is rebuilt by re-running grouping over `state.posts`.

## Out of scope

- Server / worker changes (`hblinks-server.py`, `worker/relay.js`) — untouched.
- Cloudflare worker deployment — still pending user.
- Persisting poster images to disk.
