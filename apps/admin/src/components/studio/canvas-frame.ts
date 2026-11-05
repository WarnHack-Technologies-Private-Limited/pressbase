'use client';

import { type RefObject, useEffect, useState } from 'react';

/**
 * The canvas iframe, once the block editor has put it in the frame and
 * drawn the blocks (as the section toolbar finds it). For controls drawn in
 * Studio's document over the canvas: the right-click menu (#36) and the
 * handles (#37).
 */
export function useCanvasIframe(
  frameRef: RefObject<HTMLDivElement | null>,
): HTMLIFrameElement | null {
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  useEffect(() => {
    let timer = 0;
    const find = () => {
      const found = frameRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      );
      if (found?.contentDocument?.querySelector('.is-root-container')) setIframe(found);
      else timer = window.setTimeout(find, 250);
    };
    find();
    return () => window.clearTimeout(timer);
  }, [frameRef]);
  return iframe;
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
