'use client';

import { ImageIcon, Search, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { plainTitle } from '@/lib/content';
import {
  ACCEPT,
  filterFor,
  MEDIA_FILTERS,
  type MediaFilter,
  previewUrl,
  type RestMedia,
  typeLabel,
} from '@/lib/media';
import { useCan } from '../shell/current-user';
import { Button } from '../ui/button';
import { EmptyState, Notice } from '../ui/surface';
import { DropOverlay, useFileDrop } from './drop-zone';
import styles from './media.module.css';
import { FileIcon, GridSkeleton, MediaGrid, UploadList } from './media-grid';
import {
  initialSelection,
  orderedSelection,
  selectedCount,
  selectRange,
  toggleSelection,
} from './selection';
import { useMediaList, useUploads } from './use-media';

export type MediaKind = Exclude<MediaFilter, 'all'>;

export interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen item; the picker closes itself afterwards. */
  onSelect?: (media: RestMedia) => void;
  /**
   * Pick several items (a gallery): click or Space toggles an item, Shift+click
   * selects a range, and the order of picking is kept. Confirming calls
   * `onSelectMultiple` instead of `onSelect`.
   */
  multiple?: boolean;
  /** Multi-select: called with the picked items, in the order they were picked. */
  onSelectMultiple?: (media: RestMedia[]) => void;
  /** Multi-select: IDs picked when the picker opens (a gallery's images), in order. */
  selectedIds?: readonly number[];
  /** Multi-select: the primary button's label for a count, e.g. n => `Insert ${n} images`. */
  multipleLabel?: (count: number) => string;
  /** Limit to these kinds, e.g. ['image'] for a featured image. Default: everything. */
  allowedTypes?: MediaKind[];
  /** Dialog heading, e.g. "Choose a featured image". */
  title?: string;
  /** Primary button label, e.g. "Set featured image". */
  selectLabel?: string;
  /** Pre-selects this item (the current featured image, for example). */
  selectedId?: number;
}

/**
 * Choose one item (or, with `multiple`, several) from the media library or
 * upload new ones — WordPress's media modal, for the editor's featured image,
 * media blocks and galleries.
 *
 * ```tsx
 * <MediaPicker open={picking} allowedTypes={['image']} title="Choose a featured image"
 *   selectLabel="Set featured image" onClose={() => setPicking(false)}
 *   onSelect={(media) => setFeatured(media.id)} />
 * ```
 */
export function MediaPicker(props: MediaPickerProps) {
  if (!props.open) return null;
  return <PickerDialog {...props} />;
}

