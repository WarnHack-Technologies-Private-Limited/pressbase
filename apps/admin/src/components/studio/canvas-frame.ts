'use client';

import { type RefObject, useEffect, useState } from 'react';

export interface CanvasFrame {
  iframe: HTMLIFrameElement;
  /** Its document: listeners go here, and it can be replaced while the iframe stays. */
  doc: Document;
}

/**
 * The canvas iframe and its document, once the block editor has drawn the
 * blocks there; followed when the editor replaces either (a new iframe, or
 * the same one loading its document again), so listeners never stay on an
 * old document. For controls drawn in Studio's document over the canvas:
 * the right-click menu (#36) and the handles (#37).
 */
export function useCanvasIframe(frameRef: RefObject<HTMLDivElement | null>): CanvasFrame | null {
  const [frame, setFrame] = useState<CanvasFrame | null>(null);
  useEffect(() => {
    let current: CanvasFrame | null = null;
    const check = () => {
      const iframe = frameRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      );
      const doc = iframe?.contentDocument;
      const ready = iframe && doc?.querySelector('.is-root-container') ? { iframe, doc } : null;
      if (ready?.iframe === current?.iframe && ready?.doc === current?.doc) return;
      current = ready;
      setFrame(ready);
    };
    check();
    const timer = window.setInterval(check, 250);
    return () => window.clearInterval(timer);
  }, [frameRef]);
  return frame;
}

/** A point in the canvas iframe, in Studio's own window. */
export function fromCanvas(iframe: HTMLIFrameElement, x: number, y: number) {
  const rect = iframe.getBoundingClientRect();
  return { x: rect.left + x, y: rect.top + y };
}

/** A block's element on the canvas. */
export function blockElement(
  iframe: HTMLIFrameElement | null,
  clientId: string,
): HTMLElement | null {
  return (
    iframe?.contentDocument?.querySelector<HTMLElement>(`[data-block="${CSS.escape(clientId)}"]`) ??
    null
  );
}
