import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defineLifecycle,
  definePlugin,
  type MainQuery,
  type PluginApi,
  type PluginRequestContext,
  type Post,
  restError,
} from '@pressbase/plugin-sdk';
import { registerAbilities } from './ai';
import { auditPost, duplicateTitles } from './audit';
import { indexNowKey, registerIndexNow, registerLlmsTxt, registerRobotsTxt } from './crawl';
import {
  breadcrumbTrail,
  type Crumb,
  computeHead,
  type HeadData,
  type RenderContext,
  renderHead,
  robotsDirectives,
  targetFromMain,
} from './head';
import { registerSiteHealth } from './health';
import { escHtml, escUrl } from './html';
import { type ImportSource, runImport } from './importers';
import {
  normalizePath,
  RedirectError,
  type RedirectInput,
  Redirects,
  rulesFromCsv,
  toCsv,
} from './redirects';
import {
  META,
  type MetaName,
  type SettingsPayload,
  SLUG,
  SOCIAL_DEFAULTS,
  TERM_META_NAMES,
  TITLE_DEFAULTS,
  WPSEO_DEFAULTS,
} from './shared';
import { registerSitemaps } from './sitemaps';
import {
  CACHE_TAG,
  getOwn,
  getSite,
  getSocial,
  getTitles,
  getWpseo,
  indexNowEnabled,
  OWN_DEFAULTS,
  OWN_OPTION,
} from './store';

/**
 * Pressbase SEO: a Yoast-class SEO plugin built only on Pressbase's public
 * plugin API. See README.md and docs/architecture/seo-plugin.md.
 */

declare module '@pressbase/plugin-sdk' {
  interface FilterRegistry {
    /** The breadcrumb trail as HTML, for themes and plugins: '' while Pressbase SEO is inactive. */
    pressbase_seo_breadcrumbs: [html: string, options: { main?: MainQuery; separator?: string }];
  }
}

const NS = 'pressbase-seo/v1';
const SETTINGS_OPTIONS = ['wpseo_titles', 'wpseo_social', 'wpseo', OWN_OPTION];

/* ------------------------------------------------------------------- meta */

const IDS = new Set<MetaName>(['ogImageId', 'twitterImageId', 'primaryCategory']);
const FLAGS: Partial<Record<MetaName, string[]>> = {
  noindex: ['0', '1', '2'],
  nofollow: ['0', '1'],
  cornerstone: ['0', '1'],
};

function sanitizeMeta(name: MetaName, value: unknown): string {
  const s = String(value ?? '').trim();
  if (IDS.has(name)) return /^\d+$/.test(s) ? s : '';
  const flags = FLAGS[name];
  if (flags) return flags.includes(s) ? s : '0';
  if (name === 'canonical' || name === 'ogImage' || name === 'twitterImage') {
    return /^https?:\/\/\S+$/i.test(s) ? s : '';
  }
  if (name === 'adv') {
    return s
      .split(',')
      .map((v) => v.trim())
      .filter((v) => ['noimageindex', 'noarchive', 'nosnippet'].includes(v))
      .join(',');
  }
  return s.replace(/\s+/g, ' ').slice(0, 1000);
}

function registerMeta(api: PluginApi): void {
  for (const name of Object.keys(META) as MetaName[]) {
    const args = {
      type: 'string' as const,
      single: true,
      showInRest: true,
      sanitizeCallback: (value: unknown) => sanitizeMeta(name, value),
      // Core has already checked edit_post / edit_term for the object (map_meta_cap()).
      authCallback: () => true,
    };
    api.meta.registerPostMeta('', META[name], args);
    if (TERM_META_NAMES.includes(name)) {
      api.meta.registerTermMeta('category', META[name], args);
      api.meta.registerTermMeta('post_tag', META[name], args);
    }
  }
}

/* ------------------------------------------------------------- head output */

