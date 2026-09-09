/**
 * Show-grouping and layout utilities for CineDirect.
 *
 * Pure functions that organise parsed posts into show groups, lay out
 * seasons/episodes/movies, and build flat edition indexes for routing.
 *
 * All functions are side-effect free and fully typed.
 */

import type {
  Post,
  ShowGroup,
  EditionGroup,
  ReleaseItem,
  EditionIndexEntry,
} from "@shared/types";
import { QUALITY_RANK } from "@shared/types";

import {
  parseTitle,
  parseEdition,
  parseSeasonal,
  normKey,
  baseTitle,
  editionKeyOf,
  type SearchHints,
} from "./parsing";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Layout result for a single show group. */
export interface LayoutResult {
  name: string;
  year: string;
  seasonList: SeasonBucket[];
  orphanEpisodes: ReleaseItem[];
  movies: ReleaseItem[];
}

/** A season bucket containing episode and pack items. */
export interface SeasonBucket {
  season: number;
  episodeItems: ReleaseItem[];
  packItems: ReleaseItem[];
}

/* ------------------------------------------------------------------ */
/*  groupByMovie                                                       */
/* ------------------------------------------------------------------ */

/**
 * Group an array of posts into show groups.
 *
 * For each post the title is parsed, the base title is computed, and a
 * normalised key (`normKey(baseTitle)`) is derived. Posts that share the
 * same key are collected into a single {@link ShowGroup}.
 *
 * Each post becomes a {@link ReleaseItem} with parsed title, seasonal
 * markers, and edition info. Items are added to the group and to the
 * correct {@link EditionGroup} within it.
 *
 * The returned array is sorted by the most recent post date descending
 * (newest first).
 *
 * Posts with an empty normalised key are silently skipped.
 */
export function groupByMovie(posts: Post[]): ShowGroup[] {
  const groups: ShowGroup[] = [];
  const index: Record<string, ShowGroup> = {};

  for (const p of posts) {
    const parsed = parseTitle(p.title);
    const base = baseTitle(parsed.name);
    const key = normKey(base);
    if (!key) continue;

    if (!index[key]) {
      const g: ShowGroup = {
        key,
        name: base,
        year: parsed.year,
        items: [],
        poster: null,
        editions: new Map(),
        byEditionKey: {},
      };
      index[key] = g;
      groups.push(g);
    }

    const g = index[key];
    const item: ReleaseItem = {
      post: p,
      parsed,
      seasonal: parseSeasonal(p.title),
      edition: parseEdition(p.title),
    };

    g.items.push(item);

    const ek = editionKeyOf(item);
    if (!g.byEditionKey[ek]) {
      const eg: EditionGroup = { key: ek, items: [] };
      g.byEditionKey[ek] = eg;
      g.editions.set(ek, eg);
    }
    g.byEditionKey[ek].items.push(item);
  }

  // Sort groups by most recent post date descending.
  groups.sort(
    (a, b) =>
      new Date(b.items[0].post.date).getTime() -
      new Date(a.items[0].post.date).getTime(),
  );

  return groups;
}

/* ------------------------------------------------------------------ */
/*  layOutGroup                                                        */
/* ------------------------------------------------------------------ */

/**
 * Organise one show group into seasons, orphan episodes, and standalone
 * movies.
 *
 * Items are classified as follows:
 * - **Season bucket** — item has a season number.
 *   - If it is a season pack it goes into `packItems`.
 *   - Otherwise it goes into `episodeItems`.
 * - **Orphan episode** — item has an episode number but no season.
 * - **Standalone movie** — item has neither season nor episode.
 *
 * Seasons are sorted ascending, episodes within each season by episode
 * number, and packs by quality rank (best first).
 */
