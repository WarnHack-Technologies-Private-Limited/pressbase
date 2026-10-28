import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { Post } from './posts';

/**
 * Permalinks — get_permalink() and get_page_link() (wordpress/wp-includes/link-template.php).
 * Published content gets its pretty URL from `permalink_structure`; anything
 * not yet public gets the plain ?p= / ?page_id= form, as WordPress does.
 * The public site that serves these URLs arrives in v0.4.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: get('year'),
    monthnum: get('month'),
    day: get('day'),
    hour: pad(Number(get('hour')) % 24),
    minute: get('minute'),
    second: get('second'),
  };
}

export interface PermalinkContext {
  home: string;
  structure: string;
  timeZone: string;
  /** Slug of each post's primary category, for %category%. */
  categorySlug?: (postId: number) => string | undefined;
  authorSlug?: (authorId: number | null) => string | undefined;
}

export async function permalinkContext(kernel: Kernel): Promise<PermalinkContext> {
  return {
    home: await kernel.options.get<string>('home', ''),
    structure: await kernel.options.get<string>('permalink_structure', ''),
    timeZone: await kernel.options.get<string>('timezone_string', 'UTC'),
  };
}

async function pagePath(kernel: Kernel, post: Post): Promise<string> {
  const slugs = [post.slug];
  let parentId = post.parentId;
  for (let depth = 0; parentId && depth < 20; depth++) {
    const [parent] = await kernel.db
      .select({ slug: schema.posts.slug, parentId: schema.posts.parentId })
      .from(schema.posts)
      .where(eq(schema.posts.id, parentId));
    if (!parent) break;
    slugs.unshift(parent.slug);
    parentId = parent.parentId;
  }
  return slugs.join('/');
}

export async function permalink(
  kernel: Kernel,
  post: Post,
  ctx: PermalinkContext,
): Promise<string> {
  const isPublic = post.status === 'publish';
  // get_post_permalink() for types without public URLs (wp_navigation, wp_block).
  const type = kernel.postTypes.get(post.type);
  if (type && !type.public && !['post', 'page'].includes(type.name)) {
    return `${ctx.home}/?post_type=${post.type}&p=${post.id}`;
  }
  const plain = `${ctx.home}/?${post.type === 'page' ? 'page_id' : 'p'}=${post.id}`;
  if (!isPublic || !ctx.structure) return plain;

  if (post.type === 'page') return `${ctx.home}/${await pagePath(kernel, post)}/`;
  if (post.type !== 'post') return `${ctx.home}/${post.type}/${post.slug}/`;

  const d = localParts(post.date, ctx.timeZone);
  const path = ctx.structure
    .replace(/%year%/g, d.year)
    .replace(/%monthnum%/g, d.monthnum)
    .replace(/%day%/g, d.day)
    .replace(/%hour%/g, d.hour)
    .replace(/%minute%/g, d.minute)
    .replace(/%second%/g, d.second)
    .replace(/%post_id%/g, String(post.id))
    .replace(/%postname%/g, post.slug)
    .replace(/%category%/g, ctx.categorySlug?.(post.id) ?? 'uncategorized')
    .replace(/%author%/g, ctx.authorSlug?.(post.authorId) ?? 'author');
  return `${ctx.home}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Settings → Permalinks (wordpress/wp-admin/options-permalink.php,
 * sanitize_option() in wp-includes/formatting.php, WP_Rewrite::set_*()).
 * See docs/architecture/public-site.md#permalinks.
 */

/** The structure tags Pressbase understands (WP_Rewrite::$rewritecode, less the taxonomy ones). */
export const STRUCTURE_TAGS = [
  '%year%',
  '%monthnum%',
  '%day%',
  '%hour%',
  '%minute%',
  '%second%',
  '%post_id%',
  '%postname%',
  '%category%',
  '%author%',
] as const;

/** The common settings of options-permalink.php. */
export const PERMALINK_PRESETS = {
  plain: '',
  day: '/%year%/%monthnum%/%day%/%postname%/',
  month: '/%year%/%monthnum%/%postname%/',
  numeric: '/archives/%post_id%',
  postname: '/%postname%/',
} as const;

/** First path segments the router already uses, so a category or tag base can't take them. */
const RESERVED_BASES = new Set(['author', 'search', 'page', 'feed', 'comments', 'wp-json']);

export type Sanitized = { ok: true; value: string } | { ok: false; error: string };

/**
 * The permalink structure as options-permalink.php saves it: `#` removed, a
 * leading slash, no repeated slashes, and sanitize_option()'s rule that a
 * custom structure needs a structure tag. Pressbase is stricter in two ways
 * WordPress's rewrite rules make up for and its router does not: every tag
 * must be one of STRUCTURE_TAGS, and the structure must name the post
 * (%postname% or %post_id%). An empty value is Plain.
 */
export function sanitizePermalinkStructure(input: string): Sanitized {
  const raw = input.trim();
  if (!raw) return { ok: true, value: '' };
  const value = `/${raw.replaceAll('#', '')}`.replace(/\/+/g, '/');
  if (!/%[^/%]+%/.test(value)) {
    return { ok: false, error: 'A structure tag is required when using custom permalinks.' };
  }
  const unknown = (value.match(/%[^/%]*%/g) ?? []).filter(
    (tag) => !(STRUCTURE_TAGS as readonly string[]).includes(tag),
  );
  if (unknown.length) {
    return { ok: false, error: `Unknown structure tag: ${unknown[0]}.` };
  }
  if (!value.includes('%postname%') && !value.includes('%post_id%')) {
    return {
      ok: false,
      error: 'Include %postname% or %post_id% so every post has its own address.',
    };
  }
  const rest = value.replace(/%[a-z_]+%/g, '');
  if (!/^[A-Za-z0-9\-._~/]*$/.test(rest)) {
    return {
      ok: false,
      error: 'Use only letters, numbers, hyphens, dots, underscores and slashes around the tags.',
    };
  }
  if (rest.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, error: 'The structure can’t contain “.” or “..” segments.' };
  }
  return { ok: true, value };
}

