'use client';

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ExternalLink,
  FileText,
  GripVertical,
  Home,
  Pencil,
  Plus,
} from 'lucide-react';
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { TextField } from '../ui/field';
import { ActionMenu, type MenuAction } from '../ui/menu';
import { dropPlacement, type PageMove, type Placement, placementFor } from './pages-model';
import {
  type CanvasTarget,
  isNewPage,
  type PageRef,
  pageTitle,
  pageTree,
  type StudioPage,
  sameTarget,
} from './site-model';
import styles from './studio.module.css';

export interface PagesPanelProps {
  /** The pages as the draft leaves them, that this person may open. */
  pages: StudioPage[];
  target: CanvasTarget;
  /** The draft's home page: the latest posts, or a page. */
  postsOnFront: boolean;
  frontPageId: PageRef;
  onTarget: (target: CanvasTarget) => void;
  /** What this person may do: add pages, arrange them, choose the home page. */
  can: { add: boolean; arrange: boolean; home: boolean };
  onAdd: (title: string) => void;
  onRename: (ref: PageRef, title: string) => void;
  /** Moves a page; false when it can't go there. */
  onMove: (ref: PageRef, to: Placement) => boolean;
  onHome: (id: number) => void;
}

type Drop = { ref: PageRef; where: 'before' | 'after' | 'inside' };

const MOVE_KEYS: Record<string, PageMove> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'in',
  ArrowLeft: 'out',
};

/**
 * The Pages panel (#29): the page tree, as the draft leaves it. Choose a page
 * to open it; add one; drag a page before, after or onto another to reorder
 * or nest it. Every move has a keyboard way too: the page's ⋯ menu, or
 * Alt + the arrow keys on the page. Each change goes into the draft.
 */
