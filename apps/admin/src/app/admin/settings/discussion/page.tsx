import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  type DiscussionSettings,
  DiscussionSettingsForm,
} from '@/components/settings/discussion-settings';
import { DISCUSSION_KEYS } from '@/lib/comments';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Discussion Settings' };

export default async function DiscussionSettingsPage() {
  const { status, data } = await coreGet<DiscussionSettings>('/wp/v2/settings');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  const initial = Object.fromEntries(
    DISCUSSION_KEYS.map((key) => [key, data[key]]),
  ) as DiscussionSettings;
  return <DiscussionSettingsForm initial={initial} />;
}
