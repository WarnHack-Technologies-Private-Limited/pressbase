'use client';

import { Checkbox, TextField } from '../ui/field';
import { Card } from '../ui/surface';
import styles from './settings.module.css';
import { type FieldApi, SettingsForm } from './settings-form';

export interface MediaSettings extends Record<string, unknown> {
  thumbnail_size_w: number;
  thumbnail_size_h: number;
  thumbnail_crop: boolean;
  medium_size_w: number;
  medium_size_h: number;
  large_size_w: number;
  large_size_h: number;
  uploads_use_yearmonth_folders: boolean;
}

type SizeKey = keyof Pick<
  MediaSettings,
  | 'thumbnail_size_w'
  | 'thumbnail_size_h'
  | 'medium_size_w'
  | 'medium_size_h'
  | 'large_size_w'
  | 'large_size_h'
>;

function PixelField({
  label,
  name,
  api,
}: {
  label: string;
  name: SizeKey;
  api: FieldApi<MediaSettings>;
}) {
  const value = api.values[name];
  return (
    <TextField
      label={label}
      type="number"
      inputMode="numeric"
      min={0}
      max={10000}
      step={1}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => api.set(name, e.target.valueAsNumber)}
      error={api.errors[name]}
    />
  );
}

/** Settings → Media, as in WordPress's options-media.php. */
export function MediaSettingsForm({ initial }: { initial: MediaSettings }) {
  return (
    <SettingsForm initial={initial}>
      {(api) => (
        <>
          <Card
            title="Image sizes"
            description="Pressbase makes these sizes of every image you upload, so pages load fast. Sizes are in pixels; 0 means no limit. Changes apply to new uploads."
          >
            <div className={styles.fields}>
              <fieldset className={styles.formats}>
                <legend>Thumbnail</legend>
                <div className={styles.fields}>
                  <div className={styles.two}>
                    <PixelField label="Width" name="thumbnail_size_w" api={api} />
                    <PixelField label="Height" name="thumbnail_size_h" api={api} />
                  </div>
                  <Checkbox
                    label="Crop thumbnails to exact dimensions"
                    description="Otherwise thumbnails keep the image’s proportions."
                    checked={api.values.thumbnail_crop}
                    onChange={(e) => api.set('thumbnail_crop', e.target.checked)}
                  />
                </div>
              </fieldset>
              <fieldset className={styles.formats}>
                <legend>Medium (largest width and height)</legend>
                <div className={styles.two}>
                  <PixelField label="Maximum width" name="medium_size_w" api={api} />
                  <PixelField label="Maximum height" name="medium_size_h" api={api} />
                </div>
              </fieldset>
              <fieldset className={styles.formats}>
                <legend>Large (largest width and height)</legend>
                <div className={styles.two}>
                  <PixelField label="Maximum width" name="large_size_w" api={api} />
                  <PixelField label="Maximum height" name="large_size_h" api={api} />
                </div>
              </fieldset>
            </div>
          </Card>
          <Card title="Uploading files">
            <Checkbox
              label="Organize uploads into month- and year-based folders"
              description="For example, wp-content/uploads/2026/10/photo.jpg."
              checked={api.values.uploads_use_yearmonth_folders}
              onChange={(e) => api.set('uploads_use_yearmonth_folders', e.target.checked)}
            />
          </Card>
        </>
      )}
    </SettingsForm>
  );
}
