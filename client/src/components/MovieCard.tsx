import { h } from "preact";
import { stripHtml } from "../core/parsing";
import type { ReleaseItem } from "@shared/types";
import type { ShowGroup } from "@shared/types";
import { editionKeyOf } from "../core/parsing";
import styles from "../styles/components.module.css";

interface MovieCardProps {
  item: ReleaseItem;
  group: ShowGroup;
  /** Qualities to render (defaults to the item's own parsed qualities). */
  qualities?: string[];
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function MovieCard({ item, group, qualities: overrideQualities }: MovieCardProps) {
  const qualities = overrideQualities ?? item.parsed.qualities;
  const ed = item.edition.edition;
  const episode = item.seasonal.episode;
  const poster = group.poster;
  const editionKey = editionKeyOf(item);
  const link = `#/detail/e${encodeURIComponent(editionKey)}`;
  const cleanName = stripHtml(item.parsed.name);
  const ariaLabel = `Open ${cleanName} release`;

  return (
    <article class={styles.card}>
      <div class={styles.posterArea}>
        {poster ? (
          <img
            class={styles.posterImg}
            src={poster}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span class={styles.posterPlaceholder} aria-hidden="true">
            {initialsOf(cleanName) || "NA"}
          </span>
        )}

        {episode != null ? (
          <span class={styles.episodeBadge}>
            E{String(episode).padStart(2, "0")}
          </span>
        ) : null}

        {ed ? (
          <span class={styles.editionBadge}>{ed.toUpperCase()}</span>
        ) : null}
      </div>

      <div class={styles.cardBody}>
        {qualities.length > 0 ? (
          <div class={styles.qualityChips} aria-label="Available qualities">
            {qualities.map((q) => (
              <span key={q} class={styles.qualityChip}>
                {q}
              </span>
            ))}
          </div>
        ) : null}

        <h3 class={styles.cardTitle} title={cleanName}>
          {cleanName}
        </h3>

        <p class={styles.cardMeta}>
          {[group.year, item.parsed.year].filter(Boolean).join(" · ") ||
            "Year unknown"}
        </p>

        <a
          class={styles.cardLink}
          href={link}
          aria-label={ariaLabel}
          data-testid="card-link"
        >
          Open release{" "}
          <span class={styles.cardArrow} aria-hidden="true">
            →
          </span>
        </a>
      </div>
    </article>
  );
}
