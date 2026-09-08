import { h } from "preact";
import type { ShowGroup } from "@shared/types";
import {
  layOutGroup,
  type LayoutResult,
  type SeasonBucket,
} from "../core/grouping";
import { editionKeyOf } from "../core/parsing";
import { MovieCard } from "./MovieCard";
import styles from "../styles/components.module.css";

interface ResultsGridProps {
  groups: ShowGroup[];
  query: string;
}

function SeasonHeader({ bucket }: { bucket: SeasonBucket }) {
  const title =
    bucket.packItems.length > 0
      ? `Season ${bucket.season}`
      : `Season ${bucket.season}`;
  return <h4 class={styles.seasonHeader}>{title}</h4>;
}

function groupTotalCounts(layout: LayoutResult): {
  movies: number;
  releases: number;
} {
  let movies = layout.movies.length;
  let releases = layout.seasonList.reduce(
    (acc, b) => acc + b.episodeItems.length + b.packItems.length,
    0,
  );
  releases += layout.orphanEpisodes.length;
  const packCount = layout.seasonList.reduce(
    (acc, b) => acc + b.packItems.length,
    0,
  );
  movies += packCount;
  return { movies, releases };
}

export function ResultsGrid({ groups, query }: ResultsGridProps) {
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

  let totalReleases = 0;

  return (
    <div class={styles.resultsContainer}>
      <p class={styles.statsLine} role="status">
        Found {groups.length} title{groups.length !== 1 ? "s" : ""}
        {query ? ` matching “${query}”` : ""}
        {totalReleases > 0 ? ` — ${totalReleases} release(s)` : ""}
      </p>

      {groups.map((group) => {
        const layout = layOutGroup(group);
        const { movies, releases } = groupTotalCounts(layout);
        totalReleases += releases;

        return (
          <section key={group.key} class={styles.groupSection}>
            <h2 class={styles.groupHeader}>{layout.name}</h2>
            <p class={styles.groupMeta}>
              {layout.year}
              {group.editions.size > 1 && (
                <span> · {group.editions.size} editions</span>
              )}
            </p>

            {layout.seasonList.map((bucket) => (
              <div key={bucket.season} class={styles.seasonBlock}>
                <SeasonHeader bucket={bucket} />
                {bucket.episodeItems.length > 0 && (
                  <div class={styles.cardsGrid}>
                    {bucket.episodeItems.map((item) => (
                      <MovieCard
                        key={editionKeyOf(item)}
                        item={item}
                        group={group}
                      />
                    ))}
                  </div>
                )}
                {bucket.packItems.length > 0 && (
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

            {layout.orphanEpisodes.length > 0 && (
              <div class={styles.seasonBlock}>
                <h4 class={styles.seasonHeader}>Episodes</h4>
                <div class={styles.cardsGrid}>
                  {layout.orphanEpisodes.map((item) => (
                    <MovieCard
                      key={editionKeyOf(item)}
                      item={item}
                      group={group}
                    />
                  ))}
                </div>
              </div>
            )}

            {movies > 0 && (
              <div class={styles.seasonBlock}>
                <h4 class={styles.seasonHeader}>Movies</h4>
                <div class={styles.cardsGrid}>
                  {layout.movies.map((item) => (
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
        );
      })}
    </div>
  );
}
