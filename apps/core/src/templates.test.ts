import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURGE_ACTION } from './cache/invalidation';
import { setup } from './test-utils';
import {
  getBlockTemplate,
  getBlockTemplates,
  resolveBlockTemplate,
  saveBlockTemplate,
  TEMPLATE_PART_POST_TYPE,
} from './themes/templates';

/**
 * Templates and template parts (v0.8, Studio): the wp_template and
 * wp_template_part post types, get_block_templates() and friends, the
 * renderer and core/template-part preferring customised copies, and
 * /wp/v2/templates and /wp/v2/template-parts with revisions and autosaves.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A small block theme in the data directory: an index template, a header and a footer. */
async function plainTheme(ctx: Ctx) {
  const dir = path.join(ctx.dataDir, 'themes', 'plain');
  await mkdir(path.join(dir, 'templates'), { recursive: true });
  await mkdir(path.join(dir, 'parts'), { recursive: true });
  await writeFile(path.join(dir, 'style.css'), '/*\nTheme Name: Plain\nVersion: 1.0\n*/');
  await writeFile(
    path.join(dir, 'theme.json'),
    JSON.stringify({
      version: 3,
      templateParts: [
        { name: 'header', title: 'Header', area: 'header' },
        { name: 'footer', title: 'Footer', area: 'footer' },
      ],
      customTemplates: [{ name: 'landing', title: 'Landing', postTypes: ['page'] }],
    }),
  );
  await writeFile(
    path.join(dir, 'templates', 'index.html'),
    '<!-- wp:template-part {"slug":"header"} /-->\n<!-- wp:paragraph -->\n<p>Theme index</p>\n<!-- /wp:paragraph -->\n<!-- wp:template-part {"slug":"footer"} /-->\n',
  );
  await writeFile(
    path.join(dir, 'templates', 'landing.html'),
    '<!-- wp:paragraph -->\n<p>Theme landing</p>\n<!-- /wp:paragraph -->\n',
  );
  await writeFile(
    path.join(dir, 'parts', 'header.html'),
    '<!-- wp:paragraph -->\n<p>Theme header</p>\n<!-- /wp:paragraph -->\n',
  );
  await writeFile(
    path.join(dir, 'parts', 'footer.html'),
    '<!-- wp:paragraph -->\n<p>Theme footer</p>\n<!-- /wp:paragraph -->\n',
  );
  await ctx.kernel.themes.activate('plain');
}

async function site(theme: 'plain' | 'pressbase' = 'plain') {
  const ctx = await setup();
  await ctx.install();
  if (theme === 'plain') await plainTheme(ctx);
  return ctx;
}

async function render(ctx: Ctx, url = '/') {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return (await res.json()) as { status: number; html: string; tags: string[] };
}

/** Records the page cache purges core announces. */
function purges(ctx: Ctx) {
  const seen: { tags: string[]; reason: string }[] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, async (tags, reason) => {
    seen.push({ tags, reason });
  });
  return seen;
}

const block = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;

