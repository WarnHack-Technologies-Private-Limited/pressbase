import { schema } from '@pressbase/db';
import { inArray } from 'drizzle-orm';
import type { Comment } from '../comments/service';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import { CacheTag } from './tags';

/**
 * Turns content changes into cache purges. Each handler listens to an action
 * core already fires (WordPress's names) and announces the cache tags whose
 * pages are now out of date with one Pressbase action:
 *
 *   pressbase_cache_purge (tags: string[], reason: string)
 *
 * The revalidation notifier (cache/notifier.ts) forwards those tags to
 * apps/web; a CDN integration can listen to the same action. This is the job
 * WordPress caching plugins do with clean_post_cache / clean_term_cache.
 *
 * Precision rules, kept simple on purpose:
 * - Editing a published post purges `post:{id}`: every page that showed it
 *   (its own page, list pages it appears on, neighbours linking to it).
 * - Anything that changes *which* posts a listing shows (publishing,
 *   unpublishing, a new date, slug, author, parent, password or terms, sticky
 *   posts) also purges `posts:{type}`, `posts:any`, search results and 404s.
 * - Site-wide things (settings, the theme, menus and other non-public post
 *   types) purge `site`, which every page carries.
 */

export const PURGE_ACTION = 'pressbase_cache_purge';

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    pressbase_cache_purge: [tags: string[], reason: string];
    post_updated: [postId: number, postAfter: Post, postBefore: Post];
    set_object_terms: [
      objectId: number,
      termIds: number[],
      ttIds: number[],
      taxonomy: string,
      append: boolean,
      oldTtIds: number[],
    ];
  }
}

/** Options whose changes never show on the public site. */
const PRIVATE_OPTIONS = new Set(['pressbase_db_version', 'pressbase_comment_hash_key', 'cron']);
const isPrivateOption = (name: string) =>
  PRIVATE_OPTIONS.has(name) ||
  name.startsWith('_transient') ||
  name.startsWith('_site_transient') ||
  // Settings → AI and provider keys (ai/client.ts) never show on the public site.
  name.startsWith('pressbase_ai_') ||
  name.startsWith('connectors_ai_');

/** Statuses an anonymous visitor can see (the only pages apps/web caches). */
const isPublic = (status: string) => status === 'publish';

/** Fields of a published post that decide where it appears in listings. */
const LISTING_FIELDS = ['status', 'date', 'slug', 'authorId', 'parentId', 'menuOrder', 'password'];

/** The tags of a change that adds, removes or moves a post in listings. */
export function membershipTags(post: Pick<Post, 'id' | 'type' | 'authorId'>): string[] {
  return [
    CacheTag.post(post.id),
    CacheTag.posts(post.type),
    'posts:any',
    CacheTag.search,
    CacheTag.notFound,
    ...(post.type === 'post' ? [CacheTag.home] : []),
    ...(post.authorId ? [CacheTag.author(post.authorId)] : []),
  ];
}

