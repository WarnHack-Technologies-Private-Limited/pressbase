import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Studio } from '@/components/studio';
import type { ReadingSettings, StudioPage } from '@/components/studio/site-model';
import { ButtonLink } from '@/components/ui/button';
import { Notice } from '@/components/ui/surface';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = { title: 'Studio' };

type Props = { searchParams: Promise<{ page?: string }> };

/** The pages Studio can open: every status an editor works with, as the page picker lists them. */
const PAGES =
  '/wp/v2/pages?context=edit&per_page=100&status=publish,draft,pending,private,future&orderby=menu_order&order=asc';

/**
 * Studio (#28): the full-screen site editor. WordPress's Appearance → Editor
 * (site-editor.php) needs `edit_theme_options`, and so does Studio; authors
 * opening their own pages here is #29. The admin shell shows this route
 * without its sidebar (admin-shell.tsx).
 */
export default async function StudioScreen({ searchParams }: Props) {
  const [me, site, reading, pages] = await Promise.all([
    coreGet<Me>('/wp/v2/users/me?context=edit'),
    coreGet<SiteIndex>('/'),
    coreGet<ReadingSettings>('/wp/v2/settings'),
    coreGet<StudioPage[]>(PAGES),
  ]);
  if (me.status === 401) redirect('/login');

  if (!me.data.capabilities?.edit_theme_options) {
    return (
      <div style={{ maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
        <Notice tone="warning" title="Studio is for people who can change the site’s design.">
          <p>
            Ask an administrator: Studio needs the “Edit theme options” permission. You can still
            edit your pages in Pages.
          </p>
          <p style={{ marginTop: '1rem' }}>
            <ButtonLink href="/admin" variant="secondary">
              Back to the dashboard
            </ButtonLink>
          </p>
        </Notice>
      </div>
    );
  }

  const requested = Number((await searchParams).page) || undefined;
  return (
    <Studio
      site={{ name: site.data.name, url: site.data.url }}
      reading={{
        show_on_front: reading.status === 200 ? reading.data.show_on_front : 'posts',
        page_on_front: reading.status === 200 ? Number(reading.data.page_on_front) || 0 : 0,
      }}
      pages={pages.status === 200 ? pages.data : []}
      requestedPage={requested}
      canUnfilteredHtml={Boolean(me.data.capabilities.unfiltered_html)}
    />
  );
}