describe('template storage (wp_template, wp_template_part)', () => {
  it('registers the post types and taxonomies as WordPress does', async () => {
    const ctx = await site();
    const template = ctx.kernel.postTypes.get('wp_template');
    expect(template).toMatchObject({ public: false, showInRest: true, restBase: 'templates' });
    expect(template?.cap.edit_posts).toBe('edit_theme_options');
    expect(template?.cap.edit_post).toBe('edit_template');
    expect(template?.supports.has('revisions')).toBe(true);
    expect(ctx.kernel.postTypes.get('wp_template_part')?.restBase).toBe('template-parts');
    expect([...(ctx.kernel.taxonomies.get('wp_theme')?.objectTypes ?? [])]).toEqual([
      'wp_template',
      'wp_template_part',
      'wp_global_styles',
    ]);
    expect(ctx.kernel.taxonomies.get('wp_template_part_area')?.showInRest).toBe(false);
    const types = await ctx.request('GET', '/wp/v2/types');
    expect(types.body.wp_template?.rest_base ?? types.body.templates?.rest_base).toBeDefined();
  });

  it('lists theme files with source theme, and a customised copy in their place', async () => {
    const ctx = await site();
    const files = await getBlockTemplates(ctx.kernel);
    expect(files.map((t) => t.id).sort()).toEqual(['plain//index', 'plain//landing']);
    expect(files.find((t) => t.slug === 'index')).toMatchObject({
      source: 'theme',
      title: 'Index',
      isCustom: false,
      hasThemeFile: true,
      wpId: null,
    });
    expect(files.find((t) => t.slug === 'landing')).toMatchObject({
      title: 'Landing',
      isCustom: true,
      postTypes: ['page'],
    });

    await saveBlockTemplate(ctx.kernel, 'wp_template', 'plain//index', { content: block('Mine') });
    const after = await getBlockTemplates(ctx.kernel);
    const index = after.filter((t) => t.slug === 'index');
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ source: 'custom', origin: 'theme', hasThemeFile: true });
    expect(index[0]?.content).toContain('Mine');
    // The theme's file stays reachable.
    expect((await getBlockTemplate(ctx.kernel, 'plain//index'))?.source).toBe('custom');
  });

  it('renders a customised index template and header part instead of the theme’s, and brings the theme’s back on delete', async () => {
    const ctx = await site();
    const seen = purges(ctx);
    let page = await render(ctx);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Theme index');
    expect(page.html).toContain('Theme header');

    const index = await ctx.request('POST', '/wp/v2/templates/plain//index', {
      content: `<!-- wp:template-part {"slug":"header"} /-->\n${block('Custom index')}`,
    });
    expect(index.status).toBe(200);
    expect(index.body.source).toBe('custom');
    const header = await ctx.request('POST', '/wp/v2/template-parts/plain//header', {
      content: block('Custom header'),
    });
    expect(header.status).toBe(200);
    expect(header.body).toMatchObject({ source: 'custom', area: 'header', origin: 'theme' });
    // Both saves purge every cached page.
    expect(seen.filter((p) => p.tags.includes('site')).length).toBeGreaterThanOrEqual(2);

    page = await render(ctx);
    expect(page.html).toContain('Custom index');
    expect(page.html).not.toContain('Theme index');
    expect(page.html).toMatch(/<header class="wp-block-template-part">\s*<p>Custom header<\/p>/);
    expect(page.html).toContain('wp-block-template-index');

    seen.length = 0;
    const reset = await ctx.request('DELETE', '/wp/v2/templates/plain//index');
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe('trash');
    expect(seen.some((p) => p.tags.includes('site'))).toBe(true);
    const resetPart = await ctx.request('DELETE', '/wp/v2/template-parts/plain//header?force=true');
    expect(resetPart.status).toBe(200);
    expect(resetPart.body.deleted).toBe(true);
    expect(resetPart.body.previous.source).toBe('custom');

    page = await render(ctx);
    expect(page.html).toContain('Theme index');
    expect(page.html).toContain('Theme header');
    expect((await ctx.request('GET', '/wp/v2/templates/plain//index')).body.source).toBe('theme');
    // A theme file can't be deleted.
    const again = await ctx.request('DELETE', '/wp/v2/templates/plain//index');
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('rest_invalid_template');
  });

  it('shows visitors the theme’s file when a customised template is empty', async () => {
    const ctx = await site();
    await ctx.request('POST', '/wp/v2/templates/plain//index', { content: '' });
    const page = await render(ctx);
    expect(page.html).toContain('Theme index');
  });

  it('takes custom templates without a theme file into the hierarchy', async () => {
    const ctx = await site();
    const post = await ctx.kernel.posts.insert('post', {
      title: 'Opening hours',
      slug: 'opening-hours',
      status: 'publish',
    });
    const res = await ctx.request('POST', '/wp/v2/templates', {
      slug: 'single-post-opening-hours',
      content: block('Hours template'),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/wp-json/wp/v2/templates/plain//single-post-opening-hours',
    );
    expect(res.body).toMatchObject({
      id: 'plain//single-post-opening-hours',
      source: 'custom',
      origin: null,
      has_theme_file: false,
      is_custom: true,
      title: { raw: 'Post: Opening hours' },
      description: 'Template for Opening hours',
      original_source: 'user',
      author_text: 'admin',
    });
    const resolved = await resolveBlockTemplate(ctx.kernel, [
      'single-post-opening-hours',
      'single-post',
      'single',
      'singular',
      'index',
    ]);
    expect(resolved?.slug).toBe('single-post-opening-hours');
    const link = (await ctx.request('GET', `/wp/v2/posts/${post.id}`)).body.link as string;
    const page = await render(ctx, new URL(link).pathname);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Hours template');
    expect(page.html).not.toContain('Theme index');
  });

  it('keeps template slugs unique per theme, and as the file names them', async () => {
    const ctx = await site();
    await saveBlockTemplate(ctx.kernel, 'wp_template', null, {
      slug: 'index',
      theme: 'other-theme',
      content: block('Other'),
    });
    const { template } = await saveBlockTemplate(ctx.kernel, 'wp_template', 'plain//index', {
      content: block('Plain'),
    });
    expect(template.slug).toBe('index');
    expect(template.id).toBe('plain//index');
    expect((await getBlockTemplate(ctx.kernel, 'other-theme//index'))?.content).toContain('Other');
    // A second template with the same slug in the same theme gets a suffix.
    const dup = await saveBlockTemplate(ctx.kernel, 'wp_template', null, { slug: 'index' });
    expect(dup.template.slug).toBe('index-2');
    // Underscores and case survive (sanitize_title() keeps `_`).
    const format = await saveBlockTemplate(ctx.kernel, 'wp_template', null, {
      slug: 'taxonomy-post_format-post-format-aside',
    });
    expect(format.template.slug).toBe('taxonomy-post_format-post-format-aside');
    expect(format.template.isCustom).toBe(false);
    // Untitled: named after its term, as _build_block_template_result_from_post() does.
    expect(format.template.title).toBe('Not found: Format (post-format-aside)');
  });
});

