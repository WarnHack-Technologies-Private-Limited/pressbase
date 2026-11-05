'use client';

import type { CSSProperties } from 'react';
import { type DesignChoice, previewStyle } from '@/lib/site-builder';
import styles from './site-builder.module.css';

/**
 * A live mini preview of a design direction: a hero in the site's colours,
 * fonts, corners and spacing, drawn from the design generator's own
 * palette (the same one core writes as the site's styles). Decorative: the
 * card around it names the direction.
 */
export function DesignPreview({
  choice,
  name,
  kind,
  pages,
}: {
  choice: DesignChoice;
  name: string;
  kind: string;
  pages: string[];
}) {
  let style: CSSProperties;
  try {
    style = previewStyle(choice) as CSSProperties;
  } catch {
    return null;
  }
  return (
    <div className={styles.preview} style={style} aria-hidden="true" data-scheme={choice.scheme}>
      <div className={styles.previewNav}>
        <span className={styles.previewBrand}>{name}</span>
        <span className={styles.previewLinks}>
          {pages.slice(1, 4).map((page) => (
            <span key={page}>{page}</span>
          ))}
        </span>
      </div>
      <div className={styles.previewHero}>
        {kind && <span className={styles.previewPill}>{kind}</span>}
        <span className={styles.previewTitle}>{name}</span>
        <span className={styles.previewText} />
        <span className={styles.previewText} data-short />
        <span className={styles.previewButtons}>
          <span className={styles.previewButton} />
          <span className={styles.previewButton} data-outline />
        </span>
      </div>
      <div className={styles.previewCards}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
