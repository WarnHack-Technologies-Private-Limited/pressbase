import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type MediaSettings, MediaSettingsForm } from '@/components/settings/media-settings';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Media Settings' };

export default async function MediaSettingsPage() {
  const { status, data } = await coreGet<MediaSettings>('/wp/v2/settings');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  return (
    <MediaSettingsForm
      initial={{
        thumbnail_size_w: data.thumbnail_size_w,
        thumbnail_size_h: data.thumbnail_size_h,
        thumbnail_crop: data.thumbnail_crop,
        medium_size_w: data.medium_size_w,
        medium_size_h: data.medium_size_h,
        large_size_w: data.large_size_w,
        large_size_h: data.large_size_h,
        uploads_use_yearmonth_folders: data.uploads_use_yearmonth_folders,
      }}
    />
  );
}
