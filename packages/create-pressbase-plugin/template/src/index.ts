/**
 * __PLUGIN_TITLE__: a Pressbase plugin.
 *
 * `register(api)` (the default export) runs every time the plugin loads: on
 * boot and right after activation. Everything registered through `api` is
 * taken back for you when the plugin is deactivated.
 *
 * API reference: https://github.com/WarnHack-Technologies-Private-Limited/pressbase/blob/main/docs/architecture/plugins.md
 */
import { allowAnyone, defineLifecycle, definePlugin, restError } from '@pressbase/plugin-sdk';

// @database-start
/** Created by migrations/0001-create-greetings.sql. Prefix your tables with the plugin's name. */
const TABLE = '__PLUGIN_PREFIX__greetings';

interface Greeting {
  id: number;
  name: string;
  created_at: string;
}

/** Rows of a query, whichever PostgreSQL driver the site runs. */
function rows<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? [];
}
// @database-end

export default definePlugin((api) => {
  // A hook: add a meta tag to every public page's <head>.
  api.hooks.addAction('wp_head', (out) => {
    out.print(`<meta name="__PLUGIN_SLUG__" content="${api.plugin.version}" />`);
  });

  // A stylesheet from public/, served at /wp-content/plugins/__PLUGIN_SLUG__/style.css?ver=…
  api.styles.enqueue('__PLUGIN_SLUG__', 'style.css');

  // A REST route: GET /wp-json/__PLUGIN_SLUG__/v1/hello?name=Ada
  api.rest.registerRoute('__PLUGIN_SLUG__/v1', '/hello', {
    permission: allowAnyone,
    handler: async (c) => {
      const name = c.req.query('name')?.trim() || 'world';
      if (name.length > 100) {
        return restError(
          400,
          '__PLUGIN_PREFIX__name_too_long',
          'Names are at most 100 characters.',
        );
      }
      const greeting = `${await api.options.get('greeting', 'Hello')}, ${name}!`;
      // @database-start
      const db = api.db;
      if (db) {
        await db.db.execute(
          db.sql`insert into ${db.sql.identifier(TABLE)} (name) values (${name})`,
        );
        const result = await db.db.execute(
          db.sql`select count(*)::int as count from ${db.sql.identifier(TABLE)}`,
        );
        const [row] = rows<{ count: number }>(result);
        return { greeting, count: row?.count ?? 0 };
      }
      // @database-end
      return { greeting };
    },
  });

  // @database-start
  // An authenticated route: the latest greetings, for users who can edit posts.
  api.rest.registerRoute('__PLUGIN_SLUG__/v1', '/greetings', {
    permission: (c) => api.rest.userCan(c, 'edit_posts'),
    handler: async () => {
      const db = api.db;
      if (!db) return [];
      const result = await db.db.execute(
        db.sql`select id, name, created_at from ${db.sql.identifier(TABLE)} order by id desc limit 20`,
      );
      return rows<Greeting>(result);
    },
  });
  // @database-end
});

/** Runs once, when an administrator activates the plugin. */
export const activate = defineLifecycle(async (api) => {
  await api.options.set('greeting', await api.options.get('greeting', 'Hello'));
});

/** Runs before the plugin is deleted: remove what it stored. */
export const uninstall = defineLifecycle(async (api) => {
  await api.options.delete('greeting');
  // @database-start
  await api.db?.exec(`drop table if exists ${TABLE}`);
  // @database-end
});