/**
 * A category or tag base as options-permalink.php saves it (`/topics`), or
 * '' for WordPress's default (`category`, `tag`).
 */
export function sanitizePermalinkBase(input: string): Sanitized {
  const raw = input.trim().replaceAll('#', '');
  if (!raw || /^\/+$/.test(raw)) return { ok: true, value: '' };
  const value = `/${raw}`.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!/^(?:\/[A-Za-z0-9\-._~]+)+$/.test(value)) {
    return {
      ok: false,
      error: 'Use only letters, numbers, hyphens, dots, underscores and slashes.',
    };
  }
  const segments = value.slice(1).split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, error: 'The base can’t contain “.” or “..” segments.' };
  }
  if (RESERVED_BASES.has(segments[0] ?? '')) {
    return { ok: false, error: `“${segments[0]}” is already used by other addresses.` };
  }
  return { ok: true, value };
}

export interface PermalinkBases {
  /** Without slashes, e.g. `category` or `topics/all`. */
  category: string;
  tag: string;
}

/** WP_Rewrite's category and tag bases: the option without slashes, or the default. */
export function basePath(option: string | undefined | null, fallback: string): string {
  const trimmed = (option ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed || fallback;
}

export async function permalinkBases(kernel: Kernel): Promise<PermalinkBases> {
  return {
    category: basePath(await kernel.options.get<string>('category_base', ''), 'category'),
    tag: basePath(await kernel.options.get<string>('tag_base', ''), 'tag'),
  };
}

/**
 * Earlier permalink settings, newest first, so old addresses can redirect to
 * new ones (wp_old_slug_redirect() for structures). Kept in an option, not
 * a table: a few strings per setting.
 */
export const PERMALINK_HISTORY_OPTION = 'pressbase_permalink_history';
const HISTORY_LIMIT = 10;

export interface PermalinkHistory {
  structures: string[];
  categoryBases: string[];
  tagBases: string[];
}

export async function permalinkHistory(kernel: Kernel): Promise<PermalinkHistory> {
  const stored = await kernel.options.get<Partial<PermalinkHistory> | null>(
    PERMALINK_HISTORY_OPTION,
    null,
  );
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    structures: list(stored?.structures),
    categoryBases: list(stored?.categoryBases),
    tagBases: list(stored?.tagBases),
  };
}

/** Adds a replaced value to the front of a history list. */
export function remember(list: string[], previous: string, current: string): string[] {
  if (previous === current) return list;
  return [previous, ...list.filter((v) => v !== previous && v !== current)].slice(0, HISTORY_LIMIT);
}
