'use client';

import { store as blockEditorStore, useBlockDisplayInformation } from '@wordpress/block-editor';
import type { Block as BlockInstance } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { ArrowDown, ArrowUp, Copy, Plus, Sparkles } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import { ActionMenu } from '../ui/menu';
import { addButtonPlace } from './sections-model';
import { contentRootId, sectionOf } from './sections-panel';
import styles from './studio.module.css';
import { SwapArrows, useSwapLayout } from './swap-layout';

interface Selectors {
  getBlocks: () => BlockInstance[];
  getBlockOrder: (rootClientId?: string) => string[];
  getBlockParents: (clientId: string) => string[];
  getSelectedBlockClientId: () => string | null;
  getBlockAttributes: (clientId: string) => Record<string, unknown> | null;
}

interface Actions {
  moveBlocksUp: (clientIds: string[], rootClientId?: string) => void;
  moveBlocksDown: (clientIds: string[], rootClientId?: string) => void;
  duplicateBlocks: (clientIds: string[]) => void;
  removeBlocks: (clientIds: string[]) => void;
  selectBlock: (clientId: string) => void;
}

/** A section's box, relative to the canvas frame. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The visible part of the canvas (the iframe), relative to the frame. */
  view: { top: number; left: number; width: number; height: number };
  /** Free space above and below the section, before the next thing on the page. */
  spaceAbove: number;
  spaceBelow: number;
}

const HIDE_DELAY = 400;
/** The nearest element before (or after) this one in the page, at any level. */
function neighbour(element: Element, side: 'previous' | 'next'): Element | null {
  let current: Element | null = element;
  while (current && current.tagName !== 'BODY') {
    let sibling =
      side === 'previous' ? current.previousElementSibling : current.nextElementSibling;
    // Skip what takes no room (hidden blocks, the block editor's own markers).
    while (sibling && sibling.getBoundingClientRect().height === 0) {
      sibling = side === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
    }
    if (sibling) return sibling;
    current = current.parentElement;
  }
  return null;
}


/**
 * Over the canvas (#44): the outline of the section under the pointer (or
 * holding the selection) and its floating toolbar: move up and down,
 * duplicate, Ask AI (coming with #63), and more. "＋ Add section" above and
 * below it (in the gap, never over the page: addButtonPlace()) opens the
 * Sections panel at that place. Swap layout
 * (#45): ‹ 2/5 › changes the section to the previous or next layout of its
 * kind, keeping its content.
 *
 * Drawn in Studio's document over the iframe, so its buttons follow the
 * canvas in the tab order. Everything here is also in WordPress's own block
 * toolbar and list view, for keyboard users.
 */
