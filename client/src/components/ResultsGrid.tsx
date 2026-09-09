import { h, Fragment } from "preact";
import type { ReleaseItem, ShowGroup } from "@shared/types";
import {
  layOutGroup,
  filterLayoutForHints,
  type SeasonBucket,
} from "../core/grouping";
import { editionKeyOf, parseSearchHints } from "../core/parsing";
import { MovieCard } from "./MovieCard";
import styles from "../styles/components.module.css";

/** One card per edition: quality variants of the same episode (e.g. "Silo
 *  S01E01 1080p" + "Silo S01E01 720p") collapse into a single card whose
 * quality chips merge. Insertion order is preserved (episode ascending). */
interface EditionCard {
  item: ReleaseItem;
  qualities: string[];
}

function dedupeEpisodes(items: ReleaseItem[]): EditionCard[] {
  const groups = new Map<string, ReleaseItem[]>();
  for (const item of items) {
    const key = editionKeyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return Array.from(groups.values()).map((list) => ({
    item: list[0],
    qualities: Array.from(new Set(list.flatMap((it) => it.parsed.qualities))),
  }));
}

interface ResultsGridProps {
  groups: ShowGroup[];
  query: string;
  onRefine?: (query: string) => void;
}

interface SeasonHeaderProps {
  bucket: SeasonBucket;
  /** When set, the header becomes a button that refines the search. */
  refineLabel?: string;
  onRefine?: (query: string) => void;
  /** Show the episode count inline (collapsed seasons view). */
  showCount?: boolean;
  /** Overrides the raw bucket count (deduped editions when merging quality
   *  variants — matches the cards actually rendered). */
  episodeCountOverride?: number;
}

function SeasonHeader({
  bucket,
  refineLabel,
  onRefine,
  showCount = false,
  episodeCountOverride,
}: SeasonHeaderProps) {
  const episodeCount = episodeCountOverride ?? bucket.episodeItems.length;
  const countText =
    episodeCount > 0
      ? ` · ${episodeCount} episode${episodeCount === 1 ? "" : "s"}`
      : "";
  const content = (
    <Fragment>
      Season {bucket.season}
      {showCount && countText && (
        <span class={styles.seasonCount}>{countText}</span>
      )}
    </Fragment>
  );

  if (refineLabel && onRefine) {
    return (
      <button
        type="button"
        class={styles.seasonHeaderBtn}
        onClick={() => onRefine(refineLabel)}
        aria-label={`Show ${refineLabel} episodes`}
      >
        {content}
        <span class={styles.seasonRefine} aria-hidden="true">
          Show episodes ›
        </span>
      </button>
    );
  }

  return <h4 class={styles.seasonHeader}>{content}</h4>;
}

/** Season-bucket shape as rendered for the current hints. */
interface RenderedBucket {
  bucket: SeasonBucket;
  episodeCards: EditionCard[];
  showEpisodeCards: boolean;
  showPackCards: boolean;
}

export function ResultsGrid({ groups, query, onRefine }: ResultsGridProps) {
  if (!groups || groups.length === 0) {
    return (
      <div class={styles.emptyState} role="status">
        <div class={styles.emptyIcon} aria-hidden="true">
          🎬
        </div>
        <p class={styles.emptyText}>
          {query ? `No results found for “${query}”.` : "Nothing to show yet."}
        </p>
        <p class={styles.emptyHint}>
          {query
            ? "Try a different title or check your spelling."
            : "Search for a movie or TV show to get started."}
        </p>
      </div>
    );
  }

  // The query decides how much to show:
  //  - "reacher"        → all seasons listed, no episode lists
  //  - "reacher s04"    → season 4 with all its episodes
  //  - "reacher s04e07" → only episode 7 of season 4
  const hints = parseSearchHints(query);
  const seasonal = hints.season != null || hints.episode != null;

  const view = groups.map((group) => {
    const layout = layOutGroup(group);
    const filtered = filterLayoutForHints(layout, hints);
    const seasons: RenderedBucket[] = filtered.seasonList.map((bucket) => {
      const episodeItems =
        hints.episode != null
          ? bucket.episodeItems.filter(
              (it) => it.seasonal.episode === hints.episode,
            )
          : bucket.episodeItems;
      const cards = dedupeEpisodes(episodeItems);
      return {
        bucket,
        episodeCards: cards,
        showEpisodeCards: seasonal && cards.length > 0,
        showPackCards: hints.episode == null && bucket.packItems.length > 0,
      };
    });
    return { group, layout, filtered, seasons };
  });

  let totalReleases = 0;
  for (const { seasons } of view) {
    for (const s of seasons) {
      if (s.showEpisodeCards) totalReleases += s.episodeCards.length;
      if (s.showPackCards) totalReleases += s.bucket.packItems.length;
    }
  }

  return (
    <div class={styles.resultsContainer}>
      <p class={styles.statsLine} role="status">
        Found {groups.length} title{groups.length !== 1 ? "s" : ""} matching
        “{query}”
        {totalReleases > 0 ? ` — ${totalReleases} release(s)` : ""}
      </p>

      {view.map(({ group, layout, filtered, seasons }) => (
        <section key={group.key} class={styles.groupSection}>
          <h2 class={styles.groupHeader}>{layout.name}</h2>
          <p class={styles.groupMeta}>
            {layout.year}
            {group.editions.size > 1 && (
              <span> · {group.editions.size} editions</span>
            )}
          </p>

          {seasons.map(({ bucket, episodeCards, showEpisodeCards, showPackCards }) => (
            <div key={bucket.season} class={styles.seasonBlock}>
              <SeasonHeader
                bucket={bucket}
                showCount={!seasonal}
                episodeCountOverride={episodeCards.length}
                refineLabel={
                  !seasonal ? `${layout.name} s${bucket.season}` : undefined
                }
                onRefine={!seasonal ? onRefine : undefined}
              />
              {showEpisodeCards && (
                <div class={styles.cardsGrid}>
                  {episodeCards.map(({ item, qualities }) => (
                    <MovieCard
                      key={editionKeyOf(item)}
                      item={item}
                      group={group}
                      qualities={qualities}
                    />
                  ))}
                </div>
              )}
              {showPackCards && (
                <div class={styles.cardsGrid}>
                  {bucket.packItems.map((item) => (
                    <MovieCard
                      key={editionKeyOf(item)}
                      item={item}
                      group={group}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {filtered.orphanEpisodes.length > 0 && (
            <div class={styles.seasonBlock}>
              <h4 class={styles.seasonHeader}>Episodes</h4>
              <div class={styles.cardsGrid}>
                {filtered.orphanEpisodes.map((item) => (
                  <MovieCard
                    key={editionKeyOf(item)}
                    item={item}
                    group={group}
                  />
                ))}
              </div>
            </div>
          )}

          {filtered.movies.length > 0 && (
            <div class={styles.seasonBlock}>
              <h4 class={styles.seasonHeader}>Movies</h4>
              <div class={styles.cardsGrid}>
                {filtered.movies.map((item) => (
                  <MovieCard
                    key={editionKeyOf(item)}
                    item={item}
                    group={group}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}