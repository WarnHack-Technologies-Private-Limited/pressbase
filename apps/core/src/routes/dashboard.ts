import { schema } from '@pressbase/db';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { type AppEnv, requireCapability } from '../http';
import { PRESSBASE_VERSION } from '../version';

/** Everything the dashboard home screen shows, in one request. */
export function dashboardRoutes() {
  const app = new Hono<AppEnv>();

  app.use(requireCapability('read'));

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const { db } = kernel;
    const { posts, comments } = schema;

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

    const [publishedPosts, draftPosts, publishedPages, approved, pending, recent] =
      await Promise.all([
        countPosts('post', 'publish'),
        countPosts('post', 'draft'),
        countPosts('page', 'publish'),
        countComments('1'),
        countComments('0'),
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
      },
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
