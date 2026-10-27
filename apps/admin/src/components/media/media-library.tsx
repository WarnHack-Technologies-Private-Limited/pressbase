'use client';

import { ImageIcon, Search, Upload } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPT, MEDIA_FILTERS, type MediaFilter, type RestMedia } from '@/lib/media';
import { useCan } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import { DropOverlay, useFileDrop } from './drop-zone';
import styles from './media.module.css';
import { MediaDetails } from './media-details';
import { GridSkeleton, MediaGrid, UploadList } from './media-grid';
import { useMediaList, useUploads } from './use-media';

/**
 * Media → Library: the thumbnail grid, uploads (button or drop anywhere on
 * the page), type filter and search kept in the URL, and a details dialog.
 */
export function MediaLibrary() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const canUpload = useCan('upload_files');

  const filterParam = params.get('type') as MediaFilter | null;
  const filter = MEDIA_FILTERS.some((f) => f.id === filterParam)
    ? (filterParam as MediaFilter)
    : 'all';
  const search = params.get('s') ?? '';
  const [query, setQuery] = useState(search);
  const list = useMediaList({ filter, search });
  const [openId, setOpenId] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const setParams = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.replace(`${pathname}${next.size ? `?${next}` : ''}`);
    },
    [params, pathname, router],
  );

  const { prepend } = list;
  const { uploads, add, dismiss, clearFinished } = useUploads(
    useCallback(
      (media: RestMedia) => {
        // Show new uploads when they match the current view.
        const group = MEDIA_FILTERS.find((f) => f.id === filter);
        const type = media.mime_type.split('/')[0] ?? '';
        if (!search && (filter === 'all' || group?.mediaTypes.includes(type))) prepend(media);
      },
      [filter, search, prepend],
    ),
  );

  // One toast when a batch finishes.
  const wasActive = useRef(false);
  useEffect(() => {
    const active = uploads.some((u) => u.status === 'queued' || u.status === 'uploading');
    if (wasActive.current && !active) {
      const done = uploads.filter((u) => u.status === 'done').length;
      const failed = uploads.filter((u) => u.status === 'error').length;
      if (done && !failed) {
        toast(`${done} ${done === 1 ? 'file' : 'files'} uploaded.`);
        clearFinished();
      }
    }
    wasActive.current = active;
  }, [uploads, toast, clearFinished]);

  const dragging = useFileDrop(add, { enabled: canUpload && openId === null });

  const items = list.items ?? [];
  const openIndex = items.findIndex((m) => m.id === openId);
  const open = openIndex >= 0 ? items[openIndex] : undefined;

  const close = () => {
    const lastId = openId;
    setOpenId(null);
    // Return focus to the tile of the item last shown (or the grid, if it was deleted).
    requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>(`[data-media-id="${lastId}"]`) ??
        (opener.current?.isConnected ? opener.current : null) ??
        document.querySelector<HTMLElement>('[data-tile][tabindex="0"]');
      target?.focus();
    });
  };

  const filtered = Boolean(search) || filter !== 'all';
  const filterLabel = MEDIA_FILTERS.find((f) => f.id === filter)?.label.toLowerCase();

  return (
    <>
      <PageHeader
        title="Media"
        description="Images, documents, audio and video for your site."
        actions={
          canUpload && (
            <Button
              variant="primary"
              icon={<Upload size={16} aria-hidden="true" />}
              onClick={() => fileInput.current?.click()}
            >
              Upload files
            </Button>
          )
        }
      />
      {canUpload && (
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT.all}
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files?.length) add(e.target.files);
            e.target.value = '';
          }}
        />
      )}

      <div className={styles.toolbar}>
        <ul className={styles.tabs} aria-label="Filter by type">
          {MEDIA_FILTERS.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={styles.tab}
                aria-pressed={filter === f.id}
                onClick={() => setParams({ type: f.id === 'all' ? undefined : f.id })}
              >
                {f.label}
              </button>
            </li>
          ))}
        </ul>
        <search>
          <form
            className={styles.searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ s: query.trim() || undefined });
            }}
          >
            <Search size={16} aria-hidden="true" />
            <input
              className={styles.searchInput}
              type="search"
              placeholder="Search media"
              aria-label="Search media"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value && search) setParams({ s: undefined });
              }}
            />
          </form>
        </search>
      </div>

      <UploadList uploads={uploads} onDismiss={dismiss} onClear={clearFinished} />
      {list.error && <Notice tone="danger" title={list.error} />}

      {list.items === null ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <div className={styles.emptyCard}>
          <EmptyState
            icon={<ImageIcon size={28} />}
            title={filtered ? 'No media match' : 'No media yet'}
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setQuery('');
                    setParams({ s: undefined, type: undefined });
                  }}
                >
                  Clear filters
                </Button>
              ) : canUpload ? (
                <Button variant="primary" onClick={() => fileInput.current?.click()}>
                  Upload files
                </Button>
              ) : undefined
            }
          >
            <p>
              {filtered
                ? search
                  ? `Nothing ${filter === 'all' ? '' : `in ${filterLabel} `}matches “${search}”. Try other words.`
                  : `There are no ${filterLabel} in the library yet.`
                : canUpload
                  ? 'Upload images, documents, audio or video, or drop files anywhere on this page.'
                  : 'Files uploaded to your site will appear here.'}
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <MediaGrid
            items={items}
            label="Media items"
            onActivate={(media, element) => {
              opener.current = element;
              setOpenId(media.id);
            }}
          />
          <div className={styles.more}>
            <span aria-live="polite">
              Showing {items.length.toLocaleString('en-US')} of {list.total.toLocaleString('en-US')}{' '}
              {list.total === 1 ? 'item' : 'items'}
            </span>
            {list.hasMore && (
              <Button onClick={list.loadMore} loading={list.loadingMore}>
                {list.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}

      {open && (
        <MediaDetails
          key="details"
          media={open}
          onClose={close}
          onSaved={list.replace}
          onDeleted={(id) => {
            list.remove(id);
            close();
          }}
          onPrevious={openIndex > 0 ? () => setOpenId(items[openIndex - 1]?.id ?? null) : undefined}
          onNext={
            openIndex < items.length - 1
              ? () => setOpenId(items[openIndex + 1]?.id ?? null)
              : undefined
          }
        />
      )}
      <DropOverlay visible={dragging} />
    </>
  );
}
