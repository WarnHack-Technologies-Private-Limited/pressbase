import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PluginList } from '@/components/plugins/plugin-list';
import { PageHeader } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/surface';
import { coreGet } from '@/lib/core';
import { type RestPlugin, sortPlugins } from '@/lib/plugins';

export const metadata: Metadata = { title: 'Plugins' };

/** Plugins (wp-admin/plugins.php): installed plugins, activation, upload and deletion. */
export default async function PluginsPage() {
  const plugins = await coreGet<RestPlugin[]>('/wp/v2/plugins');
  if (plugins.status === 401) redirect('/login');
  if (plugins.status === 403) redirect('/admin');

  return (
    <>
      <PageHeader
        title="Plugins"
        description="Plugins add features to your site. Activating or removing one takes effect right away."
      />
      {plugins.status === 200 ? (
        <PluginList plugins={sortPlugins(plugins.data)} />
      ) : (
        <Notice tone="danger" title="The list of plugins couldn’t be loaded.">
          Reload the page. If it keeps happening, check that the core server is running.
        </Notice>
      )}
    </>
  );
}
