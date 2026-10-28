import type { PluginApi, Post } from '@pressbase/plugin-sdk';
import { plainText, trimText } from './html';
import { bool } from './shared';
import { CACHE_TAG, getOwn, getSite, getWpseo, indexNowEnabled } from './store';

/**
 * Crawling: robots.txt additions, llms.txt and IndexNow.
 */

/* --------------------------------------------------------------- robots.txt */

export function registerRobotsTxt(api: PluginApi): void {
  api.hooks.addFilter('robots_txt', async (output, isPublic) => {
    api.cache.addTags(CACHE_TAG);
    const extra = (await getOwn(api)).robots_txt.trim();
    if (!extra || !isPublic) return output;
    return `${String(output).replace(/\n*$/, '\n')}\n# Added in Settings → SEO\n${extra}\n`;
  });
}

/* ----------------------------------------------------------------- llms.txt */

function markdownLink(text: string, url: string): string {
  return `[${text.replace(/[[\]]/g, '')}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

/** llms.txt (llmstxt.org): the site, its key pages and recent posts, as Markdown. */
export async function buildLlmsTxt(api: PluginApi): Promise<string> {
  const site = await getSite(api);
  const lines = [`# ${site.name || site.home}`, ''];
  if (site.description) lines.push(`> ${site.description}`, '');
  const section = async (heading: string, posts: Post[]) => {
    if (!posts.length) return;
    lines.push(`## ${heading}`, '');
    for (const post of posts) {
      const url = await api.content.permalink(post);
      if (!url) continue;
      const summary = trimText(plainText(post.excerpt || post.content || ''), 160);
      lines.push(`- ${markdownLink(plainText(post.title) || url, url)}${summary ? `: ${summary}` : ''}`);
    }
    lines.push('');
  };
  const pages = await api.content.query({
    post_type: 'page',
    post_status: 'publish',
    has_password: false,
    orderby: 'menu_order',
    order: 'ASC',
    posts_per_page: 20,
    no_found_rows: true,
  });
  await section('Pages', pages.posts);
  const posts = await api.content.query({
    post_type: 'post',
    post_status: 'publish',
    has_password: false,
    posts_per_page: 20,
    no_found_rows: true,
  });
  await section('Recent posts', posts.posts);
  lines.push('## Optional', '', `- ${markdownLink('XML sitemap', `${site.home}/wp-sitemap.xml`)}`, '');
  return lines.join('\n');
}

export function registerLlmsTxt(api: PluginApi): void {
  api.public.addFile('/llms.txt', async () => {
    api.cache.addTags(CACHE_TAG);
    if (!bool((await getWpseo(api)).enable_llms_txt, false)) return null;
    return { body: await buildLlmsTxt(api), contentType: 'text/markdown; charset=utf-8' };
  });
}

/* ----------------------------------------------------------------- IndexNow */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Swappable in tests: the network is off there. */
export const indexNowTransport: { fetch: typeof fetch } = { fetch: (...args) => fetch(...args) };

export function newIndexNowKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function indexNowKey(api: PluginApi): Promise<string> {
  let key = await api.options.get<string>('indexnow_key', '');
  if (!/^[a-f0-9]{32}$/.test(key)) {
    key = newIndexNowKey();
    await api.options.set('indexnow_key', key);
  }
  return key;
}

/** Engines refuse private hosts, so local and test sites never ping. */
export function pingableHost(home: string): boolean {
  try {
    const { hostname, protocol } = new URL(home);
    return (
      /^https?:$/.test(protocol) &&
      hostname.includes('.') &&
      !/^(?:localhost|127\.|10\.|192\.168\.|.*\.local$|.*\.test$|.*\.invalid$)/.test(hostname)
    );
  } catch {
    return false;
  }
}

export async function registerIndexNow(api: PluginApi): Promise<void> {
  const key = await indexNowKey(api);
  api.public.addFile(`/${key}.txt`, () => key, { cache: false });

  api.jobs.register<{ urls: string[] }>(
    'indexnow',
    async (data, { signal }) => {
      const site = await getSite(api);
      if (!pingableHost(site.home) || !data.urls.length) return;
      const res = await indexNowTransport.fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: new URL(site.home).host,
          key,
          keyLocation: `${site.home}/${key}.txt`,
          urlList: data.urls,
        }),
        signal,
      });
      // 200/202 accepted; 422 means a URL isn't on this host, which retrying won't fix.
      if (!res.ok && res.status !== 422) throw new Error(`IndexNow answered ${res.status}.`);
    },
    { maxAttempts: 3, backoffSeconds: 300 },
  );

  const queue = async (post: Post, url?: string | false) => {
    const type = api.postTypes.get(post.type);
    if (!type?.public || post.type === 'attachment') return;
    const [own, site] = await Promise.all([getOwn(api), getSite(api)]);
    if (!indexNowEnabled(own, site)) return;
    const link = url ?? (await api.content.permalink(post));
    if (!link) return;
    await api.jobs.enqueue('indexnow', { urls: [link] }, { singletonKey: `indexnow:${link}` });
  };

  // Publish, update, unpublish (and trash): anything that changes a public URL.
  api.hooks.addAction('transition_post_status', async (next, previous, post) => {
    if (next === 'publish' || previous === 'publish') await queue(post as Post);
  });
  // Permanent deletion of a published post.
  api.hooks.addAction('before_delete_post', async (id) => {
    const post = await api.content.posts.get(Number(id));
    if (post?.status === 'publish') await queue(post);
  });
}
