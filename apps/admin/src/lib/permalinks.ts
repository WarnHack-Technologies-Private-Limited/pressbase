/**
 * Settings → Permalinks helpers (wordpress/wp-admin/options-permalink.php and
 * its tag buttons in wp-admin/js/common.js). Core validates and saves; see
 * /pressbase/v1/permalinks and docs/architecture/public-site.md#permalinks.
 */

export type PresetKey = 'plain' | 'day' | 'month' | 'numeric' | 'postname';

/** The common settings, in options-permalink.php's order. */
export const PERMALINK_PRESETS: { key: PresetKey; label: string; structure: string }[] = [
  { key: 'plain', label: 'Plain', structure: '' },
  { key: 'day', label: 'Day and name', structure: '/%year%/%monthnum%/%day%/%postname%/' },
  { key: 'month', label: 'Month and name', structure: '/%year%/%monthnum%/%postname%/' },
  { key: 'numeric', label: 'Numeric', structure: '/archives/%post_id%' },
  { key: 'postname', label: 'Post name', structure: '/%postname%/' },
];

/** The structure tags, with what each one stands for (the buttons under Custom structure). */
export const STRUCTURE_TAGS: { tag: string; label: string }[] = [
  { tag: '%year%', label: 'The year of the post, four digits, for example 2004.' },
  { tag: '%monthnum%', label: 'Month of the year, for example 05.' },
  { tag: '%day%', label: 'Day of the month, for example 28.' },
  { tag: '%hour%', label: 'Hour of the day, for example 15.' },
  { tag: '%minute%', label: 'Minute of the hour, for example 43.' },
  { tag: '%second%', label: 'Second of the minute, for example 33.' },
  { tag: '%post_id%', label: 'The unique ID of the post, for example 423.' },
  { tag: '%postname%', label: 'The sanitized post title (slug).' },
  {
    tag: '%category%',
    label: 'Category slug. Nested sub-categories appear as nested directories.',
  },
  { tag: '%author%', label: 'A sanitized version of the author name.' },
];

/** Which radio button a saved structure selects. */
export function presetFor(structure: string): PresetKey | 'custom' {
  return PERMALINK_PRESETS.find((p) => p.structure === structure)?.key ?? 'custom';
}

/**
 * A tag button: adds the tag (with the slashes around it) when the structure
 * doesn't have it, removes it when it does, as WordPress's buttons do.
 */
export function toggleTag(structure: string, tag: string): string {
  if (structure.includes(tag)) {
    const without = structure.replace(tag, '').replace(/\/{2,}/g, '/');
    return without === '/' ? '' : without;
  }
  const base = structure === '' ? '/' : structure.endsWith('/') ? structure : `${structure}/`;
  return `${base}${tag}/`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An example address for a structure: what a post called "sample-post" would get. */
export function examplePermalink(home: string, structure: string, date = new Date()): string {
  const root = home.replace(/\/+$/, '');
  if (!structure) return `${root}/?p=123`;
  const path = structure
    .replace(/%year%/g, String(date.getFullYear()))
    .replace(/%monthnum%/g, pad(date.getMonth() + 1))
    .replace(/%day%/g, pad(date.getDate()))
    .replace(/%hour%/g, pad(date.getHours()))
    .replace(/%minute%/g, pad(date.getMinutes()))
    .replace(/%second%/g, pad(date.getSeconds()))
    .replace(/%post_id%/g, '123')
    .replace(/%postname%/g, 'sample-post')
    .replace(/%category%/g, 'uncategorized')
    .replace(/%author%/g, 'admin');
  return `${root}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** An example archive address for a category or tag base ('' for the default). */
export function exampleBase(home: string, base: string, fallback: string, slug: string): string {
  const trimmed = base.trim().replace(/^\/+|\/+$/g, '') || fallback;
  return `${home.replace(/\/+$/, '')}/${trimmed}/${slug}/`;
}
