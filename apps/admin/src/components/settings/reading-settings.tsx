'use client';

import { Checkbox, SelectField, TextField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import styles from './settings.module.css';
import { SettingsForm } from './settings-form';

export interface ReadingSettings extends Record<string, unknown> {
  show_on_front: 'posts' | 'page';
  page_on_front: number;
  page_for_posts: number;
  posts_per_page: number;
  blog_public: boolean;
}

/** Settings → Reading, as in WordPress's options-reading.php. */
export function ReadingSettingsForm({
  initial,
  pages,
}: {
  initial: ReadingSettings;
  pages: { id: number; title: string }[];
}) {
  return (
    <SettingsForm initial={initial}>
      {({ values, set, errors }) => (
        <>
          <Card title="Homepage" description="What visitors see first when they open your site.">
            <div className={styles.fields}>
              <fieldset className={styles.formats}>
                <legend>Your homepage displays</legend>
                <label className={styles.format} style={{ gridTemplateColumns: 'auto 1fr' }}>
                  <input
                    type="radio"
                    name="show_on_front"
                    checked={values.show_on_front === 'posts'}
                    onChange={() => set('show_on_front', 'posts')}
                  />
                  <span>Your latest posts</span>
                </label>
                <label className={styles.format} style={{ gridTemplateColumns: 'auto 1fr' }}>
                  <input
                    type="radio"
                    name="show_on_front"
                    checked={values.show_on_front === 'page'}
                    onChange={() => set('show_on_front', 'page')}
                    disabled={pages.length === 0}
                  />
                  <span>A static page{pages.length === 0 ? ' (publish a page first)' : ''}</span>
                </label>
              </fieldset>
              {values.show_on_front === 'page' && (
                <div className={styles.two}>
                  <SelectField
                    label="Homepage"
                    value={values.page_on_front}
                    onChange={(e) => set('page_on_front', Number(e.target.value))}
                    error={errors.page_on_front}
                  >
                    <option value={0}>— Select —</option>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Posts page"
                    optional
                    value={values.page_for_posts}
                    onChange={(e) => set('page_for_posts', Number(e.target.value))}
                    error={errors.page_for_posts}
                  >
                    <option value={0}>— Select —</option>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </SelectField>
                </div>
              )}
              {values.show_on_front === 'page' &&
                values.page_on_front !== 0 &&
                values.page_on_front === values.page_for_posts && (
                  <Notice
                    tone="warning"
                    title="The homepage and posts page should be different pages."
                  />
                )}
              <TextField
                label="Blog pages show at most"
                type="number"
                min={1}
                max={100}
                value={values.posts_per_page}
                onChange={(e) => set('posts_per_page', Number(e.target.value))}
                error={errors.posts_per_page}
                hint="Posts per page, from 1 to 100."
                style={{ maxWidth: '8rem' }}
              />
            </div>
          </Card>

          <Card title="Search engine visibility">
            <Checkbox
              label="Ask search engines not to index this site"
              description="It’s up to search engines to honour this request."
              checked={!values.blog_public}
              onChange={(e) => set('blog_public', !e.target.checked)}
            />
          </Card>
        </>
      )}
    </SettingsForm>
  );
}
