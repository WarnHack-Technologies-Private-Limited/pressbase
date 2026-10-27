'use client';

import dynamic from 'next/dynamic';
import styles from './block-editor.module.css';

export type { BlockEditorHandle, BlockEditorProps } from './block-editor';

/** Class for containers of WordPress UI outside the editor (the Block tab): always light. */
export const lightScope = styles.light;

/**
 * The block editor, loaded on demand and only in the browser: Gutenberg
 * needs `window`, and keeping it out of the main bundle keeps the rest of the
 * admin fast. The placeholder has the canvas's shape, so nothing jumps.
 */
export const BlockEditor = dynamic(() => import('./block-editor'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading} aria-busy="true">
      <span className="visually-hidden">Loading the editor…</span>
      <div className={styles.loadingToolbar} />
      <div className={styles.loadingCanvas}>
        <div className={styles.loadingTitle} />
        <div className={styles.loadingLine} />
        <div className={styles.loadingLine} />
        <div className={styles.loadingLine} data-short />
      </div>
    </div>
  ),
});
