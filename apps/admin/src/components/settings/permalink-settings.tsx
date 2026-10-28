'use client';

import { useState } from 'react';
import {
  exampleBase,
  examplePermalink,
  PERMALINK_PRESETS,
  type PresetKey,
  presetFor,
  STRUCTURE_TAGS,
  toggleTag,
} from '@/lib/permalinks';
import { TextField } from '../ui/field';
import { Card } from '../ui/surface';
import styles from './settings.module.css';
import { type FieldApi, SettingsForm } from './settings-form';

export interface PermalinkSettings extends Record<string, unknown> {
  permalink_structure: string;
  category_base: string;
  tag_base: string;
}

function StructureChoice({ api, home }: { api: FieldApi<PermalinkSettings>; home: string }) {
  const value = api.values.permalink_structure;
  const selected = presetFor(value);
  // The custom radio stays chosen while its text matches a preset, as in WordPress.
  const [customChosen, setCustomChosen] = useState(selected === 'custom');
  const choice: PresetKey | 'custom' = customChosen ? 'custom' : selected;
  const error = api.errors.permalink_structure;

  const choose = (key: PresetKey | 'custom') => {
    setCustomChosen(key === 'custom');
    if (key !== 'custom') {
      api.set('permalink_structure', PERMALINK_PRESETS.find((p) => p.key === key)?.structure ?? '');
    }
  };

  return (
    <fieldset className={styles.formats}>
      <legend>Permalink structure</legend>
      {PERMALINK_PRESETS.map((preset) => (
        <label key={preset.key} className={styles.format}>
          <input
            type="radio"
            name="selection"
            checked={choice === preset.key}
            onChange={() => choose(preset.key)}
          />
          <span>{preset.label}</span>
          <code className={styles.example}>{examplePermalink(home, preset.structure)}</code>
        </label>
      ))}
      <label className={styles.format}>
        <input
          type="radio"
          name="selection"
          checked={choice === 'custom'}
          onChange={() => choose('custom')}
        />
        <span>Custom structure</span>
        <code className={styles.example}>
          {choice === 'custom' && value ? examplePermalink(home, value) : ''}
        </code>
      </label>
      {choice === 'custom' && (
        <div className={`${styles.nested} ${styles.fields}`}>
          <div className={styles.mono}>
            <TextField
              label="Custom structure"
              hint="For example /%category%/%postname%/. The buttons below add and remove tags."
              value={value}
              onChange={(e) => api.set('permalink_structure', e.target.value)}
              error={error}
              spellCheck={false}
            />
          </div>
          <div>
            <p id="available-tags" className={styles.preview}>
              Available tags:
            </p>
            <ul className={styles.tags} aria-labelledby="available-tags">
              {STRUCTURE_TAGS.map(({ tag, label }) => {
                const used = value.includes(tag);
                return (
                  <li key={tag}>
                    <button
                      type="button"
                      className={styles.tag}
                      aria-pressed={used}
                      title={label}
                      aria-label={`${tag}: ${label}`}
                      onClick={() => api.set('permalink_structure', toggleTag(value, tag))}
                    >
                      {tag}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      {choice !== 'custom' && error && <p className={styles.preview}>{error}</p>}
    </fieldset>
  );
}

/** Settings → Permalinks, as in WordPress's options-permalink.php. */
export function PermalinkSettingsForm({
  initial,
  home,
}: {
  initial: PermalinkSettings;
  home: string;
}) {
  return (
    <SettingsForm initial={initial} endpoint="/pressbase/v1/permalinks">
      {(api) => (
        <>
          <Card
            title="Common settings"
            description="Choose how addresses of your posts look. Pretty, readable links are easier to share and help search engines. Old post addresses redirect to the new ones."
          >
            <StructureChoice api={api} home={home} />
          </Card>
          <Card
            title="Optional"
            description="Custom bases for category and tag archives, for example topics makes category links like the one shown. Leave blank for the default."
          >
            <div className={`${styles.fields} ${styles.short}`}>
              <TextField
                label="Category base"
                optional
                placeholder="category"
                value={api.values.category_base}
                onChange={(e) => api.set('category_base', e.target.value)}
                error={api.errors.category_base}
                hint={exampleBase(home, api.values.category_base, 'category', 'news')}
                spellCheck={false}
              />
              <TextField
                label="Tag base"
                optional
                placeholder="tag"
                value={api.values.tag_base}
                onChange={(e) => api.set('tag_base', e.target.value)}
                error={api.errors.tag_base}
                hint={exampleBase(home, api.values.tag_base, 'tag', 'travel')}
                spellCheck={false}
              />
            </div>
          </Card>
        </>
      )}
    </SettingsForm>
  );
}