export function SectionToolbar({
  frameRef,
  onAddSection,
  onAskAi,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  /** Opens the Sections panel to add a section at this index among the page's sections. */
  onAddSection: (index: number) => void;
  onAskAi: () => void;
}) {
  const { __, sprintf } = useI18n();
  const registry = useRegistry();
  const actions = useDispatch(blockEditorStore) as unknown as Actions;
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const { root, order, selectedSection, blocks } = useSelect((select) => {
    const s = select(blockEditorStore) as unknown as Selectors;
    const rootId = contentRootId(s);
    const selected = s.getSelectedBlockClientId();
    return {
      root: rootId,
      order: rootId ? s.getBlockOrder(rootId) : [],
      selectedSection: rootId && selected ? sectionOf(s, rootId, selected) : null,
      blocks: s.getBlocks(),
    };
  }, []);

  const active = hovered && order.includes(hovered) ? hovered : selectedSection;
  const index = active ? order.indexOf(active) : -1;
  const info = useBlockDisplayInformation(active);
  const swap = useSwapLayout(active);
  const metadataName = useSelect(
    (select) => {
      if (!active) return '';
      const attributes = (select(blockEditorStore) as unknown as Selectors).getBlockAttributes(
        active,
      );
      const name = (attributes?.metadata as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' ? name : '';
    },
    [active],
  );

  // The canvas iframe, once the editor has put it in the frame.
  useEffect(() => {
    let frame = 0;
    const find = () => {
      const found = frameRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      );
      if (found?.contentDocument?.querySelector('.is-root-container')) setIframe(found);
      else frame = window.setTimeout(find, 250);
    };
    find();
    return () => window.clearTimeout(frame);
  }, [frameRef]);

  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hideSoon = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHovered(null), HIDE_DELAY);
  };

  // Which section the pointer is over.
  useEffect(() => {
    const doc = iframe?.contentDocument;
    if (!doc || !root) return;
    const select = registry.select(blockEditorStore) as unknown as Selectors;
    const onOver = (event: Event) => {
      const element = (event.target as Element | null)?.closest?.('[data-block]');
      const clientId = element?.getAttribute('data-block');
      const section = clientId ? sectionOf(select, root, clientId) : null;
      cancelHide();
      if (section) setHovered(section);
      else hideSoon();
    };
    const onLeave = () => hideSoon();
    doc.addEventListener('mouseover', onOver);
    doc.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      doc.removeEventListener('mouseover', onOver);
      doc.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [iframe, root, registry]);

  useEffect(() => () => cancelHide(), []);

  // The pointer on the toolbar or an Add section button keeps the section shown.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.addEventListener('mouseover', cancelHide);
    layer.addEventListener('mouseleave', hideSoon);
    return () => {
      layer.removeEventListener('mouseover', cancelHide);
      layer.removeEventListener('mouseleave', hideSoon);
    };
  });

  // Where the section is: again on scroll, resize and every change to the blocks.
  // `blocks` changes whenever the page does, which can move the section.
  useLayoutEffect(() => {
    const doc = iframe?.contentDocument;
    const frame = frameRef.current;
    if (!doc || !frame || !iframe || !active) {
      setBox(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const element = doc.querySelector(`[data-block="${active}"]`);
      if (!element) {
        setBox(null);
        return;
      }
      const frameRect = frame.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const win = doc.defaultView;
      const before = neighbour(element, 'previous')?.getBoundingClientRect();
      const after = neighbour(element, 'next')?.getBoundingClientRect();
      const offsetTop = iframeRect.top - frameRect.top;
      const offsetLeft = iframeRect.left - frameRect.left;
      setBox({
        top: rect.top + offsetTop,
        left: rect.left + offsetLeft,
        width: rect.width,
        height: rect.height,
        view: {
          top: offsetTop,
          left: offsetLeft,
          width: iframeRect.width,
          height: iframeRect.height,
        },
        spaceAbove: before ? Math.max(0, rect.top - before.bottom) : rect.top,
        spaceBelow: after
          ? Math.max(0, after.top - rect.bottom)
          : Math.max(0, doc.documentElement.scrollHeight - (win?.scrollY ?? 0) - rect.bottom),
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const win = iframe.contentWindow;
    win?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(doc.body);
    observer.observe(iframe);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      win?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [iframe, active, blocks, frameRef]);

  if (!active || !box || !root || index < 0) return null;

  const label =
    metadataName || swap.label || info?.title || __('Section', 'pressbase-admin');
  const { view } = box;
  const viewBottom = view.top + view.height;
  // The toolbar sits inside the section's top right corner, kept in view while the section is.
  const toolbarTop = Math.min(Math.max(box.top + 8, view.top + 8), box.top + box.height - 40);
  const toolbarRight = Math.min(box.left + box.width, view.left + view.width) - 8;
  const showToolbar = box.top + box.height > view.top + 40 && box.top < viewBottom - 40;
  const bottom = box.top + box.height;
  const abovePlace = addButtonPlace(box.top, box.spaceAbove, 'above', box);
  const belowPlace = addButtonPlace(bottom, box.spaceBelow, 'below', box);
  const showBefore = abovePlace.top >= view.top + 12 && abovePlace.top <= viewBottom - 12;
  const showAfter = belowPlace.top >= view.top + 12 && belowPlace.top <= viewBottom - 12;

  const onToolbarKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = [
      ...(toolbarRef.current?.querySelectorAll<HTMLButtonElement>(
        ':scope > button, :scope > div > button',
      ) ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = (at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  };

  const sectionName = sprintf(
    __('Section %1$d of %2$d: %3$s', 'pressbase-admin'),
    index + 1,
    order.length,
    label,
  );

  return (
    <div ref={layerRef} className={styles.sectionLayer}>
      <div
        className={styles.sectionClip}
        style={{ top: view.top, left: view.left, width: view.width, height: view.height }}
        aria-hidden="true"
      >
        <div
          className={styles.sectionOutline}
          style={{
            top: box.top - view.top,
            left: box.left - view.left,
            width: box.width,
            height: box.height,
          }}
        />
      </div>
      {showToolbar && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={sectionName}
          className={styles.sectionToolbar}
          style={{ top: toolbarTop, left: toolbarRight }}
          onKeyDown={onToolbarKey}
        >
          <span className={styles.sectionToolbarLabel} aria-hidden="true">
            {label}
          </span>
          <button
            type="button"
            className={styles.sectionToolbarButton}
            aria-label={__('Move section up', 'pressbase-admin')}
            title={__('Move up', 'pressbase-admin')}
            aria-disabled={index === 0 || undefined}
            onClick={() => index > 0 && actions.moveBlocksUp([active], root)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.sectionToolbarButton}
            aria-label={__('Move section down', 'pressbase-admin')}
            title={__('Move down', 'pressbase-admin')}
            aria-disabled={index === order.length - 1 || undefined}
            onClick={() => index < order.length - 1 && actions.moveBlocksDown([active], root)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.sectionToolbarButton}
            aria-label={__('Duplicate section', 'pressbase-admin')}
            title={__('Duplicate', 'pressbase-admin')}
            onClick={() => actions.duplicateBlocks([active])}
          >
            <Copy size={16} aria-hidden="true" />
          </button>
          {swap.layouts && (
            <div className={styles.sectionToolbarGroup}>
              <SwapArrows
                state={swap}
                buttonClassName={styles.sectionToolbarButton}
                counterClassName={styles.swapCounter}
              />
            </div>
          )}
          <button
            type="button"
            className={styles.sectionToolbarButton}
            aria-label={__('Ask AI about this section (coming soon)', 'pressbase-admin')}
            title={__('Ask AI: coming soon', 'pressbase-admin')}
            aria-disabled="true"
            onClick={onAskAi}
          >
            <Sparkles size={16} aria-hidden="true" />
          </button>
          <ActionMenu
            label={__('More for this section', 'pressbase-admin')}
            actions={[
              {
                label: __('Select section', 'pressbase-admin'),
                onSelect: () => actions.selectBlock(active),
              },
              {
                label: __('Add a section above', 'pressbase-admin'),
                onSelect: () => onAddSection(index),
              },
              {
                label: __('Add a section below', 'pressbase-admin'),
                onSelect: () => onAddSection(index + 1),
              },
              {
                label: __('Remove section', 'pressbase-admin'),
                tone: 'danger',
                onSelect: () => actions.removeBlocks([active]),
              },
            ]}
          />
        </div>
      )}
      {showBefore && (
        <button
          type="button"
          className={styles.addSection}
          data-round={abovePlace.round || undefined}
          style={{ top: abovePlace.top, left: abovePlace.left }}
          aria-label={sprintf(__('Add a section above %s', 'pressbase-admin'), label)}
          title={abovePlace.round ? __('Add section', 'pressbase-admin') : undefined}
          onClick={() => onAddSection(index)}
        >
          <Plus size={14} aria-hidden="true" />
          {!abovePlace.round && __('Add section', 'pressbase-admin')}
        </button>
      )}
      {showAfter && (
        <button
          type="button"
          className={styles.addSection}
          data-round={belowPlace.round || undefined}
          style={{ top: belowPlace.top, left: belowPlace.left }}
          aria-label={sprintf(__('Add a section below %s', 'pressbase-admin'), label)}
          title={belowPlace.round ? __('Add section', 'pressbase-admin') : undefined}
          onClick={() => onAddSection(index + 1)}
        >
          <Plus size={14} aria-hidden="true" />
          {!belowPlace.round && __('Add section', 'pressbase-admin')}
        </button>
      )}
    </div>
  );
}
