'use client';

import dynamic from 'next/dynamic';
import { useI18n } from '@/lib/i18n/context';
import styles from './block-editor.module.css';

export type { BlockEditorHandle, BlockEditorProps } from './block-editor';

/** Class for containers of WordPress UI outside the editor (the Block tab): always light. */
export const lightScope = styles.light;

/** The canvas's shape while the editor loads, so nothing jumps. */
function EditorSkeleton() {
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

/**
 * The block editor, loaded on demand and only in the browser: Gutenberg
 * needs `window`, and keeping it out of the main bundle keeps the rest of the
 * admin fast. Its translations load first (translations.ts): Gutenberg
 * translates block titles as it registers them.
 */
export const BlockEditor = dynamic(
  async () => {
    const { loadEditorTranslations } = await import('./translations');
    await loadEditorTranslations();
    return import('./block-editor');
  },
  { ssr: false, loading: () => <EditorSkeleton /> },
);
