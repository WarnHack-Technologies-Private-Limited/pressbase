import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { CurrentUser } from './users';

/**
 * Meta capabilities — a port of map_meta_cap() (wordpress/wp-includes/capabilities.php)
 * for posts, terms and users. A meta capability such as edit_post depends on
 * the object (who wrote it, its status); it maps to primitive capabilities
 * that roles actually grant. The user must hold every mapped capability.
 */

const DO_NOT_ALLOW = 'do_not_allow';

async function loadPost(kernel: Kernel, id: number) {
  const [post] = await kernel.db
    .select({
      id: schema.posts.id,
      type: schema.posts.type,
      status: schema.posts.status,
      authorId: schema.posts.authorId,
      parentId: schema.posts.parentId,
    })
    .from(schema.posts)
    .where(eq(schema.posts.id, id));
  return post;
}

async function trashedFromStatus(kernel: Kernel, postId: number): Promise<string | undefined> {
  const [row] = await kernel.db
    .select({ value: schema.postmeta.value })
    .from(schema.postmeta)
    .where(
      and(eq(schema.postmeta.postId, postId), eq(schema.postmeta.key, '_wp_trash_meta_status')),
    );
  return typeof row?.value === 'string' ? row.value : undefined;
}

const LIVE = new Set(['publish', 'future']);

export async function mapMetaCap(
  kernel: Kernel,
  cap: string,
  user: CurrentUser | null,
  objectId?: number,
): Promise<string[]> {
  const userId = user?.id ?? 0;

  switch (cap) {
    case 'edit_post':
    case 'edit_page':
    case 'delete_post':
    case 'delete_page': {
      if (objectId === undefined) return [DO_NOT_ALLOW];
      let post = await loadPost(kernel, objectId);
      if (!post) return [DO_NOT_ALLOW];
      const deleting = cap.startsWith('delete');
      if (post.type === 'revision') {
        if (deleting) return [DO_NOT_ALLOW];
        post = post.parentId ? await loadPost(kernel, post.parentId) : undefined;
        if (!post) return [DO_NOT_ALLOW];
      }
      if (deleting) {
        // The pages used as front page and posts page need manage_options.
        const front = await kernel.options.get<number>('page_on_front', 0);
        const postsPage = await kernel.options.get<number>('page_for_posts', 0);
        if (post.id === front || post.id === postsPage) return ['manage_options'];
      }
      const type = kernel.postTypes.get(post.type);
      if (!type) return ['edit_others_posts'];
      const verb = deleting ? 'delete' : 'edit';
      if (!type.mapMetaCap) return [type.cap[deleting ? 'delete_post' : 'edit_post']];

      if (post.authorId && post.authorId === userId) {
        let status = post.status;
        if (status === 'trash') status = (await trashedFromStatus(kernel, post.id)) ?? 'draft';
        return [LIVE.has(status) ? type.cap[`${verb}_published_posts`] : type.cap[`${verb}_posts`]];
      }
      const caps = [type.cap[`${verb}_others_posts`]];
      if (LIVE.has(post.status)) caps.push(type.cap[`${verb}_published_posts`]);
      else if (post.status === 'private') caps.push(type.cap[`${verb}_private_posts`]);
      return caps;
    }

    case 'read_post':
    case 'read_page': {
      if (objectId === undefined) return [DO_NOT_ALLOW];
      let post = await loadPost(kernel, objectId);
      if (post?.type === 'revision' && post.parentId) post = await loadPost(kernel, post.parentId);
      if (!post) return [DO_NOT_ALLOW];
      const type = kernel.postTypes.get(post.type);
      if (!type) return ['edit_others_posts'];
      if (!type.mapMetaCap) return [type.cap.read_post];
      const status = kernel.postStatuses.get(post.status);
      if (!status) return [DO_NOT_ALLOW];
      if (status.public) return [type.cap.read];
      if (post.authorId && post.authorId === userId) return [type.cap.read];
      if (status.private) return [type.cap.read_private_posts];
      return mapMetaCap(kernel, 'edit_post', user, post.id);
    }

    case 'publish_post': {
      if (objectId === undefined) return [DO_NOT_ALLOW];
      const post = await loadPost(kernel, objectId);
      if (!post) return [DO_NOT_ALLOW];
      const type = kernel.postTypes.get(post.type);
      return [type ? type.cap.publish_posts : 'edit_others_posts'];
    }

    case 'edit_term':
    case 'delete_term':
    case 'assign_term': {
      if (objectId === undefined) return [DO_NOT_ALLOW];
      const [row] = await kernel.db
        .select({ taxonomy: schema.termTaxonomy.taxonomy })
        .from(schema.termTaxonomy)
        .where(eq(schema.termTaxonomy.termId, objectId));
      const taxonomy = row && kernel.taxonomies.get(row.taxonomy);
      if (!taxonomy) return [DO_NOT_ALLOW];
      if (cap === 'delete_term') {
        const fallback = await kernel.options.get<number>('default_category', 0);
        if (taxonomy.name === 'category' && objectId === fallback) return [DO_NOT_ALLOW];
      }
      const key =
        cap === 'edit_term'
          ? 'edit_terms'
          : cap === 'delete_term'
            ? 'delete_terms'
            : 'assign_terms';
      return [taxonomy.cap[key]];
    }

    case 'edit_user':
      // Everyone may edit themselves.
      if (objectId !== undefined && userId > 0 && objectId === userId) return [];
      return userId > 0 ? ['edit_users'] : [DO_NOT_ALLOW];

    case 'remove_user':
      return objectId !== undefined && objectId === userId ? [DO_NOT_ALLOW] : ['remove_users'];

    case 'promote_user':
    case 'add_users':
      return ['promote_users'];

    default:
      return [cap];
  }
}

/** current_user_can(): every mapped capability must be granted. */
export async function currentUserCan(
  kernel: Kernel,
  user: CurrentUser | null,
  cap: string,
  objectId?: number,
): Promise<boolean> {
  const caps = await mapMetaCap(kernel, cap, user, objectId);
  if (caps.includes(DO_NOT_ALLOW)) return false;
  return caps.every((c) => Boolean(user?.capabilities[c]));
}
