import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { parseRestDate, toLocalString } from './content/dates';
import { renderBlocksAsStatic, sanitizePostContent, sanitizeSlug } from './content/sanitize';
import { setup } from './test-utils';

async function installed() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

describe('GET /wp/v2/posts', () => {
  it('lists published posts with WordPress fields and pagination headers', async () => {
    const { client, install } = await setup();
    await install();
    const visitor = client();
    const res = await visitor.request('GET', '/wp/v2/posts');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-WP-Total')).toBe('1');
    expect(res.headers.get('X-WP-TotalPages')).toBe('1');
    const [post] = res.body;
    expect(post).toMatchObject({
      slug: 'hello-world',
      status: 'publish',
      type: 'post',
      title: { rendered: 'Hello world!' },
      comment_status: 'open',
      sticky: false,
      format: 'standard',
      categories: [1],
      tags: [],
    });
    expect(post.content.rendered).toContain('<p>Welcome to Pressbase.');
    expect(post.content.rendered).not.toContain('<!-- wp:');
    expect(post.date_gmt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // Pretty permalink from the default structure.
    expect(post.link).toMatch(/^http:\/\/localhost:3000\/\d{4}\/\d{2}\/\d{2}\/hello-world\/$/);
    // Raw fields are for the edit context only.
    expect(post.title.raw).toBeUndefined();
  });

  it('keeps drafts private and refuses non-public statuses to visitors', async () => {
    const { client, install, request } = await setup();
    await install();
    await request('POST', '/wp/v2/posts', { title: 'Secret plan', status: 'draft' });

    const visitor = client();
    expect((await visitor.request('GET', '/wp/v2/posts')).body).toHaveLength(1);
    const forbidden = await visitor.request('GET', '/wp/v2/posts?status=draft');
    expect(forbidden.status).toBe(401);
    expect(forbidden.body.code).toBe('rest_forbidden_status');

    const drafts = await request('GET', '/wp/v2/posts?status=draft&context=edit');
    expect(drafts.body.map((p: { title: { raw: string } }) => p.title.raw)).toEqual([
      'Secret plan',
    ]);
  });

  it('searches, filters by taxonomy and paginates', async () => {
    const { request, install } = await setup();
    await install();
    const news = await request('POST', '/wp/v2/categories', { name: 'News' });
    for (const title of ['Alpha launch', 'Beta launch', 'Gamma notes']) {
      await request('POST', '/wp/v2/posts', {
        title,
        status: 'publish',
        categories: title.includes('launch') ? [news.body.id] : undefined,
      });
    }
    const search = await request('GET', '/wp/v2/posts?search=launch');
    expect(
      search.body.map((p: { title: { rendered: string } }) => p.title.rendered).sort(),
    ).toEqual(['Alpha launch', 'Beta launch']);

    const inNews = await request('GET', `/wp/v2/posts?categories=${news.body.id}`);
    expect(inNews.body).toHaveLength(2);
    const notInNews = await request('GET', `/wp/v2/posts?categories_exclude[]=${news.body.id}`);
    expect(notInNews.body).toHaveLength(2); // Gamma notes + Hello world

    const page2 = await request('GET', '/wp/v2/posts?per_page=3&page=2');
    expect(page2.headers.get('X-WP-Total')).toBe('4');
    expect(page2.headers.get('X-WP-TotalPages')).toBe('2');
    expect(page2.body).toHaveLength(1);
    expect(page2.headers.get('Link')).toContain('rel="prev"');

    const beyond = await request('GET', '/wp/v2/posts?per_page=3&page=3');
    expect(beyond.status).toBe(400);
    expect(beyond.body.code).toBe('rest_post_invalid_page_number');
  });

  it('lets plugins read their own parameters through rest_{post_type}_query', async () => {
    const { request, install, kernel } = await setup();
    await install();
    await request('POST', '/wp/v2/posts', { title: 'Short note', status: 'publish' });
    const seen: unknown[] = [];
    kernel.hooks.addFilter('rest_post_query', (args, params) => {
      seen.push((params as Record<string, unknown>)['daily-tips-length']);
      return (params as Record<string, unknown>)['daily-tips-length'] === 'note'
        ? { ...(args as object), s: 'note' }
        : args;
    });
    const res = await request('GET', '/wp/v2/posts?daily-tips-length=note');
    expect(res.status).toBe(200);
    expect(res.body.map((p: { title: { rendered: string } }) => p.title.rendered)).toEqual([
      'Short note',
    ]);
    expect(seen).toEqual(['note']);
    // Pages fire their own hook.
    await request('GET', '/wp/v2/pages?daily-tips-length=note');
    expect(seen).toEqual(['note']);
  });
});

describe('writing posts', () => {
  it('creates posts with unique slugs, terms and a Location header', async () => {
    const { request } = await installed();
    const tag = await request('POST', '/wp/v2/tags', { name: 'Launch Day' });
    expect(tag.body.slug).toBe('launch-day');

    const first = await request('POST', '/wp/v2/posts', {
      title: 'Hello world!',
      content: '<!-- wp:paragraph -->\n<p>Again</p>\n<!-- /wp:paragraph -->',
      status: 'publish',
      tags: [tag.body.id],
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('Location')).toBe(`/wp-json/wp/v2/posts/${first.body.id}`);
    expect(first.body.slug).toBe('hello-world-2');
    expect(first.body.tags).toEqual([tag.body.id]);
    // Posts without a category get the default one.
    expect(first.body.categories).toEqual([1]);
    expect((await request('GET', `/wp/v2/tags/${tag.body.id}`)).body.count).toBe(1);
  });

  it('accepts { raw } objects and local dates, and schedules future posts', async () => {
    const { request, kernel } = await installed();
    const res = await request('POST', '/wp/v2/posts', {
      title: { raw: 'Next year' },
      status: 'publish',
      date: '2099-01-01T09:00:00',
    });
    expect(res.body.status).toBe('future');
    expect(res.body.date).toBe('2099-01-01T09:00:00');
    expect(res.body.date_gmt).toBe('2099-01-01T03:30:00'); // site timezone is Asia/Kolkata

    expect((await request('GET', '/wp/v2/posts')).body).toHaveLength(1);
    // Once the date passes, the post publishes itself on the next query.
    await kernel.db
      .update(schema.posts)
      .set({ date: new Date(Date.now() - 1000) })
      .where(eq(schema.posts.id, res.body.id));
    const after = await request('GET', '/wp/v2/posts');
    expect(after.body.map((p: { id: number }) => p.id)).toContain(res.body.id);
  });

  it('trashes, restores and permanently deletes', async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/posts', { title: 'Short-lived', status: 'publish' });
    const id = post.body.id;

    const trashed = await request('DELETE', `/wp/v2/posts/${id}`);
    expect(trashed.body.status).toBe('trash');
    const again = await request('DELETE', `/wp/v2/posts/${id}`);
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('rest_already_trashed');

    // Restoring brings it back as a draft, with its slug, as WordPress 5.6+ does.
    const restored = await request('POST', `/wp/v2/posts/${id}`, { status: 'draft' });
    expect(restored.body).toMatchObject({ status: 'draft', slug: 'short-lived' });

    const gone = await request('DELETE', `/wp/v2/posts/${id}?force=true`);
    expect(gone.body.deleted).toBe(true);
    expect(gone.body.previous.id).toBe(id);
    expect((await request('GET', `/wp/v2/posts/${id}`)).status).toBe(404);
  });

  it('records revisions when content changes', async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/posts', { title: 'v1', content: 'one' });
    await request('POST', `/wp/v2/posts/${post.body.id}`, { content: 'two' });
    await request('POST', `/wp/v2/posts/${post.body.id}`, { comment_status: 'closed' }); // no content change
    const revisions = await request('GET', `/wp/v2/posts/${post.body.id}/revisions`);
    expect(revisions.body.map((r: { content: { raw: string } }) => r.content.raw)).toEqual([
      'two',
      'one',
    ]);
  });

  it('hides password-protected content from visitors', async () => {
    const { request, client } = await installed();
    const post = await request('POST', '/wp/v2/posts', {
      title: 'Members',
      content: '<p>Secret</p>',
      status: 'publish',
      password: 'open-sesame',
    });
    const visitor = client();
    const locked = await visitor.request('GET', `/wp/v2/posts/${post.body.id}`);
    expect(locked.body.content).toMatchObject({ rendered: '', protected: true });
    const wrong = await visitor.request('GET', `/wp/v2/posts/${post.body.id}?password=nope`);
    expect(wrong.status).toBe(401);
    const unlocked = await visitor.request(
      'GET',
      `/wp/v2/posts/${post.body.id}?password=open-sesame`,
    );
    expect(unlocked.body.content.rendered).toBe('<p>Secret</p>');
  });

  it('validates input with field-level errors', async () => {
    const { request } = await installed();
    const res = await request('POST', '/wp/v2/posts', {
      title: 'x',
      status: 'nonsense',
      categories: 'abc',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('rest_invalid_param');
    expect(res.body.data.params).toHaveProperty('status');
  });
});

describe('roles and permissions', () => {
  it('lets contributors draft but not publish or edit others', async () => {
    const { request, loginAs } = await installed();
    const contributor = await loginAs('casey', 'contributor');

    const draft = await contributor.request('POST', '/wp/v2/posts', { title: 'My idea' });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe('draft');
    expect(draft.body.author).toBe(contributor.id);

    const publish = await contributor.request('POST', `/wp/v2/posts/${draft.body.id}`, {
      status: 'publish',
    });
    expect(publish.status).toBe(403);
    expect(publish.body.code).toBe('rest_cannot_publish');

    const pending = await contributor.request('POST', `/wp/v2/posts/${draft.body.id}`, {
      status: 'pending',
    });
    expect(pending.body.status).toBe('pending');

    const hello = (await request('GET', '/wp/v2/posts')).body[0];
    const editOthers = await contributor.request('POST', `/wp/v2/posts/${hello.id}`, {
      title: 'Hacked',
    });
    expect(editOthers.status).toBe(403);
    expect(editOthers.body.code).toBe('rest_cannot_edit');

    // Writers may add tags while editing, but categories are managed by editors.
    expect((await contributor.request('POST', '/wp/v2/tags', { name: 'Idea' })).status).toBe(201);
    expect((await contributor.request('POST', '/wp/v2/categories', { name: 'Nope' })).status).toBe(
      403,
    );
  });

  it('lets authors publish their own posts only', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ari', 'author');
    const mine = await author.request('POST', '/wp/v2/posts', { title: 'Mine', status: 'publish' });
    expect(mine.body.status).toBe('publish');
    const edit = await author.request('POST', `/wp/v2/posts/${mine.body.id}`, {
      title: 'Still mine',
    });
    expect(edit.status).toBe(200);

    const hello = (await request('GET', '/wp/v2/posts?search=Hello')).body[0];
    expect((await author.request('DELETE', `/wp/v2/posts/${hello.id}`)).status).toBe(403);
    const asSomeoneElse = await author.request('POST', '/wp/v2/posts', { title: 'x', author: 1 });
    expect(asSomeoneElse.body.code).toBe('rest_cannot_edit_others');
  });

  it('filters HTML for users without unfiltered_html, keeping block markup', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ari', 'author');
    const content =
      '<!-- wp:paragraph {"align":"center"} -->\n<p onclick="steal()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">x</a></p>\n<!-- /wp:paragraph -->';
    const filtered = await author.request('POST', '/wp/v2/posts', {
      title: '<b>Bold</b><img src=x onerror=1>',
      content,
    });
    expect(filtered.body.content.raw).toBe(
      '<!-- wp:paragraph {"align":"center"} -->\n<p>Hi <a>x</a></p>\n<!-- /wp:paragraph -->',
    );
    expect(filtered.body.title.raw).toBe('<b>Bold</b>');

    // Administrators have unfiltered_html, as in WordPress.
    const raw = await request('POST', '/wp/v2/posts', {
      title: 't',
      content: '<p onclick="x()">ok</p>',
    });
    expect(raw.body.content.raw).toBe('<p onclick="x()">ok</p>');
  });
});

