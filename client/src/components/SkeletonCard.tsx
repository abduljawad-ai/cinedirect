import { h } from "preact";
import { Fragment } from "preact";
import styles from "../styles/components.module.css";

interface SkeletonCardProps {
  count?: number;
}

export function SkeletonCard({ count = 1 }: SkeletonCardProps) {
  const n = Math.max(1, count);

  return (
    <Fragment>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          class={styles.skeletonCard}
          role="status"
          aria-label="Loading content"
        >
          <div class={styles.skeletonPoster} aria-hidden="true" />
          <div class={styles.skeletonBody} aria-hidden="true">
            <span class={styles.skeletonChip} />
            <span class={styles.skeletonChip} />
            <span class={styles.skeletonChip} />
            <div class={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
            <div
              class={`${styles.skeletonLine} ${styles.skeletonLineMedium}`}
            />
            <div class={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
          </div>
        </div>
      ))}
    </Fragment>
  );
}
