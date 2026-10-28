import type { Metadata } from 'next';
import { PluginPageScreen, pluginPageTitle } from '@/components/extensions/plugin-page-screen';

type Props = { params: Promise<{ path: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: await pluginPageTitle((await params).path) };
}

/** A plugin's top-level page (add_menu_page): /admin/plugin/{plugin}[/{page}]. */
export default async function PluginTopLevelPage({ params }: Props) {
  return <PluginPageScreen parent={null} segments={(await params).path} />;
}
