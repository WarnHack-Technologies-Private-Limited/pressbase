'use client';

import {
  __experimentalLibrary as InserterLibrary,
  __experimentalListView as ListView,
} from '@wordpress/block-editor';
import {
  Blocks,
  FileText,
  Home,
  Image,
  Layers,
  LayoutPanelTop,
  type LucideIcon,
  Palette,
  Sparkles,
  X,
} from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { lightScope } from '../block-editor';
import { Button } from '../ui/button';
import { RAIL_PANELS, type RailPanel, type RailPanelId } from './layout-model';
import { type CanvasTarget, pageTitle, pageTree, type StudioPage } from './site-model';
import styles from './studio.module.css';

const ICONS: Record<RailPanelId, LucideIcon> = {
  pages: FileText,
  elements: Blocks,
  sections: LayoutPanelTop,
  layers: Layers,
  styles: Palette,
  media: Image,
  ai: Sparkles,
};

/** The left rail: one button per panel. Pressing the open panel's button closes it. */
export function Rail({
  open,
  onToggle,
}: {
  open: RailPanelId | null;
  onToggle: (id: RailPanelId) => void;
}) {
  const { __ } = useI18n();
  return (
    <nav className={styles.rail} aria-label={__('Studio panels', 'pressbase-admin')}>
      <ul>
        {RAIL_PANELS.map((panel) => {
          const Icon = ICONS[panel.id];
          return (
            <li key={panel.id}>
              <button
                type="button"
                className={styles.railButton}
                data-panel-toggle={panel.id}
                aria-expanded={open === panel.id}
                aria-controls={open === panel.id ? 'studio-panel' : undefined}
                title={__(panel.summary, 'pressbase-admin')}
                onClick={() => onToggle(panel.id)}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{__(panel.label, 'pressbase-admin')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export interface PanelProps {
  id: RailPanelId;
  onClose: () => void;
  pages: StudioPage[];
  target: CanvasTarget;
  postsOnFront: boolean;
  frontPageId: number;
  onTarget: (target: CanvasTarget) => void;
}

/**
 * The open rail panel, beside the canvas. What's built today: the page list,
 * WordPress's block library (Elements) and list view (Layers). The rest say
 * which issue brings them. Escape closes the panel and returns focus to its
 * rail button.
 */
export function RailPanelView(props: PanelProps) {
  const { __ } = useI18n();
  const panel = RAIL_PANELS.find((p) => p.id === props.id) as RailPanel;
  const ref = useRef<HTMLElement>(null);
  const headingId = `studio-panel-${panel.id}-title`;

  // Start where a keyboard user wants to be: the search field, the tree, or the panel.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      const target =
        root?.querySelector<HTMLElement>('input[type="search"]') ??
        root?.querySelector<HTMLElement>('[role="treegrid"] a, [aria-current="page"]') ??
        root?.querySelector<HTMLElement>('h2');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [panel.id]);

  const close = () => {
    const toggle = document.querySelector<HTMLButtonElement>(`[data-panel-toggle="${panel.id}"]`);
    props.onClose();
    requestAnimationFrame(() => toggle?.focus());
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      close();
    }
  };

  return (
    <aside
      ref={ref}
      id="studio-panel"
      className={styles.panel}
      data-panel={panel.id}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
    >
      <header className={styles.panelHeader}>
        <h2 id={headingId} tabIndex={-1}>
          {__(panel.label, 'pressbase-admin')}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          className={styles.iconButton}
          aria-label={__('Close panel', 'pressbase-admin')}
          icon={<X size={16} aria-hidden="true" />}
          onClick={close}
        />
      </header>
      <div className={styles.panelBody}>
        {panel.interim === 'pages' && <PagesList {...props} />}
        {panel.interim === 'inserter' && (
          <div className={`${lightScope} ${styles.wpPanel}`}>
            <InserterLibrary
              showInserterHelpPanel={false}
              showMostUsedBlocks
              shouldFocusBlock
              onSelect={() => {}}
            />
          </div>
        )}
        {panel.interim === 'list-view' && (
          <div className={`${lightScope} ${styles.wpPanel}`}>
            <ListView
              isExpanded
              showBlockMovers
              description={__('Blocks on this page', 'pressbase-admin')}
            />
          </div>
        )}
        <Coming panel={panel} />
      </div>
    </aside>
  );
}

function Coming({ panel }: { panel: RailPanel }) {
  const { __ } = useI18n();
  const Icon = ICONS[panel.id];
  const full = panel.interim === 'none';
  return (
    <div className={styles.coming} data-full={full || undefined}>
      {full && <Icon size={28} aria-hidden="true" className={styles.comingIcon} />}
      {full && <p className={styles.comingSummary}>{__(panel.summary, 'pressbase-admin')}</p>}
      <p>{__(panel.coming, 'pressbase-admin')}</p>
      {panel.id === 'styles' && (
        <a href="/admin/appearance/styles" className={styles.comingLink}>
          {__('Open Appearance → Styles', 'pressbase-admin')}
        </a>
      )}
    </div>
  );
}

function PagesList({ pages, target, postsOnFront, frontPageId, onTarget }: PanelProps) {
  const { __ } = useI18n();
  const current = (t: CanvasTarget) =>
    t.kind === target.kind &&
    (t.kind === 'posts' || (target.kind === 'page' && t.id === target.id));
  const item = (t: CanvasTarget, label: string, home: boolean, depth = 0, note?: string) => (
    <li
      key={t.kind === 'posts' ? 'posts' : t.id}
      style={{ paddingInlineStart: `${depth * 1.25}rem` }}
    >
      <button
        type="button"
        className={styles.pageItem}
        aria-current={current(t) ? 'page' : undefined}
        onClick={() => onTarget(t)}
      >
        {home ? <Home size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
        <span className={styles.pageItemTitle}>{label}</span>
        {home && <span className={styles.pageBadge}>{__('Home', 'pressbase-admin')}</span>}
        {note && <span className={styles.pageNote}>{note}</span>}
      </button>
    </li>
  );
  return (
    <ul className={styles.pages}>
      {postsOnFront && item({ kind: 'posts' }, __('Latest posts', 'pressbase-admin'), true)}
      {pageTree(pages).map(({ page, depth }) =>
        item(
          { kind: 'page', id: page.id },
          pageTitle(page),
          !postsOnFront && page.id === frontPageId,
          depth,
          page.status === 'publish' ? undefined : __('Draft', 'pressbase-admin'),
        ),
      )}
    </ul>
  );
}
