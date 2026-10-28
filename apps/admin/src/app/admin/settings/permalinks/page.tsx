import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  type PermalinkSettings,
  PermalinkSettingsForm,
} from '@/components/settings/permalink-settings';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Permalink Settings' };

export default async function PermalinkSettingsPage() {
  const { status, data } = await coreGet<PermalinkSettings>('/pressbase/v1/permalinks');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  const settings = await coreGet<{ url?: string }>('/wp/v2/settings');
  return (
    <PermalinkSettingsForm
      home={settings.data.url ?? ''}
      initial={{
        permalink_structure: data.permalink_structure,
        category_base: data.category_base,
        tag_base: data.tag_base,
      }}
    />
  );
}
