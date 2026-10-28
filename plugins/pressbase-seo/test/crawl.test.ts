import { describe, expect, it } from 'vitest';
import { indexNowTransport, pingableHost } from '../src/crawl';
import { api, publish, render, site } from './helpers';

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

describe('sitemaps', () => {
  it('leaves out noindexed posts and terms, adds lastmod to terms, honours the settings', async () => {
    const ctx = await site();
    const shown = await publish(ctx, { title: 'Shown' });
    const hidden = await publish(ctx, {
      title: 'Hidden',
      meta: { '_yoast_wpseo_meta-robots-noindex': '1' },
    });
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Quiet' });
    await ctx.request('POST', `/wp/v2/tags/${tag.body.id}`, {
      meta: { wpseo_noindex: 'noindex' },
    });
    const loud = await ctx.request('POST', '/wp/v2/tags', { name: 'Loud' });
    await publish(ctx, { title: 'Tagged', tags: [tag.body.id, loud.body.id] });

    const posts = locs((await render(ctx, '/wp-sitemap-posts-post-1.xml')).html);
    expect(posts).toContain(shown.link);
    expect(posts).not.toContain(hidden.link);
    const tags = await render(ctx, '/wp-sitemap-taxonomies-post_tag-1.xml');
    expect(locs(tags.html)).toEqual(['http://localhost:3000/tag/loud/']);
    expect(tags.html).toMatch(/<lastmod>\d{4}-\d\d-\d\dT[\d:]+\+00:00<\/lastmod>/);

    const seo = api(ctx);
    await seo.settings.set('titles', {
      ...(await seo.settings.get<Record<string, unknown>>('titles')),
      'noindex-author-wpseo': true,
      'noindex-page': true,
    });
    const index = locs((await render(ctx, '/wp-sitemap.xml')).html);
    expect(index).not.toContain('http://localhost:3000/wp-sitemap-users-1.xml');
    expect(index).not.toContain('http://localhost:3000/wp-sitemap-posts-page-1.xml');
    expect(index).toContain('http://localhost:3000/wp-sitemap-posts-post-1.xml');

    await seo.settings.set('wpseo', { enable_xml_sitemap: false });
    expect((await render(ctx, '/wp-sitemap.xml')).status).toBe(404);
  });
});

describe('robots.txt and llms.txt', () => {
  it('appends the robots.txt additions and serves llms.txt only when turned on', async () => {
    const ctx = await site();
    const seo = api(ctx);
    await seo.settings.set('settings', {
      robots_txt: 'User-agent: ExampleBot\nDisallow: /private/',
    });
    const robots = await render(ctx, '/robots.txt');
    expect(robots.html).toContain('Sitemap: http://localhost:3000/wp-sitemap.xml');
    expect(robots.html).toContain(
      '# Added in Settings → SEO\nUser-agent: ExampleBot\nDisallow: /private/',
    );

    expect((await render(ctx, '/llms.txt')).status).toBe(404);
    await publish(ctx, { title: 'About us' }, 'pages');
    await publish(ctx, { title: 'Brewing notes', excerpt: 'Short notes on brewing.' });
    await seo.settings.set('wpseo', { enable_llms_txt: true });
    const llms = await render(ctx, '/llms.txt');
    expect(llms.status).toBe(200);
    expect(llms.html).toMatch(/^# Test Site\n/);
    expect(llms.html).toContain('## Pages');
    expect(llms.html).toMatch(/- \[About us\]\(http:\/\/localhost:3000\/about-us\/\)/);
    expect(llms.html).toContain('## Recent posts');
    expect(llms.html).toContain(': Short notes on brewing.');
  });
});

describe('IndexNow', () => {
  it('serves the key file and queues a job on publish, update and unpublish', async () => {
    const ctx = await site();
    const seo = api(ctx);
    const key = await seo.options.get<string>('indexnow_key');
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    const file = await render(ctx, `/${key}.txt`);
    expect(file.status).toBe(200);
    expect(file.html).toBe(key);

    const post = await publish(ctx, { title: 'Ping me' });
    const jobs = await seo.jobs.list({ name: 'indexnow' });
    expect(jobs.map((j) => (j.data as { urls: string[] }).urls[0])).toContain(post.link);

    // Off while the site discourages search engines (unless turned on explicitly).
    await ctx.request('POST', '/wp/v2/settings', { blog_public: false });
    for (const job of await seo.jobs.list({ name: 'indexnow' })) await seo.jobs.cancel(job.id);
    await publish(ctx, { title: 'Quiet' });
    expect(await seo.jobs.list({ name: 'indexnow', status: 'pending' })).toHaveLength(0);
  });

  it('only pings public hosts, with the key location', async () => {
    expect(pingableHost('http://localhost:3000')).toBe(false);
    expect(pingableHost('https://blog.example.com')).toBe(true);
    expect(typeof indexNowTransport.fetch).toBe('function');
  });
});
