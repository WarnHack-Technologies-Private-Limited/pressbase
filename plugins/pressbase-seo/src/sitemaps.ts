import type { PluginApi } from '@pressbase/plugin-sdk';
import { bool, META, postTypeAppearance, TERM_META, taxonomyAppearance } from './shared';
import { CACHE_TAG, getTitles, getWpseo } from './store';

/**
 * Pressbase SEO extends core's wp-sitemap.xml through its filters; there is
 * no second sitemap system. It honours the sitemap toggle, leaves out post
 * types, taxonomies, authors and single posts or terms that are noindexed,
 * and adds lastmod to terms.
 *
 * Noindexed IDs are read with one query each on core's `postmeta` and
 * `termmeta` tables, as WordPress plugins read `$wpdb->postmeta`.
 */

export function registerSitemaps(api: PluginApi): void {
  api.hooks.addFilter('wp_sitemaps_enabled', async (enabled) => {
    api.cache.addTags(CACHE_TAG);
    return enabled && bool((await getWpseo(api)).enable_xml_sitemap, true);
  });

  api.hooks.addFilter('wp_sitemaps_post_types', async (types) => {
    const titles = await getTitles(api);
    return types.filter((type) => !postTypeAppearance(titles, type).noindex);
  });

  api.hooks.addFilter('wp_sitemaps_taxonomies', async (taxonomies) => {
    const titles = await getTitles(api);
    return taxonomies.filter((tax) => !taxonomyAppearance(titles, tax).noindex);
  });

  api.hooks.addFilter('wp_sitemaps_add_provider', async (provider, name) => {
    if (name !== 'users') return provider;
    const titles = await getTitles(api);
    return bool(titles['noindex-author-wpseo'], false) || bool(titles['disable-author'], false)
      ? false
      : provider;
  });

  api.hooks.addFilter('wp_sitemaps_posts_query_args', async (args) => {
    const db = api.db;
    if (!db) return args;
    const rows = await db.query<{ id: number | string }>(
      db.sql`select post_id as id from postmeta where key = ${META.noindex} and (value #>> '{}') = '1'`,
    );
    if (!rows.length) return args;
    return { ...args, post__not_in: [...(args.post__not_in ?? []), ...rows.map((r) => Number(r.id))] };
  });

  api.hooks.addFilter('wp_sitemaps_taxonomies_query_args', async (args) => {
    const db = api.db;
    if (!db) return args;
    const rows = await db.query<{ id: number | string }>(
      db.sql`select term_id as id from termmeta where key = ${TERM_META.noindex}
             and (value #>> '{}') = 'noindex'`,
    );
    if (!rows.length) return args;
    return { ...args, exclude: [...(args.exclude ?? []), ...rows.map((r) => Number(r.id))] };
  });

  // lastmod for a term: its most recently modified published post (as Yoast does).
  api.hooks.addFilter('wp_sitemaps_taxonomies_entry', async (entry, term) => {
    const db = api.db;
    if (!db || entry.lastmod) return entry;
    const [row] = await db.query<{ modified: string | Date | null }>(
      db.sql`select max(p.modified) as modified from posts p
             join term_relationships tr on tr.object_id = p.id
             where tr.term_taxonomy_id = ${term.ttId} and p.status = 'publish'`,
    );
    if (!row?.modified) return entry;
    return {
      ...entry,
      lastmod: new Date(row.modified).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    };
  });
}
