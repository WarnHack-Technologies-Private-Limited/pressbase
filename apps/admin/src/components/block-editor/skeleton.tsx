'use client';

import { useI18n } from '@/lib/i18n/context';
import styles from './block-editor.module.css';

/** The canvas's shape while the editor loads, so nothing jumps. */
export function EditorSkeleton() {
  const { __ } = useI18n();
  return (
    <div className={styles.loading} aria-busy="true">
      <span className="visually-hidden">{__('Loading the editor…', 'pressbase-admin')}</span>
      <div className={styles.loadingToolbar} />
      <div className={styles.loadingCanvas}>
        <div className={styles.loadingTitle} />
        <div className={styles.loadingLine} />
        <div className={styles.loadingLine} />
        <div className={styles.loadingLine} data-short />
      </div>
    </div>
  );
}
