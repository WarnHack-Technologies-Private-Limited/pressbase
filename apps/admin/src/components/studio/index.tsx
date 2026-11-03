'use client';

import dynamic from 'next/dynamic';
import { useI18n } from '@/lib/i18n/context';
import styles from './studio.module.css';

export type { StudioProps } from './studio';

function StudioLoading() {
  const { __ } = useI18n();
  return (
    <div className={styles.root} aria-busy="true">
      <div className={styles.topBar} />
      <div className={styles.canvasLoading}>
        <span className="visually-hidden">{__('Opening Studio…', 'pressbase-admin')}</span>
        <div className={styles.loadingHeader} />
        <div className={styles.loadingHero} />
        <div className={styles.loadingLine} />
        <div className={styles.loadingLine} data-short />
      </div>
    </div>
  );
}

/**
 * Studio, loaded on demand and only in the browser, like the post editor
 * (../block-editor/index.tsx): the block editor needs `window`, and its
 * translations load first because block titles are translated as blocks
 * register.
 */
export const Studio = dynamic(
  async () => {
    const { loadEditorTranslations } = await import('../block-editor/translations');
    await loadEditorTranslations();
    return import('./studio');
  },
  { ssr: false, loading: () => <StudioLoading /> },
);
