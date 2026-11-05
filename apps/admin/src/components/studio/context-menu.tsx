'use client';

import {
  BlockSettingsMenuControls,
  store as blockEditorStore,
  useBlockDisplayInformation,
} from '@wordpress/block-editor';
import {
  type Block as BlockInstance,
  createBlock,
  getBlockType,
  parse,
  pasteHandler,
  serialize,
} from '@wordpress/blocks';
import { MenuItem } from '@wordpress/components';
import { useDispatch, useRegistry } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import {
  BookmarkPlus,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Paintbrush,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Checkbox, TextField } from '../ui/field';
import { type Select as AskSelect, readSection, textTarget, useAskAiOpener } from './ask-ai';
import { blockElement, fromCanvas, useCanvasIframe } from './canvas-frame';
import styles from './canvas-tools.module.css';
import { looksLikeBlocks, pastePlace, pasteStyles, type Supports } from './clipboard-model';
import { contentRootId, forgetSavedSections, sectionLabel, sectionOf } from './sections-panel';
import { useCanvasEvents } from './swap-layout';

/**
 * The canvas's right-click menu (#36), Elementor's: Copy, Paste, Paste
 * style, Duplicate, Save as section, Ask AI and Delete for the block under
 * the pointer (or the selected block, from the keyboard: Shift+F10 or the
 * context-menu key). The block editor's own ⋯ menu gets Paste and Save as
 * section too (it already has Copy, Duplicate, Copy and Paste styles, and
 * Delete). See docs/architecture/studio.md#the-right-click-menu.
 *
 * The menu is the WAI-ARIA menu pattern, drawn in Studio's document over
 * the canvas: focus moves into it, the arrow keys (and Home, End and a
 * letter) move between its items, Escape or Tab closes it and focus goes
 * back to the block.
 *
 * Copy writes the block's markup to the clipboard, as WordPress's Copy
 * does, so Ctrl+V and other editors take it too; Studio keeps its own copy
 * for when the browser won't let a page read the clipboard.
 */

type Selectors = AskSelect & {
  getBlocksByClientId: (ids: string[]) => BlockInstance[];
  getBlockRootClientId: (id: string) => string | null;
  getBlockEditingMode: (id: string) => string;
  getSelectedBlockClientId: () => string | null;
  canInsertBlockType: (name: string, root?: string | null) => boolean;
  canInsertBlocks: (ids: string[], root?: string | null) => boolean;
  canRemoveBlock: (id: string) => boolean;
};

type Actions = {
  insertBlocks: (
    blocks: BlockInstance[],
    index?: number,
    root?: string,
    updateSelection?: boolean,
  ) => void;
  replaceBlocks: (ids: string | string[], blocks: BlockInstance | BlockInstance[]) => void;
  duplicateBlocks: (ids: string[]) => void;
  removeBlocks: (ids: string[]) => void;
  selectBlock: (id: string) => void;
  updateBlockAttributes: (
    ids: string[],
    attributes: Record<string, Record<string, unknown>>,
    options: { uniqueByBlock: boolean },
  ) => void;
};

/** Blocks that are the template's regions: they're the page and the parts, not blocks to copy. */
const REGIONS = new Set(['core/post-content', 'core/template-part']);

/** What Studio last copied: for when the clipboard can't be read, and to know a section. */
let copied: { text: string; section: boolean } | null = null;

interface Clipboard {
  blocks: BlockInstance[];
  /** The blocks were a section of a page (they go after a section, not inside one). */
  section: boolean;
  /** Words, not blocks (they paste as paragraphs, and have no style). */
  plain: boolean;
}

/** What's on the clipboard: the system's when the page may read it, else Studio's own copy. */
async function readClipboard(): Promise<Clipboard | null> {
  let text: string | null = null;
  try {
    text = navigator.clipboard ? await navigator.clipboard.readText() : null;
  } catch {
    // Not allowed (the person said no, or the page isn't on https).
    text = null;
  }
  if (!text) {
    return copied ? { blocks: parse(copied.text), section: copied.section, plain: false } : null;
  }
  if (looksLikeBlocks(text)) {
    return {
      blocks: parse(text),
      section: copied?.text === text && copied.section,
      plain: false,
    };
  }
  const blocks = pasteHandler({ plainText: text, mode: 'BLOCKS' });
  return Array.isArray(blocks) ? { blocks, section: false, plain: true } : null;
}

const supportsOf = (name: string) => getBlockType(name)?.supports as Supports;

