'use client';

import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/field';
import { Card } from '../ui/surface';
import styles from './settings.module.css';
import { type FieldApi, SettingsForm } from './settings-form';

export interface DiscussionSettings extends Record<string, unknown> {
  default_comment_status: 'open' | 'closed';
  require_name_email: boolean;
  comment_registration: boolean;
  close_comments_for_old_posts: boolean;
  close_comments_days_old: number;
  thread_comments: boolean;
  thread_comments_depth: number;
  page_comments: boolean;
  comments_per_page: number;
  default_comments_page: 'newest' | 'oldest';
  comment_order: 'asc' | 'desc';
  comments_notify: boolean;
  moderation_notify: boolean;
  comment_moderation: boolean;
  comment_previously_approved: boolean;
  comment_max_links: number;
  moderation_keys: string;
  disallowed_keys: string;
  show_avatars: boolean;
  avatar_rating: 'G' | 'PG' | 'R' | 'X';
  avatar_default: string;
}

const RATINGS = [
  { value: 'G', label: 'G — suitable for all audiences' },
  { value: 'PG', label: 'PG — possibly offensive, usually for audiences 13 and above' },
  { value: 'R', label: 'R — intended for adult audiences above 17' },
  { value: 'X', label: 'X — even more mature than above' },
];

const DEFAULT_AVATARS = [
  { value: 'mystery', label: 'Mystery person' },
  { value: 'blank', label: 'Blank' },
  { value: 'gravatar_default', label: 'Gravatar logo' },
  { value: 'identicon', label: 'Identicon (generated)' },
  { value: 'wavatar', label: 'Wavatar (generated)' },
  { value: 'monsterid', label: 'MonsterID (generated)' },
  { value: 'retro', label: 'Retro (generated)' },
  { value: 'robohash', label: 'RoboHash (generated)' },
];

function NumberField({
  label,
  name,
  api,
  min,
  max,
  hint,
}: {
  label: string;
  name: 'close_comments_days_old' | 'comments_per_page' | 'comment_max_links';
  api: FieldApi<DiscussionSettings>;
  min: number;
  max: number;
  hint?: string;
}) {
  const value = api.values[name];
  return (
    <div className={styles.short}>
      <TextField
        label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => api.set(name, e.target.valueAsNumber)}
        error={api.errors[name]}
        hint={hint}
      />
    </div>
  );
}

