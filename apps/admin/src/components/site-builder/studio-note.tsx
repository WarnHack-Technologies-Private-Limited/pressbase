'use client';

import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { placeholderCount, type Run } from '@/lib/site-builder';
import studio from '../studio/studio.module.css';
import { Button } from '../ui/button';
import styles from './site-builder.module.css';

/**
 * Above Studio's canvas after a build (`?run=`, #60): the site is a draft,
 * and what's left to fill in before publishing, page by page; each page
 * opens on the canvas, and the "Before you publish" checklist (#61) lists
 * every gap, image and failed check, each a click from its block.
 */
export function SiteBuilderNote({
  runId,
  onOpenPage,
  isOpenable,
  onOpenChecklist,
}: {
  runId: number;
  onOpenPage: (slug: string) => void;
  /** Opens the "Before you publish" checklist (#61). */
  onOpenChecklist: () => void;
  /** Whether Studio has this page (the draft may have changed since). */
  isOpenable: (slug: string) => boolean;
}) {
  const { __, _n, sprintf } = useI18n();
  const [run, setRun] = useState<Run | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    api<Run>(`/pressbase/v1/site-builder/runs/${runId}`)
      .then((r) => live && setRun(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runId]);

  if (!run || dismissed) return null;
  const gaps = placeholderCount(run);
  const pages = run.pages.filter((p) => p.status === 'done' && p.placeholders.length);
  return (
    <div className={studio.stageNotice} role="status" data-site-builder-note>
      <Sparkles size={16} aria-hidden="true" />
      <div className={styles.note}>
        <p>
          {gaps
            ? sprintf(
                _n(
                  'Your new site is a draft: nobody sees it until you publish. %d thing to fill in before you publish:',
                  'Your new site is a draft: nobody sees it until you publish. %d things to fill in before you publish:',
                  gaps,
                  'pressbase-admin',
                ),
                gaps,
              )
            : __(
                'Your new site is a draft: nobody sees it until you publish. Check each page, then publish when you’re happy.',
                'pressbase-admin',
              )}{' '}
          {pages.map((page, i) => (
            <span key={page.slug}>
              {i > 0 && ', '}
              {isOpenable(page.slug) ? (
                <button
                  type="button"
                  className={styles.noteLink}
                  onClick={() => onOpenPage(page.slug)}
                >
                  {sprintf(
                    // translators: 1: a page's title, 2: how many gaps it has.
                    __('%1$s (%2$d)', 'pressbase-admin'),
                    page.title,
                    page.placeholders.length,
                  )}
                </button>
              ) : (
                sprintf(__('%1$s (%2$d)', 'pressbase-admin'), page.title, page.placeholders.length)
              )}
            </span>
          ))}
        </p>
        <p className={styles.noteHint}>
          {__(
            'Gaps are in [square brackets]. The new colours and fonts show in Preview.',
            'pressbase-admin',
          )}{' '}
          <button type="button" className={styles.noteLink} onClick={onOpenChecklist}>
            {__('See everything to fill in on the checklist', 'pressbase-admin')}
          </button>
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className={studio.iconButton}
        icon={<X size={16} aria-hidden="true" />}
        aria-label={__('Dismiss', 'pressbase-admin')}
        onClick={() => setDismissed(true)}
      />
    </div>
  );
}
