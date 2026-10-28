'use client';

import { ImagePlus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { previewUrl, type RestMedia } from '@/lib/media';
import { MediaPicker } from '../media/media-picker';
import { Button } from '../ui/button';
import styles from './site-identity.module.css';

/** The image behind an attachment ID, loaded once per ID. */
function useMedia(id: number) {
  const [media, setMedia] = useState<RestMedia | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
    if (!id) {
      setMedia(null);
      return;
    }
    if (media?.id === id) return;
    let live = true;
    api<RestMedia>(`/wp/v2/media/${id}?context=edit`)
      .then((m) => live && setMedia(m))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [id, media?.id]);
  return { media: media?.id === id ? media : null, setMedia, missing };
}

interface ImageSettingProps {
  value: number;
  onChange: (id: number) => void;
  siteName: string;
}

/**
 * Site logo (`site_logo`): shown by themes through the Site Logo block,
 * linked to the home page.
 */
export function SiteLogoField({ value, onChange, siteName }: ImageSettingProps) {
  const { media, setMedia, missing } = useMedia(value);
  const [picking, setPicking] = useState(false);
  const hintId = useId();
  const src = media ? previewUrl(media, 400) : undefined;
  return (
    <fieldset className={styles.field} aria-describedby={hintId}>
      <legend className={styles.label}>
        Logo <span className={styles.optional}>(optional)</span>
      </legend>
      <p id={hintId} className={styles.hint}>
        Appears where your theme places the Site Logo block, linked to your home page.
      </p>
      <div className={styles.body}>
        <div className={styles.logoBox} data-empty={!value || missing}>
          {src ? (
            <img src={src} alt={media?.alt_text || `${siteName || 'Site'} logo`} />
          ) : (
            <span className={styles.placeholder}>{missing ? 'Image missing' : 'No logo'}</span>
          )}
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            icon={<ImagePlus size={15} aria-hidden="true" />}
            onClick={() => setPicking(true)}
          >
            {value && !missing ? 'Replace logo' : 'Choose logo'}
          </Button>
          {value > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange(0)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <MediaPicker
        open={picking}
        allowedTypes={['image']}
        title="Choose a logo"
        selectLabel="Use as logo"
        selectedId={value || undefined}
        onClose={() => setPicking(false)}
        onSelect={(chosen) => {
          setMedia(chosen);
          onChange(chosen.id);
        }}
      />
    </fieldset>
  );
}

/**
 * Site icon (`site_icon`): the favicon, the home-screen icon on phones and
 * the admin's own icon. Core crops it to square sizes when it's saved.
 */
export function SiteIconField({ value, onChange, siteName }: ImageSettingProps) {
  const { media, setMedia, missing } = useMedia(value);
  const [picking, setPicking] = useState(false);
  const hintId = useId();
  const src = media ? previewUrl(media, 192) : undefined;
  const width = media?.media_details.width ?? 0;
  const height = media?.media_details.height ?? 0;
  const tooSmall = media && (width < 512 || height < 512);
  const notSquare = media && width !== height;
  return (
    <fieldset className={styles.field} aria-describedby={hintId}>
      <legend className={styles.label}>
        Site icon <span className={styles.optional}>(optional)</span>
      </legend>
      <p id={hintId} className={styles.hint}>
        Shown in browser tabs, bookmarks and on phone home screens. Use a square image at least 512
        × 512 pixels.
      </p>
      <div className={styles.body}>
        <div className={styles.iconPreviews} aria-hidden={!src}>
          <div className={styles.tab}>
            <span className={styles.tabIcon}>
              {src ? <img src={src} alt="" /> : <span className={styles.tabBlank} />}
            </span>
            <span className={styles.tabTitle}>{siteName || 'Your site'}</span>
          </div>
          <div className={styles.appIcon}>
            {src ? <img src={src} alt="" /> : <span className={styles.placeholder}>?</span>}
          </div>
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            icon={<ImagePlus size={15} aria-hidden="true" />}
            onClick={() => setPicking(true)}
          >
            {value && !missing ? 'Replace icon' : 'Choose icon'}
          </Button>
          {value > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange(0)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {missing && <p className={styles.note}>The previous icon’s image no longer exists.</p>}
      {(tooSmall || notSquare) && (
        <p className={styles.note}>
          {notSquare ? 'This image isn’t square, so the middle of it will be used. ' : ''}
          {tooSmall ? `At ${width} × ${height} pixels it may look soft on phones.` : ''}
        </p>
      )}
      <MediaPicker
        open={picking}
        allowedTypes={['image']}
        title="Choose a site icon"
        selectLabel="Use as site icon"
        selectedId={value || undefined}
        onClose={() => setPicking(false)}
        onSelect={(chosen) => {
          setMedia(chosen);
          onChange(chosen.id);
        }}
      />
    </fieldset>
  );
}
