import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Studio } from '@/components/studio';
import type { StudioPage } from '@/components/studio/site-model';
import { ButtonLink } from '@/components/ui/button';
import { Notice } from '@/components/ui/surface';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = { title: 'Studio' };

type Props = { searchParams: Promise<{ page?: string; changeset_uuid?: string }> };

/** The pages Studio can open: every status an editor works with, as the page picker lists them. */
const PAGES =
  '/wp/v2/pages?context=edit&per_page=100&status=publish,draft,pending,private,future&orderby=menu_order&order=asc';

/**
 * Studio (#28): the full-screen site editor. WordPress's Appearance → Editor
 * (site-editor.php) needs `edit_theme_options`. People without it who can
 * edit pages (`edit_pages`) open their own pages here too (#29); the header,
 * footer and styles are then read-only. The admin shell shows this route
 * without its sidebar (admin-shell.tsx).
 */
export default async function StudioScreen({ searchParams }: Props) {
  const [me, site, pages] = await Promise.all([
    coreGet<Me>('/wp/v2/users/me?context=edit'),
    coreGet<SiteIndex>('/'),
    coreGet<StudioPage[]>(PAGES),
  ]);
  if (me.status === 401) redirect('/login');

  const caps = me.data.capabilities ?? {};
  if (!caps.edit_theme_options && !caps.edit_pages) {
    return (
      <div style={{ maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
        <Notice tone="warning" title="Studio is for people who can edit pages.">
          <p>
            Ask an administrator if you need to change your site’s pages or design. You can still
            write posts in Posts.
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

  const query = await searchParams;
  const requested = Number(query.page) || undefined;
  // The reading settings come from the REST index, which anyone can read (WP_REST_Server::get_index()).
  return (
    <Studio
      site={{ name: site.data.name, url: site.data.url }}
      reading={{
        show_on_front: site.data.show_on_front ?? 'posts',
        page_on_front: Number(site.data.page_on_front) || 0,
      }}
      timeZone={String(site.data.timezone_string ?? '')}
      pages={pages.status === 200 ? pages.data : []}
      requestedPage={requested}
      requestedChangeset={query.changeset_uuid}
      canUnfilteredHtml={Boolean(caps.unfiltered_html)}
      user={{
        id: me.data.id,
        canEditTheme: Boolean(caps.edit_theme_options),
        canManageOptions: Boolean(caps.manage_options),
        canPublishPages: Boolean(caps.publish_pages),
        canEditOthersPages: Boolean(caps.edit_others_pages),
      }}
    />
  );
}
