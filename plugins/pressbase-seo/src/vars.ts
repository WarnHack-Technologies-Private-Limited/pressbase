/**
 * Yoast's title variables (`%%title%% %%sep%% %%sitename%%`), replaced the
 * way WPSEO_Replace_Vars does: known variables become their value, unknown
 * ones are removed, then spaces are collapsed and stray separators at the
 * ends are dropped. Shared by the server and the editor's live preview.
 */

export interface VarValues {
  title?: string;
  sitename?: string;
  sitedesc?: string;
  sep?: string;
  excerpt?: string;
  excerpt_only?: string;
  category?: string;
  primary_category?: string;
  tag?: string;
  term_title?: string;
  term_description?: string;
  category_description?: string;
  tag_description?: string;
  /** "Page 2 of 5" on later pages, else empty. */
  page?: string;
  pagenumber?: string;
  pagetotal?: string;
  date?: string;
  modified?: string;
  name?: string;
  user_description?: string;
  searchphrase?: string;
  pt_single?: string;
  pt_plural?: string;
  focuskw?: string;
  id?: string;
  parent_title?: string;
  archive_title?: string;
  currentyear?: string;
  currentmonth?: string;
  currentday?: string;
  currentdate?: string;
  [name: string]: string | undefined;
}

/** The variables offered as chips in the editor and settings, in a sensible order. */
export const COMMON_VARS = [
  'title',
  'sitename',
  'sep',
  'page',
  'excerpt',
  'primary_category',
  'sitedesc',
  'focuskw',
] as const;

const VAR = /%%([a-z0-9_]+)%%/gi;

export function replaceVars(template: string, values: VarValues): string {
  if (!template) return '';
  // Aliases Yoast accepts.
  const all: VarValues = {
    ...values,
    category: values.category ?? values.primary_category,
    term_title: values.term_title ?? values.title,
  };
  const replaced = template.replace(VAR, (_, name: string) => {
    const value = all[name.toLowerCase()];
    return value === undefined ? '' : value;
  });
  return cleanup(replaced, values.sep ?? '-');
}

/** Collapses whitespace and removes separators left dangling at the ends or doubled. */
export function cleanup(text: string, sep: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  if (!sep) return out;
  const s = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  out = out.replace(new RegExp(`(?:\\s*${s}\\s*){2,}`, 'g'), ` ${sep} `);
  out = out.replace(new RegExp(`^(?:${s}\\s*)+`), '').replace(new RegExp(`(?:\\s*${s})+$`), '');
  return out.trim();
}

/**
 * Rank Math's `%title%` syntax to Yoast's `%%title%%`, with the variables
 * whose names differ mapped across (unknown ones keep their name).
 */
const RANK_MATH_NAMES: Record<string, string> = {
  title: 'title',
  sep: 'sep',
  sitename: 'sitename',
  sitedesc: 'sitedesc',
  excerpt: 'excerpt',
  excerpt_only: 'excerpt_only',
  category: 'category',
  primary_category: 'primary_category',
  tag: 'tag',
  term: 'term_title',
  term_description: 'term_description',
  page: 'page',
  pagenumber: 'pagenumber',
  pagetotal: 'pagetotal',
  date: 'date',
  modified: 'modified',
  name: 'name',
  user_description: 'user_description',
  search_query: 'searchphrase',
  pt_single: 'pt_single',
  pt_plural: 'pt_plural',
  focuskw: 'focuskw',
  keywords: 'focuskw',
  id: 'id',
  parent_title: 'parent_title',
  currentyear: 'currentyear',
  currentmonth: 'currentmonth',
  currentday: 'currentday',
  currentdate: 'currentdate',
};

export function rankMathToYoast(template: string): string {
  return template.replace(/%([a-z_]+)(?:\([^)]*\))?%/gi, (_, name: string) => {
    const key = name.toLowerCase();
    return `%%${RANK_MATH_NAMES[key] ?? key}%%`;
  });
}

/**
 * All in One SEO's `#post_title` tags to Yoast variables. AIOSEO 4 stores
 * them in its own table (`wp_aioseo_posts`); its older post meta
 * (`_aioseo_title`) used the same tags.
 */
const AIOSEO_TAGS: Record<string, string> = {
  post_title: 'title',
  site_title: 'sitename',
  tagline: 'sitedesc',
  separator_sa: 'sep',
  post_excerpt: 'excerpt',
  post_excerpt_only: 'excerpt_only',
  categories: 'category',
  taxonomy_title: 'term_title',
  taxonomy_description: 'term_description',
  author_name: 'name',
  author_bio: 'user_description',
  post_date: 'date',
  current_year: 'currentyear',
  current_month: 'currentmonth',
  current_day: 'currentday',
  current_date: 'currentdate',
  page_number: 'pagenumber',
  search_term: 'searchphrase',
  parent_title: 'parent_title',
  post_type_singular_name: 'pt_single',
};

export function aioseoToYoast(template: string): string {
  return template.replace(/#([a-z_]+)/gi, (match, name: string) => {
    const key = AIOSEO_TAGS[name.toLowerCase()];
    return key ? `%%${key}%%` : match;
  });
}