export function layOutGroup(group: ShowGroup): LayoutResult {
  const seasonMap = new Map<number, SeasonBucket>();
  const orphanEpisodes: ReleaseItem[] = [];
  const movies: ReleaseItem[] = [];

  for (const item of group.items) {
    const se = item.seasonal;

    if (se.season !== null) {
      if (!seasonMap.has(se.season)) {
        seasonMap.set(se.season, {
          season: se.season,
          episodeItems: [],
          packItems: [],
        });
      }
      const bucket = seasonMap.get(se.season)!;
      if (se.isSeasonPack) {
        bucket.packItems.push(item);
      } else {
        bucket.episodeItems.push(item);
      }
    } else if (se.episode !== null) {
      orphanEpisodes.push(item);
    } else {
      movies.push(item);
    }
  }

  const seasonList = Array.from(seasonMap.values()).sort(
    (a, b) => a.season - b.season,
  );

  for (const b of seasonList) {
    b.episodeItems.sort(
      (a, c) => (a.seasonal.episode ?? 0) - (c.seasonal.episode ?? 0),
    );
    b.packItems.sort(
      (a, c) => qualRankOf(c) - qualRankOf(a),
    );
  }

  return {
    name: group.name,
    year: group.year,
    seasonList,
    orphanEpisodes,
    movies,
  };
}

/* ------------------------------------------------------------------ */
/*  filterLayoutForHints                                               */
/* ------------------------------------------------------------------ */

/** Layout result shaped by the current search's season/episode hints. */
export interface FilteredLayout {
  /** Season buckets to render (all seasons, or only the hinted one). */
  seasonList: SeasonBucket[];
  /** Orphan episodes to render. */
  orphanEpisodes: ReleaseItem[];
  /** Standalone movie items to render (always kept). */
  movies: ReleaseItem[];
}

/**
 * Shape a {@link LayoutResult} for the current search query.
 *
 * Drives the "search the show name → seasons only, no episode list" UX:
 * - No hints: every season bucket renders as a collapsed header (episode
 *   cards are omitted) and orphan episodes are hidden.
 * - Season hint (`reacher s04`): only that season's bucket is kept.
 * - Episode hint (`reacher s04e07`): only that season's bucket is kept;
 *   the component further filters its episode items to the episode number.
 * - Bare episode hint (`e10`): season buckets are kept but only matching
 *   orphan/seasonal episodes survive the component's episode filter.
 */
export function filterLayoutForHints(
  layout: LayoutResult,
  hints: SearchHints,
): FilteredLayout {
  let orphanEpisodes: ReleaseItem[];
  if (hints.season != null) {
    orphanEpisodes = []; // orphans have no season → never match a season hint
  } else if (hints.episode != null) {
    orphanEpisodes = layout.orphanEpisodes.filter(
      (it) => it.seasonal.episode === hints.episode,
    );
  } else {
    orphanEpisodes = layout.orphanEpisodes;
  }

  return {
    seasonList:
      hints.season != null
        ? layout.seasonList.filter((b) => b.season === hints.season)
        : layout.seasonList,
    orphanEpisodes,
    movies: layout.movies,
  };
}

/* ------------------------------------------------------------------ */
/*  indexEditions                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build a flat lookup of every edition key across all groups.
 *
 * Used by the detail view to resolve `#/detail/e<encoded-key>` routes.
 * Each entry maps an edition key to its owning {@link ShowGroup} and
 * {@link EditionGroup}.
 */
export function indexEditions(
  groups: ShowGroup[],
): Record<string, EditionIndexEntry> {
  const editions: Record<string, EditionIndexEntry> = {};

  for (const g of groups) {
    for (const ek of Object.keys(g.byEditionKey)) {
      editions[ek] = { group: g, edition: g.byEditionKey[ek] };
    }
  }

  return editions;
}

/* ------------------------------------------------------------------ */
/*  qualRankOf                                                         */
/* ------------------------------------------------------------------ */

/**
 * Return the best quality rank for a release item.
 *
 * Iterates over the item's quality tiers and returns the highest rank
 * using the {@link QUALITY_RANK} map. Returns `-1` if no recognised
 * quality is present.
 */
export function qualRankOf(item: ReleaseItem): number {
  let best = -1;
  for (const q of item.parsed.qualities) {
    const r = (QUALITY_RANK as Record<string, number>)[q] ?? -1;
    if (r > best) best = r;
  }
  return best;
}