export function PagesPanel(props: PagesPanelProps) {
  const { __, sprintf } = useI18n();
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [renaming, setRenaming] = useState<PageRef | null>(null);
  const [dragged, setDragged] = useState<PageRef | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const tree = pageTree(props.pages);
  const byRef = new Map(props.pages.map((page) => [page.id, page]));
  const titleOf = (ref: PageRef) => pageTitle(byRef.get(ref));

  const focusRow = (ref: PageRef) =>
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-page-ref="${CSS.escape(String(ref))}"]`)
        ?.focus(),
    );

  const describe = (ref: PageRef, to: Placement) => {
    const title = titleOf(ref);
    return to.parent === 0
      ? sprintf(__('%s moved. It’s now a main page.', 'pressbase-admin'), title)
      : sprintf(
          __('%1$s moved. It’s now under %2$s.', 'pressbase-admin'),
          title,
          titleOf(to.parent),
        );
  };

  const move = (ref: PageRef, to: Placement | null) => {
    if (!to || !props.onMove(ref, to)) {
      setAnnouncement(__('The page can’t go there.', 'pressbase-admin'));
      return;
    }
    setAnnouncement(describe(ref, to));
    focusRow(ref);
  };

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    props.onAdd(title);
    setAnnouncement(
      sprintf(__('%s added. It goes live when you publish.', 'pressbase-admin'), title),
    );
    setNewTitle('');
    setAdding(false);
  };

  const onRowKey = (event: ReactKeyboardEvent, ref: PageRef) => {
    const moveKey = MOVE_KEYS[event.key];
    if (!event.altKey || !moveKey || !props.can.arrange) return;
    event.preventDefault();
    move(ref, placementFor(props.pages, ref, moveKey));
  };

  const onDragOver = (event: DragEvent, ref: PageRef) => {
    if (dragged === null || dragged === ref) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (event.clientY - box.top) / box.height;
    const where = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
    if (drop?.ref !== ref || drop.where !== where) setDrop({ ref, where });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragged !== null && drop) {
      move(dragged, dropPlacement(props.pages, dragged, drop.ref, drop.where));
    }
    setDragged(null);
    setDrop(null);
  };

  const actions = (page: StudioPage, isHome: boolean): MenuAction[] => {
    const out: MenuAction[] = [
      {
        label: __('Rename', 'pressbase-admin'),
        icon: <Pencil size={16} aria-hidden="true" />,
        onSelect: () => setRenaming(page.id),
      },
    ];
    if (props.can.home && !isHome && !isNewPage(page.id) && page.status === 'publish') {
      const id = page.id;
      out.push({
        label: __('Make this the home page', 'pressbase-admin'),
        icon: <Home size={16} aria-hidden="true" />,
        onSelect: () => {
          props.onHome(id);
          setAnnouncement(
            sprintf(
              __('%s will be the home page once you publish.', 'pressbase-admin'),
              pageTitle(page),
            ),
          );
        },
      });
    }
    if (props.can.arrange) {
      const moves: [PageMove, string, typeof ArrowUp][] = [
        ['up', __('Move up', 'pressbase-admin'), ArrowUp],
        ['down', __('Move down', 'pressbase-admin'), ArrowDown],
      ];
      for (const [kind, label, Icon] of moves) {
        const to = placementFor(props.pages, page.id, kind);
        if (to) {
          out.push({
            label,
            icon: <Icon size={16} aria-hidden="true" />,
            onSelect: () => move(page.id, to),
          });
        }
      }
      const into = placementFor(props.pages, page.id, 'in');
      if (into) {
        out.push({
          label: sprintf(__('Put under %s', 'pressbase-admin'), titleOf(into.parent)),
          icon: <ArrowRight size={16} aria-hidden="true" />,
          onSelect: () => move(page.id, into),
        });
      }
      const out_ = placementFor(props.pages, page.id, 'out');
      if (out_) {
        out.push({
          label: sprintf(__('Move out of %s', 'pressbase-admin'), titleOf(page.parent)),
          icon: <ArrowLeft size={16} aria-hidden="true" />,
          onSelect: () => move(page.id, out_),
        });
      }
    }
    if (!isNewPage(page.id)) {
      const id = page.id;
      out.push({
        label: __('Edit details in Pages', 'pressbase-admin'),
        icon: <ExternalLink size={16} aria-hidden="true" />,
        onSelect: () => {
          window.location.href = `/admin/pages/${id}`;
        },
      });
    }
    return out;
  };

  const isCurrent = (t: CanvasTarget) => sameTarget(t, props.target);

  return (
    <div className={styles.pagesPanel}>
      {props.can.add && (
        <div className={styles.pagesAdd}>
          {adding ? (
            <form onSubmit={submitNew} className={styles.pagesAddForm}>
              <TextField
                label={__('Page title', 'pressbase-admin')}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                autoFocus
                maxLength={200}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setAdding(false);
                  }
                }}
              />
              <div className={styles.pagesAddActions}>
                <Button type="submit" size="sm" variant="primary" disabled={!newTitle.trim()}>
                  {__('Add page', 'pressbase-admin')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  {__('Cancel', 'pressbase-admin')}
                </Button>
              </div>
            </form>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={16} aria-hidden="true" />}
              onClick={() => setAdding(true)}
            >
              {__('Add page', 'pressbase-admin')}
            </Button>
          )}
        </div>
      )}

      <ul
        ref={listRef}
        className={styles.pages}
        aria-label={__('Pages', 'pressbase-admin')}
        aria-describedby={props.can.arrange ? hintId : undefined}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
      >
        {props.postsOnFront && (
          <li>
            <div className={styles.pageRow}>
              <span className={styles.pageGrip} aria-hidden="true" />
              <button
                type="button"
                className={styles.pageItem}
                aria-current={isCurrent({ kind: 'posts' }) ? 'page' : undefined}
                onClick={() => props.onTarget({ kind: 'posts' })}
              >
                <Home size={16} aria-hidden="true" />
                <span className={styles.pageItemTitle}>
                  {__('Latest posts', 'pressbase-admin')}
                </span>
                <span className={styles.pageBadge}>{__('Home', 'pressbase-admin')}</span>
              </button>
            </div>
          </li>
        )}
        {tree.map(({ page, depth }) => {
          const t: CanvasTarget = { kind: 'page', id: page.id };
          const isHome = !props.postsOnFront && page.id === props.frontPageId;
          const isNew = isNewPage(page.id);
          const parent = byRef.get(page.parent);
          const title = pageTitle(page);
          return (
            <li
              key={String(page.id)}
              style={{ paddingInlineStart: `${depth * 1.25}rem` }}
              draggable={props.can.arrange && renaming !== page.id}
              data-dragging={dragged === page.id || undefined}
              data-drop={drop?.ref === page.id ? drop.where : undefined}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', title);
                setDragged(page.id);
              }}
              onDragEnd={() => {
                setDragged(null);
                setDrop(null);
              }}
              onDragOver={(event) => onDragOver(event, page.id)}
              onDrop={onDrop}
            >
              <div className={styles.pageRow}>
                {props.can.arrange ? (
                  <GripVertical size={14} aria-hidden="true" className={styles.pageGrip} />
                ) : (
                  <span className={styles.pageGrip} aria-hidden="true" />
                )}
                {renaming === page.id ? (
                  <RenameField
                    title={title}
                    onDone={(next) => {
                      setRenaming(null);
                      if (next && next !== title) props.onRename(page.id, next);
                      focusRow(page.id);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.pageItem}
                    data-page-ref={String(page.id)}
                    aria-current={isCurrent(t) ? 'page' : undefined}
                    onClick={() => props.onTarget(t)}
                    onKeyDown={(event) => onRowKey(event, page.id)}
                  >
                    {isHome ? (
                      <Home size={16} aria-hidden="true" />
                    ) : (
                      <FileText size={16} aria-hidden="true" />
                    )}
                    <span className={styles.pageItemTitle}>{title}</span>
                    {parent && (
                      <span className="visually-hidden">
                        {sprintf(__(', under %s', 'pressbase-admin'), pageTitle(parent))}
                      </span>
                    )}
                    {isHome && (
                      <span className={styles.pageBadge}>{__('Home', 'pressbase-admin')}</span>
                    )}
                    {isNew ? (
                      <span className={styles.pageNote} data-tone="accent">
                        {__('New', 'pressbase-admin')}
                      </span>
                    ) : (
                      page.status !== 'publish' && (
                        <span className={styles.pageNote}>{__('Draft', 'pressbase-admin')}</span>
                      )
                    )}
                  </button>
                )}
                <ActionMenu
                  label={sprintf(__('Actions for %s', 'pressbase-admin'), title)}
                  actions={actions(page, isHome)}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {props.pages.length === 0 && !props.postsOnFront && (
        <p className={styles.pagesEmpty}>
          {__('No pages yet. Add one to start building your site.', 'pressbase-admin')}
        </p>
      )}
      {props.can.arrange && (
        <p id={hintId} className={styles.pagesHint}>
          {__(
            'Drag a page to reorder it, or onto another page to put it under that one. With the keyboard, use the page’s ⋯ menu, or Alt and the arrow keys.',
            'pressbase-admin',
          )}
        </p>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** Renaming a page in place: Enter keeps the new title, Escape the old one. */
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const { __ } = useI18n();
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      className={styles.renameInput}
      aria-label={__('Page title', 'pressbase-admin')}
      value={value}
      maxLength={200}
      // biome-ignore lint/a11y/noAutofocus: renaming starts in the field the person asked for.
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value.trim() || null);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}