function PickerDialog({
  onClose,
  onSelect,
  multiple = false,
  onSelectMultiple,
  selectedIds,
  multipleLabel,
  allowedTypes,
  title = 'Choose media',
  selectLabel = 'Select',
  selectedId,
}: MediaPickerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const canUpload = useCan('upload_files');
  const kinds = allowedTypes?.length ? allowedTypes : undefined;
  const filters = MEDIA_FILTERS.filter(
    (f) => f.id === 'all' || !kinds || kinds.includes(f.id as MediaKind),
  );
  const [filter, setFilter] = useState<MediaFilter>(
    kinds?.length === 1 ? (kinds[0] as MediaFilter) : 'all',
  );
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<RestMedia | undefined>();
  const [rejected, setRejected] = useState<string>();
  const list = useMediaList({ filter, search, allowed: kinds });

  // Multi-select: picked IDs in order, every item seen so far (across filters,
  // searches and pages), and the last item toggled (the Shift+click anchor).
  const [picked, setPicked] = useState<number[]>(() => initialSelection(selectedIds));
  const [known, setKnown] = useState<ReadonlyMap<number, RestMedia>>(() => new Map());
  const anchor = useRef<number | undefined>(undefined);
  const remember = useCallback((items: RestMedia[]) => {
    if (!items.length) return;
    setKnown((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.id, item);
      return next;
    });
  }, []);
  useEffect(() => {
    if (multiple && list.items) remember(list.items);
  }, [multiple, list.items, remember]);

  // Preselected items may not be on the first page: load them by ID.
  const preselected = useRef(initialSelection(selectedIds));
  useEffect(() => {
    const ids = preselected.current;
    if (!multiple || !ids.length) return;
    const q = new URLSearchParams({
      context: 'edit',
      include: ids.join(','),
      per_page: String(Math.min(ids.length, 100)),
    });
    fetch(`/wp-json/wp/v2/media?${q}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : []))
      .then((items: RestMedia[]) => remember(Array.isArray(items) ? items : []))
      .catch(() => {});
  }, [multiple, remember]);
  const pickedItems = useMemo(() => orderedSelection(picked, known), [picked, known]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Pre-select the current item once it's loaded.
  useEffect(() => {
    if (selectedId && !chosen) {
      const found = list.items?.find((m) => m.id === selectedId);
      if (found) setChosen(found);
    }
  }, [selectedId, list.items, chosen]);

  const { prepend } = list;
  const { uploads, add, dismiss, clearFinished } = useUploads(
    useCallback(
      (media: RestMedia) => {
        prepend(media);
        // A fresh upload is almost always the one wanted.
        if (multiple) {
          remember([media]);
          setPicked((current) => (current.includes(media.id) ? current : [...current, media.id]));
        } else {
          setChosen(media);
        }
      },
      [prepend, multiple, remember],
    ),
  );

  const addFiles = (files: FileList | File[]) => {
    const all = Array.from(files);
    const ok = kinds
      ? all.filter((f) => kinds.includes(filterFor(f.type || 'application/x')))
      : all;
    setRejected(
      ok.length < all.length
        ? `Only ${kinds?.map((k) => MEDIA_FILTERS.find((f) => f.id === k)?.label.toLowerCase()).join(' or ')} can be used here.`
        : undefined,
    );
    if (ok.length) add(ok);
  };
  const dragging = useFileDrop(addFiles, { enabled: canUpload, target: bodyRef });

  const confirm = (media: RestMedia | undefined = chosen) => {
    if (multiple) {
      if (!pickedItems.length) return;
      onSelectMultiple?.(pickedItems);
      onClose();
      return;
    }
    if (!media) return;
    onSelect?.(media);
    onClose();
  };

  const activate = (media: RestMedia, shiftKey: boolean) => {
    if (!multiple) {
      setChosen(chosen?.id === media.id ? undefined : media);
      return;
    }
    const grid = (list.items ?? []).map((m) => m.id);
    setPicked((current) =>
      shiftKey
        ? selectRange(current, grid, anchor.current, media.id)
        : toggleSelection(current, media.id),
    );
    anchor.current = media.id;
  };
  const count = pickedItems.length;
  const primaryLabel = multiple
    ? (multipleLabel?.(count) ?? (count ? `Select ${count}` : 'Select'))
    : selectLabel;

  const accept = kinds ? kinds.map((k) => ACCEPT[k]).join(',') : ACCEPT.all;
  const items = list.items ?? [];

  return (
    <dialog
      ref={ref}
      className={styles.picker}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // Ctrl/⌘+Enter confirms from anywhere, as Enter alone toggles a tile.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          confirm();
        }
      }}
    >
      <header className={styles.detailsHeader}>
        <h2 id={titleId} className={styles.detailsTitle}>
          {title}
        </h2>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className={styles.pickerBody} ref={bodyRef}>
        <div className={styles.toolbar}>
          {filters.length > 2 && (
            <ul className={styles.tabs} aria-label="Filter by type">
              {filters.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className={styles.tab}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.pickerTools}>
            <search>
              <form
                className={styles.searchForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  setSearch(query.trim());
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
                    if (!e.target.value) setSearch('');
                  }}
                />
              </form>
            </search>
            {canUpload && (
              <>
                <Button
                  size="sm"
                  icon={<Upload size={14} aria-hidden="true" />}
                  onClick={() => fileInput.current?.click()}
                >
                  Upload
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={accept}
                  className="visually-hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>

        {rejected && <Notice tone="warning" title={rejected} />}
        <UploadList uploads={uploads} onDismiss={dismiss} onClear={clearFinished} />
        {list.error && <Notice tone="danger" title={list.error} />}

        {list.items === null ? (
          <GridSkeleton count={10} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ImageIcon size={28} />}
            title={search ? 'No media match' : 'Nothing here yet'}
          >
            <p>
              {search
                ? 'Try other words.'
                : canUpload
                  ? 'Upload a file, or drop one here.'
                  : 'Files uploaded to your site will appear here.'}
            </p>
          </EmptyState>
        ) : (
          <>
            <MediaGrid
              items={items}
              label="Media items"
              mode="select"
              selectedId={chosen?.id}
              selectedIds={multiple ? picked.filter((id) => known.has(id)) : undefined}
              onActivate={(media, _element, { shiftKey }) => activate(media, shiftKey)}
              onConfirm={multiple ? undefined : (media) => confirm(media)}
            />
            {list.hasMore && (
              <div className={styles.more}>
                <span />
                <Button size="sm" onClick={list.loadMore} loading={list.loadingMore}>
                  {list.loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
        <DropOverlay visible={dragging} contained />
      </div>

      <footer className={styles.detailsFooter}>
        <div className={styles.chosen} aria-live="polite">
          {multiple ? (
            <PickedSummary items={pickedItems} onClear={() => setPicked([])} />
          ) : chosen ? (
            <>
              {previewUrl(chosen, 64) ? (
                <img src={previewUrl(chosen, 64)} alt="" className={styles.chosenThumb} />
              ) : (
                <span className={styles.chosenThumb}>
                  <FileIcon mime={chosen.mime_type} size={20} />
                </span>
              )}
              <span className={styles.chosenText}>
                <strong>{plainTitle(chosen.title.rendered) || '(no title)'}</strong>
                <span>
                  {typeLabel(chosen)}
                  {chosen.media_details.width
                    ? ` · ${chosen.media_details.width} × ${chosen.media_details.height}`
                    : ''}
                </span>
              </span>
            </>
          ) : (
            <span className={styles.unsaved}>Nothing selected</span>
          )}
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={multiple ? count === 0 : !chosen}
          onClick={() => confirm()}
        >
          {primaryLabel}
        </Button>
      </footer>
    </dialog>
  );
}

/** The footer in multi-select mode: the first few picks, the count, and Clear. */
function PickedSummary({ items, onClear }: { items: RestMedia[]; onClear: () => void }) {
  if (!items.length) {
    return (
      <span className={styles.hint}>Click items to select them. Shift-click selects a range.</span>
    );
  }
  const shown = items.slice(0, 4);
  const more = items.length - shown.length;
  return (
    <>
      <ul className={styles.picked} aria-hidden="true">
        {shown.map((media) => {
          const thumb = previewUrl(media, 64);
          return (
            <li key={media.id}>
              {thumb ? (
                <img src={thumb} alt="" className={styles.chosenThumb} />
              ) : (
                <span className={styles.chosenThumb}>
                  <FileIcon mime={media.mime_type} size={20} />
                </span>
              )}
            </li>
          );
        })}
        {more > 0 && (
          <li>
            <span className={`${styles.chosenThumb} ${styles.pickedMore}`}>+{more}</span>
          </li>
        )}
      </ul>
      <span className={styles.chosenText}>
        <strong>{selectedCount(items.length)}</strong>
        <span>Numbered in the order they’ll appear</span>
      </span>
      <button type="button" className={styles.linkButton} onClick={onClear}>
        Clear
      </button>
    </>
  );
}
