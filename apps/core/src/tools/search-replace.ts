import { blockDelimiterPattern, serializeBlockAttributes } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, asc, eq, gt, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { PURGE_ACTION } from '../cache/invalidation';
import { CacheTag } from '../cache/tags';
import type { Kernel } from '../kernel';

/**
 * Search and replace across the content tables — what `wp search-replace`
 * does (wp-cli/search-replace-command), for moving a site to a new address.
 *
 * WordPress stores PHP-serialized strings, so wp-cli unserializes, replaces
 * and serializes again to keep string lengths right. Pressbase's equivalent
 * is JSON, in three places, and each is replaced *inside* the JSON so it
 * stays valid whatever the replacement contains (quotes, backslashes, `<`):
 *
 * - option and meta values are JSONB: every string in them is replaced;
 * - text that is itself a JSON document (a string option holding JSON) is
 *   decoded, replaced and encoded again;
 * - block attributes in post content (`<!-- wp:image {"url":"…"} -->`) are
 *   decoded, replaced and serialised as WordPress does
 *   (serialize_block_attributes()); the HTML around them is plain text.
 *
 * Object keys are never changed, as in wp-cli. Changed options go through
 * the Options API (so caches and hooks see them); other rows are updated
 * directly, as wp-cli does. Every cached public page is purged afterwards.
 */

export interface SearchReplaceColumn {
  /** Pressbase's table. */
  table: string;
  /** WordPress's column name, used by --include-columns and in the report. */
  column: string;
  json: boolean;
}

interface ColumnDef extends SearchReplaceColumn {
  source: PgTable;
  id: PgColumn;
  value: PgColumn;
}

const COLUMNS: ColumnDef[] = [
  {
    table: 'posts',
    column: 'post_title',
    json: false,
    source: schema.posts,
    id: schema.posts.id,
    value: schema.posts.title,
  },
  {
    table: 'posts',
    column: 'post_content',
    json: false,
    source: schema.posts,
    id: schema.posts.id,
    value: schema.posts.content,
  },
  {
    table: 'posts',
    column: 'post_excerpt',
    json: false,
    source: schema.posts,
    id: schema.posts.id,
    value: schema.posts.excerpt,
  },
  {
    table: 'posts',
    column: 'guid',
    json: false,
    source: schema.posts,
    id: schema.posts.id,
    value: schema.posts.guid,
  },
  {
    table: 'postmeta',
    column: 'meta_value',
    json: true,
    source: schema.postmeta,
    id: schema.postmeta.id,
    value: schema.postmeta.value,
  },
  {
    table: 'options',
    column: 'option_value',
    json: true,
    source: schema.options,
    id: schema.options.id,
    value: schema.options.value,
  },
  {
    table: 'comments',
    column: 'comment_content',
    json: false,
    source: schema.comments,
    id: schema.comments.id,
    value: schema.comments.content,
  },
  {
    table: 'comments',
    column: 'comment_author_url',
    json: false,
    source: schema.comments,
    id: schema.comments.id,
    value: schema.comments.authorUrl,
  },
  {
    table: 'commentmeta',
    column: 'meta_value',
    json: true,
    source: schema.commentmeta,
    id: schema.commentmeta.id,
    value: schema.commentmeta.value,
  },
];

/** The tables and columns search-replace covers, in report order. */
export const SEARCH_REPLACE_COLUMNS: readonly SearchReplaceColumn[] = COLUMNS.map(
  ({ table, column, json }) => ({ table, column, json }),
);

export interface SearchReplaceOptions {
  search: string;
  replace: string;
  /** Count only; change nothing. */
  dryRun?: boolean;
  /** Treat `search` as a JavaScript regular expression; `replace` may use $1… */
  regex?: boolean;
  /** Flags for `regex` (`i`, `m`, `s`, `u`); `g` is always on. */
  regexFlags?: string;
  /** Only these tables (`posts`, `postmeta`, `options`, `comments`, `commentmeta`; a `wp_` prefix is ignored). */
  tables?: string[];
  /** Only these columns (WordPress names: post_content, guid, option_value…). */
  includeColumns?: string[];
  /** Never these columns. */
  skipColumns?: string[];
}

