'use client';

import { FileText, Globe, LayoutTemplate, Palette, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { type ChangeDescription, parseKey } from './changes-model';
import styles from './studio.module.css';

export interface PendingChange extends ChangeDescription {
  key: string;
}

const ICONS: Record<string, ReactNode> = {
  page: <FileText size={16} aria-hidden="true" />,
  wp_template_part: <LayoutTemplate size={16} aria-hidden="true" />,
  wp_template: <LayoutTemplate size={16} aria-hidden="true" />,
  wp_global_styles: <Palette size={16} aria-hidden="true" />,
};

/**
 * *Publish N* (#31): the button says how many things the draft changes; it
 * opens a panel listing them (each can be put back on its own), with
 * Publish and Discard all. A non-modal dialog: Escape or a click outside
 * closes it and focus returns to the button.
 */
export function PublishButton({
  changes,
  busy,
  disabled,
  onPublish,
  onRevert,
  onDiscardAll,
  openSignal = 0,
}: {
  /** Opens the list when it changes (the command palette's Publish, #33). */
  openSignal?: number;
  changes: PendingChange[];
  busy: 'publish' | 'discard' | 'revert' | null;
  disabled?: boolean;
  onPublish: () => Promise<boolean>;
  onRevert: (key: string) => void;
  onDiscardAll: () => void;
}) {
  const { __, _n, sprintf } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const count = changes.length;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Asked to open from elsewhere: the list, with focus on its Publish button.
  const panelRef = useRef<HTMLDivElement>(null);
  // Only a new signal opens it; `count` is read, not watched.
  useEffect(() => {
    if (!openSignal || count === 0) return;
    setOpen(true);
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>('[data-publish-confirm]')?.focus(),
    );
  }, [openSignal]);

  // Nothing left to list: the panel has done its job.
  useEffect(() => {
    if (open && count === 0 && !busy) setOpen(false);
  }, [open, count, busy]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const label = count
    ? sprintf(_n('Publish, %d change', 'Publish, %d changes', count, 'pressbase-admin'), count)
    : __('Publish', 'pressbase-admin');

  return (
    <div ref={wrapRef} className={styles.publishWrap}>
      <Button
        ref={buttonRef}
        size="sm"
        variant="primary"
        loading={busy === 'publish'}
        disabled={disabled}
        aria-disabled={count === 0}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={count ? undefined : __('No changes to publish yet', 'pressbase-admin')}
        onClick={() => count > 0 && setOpen((o) => !o)}
      >
        {__('Publish', 'pressbase-admin')}
        {count > 0 && (
          <span className={styles.publishCount} aria-hidden="true">
            {count.toLocaleString()}
          </span>
        )}
      </Button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className={styles.publishPanel}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <h2 id={titleId} className={styles.publishTitle}>
            {sprintf(
              _n(
                '%d change ready to publish',
                '%d changes ready to publish',
                count,
                'pressbase-admin',
              ),
              count,
            )}
          </h2>
          <p className={styles.muted}>
            {__(
              'They’re saved in your draft. Visitors see them once you publish, all at once.',
              'pressbase-admin',
            )}
          </p>
          <ul className={styles.changeList}>
            {changes.map((change) => (
              <li key={change.key} className={styles.changeItem}>
                <span className={styles.changeIcon}>
                  {ICONS[parseKey(change.key).type] ?? <Globe size={16} aria-hidden="true" />}
                </span>
                <span className={styles.changeText}>
                  <span className={styles.changeTitle}>{change.title}</span>
                  {change.detail && <span className={styles.changeDetail}>{change.detail}</span>}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className={styles.iconButton}
                  icon={<RotateCcw size={16} aria-hidden="true" />}
                  aria-label={sprintf(__('Undo changes to %s', 'pressbase-admin'), change.title)}
                  title={__('Undo these changes', 'pressbase-admin')}
                  disabled={Boolean(busy)}
                  onClick={() => onRevert(change.key)}
                />
              </li>
            ))}
          </ul>
          <div className={styles.publishActions}>
            <Button
              size="sm"
              variant="ghost"
              className={styles.discardAll}
              disabled={Boolean(busy)}
              onClick={() => {
                setOpen(false);
                onDiscardAll();
              }}
            >
              {__('Discard all', 'pressbase-admin')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-publish-confirm
              loading={busy === 'publish'}
              disabled={Boolean(busy) && busy !== 'publish'}
              onClick={async () => {
                if (busy) return;
                if (await onPublish()) close();
              }}
            >
              {sprintf(
                _n('Publish %d change', 'Publish %d changes', count, 'pressbase-admin'),
                count,
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
