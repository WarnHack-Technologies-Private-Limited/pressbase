import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReadingSettings, ReadingSettingsForm } from '@/components/settings/reading-settings';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Reading Settings' };

export default async function ReadingSettingsPage() {
  const [{ status, data }, pages] = await Promise.all([
    coreGet<ReadingSettings>('/wp/v2/settings'),
    coreGet<{ id: number; title: { rendered: string } }[]>(
      '/wp/v2/pages?per_page=100&orderby=title&order=asc',
    ),
  ]);
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');
  const {
    show_on_front,
    page_on_front,
    page_for_posts,
    posts_per_page,
    blog_public,
    posts_per_rss,
    rss_use_excerpt,
  } = data;
  return (
    <ReadingSettingsForm
      initial={{
        show_on_front,
        page_on_front,
        page_for_posts,
        posts_per_page,
        blog_public,
        posts_per_rss,
        rss_use_excerpt,
      }}
      pages={(pages.status === 200 ? pages.data : []).map((p) => ({
        id: p.id,
        title: p.title.rendered || '(no title)',
      }))}
    />
  );
}
