'use client';

import { Upload } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import styles from './media.module.css';

const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Accepts files dropped anywhere on `target` (the whole window by default).
 * Returns whether files are being dragged over it, for the overlay.
 */
export function useFileDrop(
  onFiles: (files: File[]) => void,
  { enabled = true, target }: { enabled?: boolean; target?: RefObject<HTMLElement | null> } = {},
): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const callback = useRef(onFiles);
  callback.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const el: HTMLElement | Window = target?.current ?? window;
    const enter = (e: Event) => {
      const event = e as DragEvent;
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const over = (e: Event) => {
      const event = e as DragEvent;
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: Event) => {
      if (!hasFiles(e as DragEvent)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: Event) => {
      const event = e as DragEvent;
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) callback.current(files);
    };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [enabled, target]);

  return dragging;
}

/** The "Drop files to upload" overlay. Decorative: the upload button is the accessible path. */
export function DropOverlay({ visible, contained }: { visible: boolean; contained?: boolean }) {
  if (!visible) return null;
  return (
    <div
      className={`${styles.dropOverlay} ${contained ? styles.dropContained : ''}`}
      aria-hidden="true"
    >
      <div className={styles.dropMessage}>
        <Upload size={28} />
        <span>Drop files to upload</span>
      </div>
    </div>
  );
}
