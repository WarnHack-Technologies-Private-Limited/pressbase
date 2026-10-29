import type { PluginApi, Post } from '@pressbase/plugin-sdk';
import { analyze, type CheckResult } from './analysis';
import { computeHead } from './head';
import { plainText } from './html';
import { META } from './shared';
import { getSite } from './store';

/**
 * The content analysis on the server: the same checks the editor runs
 * (analysis/), for `pressbase pressbase-seo audit` and later a site-wide report.
 */

/** Other published posts with the same title, or the same custom SEO title. */
export async function duplicateTitles(
  api: PluginApi,
  title: string,
  exclude: number,
): Promise<{ id: number; title: string }[]> {
  const db = api.db;
  const wanted = title.trim().toLowerCase();
  if (!db || !wanted) return [];
  const rows = await db.query<{ id: number | string; title: string }>(
    db.sql`select p.id, p.title from posts p
           where p.status = 'publish' and p.type in ('post', 'page') and p.id <> ${exclude}
           and (lower(p.title) = ${wanted} or exists (
             select 1 from postmeta m where m.post_id = p.id and m.key = ${META.title}
             and lower(m.value #>> '{}') = ${wanted}))
           order by p.id limit 5`,
  );
  return rows.map((r) => ({ id: Number(r.id), title: plainText(r.title) }));
}

export async function auditPost(api: PluginApi, post: Post): Promise<CheckResult[]> {
  const [head, site, focuskw] = await Promise.all([
    computeHead(api, { target: { kind: 'post', post }, paged: 1, maxPages: 1 }),
    getSite(api),
    api.meta.get('post', post.id, META.focuskw, true),
  ]);
  const title = plainText(post.title);
  return analyze(
    {
      title,
      seoTitle: head.title,
      content: post.content ?? '',
      slug: post.slug,
      description: head.description,
      keyphrase: typeof focuskw === 'string' ? focuskw : '',
      homeUrl: site.home,
      duplicateTitles: await duplicateTitles(api, title, post.id),
    },
    (s) => api.i18n.__(s),
  );
}
