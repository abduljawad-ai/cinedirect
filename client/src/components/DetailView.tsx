import { h } from "preact";
import type {
  ShowGroup,
  EditionGroup,
  TvMazeMeta,
  QualityRow,
} from "@shared/types";
import { stripHtml, formatBytes } from "../core/parsing";
import styles from "../styles/components.module.css";

interface DetailViewProps {
  editionKey: string;
  group: ShowGroup;
  edition: EditionGroup;
  meta: TvMazeMeta | null;
  rows: QualityRow[];
  loading: boolean;
  onBack: () => void;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function DetailView({
  editionKey,
  group,
  edition,
  meta,
  rows,
  loading,
  onBack,
}: DetailViewProps) {
  if (loading) {
    return (
      <div class={styles.loadingContainer} role="status" aria-live="polite">
        <span class={styles.loadingSpinner} aria-hidden="true" />
        <p>Loading release details…</p>
      </div>
    );
  }

  if (!group || !edition) {
    return (
      <div class={styles.errorState} role="alert">
        <p class={styles.errorText}>Sorry, this release could not be found.</p>
        <button class={styles.backButton} onClick={onBack}>
          ← Back to results
        </button>
      </div>
    );
  }

  const name = stripHtml(group.name);
  const poster = meta?.poster ?? group.poster;
  const editionLabel =
    edition.key && edition.key !== "default" ? edition.key : "Default";
  const qualities = rows
    .map((r) => r.quality)
    .filter((q): q is NonNullable<typeof q> => q != null);

  return (
    <div class={styles.detailContainer}>
      <button class={styles.backButton} onClick={onBack}>
        <span aria-hidden="true">←</span> Back to results
      </button>

      <div class={styles.hero}>
        <div class={styles.heroPoster}>
          {poster ? (
            <img
              class={styles.heroPosterImg}
              src={poster}
              alt={`${name} poster`}
            />
          ) : (
            <span class={styles.heroPosterPlaceholder} aria-hidden="true">
              {initialsOf(name) || "NA"}
            </span>
          )}
        </div>

        <div class={styles.heroInfo}>
          <h1 class={styles.heroTitle}>{name}</h1>

          {group.year ? <p>{group.year}</p> : null}
          <span class={styles.heroEdition}>{editionLabel}</span>

          {qualities.length > 0 && (
            <div class={styles.heroQualities} aria-label="Available qualities">
              {qualities.map((q) => (
                <span key={q} class={styles.qualityChip}>
                  {q}
                </span>
              ))}
            </div>
          )}

          {meta &&
            (meta.genres.length > 0 || meta.rating != null || meta.network) && (
              <div class={styles.heroMetaChips}>
                {meta.rating != null && (
                  <span class={styles.metaChip}>
                    ★ {meta.rating.toFixed(1)}
                  </span>
                )}
                {meta.genres.slice(0, 4).map((g) => (
                  <span key={g} class={styles.metaChip}>
                    {g}
                  </span>
                ))}
                {meta.network && (
                  <span class={styles.metaChip}>{meta.network}</span>
                )}
              </div>
            )}

          {meta?.summary ? (
            <p class={styles.heroSynopsis}>{stripHtml(meta.summary)}</p>
          ) : null}
        </div>
      </div>

      <section
        class={styles.downloadSection}
        aria-label={`Download options for ${name} (${editionKey})`}
      >
        <h2 class={styles.downloadSectionTitle}>Download</h2>
        {rows.length === 0 ? (
          <p class={styles.emptyText}>
            No download links available for this release.
          </p>
        ) : (
          rows.map((row, idx) => (
            <div
              key={`${row.quality ?? "any"}-${idx}`}
              class={styles.qualityRow}
            >
              <span class={styles.qualityLabel}>
                {row.quality ?? "Unknown"}
              </span>
              <span class={styles.qualityMeta}>
                {formatBytes(row.size) || "Size unavailable"}
                {row.hostTag ? ` · ${row.hostTag}` : ""}
              </span>
              <a
                class={styles.qualityLink}
                href={row.direct}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Download ${name} ${row.quality ?? ""} from ${row.hostTag || "host"}`}
              >
                Get link
              </a>
            </div>
          ))
        )}
      </section>

      {edition.items[0]?.post.link ? (
        <a
          class={styles.sourceLink}
          href={edition.items[0].post.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          View source ↗
        </a>
      ) : null}
    </div>
  );
}