describe('pages', () => {
  it('supports hierarchy, menu order and nested permalinks', async () => {
    const { request } = await installed();
    const about = await request('POST', '/wp/v2/pages', { title: 'About', status: 'publish' });
    const team = await request('POST', '/wp/v2/pages', {
      title: 'Team',
      status: 'publish',
      parent: about.body.id,
      menu_order: 2,
    });
    expect(team.body).toMatchObject({ parent: about.body.id, menu_order: 2 });
    expect(team.body.link).toBe('http://localhost:3000/about/team/');
    expect(team.body.categories).toBeUndefined();

    const top = await request('GET', '/wp/v2/pages?parent=0&orderby=title&order=asc');
    expect(top.body.map((p: { title: { rendered: string } }) => p.title.rendered)).toEqual([
      'About',
      'Sample Page',
    ]);

    const loop = await request('POST', `/wp/v2/pages/${about.body.id}`, { parent: team.body.id });
    expect(loop.status).toBe(400);
    expect(loop.body.code).toBe('rest_post_invalid_parent');
  });

  it('keeps the same slug allowed under different parents', async () => {
    const { request } = await installed();
    const a = await request('POST', '/wp/v2/pages', { title: 'A', status: 'publish' });
    const b = await request('POST', '/wp/v2/pages', { title: 'B', status: 'publish' });
    const one = await request('POST', '/wp/v2/pages', {
      title: 'Contact',
      parent: a.body.id,
      status: 'publish',
    });
    const two = await request('POST', '/wp/v2/pages', {
      title: 'Contact',
      parent: b.body.id,
      status: 'publish',
    });
    expect([one.body.slug, two.body.slug]).toEqual(['contact', 'contact']);
  });
});

