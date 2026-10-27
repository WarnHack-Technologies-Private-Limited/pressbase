'use client';

import { addFilter, hasFilter } from '@wordpress/hooks';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { type MediaKind, MediaPicker } from '../media/media-picker';
import { kindsFor, toEditorMedia } from './media-shape';

/**
 * Connects the block editor's "Media Library" buttons (image, cover, gallery,
 * video, audio, media & text…) to Pressbase's MediaPicker, through the same
 * `editor.MediaUpload` filter WordPress uses to plug in its media modal
 * (wp-includes/js/media/… via @wordpress/media-utils' MediaUpload).
 */

interface MediaUploadProps {
  onSelect: (media: unknown) => void;
  allowedTypes?: string[];
  multiple?: boolean | 'add';
  value?: number | number[];
  render: (args: { open: () => void }) => ReactNode;
  title?: string;
  onClose?: () => void;
}

const PICKER_TITLES: Record<MediaKind | 'media', string> = {
  image: 'Choose an image',
  video: 'Choose a video',
  audio: 'Choose audio',
  document: 'Choose a file',
  media: 'Choose media',
};

function PressbaseMediaUpload({
  onSelect,
  allowedTypes,
  multiple,
  value,
  render,
  title,
  onClose,
}: MediaUploadProps) {
  const [open, setOpen] = useState(false);
  const kinds = kindsFor(allowedTypes);
  const kind = kinds?.length === 1 ? kinds[0] : undefined;
  return (
    <>
      {render({ open: () => setOpen(true) })}
      {/* Blocks render inside the canvas iframe; the picker belongs to the admin page. */}
      {open &&
        createPortal(
          <MediaPicker
            open
            allowedTypes={kinds}
            title={title ?? PICKER_TITLES[kind ?? 'media']}
            selectLabel="Insert"
            selectedId={typeof value === 'number' ? value : undefined}
            onClose={() => {
              setOpen(false);
              onClose?.();
            }}
            onSelect={(media) => {
              const item = toEditorMedia(media);
              // Galleries pick one image at a time for now.
              onSelect(multiple ? [item] : item);
            }}
          />,
          document.body,
        )}
    </>
  );
}

export function registerMediaLibrary(): void {
  if (hasFilter('editor.MediaUpload', 'pressbase/media-library')) return;
  addFilter('editor.MediaUpload', 'pressbase/media-library', () => PressbaseMediaUpload);
}
