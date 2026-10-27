import { describe, expect, it } from 'vitest';
import { normalizeWhitespace } from './content/autosaves';
import { setup } from './test-utils';

async function installed() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const revisionsOf = async (
  request: Awaited<ReturnType<typeof installed>>['request'],
  id: number,
): Promise<{ slug: string; content: { raw: string } }[]> =>
  (await request('GET', `/wp/v2/posts/${id}/revisions`)).body;

describe('POST /wp/v2/{posts|pages}/:id/autosaves', () => {
  it("updates the author's own draft directly, without a revision", async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/posts', { title: 'Draft', content: 'one' });
    const before = await revisionsOf(request, post.body.id);

    const res = await request('POST', `/wp/v2/posts/${post.body.id}/autosaves`, {
      title: 'Draft, autosaved',
      content: '<!-- wp:paragraph --><p>two</p><!-- /wp:paragraph -->',
      excerpt: 'Short',
      status: 'publish', // ignored: autosaves only carry the revisioned fields
    });
    expect(res.status).toBe(200);
    // WordPress answers with the post itself, shaped as a revision.
    expect(res.body).toMatchObject({
      id: post.body.id,
      parent: 0,
      title: { raw: 'Draft, autosaved' },
      excerpt: { raw: 'Short' },
    });
    expect(res.body.preview_link).toContain('preview=true');

    const saved = await request('GET', `/wp/v2/posts/${post.body.id}?context=edit`);
    expect(saved.body.status).toBe('draft');
    expect(saved.body.content.raw).toContain('<p>two</p>');
    expect(await revisionsOf(request, post.body.id)).toHaveLength(before.length);
    expect((await request('GET', `/wp/v2/posts/${post.body.id}/autosaves`)).body).toEqual([]);
  });

  it('stores one autosave revision per user for published posts, updated in place', async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/posts', {
      title: 'Live',
      content: 'published words',
      status: 'publish',
    });
    const id = post.body.id;

    const first = await request('POST', `/wp/v2/posts/${id}/autosaves`, {
      content: 'edited words',
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      parent: id,
      slug: `${id}-autosave-v1`,
      title: { raw: 'Live' }, // untouched fields come from the post
      content: { raw: 'edited words' },
    });
    expect(first.body.preview_link).toContain(`preview_id=${id}`);

    const second = await request('POST', `/wp/v2/posts/${id}/autosaves`, {
      title: { raw: 'Live, again' },
      content: 'edited twice',
    });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.content.raw).toBe('edited twice');

    // The published post is unchanged.
    const live = await request('GET', `/wp/v2/posts/${id}?context=edit`);
    expect(live.body.content.raw).toBe('published words');

    const list = await request('GET', `/wp/v2/posts/${id}/autosaves?context=edit`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: first.body.id, title: { raw: 'Live, again' } });

    // Autosaves are revisions, so they are listed with the history too, as in WordPress.
    expect((await revisionsOf(request, id)).map((r) => r.slug)).toContain(`${id}-autosave-v1`);

    const one = await request('GET', `/wp/v2/posts/${id}/autosaves/${first.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(first.body.id);
    expect(one.body.content.raw).toBeUndefined(); // view context by default
  });

  it("keeps each user's autosave separate, and the author's draft safe from others", async () => {
    const { request, loginAs } = await installed();
    const draft = await request('POST', '/wp/v2/posts', { title: 'Shared', content: 'admin' });
    const editor = await loginAs('eden', 'editor');

    const theirs = await editor.request('POST', `/wp/v2/posts/${draft.body.id}/autosaves`, {
      content: 'editor changes',
    });
    expect(theirs.status).toBe(200);
    expect(theirs.body.parent).toBe(draft.body.id);
    expect(theirs.body.author).toBe(editor.id);
    // Someone else's draft is never overwritten by an autosave.
    const still = await request('GET', `/wp/v2/posts/${draft.body.id}?context=edit`);
    expect(still.body.content.raw).toBe('admin');

    await request('POST', `/wp/v2/posts/${draft.body.id}`, { status: 'pending' });
    const mine = await request('POST', `/wp/v2/posts/${draft.body.id}/autosaves`, {
      content: 'admin changes',
    });
    expect(mine.body.id).not.toBe(theirs.body.id);
    const list = await request('GET', `/wp/v2/posts/${draft.body.id}/autosaves`);
    expect(list.body).toHaveLength(2);
  });

  it('returns the existing autosave when nothing differs from the post', async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/pages', {
      title: 'About',
      content: 'Hello  there',
      status: 'publish',
    });
    const first = await request('POST', `/wp/v2/pages/${post.body.id}/autosaves`, {
      content: 'Changed',
    });
    const same = await request('POST', `/wp/v2/pages/${post.body.id}/autosaves`, {
      content: 'Hello there',
    });
    expect(same.body.id).toBe(first.body.id);
    expect(same.body.content.raw).toBe('Changed');
  });

  it('sanitises autosaves from users without unfiltered_html', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ari', 'author');
    const post = await author.request('POST', '/wp/v2/posts', {
      title: 'Mine',
      content: 'safe',
      status: 'publish',
    });
    const res = await author.request('POST', `/wp/v2/posts/${post.body.id}/autosaves`, {
      content: '<p>Hi</p><script>alert(1)</script>',
    });
    expect(res.status).toBe(200);
    expect(res.body.content.raw).not.toContain('<script>');
    // An administrator can read it; another author cannot.
    expect((await request('GET', `/wp/v2/posts/${post.body.id}/autosaves`)).body).toHaveLength(1);
    const other = await loginAs('bo', 'author');
    const denied = await other.request('GET', `/wp/v2/posts/${post.body.id}/autosaves`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_read');
    const write = await other.request('POST', `/wp/v2/posts/${post.body.id}/autosaves`, {
      content: 'x',
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('rest_cannot_edit');
  });

  it('answers with WordPress errors for missing posts and autosaves', async () => {
    const { request, client } = await installed();
    expect((await request('GET', '/wp/v2/posts/9999/autosaves')).body.code).toBe(
      'rest_post_invalid_parent',
    );
    const missing = await request('POST', '/wp/v2/posts/9999/autosaves', { content: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('rest_post_invalid_id');

    const post = await request('POST', '/wp/v2/posts', { title: 'x', status: 'publish' });
    const none = await request('GET', `/wp/v2/posts/${post.body.id}/autosaves/1`);
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('rest_post_no_autosave');

    // A page ID under /posts is not a post.
    const page = await request('POST', '/wp/v2/pages', { title: 'p' });
    expect((await request('GET', `/wp/v2/posts/${page.body.id}/autosaves`)).status).toBe(404);

    const visitor = client();
    const anonymous = await visitor.request('GET', `/wp/v2/posts/${post.body.id}/autosaves`);
    expect(anonymous.status).toBe(401);
    const bad = await request('POST', `/wp/v2/posts/${post.body.id}/autosaves`, { title: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');
  });

  it('deletes autosaves with the post', async () => {
    const { request } = await installed();
    const post = await request('POST', '/wp/v2/posts', { title: 'Bye', status: 'publish' });
    await request('POST', `/wp/v2/posts/${post.body.id}/autosaves`, { content: 'later' });
    await request('DELETE', `/wp/v2/posts/${post.body.id}?force=true`);
    const res = await request('GET', `/wp/v2/posts/${post.body.id}/autosaves`);
    expect(res.status).toBe(404);
  });
});

describe('normalizeWhitespace', () => {
  it('ignores differences WordPress ignores', () => {
    expect(normalizeWhitespace('  a\r\n\r\nb\t  c ')).toBe('a\nb c');
  });
});
