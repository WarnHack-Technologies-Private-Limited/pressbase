import { Lock, Puzzle } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { coreGet } from '@/lib/core';
import { type PageParent, pageHref, parsePagePath } from '@/lib/extensions/pages';
import { type PluginPageDetails, pageEndpoint } from '@/lib/extensions/settings';
import { PageHeader } from '../shell/page-header';
import { ButtonLink } from '../ui/button';
import { Card, EmptyState } from '../ui/surface';
import styles from './extensions.module.css';
import { PluginPageBody } from './plugin-page-body';
import { PluginSettingsForm } from './plugin-settings-form';

/** One request per render for the page's metadata and body. */
export const loadPluginPage = cache(async (segments: string[]) => {
  const path = parsePagePath(segments);
  if (!path) return null;
  return coreGet<PluginPageDetails>(pageEndpoint(path.plugin, path.page));
});

export async function pluginPageTitle(segments: string[]): Promise<string> {
  const result = await loadPluginPage(segments);
  return result?.status === 200 ? result.data.title : 'Not found';
}

/**
 * A plugin's admin page, under Settings, Tools or at the top level: a
 * settings form drawn from its schema, a browser module's UI, or both.
 * Capabilities are checked by core; a page reached under the wrong parent
 * redirects to its real address.
 */
export async function PluginPageScreen({
  parent,
  segments,
}: {
  parent: PageParent | null;
  segments: string[];
}) {
  const result = await loadPluginPage(segments);
  if (!result || result.status === 404) notFound();
  if (result.status === 401) redirect('/login');
  // Under Settings the layout already has its header.
  const header = parent !== 'settings';
  if (result.status === 403) {
    return (
      <>
        {header && <PageHeader title="Not allowed" />}
        <Card>
          <EmptyState
            icon={<Lock size={28} />}
            title="You don’t have access to this"
            action={
              <ButtonLink href="/admin" variant="secondary">
                Back to the dashboard
              </ButtonLink>
            }
          >
            <p>This page belongs to a plugin and needs a role with more permissions.</p>
          </EmptyState>
        </Card>
      </>
    );
  }
  if (result.status !== 200) throw new Error(`Core answered ${result.status} for a plugin page.`);
  const page = result.data;
  if (page.parent !== parent || pageHref(page) !== hrefOf(parent, segments))
    redirect(pageHref(page));

  const hasSettings = page.sections.length > 0;
  return (
    <>
      {header && <PageHeader title={page.title} description={page.description || undefined} />}
      {!header && page.description && <p className={styles.pageDescription}>{page.description}</p>}
      <div className={styles.pageBody}>
        {page.module && (
          <PluginPageBody
            plugin={page.plugin}
            page={page.slug}
            title={page.plugin_title}
            module={page.module}
          />
        )}
        {hasSettings && <PluginSettingsForm page={page} />}
        {!page.module && !hasSettings && (
          <Card>
            <EmptyState icon={<Puzzle size={28} />} title="Nothing to set up here">
              <p>{page.plugin_title} hasn’t added anything to this page.</p>
            </EmptyState>
          </Card>
        )}
      </div>
    </>
  );
}

function hrefOf(parent: PageParent | null, segments: string[]): string {
  const base = parent ? `/admin/${parent}` : '/admin/plugin';
  return `${base}/${segments.join('/')}`;
}
