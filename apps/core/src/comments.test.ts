import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { autop, ksesComment, relUgc } from './comments/format';
import { matchesWordList } from './comments/service';
import { setup } from './test-utils';

let ipCounter = 0;
/** Each visitor gets their own address, so flood control doesn't link them. */
const visitorHeaders = () => ({ 'x-forwarded-for': `203.0.113.${++ipCounter % 250}` });

async function site() {
  const ctx = await setup();
  await ctx.install();
  const [hello] = await ctx.kernel.db
    .select()
    .from(schema.posts)
    .where(eq(schema.posts.slug, 'hello-world'));
  if (!hello) throw new Error('No sample post.');
  const visitor = ctx.client();
  /** An anonymous comment through the REST API. */
  const comment = (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const own = visitorHeaders();
    return visitor.request(
      'POST',
      '/wp/v2/comments',
      // A fresh email each time too: flood control also matches on email.
      { post: hello.id, author_name: 'Ada', author_email: `ada${ipCounter}@example.com`, ...body },
      { ...own, ...headers },
    );
  };
  const setOptions = (values: Record<string, unknown>) =>
    ctx.request('POST', '/wp/v2/settings', values);
  // WordPress holds first-time commenters by default; most tests want them approved.
  await setOptions({ comment_previously_approved: false });
  const commentCount = async () =>
    (await ctx.kernel.posts.get(hello.id))?.commentCount ?? Number.NaN;
  return { ...ctx, hello, visitor, comment, setOptions, commentCount };
}

describe('comment text helpers', () => {
  it('filters visitor HTML to WordPress’s allowed tags and marks links ugc', () => {
    const html = ksesComment(
      '<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.test" rel="me">ok</a><script>alert(1)</script><img src=x></p>',
    );
    expect(html).not.toMatch(/script|onclick|javascript|<img|<p/);
    expect(relUgc(html)).toContain('<a href="https://ok.test" rel="me nofollow ugc">ok</a>');
  });

  it('turns blank lines into paragraphs and newlines into breaks', () => {
    expect(autop('One\ntwo\n\nThree')).toBe('<p>One<br />\ntwo</p>\n<p>Three</p>\n');
  });

  it('matches moderation words case-insensitively in any field', () => {
    expect(matchesWordList('\n casino \n', ['Hello', 'Visit my CASINO'])).toBe(true);
    expect(matchesWordList('', ['anything'])).toBe(false);
  });
});