describe('categories and tags', () => {
  it('creates, updates and deletes terms with WordPress semantics', async () => {
    const { request } = await installed();
    const parent = await request('POST', '/wp/v2/categories', { name: 'Travel' });
    const child = await request('POST', '/wp/v2/categories', {
      name: 'Asia',
      parent: parent.body.id,
    });
    expect(child.body).toMatchObject({
      parent: parent.body.id,
      slug: 'asia',
      taxonomy: 'category',
    });
    expect(child.body.link).toBe('http://localhost:3000/category/asia/');

    const duplicate = await request('POST', '/wp/v2/categories', { name: 'travel' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toMatchObject({
      code: 'term_exists',
      data: { term_id: parent.body.id },
    });

    const renamed = await request('POST', `/wp/v2/categories/${child.body.id}`, {
      name: 'East Asia',
      slug: 'east-asia',
    });
    expect(renamed.body).toMatchObject({ name: 'East Asia', slug: 'east-asia' });

    const noForce = await request('DELETE', `/wp/v2/categories/${parent.body.id}`);
    expect(noForce.status).toBe(501);
    const deleted = await request('DELETE', `/wp/v2/categories/${parent.body.id}?force=true`);
    expect(deleted.body.deleted).toBe(true);
    // Children move up to the deleted term's parent.
    expect((await request('GET', `/wp/v2/categories/${child.body.id}`)).body.parent).toBe(0);
  });

  it('runs rest_prepare_{taxonomy} on each term', async () => {
    const ctx = await installed();
    ctx.kernel.hooks.addFilter('rest_prepare_post_tag', (item, term, context) => ({
      ...(item as object),
      extra: `${(term as { slug: string }).slug}:${context}`,
    }));
    const created = await ctx.request('POST', '/wp/v2/tags', { name: 'Green tea' });
    expect(created.body.extra).toBe('green-tea:edit');
    const list = await ctx.request('GET', '/wp/v2/tags');
    expect(list.body[0].extra).toBe('green-tea:view');
    const categories = await ctx.request('GET', '/wp/v2/categories');
    expect(categories.body[0].extra).toBeUndefined();
  });

  it('protects the default category and re-homes orphaned posts', async () => {
    const { request } = await installed();
    expect((await request('DELETE', '/wp/v2/categories/1?force=true')).status).toBe(403);

    const cat = await request('POST', '/wp/v2/categories', { name: 'Temporary' });
    const post = await request('POST', '/wp/v2/posts', {
      title: 'P',
      status: 'publish',
      categories: [cat.body.id],
    });
    expect(post.body.categories).toEqual([cat.body.id]);
    await request('DELETE', `/wp/v2/categories/${cat.body.id}?force=true`);
    expect((await request('GET', `/wp/v2/posts/${post.body.id}`)).body.categories).toEqual([1]);
  });

  it('counts only published posts', async () => {
    const { request } = await installed();
    const tag = await request('POST', '/wp/v2/tags', { name: 'Counted' });
    const post = await request('POST', '/wp/v2/posts', { title: 'Draft', tags: [tag.body.id] });
    expect((await request('GET', `/wp/v2/tags/${tag.body.id}`)).body.count).toBe(0);
    await request('POST', `/wp/v2/posts/${post.body.id}`, { status: 'publish' });
    expect((await request('GET', `/wp/v2/tags/${tag.body.id}`)).body.count).toBe(1);
    await request('DELETE', `/wp/v2/posts/${post.body.id}`);
    expect((await request('GET', `/wp/v2/tags/${tag.body.id}`)).body.count).toBe(0);
  });
});

describe('types, statuses and users', () => {
  it('describes post types and taxonomies', async () => {
    const { request } = await installed();
    const types = await request('GET', '/wp/v2/types?context=edit');
    expect(Object.keys(types.body)).toEqual(expect.arrayContaining(['post', 'page']));
    expect(types.body.page).toMatchObject({ hierarchical: true, rest_base: 'pages' });
    expect(types.body.post.capabilities.edit_posts).toBe('edit_posts');
    const taxonomies = await request('GET', '/wp/v2/taxonomies?type=post');
    expect(Object.keys(taxonomies.body).sort()).toEqual(['category', 'post_tag']);
  });

  it('shows visitors only public statuses and only published authors', async () => {
    const { client, loginAs, install } = await setup();
    await install();
    await loginAs('quiet', 'subscriber');
    const visitor = client();
    expect(Object.keys((await visitor.request('GET', '/wp/v2/statuses')).body)).toEqual([
      'publish',
    ]);
    const users = await visitor.request('GET', '/wp/v2/users');
    expect(users.body.map((u: { slug: string }) => u.slug)).toEqual(['admin']);
    expect(users.body[0].email).toBeUndefined();
  });
});

describe('content helpers', () => {
  it('sanitises HTML but keeps valid block delimiters', () => {
    const input =
      '<!-- wp:image {"id":5,"alt":"a--b"} /--><!-- wp:core/quote --><blockquote><p>q</p></blockquote><!-- /wp:core/quote --><!-- not a block -->';
    const out = sanitizePostContent(input);
    // "--" inside attributes is re-encoded, so the comment can't be closed early.
    expect(out).toContain('<!-- wp:image {"id":5,"alt":"a\\u002d\\u002db"} /-->');
    expect(out).toContain(
      '<!-- wp:core/quote --><blockquote><p>q</p></blockquote><!-- /wp:core/quote -->',
    );
    expect(out).not.toContain('not a block');
    expect(renderBlocksAsStatic(out)).toBe('<blockquote><p>q</p></blockquote>');

    // A "delimiter" that tries to break out of its comment is not a block: it is dropped.
    expect(
      sanitizePostContent('<!-- wp:image {"x":"--><script>alert(1)</script>"} /-->'),
    ).not.toContain('<script');
  });

  it('makes WordPress-style slugs', () => {
    expect(sanitizeSlug('Héllo, Wörld!  Again_and--again')).toBe('hello-world-again-and-again');
    expect(sanitizeSlug('<b>Tagged</b> &amp; title')).toBe('tagged-title');
  });

  it('converts between local and GMT dates', () => {
    expect(parseRestDate('2026-07-04T12:00:00', 'America/New_York', false)?.toISOString()).toBe(
      '2026-07-04T16:00:00.000Z',
    );
    expect(parseRestDate('2026-01-04T12:00:00', 'America/New_York', false)?.toISOString()).toBe(
      '2026-01-04T17:00:00.000Z',
    );
    expect(toLocalString(new Date('2026-10-27T10:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-10-27T15:30:00',
    );
    expect(parseRestDate('2026-10-27T10:00:00Z', 'Asia/Kolkata', false)?.toISOString()).toBe(
      '2026-10-27T10:00:00.000Z',
    );
    expect(parseRestDate('yesterday', 'UTC', false)).toBeUndefined();
  });
});
