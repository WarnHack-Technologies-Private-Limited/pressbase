import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppearanceSubnav } from '@/components/appearance/appearance-subnav';
import { MenuEditor } from '@/components/appearance/menu-editor';
import { PageHeader } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/surface';
import { coreGet, type SiteIndex } from '@/lib/core';
import type { FallbackState, RestMenu } from '@/lib/menus-api';
import styles from '../appearance.module.css';

export const metadata: Metadata = { title: 'Menus' };

/**
 * Appearance → Menus (wp-admin/nav-menus.php, for block themes): the site's
 * `wp_navigation` menus and which one the header shows.
 * See docs/architecture/navigation.md.
 */
export default async function MenusPage() {
  const [menus, fallback, site] = await Promise.all([
    coreGet<RestMenu[]>('/wp/v2/navigation?context=edit&per_page=100&status=publish,draft'),
    coreGet<FallbackState>('/pressbase/v1/navigation-fallback'),
    coreGet<SiteIndex>('/'),
  ]);
  if (menus.status === 401) redirect('/login?redirect_to=/admin/appearance/menus');
  if (menus.status === 403 || fallback.status === 403) redirect('/admin');
  const home = site.data.url || '/';

  return (
    <>
      <PageHeader
        title="Menus"
        description="Choose the links visitors see in your site’s navigation."
        actions={
          <a href={home} className={styles.visit} target="_blank" rel="noreferrer">
            Visit site
            <ExternalLink size={14} aria-hidden="true" />
            <span className="visually-hidden">(opens in a new tab)</span>
          </a>
        }
      />
      <AppearanceSubnav />
      {menus.status === 200 && fallback.status === 200 ? (
        <MenuEditor initialMenus={menus.data} initialFallback={fallback.data} />
      ) : (
        <Notice tone="danger" title="Your menus couldn’t be loaded.">
          Reload the page. If it keeps happening, check that the core server is running.
        </Notice>
      )}
    </>
  );
}
