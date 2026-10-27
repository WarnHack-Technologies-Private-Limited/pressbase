import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/** A site with a published page, a draft, a private post, a category and a tag. */
async function site() {
  const ctx = await setup();
  await ctx.install();
  const { request } = ctx;
  const page = await request('POST', '/wp/v2/pages', {
    title: 'About the garden',
    status: 'publish',
  });
  const post = await request('POST', '/wp/v2/posts', {
    title: 'Garden notes',
    content: '<!-- wp:paragraph --><p>Tomatoes</p><!-- /wp:paragraph -->',
    status: 'publish',
  });
  await request('POST', '/wp/v2/posts', { title: 'Garden draft', status: 'draft' });
  await request('POST', '/wp/v2/posts', { title: 'Garden secrets', status: 'private' });
  const category = await request('POST', '/wp/v2/categories', { name: 'Gardening' });
  const tag = await request('POST', '/wp/v2/tags', { name: 'garden-tools' });
  return { ...ctx, page: page.body, post: post.body, category: category.body, tag: tag.body };
}

describe('GET /wp/v2/search', () => {
  it('finds published posts and pages with WordPress’s fields', async () => {
    const { client, page, post } = await site();
    const visitor = client();
    const res = await visitor.request('GET', '/wp/v2/search?search=garden');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-WP-Total')).toBe('2');
    expect(res.headers.get('X-WP-TotalPages')).toBe('1');
    const byId = Object.fromEntries(res.body.map((r: { id: number }) => [r.id, r]));
    expect(byId[page.id]).toEqual({
      id: page.id,
      title: 'About the garden',
      url: page.link,
      type: 'post',
      subtype: 'page',
      _links: {
        self: [{ embeddable: true, href: `/wp-json/wp/v2/pages/${page.id}` }],
        about: [{ href: '/wp-json/wp/v2/types/page' }],
        collection: [{ href: '/wp-json/wp/v2/search' }],
      },
    });
    expect(byId[post.id]).toMatchObject({ subtype: 'post', url: post.link });
  });

  it('never returns drafts or private posts, even to their author', async () => {
    const { request } = await site();
    const res = await request('GET', '/wp/v2/search?search=garden');
    const titles = res.body.map((r: { title: string }) => r.title);
    expect(titles).not.toContain('Garden draft');
    expect(titles).not.toContain('Garden secrets');
  });

  it('limits to subtypes, and `any` overrides the others', async () => {
    const { request, page } = await site();
    const pages = await request('GET', '/wp/v2/search?search=garden&subtype=page');
    expect(pages.body.map((r: { id: number }) => r.id)).toEqual([page.id]);
    const any = await request('GET', '/wp/v2/search?search=garden&subtype[]=page&subtype[]=any');
    expect(any.body).toHaveLength(2);
    // A taxonomy is a valid subtype, but not of the post handler.
    const none = await request('GET', '/wp/v2/search?search=garden&subtype=category');
    expect(none.body).toEqual([]);
    expect(none.headers.get('X-WP-Total')).toBe('0');
  });

  it('searches terms of every public taxonomy', async () => {
    const { client, category, tag } = await site();
    const res = await client().request('GET', '/wp/v2/search?type=term&search=garden');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: category.id,
        title: 'Gardening',
        url: category.link,
        type: 'category',
        _links: {
          self: [{ embeddable: true, href: `/wp-json/wp/v2/categories/${category.id}` }],
          about: [{ href: '/wp-json/wp/v2/taxonomies/category' }],
          collection: [{ href: '/wp-json/wp/v2/search' }],
        },
      },
      expect.objectContaining({ id: tag.id, title: 'garden-tools', type: 'post_tag' }),
    ]);
    const tags = await client().request(
      'GET',
      '/wp/v2/search?type=term&subtype=post_tag&search=garden',
    );
    expect(tags.body.map((r: { id: number }) => r.id)).toEqual([tag.id]);
  });

  it('paginates with WordPress headers and rejects pages past the end', async () => {
    const { request } = await site();
    const first = await request('GET', '/wp/v2/search?search=garden&per_page=1');
    expect(first.body).toHaveLength(1);
    expect(first.headers.get('X-WP-TotalPages')).toBe('2');
    expect(first.headers.get('Link')).toContain('rel="next"');
    const second = await request('GET', '/wp/v2/search?search=garden&per_page=1&page=2');
    expect(second.body[0].id).not.toBe(first.body[0].id);
    expect(second.headers.get('Link')).toContain('rel="prev"');
    const past = await request('GET', '/wp/v2/search?search=garden&per_page=1&page=3');
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('rest_search_invalid_page_number');
  });

  it('honours include and exclude', async () => {
    const { request, page, post } = await site();
    const include = await request('GET', `/wp/v2/search?include=${page.id}`);
    expect(include.body.map((r: { id: number }) => r.id)).toEqual([page.id]);
    const exclude = await request('GET', `/wp/v2/search?search=garden&exclude=${page.id}`);
    expect(exclude.body.map((r: { id: number }) => r.id)).toEqual([post.id]);
  });

  it('validates type, subtype and context', async () => {
    const { request } = await site();
    for (const query of ['type=user', 'subtype=nope', 'context=edit', 'per_page=101']) {
      const res = await request('GET', `/wp/v2/search?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe('rest_invalid_param');
    }
    expect((await request('GET', '/wp/v2/search?context=embed')).status).toBe(200);
  });

  it('finds no post formats, which Pressbase doesn’t have yet', async () => {
    const { request } = await site();
    const res = await request('GET', '/wp/v2/search?type=post-format&search=gallery');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lets plugins change the query through rest_post_search_query', async () => {
    const { request, kernel, page } = await site();
    kernel.hooks.addFilter('rest_post_search_query', (args) => ({
      ...(args as object),
      post_type: ['page'],
    }));
    const res = await request('GET', '/wp/v2/search?search=garden');
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([page.id]);
  });
});
