'use client';

import {
  Blocks,
  FileText,
  History,
  Image,
  Layers,
  LayoutPanelTop,
  type LucideIcon,
  Palette,
  Sparkles,
  X,
} from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { RAIL_PANELS, type RailPanel, type RailPanelId } from './layout-model';
import styles from './studio.module.css';

export const RAIL_ICONS: Record<RailPanelId, LucideIcon> = {
  pages: FileText,
  elements: Blocks,
  sections: LayoutPanelTop,
  layers: Layers,
  styles: Palette,
  media: Image,
  ai: Sparkles,
  history: History,
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
          const Icon = RAIL_ICONS[panel.id];
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
  /** A built panel's content (Pages, Sections), from Studio. */
  content?: ReactNode;
  /** A note at the top of the panel (what this person can't change, and why). */
  note?: ReactNode;
}

/**
 * The open rail panel, beside the canvas. Built panels (Pages, Elements,
 * Sections, Layers, Styles, AI, History) get their content from Studio; the
 * rest say which issue brings them. Escape closes the panel and returns
 * focus to its rail button.
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
    // A dialog opened from the panel (History's previews) closes on its own.
    const inDialog = (event.target as Element | null)?.closest?.('dialog');
    if (event.key === 'Escape' && !event.defaultPrevented && !inDialog) {
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
        {props.note}
        {panel.interim === 'built' && props.content}
        {panel.coming && <Coming panel={panel} coming={panel.coming} />}
      </div>
    </aside>
  );
}

function Coming({ panel, coming }: { panel: RailPanel; coming: string }) {
  const { __ } = useI18n();
  const Icon = RAIL_ICONS[panel.id];
  const full = panel.interim === 'none';
  return (
    <div className={styles.coming} data-full={full || undefined}>
      {full && <Icon size={28} aria-hidden="true" className={styles.comingIcon} />}
      {full && <p className={styles.comingSummary}>{__(panel.summary, 'pressbase-admin')}</p>}
      <p>{__(coming, 'pressbase-admin')}</p>
    </div>
  );
}