export interface SearchReplaceRow {
  table: string;
  column: string;
  /** Occurrences replaced (or that would be, on a dry run). */
  replacements: number;
  /** Rows changed. */
  rows: number;
}

export interface SearchReplaceReport {
  rows: SearchReplaceRow[];
  total: number;
}

export class SearchReplaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Replacer = (text: string) => { text: string; count: number };

function makeReplacer(options: SearchReplaceOptions): Replacer {
  if (options.regex) {
    let pattern: RegExp;
    try {
      const flags = new Set(`${options.regexFlags ?? ''}g`.split(''));
      pattern = new RegExp(options.search, [...flags].join(''));
    } catch (error) {
      throw new SearchReplaceError(
        'pressbase_invalid_regex',
        `That regular expression isn’t valid: ${(error as Error).message}`,
      );
    }
    return (text) => {
      const count = text.match(pattern)?.length ?? 0;
      return count ? { text: text.replace(pattern, options.replace), count } : { text, count: 0 };
    };
  }
  const { search, replace } = options;
  return (text) => {
    if (!text.includes(search)) return { text, count: 0 };
    const parts = text.split(search);
    return { text: parts.join(replace), count: parts.length - 1 };
  };
}

const MAX_DEPTH = 64;

/** Replaces inside any JSON value: every string, recursively. Keys stay. */
function replaceInJson(
  value: unknown,
  replacer: Replacer,
  depth = 0,
): { value: unknown; count: number } {
  if (depth > MAX_DEPTH) return { value, count: 0 };
  if (typeof value === 'string') {
    const r = replaceInText(value, replacer, depth + 1);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const r = replaceInJson(item, replacer, depth + 1);
      count += r.count;
      return r.value;
    });
    return { value: count ? out : value, count };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = replaceInJson(item, replacer, depth + 1);
      count += r.count;
      out[key] = r.value;
    }
    return { value: count ? out : value, count };
  }
  return { value, count: 0 };
}

/** A string holding a JSON object or array, decoded; undefined otherwise. */
function asJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces in a text value: a whole JSON document is replaced inside;
 * otherwise block attributes are, and the rest is plain text.
 */
function replaceInText(
  text: string,
  replacer: Replacer,
  depth = 0,
): { text: string; count: number } {
  const doc = asJsonDocument(text);
  if (doc !== undefined) {
    const r = replaceInJson(doc, replacer, depth + 1);
    return r.count ? { text: JSON.stringify(r.value), count: r.count } : { text, count: 0 };
  }
  if (!text.includes('<!-- wp:')) return replacer(text);

  // Block delimiters: replace inside their attributes; plain text between them.
  let count = 0;
  let out = '';
  let last = 0;
  const pattern = blockDelimiterPattern();
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const before = replacer(text.slice(last, match.index));
    out += before.text;
    count += before.count;
    const whole = match[0];
    const attrs = match[4];
    let delimiter = whole;
    if (attrs) {
      try {
        const parsed = JSON.parse(attrs);
        const r = replaceInJson(parsed, replacer, depth + 1);
        if (r.count) {
          delimiter = whole.replace(
            attrs,
            // The group includes the whitespace before -->; keep it. (A function, so `$` stays literal.)
            () =>
              serializeBlockAttributes(r.value as Record<string, unknown>) +
              attrs.slice(attrs.trimEnd().length),
          );
          count += r.count;
        }
      } catch {
        // Attributes WordPress couldn't parse either: leave the delimiter alone.
      }
    }
    out += delimiter;
    last = match.index + whole.length;
  }
  const rest = replacer(text.slice(last));
  return { text: out + rest.text, count: count + rest.count };
}

/** The forms `search` can take inside stored JSON, for the database-side pre-filter. */
function variants(search: string): string[] {
  const json = (s: string) => JSON.stringify(s).slice(1, -1);
  // {"a":"…"} → the escaped text between the quotes.
  const block = (s: string) => serializeBlockAttributes({ a: s }).slice(6, -2);
  return [...new Set([search, json(search), json(json(search)), block(search)])].filter(Boolean);
}

