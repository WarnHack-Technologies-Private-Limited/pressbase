'use client';

import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { type SyntheticEvent, useId, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import {
  addPage,
  addSection,
  MAX_PAGES,
  MAX_SECTIONS,
  move,
  removePage,
  removeSection,
  type SectionKind,
  type Sitemap,
  updatePage,
} from '@/lib/site-builder';
import { Button } from '../ui/button';
import { Badge } from '../ui/surface';
import styles from './site-builder.module.css';

/**
 * The Sitemap step: the pages, in menu order, each with its sections.
 * Pages move by drag and drop or with the arrow buttons (the keyboard
 * way), and each move is announced. Up to eight pages; the first is the
 * home page.
 */
export function SitemapEditor({
  sitemap,
  sections,
  onChange,
}: {
  sitemap: Sitemap;
  sections: SectionKind[];
  onChange: (next: Sitemap) => void;
}) {
  const { __, sprintf } = useI18n();
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState<Record<number, string>>({});
  const listRef = useRef<HTMLOListElement>(null);
  const newId = useId();
  const pages = sitemap.pages;
  const label = (category: string) =>
    sections.find((s) => s.category === category)?.label ?? category;

  const set = (next: Sitemap['pages']) => onChange({ pages: next });

  const movePageTo = (from: number, to: number, focus = false) => {
    if (to < 0 || to >= pages.length || from === to) return;
    set(move(pages, from, to));
    const title = pages[from]?.title ?? '';
    setAnnouncement(
      to === 0
        ? sprintf(__('%s moved to the top. It’s now the home page.', 'pressbase-admin'), title)
        : sprintf(
            __('%1$s moved to place %2$d of %3$d.', 'pressbase-admin'),
            title,
            to + 1,
            pages.length,
          ),
    );
    if (focus) {
      requestAnimationFrame(() =>
        listRef.current?.querySelectorAll<HTMLInputElement>('[data-page-title]')[to]?.focus(),
      );
    }
  };

  // Not a form of its own: the step around it is the form (Build my site).
  const onAddPage = (event?: SyntheticEvent) => {
    event?.preventDefault();
    const first = sections.find((s) => s.category === 'text' || s.category === 'about');
    const next = addPage(pages, newTitle, first?.category ?? sections[0]?.category ?? 'text');
    if (next.length === pages.length) return;
    set(next);
    setAnnouncement(sprintf(__('%s added.', 'pressbase-admin'), newTitle.trim()));
    setNewTitle('');
  };

  return (
    <div className={styles.sitemap}>
      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>
      <ol ref={listRef} className={styles.pageList}>
        {pages.map((page, i) => (
          <li
            key={i}
            className={styles.pageItem}
            data-dragging={dragging === i || undefined}
            data-over={over === i && dragging !== i ? true : undefined}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setOver(i);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null) movePageTo(dragging, i);
              setDragging(null);
              setOver(null);
            }}
          >
            <div className={styles.pageHead}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a mouse handle; the arrow buttons are the keyboard way. */}
              <span
                className={styles.dragHandle}
                draggable
                title={__('Drag to reorder', 'pressbase-admin')}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', page.title);
                  setDragging(i);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
              >
                <GripVertical size={18} aria-hidden="true" />
              </span>
              <label className={styles.srOnly} htmlFor={`${newId}-page-${i}`}>
                {sprintf(__('Page %d title', 'pressbase-admin'), i + 1)}
              </label>
              <input
                id={`${newId}-page-${i}`}
                data-page-title
                className={styles.pageTitle}
                value={page.title}
                maxLength={60}
                onChange={(event) =>
                  set(updatePage(pages, i, (p) => ({ ...p, title: event.target.value })))
                }
                // Enter keeps the title; it doesn't start the build.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
              {i === 0 && <Badge tone="accent">{__('Home page', 'pressbase-admin')}</Badge>}
              <span className={styles.pageActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowUp size={16} aria-hidden="true" />}
                  aria-label={sprintf(__('Move %s up', 'pressbase-admin'), page.title)}
                  disabled={i === 0}
                  onClick={() => movePageTo(i, i - 1, true)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowDown size={16} aria-hidden="true" />}
                  aria-label={sprintf(__('Move %s down', 'pressbase-admin'), page.title)}
                  disabled={i === pages.length - 1}
                  onClick={() => movePageTo(i, i + 1, true)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  aria-label={sprintf(__('Remove %s', 'pressbase-admin'), page.title)}
                  disabled={pages.length <= 1}
                  onClick={() => {
                    set(removePage(pages, i));
                    setAnnouncement(sprintf(__('%s removed.', 'pressbase-admin'), page.title));
                  }}
                />
              </span>
            </div>
            <ol
              className={styles.sectionList}
              aria-label={sprintf(__('Sections of %s', 'pressbase-admin'), page.title)}
            >
              {page.sections.map((section, s) => (
                <li key={s} className={styles.sectionChip}>
                  <span>{label(section.category)}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={sprintf(
                      __('Remove the %1$s section from %2$s', 'pressbase-admin'),
                      label(section.category),
                      page.title,
                    )}
                    disabled={page.sections.length <= 1}
                    onClick={() => set(updatePage(pages, i, (p) => removeSection(p, s)))}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
              {page.sections.length < MAX_SECTIONS && (
                <li className={styles.sectionAdd}>
                  <label className={styles.srOnly} htmlFor={`${newId}-add-${i}`}>
                    {sprintf(__('Add a section to %s', 'pressbase-admin'), page.title)}
                  </label>
                  <select
                    id={`${newId}-add-${i}`}
                    value={adding[i] ?? ''}
                    onChange={(event) => {
                      const category = event.target.value;
                      if (!category) return;
                      set(updatePage(pages, i, (p) => addSection(p, category)));
                      setAdding((a) => ({ ...a, [i]: '' }));
                      setAnnouncement(
                        sprintf(
                          __('%1$s section added to %2$s.', 'pressbase-admin'),
                          label(category),
                          page.title,
                        ),
                      );
                    }}
                  >
                    <option value="">{__('+ Add section', 'pressbase-admin')}</option>
                    {sections.map((kind) => (
                      <option key={kind.category} value={kind.category}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                </li>
              )}
            </ol>
          </li>
        ))}
      </ol>
      <div className={styles.addPage}>
        <label htmlFor={`${newId}-new`} className={styles.addPageLabel}>
          {__('Add a page', 'pressbase-admin')}
        </label>
        <div className={styles.addPageRow}>
          <input
            id={`${newId}-new`}
            value={newTitle}
            maxLength={60}
            placeholder={__('Page title', 'pressbase-admin')}
            disabled={pages.length >= MAX_PAGES}
            aria-describedby={`${newId}-limit`}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onAddPage(event);
            }}
          />
          <Button
            icon={<Plus size={16} aria-hidden="true" />}
            disabled={pages.length >= MAX_PAGES || !newTitle.trim()}
            onClick={onAddPage}
          >
            {__('Add page', 'pressbase-admin')}
          </Button>
        </div>
        <p id={`${newId}-limit`} className={styles.hint}>
          {pages.length >= MAX_PAGES
            ? sprintf(
                __(
                  'That’s the most for now: %d pages. You can add more in Studio afterwards.',
                  'pressbase-admin',
                ),
                MAX_PAGES,
              )
            : sprintf(
                __('Up to %d pages. You can add more in Studio afterwards.', 'pressbase-admin'),
                MAX_PAGES,
              )}
        </p>
      </div>
    </div>
  );
}