describe('/wp/v2/templates and /wp/v2/template-parts', () => {
  it('lists templates and parts in WordPress’s shape', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp/v2/templates');
    expect(res.status).toBe(200);
    const index = res.body.find((t: { id: string }) => t.id === 'plain//index');
    expect(Object.keys(index)).toEqual([
      'id',
      'theme',
      'content',
      'slug',
      'source',
      'origin',
      'type',
      'description',
      'title',
      'status',
      'wp_id',
      'has_theme_file',
      'is_custom',
      'author',
      'modified',
      'date',
      'author_text',
      'original_source',
      '_links',
    ]);
    expect(index).toMatchObject({
      theme: 'plain',
      slug: 'index',
      source: 'theme',
      origin: null,
      type: 'wp_template',
      description:
        'Used as a fallback template for all pages when a more specific template is not defined.',
      title: { raw: 'Index', rendered: 'Index' },
      status: 'publish',
      wp_id: 0,
      has_theme_file: true,
      is_custom: false,
      author: 0,
      modified: null,
      date: null,
      author_text: 'Plain',
      original_source: 'theme',
    });
    expect(index.content.raw).toContain('Theme index');
    expect(index.content.block_version).toBeUndefined();
    expect(index._links.self[0].href).toBe(
      'http://localhost:3000/wp-json/wp/v2/templates/plain//index',
    );
    expect(index._links.about[0].href).toBe('http://localhost:3000/wp-json/wp/v2/types/wp_template');

    const pageTemplates = await ctx.request('GET', '/wp/v2/templates?post_type=page');
    expect(pageTemplates.body.map((t: { slug: string }) => t.slug)).toEqual(['landing']);

    const parts = await ctx.request('GET', '/wp/v2/template-parts?area=header');
    expect(parts.status).toBe(200);
    expect(parts.body).toHaveLength(1);
    expect(parts.body[0]).toMatchObject({
      id: 'plain//header',
      type: 'wp_template_part',
      area: 'header',
      title: { raw: 'Header' },
    });
    expect(parts.body[0].is_custom).toBeUndefined();
  });

  it('reads one template by id, also as theme/slug or URL-encoded, and the theme’s file with source=theme', async () => {
    const ctx = await site();
    for (const id of ['plain//index', 'plain/index', 'plain%2F%2Findex']) {
      const res = await ctx.request('GET', `/wp/v2/templates/${id}?context=edit`);
      expect(res.status, id).toBe(200);
      expect(res.body.id).toBe('plain//index');
      expect(res.body.content.block_version).toBe(1);
      expect(res.body._links.self[0].targetHints.allow).toContain('DELETE');
    }
    await ctx.request('POST', '/wp/v2/templates/plain//index', { content: block('Saved') });
    const file = await ctx.request('GET', '/wp/v2/templates/plain//index?source=theme');
    expect(file.body.source).toBe('theme');
    expect(file.body.content.raw).toContain('Theme index');
    const missing = await ctx.request('GET', '/wp/v2/templates/plain//nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('rest_template_not_found');
  });

  it('resolves pattern blocks in the content it returns', async () => {
    const ctx = await site('pressbase');
    const res = await ctx.request('GET', '/wp/v2/templates/pressbase//index');
    expect(res.status).toBe(200);
    expect(res.body.content.raw).not.toContain('<!-- wp:pattern');
    expect(res.body.content.raw).toContain('<!-- wp:query');
  });

  it('customises the Pressbase header on the home page', async () => {
    const ctx = await site('pressbase');
    const res = await ctx.request('POST', '/wp/v2/template-parts/pressbase//header', {
      content: block('Bakery opening hours'),
      title: 'Bakery header',
    });
    expect(res.status).toBe(200);
    expect(res.body.title.raw).toBe('Bakery header');
    const page = await render(ctx);
    expect(page.html).toContain('Bakery opening hours');
  });

  it('edits: a theme file becomes a copy, a copy is updated, source=theme resets it', async () => {
    const ctx = await site();
    const first = await ctx.request('PUT', '/wp/v2/templates/plain//index', {
      content: { raw: block('One') },
      title: { raw: '' },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      source: 'custom',
      origin: 'theme',
      title: { raw: 'Index' },
      description:
        'Used as a fallback template for all pages when a more specific template is not defined.',
      original_source: 'theme',
      author_text: 'Plain',
    });
    expect(first.body.wp_id).toBeGreaterThan(0);
    expect(first.body.modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    const second = await ctx.request('PATCH', '/wp/v2/templates/plain//index', {
      description: 'Shown when nothing else fits.',
    });
    expect(second.body.wp_id).toBe(first.body.wp_id);
    expect(second.body.description).toBe('Shown when nothing else fits.');
    expect(second.body.content.raw).toContain('One');

    const reset = await ctx.request('POST', '/wp/v2/templates/plain//index', { source: 'theme' });
    expect(reset.status).toBe(200);
    expect(reset.body.source).toBe('theme');
    expect(await ctx.kernel.posts.get(first.body.wp_id)).toBeUndefined();
  });

  it('validates input and needs edit_theme_options to write', async () => {
    const ctx = await site();
    const noSlug = await ctx.request('POST', '/wp/v2/templates', { content: 'x' });
    expect(noSlug.status).toBe(400);
    expect(noSlug.body.code).toBe('rest_missing_callback_param');
    const badSlug = await ctx.request('POST', '/wp/v2/templates', { slug: 'a b/c' });
    expect(badSlug.status).toBe(400);
    expect(badSlug.body.code).toBe('rest_invalid_param');
    const badAuthor = await ctx.request('POST', '/wp/v2/templates/plain//index', { author: 9999 });
    expect(badAuthor.body.code).toBe('rest_invalid_author');

    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('GET', '/wp/v2/templates')).status).toBe(200);
    const denied = await author.request('POST', '/wp/v2/templates/plain//index', { content: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_manage_templates');
    expect((await author.request('DELETE', '/wp/v2/templates/plain//index')).status).toBe(403);
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect((await subscriber.request('GET', '/wp/v2/template-parts')).status).toBe(403);
    ctx.clearCookie();
    const anonymous = await ctx.request('GET', '/wp/v2/templates');
    expect(anonymous.status).toBe(401);
  });

  it('keeps revisions of customised templates', async () => {
    const ctx = await site();
    const fileOnly = await ctx.request('GET', '/wp/v2/templates/plain//index/revisions');
    expect(fileOnly.status).toBe(400);
    expect(fileOnly.body.code).toBe('rest_invalid_template');

    await ctx.request('POST', '/wp/v2/templates/plain//index', { content: block('Version one') });
    const saved = await ctx.request('POST', '/wp/v2/templates/plain//index', {
      content: block('Version two'),
    });
    expect(saved.body._links['version-history'][0].count).toBe(2);
    const list = await ctx.request('GET', '/wp/v2/templates/plain//index/revisions');
    expect(list.status).toBe(200);
    expect(list.headers.get('x-wp-total')).toBe('2');
    expect(list.body[0]).toMatchObject({ id: 'plain//index', parent: saved.body.wp_id });
    expect(list.body[0].content.raw).toContain('Version two');
    expect(list.body[1].content.raw).toContain('Version one');
    const revisionId = list.body[1].wp_id;
    expect(list.body[1]._links.self[0].href).toBe(
      `http://localhost:3000/wp-json/wp/v2/templates/plain//index/revisions/${revisionId}`,
    );

    const one = await ctx.request('GET', `/wp/v2/templates/plain//index/revisions/${revisionId}`);
    expect(one.status).toBe(200);
    expect(one.body.wp_id).toBe(revisionId);

    const paged = await ctx.request('GET', '/wp/v2/templates/plain//index/revisions?per_page=1');
    expect(paged.headers.get('x-wp-totalpages')).toBe('2');

    const noForce = await ctx.request(
      'DELETE',
      `/wp/v2/templates/plain//index/revisions/${revisionId}`,
    );
    expect(noForce.status).toBe(501);
    expect(noForce.body.code).toBe('rest_trash_not_supported');
    const removed = await ctx.request(
      'DELETE',
      `/wp/v2/templates/plain//index/revisions/${revisionId}?force=true`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);
    const wrong = await ctx.request('GET', `/wp/v2/templates/plain//index/revisions/${revisionId}`);
    expect(wrong.status).toBe(404);

    const author = await ctx.loginAs('writer', 'author');
    const denied = await author.request('GET', '/wp/v2/templates/plain//index/revisions');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_read');
  });

  it('autosaves a customised template without changing it', async () => {
    const ctx = await site();
    const saved = await ctx.request('POST', '/wp/v2/template-parts/plain//footer', {
      content: block('Footer saved'),
    });
    const autosave = await ctx.request('POST', '/wp/v2/template-parts/plain//footer/autosaves', {
      content: block('Footer draft'),
    });
    expect(autosave.status).toBe(200);
    expect(autosave.body).toMatchObject({
      id: 'plain//footer',
      area: 'footer',
      parent: saved.body.wp_id,
    });
    expect(autosave.body.content.raw).toContain('Footer draft');
    const list = await ctx.request('GET', '/wp/v2/template-parts/plain//footer/autosaves');
    expect(list.body).toHaveLength(1);
    const latest = await ctx.request(
      'GET',
      `/wp/v2/template-parts/plain//footer/autosaves/${autosave.body.wp_id}`,
    );
    expect(latest.body.content.raw).toContain('Footer draft');
    const part = await ctx.request('GET', '/wp/v2/template-parts/plain//footer');
    expect(part.body.content.raw).toContain('Footer saved');
    expect(
      (await ctx.kernel.posts.revisions(saved.body.wp_id)).filter(
        (r) => !r.slug.includes('autosave'),
      ),
    ).toHaveLength(1);
    const none = await ctx.request('GET', '/wp/v2/template-parts/plain//header/autosaves');
    expect(none.status).toBe(400);
  });

  it('moves a part to another area, and unknown areas become uncategorized', async () => {
    const ctx = await site();
    const res = await ctx.request('POST', '/wp/v2/template-parts', {
      slug: 'sidebar',
      area: 'aside-area',
      content: block('Side'),
    });
    expect(res.status).toBe(201);
    expect(res.body.area).toBe('uncategorized');
    const moved = await ctx.request('POST', '/wp/v2/template-parts/plain//sidebar', {
      area: 'footer',
    });
    expect(moved.body.area).toBe('footer');
    const footers = await getBlockTemplates(
      ctx.kernel,
      { area: 'footer' },
      TEMPLATE_PART_POST_TYPE,
    );
    expect(footers.map((t) => t.slug).sort()).toEqual(['footer', 'sidebar']);
  });
});