/** The menu's actions on a block, shared with the ⋯ menu's items. */
function useBlockActions() {
  const { __, sprintf } = useI18n();
  const registry = useRegistry();
  const actions = useDispatch(blockEditorStore) as unknown as Actions;
  const { createSuccessNotice, createErrorNotice } = useDispatch(noticesStore) as unknown as {
    createSuccessNotice: (message: string, options?: object) => void;
    createErrorNotice: (message: string, options?: object) => void;
  };
  const events = useCanvasEvents();
  const select = useCallback(
    () => registry.select(blockEditorStore) as unknown as Selectors,
    [registry],
  );
  const title = useCallback(
    (clientId: string) => {
      const s = select();
      const name = (s.getBlockAttributes(clientId)?.metadata as { name?: unknown } | undefined)
        ?.name;
      if (typeof name === 'string' && name) return name;
      const type = s.getBlockName(clientId) ?? '';
      return getBlockType(type)?.title ?? type;
    },
    [select],
  );

  const copy = async (clientId: string) => {
    const s = select();
    const text = serialize(s.getBlocksByClientId([clientId]));
    const root = contentRootId(s);
    copied = { text, section: Boolean(root) && s.getBlockRootClientId(clientId) === root };
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Studio's own copy still pastes here.
    }
    createSuccessNotice(sprintf(__('Copied “%s”.', 'pressbase-admin'), title(clientId)), {
      type: 'snackbar',
    });
  };

  const paste = async (clientId: string) => {
    const clipboard = await readClipboard();
    if (!clipboard?.blocks.length) {
      createErrorNotice(__('Nothing to paste. Copy a block first.', 'pressbase-admin'));
      return;
    }
    const s = select();
    const place = pastePlace(
      [...s.getBlockParents(clientId), clientId],
      clipboard.blocks.map((block) => block.name),
      {
        contentRoot: contentRootId(s),
        section: clipboard.section,
        indexOf: (id, root) => s.getBlockOrder(root).indexOf(id),
        canInsert: (name, root) => s.canInsertBlockType(name, root),
      },
    );
    if (!place) {
      createErrorNotice(__('What you copied can’t go here.', 'pressbase-admin'));
      return;
    }
    actions.insertBlocks(clipboard.blocks, place.index, place.root, true);
  };

  const pasteStyle = async (clientId: string) => {
    const clipboard = await readClipboard();
    if (!clipboard || clipboard.plain || !clipboard.blocks.length) {
      createErrorNotice(
        __('Copy a block first: Paste style gives this one its style.', 'pressbase-admin'),
      );
      return;
    }
    const updates = pasteStyles(
      clipboard.blocks,
      select().getBlocksByClientId([clientId]) as never,
      supportsOf,
    );
    const name = title(clientId);
    if (!updates.size) {
      createSuccessNotice(sprintf(__('“%s” already has that style.', 'pressbase-admin'), name), {
        type: 'snackbar',
      });
      return;
    }
    // One change, so one undo step, named in History.
    events?.labelNext(sprintf(__('Pasted style onto “%s”', 'pressbase-admin'), name));
    actions.updateBlockAttributes([...updates.keys()], Object.fromEntries(updates), {
      uniqueByBlock: true,
    });
    createSuccessNotice(sprintf(__('Pasted the style onto “%s”.', 'pressbase-admin'), name), {
      type: 'snackbar',
    });
  };

  /** Saves the block as a pattern (wp_block); a synced one then stands in for it. */
  const saveSection = async (clientId: string, name: string, synced: boolean) => {
    const content = serialize(select().getBlocksByClientId([clientId]));
    const post = await api<{ id: number }>('/wp/v2/blocks', {
      method: 'POST',
      body: {
        title: name,
        content,
        status: 'publish',
        meta: { wp_pattern_sync_status: synced ? '' : 'unsynced' },
      },
    });
    forgetSavedSections();
    if (synced) {
      events?.labelNext(sprintf(__('Saved “%s” as a synced section', 'pressbase-admin'), name));
      actions.replaceBlocks(clientId, createBlock('core/block', { ref: post.id }));
    }
    createSuccessNotice(
      sprintf(
        __('Saved “%s”. It’s under Saved sections in the Sections panel.', 'pressbase-admin'),
        name,
      ),
      { type: 'snackbar' },
    );
  };

  return { select, title, copy, paste, pasteStyle, saveSection, actions };
}

/* ------------------------------------------------------------ the menu */

interface MenuItemSpec {
  id: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  keys?: string;
  tone?: 'danger';
  /** The first item of a group (a line above it). */
  group?: boolean;
  run: () => void;
}

