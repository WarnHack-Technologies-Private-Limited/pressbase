import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { SiteBuilderStatus } from '@/components/site-builder/build-offer';
import { PromptToSite } from '@/components/site-builder/prompt-to-site';
import { ButtonLink } from '@/components/ui/button';
import { Notice } from '@/components/ui/surface';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';
import { getI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { __ } = await getI18n();
  return { title: __('Build your site', 'pressbase-admin') };
}

type Props = { searchParams: Promise<{ run?: string }> };

/**
 * Prompt to site (#60): the guided flow from a description to a draft
 * site, full-screen like Studio (isFullScreen() covers /admin/studio/…).
 * For people who can change the design (`edit_theme_options`), with AI
 * set up; otherwise it says why and where to go. ?run= follows a build.
 */
export default async function BuildScreen({ searchParams }: Props) {
  const [me, site, status, { __ }] = await Promise.all([
    coreGet<Me>('/wp/v2/users/me?context=edit'),
    coreGet<SiteIndex>('/'),
    coreGet<SiteBuilderStatus>('/pressbase/v1/site-builder/status'),
    getI18n(),
  ]);
  if (me.status === 401) redirect('/login');
  const caps = me.data.capabilities ?? {};

  const stop = (title: string, body: string, link?: { href: string; label: string }) => (
    <div style={{ maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
      <Notice tone="warning" title={title}>
        <p>{body}</p>
        <p style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {link && (
            <ButtonLink href={link.href} variant="primary">
              {link.label}
            </ButtonLink>
          )}
          <ButtonLink href="/admin" variant="secondary">
            {__('Back to the dashboard', 'pressbase-admin')}
          </ButtonLink>
        </p>
      </Notice>
    </div>
  );

  if (!caps.edit_theme_options || status.status !== 200) {
    return stop(
      __('Building a site is for people who can change its design.', 'pressbase-admin'),
      __(
        'Ask an administrator if you’d like to build the site from a description.',
        'pressbase-admin',
      ),
    );
  }
  if (!status.data.supports_ai && !status.data.active_run) {
    return stop(
      __('AI isn’t set up yet', 'pressbase-admin'),
      status.data.can_manage_ai
        ? __(
            'Turn on AI and add a key in Settings → AI, then come back to build your site from a description.',
            'pressbase-admin',
          )
        : __('Ask an administrator to turn on AI in Settings → AI.', 'pressbase-admin'),
      status.data.can_manage_ai
        ? { href: '/admin/settings/ai', label: __('Open Settings → AI', 'pressbase-admin') }
        : undefined,
    );
  }

  const query = await searchParams;
  return (
    <PromptToSite
      status={status.data}
      siteName={site.data.name ?? ''}
      requestedRun={Number(query.run) || undefined}
      canUpload={Boolean(caps.upload_files)}
      canSetLogo={Boolean(caps.manage_options)}
    />
  );
}
