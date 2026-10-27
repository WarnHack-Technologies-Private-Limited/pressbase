'use client';

import { Check, FileAudio, FileText, FileVideo, X } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { plainTitle } from '@/lib/content';
import { filterFor, formatBytes, previewUrl, type RestMedia, typeLabel } from '@/lib/media';
import styles from './media.module.css';
import type { UploadItem } from './use-media';

/** Icon for files that have no picture. */
export function FileIcon({ mime, size = 32 }: { mime: string; size?: number }) {
  const kind = filterFor(mime);
  const Icon = kind === 'audio' ? FileAudio : kind === 'video' ? FileVideo : FileText;
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />;
}

/** Accessible name for a tile: the title, then what kind of file it is. */
function tileLabel(media: RestMedia): string {
  const title = plainTitle(media.title.rendered) || '(no title)';
  return `${title}, ${typeLabel(media)}${media.media_type === 'image' && media.media_details.width ? `, ${media.media_details.width} × ${media.media_details.height}` : ''}`;
}

/**
 * The thumbnail grid. Each item is a button; arrow keys move between them
 * (one tab stop for the whole grid), Home and End jump to the ends.
 * In `select` mode, buttons are toggles (aria-pressed) for the picker.
 */
export function MediaGrid({
  items,
  label,
  mode = 'open',
  selectedId,
  onActivate,
  onConfirm,
}: {
  items: RestMedia[];
  label: string;
  mode?: 'open' | 'select';
  selectedId?: number;
  onActivate: (media: RestMedia, element: HTMLButtonElement) => void;
  /** Double-click in select mode. */
  onConfirm?: (media: RestMedia) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const current = Math.min(focusIndex, Math.max(items.length - 1, 0));

  const buttons = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-tile]') ?? []);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = buttons();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    // Columns: how many tiles share the first tile's row.
    const top = all[0]?.offsetTop ?? 0;
    const columns = Math.max(1, all.filter((b) => b.offsetTop === top).length);
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
        next = index + 1;
        break;
      case 'ArrowLeft':
        next = index - 1;
        break;
      case 'ArrowDown':
        next = index + columns;
        break;
      case 'ArrowUp':
        next = index - columns;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    next = Math.max(0, Math.min(all.length - 1, next));
    setFocusIndex(next);
    all[next]?.focus();
  };

  return (
    <ul className={styles.grid} aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {items.map((media, index) => {
        const thumb = previewUrl(media);
        const selected = mode === 'select' && media.id === selectedId;
        return (
          <li key={media.id} className={styles.cell}>
            <button
              type="button"
              data-tile
              data-media-id={media.id}
              className={styles.tile}
              tabIndex={index === current ? 0 : -1}
              aria-label={tileLabel(media)}
              aria-pressed={mode === 'select' ? selected : undefined}
              aria-haspopup={mode === 'open' ? 'dialog' : undefined}
              onFocus={() => setFocusIndex(index)}
              onClick={(e) => onActivate(media, e.currentTarget)}
              onDoubleClick={() => onConfirm?.(media)}
            >
              {thumb ? (
                <img
                  src={thumb}
                  alt=""
                  className={styles.thumb}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              ) : (
                <span className={styles.fileTile}>
                  <FileIcon mime={media.mime_type} />
                  <span className={styles.fileTileName}>{plainTitle(media.title.rendered)}</span>
                  <span className={styles.fileTileType}>{typeLabel(media)}</span>
                </span>
              )}
              {selected && (
                <span className={styles.check} aria-hidden="true">
                  <Check size={14} strokeWidth={3} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Placeholder tiles while the first page loads. */
export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <ul className={styles.grid} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={styles.cell}>
          <div className={`${styles.tile} ${styles.skeleton}`} />
        </li>
      ))}
    </ul>
  );
}

/** Per-file progress for uploads in flight, with errors kept until dismissed. */
export function UploadList({
  uploads,
  onDismiss,
  onClear,
}: {
  uploads: UploadItem[];
  onDismiss: (key: number) => void;
  onClear: () => void;
}) {
  if (!uploads.length) return null;
  const active = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading').length;
  const failed = uploads.filter((u) => u.status === 'error').length;
  const done = uploads.length - active - failed;
  const summary = active
    ? `Uploading ${active} ${active === 1 ? 'file' : 'files'}…`
    : failed
      ? `${failed} ${failed === 1 ? 'upload' : 'uploads'} failed${done ? `, ${done} done` : ''}`
      : `${done} ${done === 1 ? 'file' : 'files'} uploaded`;
  return (
    <section className={styles.uploads} aria-label="Uploads">
      <header className={styles.uploadsHeader}>
        <h2 className={styles.uploadsTitle} aria-live="polite">
          {summary}
        </h2>
        {!active && (
          <button type="button" className={styles.linkButton} onClick={onClear}>
            Clear
          </button>
        )}
      </header>
      <ul className={styles.uploadRows}>
        {uploads.map((u) => (
          <li key={u.key} className={styles.uploadRow} data-status={u.status}>
            <div className={styles.uploadName}>
              <span className={styles.uploadFile}>{u.name}</span>
              <span className={styles.uploadMeta}>
                {u.status === 'error' ? (
                  <span className={styles.uploadError}>{u.error}</span>
                ) : u.status === 'done' ? (
                  <>
                    <Check size={14} aria-hidden="true" /> Uploaded
                  </>
                ) : u.status === 'queued' ? (
                  'Waiting…'
                ) : (
                  `${Math.round(u.progress * 100)}% of ${formatBytes(u.size)}`
                )}
              </span>
            </div>
            {(u.status === 'uploading' || u.status === 'queued') && (
              <div
                className={styles.progress}
                role="progressbar"
                aria-label={`Uploading ${u.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(u.progress * 100)}
              >
                <span style={{ width: `${Math.max(2, u.progress * 100)}%` }} />
              </div>
            )}
            {u.status !== 'done' && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onDismiss(u.key)}
                aria-label={u.status === 'error' ? `Dismiss ${u.name}` : `Cancel ${u.name}`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
