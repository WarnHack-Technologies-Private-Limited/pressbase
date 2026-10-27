import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { createPostAutosave, getAutosave, listAutosaves } from '../content/autosaves';
import { toGmtString, toLocalString } from '../content/dates';
import { permalink, permalinkContext } from '../content/permalinks';
import type { PostType } from '../content/post-types';
import type { Post } from '../content/posts';
import { renderBlocksAsStatic } from '../content/sanitize';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { authStatus, contextParam, rawText, serviceError } from './rest-util';

/**
 * /wp/v2/{posts|pages}/:id/autosaves — a port of WP_REST_Autosaves_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-autosaves-controller.php).
 *
 * - GET  /:id/autosaves              every autosave of the post (edit_post)
 * - POST /:id/autosaves              autosave: the author's own draft is updated
 *                                    directly; otherwise the user's autosave
 *                                    revision is created or updated in place
 * - GET  /:parent/autosaves/:id      the newest autosave (as WordPress, which
 *                                    ignores :id and calls wp_get_post_autosave)
 *
 * Only the revisioned fields (title, content, excerpt) are accepted, which is
 * what the block editor sends. Filter: `rest_prepare_autosave` (data, post).
 */

const bodySchema = z.object({
  title: rawText.optional(),
  content: rawText.optional(),
  excerpt: rawText.optional(),
});

/** WP_REST_Revisions_Controller::prepare_item_for_response(), plus preview_link. */
async function prepareAutosave(
  kernel: Kernel,
  row: Post,
  parent: Post,
  context: 'view' | 'edit' | 'embed',
): Promise<Record<string, unknown>> {
  const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
  const edit = context === 'edit';
  const data: Record<string, unknown> = {
    author: row.authorId ?? 0,
    date: toLocalString(row.date, timeZone),
    date_gmt: toGmtString(row.date),
    id: row.id,
    modified: toLocalString(row.modified, timeZone),
    modified_gmt: toGmtString(row.modified),
    parent: row.parentId ?? 0,
    slug: row.slug,
    title: edit ? { raw: row.title, rendered: row.title } : { rendered: row.title },
    content: {
      ...(edit ? { raw: row.content } : {}),
      rendered: renderBlocksAsStatic(row.content),
    },
    excerpt: {
      ...(edit ? { raw: row.excerpt } : {}),
      rendered: row.excerpt ? `<p>${row.excerpt}</p>\n` : '',
    },
  };
  if (edit) {
    // get_preview_post_link(): the parent's permalink with preview arguments.
    const link = await permalink(kernel, parent, await permalinkContext(kernel));
    const isAutosave = row.id !== parent.id;
    const url = new URL(link, 'http://localhost');
    url.searchParams.set('preview', 'true');
    if (isAutosave) url.searchParams.set('preview_id', String(parent.id));
    data.preview_link = /^https?:\/\//.test(link) ? url.toString() : `${url.pathname}${url.search}`;
  }
  return (await kernel.hooks.applyFilters('rest_prepare_autosave', data, row)) as Record<
    string,
    unknown
  >;
}

export function autosavesRoutes(type: PostType) {
  const app = new Hono<AppEnv>({ strict: false });

  /** WP_REST_Revisions_Controller::get_parent(). */
  const loadParent = async (c: Context<AppEnv>, param: string) => {
    const id = Number(c.req.param(param));
    const post = Number.isInteger(id) ? await c.get('kernel').posts.get(id) : undefined;
    return post && post.type === type.name ? post : undefined;
  };
  const invalidParent = (c: Context<AppEnv>) =>
    restError(c, 404, 'rest_post_invalid_parent', 'Invalid post parent ID.');
  const cannotRead = (c: Context<AppEnv>) =>
    restError(
      c,
      authStatus(c),
      'rest_cannot_read',
      'Sorry, you are not allowed to view autosaves of this post.',
    );

  /* ------------------------------------------------------------ list */

  app.get('/:id{[0-9]+}/autosaves', async (c) => {
    const kernel = c.get('kernel');
    const parsed = z.object({ context: contextParam }).safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    const parent = await loadParent(c, 'id');
    if (!parent) return invalidParent(c);
    if (!(await currentUserCan(kernel, c.get('user'), 'edit_post', parent.id))) {
      return cannotRead(c);
    }
    const rows = await listAutosaves(kernel, parent.id);
    const items = [];
    for (const row of rows) {
      items.push(await prepareAutosave(kernel, row, parent, parsed.data.context));
    }
    return c.json(items);
  });

  /* ------------------------------------------------------------ read */

  app.get('/:parent{[0-9]+}/autosaves/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const parsed = z.object({ context: contextParam }).safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    const parent = await loadParent(c, 'parent');
    if (!parent) return invalidParent(c);
    if (!(await currentUserCan(kernel, c.get('user'), 'edit_post', parent.id))) {
      return cannotRead(c);
    }
    const autosave = await getAutosave(kernel, parent.id);
    if (!autosave) {
      return restError(
        c,
        404,
        'rest_post_no_autosave',
        'There is no autosave revision for this post.',
      );
    }
    return c.json(await prepareAutosave(kernel, autosave, parent, parsed.data.context));
  });

  /* ---------------------------------------------------------- create */

  app.post('/:id{[0-9]+}/autosaves', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    // create_item_permissions_check() → the parent controller's update check.
    const post = await loadParent(c, 'id');
    if (!post) return restError(c, 404, 'rest_post_invalid_id', 'Invalid post ID.');
    if (!user || !(await currentUserCan(kernel, user, 'edit_post', post.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to edit this post.',
      );
    }
    const parsed = bodySchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const filterHtml = !userCan(user, 'unfiltered_html');

    try {
      // Drafts by the same author are updated directly, without a revision
      // (Pressbase has no post locks yet, so the lock check always passes).
      const isDraft = post.status === 'draft' || post.status === 'auto-draft';
      if (isDraft && post.authorId === user.id) {
        const updated = await kernel.posts.update(post.id, {
          ...parsed.data,
          filterHtml,
          saveRevision: false,
        });
        return c.json(await prepareAutosave(kernel, updated, updated, 'edit'));
      }
      const autosave = await createPostAutosave(kernel, post, user.id, {
        ...parsed.data,
        filterHtml,
      });
      return c.json(await prepareAutosave(kernel, autosave, post, 'edit'));
    } catch (error) {
      return serviceError(c, error);
    }
  });

  return app;
}
