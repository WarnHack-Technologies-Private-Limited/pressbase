'use client';

import { store as blockEditorStore } from '@wordpress/block-editor';
import { useSelect } from '@wordpress/data';
import { type RefObject, useEffect, useState } from 'react';
import { autoScrollSpeed } from './elements-model';
import { contentRootId } from './sections-panel';

interface Selectors {
  getBlockInsertionPoint: () => { rootClientId?: string | null; operation?: string };
  isBlockInsertionPointVisible: () => boolean;
}

/** The attribute that lights up the block a drop goes into (canvas.css). */
export const DROP_TARGET_ATTRIBUTE = 'data-studio-drop-target';

/**
 * Help while something is dragged over the canvas (#35): the block it will
 * go into (a group, a column, an empty section) is highlighted, on top of
 * the drop line WordPress's drop zones draw between blocks; and the canvas
 * scrolls when the pointer nears its top or bottom edge. The page's content
 * itself isn't highlighted: the line is enough there.
 */
export function CanvasDragAssist({ frameRef }: { frameRef: RefObject<HTMLDivElement | null> }) {
  const pageRoot = useSelect(
    (select) =>
      contentRootId(select(blockEditorStore) as unknown as Parameters<typeof contentRootId>[0]),
    [],
  );
  const [doc, setDoc] = useState<Document | null>(null);
  const [dragging, setDragging] = useState(false);
  const target = useSelect((select) => {
    const s = select(blockEditorStore) as unknown as Selectors;
    if (!s.isBlockInsertionPointVisible()) return null;
    const point = s.getBlockInsertionPoint();
    return point.operation === 'insert' || point.operation === undefined
      ? (point.rootClientId ?? null)
      : null;
  }, []);

  // The canvas document, once the editor has put the iframe in the frame.
  useEffect(() => {
    let timer = 0;
    const find = () => {
      const iframe = frameRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      );
      const found = iframe?.contentDocument;
      if (found?.querySelector('.is-root-container')) setDoc(found);
      else timer = window.setTimeout(find, 250);
    };
    find();
    return () => window.clearTimeout(timer);
  }, [frameRef]);

  // Dragging over the canvas, and auto-scrolling near its edges.
  useEffect(() => {
    const win = doc?.defaultView;
    if (!doc || !win) return;
    let speed = 0;
    let frame = 0;
    const step = () => {
      frame = 0;
      if (!speed) return;
      win.scrollBy(0, speed);
      frame = win.requestAnimationFrame(step);
    };
    const stop = () => {
      speed = 0;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      setDragging(true);
      speed = autoScrollSpeed(event.clientY, win.innerHeight);
      if (speed && !frame) frame = win.requestAnimationFrame(step);
    };
    const onLeave = (event: DragEvent) => {
      // Leaving the canvas, not moving between its elements.
      if (!event.relatedTarget) stop();
    };
    doc.addEventListener('dragover', onOver);
    doc.addEventListener('dragleave', onLeave);
    doc.addEventListener('drop', stop);
    window.addEventListener('dragend', stop);
    window.addEventListener('drop', stop);
    return () => {
      stop();
      doc.removeEventListener('dragover', onOver);
      doc.removeEventListener('dragleave', onLeave);
      doc.removeEventListener('drop', stop);
      window.removeEventListener('dragend', stop);
      window.removeEventListener('drop', stop);
    };
  }, [doc]);

  // The highlighted drop area.
  useEffect(() => {
    if (!doc || !dragging || !target || target === pageRoot) return;
    const element = doc.getElementById(`block-${target}`);
    element?.setAttribute(DROP_TARGET_ATTRIBUTE, '');
    return () => element?.removeAttribute(DROP_TARGET_ATTRIBUTE);
  }, [doc, dragging, target, pageRoot]);

  return null;
}