/** Settings → Discussion, as in WordPress's options-discussion.php. */
export function DiscussionSettingsForm({ initial }: { initial: DiscussionSettings }) {
  return (
    <SettingsForm initial={initial}>
      {(api) => {
        const { values, set, errors } = api;
        return (
          <>
            <Card
              title="Defaults for new posts"
              description="Each post can change this in the editor."
            >
              <Checkbox
                label="Allow people to submit comments on new posts"
                checked={values.default_comment_status === 'open'}
                onChange={(e) =>
                  set('default_comment_status', e.target.checked ? 'open' : 'closed')
                }
              />
            </Card>

            <Card title="Other comment settings">
              <div className={styles.fields}>
                <Checkbox
                  label="Comment author must fill out name and email"
                  checked={values.require_name_email}
                  onChange={(e) => set('require_name_email', e.target.checked)}
                />
                <Checkbox
                  label="Users must be registered and logged in to comment"
                  checked={values.comment_registration}
                  onChange={(e) => set('comment_registration', e.target.checked)}
                />
                <Checkbox
                  label="Automatically close comments on old posts"
                  description="Pages aren’t affected."
                  checked={values.close_comments_for_old_posts}
                  onChange={(e) => set('close_comments_for_old_posts', e.target.checked)}
                />
                {values.close_comments_for_old_posts && (
                  <div className={styles.nested}>
                    <NumberField
                      label="Close comments when a post is older than (days)"
                      name="close_comments_days_old"
                      api={api}
                      min={1}
                      max={36500}
                    />
                  </div>
                )}
                <Checkbox
                  label="Enable threaded (nested) comments"
                  description="Readers can reply to a comment, not just the post."
                  checked={values.thread_comments}
                  onChange={(e) => set('thread_comments', e.target.checked)}
                />
                {values.thread_comments && (
                  <div className={`${styles.nested} ${styles.short}`}>
                    <SelectField
                      label="Nest replies up to"
                      value={values.thread_comments_depth}
                      onChange={(e) => set('thread_comments_depth', Number(e.target.value))}
                      error={errors.thread_comments_depth}
                    >
                      {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                        <option key={n} value={n}>
                          {n} levels deep
                        </option>
                      ))}
                    </SelectField>
                  </div>
                )}
                <Checkbox
                  label="Break comments into pages"
                  checked={values.page_comments}
                  onChange={(e) => set('page_comments', e.target.checked)}
                />
                {values.page_comments && (
                  <div className={`${styles.nested} ${styles.two}`}>
                    <NumberField
                      label={
                        values.thread_comments ? 'Top-level comments per page' : 'Comments per page'
                      }
                      name="comments_per_page"
                      api={api}
                      min={1}
                      max={1000}
                    />
                    <SelectField
                      label="Show first"
                      value={values.default_comments_page}
                      onChange={(e) =>
                        set('default_comments_page', e.target.value as 'newest' | 'oldest')
                      }
                    >
                      <option value="newest">The last page</option>
                      <option value="oldest">The first page</option>
                    </SelectField>
                  </div>
                )}
                <SelectField
                  label="Order of comments on each page"
                  value={values.comment_order}
                  onChange={(e) => set('comment_order', e.target.value as 'asc' | 'desc')}
                >
                  <option value="asc">Older comments first</option>
                  <option value="desc">Newer comments first</option>
                </SelectField>
              </div>
            </Card>

            <Card
              title="Email me whenever"
              description="Emails go to the site’s administration email and, where it fits, the post’s author."
            >
              <div className={styles.fields}>
                <Checkbox
                  label="Anyone posts a comment"
                  checked={values.comments_notify}
                  onChange={(e) => set('comments_notify', e.target.checked)}
                />
                <Checkbox
                  label="A comment is held for moderation"
                  checked={values.moderation_notify}
                  onChange={(e) => set('moderation_notify', e.target.checked)}
                />
              </div>
            </Card>

            <Card
              title="Before a comment appears"
              description="Comments that need approval wait in Comments → Pending."
            >
              <div className={styles.fields}>
                <Checkbox
                  label="Comment must be manually approved"
                  checked={values.comment_moderation}
                  onChange={(e) => set('comment_moderation', e.target.checked)}
                />
                <Checkbox
                  label="Comment author must have a previously approved comment"
                  description="First-time commenters wait for approval; after that, they’re trusted."
                  checked={values.comment_previously_approved}
                  disabled={values.comment_moderation}
                  onChange={(e) => set('comment_previously_approved', e.target.checked)}
                />
              </div>
            </Card>

            <Card
              title="Comment moderation"
              description="Hold comments that look suspicious, so you can review them first."
            >
              <div className={styles.fields}>
                <NumberField
                  label="Hold a comment with this many links or more"
                  name="comment_max_links"
                  api={api}
                  min={0}
                  max={1000}
                  hint="A common sign of spam. 0 turns this check off."
                />
                <TextAreaField
                  label="Hold comments containing"
                  value={values.moderation_keys}
                  onChange={(e) => set('moderation_keys', e.target.value)}
                  rows={5}
                  optional
                  error={errors.moderation_keys}
                  hint="One word, name, email, URL or IP address per line. Parts of words match too: “press” matches “WordPress”."
                  spellCheck={false}
                />
              </div>
            </Card>

            <Card
              title="Disallowed comment keys"
              description="Comments matching these go straight to Spam."
            >
              <TextAreaField
                label="Send to spam comments containing"
                value={values.disallowed_keys}
                onChange={(e) => set('disallowed_keys', e.target.value)}
                rows={5}
                optional
                error={errors.disallowed_keys}
                hint="One word, name, email, URL or IP address per line. Markup is ignored, so hidden words are caught too."
                spellCheck={false}
              />
            </Card>

            <Card
              title="Avatars"
              description="Pictures next to commenters’ names on your site, from Gravatar."
            >
              <div className={styles.fields}>
                <Checkbox
                  label="Show avatars"
                  description="Each commenter’s email address is sent to Gravatar, in hashed form, to find their picture."
                  checked={values.show_avatars}
                  onChange={(e) => set('show_avatars', e.target.checked)}
                />
                {values.show_avatars && (
                  <>
                    <SelectField
                      label="Maximum rating"
                      value={values.avatar_rating}
                      onChange={(e) =>
                        set('avatar_rating', e.target.value as DiscussionSettings['avatar_rating'])
                      }
                    >
                      {RATINGS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="Default avatar"
                      hint="For people without a Gravatar of their own."
                      value={values.avatar_default}
                      onChange={(e) => set('avatar_default', e.target.value)}
                    >
                      {DEFAULT_AVATARS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </SelectField>
                  </>
                )}
              </div>
            </Card>
          </>
        );
      }}
    </SettingsForm>
  );
}