const MOVES_SELECTION = new Set(['paste', 'duplicate', 'delete']);

interface Open {
  clientId: string;
  x: number;
  y: number;
  /** Where focus goes back to when the menu closes without acting. */
  returnTo: HTMLElement | null;
}

export function CanvasContextMenu({
  frameRef,
  canSaveSections,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  /** The site has saved sections (/wp/v2/blocks). */
  canSaveSections: boolean;
}) {
  const { __, sprintf } = useI18n();
  const iframe = useCanvasIframe(frameRef);
  const askAi = useAskAiOpener();
  const block = useBlockActions();
  const { select, actions } = block;
  const [open, setOpen] = useState<Open | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const openedByKey = useRef(0);

  /** The block a menu is for: the innermost one people can work on, never a region. */
  const targetOf = useCallback(
    (element: Element | null): string | null => {
      const s = select();
      let node = element?.closest?.('[data-block]') ?? null;
      while (node) {
        const clientId = node.getAttribute('data-block');
        if (clientId) {
          const name = s.getBlockName(clientId) ?? '';
          if (REGIONS.has(name)) return null;
          if (s.getBlockEditingMode(clientId) !== 'disabled') return clientId;
        }
        node = node.parentElement?.closest('[data-block]') ?? null;
      }
      return null;
    },
    [select],
  );

  const openFor = useCallback(
    (clientId: string, point: { x: number; y: number } | null) => {
      if (!iframe) return;
      const element = blockElement(iframe, clientId);
      let at = point;
      if (!at) {
        const rect = element?.getBoundingClientRect();
        at = fromCanvas(iframe, (rect?.left ?? 0) + 8, (rect?.top ?? 0) + 8);
      }
      actions.selectBlock(clientId);
      // Back to the block when the menu closes (WordPress's block wrappers take focus).
      setOpen({ clientId, x: at.x, y: at.y, returnTo: element });
    },
    [iframe, actions],
  );

  // Right-click, Shift+F10 and the context-menu key in the canvas.
  useEffect(() => {
    const doc = iframe?.contentDocument;
    if (!doc || !iframe) return;
    const onContextMenu = (event: MouseEvent) => {
      // Shift+right-click keeps the browser's own menu (spelling, copying text…).
      if (event.shiftKey && event.button === 2) return;
      // The keyboard's contextmenu event (button 0), just after Shift+F10 opened the menu.
      const fromKeyboard = event.button !== 2;
      if (fromKeyboard && Date.now() - openedByKey.current < 600) {
        event.preventDefault();
        return;
      }
      // Right-click on selected words: the browser's menu, to copy them or fix a spelling.
      const selection = doc.getSelection();
      const target = event.target as Element | null;
      if (
        selection &&
        !selection.isCollapsed &&
        target?.closest?.('[contenteditable="true"]') &&
        selection.containsNode(target, true)
      ) {
        return;
      }
      // From the keyboard, the target is the focused block; else the selected one.
      const clientId =
        targetOf(target) ?? (fromKeyboard ? select().getSelectedBlockClientId() : null);
      if (!clientId) return;
      event.preventDefault();
      const pointed = event.clientX !== 0 || event.clientY !== 0;
      openFor(clientId, pointed ? fromCanvas(iframe, event.clientX, event.clientY) : null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = (event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu';
      if (!key || event.defaultPrevented) return;
      const clientId =
        targetOf(doc.activeElement) ?? targetOf(event.target as Element | null) ?? null;
      const selected = select().getSelectedBlockClientId();
      const chosen = selected ?? clientId;
      if (!chosen || select().getBlockEditingMode(chosen) === 'disabled') return;
      event.preventDefault();
      openedByKey.current = Date.now();
      openFor(chosen, null);
    };
    doc.addEventListener('contextmenu', onContextMenu);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('contextmenu', onContextMenu);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [iframe, openFor, select, targetOf]);

  const openRef = useRef(open);
  openRef.current = open;
  const close = useCallback((refocus: boolean) => {
    const current = openRef.current;
    setOpen(null);
    if (refocus) current?.returnTo?.focus();
  }, []);

  return (
    <>
      <MoreMenuItems
        canSaveSections={canSaveSections}
        onSave={(clientId) => setSaving(clientId)}
        paste={block.paste}
      />
      {open && (
        <ContextMenu
          at={open}
          label={sprintf(__('Actions for %s', 'pressbase-admin'), block.title(open.clientId))}
          heading={block.title(open.clientId)}
          items={menuItems(open.clientId)}
          iframe={iframe}
          onClose={close}
        />
      )}
      {saving && (
        <SaveSectionDialog
          clientId={saving}
          defaultName={block.title(saving)}
          onSave={block.saveSection}
          onClose={() => setSaving(null)}
        />
      )}
    </>
  );

  /** The menu's items for a block: only what can be done to it. */
  function menuItems(clientId: string): MenuItemSpec[] {
    const s = select();
    const name = s.getBlockName(clientId) ?? '';
    const root = s.getBlockRootClientId(clientId);
    const editable = s.getBlockEditingMode(clientId) === 'default';
    const content = contentRootId(s);
    const section = content ? sectionOf(s, content, clientId) : null;
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const primary = mac ? '⌘' : 'Ctrl+';
    const shift = mac ? '⇧' : 'Shift+';

    const items: MenuItemSpec[] = [
      {
        id: 'copy',
        label: __('Copy', 'pressbase-admin'),
        icon: <Copy size={16} aria-hidden="true" />,
        hint: `${primary}C`,
        keys: mac ? 'Meta+C' : 'Control+C',
        run: () => block.copy(clientId),
      },
    ];
    if (editable) {
      items.push(
        {
          id: 'paste',
          label: __('Paste', 'pressbase-admin'),
          icon: <ClipboardPaste size={16} aria-hidden="true" />,
          run: () => block.paste(clientId),
        },
        {
          id: 'paste-style',
          label: __('Paste style', 'pressbase-admin'),
          icon: <Paintbrush size={16} aria-hidden="true" />,
          run: () => block.pasteStyle(clientId),
        },
      );
      if (s.canInsertBlocks([clientId], root)) {
        items.push({
          id: 'duplicate',
          label: __('Duplicate', 'pressbase-admin'),
          icon: <CopyPlus size={16} aria-hidden="true" />,
          hint: `${primary}${shift}D`,
          keys: mac ? 'Meta+Shift+D' : 'Control+Shift+D',
          group: true,
          run: () => actions.duplicateBlocks([clientId]),
        });
      }
      if (canSaveSections && name !== 'core/block') {
        items.push({
          id: 'save',
          label: __('Save as section…', 'pressbase-admin'),
          icon: <BookmarkPlus size={16} aria-hidden="true" />,
          group: !items.some((item) => item.id === 'duplicate'),
          run: () => setSaving(clientId),
        });
      }
    }
    if (askAi && section) {
      const target =
        textTarget(s, clientId) ??
        (() => {
          const read = readSection(s, section);
          return read ? ({ kind: 'section', section: read } as const) : null;
        })();
      if (target) {
        items.push({
          id: 'ask-ai',
          label:
            target.kind === 'text'
              ? __('Ask AI about this text…', 'pressbase-admin')
              : sprintf(__('Ask AI about “%s”…', 'pressbase-admin'), sectionLabel(s, section)),
          icon: <Sparkles size={16} aria-hidden="true" />,
          group: true,
          run: () => askAi(target),
        });
      }
    }
    if (editable && s.canRemoveBlock(clientId)) {
      items.push({
        id: 'delete',
        label: __('Delete', 'pressbase-admin'),
        icon: <Trash2 size={16} aria-hidden="true" />,
        tone: 'danger',
        group: true,
        run: () => actions.removeBlocks([clientId]),
      });
    }
    return items;
  }
}

function ContextMenu({
  at,
  label,
  heading,
  items,
  iframe,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  heading: string;
  items: MenuItemSpec[];
  iframe: HTMLIFrameElement | null;
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const headingId = useId();

  // Kept inside the window, then focus on the first item.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
    const top = Math.max(8, at.y + height > window.innerHeight - 8 ? at.y - height : at.y);
    setPlace({ left, top: Math.min(top, window.innerHeight - height - 8) });
  }, [at.x, at.y]);

  useEffect(() => {
    if (place) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [place]);

  // A click anywhere else, in Studio or on the canvas, or the canvas scrolling, closes it.
  useEffect(() => {
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    const onScroll = () => onClose(false);
    document.addEventListener('mousedown', away, true);
    doc?.addEventListener('mousedown', away, true);
    win?.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', away, true);
      doc?.removeEventListener('mousedown', away, true);
      win?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [iframe, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    let next: number | undefined = {
      ArrowDown: (index + 1) % list.length,
      ArrowUp: (index - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    }[event.key];
    // A letter: the next item starting with it.
    if (next === undefined && event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLocaleLowerCase();
      for (let step = 1; step <= list.length; step++) {
        const candidate = list[(index + step) % list.length];
        if (candidate?.textContent?.trim().toLocaleLowerCase().startsWith(letter)) {
          next = (index + step) % list.length;
          break;
        }
      }
    }
    if (next === undefined) return;
    event.preventDefault();
    list[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.contextMenu}
      style={place ? { left: place.left, top: place.top } : { left: at.x, top: at.y, opacity: 0 }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      data-studio-context-menu
    >
      <div id={headingId} className={styles.contextHeading} role="presentation">
        {heading}
      </div>
      {items.map((item) => (
        <div key={item.id} role="none">
          {item.group && <hr className={styles.contextSeparator} />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={styles.contextItem}
            data-tone={item.tone}
            aria-keyshortcuts={item.keys}
            onClick={() => {
              // Closed first, focus back on the block, so a dialog the item opens
              // returns there. Pasting, duplicating and deleting select another block.
              onClose(!MOVES_SELECTION.has(item.id));
              item.run();
            }}
          >
            {item.icon}
            <span className={styles.contextLabel}>{item.label}</span>
            {item.hint && (
              <span className={styles.contextHint} aria-hidden="true">
                {item.hint}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ------------------------------------------- the block toolbar's ⋯ menu */

/** Paste and Save as section in the block editor's ⋯ menu, for the selected block. */
function MoreMenuItems({
  canSaveSections,
  onSave,
  paste,
}: {
  canSaveSections: boolean;
  onSave: (clientId: string) => void;
  paste: (clientId: string) => Promise<void>;
}) {
  const { __ } = useI18n();
  return (
    <BlockSettingsMenuControls>
      {({ selectedClientIds, onClose }: { selectedClientIds: string[]; onClose: () => void }) => {
        const [clientId] = selectedClientIds;
        if (selectedClientIds.length !== 1 || !clientId) return null;
        return (
          <MoreItems
            clientId={clientId}
            canSave={canSaveSections}
            onClose={onClose}
            onPaste={() => paste(clientId)}
            onSave={() => onSave(clientId)}
            labels={{
              paste: __('Paste after', 'pressbase-admin'),
              save: __('Save as section…', 'pressbase-admin'),
            }}
          />
        );
      }}
    </BlockSettingsMenuControls>
  );
}

function MoreItems(props: {
  clientId: string;
  canSave: boolean;
  onClose: () => void;
  onPaste: () => void;
  onSave: () => void;
  labels: { paste: string; save: string };
}) {
  const registry = useRegistry();
  const info = useBlockDisplayInformation(props.clientId);
  const s = registry.select(blockEditorStore) as unknown as Selectors;
  const name = s.getBlockName(props.clientId) ?? '';
  if (REGIONS.has(name) || s.getBlockEditingMode(props.clientId) !== 'default') return null;
  return (
    <>
      <MenuItem
        onClick={() => {
          props.onClose();
          props.onPaste();
        }}
      >
        {props.labels.paste}
      </MenuItem>
      {props.canSave && name !== 'core/block' && info && (
        <MenuItem
          onClick={() => {
            props.onClose();
            props.onSave();
          }}
        >
          {props.labels.save}
        </MenuItem>
      )}
    </>
  );
}

/* ------------------------------------------------------ Save as section */

function SaveSectionDialog({
  clientId,
  defaultName,
  onSave,
  onClose,
}: {
  clientId: string;
  defaultName: string;
  onSave: (clientId: string, name: string, synced: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { __ } = useI18n();
  const [name, setName] = useState(defaultName);
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();

  const submit = async () => {
    if (!name.trim()) {
      setError(__('Give the section a name.', 'pressbase-admin'));
      return;
    }
    setBusy(true);
    try {
      await onSave(clientId, name.trim(), synced);
      onClose();
    } catch {
      setBusy(false);
      setError(__('The section couldn’t be saved. Try again.', 'pressbase-admin'));
    }
  };

  return (
    <Dialog
      open
      title={__('Save as section', 'pressbase-admin')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {__('Cancel', 'pressbase-admin')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {__('Save', 'pressbase-admin')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.saveForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={__('Name', 'pressbase-admin')}
          value={name}
          error={error || undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
        <Checkbox
          label={__('Synced', 'pressbase-admin')}
          description={__(
            'Keep every copy the same: a change to it shows everywhere it’s used. Otherwise each copy can be changed on its own.',
            'pressbase-admin',
          )}
          checked={synced}
          onChange={(event) => setSynced(event.target.checked)}
        />
      </form>
    </Dialog>
  );
}
