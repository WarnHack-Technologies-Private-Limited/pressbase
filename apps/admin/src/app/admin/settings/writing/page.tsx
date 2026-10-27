import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type WritingSettings, WritingSettingsForm } from '@/components/settings/writing-settings';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Writing Settings' };

export default async function WritingSettingsPage() {
  const [{ status, data }, categories] = await Promise.all([
    coreGet<WritingSettings>('/wp/v2/settings'),
    coreGet<{ id: number; name: string }[]>('/wp/v2/categories?per_page=100&orderby=name'),
  ]);
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  return (
    <WritingSettingsForm
      initial={{ default_category: data.default_category }}
      categories={categories.status === 200 ? categories.data : []}
    />
  );
}
