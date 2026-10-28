import type { Metadata } from 'next';
import { PluginPageScreen, pluginPageTitle } from '@/components/extensions/plugin-page-screen';

type Props = { params: Promise<{ path: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `${await pluginPageTitle((await params).path)} Settings` };
}

/** A plugin's settings page (add_options_page): /admin/settings/{plugin}[/{page}]. */
export default async function PluginSettingsPage({ params }: Props) {
  return <PluginPageScreen parent="settings" segments={(await params).path} />;
}
