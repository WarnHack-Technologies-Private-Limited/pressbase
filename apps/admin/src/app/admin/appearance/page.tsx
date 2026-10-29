import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppearanceSubnav } from '@/components/appearance/appearance-subnav';
import { ThemeList } from '@/components/appearance/theme-list';
import { ThemeUploadButton } from '@/components/appearance/theme-upload';
import { PageHeader } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/surface';
import { coreGet, type SiteIndex } from '@/lib/core';
import { type RestTheme, sortThemes } from '@/lib/themes';
import styles from './appearance.module.css';

export const metadata: Metadata = { title: 'Themes' };

/**
 * Appearance → Themes (wp-admin/themes.php): the installed themes, switching
 * between them, uploading a theme (theme-install.php?upload) and deleting one.
 */
export default async function AppearancePage({
  searchParams,
}: {
  searchParams: Promise<{ installed?: string }>;
}) {
  const [themes, site, params] = await Promise.all([
    coreGet<RestTheme[]>('/wp/v2/themes'),
    coreGet<SiteIndex>('/'),
    searchParams,
  ]);
  if (themes.status === 401) redirect('/login');
  if (themes.status === 403) redirect('/admin');
  const home = site.data.url || '/';
  const active =
    themes.status === 200 ? (themes.data.find((t) => t.status === 'active')?.stylesheet ?? '') : '';

  return (
    <>
      <PageHeader
        title="Themes"
        description="A theme sets how your site looks. Switching themes keeps your content."
        actions={
          <div className={styles.headerActions}>
            <a href={home} className={styles.visit} target="_blank" rel="noreferrer">
              Visit site
              <ExternalLink size={14} aria-hidden="true" />
              <span className="visually-hidden">(opens in a new tab)</span>
            </a>
            <ThemeUploadButton activeStylesheet={active} />
          </div>
        }
      />
      <AppearanceSubnav />
      {themes.status === 200 ? (
        <ThemeList themes={sortThemes(themes.data)} installed={params.installed ?? null} />
      ) : (
        <Notice tone="danger" title="The list of themes couldn’t be loaded.">
          Reload the page. If it keeps happening, check that the core server is running.
        </Notice>
      )}
    </>
  );
}
