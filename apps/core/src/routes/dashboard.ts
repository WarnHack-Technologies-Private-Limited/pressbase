import { schema } from '@pressbase/db';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { userCan } from '../auth/users';
import { type AppEnv, requireCapability, restError } from '../http';
import { decodeGlobalStyles, userGlobalStylesPost } from '../themes/global-styles';
import { DEFAULT_THEME } from '../themes/service';
import { PRESSBASE_VERSION } from '../version';

/** Everything the dashboard home screen shows, in one request. */
export function dashboardRoutes() {
  const app = new Hono<AppEnv>();

  app.use(requireCapability('read'));

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const { db } = kernel;
    const { posts, comments, users } = schema;

    const countPosts = async (type: string, status: string) =>
      (
        await db
          .select({ n: count() })
          .from(posts)
          .where(and(eq(posts.type, type), eq(posts.status, status)))
      )[0]?.n ?? 0;
    const countComments = async (approved: string) =>
      (await db.select({ n: count() }).from(comments).where(eq(comments.approved, approved)))[0]
        ?.n ?? 0;

    const [publishedPosts, draftPosts, publishedPages, approved, pending, people, recent] =
      await Promise.all([
        countPosts('post', 'publish'),
        countPosts('post', 'draft'),
        countPosts('page', 'publish'),
        countComments('1'),
        countComments('0'),
        db
          .select({ n: count() })
          .from(users)
          .then((rows) => rows[0]?.n ?? 0),
        db
          .select({
            id: posts.id,
            title: posts.title,
            type: posts.type,
            status: posts.status,
            modified: posts.modified,
          })
          .from(posts)
          .where(
            and(inArray(posts.type, ['post', 'page']), inArray(posts.status, ['publish', 'draft'])),
          )
          .orderBy(desc(posts.modified))
          .limit(5),
      ]);

    // "Make it yours" on the dashboard: another theme, a logo, or saved styles.
    const stylesheet = await kernel.options.get<string>('stylesheet', '');
    const stylesPost = await userGlobalStylesPost(kernel, stylesheet);
    const styles = stylesPost ? decodeGlobalStyles(stylesPost.content) : undefined;
    const customized =
      stylesheet !== DEFAULT_THEME ||
      Boolean(await kernel.options.get<number>('site_logo', 0)) ||
      Object.keys(styles?.styles ?? {}).length > 0 ||
      Object.keys(styles?.settings ?? {}).length > 0;

    return c.json({
      site: {
        title: await kernel.options.get<string>('blogname', ''),
        url: await kernel.options.get<string>('home', ''),
        public: await kernel.options.get<boolean>('blog_public', true),
      },
      counts: {
        posts: publishedPosts,
        drafts: draftPosts,
        pages: publishedPages,
        comments: approved,
        pendingComments: pending,
        users: people,
      },
      appearance: { customized },
      recent,
      system: {
        version: PRESSBASE_VERSION,
        database: kernel.connection.driver,
        node: process.versions.node,
      },
    });
  });

  return app;
}

/**
 * Counts per status for one post type — wp_count_posts(), which powers the
 * status tabs above admin lists ("All (12) | Published (9) | Drafts (3)").
 */
export function postCountRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/:type', async (c) => {
    const kernel = c.get('kernel');
    const type = kernel.postTypes.get(c.req.param('type'));
    if (!type?.showInRest) return restError(c, 404, 'rest_type_invalid', 'Invalid post type.');
    if (!userCan(c.get('user'), type.cap.edit_posts)) {
      return restError(
        c,
        c.get('user') ? 403 : 401,
        'rest_forbidden',
        'Sorry, you are not allowed to do that.',
      );
    }
    await kernel.posts.publishDue();
    const rows = await kernel.db
      .select({ status: schema.posts.status, n: count() })
      .from(schema.posts)
      .where(eq(schema.posts.type, type.name))
      .groupBy(schema.posts.status);
    return c.json(Object.fromEntries(rows.map((r) => [r.status, r.n])));
  });

  return app;
}
