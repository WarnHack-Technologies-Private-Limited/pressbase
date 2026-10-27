'use client';

import { addFilter, hasFilter } from '@wordpress/hooks';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { MediaPicker } from '../media/media-picker';
import { initialSelection } from '../media/selection';
import { kindsFor, pickerCopy, toEditorMedia } from './media-shape';

/**
 * Connects the block editor's "Media Library" buttons (image, cover, gallery,
 * video, audio, media & text…) to Pressbase's MediaPicker, through the same
 * `editor.MediaUpload` filter WordPress uses to plug in its media modal
 * (wp-includes/js/media/… via @wordpress/media-utils' MediaUpload).
 */

interface MediaUploadProps {
  onSelect: (media: unknown) => void;
  allowedTypes?: string[];
  /** `add` allows several files, like `true`. */
  multiple?: boolean | 'add';
  /** A gallery is being created or edited (images only). */
  gallery?: boolean;
  /** The gallery already has images; they come back with the new ones. */
  addToGallery?: boolean;
  value?: number | number[] | { id?: number } | { id?: number }[];
  render: (args: { open: () => void }) => ReactNode;
  title?: string;
  onClose?: () => void;
}

function PressbaseMediaUpload({
  onSelect,
  allowedTypes,
  multiple,
  gallery,
  addToGallery,
  value,
  render,
  title,
  onClose,
}: MediaUploadProps) {
  const [open, setOpen] = useState(false);
  const kinds = kindsFor(allowedTypes);
  const kind = kinds?.length === 1 ? kinds[0] : undefined;
  const many = Boolean(multiple);
  const copy = pickerCopy({ kind, multiple: many, gallery, addToGallery });
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      {render({ open: () => setOpen(true) })}
      {/* Blocks render inside the canvas iframe; the picker belongs to the admin page. */}
      {open &&
        createPortal(
          many ? (
            // Galleries ("Media Library" and "Add"): the gallery's images come
            // preselected, and the result is the whole list in picked order,
            // as WordPress's gallery-edit frame returns it.
            <MediaPicker
              open
              multiple
              allowedTypes={kinds}
              title={title ?? copy.title}
              selectedIds={initialSelection(value)}
              multipleLabel={copy.multipleLabel}
              onClose={close}
              onSelectMultiple={(items) => onSelect(items.map(toEditorMedia))}
            />
          ) : (
            <MediaPicker
              open
              allowedTypes={kinds}
              title={title ?? copy.title}
              selectLabel={copy.selectLabel}
              selectedId={typeof value === 'number' ? value : undefined}
              onClose={close}
              onSelect={(media) => onSelect(toEditorMedia(media))}
            />
          ),
          document.body,
        )}
    </>
  );
}

export function registerMediaLibrary(): void {
  if (hasFilter('editor.MediaUpload', 'pressbase/media-library')) return;
  addFilter('editor.MediaUpload', 'pressbase/media-library', () => PressbaseMediaUpload);
}
