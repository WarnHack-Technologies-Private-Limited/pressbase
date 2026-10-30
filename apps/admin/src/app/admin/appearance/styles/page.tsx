import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppearanceSubnav } from '@/components/appearance/appearance-subnav';
import { StylesEditor } from '@/components/appearance/styles-editor';
import { PageHeader } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/surface';
import { coreGet, type SiteIndex } from '@/lib/core';
import type { GlobalStylesConfig, RestGlobalStyles, StyleVariation } from '@/lib/global-styles';
import { type RestTheme, themeName } from '@/lib/themes';

export const metadata: Metadata = { title: 'Styles' };

type ThemeWithLinks = RestTheme & { _links?: Record<string, { href: string }[]> };

/**
 * Appearance → Styles: the active block theme's global styles — WordPress's
 * site editor Styles panel, reduced to the essentials, with a live preview.
 */
export default async function StylesPage() {
  const [themes, site] = await Promise.all([
    coreGet<ThemeWithLinks[]>('/wp/v2/themes?status=active'),
    coreGet<SiteIndex>('/'),
  ]);
  if (themes.status === 401) redirect('/login');
  if (themes.status === 403) redirect('/admin');

  const theme = themes.status === 200 ? themes.data[0] : undefined;
  const href = theme?._links?.['wp:user-global-styles']?.[0]?.href;
  const id = href ? Number(href.split('/').pop()) : 0;
  const header = (
    <>
      <PageHeader
        title="Styles"
        description={
          theme
            ? `Colours, type and layout for ${themeName(theme)}. Changes show in the preview; nothing goes live until you save.`
            : undefined
        }
      />
      <AppearanceSubnav />
    </>
  );

  if (!theme || !id) {
    return (
      <>
        {header}
        <Notice tone="warning" title="This theme has no styles to edit.">
          Styles work with block themes, such as Pressbase. Activate one in Themes.
        </Notice>
      </>
    );
  }

  const stylesheet = encodeURIComponent(theme.stylesheet);
  const [user, base, variations] = await Promise.all([
    coreGet<RestGlobalStyles>(`/wp/v2/global-styles/${id}?context=edit`),
    coreGet<GlobalStylesConfig>(`/wp/v2/global-styles/themes/${stylesheet}`),
    coreGet<StyleVariation[]>(`/wp/v2/global-styles/themes/${stylesheet}/variations`),
  ]);
  if (user.status === 403) {
    return (
      <>
        {header}
        <Notice tone="warning" title="You can’t change this site’s styles.">
          Ask an administrator: editing styles needs the “Edit theme options” permission.
        </Notice>
      </>
    );
  }
  if (user.status !== 200 || base.status !== 200 || variations.status !== 200) {
    return (
      <>
        {header}
        <Notice tone="danger" title="The styles couldn’t be loaded.">
          Reload the page. If it keeps happening, check that the core server is running.
        </Notice>
      </>
    );
  }

  return (
    <>
      {header}
      <StylesEditor
        themeName={themeName(theme)}
        stylesheet={theme.stylesheet}
        home={site.data.url}
        user={user.data}
        base={base.data}
        variations={variations.data}
      />
    </>
  );
}