function normaliseTable(name: string): string {
  return name.replace(/^wp_/, '');
}

function selectedColumns(options: SearchReplaceOptions): ColumnDef[] {
  const tables = options.tables?.map(normaliseTable);
  const known = new Set(COLUMNS.map((c) => c.table));
  for (const table of tables ?? []) {
    if (!known.has(table)) {
      throw new SearchReplaceError(
        'pressbase_unknown_table',
        `There’s no table called "${table}" to search. Choose from: ${[...known].join(', ')}.`,
      );
    }
  }
  const columns = new Set(COLUMNS.map((c) => c.column));
  for (const column of [...(options.includeColumns ?? []), ...(options.skipColumns ?? [])]) {
    if (!columns.has(column)) {
      throw new SearchReplaceError(
        'pressbase_unknown_column',
        `There’s no column called "${column}" to search. Choose from: ${[...columns].join(', ')}.`,
      );
    }
  }
  return COLUMNS.filter(
    (c) =>
      (!tables || tables.includes(c.table)) &&
      (!options.includeColumns?.length || options.includeColumns.includes(c.column)) &&
      !options.skipColumns?.includes(c.column),
  );
}

const BATCH = 500;

/** Runs a search and replace and reports what changed (or would change). */
export async function searchReplace(
  kernel: Kernel,
  options: SearchReplaceOptions,
): Promise<SearchReplaceReport> {
  if (!options.search) {
    throw new SearchReplaceError('pressbase_empty_search', 'Give a value to search for.');
  }
  const replacer = makeReplacer(options);
  const columns = selectedColumns(options);
  const forms = options.regex ? [] : variants(options.search);
  const rows: SearchReplaceRow[] = [];
  let changedSomething = false;

  for (const def of columns) {
    const row: SearchReplaceRow = {
      table: def.table,
      column: def.column,
      replacements: 0,
      rows: 0,
    };
    const asText = def.json ? sql`${def.value}::text` : sql`${def.value}`;
    // Regular expressions are matched in JavaScript, so every row is read.
    const filter: SQL | undefined = forms.length
      ? or(...forms.map((form) => sql`strpos(${asText}, ${form}) > 0`))
      : undefined;
    let lastId = 0;
    for (;;) {
      const batch = (await kernel.db
        .select({ id: def.id, value: def.value })
        .from(def.source)
        .where(and(gt(def.id, lastId), filter))
        .orderBy(asc(def.id))
        .limit(BATCH)) as { id: number; value: unknown }[];
      if (!batch.length) break;
      lastId = batch[batch.length - 1]?.id ?? lastId;
      for (const item of batch) {
        const result = def.json
          ? replaceInJson(item.value, replacer)
          : (() => {
              const r = replaceInText(String(item.value ?? ''), replacer);
              return { value: r.text, count: r.count };
            })();
        if (!result.count) continue;
        row.replacements += result.count;
        row.rows += 1;
        if (options.dryRun) continue;
        changedSomething = true;
        if (def.table === 'options') {
          const [option] = await kernel.db
            .select({ name: schema.options.name })
            .from(schema.options)
            .where(eq(schema.options.id, item.id));
          if (option) await kernel.options.set(option.name, result.value);
        } else {
          await kernel.db
            .update(def.source)
            .set({ [columnKey(def)]: result.value })
            .where(eq(def.id, item.id));
        }
      }
      if (batch.length < BATCH) break;
    }
    rows.push(row);
  }

  if (changedSomething) {
    await kernel.hooks.doAction(PURGE_ACTION, [CacheTag.site], 'search_replace');
  }
  return { rows, total: rows.reduce((n, r) => n + r.replacements, 0) };
}

/** The Drizzle property name of a column (for `.set()`). */
function columnKey(def: ColumnDef): string {
  const table = def.source as unknown as Record<string, unknown>;
  const key = Object.keys(table).find((k) => table[k] === def.value);
  if (!key) throw new Error(`Unknown column ${def.table}.${def.column}`);
  return key;
}
