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
