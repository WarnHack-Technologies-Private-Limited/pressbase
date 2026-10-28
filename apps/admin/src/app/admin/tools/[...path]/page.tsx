import type { Metadata } from 'next';
import { PluginPageScreen, pluginPageTitle } from '@/components/extensions/plugin-page-screen';

type Props = { params: Promise<{ path: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: await pluginPageTitle((await params).path) };
}

/** A plugin's page under Tools (add_management_page): /admin/tools/{plugin}[/{page}]. */
export default async function PluginToolsPage({ params }: Props) {
  return <PluginPageScreen parent="tools" segments={(await params).path} />;
}
