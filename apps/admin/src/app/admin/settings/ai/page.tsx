import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type AiSettingsData, AiSettingsForm } from '@/components/settings/ai-settings';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'AI Settings' };

/** Settings → AI (WordPress 7 keeps provider keys in Settings → Connectors). */
export default async function AiSettingsPage() {
  const { status, data } = await coreGet<AiSettingsData>('/pressbase/v1/ai/settings');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  return <AiSettingsForm initial={data} />;
}
