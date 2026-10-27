'use client';

import { ImagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { previewUrl, type RestMedia } from '@/lib/media';
import { MediaPicker } from '../media/media-picker';
import styles from './editor.module.css';

/**
 * The editor's "Featured image" panel — WordPress's post thumbnail box
 * (`featured_media`, stored as `_thumbnail_id`). Themes decide where it shows.
 */
export function FeaturedImage({
  value,
  onChange,
}: {
  value: number;
  onChange: (id: number) => void;
}) {
  const [media, setMedia] = useState<RestMedia | null>(null);
  const [picking, setPicking] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setMissing(false);
    if (!value) {
      setMedia(null);
      return;
    }
    if (media?.id === value) return;
    let live = true;
    api<RestMedia>(`/wp/v2/media/${value}?context=edit`)
      .then((m) => live && setMedia(m))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [value, media?.id]);

  const picker = (
    <MediaPicker
      open={picking}
      allowedTypes={['image']}
      title="Choose a featured image"
      selectLabel="Set featured image"
      selectedId={value || undefined}
      onClose={() => setPicking(false)}
      onSelect={(chosen) => {
        setMedia(chosen);
        onChange(chosen.id);
      }}
    />
  );

  if (!value || missing) {
    return (
      <>
        {missing && <p className={styles.hint}>The previous featured image no longer exists.</p>}
        <button type="button" className={styles.featuredEmpty} onClick={() => setPicking(true)}>
          <ImagePlus size={20} aria-hidden="true" />
          Set featured image
        </button>
        {picker}
      </>
    );
  }

  const src = media ? previewUrl(media, 400) : undefined;
  return (
    <>
      <button
        type="button"
        className={styles.featuredPreview}
        onClick={() => setPicking(true)}
        aria-label={`Replace featured image${media?.alt_text ? `: ${media.alt_text}` : ''}`}
      >
        {src ? <img src={src} alt="" /> : <span className={styles.hint}>Loading…</span>}
      </button>
      {media && !media.alt_text && (
        <p className={styles.hint}>
          This image has no alt text. Add it in the media library so everyone can understand it.
        </p>
      )}
      <div className={styles.featuredActions}>
        <button type="button" className={styles.linkButton} onClick={() => setPicking(true)}>
          Replace
        </button>
        <button
          type="button"
          className={styles.linkButton}
          data-tone="danger"
          onClick={() => onChange(0)}
        >
          Remove
        </button>
      </div>
      {picker}
    </>
  );
}
