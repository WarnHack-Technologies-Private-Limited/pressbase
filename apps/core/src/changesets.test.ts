import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadUser } from './auth/users';
import { PURGE_ACTION } from './cache/invalidation';
import { postEntityHandler } from './changesets/entities';
import { withChangesetPreview } from './changesets/preview';
import { queryPosts } from './content/query';
import { setup } from './test-utils';
import { userGlobalStylesPost } from './themes/global-styles';

/**
 * Changesets (ADR 0022): the customize_changeset post type, its REST routes,
 * publishing in one transaction, per-entry permissions, and previews with
 * ?changeset_uuid= (WP_Customize_Manager's save_changeset_post(),
 * _publish_changeset_values() and changeset previews).
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  const page = await ctx.kernel.posts.insert('page', {
    title: 'Opening hours',
    content: '<!-- wp:paragraph --><p>Open from nine until five.</p><!-- /wp:paragraph -->',
    status: 'publish',
    authorId: 1,
  });
  const menu = await ctx.kernel.posts.insert('wp_navigation', {
    title: 'Header',
    content: '<!-- wp:navigation-link {"label":"Our menu","url":"/menu/"} /-->',
    status: 'publish',
  });
  // Purges announced while the test runs.
  const purges: { tags: string[]; reason: string }[] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, (tags, reason) => {
    purges.push({ tags, reason });
  });
  return { ...ctx, page, menu, purges };
}

/** A public URL as anonymous visitors get it (no cookie). */
async function visit(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

/** A public URL as the logged-in administrator gets it. */
async function visitAsAdmin(ctx: Ctx, url: string) {
  const res = await ctx.request('GET', `/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return res.body as { status: number; headers: Record<string, string>; html: string };
}

/** Runs `fn` as a render of the changeset's preview would, as the administrator. */
async function inPreview<T>(ctx: Ctx, uuid: string, fn: () => Promise<T>): Promise<T> {
  const changeset = await ctx.kernel.changesets.find(uuid);
  const user = await loadUser(ctx.kernel, 1);
  if (!changeset || !user) throw new Error('No changeset.');
  return withChangesetPreview(await ctx.kernel.changesets.previewOf(changeset, user), fn);
}

const STYLE_EDIT = { styles: { color: { background: '#3a5a40' } } };

/** Styles, the header (site title and menu) and a page, in one changeset. */
function studioEdits(ctx: Awaited<ReturnType<typeof site>>) {
  return {
    'wp_global_styles:pressbase': STYLE_EDIT,
    'option:blogname': 'Corner Bakery',
    [`wp_navigation:${ctx.menu.id}`]: {
      content: '<!-- wp:navigation-link {"label":"Fresh bread","url":"/bread/"} /-->',
    },
    [`page:${ctx.page.id}`]: {
      content: '<!-- wp:paragraph --><p>Open from seven until three.</p><!-- /wp:paragraph -->',
    },
  };
}

async function startChangeset(ctx: Awaited<ReturnType<typeof site>>) {
  const res = await ctx.request('POST', '/pressbase/v1/changesets', { entries: studioEdits(ctx) });
  expect(res.status).toBe(201);
  return res.body.uuid as string;
}

describe('changesets: storage and REST', () => {
  it('starts one open changeset per user, an auto-draft with a UUID slug', async () => {
    const ctx = await site();
    const first = await ctx.request('POST', '/pressbase/v1/changesets', { title: 'Spring' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('auto-draft');
    expect(first.body.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.body.preview_link).toBe(
      `http://localhost:3000/?changeset_uuid=${first.body.uuid}`,
    );
    const post = await ctx.kernel.posts.get(first.body.id);
    expect(post).toMatchObject({ type: 'customize_changeset', slug: first.body.uuid });

    // A second request gets the open one back.
    const again = await ctx.request('POST', '/pressbase/v1/changesets', {});
    expect(again.status).toBe(200);
    expect(again.body.uuid).toBe(first.body.uuid);
    const list = await ctx.request('GET', '/pressbase/v1/changesets');
    expect(list.body.map((c: { uuid: string }) => c.uuid)).toEqual([first.body.uuid]);

    // customize_changeset_branching allows more than one.
    ctx.kernel.hooks.addFilter('customize_changeset_branching', () => true);
    const branch = await ctx.request('POST', '/pressbase/v1/changesets', {});
    expect(branch.status).toBe(201);
    expect(branch.body.uuid).not.toBe(first.body.uuid);
  });

  it('needs a logged-in user who can edit content', async () => {
    const ctx = await site();
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect((await subscriber.request('POST', '/pressbase/v1/changesets', {})).status).toBe(403);
    ctx.clearCookie();
    const anonymous = await ctx.request('POST', '/pressbase/v1/changesets', {});
    expect(anonymous.status).toBe(401);
  });

  it('stores entries as WordPress stores changeset settings, and removes them with null', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const res = await ctx.request('GET', `/pressbase/v1/changesets/${uuid}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
    expect(res.body.entries['option:blogname']).toMatchObject({
      value: 'Corner Bakery',
      type: 'option',
      user_id: 1,
    });
    expect(res.body.entries['wp_global_styles:pressbase'].value).toMatchObject({
      version: 3,
      isGlobalStylesUserThemeJSON: true,
      styles: STYLE_EDIT.styles,
    });
    const removed = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}`, {
      entries: { 'option:blogname': null },
      status: 'draft',
    });
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe('draft');
    expect(Object.keys(removed.body.entries)).not.toContain('option:blogname');
  });

  it('refuses invalid entries with their reasons, and saves none of them', async () => {
    const ctx = await site();
    const { body } = await ctx.request('POST', '/pressbase/v1/changesets', {});
    const res = await ctx.request('POST', `/pressbase/v1/changesets/${body.uuid}`, {
      entries: {
        'option:blogname': 'Fine',
        'option:admin_email': 'someone@example.com',
        'page:999999': { content: 'x' },
        [`page:${ctx.page.id}`]: { colour: 'blue' },
        'nonsense:1': {},
        'no-colon': {},
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('transaction_fail');
    expect(Object.keys(res.body.data.entries).sort()).toEqual(
      ['no-colon', 'nonsense:1', 'option:admin_email', `page:${ctx.page.id}`, 'page:999999'].sort(),
    );
    expect(res.body.data.entries['option:admin_email'].code).toBe('changeset_option_not_allowed');
    expect(res.body.data.entries['page:999999'].code).toBe('rest_post_invalid_id');
    const stored = await ctx.request('GET', `/pressbase/v1/changesets/${body.uuid}`);
    expect(stored.body.count).toBe(0);
  });

  it('checks permission per entry: an editor can change a page, not styles or options', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('editor', 'editor');
    const { body } = await editor.request('POST', '/pressbase/v1/changesets', {});
    const res = await editor.request('POST', `/pressbase/v1/changesets/${body.uuid}`, {
      entries: {
        [`page:${ctx.page.id}`]: { title: 'Hours' },
        'wp_global_styles:pressbase': STYLE_EDIT,
        'option:blogname': 'Mine now',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.data.entries).toEqual({
      'wp_global_styles:pressbase': expect.objectContaining({ code: 'changeset_entry_forbidden' }),
      'option:blogname': expect.objectContaining({ code: 'changeset_entry_forbidden' }),
    });
    const ok = await editor.request('POST', `/pressbase/v1/changesets/${body.uuid}`, {
      entries: { [`page:${ctx.page.id}`]: { title: 'Hours' } },
    });
    expect(ok.status).toBe(200);
    const published = await editor.request('POST', `/pressbase/v1/changesets/${body.uuid}/publish`);
    expect(published.status).toBe(200);
    expect((await ctx.kernel.posts.get(ctx.page.id))?.title).toBe('Hours');

    // A contributor's changeset is theirs alone: the editor can't open the
    // administrator's, which only edit_theme_options reaches.
    const admin = await ctx.request('POST', '/pressbase/v1/changesets', {});
    const peek = await editor.request('GET', `/pressbase/v1/changesets/${admin.body.uuid}`);
    expect(peek.status).toBe(403);
  });

  it('checks the publisher’s rights to every entry again', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('editor', 'editor');
    const { body } = await editor.request('POST', '/pressbase/v1/changesets', {
      entries: { [`page:${ctx.page.id}`]: { title: 'Hours' } },
    });
    expect(body.count).toBe(1);
    // The editor becomes an author, who can't edit someone else's page.
    await ctx.kernel.db
      .update(schema.usermeta)
      .set({ value: { author: true } })
      .where(and(eq(schema.usermeta.userId, editor.id), eq(schema.usermeta.key, 'capabilities')));
    const res = await editor.request('POST', `/pressbase/v1/changesets/${body.uuid}/publish`);
    expect(res.status).toBe(400);
    expect(res.body.data.entries[`page:${ctx.page.id}`].code).toBe('changeset_entry_forbidden');
    expect((await ctx.kernel.posts.get(ctx.page.id))?.title).toBe('Opening hours');
  });

  it('discards a changeset by trashing it, keeping its UUID', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const res = await ctx.request('DELETE', `/pressbase/v1/changesets/${uuid}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('trash');
    const post = await ctx.kernel.changesets.find(uuid);
    expect(post).toMatchObject({ status: 'trash', slug: uuid });
    expect((await ctx.request('GET', `/pressbase/v1/changesets/${uuid}`)).status).toBe(404);
    // Nothing was written, and the next changeset is a new one.
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');
    const next = await ctx.request('POST', '/pressbase/v1/changesets', {});
    expect(next.status).toBe(201);
    expect(next.body.uuid).not.toBe(uuid);
  });
});

describe('changesets: publishing', () => {
  it('keeps styles, header and page edits off the public site until publish, then shows them at once', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const pagePath = '/opening-hours/';

    const before = await visit(ctx, pagePath);
    expect(before.status).toBe(200);
    expect(before.html).toContain('Open from nine until five.');
    expect(before.html).toContain('Test Site');
    expect(before.html).toContain('Our menu');
    expect(before.html).not.toContain('#3a5a40');
    expect(ctx.purges).toEqual([]);

    const revisionsBefore = (await ctx.kernel.posts.revisions(ctx.page.id)).length;
    const res = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('publish');

    const after = await visit(ctx, pagePath);
    expect(after.html).toContain('Open from seven until three.');
    expect(after.html).toContain('Corner Bakery');
    expect(after.html).toContain('Fresh bread');
    expect(after.html).not.toContain('Our menu');
    expect(after.html).toContain('#3a5a40');

    // Revisions are recorded for the page, the menu and the global styles.
    expect((await ctx.kernel.posts.revisions(ctx.page.id)).length).toBe(revisionsBefore + 1);
    expect((await ctx.kernel.posts.revisions(ctx.menu.id)).length).toBeGreaterThan(0);
    const styles = await userGlobalStylesPost(ctx.kernel, 'pressbase');
    expect((await ctx.kernel.posts.revisions(styles?.id ?? 0)).length).toBeGreaterThan(0);

    // One purge, after commit, of every tag the entries made stale.
    expect(ctx.purges).toHaveLength(1);
    expect(ctx.purges[0]?.reason).toBe('changeset_publish');
    expect(ctx.purges[0]?.tags).toEqual(expect.arrayContaining(['site', `post:${ctx.page.id}`]));

    // A published changeset can't be changed or published again.
    const again = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}/publish`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('changeset_already_published');
    const edit = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}`, {
      entries: { 'option:blogname': 'Later' },
    });
    expect(edit.status).toBe(409);
  });

  it('rolls the whole publish back when one entry fails', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const stylesBefore = (await ctx.kernel.themes.active()).css;
    const revisionsBefore = (await ctx.kernel.posts.revisions(ctx.page.id)).length;
    // Options are written last: the page, the menu and the styles are already
    // written inside the transaction when the site title fails.
    let saw = 0;
    ctx.kernel.hooks.addAction('save_post_page', () => {
      saw++;
    });
    ctx.kernel.hooks.addFilter('pre_update_option_blogname', () => {
      throw new Error('The disk is full.');
    });

    const res = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}/publish`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('changeset_post_save_failure');
    expect(saw).toBe(1);

    // Nothing changed: not the database, not the cached options or styles.
    expect((await ctx.kernel.posts.get(ctx.page.id))?.content).toContain('nine until five');
    expect((await ctx.kernel.posts.get(ctx.menu.id))?.content).toContain('Our menu');
    expect((await ctx.kernel.posts.revisions(ctx.page.id)).length).toBe(revisionsBefore);
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');
    expect((await ctx.kernel.themes.active()).css).toEqual(stylesBefore);
    const page = await visit(ctx, '/opening-hours/');
    expect(page.html).toContain('Open from nine until five.');
    expect(page.html).not.toContain('#3a5a40');
    expect((await ctx.kernel.changesets.find(uuid))?.status).toBe('auto-draft');
    // No content purge; only the safety purge for what the failed attempt may have shown.
    expect(ctx.purges).toEqual([{ tags: ['site'], reason: 'changeset_rollback' }]);
  });

  it('refuses to publish when an entry no longer applies, writing nothing', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    await ctx.kernel.posts.delete(ctx.page.id);
    const res = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}/publish`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('transaction_fail');
    expect(Object.keys(res.body.data.entries)).toEqual([`page:${ctx.page.id}`]);
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');
    expect((await ctx.kernel.posts.get(ctx.menu.id))?.content).toContain('Our menu');
  });

  it('publishes a scheduled changeset when its date comes (status future)', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const soon = new Date(Date.now() + 3_600_000);
    const res = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}`, {
      status: 'draft',
      date_gmt: soon.toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('future');
    const past = await ctx.request('POST', `/pressbase/v1/changesets/${uuid}`, {
      date_gmt: '2020-01-01T00:00:00Z',
    });
    expect(past.body.code).toBe('not_future_date');
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');

    // publish_future_post's safety net, run as if the hour had passed.
    await ctx.kernel.posts.publishDue(new Date(soon.getTime() + 1000));
    expect((await ctx.kernel.changesets.find(uuid))?.status).toBe('publish');
    expect(await ctx.kernel.options.get('blogname')).toBe('Corner Bakery');
    expect((await ctx.kernel.posts.get(ctx.page.id))?.content).toContain('seven until three');
  });

  it('lets post types plug in with one registration, including posts it creates', async () => {
    const ctx = await site();
    // What templates and template parts do: create a post that doesn't exist
    // yet (a part customised from a theme file), found by slug and term.
    ctx.kernel.postTypes.register('test_part', {
      label: 'Parts',
      singularLabel: 'Part',
      capabilities: { create_posts: 'edit_theme_options', publish_posts: 'edit_theme_options' },
    });
    ctx.kernel.taxonomies.register('test_theme', ['test_part'], {
      label: 'Themes',
      singularLabel: 'Theme',
    });
    ctx.kernel.changesets.entities.register(
      postEntityHandler('test_part', {
        create: { terms: async () => ({ test_theme: ['pressbase'] }) },
      }),
    );
    const res = await ctx.request('POST', '/pressbase/v1/changesets', {
      entries: { 'test_part:header': { content: '<p>A new header</p>' } },
    });
    expect(res.status).toBe(201);
    const lookup = () =>
      queryPosts(ctx.kernel, {
        post_type: 'test_part',
        name: 'header',
        tax_query: [{ taxonomy: 'test_theme', field: 'slug', terms: ['pressbase'] }],
      });

    // In a preview, the lookup finds the part the changeset creates.
    const previewed = await inPreview(ctx, res.body.uuid, lookup);
    expect(previewed.posts).toHaveLength(1);
    expect(previewed.posts[0]).toMatchObject({ slug: 'header', content: '<p>A new header</p>' });
    expect(previewed.posts[0]?.id).toBeLessThan(0);
    expect((await lookup()).posts).toHaveLength(0);

    const published = await ctx.request('POST', `/pressbase/v1/changesets/${res.body.uuid}/publish`);
    expect(published.status).toBe(200);
    const found = await lookup();
    expect(found.posts).toHaveLength(1);
    expect(found.posts[0]).toMatchObject({ status: 'publish', content: '<p>A new header</p>' });
  });
});

