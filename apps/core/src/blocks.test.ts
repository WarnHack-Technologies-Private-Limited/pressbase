import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

async function installed() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

type Ctx = Awaited<ReturnType<typeof installed>>;

async function createPost(ctx: Ctx, body: Record<string, unknown>, base = '/wp/v2/posts') {
  const res = await ctx.request('POST', base, { status: 'publish', ...body });
  if (res.status !== 201) throw new Error(`Create failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: number; link: string };
}

async function rendered(ctx: Ctx, id: number, base = '/wp/v2/posts'): Promise<string> {
  const res = await ctx.request('GET', `${base}/${id}`);
  expect(res.status).toBe(200);
  return res.body.content.rendered;
}

describe('content.rendered', () => {
  it('renders nested static blocks, latest posts and categories', async () => {
    const ctx = await installed();
    const news = await ctx.request('POST', '/wp/v2/categories', { name: 'News' });
    await createPost(ctx, { title: 'Alpha', categories: [news.body.id] });
    await createPost(ctx, { title: 'Beta' });
    const post = await createPost(ctx, {
      title: 'Overview',
      content:
        '<!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph --><!-- wp:latest-posts {"postsToShow":2,"displayPostDate":true,"order":"asc","orderBy":"title"} /--></div><!-- /wp:group -->\n\n<!-- wp:categories {"showPostCounts":true} /-->',
    });

    const html = await rendered(ctx, post.id);
    expect(html).not.toContain('<!-- wp:');
    // The layout block support adds WordPress's layout classes, as in content.rendered on WordPress.
    expect(html).toContain(
      '<div class="wp-block-group is-layout-flow wp-block-group-is-layout-flow"><p>Intro</p><ul class="wp-block-latest-posts__list has-dates wp-block-latest-posts is-layout-flow wp-block-latest-posts-is-layout-flow"><li><a class="wp-block-latest-posts__post-title" href="http://localhost:3000/',
    );
    // Ordered by title, two posts: Alpha, Beta.
    const titles = [...html.matchAll(/post-title" href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Alpha', 'Beta']);
    expect(html).toMatch(
      /<time datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30" class="wp-block-latest-posts__post-date">[A-Z][a-z]+ \d{1,2}, \d{4}<\/time>/,
    );
    expect(html).toContain(
      '<ul class="wp-block-categories-list wp-block-categories-taxonomy-category wp-block-categories">',
    );
    expect(html).toContain(
      `\t<li class="cat-item cat-item-${news.body.id}"><a href="http://localhost:3000/category/news/">News</a> (1)\n</li>\n`,
    );
    expect(html).toMatch(/>Uncategorized<\/a> \(\d\)/);

    // Revisions render the same way.
    const revisions = await ctx.request('GET', `/wp/v2/posts/${post.id}/revisions`);
    expect(revisions.body[0].content.rendered).toContain('wp-block-latest-posts__list');
  });

  it('gives post blocks the post they are rendered in as context', async () => {
    const ctx = await installed();
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Launch' });
    const post = await createPost(ctx, {
      title: 'Context matters',
      excerpt: 'A short summary.',
      tags: [tag.body.id],
      content:
        '<!-- wp:post-title {"isLink":true,"level":1} /--><!-- wp:post-date {"format":"Y"} /--><!-- wp:post-author-name /--><!-- wp:post-terms {"term":"post_tag","prefix":"Tags: "} /--><!-- wp:post-excerpt {"moreText":"Read on"} /-->',
    });
    const html = await rendered(ctx, post.id);
    expect(html).toContain(
      `<h1 class="wp-block-post-title"><a href="${post.link}" target="_self" >Context matters</a></h1>`,
    );
    expect(html).toMatch(
      /<div class="wp-block-post-date"><time datetime="[^"]+">\d{4}<\/time><\/div>/,
    );
    expect(html).toContain('<div class="wp-block-post-author-name">admin</div>');
    expect(html).toContain(
      '<div class="taxonomy-post_tag wp-block-post-terms"><span class="wp-block-post-terms__prefix">Tags: </span><a href="http://localhost:3000/tag/launch/" rel="tag">Launch</a></div>',
    );
    expect(html).toContain(
      `<div class="wp-block-post-excerpt"><p class="wp-block-post-excerpt__excerpt">A short summary.</p><p class="wp-block-post-excerpt__more-text"><a class="wp-block-post-excerpt__more-link" href="${post.link}">Read on</a></p></div>`,
    );
  });

  it('renders site, search, archives, tag cloud, page list and login blocks', async () => {
    const ctx = await installed();
    await ctx.kernel.options.set('blogdescription', 'Just another site');
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Cloudy' });
    await createPost(ctx, { title: 'Tagged', tags: [tag.body.id] });
    const post = await createPost(ctx, {
      title: 'Widgets',
      content: [
        '<!-- wp:site-title /-->',
        '<!-- wp:site-tagline /-->',
        '<!-- wp:search {"label":"Search","buttonText":"Go"} /-->',
        '<!-- wp:archives {"showPostCounts":true} /-->',
        '<!-- wp:archives {"displayAsDropdown":true} /-->',
        '<!-- wp:tag-cloud /-->',
        '<!-- wp:page-list /-->',
        '<!-- wp:loginout /-->',
      ].join('\n'),
    });
    const html = await rendered(ctx, post.id);
    expect(html).toContain(
      '<h1 class="wp-block-site-title"><a href="http://localhost:3000" target="_self" rel="home">Test Site</a></h1>',
    );
    expect(html).toContain('<p class="wp-block-site-tagline">Just another site</p>');
    expect(html).toContain(
      '<form role="search" method="get" action="http://localhost:3000/" class="wp-block-search__button-outside wp-block-search__text-button wp-block-search"><label class="wp-block-search__label" for="wp-block-search__input-1" >Search</label><div class="wp-block-search__inside-wrapper"><input class="wp-block-search__input" id="wp-block-search__input-1" placeholder="" value="" type="search" name="s" required />',
    );
    expect(html).toContain(
      '<button aria-label="Go" type="submit" class="wp-block-search__button wp-element-button">Go</button>',
    );
    expect(html).toMatch(
      /<ul class="wp-block-archives-list wp-block-archives">\t<li><a href='http:\/\/localhost:3000\/\d{4}\/\d{2}\/'>[A-Z][a-z]+ \d{4}<\/a>&nbsp;\(3\)<\/li>\n<\/ul>/,
    );
    expect(html).toContain(
      '<div class="wp-block-archives-dropdown wp-block-archives"><label for="wp-block-archives-1"',
    );
    expect(html).toContain('<option value="">Select Month</option>');
    expect(html).toMatch(
      /class="tag-cloud-link tag-link-\d+ tag-link-position-1" style="font-size: 8pt;" aria-label="Cloudy \(1 item\)">Cloudy<\/a>/,
    );
    expect(html).toContain(
      '<ul class="wp-block-page-list"><li class="wp-block-pages-list__item"><a class="wp-block-pages-list__item__link" href="http://localhost:3000/sample-page/">Sample Page</a></li></ul>',
    );
    // The REST request is made by the logged-in administrator.
    expect(html).toContain(
      '<div class="logged-in wp-block-loginout"><a href="http://localhost:3000/login?action=logout',
    );
    const visitor = ctx.client();
    expect(
      (await visitor.request('GET', `/wp/v2/posts/${post.id}`)).body.content.rendered,
    ).toContain(
      '<div class="logged-out wp-block-loginout"><a href="http://localhost:3000/login?redirect_to=',
    );
  });

  it('escapes user data printed by dynamic blocks', async () => {
    const ctx = await installed();
    await ctx.kernel.options.set('blogname', '<script>alert("name")</script>Site');
    // Administrators may save raw HTML in titles, as in WordPress.
    await createPost(ctx, { title: '<script>alert(1)</script>Evil <em>title</em>' });
    const [admin] = await ctx.kernel.db.select().from(schema.users);
    await ctx.kernel.db
      .update(schema.users)
      .set({ displayName: '<img src=x onerror=alert(2)>' })
      .where(eq(schema.users.id, admin!.id));
    const post = await createPost(ctx, {
      title: 'Listing',
      content:
        '<!-- wp:latest-posts {"displayAuthor":true,"postsToShow":1} /--><!-- wp:site-title {"isLink":false} /--><!-- wp:search {"placeholder":"\\" onfocus=\\"alert(3)"} /-->',
    });
    // The newest post is "Listing" itself; ask for the older one too.
    const html = await rendered(ctx, post.id);
    expect(html).not.toMatch(/<script|<img|onfocus="/);
    expect(html).toContain(
      '<div class="wp-block-latest-posts__post-author">by &lt;img src=x onerror=alert(2)&gt;</div>',
    );
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;Site');
    expect(html).toContain('placeholder="&quot; onfocus=&quot;alert(3)"');

    const list = await ctx.request('POST', '/wp/v2/block-renderer/core/latest-posts', {
      attributes: { postsToShow: 3 },
    });
    expect(list.body.rendered).toContain('Evil <em>title</em>');
    expect(list.body.rendered).not.toContain('<script');
  });

  it('runs render filters registered on the kernel hook bus', async () => {
    const ctx = await installed();
    ctx.kernel.hooks.addFilter('render_block', (content, parsed) =>
      parsed.blockName === 'core/paragraph' ? content.replace('<p>', '<p data-seen="1">') : content,
    );
    ctx.kernel.hooks.addFilter(
      'render_block_core/site-title',
      (content: unknown) => `${content}<!-- after -->`,
    );
    const post = await createPost(ctx, {
      title: 'Filtered',
      content: '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --><!-- wp:site-title /-->',
    });
    const html = await rendered(ctx, post.id);
    expect(html).toContain('<p data-seen="1">x</p>');
    expect(html).toMatch(/<\/h1><!-- after -->$/);
  });

  it('lets plugins register their own dynamic blocks', async () => {
    const ctx = await installed();
    ctx.kernel.blocks.registerBlockType('acme/greeting', {
      title: 'Greeting',
      attributes: { name: { type: 'string', default: 'reader' } },
      usesContext: ['postId'],
      render: (attributes, _content, block) =>
        `<p>Hello ${String(attributes.name)} of post ${String(block.context.postId)}</p>`,
    });
    const post = await createPost(ctx, { title: 'Hi', content: '<!-- wp:acme/greeting /-->' });
    expect(await rendered(ctx, post.id)).toBe(`<p>Hello reader of post ${post.id}</p>`);
    const type = await ctx.request('GET', '/wp/v2/block-types/acme/greeting');
    expect(type.body).toMatchObject({ name: 'acme/greeting', title: 'Greeting', is_dynamic: true });
  });
});

describe('/wp/v2/block-renderer', () => {
  it('needs edit_posts, or edit_post for a given post', async () => {
    const ctx = await installed();
    const visitor = ctx.client();
    const anon = await visitor.request('GET', '/wp/v2/block-renderer/core/archives');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('block_cannot_read');

    const subscriber = await ctx.loginAs('sub', 'subscriber');
    const denied = await subscriber.request('GET', '/wp/v2/block-renderer/core/archives');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('block_cannot_read');

    const contributor = await ctx.loginAs('con', 'contributor');
    const ok = await contributor.request('GET', '/wp/v2/block-renderer/core/archives?context=edit');
    expect(ok.status).toBe(200);
    expect(ok.body.rendered).toContain('wp-block-archives-list');

    // Someone else's post.
    const other = await contributor.request(
      'GET',
      '/wp/v2/block-renderer/core/post-title?post_id=1',
    );
    expect(other.status).toBe(403);
    expect(other.body.message).toBe('Sorry, you are not allowed to read blocks of this post.');
  });

  it('renders dynamic blocks with attributes and post context', async () => {
    const ctx = await installed();
    for (const title of ['One', 'Two', 'Three']) await createPost(ctx, { title });

    // GET: attributes from the query string, coerced to their types.
    const get = await ctx.request(
      'GET',
      '/wp/v2/block-renderer/core/latest-posts?context=edit&attributes[postsToShow]=2&attributes[displayPostDate]=true',
    );
    expect(get.status).toBe(200);
    expect(get.body.rendered.match(/<li>/g)).toHaveLength(2);
    expect(get.body.rendered).toContain('has-dates');

    // POST: attributes in the body.
    const post = await ctx.request('POST', '/wp/v2/block-renderer/core/latest-posts', {
      attributes: { postsToShow: 1, order: 'asc', orderBy: 'title' },
    });
    expect(post.body.rendered).toContain('>Hello world!</a>');

    const title = await ctx.request(
      'GET',
      '/wp/v2/block-renderer/core/post-title?post_id=1&attributes[level]=3',
    );
    expect(title.body).toEqual({ rendered: '<h3 class="wp-block-post-title">Hello world!</h3>' });
    // Without a post there is nothing to show.
    expect((await ctx.request('GET', '/wp/v2/block-renderer/core/post-title')).body.rendered).toBe(
      '',
    );
  });

  it('refuses static or unknown blocks and invalid attributes', async () => {
    const ctx = await installed();
    const unknown = await ctx.request('GET', '/wp/v2/block-renderer/acme/missing');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('block_invalid');

    ctx.kernel.blocks.registerBlockType('acme/static', { title: 'Static' });
    const notDynamic = await ctx.request('GET', '/wp/v2/block-renderer/acme/static');
    expect(notDynamic.status).toBe(404);
    expect(notDynamic.body.code).toBe('block_invalid');

    const badType = await ctx.request('POST', '/wp/v2/block-renderer/core/latest-posts', {
      attributes: { postsToShow: 'many' },
    });
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe('rest_invalid_param');
    expect(badType.body.data.params.attributes).toMatch(/postsToShow/);

    const extra = await ctx.request('POST', '/wp/v2/block-renderer/core/latest-posts', {
      attributes: { notAnAttribute: 1 },
    });
    expect(extra.status).toBe(400);
    expect(extra.body.data.params.attributes).toMatch(/notAnAttribute is not a valid property/);
  });
});

describe('/wp/v2/block-types', () => {
  it('lists registered blocks with their attributes for editors', async () => {
    const ctx = await installed();
    const res = await ctx.request('GET', '/wp/v2/block-types');
    expect(res.status).toBe(200);
    const latest = res.body.find((t: { name: string }) => t.name === 'core/latest-posts');
    expect(latest).toMatchObject({
      name: 'core/latest-posts',
      title: 'Latest Posts',
      category: 'widgets',
      is_dynamic: true,
      api_version: 3,
      attributes: {
        postsToShow: { type: 'number', default: 5 },
        displayPostDate: { type: 'boolean', default: false },
        className: { type: 'string' },
        lock: { type: 'object' },
      },
      keywords: ['recent posts'],
      uses_context: [],
      supports: { align: true, html: false },
      editor_script_handles: [],
    });
    expect(latest._links['https://api.w.org/render-block'][0].href).toBe(
      '/wp-json/wp/v2/block-renderer/core/latest-posts?context=edit',
    );
    const names = res.body.map((t: { name: string }) => t.name);
    for (const name of [
      'core/archives',
      'core/block',
      'core/categories',
      'core/loginout',
      'core/page-list',
      'core/post-author-name',
      'core/post-date',
      'core/post-excerpt',
      'core/post-terms',
      'core/post-title',
      'core/search',
      'core/site-tagline',
      'core/site-title',
      'core/tag-cloud',
    ]) {
      expect(names).toContain(name);
    }
    const title = res.body.find((t: { name: string }) => t.name === 'core/post-title');
    expect(title.uses_context).toEqual(['postId', 'postType', 'queryId']);
    const block = res.body.find((t: { name: string }) => t.name === 'core/block');
    expect(block.provides_context).toEqual({ 'pattern/overrides': 'content' });

    const one = await ctx.request('GET', '/wp/v2/block-types/core/search');
    expect(one.body.name).toBe('core/search');
    const byNamespace = await ctx.request('GET', '/wp/v2/block-types/core');
    expect(byNamespace.body.every((t: { name: string }) => t.name.startsWith('core/'))).toBe(true);
    const missing = await ctx.request('GET', '/wp/v2/block-types/core/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('rest_block_type_invalid');
  });

  it('is closed to people who cannot edit', async () => {
    const ctx = await installed();
    const anon = await ctx.client().request('GET', '/wp/v2/block-types');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('rest_block_type_cannot_view');
    const subscriber = await ctx.loginAs('sub', 'subscriber');
    expect((await subscriber.request('GET', '/wp/v2/block-types/core/search')).status).toBe(403);
  });
});

describe('/wp/v2/block-patterns', () => {
  it('returns built-in patterns with valid core block markup', async () => {
    const ctx = await installed();
    ctx.kernel.blocks.registerBlockPattern('acme/with-ref', {
      title: 'Wrapper',
      content: '<!-- wp:pattern {"slug":"pressbase/quote"} /-->',
    });
    const res = await ctx.request('GET', '/wp/v2/block-patterns/patterns');
    expect(res.status).toBe(200);
    const names = res.body.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pressbase/hero',
        'pressbase/two-columns-text',
        'pressbase/call-to-action',
        'pressbase/quote',
        'pressbase/about-me',
        'pressbase/image-and-text',
      ]),
    );
    const hero = res.body.find((p: { name: string }) => p.name === 'pressbase/hero');
    expect(Object.keys(hero)).toEqual([
      'name',
      'title',
      'content',
      'description',
      'viewport_width',
      'categories',
      'keywords',
      'source',
    ]);
    expect(hero.categories).toContain('banner');

    for (const pattern of res.body) {
      const blocks = parseBlocks(pattern.content);
      expect(serializeBlocks(blocks)).toBe(pattern.content);
      const walk = (list: ReturnType<typeof parseBlocks>): void => {
        for (const block of list) {
          if (block.blockName === null) expect(block.innerHTML.trim()).toBe('');
          else expect(block.blockName.startsWith('core/')).toBe(true);
          walk(block.innerBlocks);
        }
      };
      walk(blocks);
    }
    // core/pattern references are resolved for the editor.
    const wrapper = res.body.find((p: { name: string }) => p.name === 'acme/with-ref');
    expect(wrapper.content).toContain('<blockquote class="wp-block-quote">');
  });

  it('lists categories and needs edit rights', async () => {
    const ctx = await installed();
    const res = await ctx.request('GET', '/wp/v2/block-patterns/categories');
    expect(res.body).toContainEqual({
      name: 'call-to-action',
      label: 'Call to action',
      description: 'Sections whose purpose is to trigger a specific action.',
    });
    const anon = await ctx.client().request('GET', '/wp/v2/block-patterns/patterns');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('rest_cannot_view');
  });
});

describe('/wp/v2/blocks (synced patterns)', () => {
  it('creates, reads, updates and deletes patterns with WordPress fields', async () => {
    const ctx = await installed();
    const created = await ctx.request('POST', '/wp/v2/blocks', {
      title: 'Footer note',
      content: '<!-- wp:paragraph --><p>Thanks for reading.</p><!-- /wp:paragraph -->',
      status: 'publish',
      meta: { wp_pattern_sync_status: 'unsynced' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      type: 'wp_block',
      status: 'publish',
      title: { raw: 'Footer note' },
      content: {
        raw: '<!-- wp:paragraph --><p>Thanks for reading.</p><!-- /wp:paragraph -->',
        protected: false,
        block_version: 1,
      },
      wp_pattern_sync_status: 'unsynced',
      meta: {},
    });
    expect(created.body.content.rendered).toBeUndefined();
    expect(created.body.title.rendered).toBeUndefined();
    expect(created.body.excerpt).toBeUndefined();
    const id = created.body.id;

    const list = await ctx.request('GET', '/wp/v2/blocks');
    expect(list.body.map((b: { id: number }) => b.id)).toEqual([id]);
    expect(list.body[0].title).toEqual({ raw: 'Footer note' });

    const synced = await ctx.request('PATCH', `/wp/v2/blocks/${id}`, {
      meta: { wp_pattern_sync_status: '' },
    });
    expect(synced.body.wp_pattern_sync_status).toBe('');

    const invalid = await ctx.request('PATCH', `/wp/v2/blocks/${id}`, {
      meta: { wp_pattern_sync_status: 'sometimes' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('rest_invalid_param');

    const deleted = await ctx.request('DELETE', `/wp/v2/blocks/${id}?force=true`);
    expect(deleted.body.deleted).toBe(true);
  });

  it('keeps raw patterns from people who cannot edit posts', async () => {
    const ctx = await installed();
    const created = await ctx.request('POST', '/wp/v2/blocks', {
      title: 'Secret layout',
      content: '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->',
      status: 'publish',
    });
    const visitor = ctx.client();
    const list = await visitor.request('GET', '/wp/v2/blocks');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const one = await visitor.request('GET', `/wp/v2/blocks/${created.body.id}`);
    expect(one.status).toBe(401);

    // Creating a pattern needs publish_posts.
    const contributor = await ctx.loginAs('con', 'contributor');
    expect((await contributor.request('GET', `/wp/v2/blocks/${created.body.id}`)).status).toBe(200);
    const denied = await contributor.request('POST', '/wp/v2/blocks', { title: 'Mine' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_create');
  });

  it('renders core/block references and stops self-references', async () => {
    const ctx = await installed();
    const a = await createPost(ctx, { title: 'A', content: '' }, '/wp/v2/blocks');
    const b = await createPost(
      ctx,
      {
        title: 'B',
        content: `<!-- wp:paragraph --><p>B says hi</p><!-- /wp:paragraph --><!-- wp:block {"ref":${a.id}} /-->`,
      },
      '/wp/v2/blocks',
    );
    // A contains itself and B, which contains A again.
    await ctx.request('PATCH', `/wp/v2/blocks/${a.id}`, {
      content: `<!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>A here</p><!-- /wp:paragraph --><!-- wp:block {"ref":${a.id}} /--><!-- wp:block {"ref":${b.id}} /--></div><!-- /wp:group -->`,
    });
    const draft = await createPost(
      ctx,
      { title: 'Draft', status: 'draft', content: '<p>draft pattern</p>' },
      '/wp/v2/blocks',
    );
    const post = await createPost(ctx, {
      title: 'Uses patterns',
      content: `<!-- wp:block {"ref":${a.id}} /--><!-- wp:block {"ref":${draft.id}} /--><!-- wp:block {"ref":999999} /-->`,
    });
    const html = await rendered(ctx, post.id);
    expect(html).toBe(
      '<div class="wp-block-group is-layout-flow wp-block-group-is-layout-flow"><p>A here</p><p>B says hi</p></div>',
    );
  });
});
