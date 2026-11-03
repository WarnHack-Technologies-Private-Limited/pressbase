import { AsyncLocalStorage } from 'node:async_hooks';
import type { GlobalStylesConfig } from '@pressbase/theme-json';
import type { CurrentUser } from '../auth/users';
import type { Post } from '../content/posts';
import type { QueryArgs } from '../content/query';

/**
 * The preview overlay of a changeset (v0.8, ADR 0022): what
 * WP_Customize_Setting::preview() does with filters for each setting, held
 * in request-scoped state instead.
 *
 * While a page renders with `?changeset_uuid=`, the content layer asks this
 * overlay before answering:
 *
 * - `kernel.posts.get()` returns the changed post, or a post the changeset
 *   creates (negative IDs);
 * - `queryPosts()` swaps changed posts into its results, drops those that no
 *   longer match, and adds those that now do (see previewQueryRows());
 * - the main query's singular lookups (by path or slug) go through
 *   previewPost();
 * - options on the changeset allow-list answer from `pre_option_{name}`;
 * - the global styles render through `RenderRequest.theme`.
 *
 * Nothing is written, and nothing outside the render sees the overlay.
 */

/** A post the changeset creates on publish, as a preview shows it. */
export interface CreatedPost {
  post: Post;
  /** Term slugs by taxonomy, so `tax_query` lookups (a template's theme) can find it. */
  terms: Record<string, string[]>;
}

export class ChangesetPreview {
  /** Changed posts, by ID, with the changes applied. */
  readonly posts = new Map<number, Post>();
  /** Posts the changeset creates, by their (negative) preview IDs. */
  readonly created = new Map<number, CreatedPost>();
  /** Options on the allow-list, as the changeset sets them. */
  readonly options = new Map<string, unknown>();
  /** The active theme's user global styles, when the changeset changes them. */
  globalStyles: GlobalStylesConfig | undefined;
  /** False once the render is over, so continuations that outlive it don't see it. */
  active = true;
  #nextId = -1;

  constructor(
    readonly changeset: Post,
    readonly user: CurrentUser,
  ) {}

  /** The changeset's UUID (its slug). */
  get uuid(): string {
    return this.changeset.slug;
  }

  /** An ID for a post that doesn't exist yet. */
  nextId(): number {
    return this.#nextId--;
  }

  /** Whether the overlay has posts of these types (`any` matches all). */
  hasPostsOf(types: string[]): boolean {
    const all = types.includes('any');
    for (const post of this.posts.values()) if (all || types.includes(post.type)) return true;
    for (const { post } of this.created.values()) if (all || types.includes(post.type)) return true;
    return false;
  }
}

const storage = new AsyncLocalStorage<ChangesetPreview>();

/** The changeset preview the current render shows, if any. */
export function currentChangesetPreview(): ChangesetPreview | undefined {
  const preview = storage.getStore();
  return preview?.active ? preview : undefined;
}

/** Runs `fn` with the overlay in place. */
export async function withChangesetPreview<T>(
  preview: ChangesetPreview,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await storage.run(preview, fn);
  } finally {
    preview.active = false;
  }
}

/** Runs `fn` without the overlay: work that writes (a scheduled publish) must see the database. */
export function outsideChangesetPreview<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}

/**
 * A post as the preview shows it: changed, or created by the changeset (a
 * negative `id` that the database didn't find). Outside a preview, the post.
 */
export function previewPost(post: Post | undefined, id?: number): Post | undefined {
  const preview = currentChangesetPreview();
  if (!preview) return post;
  if (post) return preview.posts.get(post.id) ?? post;
  return id !== undefined && id < 0 ? preview.created.get(id)?.post : undefined;
}

const list = <T>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** Query arguments previewQueryRows() can evaluate in memory. */
const EVALUATED = new Set<keyof QueryArgs>([
  'post_type',
  'post_status',
  'p',
  'post__in',
  'post__not_in',
  'name',
  'post_name__in',
  'post_parent',
  'tax_query',
  'orderby',
  'order',
  'posts_per_page',
  'paged',
  'offset',
  'no_found_rows',
]);