describe('changesets: preview (?changeset_uuid=)', () => {
  it('renders the changeset for its editor, and nobody else', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    const url = `/opening-hours/?changeset_uuid=${uuid}`;

    const preview = await visitAsAdmin(ctx, url);
    expect(preview.status).toBe(200);
    expect(preview.html).toContain('Open from seven until three.');
    expect(preview.html).toContain('Corner Bakery');
    expect(preview.html).toContain('Fresh bread');
    expect(preview.html).toContain('#3a5a40');
    // Never cached, never indexed.
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['x-robots-tag']).toBe('noindex');
    expect(preview.html).toMatch(/<meta name='robots' content='[^']*noindex/);
    // The banner, with its ways out.
    expect(preview.html).toContain('id="pressbase-preview-banner"');
    expect(preview.html).toContain(
      `href="http://localhost:3000/admin/studio?changeset_uuid=${uuid}"`,
    );
    expect(preview.html).toContain('href="/opening-hours/">Exit preview</a>');
    // Links on the site stay in the preview.
    expect(preview.html).toContain(`/bread/?changeset_uuid=${uuid}`);

    // The same URL without the parameter, or for a visitor, is the live site.
    const plain = await visitAsAdmin(ctx, '/opening-hours/');
    expect(plain.html).toContain('Open from nine until five.');
    expect(plain.html).not.toContain('pressbase-preview-banner');
    const anonymous = await visit(ctx, url);
    expect(anonymous.status).toBe(200);
    expect(anonymous.html).toContain('Open from nine until five.');
    expect(anonymous.html).toContain('Test Site');
    expect(anonymous.html).not.toContain('#3a5a40');
    expect(anonymous.headers['cache-control']).toBe('private, no-store');

    // Someone who can't manage the changeset sees the live site.
    const editor = await ctx.loginAs('editor', 'editor');
    const other = await editor.request('GET', `/pressbase/v1/render?url=${encodeURIComponent(url)}`);
    expect(other.body.html).toContain('Open from nine until five.');

    // The page cache is untouched: no purge, no change to the cached theme or options.
    expect(ctx.purges).toEqual([]);
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');
    expect((await visit(ctx, '/')).html).not.toContain('#3a5a40');
  });

  it('shows a page the changeset publishes, and a new front page', async () => {
    const ctx = await site();
    const draft = await ctx.kernel.posts.insert('page', {
      title: 'Welcome',
      content: '<!-- wp:paragraph --><p>Fresh every morning.</p><!-- /wp:paragraph -->',
      status: 'draft',
      authorId: 1,
    });
    const res = await ctx.request('POST', '/pressbase/v1/changesets', {
      entries: {
        [`page:${draft.id}`]: { status: 'publish' },
        'option:show_on_front': 'page',
        'option:page_on_front': draft.id,
      },
    });
    const preview = await visitAsAdmin(ctx, `/?changeset_uuid=${res.body.uuid}`);
    expect(preview.html).toContain('Fresh every morning.');
    expect((await visit(ctx, '/')).html).not.toContain('Fresh every morning.');
    // The page list in a preview includes the page the changeset publishes.
    const { posts } = await inPreview(ctx, res.body.uuid, () =>
      queryPosts(ctx.kernel, { post_type: 'page', posts_per_page: -1 }),
    );
    expect(posts.map((p) => p.id)).toContain(draft.id);
  });

  it('ignores an unknown or published changeset', async () => {
    const ctx = await site();
    const uuid = await startChangeset(ctx);
    await ctx.request('POST', `/pressbase/v1/changesets/${uuid}/publish`);
    const published = await visitAsAdmin(ctx, `/?changeset_uuid=${uuid}`);
    expect(published.html).not.toContain('pressbase-preview-banner');
    const unknown = await visitAsAdmin(ctx, '/?changeset_uuid=not-a-uuid');
    expect(unknown.status).toBe(200);
    expect(unknown.headers['cache-control']).toBe('private, no-store');
  });
});