function registerHead(api: PluginApi): void {
  // One computation per page, shared by the robots filter, the title and the head block.
  const memo = new WeakMap<MainQuery, Promise<HeadData>>();
  const headFor = (main: MainQuery) => {
    let head = memo.get(main);
    if (!head) {
      head = computeHead(api, targetFromMain(main));
      memo.set(main, head);
    }
    return head;
  };

  api.hooks.addFilter('pre_get_document_title', async (title, main) => {
    if (!main || title) return title;
    return (await headFor(main)).title;
  });

  // Merged into core's wp_robots (which already says noindex while the site discourages search engines).
  api.hooks.addFilter('wp_robots', async (robots, main) => {
    if (!main || robots.noindex) return robots;
    const head = await headFor(main);
    const merged: Record<string, string | boolean> = { ...robotsDirectives(head.robots), ...robots };
    if (!head.robots.index) {
      delete merged['max-image-preview'];
      delete merged['max-snippet'];
      delete merged['max-video-preview'];
    }
    return merged;
  });

  // Pressbase SEO prints its own canonical (also for archives and the home page).
  api.hooks.removeAction('wp_head', 'rel_canonical');
  api.hooks.addAction(
    'wp_head',
    async (out, page) => {
      api.cache.addTags(CACHE_TAG);
      out.print(renderHead(await headFor(page.main)));
    },
    1,
  );

  // Headless: the same data on posts, pages, categories and tags (`view` context).
  const restField = async (item: Record<string, unknown>, context: RenderContext, rest: string) => {
    if (rest !== 'view') return item;
    const head = await computeHead(api, context);
    return { ...item, pressbase_seo_head: { ...headJson(head), html: renderHead(head, { title: true, robots: true }) } };
  };
  for (const type of ['post', 'page']) {
    api.hooks.addFilter(`rest_prepare_${type}`, async (item: unknown, post: unknown, rest: unknown) =>
      (post as Post).status === 'publish'
        ? restField(item as Record<string, unknown>, { target: { kind: 'post', post: post as Post }, paged: 1, maxPages: 1 }, String(rest))
        : item,
    );
  }
  for (const taxonomy of ['category', 'post_tag']) {
    api.hooks.addFilter(`rest_prepare_${taxonomy}`, async (item: unknown, term: unknown, rest: unknown) =>
      restField(
        item as Record<string, unknown>,
        { target: { kind: 'term', term: term as never }, paged: 1, maxPages: 1 },
        String(rest),
      ),
    );
  }
}

/** The head as JSON, shaped like Yoast's `yoast_head_json`. */
export function headJson(head: HeadData) {
  const og = Object.fromEntries(
    head.og
      .filter((t) => !t.property.startsWith('og:image'))
      .map((t) => [t.property.replace(/[:]/g, '_'), t.content]),
  );
  return {
    title: head.title,
    description: head.description,
    canonical: head.canonical,
    robots: robotsDirectives(head.robots),
    ...og,
    og_image: head.image
      ? [{ url: head.image.url, width: head.image.width, height: head.image.height, type: head.image.type }]
      : [],
    twitter: Object.fromEntries(head.twitter.map((t) => [t.name.replace('twitter:', ''), t.content])),
    breadcrumbs: head.breadcrumbs,
    schema: head.schema,
  };
}

/* ------------------------------------------------------------- breadcrumbs */

export function breadcrumbsHtml(trail: Crumb[], separator: string, showCurrent = true): string {
  const crumbs = showCurrent ? trail : trail.slice(0, -1);
  if (!crumbs.length) return '';
  const items = crumbs.map((crumb, index) => {
    const last = index === crumbs.length - 1;
    const label = escHtml(crumb.name);
    const inner = crumb.url && !(last && showCurrent) ? `<a href="${escUrl(crumb.url)}">${label}</a>` : `<span${last && showCurrent ? ' aria-current="page"' : ''}>${label}</span>`;
    const sep = last ? '' : ` <span class="pressbase-seo-breadcrumbs__separator" aria-hidden="true">${escHtml(separator)}</span>`;
    return `<li>${inner}${sep}</li>`;
  });
  return `<ol class="pressbase-seo-breadcrumbs__list">${items.join('')}</ol>`;
}

