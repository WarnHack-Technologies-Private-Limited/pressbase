/**
 * Plugins' filters on the posts and pages lists (`PostsListFilter`), as
 * `restrict_manage_posts` adds a dropdown in WordPress. The chosen value is
 * kept in the URL under the filter's `id`, and the filter's `query(value)`
 * turns it into REST parameters for `/wp/v2/{type}`; the plugin reads them
 * on the server with the `rest_{post_type}_query` filter. Framework-free so
 * it can be tested.
 */

import type { FillEntry } from './registry';

export interface ListFilterOption {
  value: string;
  label: string;
}

export type QueryValue = string | number | boolean | (string | number)[];

/** A filter's props, as given to <PostsListFilter>. */
export interface ListFilter {
  /** The URL parameter: lowercase letters, numbers and dashes, prefixed with the plugin's name. */
  id: string;
  label: string;
  options: ListFilterOption[];
  /** REST parameters for a chosen value. */
  query: (value: string) => Record<string, QueryValue>;
}

/** URL and REST parameters a filter may not use: the list's own. */
export const RESERVED_PARAMS = new Set([
  's',
  'status',
  'cat',
  'paged',
  'context',
  'page',
  'per_page',
  'search',
  'orderby',
  'order',
  'categories',
  '_fields',
  '_embed',
]);

const FILTER_ID = /^[a-z][a-z0-9-]*$/;

/** The filters a list shows: well-formed ones, first by id. */
export function listFilters(fills: FillEntry[]): (ListFilter & { owner: string | null })[] {
  const seen = new Set<string>();
  const out: (ListFilter & { owner: string | null })[] = [];
  for (const fill of fills) {
    const { id, label, options, query } = fill.props as Partial<ListFilter>;
    if (
      typeof id !== 'string' ||
      !FILTER_ID.test(id) ||
      RESERVED_PARAMS.has(id) ||
      seen.has(id) ||
      typeof label !== 'string' ||
      !Array.isArray(options) ||
      typeof query !== 'function'
    ) {
      continue;
    }
    seen.add(id);
    out.push({ id, label, options, query, owner: fill.owner });
  }
  return out;
}

/**
 * The REST parameters for the chosen filter values. A value that isn't one
 * of the filter's options, a `query` that throws, and reserved parameters are
 * left out (reported through `onError`).
 */
export function filterQuery(
  filters: ListFilter[],
  values: (id: string) => string | null,
  onError: (filter: ListFilter, error: unknown) => void = () => {},
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const filter of filters) {
    const value = values(filter.id);
    if (!value || !filter.options.some((option) => option.value === value)) continue;
    let query: Record<string, QueryValue>;
    try {
      query = filter.query(value);
    } catch (error) {
      onError(filter, error);
      continue;
    }
    for (const [key, raw] of Object.entries(query ?? {})) {
      if (RESERVED_PARAMS.has(key)) {
        onError(filter, new Error(`"${key}" is the list's own parameter.`));
        continue;
      }
      params[key] = Array.isArray(raw) ? raw.join(',') : String(raw);
    }
  }
  return params;
}