describe('POST /wp/v2/comments', () => {
  it('accepts an anonymous comment, approved, and counts it', async () => {
    const { comment, commentCount, hello } = await site();
    expect(await commentCount()).toBe(1);
    const res = await comment({ content: 'Great post!', author_url: 'example.org' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe(`/wp-json/wp/v2/comments/${res.body.id}`);
    expect(res.body).toMatchObject({
      post: hello.id,
      parent: 0,
      author: 0,
      author_name: 'Ada',
      author_url: 'http://example.org/',
      status: 'approved',
      type: 'comment',
      content: { rendered: '<p>Great post!</p>\n' },
    });
    // Visitors get the view context: no email, IP or raw content.
    expect(res.body.author_email).toBeUndefined();
    expect(res.body.author_ip).toBeUndefined();
    expect(res.body.content.raw).toBeUndefined();
    expect(res.body.link).toMatch(new RegExp(`#comment-${res.body.id}$`));
    expect(res.body.author_avatar_urls['48']).toMatch(
      /^https:\/\/secure\.gravatar\.com\/avatar\/[0-9a-f]{64}\?s=48/,
    );
    expect(await commentCount()).toBe(2);
  });

  it('lets a visitor without a session post without the X-Pressbase-Request header, and nobody else', async () => {
    const { app, hello, kernel } = await site();
    const post = (headers: Record<string, string>, url = '/wp-json/wp/v2/comments') =>
      app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...visitorHeaders(), ...headers },
        body: JSON.stringify({
          post: hello.id,
          author_name: 'Grace',
          author_email: `grace${ipCounter}@example.com`,
          content: `No header ${ipCounter}`,
        }),
      });
    expect((await post({})).status).toBe(201);
    // A session cookie means ambient credentials: the header is required again.
    const withCookie = await post({ cookie: 'pressbase_session=whatever' });
    expect(withCookie.status).toBe(403);
    expect(((await withCookie.json()) as { code: string }).code).toBe(
      'pressbase_missing_request_header',
    );
    // Only creating is exempt.
    const [first] = (await kernel.comments.query({ status: 'any' })).comments;
    const del = await app.request(`/wp-json/wp/v2/comments/${first?.id}`, { method: 'DELETE' });
    expect(del.status).toBe(403);
  });

  it('requires name and email from visitors, and a post that is open', async () => {
    const { comment, request, hello, setOptions } = await site();
    const missing = await comment({ author_email: '', content: 'Hello' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('rest_comment_author_data_required');

    await setOptions({ require_name_email: false });
    expect((await comment({ author_name: '', author_email: '', content: 'Hello' })).status).toBe(
      201,
    );

    expect((await comment({ content: '   ' })).body.code).toBe('rest_comment_content_invalid');
    expect((await comment({ post: 9999, content: 'x' })).body.code).toBe(
      'rest_comment_invalid_post_id',
    );

    await request('POST', `/wp/v2/posts/${hello.id}`, { comment_status: 'closed' });
    const closed = await comment({ content: 'Too late' });
    expect(closed.status).toBe(403);
    expect(closed.body.code).toBe('rest_comment_closed');

    const draft = await request('POST', '/wp/v2/posts', { title: 'Draft', status: 'draft' });
    expect((await comment({ post: draft.body.id, content: 'Hi' })).body.code).toBe(
      'rest_comment_draft_post',
    );
  });

  it('closes comments on old posts when that setting is on', async () => {
    const { comment, kernel, hello, setOptions } = await site();
    await kernel.db
      .update(schema.posts)
      .set({ date: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(schema.posts.id, hello.id));
    expect((await comment({ content: 'Still open' })).status).toBe(201);
    await setOptions({ close_comments_for_old_posts: true, close_comments_days_old: 14 });
    expect((await comment({ content: 'Now closed' })).body.code).toBe('rest_comment_closed');
  });

  it('needs a login when comment_registration is on', async () => {
    const { comment, setOptions, loginAs, hello } = await site();
    await setOptions({ comment_registration: true });
    const res = await comment({ content: 'Let me in' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('rest_comment_login_required');

    // Logged-in users comment as themselves.
    const sub = await loginAs('reader', 'subscriber');
    const mine = await sub.request('POST', '/wp/v2/comments', {
      post: hello.id,
      content: 'Member here',
    });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ author: sub.id, author_name: 'reader' });
  });

  it('refuses duplicates with 409 and floods with 400', async () => {
    const { comment } = await site();
    const headers = { 'x-forwarded-for': '198.51.100.7' };
    expect((await comment({ content: 'Same words' }, headers)).status).toBe(201);
    const dupe = await comment({ content: 'Same words' }, { 'x-forwarded-for': '198.51.100.8' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('comment_duplicate');

    const flood = await comment(
      { author_name: 'Ada', author_email: 'other@example.com', content: 'Quick second thought' },
      headers,
    );
    expect(flood.status).toBe(400);
    expect(flood.body.code).toBe('comment_flood');
  });

  it('holds comments for moderation by setting, link count and moderation keys', async () => {
    const { comment, setOptions, commentCount } = await site();
    await setOptions({ comment_moderation: true });
    const held = await comment({ content: 'Please approve me' });
    expect(held.body.status).toBe('hold');
    expect(await commentCount()).toBe(1);

    await setOptions({ comment_moderation: false, comment_max_links: 2 });
    const links = await comment({
      author_email: 'links@example.com',
      content: '<a href="https://a.test">a</a> <a href="https://b.test">b</a>',
    });
    expect(links.body.status).toBe('hold');

    await setOptions({ comment_max_links: 0, moderation_keys: 'crypto\n' });
    const keyed = await comment({ author_email: 'k@example.com', content: 'Buy CRYPTO now' });
    expect(keyed.body.status).toBe('hold');
  });

  it('sends disallowed words to spam, even hidden in markup', async () => {
    const { comment, setOptions, request } = await site();
    await setOptions({ disallowed_keys: 'viagra' });
    const res = await comment({ content: 'Cheap <strong>via</strong>gra here' });
    expect(res.status).toBe(201);
    const stored = await request('GET', `/wp/v2/comments/${res.body.id}?context=edit`);
    expect(stored.body.status).toBe('spam');
  });

  it('auto-approves authors with a previously approved comment only', async () => {
    const { comment, setOptions, kernel } = await site();
    await setOptions({ comment_previously_approved: true });
    // Out of the flood window of the sample comment's author.
    await kernel.db.update(schema.comments).set({ date: new Date(Date.now() - 60_000) });
    // The sample comment's author has an approved comment already.
    const known = await comment({
      author_name: 'A Pressbase Commenter',
      author_email: 'commenter@pressbase.example',
      content: 'Back again',
    });
    expect(known.body.status).toBe('approved');
    const stranger = await comment({ author_email: 'new@example.com', content: 'First time' });
    expect(stranger.body.status).toBe('hold');
    expect((await kernel.comments.get(stranger.body.id))?.approved).toBe('0');
  });

  it('stores the IP address and user agent, shown to moderators only', async () => {
    const { comment, request, visitor } = await site();
    const res = await comment(
      { content: 'Tracking test' },
      { 'x-forwarded-for': '192.0.2.44', 'user-agent': 'TestAgent/1.0' },
    );
    const edit = await request('GET', `/wp/v2/comments/${res.body.id}?context=edit`);
    expect(edit.body).toMatchObject({
      author_ip: '192.0.2.44',
      author_user_agent: 'TestAgent/1.0',
      author_email: expect.stringMatching(/^ada\d+@example\.com$/),
      content: { raw: 'Tracking test' },
    });
    const denied = await visitor.request('GET', `/wp/v2/comments/${res.body.id}?context=edit`);
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('rest_forbidden_context');
  });

  it('filters HTML from visitors and keeps rich HTML out of rendered output', async () => {
    const { comment, request, hello } = await site();
    const res = await comment({
      content: '<strong>Bold</strong> <a href="https://x.test">link</a><script>alert(1)</script>',
    });
    const raw = (await request('GET', `/wp/v2/comments/${res.body.id}?context=edit`)).body.content
      .raw;
    expect(raw).toBe('<strong>Bold</strong> <a href="https://x.test" rel="nofollow ugc">link</a>');

    // Administrators keep raw HTML (unfiltered_html), but it never renders as script.
    const admin = await request('POST', '/wp/v2/comments', {
      post: hello.id,
      content: '<p>Admin</p><script>alert(2)</script>',
    });
    expect(admin.body.content.raw).toContain('<script>');
    expect(admin.body.content.rendered).not.toContain('<script>');
    expect(admin.body.author_name).toBe('admin');
  });
});

describe('threading, status and counts', () => {
  it('moves comments through hold, approve, spam, trash and back, keeping comment_count right', async () => {
    const { comment, request, commentCount, kernel } = await site();
    const res = await comment({ content: 'Moderate me' });
    const id = res.body.id;
    expect(await commentCount()).toBe(2);

    const setStatus = (status: string) => request('POST', `/wp/v2/comments/${id}`, { status });
    expect((await setStatus('hold')).body.status).toBe('hold');
    expect(await commentCount()).toBe(1);
    expect((await setStatus('approved')).body.status).toBe('approved');
    expect(await commentCount()).toBe(2);
    expect((await setStatus('spam')).body.status).toBe('spam');
    expect(await commentCount()).toBe(1);
    expect((await setStatus('unspam')).body.status).toBe('approved');

    const trashed = await request('DELETE', `/wp/v2/comments/${id}`);
    expect(trashed.body.status).toBe('trash');
    expect(String(await kernel.comments.getMeta(id, '_wp_trash_meta_status'))).toBe('1');
    expect(await commentCount()).toBe(1);
    expect((await request('DELETE', `/wp/v2/comments/${id}`)).body.code).toBe(
      'rest_already_trashed',
    );

    expect((await setStatus('untrash')).body.status).toBe('approved');
    expect(await kernel.comments.getMeta(id, '_wp_trash_meta_status')).toBeUndefined();
    expect(await commentCount()).toBe(2);

    const gone = await request('DELETE', `/wp/v2/comments/${id}?force=true`);
    expect(gone.body).toMatchObject({ deleted: true, previous: { id } });
    expect(await commentCount()).toBe(1);
    expect((await request('GET', `/wp/v2/comments/${id}`)).status).toBe(404);
  });

  it('fires WordPress’s comment hooks', async () => {
    const { comment, request, kernel } = await site();
    const fired: string[] = [];
    for (const name of [
      'preprocess_comment',
      'pre_comment_approved',
      'wp_insert_comment',
      'comment_post',
      'transition_comment_status',
      'wp_set_comment_status',
      'trash_comment',
      'trashed_comment',
      'edit_comment',
      'delete_comment',
      'deleted_comment',
    ]) {
      kernel.hooks.addFilter(name, (value: unknown) => {
        fired.push(name);
        return value;
      });
    }
    const res = await comment({ content: 'Hooked' });
    await request('POST', `/wp/v2/comments/${res.body.id}`, { content: 'Edited' });
    await request('DELETE', `/wp/v2/comments/${res.body.id}`);
    await request('DELETE', `/wp/v2/comments/${res.body.id}?force=true`);
    expect(new Set(fired)).toEqual(
      new Set([
        'preprocess_comment',
        'pre_comment_approved',
        'wp_insert_comment',
        'comment_post',
        'edit_comment',
        'trash_comment',
        'wp_set_comment_status',
        'transition_comment_status',
        'trashed_comment',
        'delete_comment',
        'deleted_comment',
      ]),
    );
  });

  it('lets pre_comment_approved decide the status', async () => {
    const { comment, kernel } = await site();
    kernel.hooks.addFilter('pre_comment_approved', () => '0');
    expect((await comment({ content: 'Filtered' })).body.status).toBe('hold');
  });

  it('threads replies, and re-parents them when a comment is deleted', async () => {
    const { comment, request, kernel } = await site();
    const top = await comment({ content: 'Top' });
    const reply = await comment({
      parent: top.body.id,
      author_email: 'b@example.com',
      content: 'Reply',
    });
    const deeper = await comment({
      parent: reply.body.id,
      author_email: 'c@example.com',
      content: 'Deeper',
    });
    expect(reply.body.parent).toBe(top.body.id);
    expect(reply.body._links['in-reply-to'][0].href).toBe(`/wp-json/wp/v2/comments/${top.body.id}`);

    const children = await request('GET', `/wp/v2/comments?parent=${top.body.id}`);
    expect(children.body.map((c: { id: number }) => c.id)).toEqual([reply.body.id]);

    await request('DELETE', `/wp/v2/comments/${reply.body.id}?force=true`);
    expect((await kernel.comments.get(deeper.body.id))?.parentId).toBe(top.body.id);
  });
});

describe('GET /wp/v2/comments', () => {
  it('shows visitors approved comments only, and moderators everything they ask for', async () => {
    const { comment, visitor, request, setOptions } = await site();
    await setOptions({ comment_moderation: true });
    await comment({ content: 'Pending one', author_email: 'p@example.com' });

    const publicList = await visitor.request('GET', '/wp/v2/comments');
    expect(publicList.body).toHaveLength(1);
    expect(publicList.headers.get('X-WP-Total')).toBe('1');

    const forbidden = await visitor.request('GET', '/wp/v2/comments?status=hold');
    expect(forbidden.status).toBe(401);
    expect(forbidden.body.code).toBe('rest_forbidden_param');

    const held = await request('GET', '/wp/v2/comments?status=hold&context=edit');
    expect(held.body).toHaveLength(1);
    expect(held.body[0]).toMatchObject({ status: 'hold', author_email: 'p@example.com' });

    const byEmail = await request('GET', '/wp/v2/comments?status=all&author_email=p@example.com');
    expect(byEmail.body).toHaveLength(1);

    const search = await request('GET', '/wp/v2/comments?status=all&search=pending');
    expect(search.body).toHaveLength(1);
  });

  it('keeps author_email and edit context to moderators', async () => {
    const { loginAs } = await site();
    const author = await loginAs('writer', 'author');
    const res = await author.request('GET', '/wp/v2/comments?author_email=a@example.com');
    expect(res.status).toBe(403);
    expect((await author.request('GET', '/wp/v2/comments?context=edit')).body.code).toBe(
      'rest_forbidden_context',
    );
  });

  it('pages, orders and filters by post', async () => {
    const { comment, request, hello } = await site();
    for (let i = 0; i < 3; i++) {
      await comment({ author_email: `n${i}@example.com`, content: `Comment ${i}` });
    }
    const page = await request('GET', `/wp/v2/comments?post=${hello.id}&per_page=2&order=asc`);
    expect(page.body).toHaveLength(2);
    expect(page.headers.get('X-WP-Total')).toBe('4');
    expect(page.headers.get('X-WP-TotalPages')).toBe('2');
    expect(page.headers.get('Link')).toContain('rel="next"');
  });
});

describe('who may edit comments', () => {
  it('lets moderators edit any comment, post authors comments on their posts, and nobody else', async () => {
    const { comment, loginAs, request } = await site();
    const res = await comment({ content: 'On the admin’s post' });
    const id = res.body.id;

    const editor = await loginAs('ed', 'editor');
    expect((await editor.request('POST', `/wp/v2/comments/${id}`, { status: 'hold' })).status).toBe(
      200,
    );

    const author = await loginAs('au', 'author');
    const denied = await author.request('POST', `/wp/v2/comments/${id}`, { content: 'Hacked' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_edit');
    expect((await author.request('DELETE', `/wp/v2/comments/${id}`)).body.code).toBe(
      'rest_cannot_delete',
    );

    // The author's own post: they may moderate its comments (edit_comment → edit_post).
    const own = await author.request('POST', '/wp/v2/posts', { title: 'Mine', status: 'publish' });
    const onOwn = await comment({ post: own.body.id, content: 'On the author’s post' });
    expect(
      (await author.request('POST', `/wp/v2/comments/${onOwn.body.id}`, { status: 'hold' })).body
        .status,
    ).toBe('hold');

    const sub = await loginAs('sub', 'subscriber');
    expect((await sub.request('DELETE', `/wp/v2/comments/${id}`)).status).toBe(403);
    expect((await request('GET', '/pressbase/v1/comment-counts')).body).toMatchObject({
      approved: 1,
      moderated: 2,
      mine: 0,
    });
    expect((await sub.request('GET', '/pressbase/v1/comment-counts')).status).toBe(403);
  });

  it('refuses posting as someone else unless you moderate', async () => {
    const { loginAs, hello } = await site();
    const author = await loginAs('impostor', 'author');
    const res = await author.request('POST', '/wp/v2/comments', {
      post: hello.id,
      author: 1,
      content: 'As the admin',
    });
    expect(res.body.code).toBe('rest_comment_invalid_author');
    const status = await author.request('POST', '/wp/v2/comments', {
      post: hello.id,
      status: 'approved',
      content: 'Approve myself',
    });
    expect(status.body.code).toBe('rest_comment_invalid_status');
  });
});

describe('POST /wp-comments-post', () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  it('accepts the classic form and redirects back to the comment', async () => {
    const { app, hello, kernel } = await site();
    const res = await app.request('/wp-comments-post', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...visitorHeaders() },
      body: form({
        comment_post_ID: String(hello.id),
        author: 'Lin',
        email: 'lin@example.com',
        url: '',
        comment: 'From the form',
        comment_parent: '0',
      }),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    const [latest] = (await kernel.comments.query({ status: 'any', orderby: 'id' })).comments;
    expect(location).toMatch(new RegExp(`/hello-world/#comment-${latest?.id}$`));
    expect(latest).toMatchObject({ author: 'Lin', approved: '1', content: 'From the form' });
  });

  it('adds a moderation hash for held comments, which shows the comment to its author', async () => {
    const { app, hello, setOptions, kernel } = await site();
    await setOptions({ comment_moderation: true });
    const res = await app.request('/wp-comments-post.php', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...visitorHeaders() },
      body: form({
        comment_post_ID: String(hello.id),
        author: 'Mo',
        email: 'mo@example.com',
        comment: 'Held for review',
        redirect_to: 'https://evil.example/steal',
      }),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.host).toBe('localhost:3000');
    const id = Number(location.searchParams.get('unapproved'));
    const hash = location.searchParams.get('moderation-hash') ?? '';
    expect(await kernel.comments.unapprovedEmail(id, hash)).toBe('mo@example.com');
    expect(await kernel.comments.unapprovedEmail(id, 'wrong')).toBeUndefined();

    const html = await kernel.blocks.render(
      '<!-- wp:comment-template --><!-- wp:comment-content /--><!-- /wp:comment-template -->',
      {
        context: { postId: hello.id, postType: 'post' },
        query: { unapproved: String(id), 'moderation-hash': hash },
      },
    );
    expect(html).toContain('Your comment is awaiting moderation. This is a preview');
    const other = await kernel.blocks.render(
      '<!-- wp:comment-template --><!-- wp:comment-content /--><!-- /wp:comment-template -->',
      { context: { postId: hello.id, postType: 'post' } },
    );
    expect(other).not.toContain('Held for review');
  });

  it('answers errors with an escaped HTML page and WordPress’s status codes', async () => {
    const { app, hello, request } = await site();
    const send = (fields: Record<string, string>) =>
      app.request('/wp-comments-post', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...visitorHeaders() },
        body: form(fields),
      });
    const missing = await send({ comment_post_ID: String(hello.id), comment: 'No name' });
    expect(missing.status).toBe(400);
    const html = await missing.text();
    expect(html).toContain('Please fill in the required fields (name, email).');
    expect(html).toContain('Back to the post');

    expect((await send({ comment_post_ID: '999', comment: 'x' })).status).toBe(404);
    await request('POST', `/wp/v2/posts/${hello.id}`, { comment_status: 'closed' });
    const closed = await send({
      comment_post_ID: String(hello.id),
      author: '<b>x</b>',
      email: 'x@example.com',
      comment: 'closed?',
    });
    expect(closed.status).toBe(403);
  });
});

describe('comment blocks', () => {
  async function threaded() {
    const ctx = await site();
    const { comment } = ctx;
    const a = await comment({
      author_name: 'Alice',
      author_email: 'a@example.com',
      content: 'First <em>thought</em>',
    });
    const b = await comment({
      parent: a.body.id,
      author_name: 'Bob',
      author_email: 'b@example.com',
      content: 'A reply',
    });
    const c = await comment({
      parent: b.body.id,
      author_name: 'Cy',
      author_email: 'c@example.com',
      content: 'Deepest reply',
    });
    return { ...ctx, ids: [a.body.id, b.body.id, c.body.id] as const };
  }

  const TEMPLATE = `<!-- wp:comments {"tagName":"section"} -->
<div class="wp-block-comments"><!-- wp:comments-title {"showCommentsCount":true} /-->
<!-- wp:comment-template -->
<!-- wp:comment-author-name {"isLink":true} /-->
<!-- wp:comment-date /-->
<!-- wp:comment-content /-->
<!-- wp:comment-reply-link /-->
<!-- wp:comment-edit-link /-->
<!-- /wp:comment-template -->
<!-- wp:post-comments-form /--></div>
<!-- /wp:comments -->`;

  it('renders a threaded list with WordPress’s markup and classes', async () => {
    const { kernel, hello, ids } = await threaded();
    const html = await kernel.blocks.render(TEMPLATE, {
      context: { postId: hello.id, postType: 'post' },
    });
    expect(html).toContain('<div class="wp-block-comments">');
    expect(html).toContain(
      '<h2 id="comments" class="wp-block-comments-title">4 responses to &#8220;Hello world!&#8221;</h2>',
    );
    // The sample comment comes first (oldest first), then the thread.
    expect(html).toMatch(
      /<ol class="wp-block-comment-template"><li id="comment-\d+" class="comment odd alt thread-odd thread-alt depth-1">/,
    );
    expect(html).toContain(
      `<li id="comment-${ids[0]}" class="comment even thread-even depth-1 parent">`,
    );
    expect(html).toContain(
      `<ol><li id="comment-${ids[1]}" class="comment odd alt depth-2 parent">`,
    );
    expect(html).toContain(`<ol><li id="comment-${ids[2]}" class="comment even depth-3">`);
    expect(html).toContain('<div class="wp-block-comment-author-name">Alice</div>');
    expect(html).toContain('<div class="wp-block-comment-content"><p>First <em>thought</em></p>');
    expect(html).toMatch(
      /<div class="wp-block-comment-date"><time datetime="\d{4}-\d{2}-\d{2}T[^"]+">/,
    );
    expect(html).toContain(`replytocom=${ids[0]}#respond`);
    expect(html).toContain('class="comment-reply-link"');
    expect(html).toContain('aria-label="Reply to Alice"');
    // The form posts to the classic endpoint, with WordPress's ids and fields.
    expect(html).toContain(
      '<div id="respond" class="comment-respond wp-block-post-comments-form">',
    );
    expect(html).toContain('action="http://localhost:3000/wp-comments-post"');
    expect(html).toContain('<textarea id="comment" name="comment"');
    expect(html).toContain("name='comment_post_ID'");
    // Visitors see no edit links.
    expect(html).not.toContain('wp-block-comment-edit-link');
  });

  it('caps nesting at thread_comments_depth and stops reply links there', async () => {
    const { kernel, hello, ids, setOptions } = await threaded();
    await setOptions({ thread_comments_depth: 2 });
    const html = await kernel.blocks.render(TEMPLATE, {
      context: { postId: hello.id, postType: 'post' },
    });
    // Past the deepest level, replies are listed at that level (no third <ol>),
    // inside their parent's <li> exactly as WordPress prints them.
    expect(html).toContain(`<li id="comment-${ids[2]}" class="comment even depth-2">`);
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).not.toContain(`replytocom=${ids[1]}`);
    expect(html).not.toContain(`replytocom=${ids[2]}`);
    expect(html).toContain(`replytocom=${ids[0]}`);

    await setOptions({ thread_comments: false });
    const flat = await kernel.blocks.render(TEMPLATE, {
      context: { postId: hello.id, postType: 'post' },
    });
    expect(flat).not.toContain('comment-reply-link');
    expect(flat.match(/depth-1/g)).toHaveLength(4);
  });

  it('shows edit links to moderators, the reply form title and escapes authors', async () => {
    const { kernel, hello, comment, ids } = await threaded();
    await comment({
      author_name: '<script>x</script>Eve',
      author_email: 'e@example.com',
      content: 'hi',
    });
    const admin = await kernel.comments
      .get(ids[0])
      .then(() => kernel.db.select().from(schema.users));
    const user = await (await import('./auth/users')).loadUser(kernel, admin[0]?.id ?? 1);
    const html = await kernel.blocks.render(TEMPLATE, {
      context: { postId: hello.id, postType: 'post' },
      user,
      query: { replytocom: String(ids[1]) },
    });
    expect(html).toContain(`href="http://localhost:3000/admin/comments?c=${ids[0]}"`);
    expect(html).not.toContain('<script>x');
    expect(html).toContain('Leave a Reply to <a href="#comment-');
    expect(html).toContain(`id='comment_parent' value='${ids[1]}'`);
    expect(html).toContain('<p class="logged-in-as">Logged in as');
  });

  it('pages comments and links between pages', async () => {
    const { kernel, hello, comment, setOptions } = await site();
    for (let i = 0; i < 4; i++) {
      await comment({ author_email: `p${i}@example.com`, content: `Paged ${i}` });
    }
    await setOptions({
      page_comments: true,
      comments_per_page: 2,
      default_comments_page: 'oldest',
    });
    const markup = `<!-- wp:comments --><div class="wp-block-comments"><!-- wp:comment-template --><!-- wp:comment-content /--><!-- /wp:comment-template -->
<!-- wp:comments-pagination {"paginationArrow":"arrow"} --><!-- wp:comments-pagination-previous /--><!-- wp:comments-pagination-numbers /--><!-- wp:comments-pagination-next /--><!-- /wp:comments-pagination --></div><!-- /wp:comments -->`;
    const first = await kernel.blocks.render(markup, {
      context: { postId: hello.id, postType: 'post' },
    });
    expect(first).toContain(
      '<nav class="wp-block-comments-pagination" aria-label="Comments pagination">',
    );
    expect(first).toContain('<span aria-current="page" class="page-numbers current">1</span>');
    expect(first).toContain('/hello-world/comment-page-2/#comments');
    expect(first).toContain(
      "Newer Comments<span class='wp-block-comments-pagination-next-arrow is-arrow-arrow' aria-hidden='true'>→</span>",
    );
    expect(first).not.toContain('Older Comments');
    expect(first).toContain('Hi, this is a comment.');
    expect(first).not.toContain('Paged 3');

    const last = await kernel.blocks.render(markup, {
      context: { postId: hello.id, postType: 'post' },
      query: { cpage: '3' },
    });
    expect(last).toContain('Paged 3');
    expect(last).toContain('Older Comments');
    expect(last).not.toContain('Newer Comments');
  });

  it('renders latest comments and the comment form for closed posts', async () => {
    const { kernel, hello, comment, request } = await site();
    await comment({
      author_name: 'Zed',
      author_url: 'https://zed.test',
      content: 'Latest words here',
    });
    const latest = await kernel.blocks.render('<!-- wp:latest-comments {"commentsToShow":2} /-->');
    expect(latest).toContain(
      '<ol class="has-avatars has-dates has-excerpts wp-block-latest-comments">',
    );
    expect(latest).toContain(
      '<a class="wp-block-latest-comments__comment-author" href="https://zed.test/">Zed</a> on <a class="wp-block-latest-comments__comment-link"',
    );
    expect(latest).toContain('Hello world!</a>');
    expect(latest).toContain(
      "class='avatar avatar-48 photo wp-block-latest-comments__comment-avatar'",
    );
    expect(latest.match(/wp-block-latest-comments__comment"/g)).toHaveLength(2);

    await request('POST', `/wp/v2/posts/${hello.id}`, { comment_status: 'closed' });
    const form = await kernel.blocks.render('<!-- wp:post-comments-form /-->', {
      context: { postId: hello.id, postType: 'post' },
    });
    expect(form).toBe('');
  });
});