function registerBreadcrumbs(api: PluginApi): void {
  const { __ } = api.i18n;
  const render = async (main: MainQuery | undefined, separator?: string, showCurrent = true) => {
    if (!main) return '';
    const titles = await getTitles(api);
    const trail = await breadcrumbTrail(api, targetFromMain(main), titles);
    return breadcrumbsHtml(trail, separator ?? String(titles['breadcrumbs-sep'] || '»'), showCurrent);
  };

  api.hooks.addFilter('pressbase_seo_breadcrumbs', async (html, options) =>
    html || render(options?.main ?? api.content.mainQuery(), options?.separator),
  );

  api.blocks.register('pressbase-seo/breadcrumbs', {
    title: __('Breadcrumbs'),
    description: __('The path from the home page to this page, as search engines see it.'),
    category: 'theme',
    icon: 'arrow-right-alt',
    keywords: ['breadcrumb', 'navigation', 'seo'],
    attributes: {
      separator: { type: 'string', default: '' },
      showCurrent: { type: 'boolean', default: true },
    },
    supports: { align: ['wide', 'full'], anchor: true, color: { text: true, link: true }, typography: { fontSize: true } },
    render: async (attributes, _content, block) => {
      api.cache.addTags(CACHE_TAG);
      const list = await render(
        api.content.mainQuery(),
        String(attributes.separator || '') || undefined,
        attributes.showCurrent !== false,
      );
      if (!list) return '';
      return `<nav ${api.blocks.getBlockWrapperAttributes(block, { class: 'pressbase-seo-breadcrumbs', 'aria-label': __('Breadcrumbs') })}>${list}</nav>`;
    },
  });
}

/* --------------------------------------------------------------- redirects */

function registerRedirects(api: PluginApi, redirects: Redirects): void {
  api.hooks.addAction('template_redirect', async (request) => {
    const found = await redirects.match(request.path);
    if (!found) return;
    await redirects.hit(found.rule.id);
    if (found.rule.status === 410) request.notFound(410);
    else request.redirect(found.location, found.rule.status);
  });

  api.hooks.addAction('pressbase_404', async ({ path: p, referrer }) => {
    if (/\.(?:php|asp|aspx|env|ini|sql|bak)$/i.test(p)) return; // probes: not worth a row
    await redirects.log404(p.split('?')[0] ?? p, referrer ?? '');
  });

  api.cron.addAction('prune_404s', () => redirects.prune404());

  // Automatic redirects when a published post's address changes.
  api.hooks.addAction('post_updated', async (_id, after, before) => {
    if (after.status !== 'publish' || before.status !== 'publish' || after.slug === before.slug) return;
    if (after.type === 'attachment' || !api.postTypes.get(after.type)?.public) return;
    const own = await getOwn(api);
    if (!own.auto_redirects) return;
    const [from, to] = await Promise.all([api.content.permalink(before), api.content.permalink(after)]);
    if (!from || !to || from === to) return;
    const source = normalizePath(from);
    const target = new URL(to).pathname;
    // A rule from the new address (an earlier rename back) would loop: drop it.
    const back = await redirects.match(target);
    if (back && !back.rule.regex) await redirects.delete(back.rule.id);
    if (await redirects.match(source)) return;
    try {
      await redirects.create({ source, target, status: 301 });
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
    }
  });
}

/* ----------------------------------------------------------------- settings */

function objectSanitizer(defaults: Record<string, unknown>) {
  return (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected an object.');
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z0-9_-]{1,80}$/i.test(key)) continue;
      const d = defaults[key];
      if (typeof d === 'boolean') out[key] = Boolean(v);
      else if (typeof d === 'number') out[key] = Number(v) || 0;
      else if (Array.isArray(d)) out[key] = Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean).slice(0, 20) : [];
      else if (typeof v === 'boolean' || typeof v === 'number') out[key] = v;
      else if (typeof v === 'string') out[key] = v.trim().slice(0, 2000);
    }
    return out;
  };
}