/**
 * Whether a post matches the query: true or false, or undefined when the
 * query asks something only the database can answer (a search, meta, terms
 * of a post that exists).
 */
function matches(
  post: Post,
  args: QueryArgs,
  terms?: Record<string, string[]>,
): boolean | undefined {
  const types = list(args.post_type) ?? ['post'];
  if (!types.includes('any') && !types.includes(post.type)) return false;
  const statuses = list(args.post_status) ?? ['publish'];
  if (statuses.includes('any')) {
    if (['trash', 'auto-draft', 'inherit'].includes(post.status)) return false;
  } else if (!statuses.includes(post.status)) return false;
  if (args.p !== undefined && post.id !== args.p) return false;
  if (args.post__in && !args.post__in.includes(post.id)) return false;
  if (args.post__not_in?.includes(post.id)) return false;
  if (args.name !== undefined && post.slug !== args.name) return false;
  if (args.post_name__in?.length && !args.post_name__in.includes(post.slug)) return false;
  if (args.post_parent !== undefined) {
    if ((post.parentId ?? 0) !== args.post_parent) return false;
  }
  let unknown = false;
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !EVALUATED.has(key as keyof QueryArgs)) unknown = true;
  }
  for (const clause of args.tax_query ?? []) {
    if (!clause.terms.length) continue;
    const own = terms?.[clause.taxonomy];
    if (!own || (clause.field ?? 'term_id') !== 'slug') {
      unknown = true;
      continue;
    }
    const wanted = clause.terms.map(String);
    const operator = clause.operator ?? 'IN';
    const ok =
      operator === 'NOT IN'
        ? !wanted.some((t) => own.includes(t))
        : operator === 'AND'
          ? wanted.every((t) => own.includes(t))
          : wanted.some((t) => own.includes(t));
    if (!ok) return false;
  }
  return unknown ? undefined : true;
}

const ORDER_FIELDS: Partial<Record<string, (p: Post) => number | string>> = {
  date: (p) => p.date.getTime(),
  modified: (p) => p.modified.getTime(),
  title: (p) => p.title,
  name: (p) => p.slug,
  id: (p) => p.id,
  menu_order: (p) => p.menuOrder,
};

/**
 * queryPosts() under a preview: changed posts replace their rows (and leave
 * when they no longer match), and changed or created posts that now match
 * join the results — when the query can be evaluated in memory and the page
 * of results has room. Returns the rows and how `found` changes.
 */
export function previewQueryRows(
  args: QueryArgs,
  rows: Post[],
  perPage: number,
): { rows: Post[]; delta: number } {
  const preview = currentChangesetPreview();
  const types = list(args.post_type) ?? ['post'];
  if (!preview?.hasPostsOf(types)) return { rows, delta: 0 };

  const seen = new Set(rows.map((r) => r.id));
  const kept = rows
    .map((row) => preview.posts.get(row.id) ?? row)
    .filter((row) => !preview.posts.has(row.id) || matches(row, args) !== false);
  let delta = kept.length - rows.length;

  const room = perPage === -1 || rows.length < perPage;
  if (!room) return { rows: kept, delta };
  const joining: Post[] = [];
  for (const post of preview.posts.values()) {
    if (!seen.has(post.id) && matches(post, args) === true) joining.push(post);
  }
  for (const { post, terms } of preview.created.values()) {
    if (matches(post, args, terms) === true) joining.push(post);
  }
  if (!joining.length) return { rows: kept, delta };
  delta += joining.length;
  const merged = [...kept, ...joining];
  const key = ORDER_FIELDS[args.orderby ?? 'date'];
  if (key) {
    const direction = args.order === 'ASC' ? 1 : -1;
    merged.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return x === y ? 0 : (x < y ? -1 : 1) * direction;
    });
  }
  return { rows: perPage === -1 ? merged : merged.slice(0, perPage), delta };
}
