'use client';

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  GripVertical,
  Menu as MenuIcon,
  Plus,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '@/lib/api';
import {
  appendItems,
  canDrop,
  canHaveChildren,
  canMove,
  customLink,
  type DropPosition,
  decodeEntities,
  dropItem,
  findItem,
  findPosition,
  homeLink,
  itemFromSearchResult,
  itemsFromPages,
  itemTypeLabel,
  type MenuItem,
  type Move,
  moveItem,
  normalizeUrl,
  parseMenu,
  removeItem,
  type SearchResult,
  serializeMenu,
  updateItem,
} from '@/lib/menus';
import {
  type FallbackState,
  menuName,
  newMenuName,
  type RestMenu,
  type RestPageLink,
} from '@/lib/menus-api';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/field';
import { Badge, Card, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import { MenuPreview } from './menu-preview';
import styles from './menus.module.css';

/**
 * Appearance → Menus. A calm, focused editor for `wp_navigation` menus:
 * pick a menu, arrange its items (drag and drop, or the keyboard: Move up,
 * Move down, Into submenu, Out of submenu, also on the arrow keys while an
 * item's handle has focus), edit each item in place, add pages, posts,
 * categories and links, choose the header's menu, and preview the header
 * before saving. Tree logic lives in lib/menus.ts.
 */

interface Draft {
  title: string;
  items: MenuItem[];
}

const MOVES: { move: Move; label: (ctx: MoveContext) => string; icon: typeof ArrowUp }[] = [
  { move: 'up', label: () => 'Move up', icon: ArrowUp },
  { move: 'down', label: () => 'Move down', icon: ArrowDown },
  {
    move: 'in',
    label: (c) => (c.previous ? `Into submenu of “${c.previous}”` : 'Into submenu'),
    icon: ArrowRight,
  },
  {
    move: 'out',
    label: (c) => (c.parent ? `Out of “${c.parent}”` : 'Out of submenu'),
    icon: ArrowLeft,
  },
];

interface MoveContext {
  previous?: string;
  parent?: string;
}

export function MenuEditor({
  initialMenus,
  initialFallback,
}: {
  initialMenus: RestMenu[];
  initialFallback: FallbackState;
}) {
  const toast = useToast();
  const router = useRouter();
  const [menus, setMenus] = useState(initialMenus);
  const [fallback, setFallback] = useState(initialFallback);
  const [selectedId, setSelectedId] = useState<number | null>(
    () =>
      (initialMenus.find((m) => m.id === initialFallback.current) ?? initialMenus[0])?.id ?? null,
  );
  const selected = menus.find((m) => m.id === selectedId) ?? null;

  // The saved state of the selected menu, and the draft being edited.
  const [saved, setSaved] = useState<{ title: string; content: string }>({
    title: '',
    content: '',
  });
  const [draft, setDraft] = useState<Draft>({ title: '', items: [] });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'create' | 'delete' | 'header' | null>(null);
  const [nameError, setNameError] = useState<string>();
  const [confirm, setConfirm] = useState<
    { kind: 'delete' } | { kind: 'switch'; to: number | 'new' } | null
  >(null);
  const [announcement, setAnnouncement] = useState('');
  const focusAfter = useRef<{ key: string; target: string } | null>(null);
  const formId = useId();

  // Load the selected menu into the draft.
  const load = useCallback((menu: RestMenu | null) => {
    if (!menu) {
      setSaved({ title: '', content: '' });
      setDraft({ title: '', items: [] });
      return;
    }
    const items = parseMenu(menu.content.raw);
    setSaved({ title: menuName(menu), content: serializeMenu(items) });
    setDraft({ title: menuName(menu), items });
    setOpenKey(null);
    setNameError(undefined);
  }, []);

  // Only when the selection changes.
  useEffect(() => load(selected), [selectedId, load]);

  const content = useMemo(() => serializeMenu(draft.items), [draft.items]);
  const dirty = Boolean(selected) && (draft.title !== saved.title || content !== saved.content);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Keep focus on the control that was used once the tree re-renders.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-item-key="${target.key}"]`);
      const control =
        row?.querySelector<HTMLElement>(`[data-focus="${target.target}"]:not([disabled])`) ??
        row?.querySelector<HTMLElement>('[data-focus="handle"]');
      control?.focus();
    });
  }, [draft.items]);

  const setItems = (update: (items: MenuItem[]) => MenuItem[]) =>
    setDraft((d) => ({ ...d, items: update(d.items) }));

  /** "Team moved into About. Item 1 of 2, level 2." */
  const describePosition = (items: MenuItem[], key: string) => {
    const pos = findPosition(items, key);
    const item = findItem(items, key);
    if (!pos || !item) return '';
    const parent = pos.parent ? findItem(items, pos.parent) : null;
    const where = parent ? `in “${parent.label}”` : 'at the top level';
    return `${item.label}: item ${pos.index + 1} of ${pos.siblings.length}, ${where}.`;
  };

  const move = (key: string, direction: Move, target = 'handle') => {
    const next = moveItem(draft.items, key, direction);
    if (next === draft.items) return;
    focusAfter.current = { key, target };
    setDraft((d) => ({ ...d, items: next }));
    setAnnouncement(`Moved. ${describePosition(next, key)}`);
  };

  const remove = (key: string) => {
    const item = findItem(draft.items, key);
    const before = draft.items;
    setItems((items) => removeItem(items, key));
    if (item) {
      toast(`“${item.label}” removed from the menu.`, {
        action: { label: 'Undo', onClick: () => setDraft((d) => ({ ...d, items: before })) },
      });
    }
  };

  const add = (added: MenuItem[]) => {
    if (!added.length) return;
    setItems((items) => appendItems(items, added));
    setAnnouncement(
      added.length === 1
        ? `“${added[0]?.label}” added at the end of the menu.`
        : `${added.length} items added at the end of the menu.`,
    );
  };

  /* --------------------------------------------------------------- server */

  const replaceMenu = (menu: RestMenu) =>
    setMenus((list) => {
      const exists = list.some((m) => m.id === menu.id);
      return exists ? list.map((m) => (m.id === menu.id ? menu : m)) : [menu, ...list];
    });

  const refreshFallback = async () => {
    try {
      setFallback(await api<FallbackState>('/pressbase/v1/navigation-fallback'));
    } catch {
      // The badge just stays as it was.
    }
  };

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!selected) return;
    if (!draft.title.trim()) {
      setNameError('Give the menu a name.');
      document.querySelector<HTMLInputElement>('input[name="menu-name"]')?.focus();
      return;
    }
    setBusy('save');
    try {
      const menu = await api<RestMenu>(`/wp/v2/navigation/${selected.id}`, {
        method: 'POST',
        body: { title: draft.title.trim(), content, status: 'publish' },
      });
      replaceMenu(menu);
      setSaved({ title: menuName(menu), content });
      setDraft((d) => ({ ...d, title: menuName(menu) }));
      toast(
        fallback.current === menu.id ? 'Menu saved. Your header shows the changes.' : 'Menu saved.',
      );
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The menu couldn’t be saved.', {
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * New menus are published at once, and the header shows the newest menu
   * unless one is chosen. So before creating one, the menu the header shows
   * now is chosen explicitly: making a menu never changes the site by itself.
   */
  async function create(fromPages = false) {
    setBusy('create');
    try {
      if (fallback.id === 0 && fallback.current !== 0) {
        await api('/pressbase/v1/navigation-fallback', {
          method: 'PUT',
          body: { id: fallback.current },
        });
      }
      let items: MenuItem[] = [];
      if (fromPages) {
        const pages = await api<RestPageLink[]>(
          '/wp/v2/pages?per_page=100&status=publish&orderby=menu_order&order=asc&_fields=id,title,link,parent,menu_order',
        );
        items = itemsFromPages(
          pages.map((p) => ({
            id: p.id,
            title: decodeEntities(p.title.rendered),
            link: p.link,
            parent: p.parent,
          })),
        );
      }
      const menu = await api<RestMenu>('/wp/v2/navigation', {
        method: 'POST',
        body: { title: newMenuName(menus), content: serializeMenu(items), status: 'publish' },
      });
      // The edit context includes content.raw.
      const full = await api<RestMenu>(`/wp/v2/navigation/${menu.id}?context=edit`);
      replaceMenu(full);
      setSelectedId(full.id);
      await refreshFallback();
      toast(
        fallback.current === 0
          ? `“${menuName(full)}” created. Your header shows it now.`
          : `“${menuName(full)}” created.`,
      );
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('input[name="menu-name"]')?.focus(),
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The menu couldn’t be created.', {
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function useInHeader() {
    if (!selected) return;
    setBusy('header');
    try {
      setFallback(
        await api<FallbackState>('/pressbase/v1/navigation-fallback', {
          method: 'PUT',
          body: { id: selected.id },
        }),
      );
      toast(
        dirty
          ? `Your header shows “${menuName(selected)}”. Save to include your latest changes.`
          : `Your header shows “${menuName(selected)}” now.`,
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The header couldn’t be changed.', {
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function deleteMenu() {
    if (!selected) return;
    setBusy('delete');
    try {
      await api(`/wp/v2/navigation/${selected.id}?force=true`, { method: 'DELETE' });
      const rest = menus.filter((m) => m.id !== selected.id);
      setMenus(rest);
      setSelectedId(rest[0]?.id ?? null);
      await refreshFallback();
      toast(`“${menuName(selected)}” deleted.`);
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The menu couldn’t be deleted.', {
        tone: 'danger',
      });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const select = (to: number | 'new') => {
    if (dirty) {
      setConfirm({ kind: 'switch', to });
      return;
    }
    if (to === 'new') void create();
    else setSelectedId(to);
  };

  /* --------------------------------------------------------------- render */

  if (!menus.length) {
    return (
      <EmptyState
        icon={<MenuIcon size={24} />}
        title="Your header lists your pages"
        action={
          <div className={styles.emptyActions}>
            <Button variant="primary" loading={busy === 'create'} onClick={() => create(true)}>
              Create a menu from your pages
            </Button>
            <Button variant="ghost" disabled={busy === 'create'} onClick={() => create(false)}>
              Start with an empty menu
            </Button>
          </div>
        }
      >
        Until you make a menu, the header shows every published page. A menu lets you choose the
        links, their order and their submenus.
      </EmptyState>
    );
  }

  const inHeader = selected !== null && fallback.current === selected.id;

  return (
    <div className={styles.screen}>
      <div className={styles.picker}>
        {menus.length > 1 ? (
          <SelectField
            label="Menu to edit"
            value={selectedId ?? ''}
            onChange={(e) => select(Number(e.target.value))}
          >
            {menus.map((m) => (
              <option key={m.id} value={m.id}>
                {menuName(m)}
                {fallback.current === m.id ? ' (in the header)' : ''}
              </option>
            ))}
          </SelectField>
        ) : (
          // One menu: its card says which; nothing to choose.
          <span />
        )}
        <Button
          icon={<Plus size={16} aria-hidden="true" />}
          loading={busy === 'create'}
          onClick={() => select('new')}
        >
          New menu
        </Button>
      </div>

      {selected && (
        <>
          <div className={styles.layout}>
            <Card
              className={styles.menuCard}
              title={draft.title.trim() || 'Untitled menu'}
              description={
                inHeader
                  ? 'Visitors see this menu in your site’s header.'
                  : 'This menu isn’t in your header. You can still add it to posts with the Navigation block.'
              }
              actions={
                inHeader ? (
                  <Badge tone="success">
                    <Check size={12} aria-hidden="true" /> In the header
                  </Badge>
                ) : (
                  <Button size="sm" loading={busy === 'header'} onClick={useInHeader}>
                    Use in the header
                  </Button>
                )
              }
            >
              <form id={formId} onSubmit={save} noValidate>
                <div className={styles.nameRow}>
                  <TextField
                    name="menu-name"
                    label="Menu name"
                    hint="Screen readers announce it for the menu."
                    value={draft.title}
                    error={nameError}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, title: e.target.value }));
                      setNameError(undefined);
                    }}
                  />
                </div>

                <h3 className={styles.sectionTitle} id="menu-structure">
                  Menu structure
                </h3>
                {draft.items.length ? (
                  <>
                    <p className={styles.help} id="menu-structure-help">
                      Drag items to reorder them, or use an item’s handle with the arrow keys: up
                      and down to move, right to put it in the submenu of the item above, left to
                      take it out.
                    </p>
                    <ItemTree
                      items={draft.items}
                      all={draft.items}
                      depth={0}
                      openKey={openKey}
                      onToggle={(key) => setOpenKey((k) => (k === key ? null : key))}
                      onMove={move}
                      onDrop={(key, target, position) => {
                        const next = dropItem(draft.items, key, target, position);
                        if (next === draft.items) return;
                        setDraft((d) => ({ ...d, items: next }));
                        setAnnouncement(`Dropped. ${describePosition(next, key)}`);
                      }}
                      onChange={(key, changes) =>
                        setItems((items) => updateItem(items, key, changes))
                      }
                      onRemove={remove}
                      onConvertPageList={async (key) => {
                        try {
                          const pages = await api<RestPageLink[]>(
                            '/wp/v2/pages?per_page=100&status=publish&orderby=menu_order&order=asc&_fields=id,title,link,parent,menu_order',
                          );
                          const links = itemsFromPages(
                            pages.map((p) => ({
                              id: p.id,
                              title: decodeEntities(p.title.rendered),
                              link: p.link,
                              parent: p.parent,
                            })),
                          );
                          setItems((items) => {
                            const pos = findPosition(items, key);
                            if (!pos) return items;
                            const without = removeItem(items, key);
                            // Put the links where the page list was.
                            const insert = (list: MenuItem[], parent: string | null): MenuItem[] =>
                              parent === pos.parent
                                ? [...list.slice(0, pos.index), ...links, ...list.slice(pos.index)]
                                : list.map((i) => ({ ...i, children: insert(i.children, i.key) }));
                            return insert(without, null);
                          });
                          setAnnouncement(`Page list replaced with ${links.length} page links.`);
                        } catch {
                          toast('Your pages couldn’t be loaded.', { tone: 'danger' });
                        }
                      }}
                    />
                  </>
                ) : (
                  <p className={styles.emptyMenu}>
                    This menu is empty. Add pages, posts, categories or links from{' '}
                    <em>Add items</em>.{inHeader && ' Until you do, your header lists your pages.'}
                  </p>
                )}
              </form>
              <div className={styles.cardFooter}>
                <Button
                  variant="ghost"
                  className={styles.deleteButton}
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  onClick={() => setConfirm({ kind: 'delete' })}
                >
                  Delete menu
                </Button>
              </div>
            </Card>

            <AddItems onAdd={add} />
          </div>

          <MenuPreview content={content} title={draft.title} />

          {dirty && (
            <section className={styles.savebar} aria-label="Unsaved changes">
              <span>You have unsaved changes</span>
              <div className={styles.savebarActions}>
                <Button variant="ghost" onClick={() => load(selected)} disabled={busy === 'save'}>
                  Discard
                </Button>
                <Button type="submit" form={formId} variant="primary" loading={busy === 'save'}>
                  {busy === 'save' ? 'Saving…' : 'Save menu'}
                </Button>
              </div>
            </section>
          )}
        </>
      )}

      <div className="visually-hidden" aria-live="polite" role="status">
        {announcement}
      </div>

      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={`Delete “${selected ? menuName(selected) : ''}”?`}
        confirmLabel="Delete menu"
        busy={busy === 'delete'}
        onConfirm={deleteMenu}
        onCancel={() => setConfirm(null)}
      >
        {inHeader
          ? 'It’s deleted for good. Your header will show your newest other menu, or your pages.'
          : 'It’s deleted for good. Navigation blocks that use it will show your header menu instead.'}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'switch'}
        title="Leave without saving?"
        confirmLabel="Discard changes"
        onConfirm={() => {
          const to = confirm?.kind === 'switch' ? confirm.to : null;
          setConfirm(null);
          load(selected);
          if (to === 'new') void create();
          else if (to !== null) setSelectedId(to);
        }}
        onCancel={() => setConfirm(null)}
      >
        Your changes to this menu will be lost.
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ tree */

interface TreeProps {
  items: MenuItem[];
  all: MenuItem[];
  depth: number;
  openKey: string | null;
  onToggle: (key: string) => void;
  onMove: (key: string, move: Move, target?: string) => void;
  onDrop: (key: string, target: string, position: DropPosition) => void;
  onChange: (key: string, changes: Partial<MenuItem>) => void;
  onRemove: (key: string) => void;
  onConvertPageList: (key: string) => void;
}

/** The key of the item being dragged (dataTransfer can't be read during dragover). */
let dragging: string | null = null;

function ItemTree(props: TreeProps) {
  return (
    <ul
      className={styles.tree}
      aria-labelledby={props.depth === 0 ? 'menu-structure' : undefined}
      data-depth={props.depth}
    >
      {props.items.map((item, index) => (
        <ItemRow
          key={item.key}
          {...props}
          item={item}
          index={index}
          previous={props.items[index - 1]}
        />
      ))}
    </ul>
  );
}

function ItemRow({
  item,
  index,
  previous,
  ...props
}: TreeProps & { item: MenuItem; index: number; previous?: MenuItem }) {
  const { all, depth, openKey } = props;
  const open = openKey === item.key;
  const panelId = useId();
  const [drop, setDrop] = useState<DropPosition | null>(null);
  const pos = findPosition(all, item.key);
  const parent = pos?.parent ? findItem(all, pos.parent) : null;
  const moveContext: MoveContext = { previous: previous?.label, parent: parent?.label };

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, Move> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowRight: 'in',
      ArrowLeft: 'out',
    };
    const direction = keys[event.key];
    if (!direction) return;
    event.preventDefault();
    props.onMove(item.key, direction, 'handle');
  };

  const positionFor = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    if (canHaveChildren(item) && y > 0.3 && y < 0.7) return 'inside';
    return y < 0.5 ? 'before' : 'after';
  };

  return (
    <li className={styles.itemWrap} data-item-key={item.key}>
      {/* A drop target for dragging with a pointer; the handle and the Move
          buttons are the keyboard way to do the same. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target only. */}
      <div
        className={styles.item}
        data-open={open || undefined}
        data-drop={drop ?? undefined}
        onDragOver={(event) => {
          if (!dragging) return;
          const position = positionFor(event);
          if (!canDrop(all, dragging, item.key, position)) {
            setDrop(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDrop(position);
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(event) => {
          event.preventDefault();
          setDrop(null);
          if (dragging) props.onDrop(dragging, item.key, positionFor(event));
          dragging = null;
        }}
      >
        <button
          type="button"
          className={styles.handle}
          data-focus="handle"
          draggable
          aria-label={`Move ${item.label}`}
          aria-describedby="menu-structure-help"
          onKeyDown={onHandleKey}
          onDragStart={(event) => {
            dragging = item.key;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', item.label);
            const row = event.currentTarget.closest(`.${styles.item}`);
            if (row instanceof HTMLElement) event.dataTransfer.setDragImage(row, 16, 16);
          }}
          onDragEnd={() => {
            dragging = null;
          }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.itemMain}
          aria-expanded={open}
          aria-controls={panelId}
          data-focus="toggle"
          onClick={() => props.onToggle(item.key)}
        >
          <span className={styles.itemLabel}>{item.label || '(no label)'}</span>
          <span className={styles.itemType}>
            {itemTypeLabel(item)}
            {item.opensInNewTab ? ' · Opens in a new tab' : ''}
          </span>
          <ChevronDown size={16} aria-hidden="true" className={styles.chevron} />
        </button>
      </div>

      {open && (
        <div id={panelId} className={styles.panel}>
          <ItemFields item={item} onChange={(changes) => props.onChange(item.key, changes)} />
          {item.kind === 'page-list' && (
            <div className={styles.panelNote}>
              <p>Shows every published page, nested like your pages are.</p>
              <Button size="sm" onClick={() => props.onConvertPageList(item.key)}>
                Replace with page links
              </Button>
            </div>
          )}
          {item.kind === 'block' && (
            <p className={styles.panelNote}>
              This block is kept as it is. Edit its settings in the block editor.
            </p>
          )}
          <fieldset className={styles.moves}>
            <legend>Move</legend>
            {MOVES.map(({ move, label, icon: Icon }) => (
              <Button
                key={move}
                size="sm"
                variant="ghost"
                data-focus={`move-${move}`}
                icon={<Icon size={14} aria-hidden="true" />}
                disabled={!canMove(all, item.key, move)}
                onClick={() => props.onMove(item.key, move, `move-${move}`)}
              >
                {label(moveContext)}
              </Button>
            ))}
          </fieldset>
          <div className={styles.panelFooter}>
            <Button
              size="sm"
              variant="ghost"
              className={styles.deleteButton}
              icon={<Trash2 size={14} aria-hidden="true" />}
              onClick={() => props.onRemove(item.key)}
            >
              Remove from menu
            </Button>
            <Button size="sm" onClick={() => props.onToggle(item.key)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {item.children.length > 0 && <ItemTree {...props} items={item.children} depth={depth + 1} />}
    </li>
  );
}

function ItemFields({
  item,
  onChange,
}: {
  item: MenuItem;
  onChange: (changes: Partial<MenuItem>) => void;
}) {
  const [urlError, setUrlError] = useState<string>();
  if (item.kind === 'page-list' || item.kind === 'block') return null;
  const editableUrl = item.kind === 'custom';
  return (
    <div className={styles.fields}>
      <TextField
        label="Label"
        value={item.label}
        onChange={(e) => onChange({ label: e.target.value })}
        error={item.label.trim() ? undefined : 'Items without a label don’t show on your site.'}
      />
      {editableUrl ? (
        <TextField
          label="Link"
          type="url"
          inputMode="url"
          spellCheck={false}
          defaultValue={item.url}
          error={urlError}
          hint="A web address, like https://example.com, or a path on your site, like /shop/."
          onBlur={(e) => {
            const url = normalizeUrl(e.target.value);
            if (url === null) {
              setUrlError('Enter a web address starting with https://, or a path starting with /.');
              return;
            }
            setUrlError(undefined);
            e.target.value = url;
            onChange({ url });
          }}
        />
      ) : item.kind !== 'home' ? (
        <p className={styles.linkedTo}>
          Links to{' '}
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.url}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      ) : null}
      <TextAreaField
        label="Description"
        optional
        rows={2}
        value={item.description}
        hint="Shown under the label by themes that display descriptions."
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <Checkbox
        label="Open in a new tab"
        checked={item.opensInNewTab}
        onChange={(e) => onChange({ opensInNewTab: e.target.checked })}
      />
    </div>
  );
}

/* ------------------------------------------------------------- add items */

type Source = 'page' | 'post' | 'category' | 'link';

const SOURCES: { id: Source; label: string; type: string; subtype: string }[] = [
  { id: 'page', label: 'Pages', type: 'post', subtype: 'page' },
  { id: 'post', label: 'Posts', type: 'post', subtype: 'post' },
  { id: 'category', label: 'Categories', type: 'term', subtype: 'category' },
  { id: 'link', label: 'Link', type: '', subtype: '' },
];

function AddItems({ onAdd }: { onAdd: (items: MenuItem[]) => void }) {
  const [source, setSource] = useState<Source>('page');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [problem, setProblem] = useState<string>();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [linkErrors, setLinkErrors] = useState<{ url?: string; label?: string }>({});
  const tabsId = useId();

  const config = SOURCES.find((s) => s.id === source) as (typeof SOURCES)[number];

  useEffect(() => {
    if (source === 'link') return;
    let live = true;
    const timer = setTimeout(
      async () => {
        const q = new URLSearchParams({
          type: config.type,
          subtype: config.subtype,
          per_page: '20',
        });
        if (search.trim()) q.set('search', search.trim());
        try {
          const found = await api<SearchResult[]>(`/wp/v2/search?${q}`);
          if (live) {
            setResults(found);
            setProblem(undefined);
          }
        } catch {
          if (live) setProblem('Search isn’t available right now. Try again in a moment.');
        }
      },
      search ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, search, config.type, config.subtype]);

  const switchTo = (next: Source) => {
    setSource(next);
    setSearch('');
    setResults(null);
    setChecked(new Set());
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = SOURCES.findIndex((s) => s.id === source);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % SOURCES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + SOURCES.length) % SOURCES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SOURCES.length - 1;
    else return;
    event.preventDefault();
    const id = SOURCES[next]?.id as Source;
    switchTo(id);
    requestAnimationFrame(() => document.getElementById(`${tabsId}-${id}`)?.focus());
  };

  const addChecked = () => {
    const picked = (results ?? []).filter((r) => checked.has(r.id));
    onAdd(picked.map(itemFromSearchResult));
    setChecked(new Set());
  };

  const addLink = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    const errors: typeof linkErrors = {};
    if (!normalized) {
      errors.url = 'Enter a web address starting with https://, or a path starting with /.';
    }
    if (!label.trim()) errors.label = 'Give the link a label.';
    setLinkErrors(errors);
    if (errors.url || errors.label || !normalized) return;
    onAdd([customLink(label.trim(), normalized)]);
    setUrl('');
    setLabel('');
  };

  return (
    <Card
      className={styles.addCard}
      title="Add items"
      description="New items go at the end of the menu."
    >
      <div className={styles.sourceTabs} role="tablist" aria-label="Add from">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            id={`${tabsId}-${s.id}`}
            type="button"
            role="tab"
            aria-selected={source === s.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={source === s.id ? 0 : -1}
            onClick={() => switchTo(s.id)}
            onKeyDown={onTabKey}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${source}`}
        className={styles.sourcePanel}
      >
        {source === 'link' ? (
          // Not a nested <form>: the editor is one. Enter in a field adds the link.
          <div className={styles.linkForm}>
            <TextField
              label="Web address"
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder="https://"
              value={url}
              error={linkErrors.url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLink(e)}
            />
            <TextField
              label="Label"
              value={label}
              error={linkErrors.label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLink(e)}
            />
            <div className={styles.addActions}>
              <Button onClick={addLink} icon={<Plus size={16} aria-hidden="true" />}>
                Add link
              </Button>
              <Button variant="ghost" onClick={() => onAdd([homeLink()])}>
                Add a home link
              </Button>
            </div>
          </div>
        ) : (
          <>
            <TextField
              label={`Search ${config.label.toLowerCase()}`}
              type="search"
              required={false}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {problem && <Notice tone="warning" title={problem} />}
            {results === null ? (
              <p className={styles.help}>Loading…</p>
            ) : results.length ? (
              <ul className={styles.results}>
                {results.map((r) => (
                  <li key={r.id}>
                    <Checkbox
                      label={decodeEntities(r.title) || '(no title)'}
                      checked={checked.has(r.id)}
                      onChange={(e) =>
                        setChecked((set) => {
                          const next = new Set(set);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.help}>
                {search
                  ? `No ${config.label.toLowerCase()} match “${search}”.`
                  : `No ${config.label.toLowerCase()} yet.`}
              </p>
            )}
            <div className={styles.addActions}>
              <Button
                onClick={addChecked}
                disabled={!checked.size}
                icon={<Plus size={16} aria-hidden="true" />}
              >
                {checked.size > 1 ? `Add ${checked.size} items` : 'Add to menu'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