function registerSettings(api: PluginApi): void {
  const { __ } = api.i18n;
  const page = SLUG;
  api.admin.addPage({
    slug: page,
    title: __('SEO'),
    parent: 'settings',
    description: __('How the site appears in search results and when shared.'),
    entry: 'dist/admin/settings.js',
  });
  api.admin.addPage({
    slug: 'seo-tools',
    title: __('SEO'),
    parent: 'tools',
    capability: 'manage_options',
    description: __('Redirects, the 404 log, and importing from other SEO plugins.'),
    entry: 'dist/admin/tools.js',
  });
  api.settings.register('titles', { type: 'object', option: 'wpseo_titles', default: TITLE_DEFAULTS, page, sanitize: objectSanitizer(TITLE_DEFAULTS) });
  api.settings.register('social', {
    type: 'object',
    option: 'wpseo_social',
    default: SOCIAL_DEFAULTS,
    page,
    sanitize: (value) => {
      const out = objectSanitizer(SOCIAL_DEFAULTS)(value);
      for (const key of ['facebook_site', 'og_default_image']) {
        if (typeof out[key] === 'string' && out[key] && !/^https?:\/\//i.test(out[key] as string)) {
          throw new Error(__('Use a full address, starting with https://.'));
        }
      }
      if (Array.isArray(out.other_social_urls)) {
        out.other_social_urls = (out.other_social_urls as string[]).filter((u) => /^https?:\/\//i.test(u));
      }
      return out;
    },
  });
  api.settings.register('wpseo', { type: 'object', option: 'wpseo', default: WPSEO_DEFAULTS, page, sanitize: objectSanitizer(WPSEO_DEFAULTS) });
  api.settings.register('settings', {
    type: 'object',
    default: OWN_DEFAULTS,
    page,
    sanitize: (value) => {
      const v = (value ?? {}) as Record<string, unknown>;
      const robots = String(v.robots_txt ?? '');
      if (robots.length > 5000) throw new Error(__('Keep the robots.txt additions under 5,000 characters.'));
      return {
        robots_txt: robots
          .split('\n')
          .map((l) => l.replace(/[<>]/g, '').trimEnd())
          .join('\n')
          .trim(),
        indexnow: typeof v.indexnow === 'boolean' ? v.indexnow : null,
        setup_done: v.setup_done === true,
        auto_redirects: v.auto_redirects !== false,
      };
    },
  });

  // Settings changes reach every page's head, the sitemaps, robots.txt and llms.txt.
  api.hooks.addAction('updated_option', async (name: unknown) => {
    if (SETTINGS_OPTIONS.includes(String(name))) await api.cache.purge([CACHE_TAG]);
  });
  api.hooks.addAction('added_option', async (name: unknown) => {
    if (SETTINGS_OPTIONS.includes(String(name))) await api.cache.purge([CACHE_TAG]);
  });
}

async function settingsPayload(api: PluginApi): Promise<SettingsPayload> {
  const [titles, social, wpseo, own, site] = await Promise.all([
    getTitles(api),
    getSocial(api),
    getWpseo(api),
    getOwn(api),
    getSite(api),
  ]);
  const types = ['post', 'page', 'attachment']
    .map((name) => api.postTypes.get(name))
    .filter((t) => t !== undefined);
  const taxonomies = ['category', 'post_tag']
    .map((name) => api.taxonomies.get(name))
    .filter((t) => t !== undefined);
  return {
    titles,
    social,
    wpseo,
    own: { ...own, indexnow_effective: indexNowEnabled(own, site), indexnow_key: await indexNowKey(api) },
    site: {
      name: site.name,
      description: site.description,
      home: site.home,
      public: site.public,
      postTypes: types.map((t) => ({ name: t.name, label: t.label })),
      taxonomies: taxonomies.map((t) => ({ name: t.name, label: t.label })),
    },
  };
}

/* --------------------------------------------------------------------- REST */

async function body(c: PluginRequestContext): Promise<Record<string, unknown>> {
  try {
    const json = await c.req.json();
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function registerRoutes(api: PluginApi, redirects: Redirects): void {
  const admin = (c: PluginRequestContext) => api.rest.userCan(c, 'manage_options');
  const editor = (c: PluginRequestContext) => api.rest.userCan(c, 'edit_posts');
  const fail = (error: unknown) => {
    if (error instanceof RedirectError) return restError(400, error.code, error.message);
    throw error;
  };

  api.rest.registerRoute(NS, '/settings', { permission: admin, handler: () => settingsPayload(api) });

  api.rest.registerRoute(NS, '/redirects', {
    methods: ['GET', 'POST'],
    permission: admin,
    handler: async (c) => {
      if (c.req.method === 'POST') {
        try {
          return c.json(await redirects.create((await body(c)) as unknown as RedirectInput), 201);
        } catch (error) {
          return fail(error);
        }
      }
      const items = await redirects.list({
        search: c.req.query('search') || undefined,
        after: Number(c.req.query('after')) || 0,
        limit: Number(c.req.query('per_page')) || 50,
      });
      return { items, total: await redirects.count() };
    },
  });
  api.rest.registerRoute(NS, '/redirects/:id{[0-9]+}', {
    methods: ['GET', 'PUT', 'PATCH', 'POST', 'DELETE'],
    permission: admin,
    handler: async (c) => {
      const id = Number(c.req.param('id'));
      const missing = () => restError(404, 'pressbase_seo_redirect_not_found', 'That redirect doesn’t exist.');
      if (c.req.method === 'GET') return (await redirects.get(id)) ?? missing();
      if (c.req.method === 'DELETE') {
        const deleted = await redirects.delete(id);
        return deleted ? { deleted: true, previous: deleted } : missing();
      }
      try {
        return (await redirects.update(id, (await body(c)) as unknown as RedirectInput)) ?? missing();
      } catch (error) {
        return fail(error);
      }
    },
  });
  api.rest.registerRoute(NS, '/redirects/export', {
    permission: admin,
    handler: async () => {
      const all = [];
      let after = 0;
      for (;;) {
        const page = await redirects.list({ after, limit: 500 });
        all.push(...page);
        if (page.length < 500) break;
        after = page[page.length - 1]?.id ?? after;
      }
      return new Response(toCsv(all), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="redirects.csv"',
        },
      });
    },
  });
  api.rest.registerRoute(NS, '/redirects/import', {
    methods: 'POST',
    permission: admin,
    handler: async (c) => {
      const csv = String((await body(c)).csv ?? '');
      if (!csv.trim()) return restError(400, 'pressbase_seo_empty_csv', 'Choose a CSV file with redirects.');
      return redirects.upsertMany(rulesFromCsv(csv).slice(0, 10000));
    },
  });

  api.rest.registerRoute(NS, '/404s', {
    methods: ['GET', 'DELETE'],
    permission: admin,
    handler: async (c) => {
      if (c.req.method === 'DELETE') {
        await redirects.delete404();
        return { deleted: true };
      }
      return { items: await redirects.list404({ after: Number(c.req.query('after')) || 0, limit: Number(c.req.query('per_page')) || 50 }) };
    },
  });
  api.rest.registerRoute(NS, '/404s/:id{[0-9]+}', {
    methods: 'DELETE',
    permission: admin,
    handler: async (c) => {
      await redirects.delete404(Number(c.req.param('id')));
      return { deleted: true };
    },
  });

  api.rest.registerRoute(NS, '/import/:source{rankmath|aioseo}', {
    methods: 'POST',
    permission: admin,
    handler: async (c) => runImport(api, c.req.param('source') as ImportSource),
  });

  // For the editor's "title not used by another post" check.
  api.rest.registerRoute(NS, '/duplicates', {
    permission: editor,
    handler: async (c) => ({
      items: await duplicateTitles(api, c.req.query('title') ?? '', Number(c.req.query('exclude')) || 0),
    }),
  });

  // The editor's preview data that only the server knows: the site, separator and templates.
  api.rest.registerRoute(NS, '/editor', {
    permission: editor,
    handler: async () => {
      const [titles, social, site] = await Promise.all([getTitles(api), getSocial(api), getSite(api)]);
      return {
        home: site.home,
        siteName: site.name,
        siteDescription: site.description,
        separator: titles.separator,
        titles: Object.fromEntries(Object.entries(titles).filter(([k]) => /^(title|metadesc|noindex)-/.test(k))),
        social: { default_image: social.og_default_image, twitter_card_type: social.twitter_card_type },
      };
    },
  });

  // The admin's strings in the site's language (the browser has no translation files).
  let strings: string[] | null = null;
  api.rest.registerRoute(NS, '/l10n', {
    permission: (c) => api.rest.currentUser(c) !== null,
    handler: async () => {
      const locale = api.i18n.locale();
      if (locale === 'en_US') return { locale, strings: {} };
      strings ??= JSON.parse(await readFile(path.join(api.plugin.dir, 'dist/admin-strings.json'), 'utf8')) as string[];
      const out: Record<string, string> = {};
      for (const s of strings) {
        const t = api.i18n.__(s);
        if (t !== s) out[s] = t;
      }
      return { locale, strings: out };
    },
  });
}

/* -------------------------------------------------------------------- CLI */

function registerCli(api: PluginApi): void {
  api.cli.addCommand(
    'pressbase-seo audit',
    async (args, assoc, io) => {
      const ids = args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const posts: Post[] = [];
      if (ids.length) {
        for (const id of ids) {
          const post = await api.content.posts.get(id);
          if (!post) return io.error(`Post ${id} doesn’t exist.`);
          posts.push(post);
        }
      } else {
        for (let paged = 1; ; paged++) {
          const result = await api.content.query({ post_type: ['post', 'page'], post_status: 'publish', posts_per_page: 100, paged });
          posts.push(...result.posts);
          if (paged >= result.maxPages || !result.posts.length) break;
        }
      }
      const rows: Record<string, unknown>[] = [];
      for (const post of posts) {
        for (const check of await auditPost(api, post)) {
          if (check.status === 'na' && !assoc.all) continue;
          rows.push({ post: post.id, check: check.id, status: check.status, message: check.message });
        }
      }
      if (!rows.length) {
        io.success('Nothing to check.');
        return;
      }
      io.formatItems(rows, ['post', 'check', 'status', 'message']);
    },
    {
      shortdesc: 'Runs the SEO content checks on posts and prints what could be better.',
      synopsis: '[<post-id>...] [--all] [--format=<format>]',
      longdesc: 'Without IDs, checks every published post and page. --all also lists checks that don’t apply.',
    },
  );
}

/* ------------------------------------------------------------- the plugin */

export default definePlugin(async (api) => {
  const redirects = new Redirects(api);
  registerMeta(api);
  registerHead(api);
  registerSitemaps(api);
  registerRobotsTxt(api);
  registerLlmsTxt(api);
  await registerIndexNow(api);
  registerRedirects(api, redirects);
  registerBreadcrumbs(api);
  registerSettings(api);
  registerRoutes(api, redirects);
  registerSiteHealth(api);
  registerCli(api);
  registerAbilities(api);

  // Posts list filter: "Missing description".
  for (const type of ['post', 'page']) {
    api.hooks.addFilter(`rest_${type}_query`, async (args: unknown, params: unknown) => {
      const a = args as { post__not_in?: number[] };
      if ((params as Record<string, unknown>)['pressbase-seo-description'] !== 'missing' || !api.db) return args;
      const { sql, query } = api.db;
      const rows = await query<{ id: number | string }>(
        sql`select post_id as id from postmeta where key = ${META.metadesc} and coalesce(value #>> '{}', '') <> ''`,
      );
      return { ...a, post__not_in: [...(a.post__not_in ?? []), ...rows.map((r) => Number(r.id))] };
    });
  }
});

export const activate = defineLifecycle(async (api) => {
  if (!(await api.cron.nextScheduled('prune_404s'))) {
    await api.cron.scheduleEvent(Date.now() / 1000 + 3600, 'daily', 'prune_404s');
  }
});

export const uninstall = defineLifecycle(async (api) => {
  // Yoast's options and meta stay: they belong to the content, and another SEO plugin can use them.
  await api.db?.exec('drop table if exists pressbase_seo_redirects; drop table if exists pressbase_seo_404s;');
  for (const name of ['settings', 'indexnow_key']) await api.options.delete(name);
});