export function registerCacheInvalidation(kernel: Kernel): void {
  const { hooks } = kernel;
  const purge = async (tags: (string | undefined)[], reason: string) => {
    const unique = [...new Set(tags.filter((t): t is string => Boolean(t)))];
    if (unique.length) await hooks.doAction(PURGE_ACTION, unique, reason);
  };
  /**
   * membershipTags() plus the term lists of the post's taxonomies: term
   * counts (and so which terms hide_empty lists show, in sitemaps and
   * category lists) follow published posts.
   */
  const listingTags = (post: Pick<Post, 'id' | 'type' | 'authorId'>) => [
    ...membershipTags(post),
    ...kernel.taxonomies
      .all()
      .filter((t) => t.objectTypes.has(post.type))
      .map((t) => CacheTag.terms(t.name)),
  ];
  /** Post types visitors never browse (menus, templates, global styles) can appear on every page. */
  const siteWide = (type: string) => {
    const definition = kernel.postTypes.get(type);
    return !definition || (!definition.public && !['revision', 'attachment'].includes(type));
  };

  // Posts: status transitions (publish, unpublish, trash, scheduled posts going live).
  hooks.addAction('transition_post_status', async (newStatus, oldStatus, post) => {
    const p = post as Post;
    if (newStatus === oldStatus || !(isPublic(String(newStatus)) || isPublic(String(oldStatus))))
      return;
    if (siteWide(p.type)) return purge([CacheTag.site], `transition_post_status:${p.type}`);
    await purge(listingTags(p), 'transition_post_status');
  });

  // Edits. Drafts and other unpublished posts aren't cached, so only public posts count.
  hooks.addAction('save_post', async (postId, post) => {
    const p = post as Post;
    if (p.type === 'revision') return;
    if (siteWide(p.type)) {
      if (isPublic(p.status)) await purge([CacheTag.site], `save_post:${p.type}`);
      return;
    }
    if (isPublic(p.status)) await purge([CacheTag.post(Number(postId))], 'save_post');
  });

  hooks.addAction('post_updated', async (_id, after, before) => {
    if (!isPublic(after.status) || !isPublic(before.status) || siteWide(after.type)) return;
    const moved = LISTING_FIELDS.some((field) => {
      const a = after[field as keyof Post];
      const b = before[field as keyof Post];
      return a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b;
    });
    if (moved) await purge([...listingTags(after), ...listingTags(before)], 'post_updated');
  });

  hooks.addAction('set_object_terms', async (objectId, _termIds, ttIds, taxonomy, _a, oldTtIds) => {
    const before = [...oldTtIds].sort().join(',');
    const after = [...ttIds].sort().join(',');
    if (before === after) return;
    const post = await kernel.posts.get(objectId);
    if (!post || !isPublic(post.status)) return;
    await purge(
      [
        ...membershipTags(post),
        CacheTag.terms(taxonomy),
        ...(await termTags(kernel, ttIds, oldTtIds)),
      ],
      'set_object_terms',
    );
  });

  // Permanent deletion of a published post skips transition_post_status.
  hooks.addAction('deleted_post', async (_postId, post) => {
    const p = post as Post;
    if (!isPublic(p.status)) return;
    await purge(siteWide(p.type) ? [CacheTag.site] : listingTags(p), 'deleted_post');
  });

  // Meta written through the metadata API (content/meta.ts): what a page prints
  // from it (an SEO title, a description) belongs to the post or term.
  for (const action of ['added_post_meta', 'updated_post_meta', 'deleted_post_meta'] as const) {
    hooks.addAction(action, async (...args: unknown[]) => {
      const postId = args[1];
      const post = await kernel.posts.get(Number(postId));
      if (!post || !isPublic(post.status)) return;
      await purge([siteWide(post.type) ? CacheTag.site : CacheTag.post(post.id)], action);
    });
  }
  for (const action of ['added_term_meta', 'updated_term_meta', 'deleted_term_meta'] as const) {
    hooks.addAction(action, async (...args: unknown[]) =>
      purge([CacheTag.term(Number(args[1]))], action),
    );
  }

  // Media: alt text, captions and files of an attachment shown on pages.
  for (const action of ['edit_attachment', 'delete_attachment'] as const) {
    hooks.addAction(action, async (id) => purge([CacheTag.post(Number(id))], action));
  }

  // Terms (clean_term_cache()).
  hooks.addAction('created_term', async (_termId, taxonomy) =>
    purge([CacheTag.terms(String(taxonomy)), CacheTag.notFound], 'created_term'),
  );
  hooks.addAction('edited_term', async (termId, taxonomy) =>
    purge(
      [CacheTag.term(Number(termId)), CacheTag.terms(String(taxonomy)), CacheTag.notFound],
      'edited_term',
    ),
  );
  hooks.addAction('delete_term', async (termId, taxonomy) => {
    const types = kernel.taxonomies.get(String(taxonomy))?.objectTypes ?? new Set<string>();
    await purge(
      [
        CacheTag.term(Number(termId)),
        CacheTag.terms(String(taxonomy)),
        ...[...types].map(CacheTag.posts),
        'posts:any',
      ],
      'delete_term',
    );
  });

  // Comments: only approved comments are public (wp_update_comment_count() and friends).
  const commentTags = (c: Comment) => [CacheTag.post(c.postId), CacheTag.comments];
  hooks.addAction('wp_insert_comment', async (_id, comment) => {
    const c = comment as Comment;
    if (c.approved === '1') await purge(commentTags(c), 'wp_insert_comment');
  });
  hooks.addAction('edit_comment', async (_id, comment) => {
    const c = comment as Comment;
    if (c.approved === '1') await purge(commentTags(c), 'edit_comment');
  });
  hooks.addAction('transition_comment_status', async (to, from, comment) => {
    if (to === 'approved' || from === 'approved') {
      await purge(commentTags(comment as Comment), 'transition_comment_status');
    }
  });

  // Authors: display names in bylines and archives; deleting reassigns posts.
  hooks.addAction('profile_update', async (userId) =>
    purge([CacheTag.author(Number(userId))], 'profile_update'),
  );
  hooks.addAction('deleted_user', async () => purge([CacheTag.site], 'deleted_user'));

  // Plugins: their head output, scripts and styles can be on every page.
  for (const action of ['activated_plugin', 'deactivated_plugin'] as const) {
    hooks.addAction(action, async () => purge([CacheTag.site], action));
  }

  // Settings and the theme: every page.
  hooks.addAction('updated_option', async (name) => {
    const option = String(name);
    if (isPrivateOption(option)) return;
    if (option === 'sticky_posts') {
      return purge(
        [CacheTag.posts('post'), 'posts:any', CacheTag.home, CacheTag.search],
        'sticky_posts',
      );
    }
    await purge([CacheTag.site], `option:${option}`);
  });
  hooks.addAction('deleted_option', async (name) => {
    if (!isPrivateOption(String(name))) await purge([CacheTag.site], `option:${String(name)}`);
  });
  hooks.addAction('switch_theme', async () => purge([CacheTag.site], 'switch_theme'));
}

/** term:{id} for term_taxonomy IDs. */
async function termTags(kernel: Kernel, ...ttIdLists: number[][]): Promise<string[]> {
  const ids = [...new Set(ttIdLists.flat())];
  if (!ids.length) return [];
  const rows = await kernel.db
    .select({ termId: schema.termTaxonomy.termId })
    .from(schema.termTaxonomy)
    .where(inArray(schema.termTaxonomy.id, ids));
  return rows.map((r) => CacheTag.term(r.termId));
}
