'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { ButtonLink } from '../ui/button';
import styles from './site-builder.module.css';

export interface SiteBuilderStatus {
  supports_ai: boolean;
  can_manage_ai: boolean;
  max_pages: number;
  max_questions: number;
  active_run: number | null;
}

export const BUILD_PATH = '/admin/studio/build';

/**
 * "Build your site with AI": where the guided flow is offered (after the
 * installer, on an empty site's dashboard, in Studio's AI panel). With AI
 * off it says so and links to Settings → AI, for people who can turn it on.
 * Pass `status` when the server already has it; otherwise it's fetched.
 */
export function BuildOffer({
  status: given,
  variant = 'card',
}: {
  status?: SiteBuilderStatus | null;
  variant?: 'card' | 'panel' | 'installer';
}) {
  const { __ } = useI18n();
  const [status, setStatus] = useState<SiteBuilderStatus | null | undefined>(given);

  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    api<SiteBuilderStatus>('/pressbase/v1/site-builder/status')
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [given]);

  if (!status) return null;

  if (!status.supports_ai) {
    return (
      <p className={styles.offerOff} data-variant={variant}>
        {status.can_manage_ai ? (
          <>
            {__('Want help building your site? ', 'pressbase-admin')}
            <Link href="/admin/settings/ai">
              {__('Turn on AI in Settings → AI', 'pressbase-admin')}
            </Link>
            {__(', then describe your site and Pressbase drafts it for you.', 'pressbase-admin')}
          </>
        ) : (
          __(
            'An administrator can turn on AI in Settings → AI to build your site from a description.',
            'pressbase-admin',
          )
        )}
      </p>
    );
  }

  const resuming = status.active_run !== null;
  return (
    <div className={styles.offer} data-variant={variant}>
      {variant !== 'installer' && (
        <span className={styles.offerIcon} aria-hidden="true">
          <Sparkles size={20} />
        </span>
      )}
      <div className={styles.offerText}>
        <p className={styles.offerTitle}>
          {resuming
            ? __('Your site is being built', 'pressbase-admin')
            : __('Build your site from a description', 'pressbase-admin')}
        </p>
        <p className={styles.offerBody}>
          {resuming
            ? __('Pick up where you left off and watch the pages arrive.', 'pressbase-admin')
            : __(
                'Say what your site is for. Pressbase plans the pages, picks a look and writes a first draft. Nothing goes live until you publish it.',
                'pressbase-admin',
              )}
        </p>
      </div>
      <ButtonLink
        href={resuming ? `${BUILD_PATH}?run=${status.active_run}` : BUILD_PATH}
        variant="primary"
        icon={<Sparkles size={16} aria-hidden="true" />}
        fullWidth={variant !== 'card'}
      >
        {resuming
          ? __('See the progress', 'pressbase-admin')
          : __('Build my site', 'pressbase-admin')}
      </ButtonLink>
    </div>
  );
}
