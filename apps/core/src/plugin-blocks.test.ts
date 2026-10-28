import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURGE_ACTION } from './cache/invalidation';
import { blockAssetHandle, validateBlockArgs } from './plugins/blocks';
import { setup } from './test-utils';

/**
 * Plugin blocks (gap 4 of docs/plans/first-party-plugins.md, ADR 0020):
 * api.blocks.register() and registerFromMetadata(), rendering through
 * render_block(), deactivation, /wp/v2/block-types, per-page styles and
 * cache purges.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  const purges: { tags: string[]; reason: string }[] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, async (tags, reason) => {
    purges.push({ tags, reason });
  });
  return { ...ctx, purges };
}

async function plugin(ctx: Ctx, slug: string, files: Record<string, string>) {
  const dir = path.join(ctx.dataDir, 'plugins', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: slug, title: slug, version: '1.0.0', main: 'index.js' }),
  );
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return (await res.json()) as { status: number; html: string };
}

async function publish(ctx: Ctx, title: string, content: string) {
  const res = await ctx.request('POST', '/wp/v2/posts', { title, content, status: 'publish' });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string };
}

const NOTICE = `
export default function register(api) {
  api.blocks.register('notes/notice', {
    title: 'Notice',
    category: 'widgets',
    attributes: {
      tone: { type: 'string', enum: ['info', 'warning'], default: 'info' },
      count: { type: 'integer', default: 1 },
    },
    usesContext: ['postId'],
    supports: { className: true },
    editorScript: 'admin/notice.js',
    style: 'notice.css',
    editorStyle: 'notice-editor.css',
    render: (attributes, content, block) =>
      '<aside ' + api.blocks.getBlockWrapperAttributes(block, { class: 'is-' + attributes.tone }) + '>' +
      api.blocks.escHtml(String(attributes.count) + ' on ' + block.context.postId + ' <b>') +
      content + '</aside>',
  });
  api.blocks.register('notes/broken', { render: () => { throw new Error('boom'); } });
}
`;

const NOTICE_FILES = {
  'index.js': NOTICE,
  'admin/notice.js': 'export {};',
  'public/notice.css': '.wp-block-notes-notice{color:red}',
  'public/notice-editor.css': '.x{}',
};

describe('api.blocks.register()', () => {
  it('registers a dynamic block that renders through render_block(), filters included', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', NOTICE_FILES);
    await ctx.kernel.plugins.activate('notes');
    ctx.kernel.hooks.addFilter('render_block_notes/notice', (html) => `${html}<!--filtered-->`);

    const html = await ctx.kernel.blocks.render(
      '<!-- wp:notes/notice {"tone":"warning","count":"lots"} /-->',
      { context: { postId: 7 } },
    );
    // `count` doesn't match its schema, so it's dropped and the default fills in; output is escaped.
    expect(html).toBe(
      '<aside class="is-warning wp-block-notes-notice">1 on 7 &lt;b&gt;</aside><!--filtered-->',
    );
  });

  it('contains a render callback that throws: nothing renders, and the error is recorded', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', NOTICE_FILES);
    await ctx.kernel.plugins.activate('notes');
    const errors: unknown[] = [];
    ctx.kernel.hooks.addAction('pressbase_plugin_error', async (slug, record) => {
      errors.push([slug, (record as { during: string }).during]);
    });
    expect(await ctx.kernel.blocks.render('a<!-- wp:notes/broken /-->b')).toBe('ab');
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([['notes', 'block notes/broken']]);
  });

  it('refuses names outside the plugin’s namespace, duplicates and bad schemas', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', {
      'index.js': `export default (api) => api.blocks.register('core/notice', { title: 'x' });`,
    });
    await expect(ctx.kernel.plugins.activate('notes')).rejects.toThrow(/start with the plugin's name/);
    await plugin(ctx, 'twice', {
      'index.js': `export default (api) => { api.blocks.register('twice/a'); api.blocks.register('twice/a'); };`,
    });
    await expect(ctx.kernel.plugins.activate('twice')).rejects.toThrow(/already registered/);
    expect(ctx.kernel.blocks.registry.isRegistered('twice/a')).toBe(false);

    expect(() => validateBlockArgs('a/b', { attributes: { x: {} } })).toThrow(/needs a `type`/);
    expect(() => validateBlockArgs('a/b', { attributes: { x: { type: 'text' as never } } })).toThrow(
      /unknown type/,
    );
    expect(() =>
      validateBlockArgs('a/b', { attributes: { x: { type: 'number', default: 'no' } } }),
    ).toThrow(/default doesn't match/);
    expect(() => validateBlockArgs('a/b', { providesContext: { c: 'missing' } })).toThrow(
      /must name one of the block's attributes/,
    );
    expect(() => validateBlockArgs('a/b', { keywords: 'x' as never })).toThrow(/list of strings/);
    expect(() => validateBlockArgs('a/b', { render: 'x' as never })).toThrow(/must be a function/);
    expect(blockAssetHandle('a/b', 'editorStyle', 1)).toBe('a-b-editor-style-2');
  });

  it('is unregistered on deactivation: the public page renders nothing, the cache is purged', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', NOTICE_FILES);
    await ctx.kernel.plugins.activate('notes');
    await Promise.resolve();
    expect(ctx.purges.some((p) => p.reason === 'plugin:notes' && p.tags.includes('site'))).toBe(
      true,
    );
    const post = await publish(ctx, 'With a notice', 'Before<!-- wp:notes/notice /-->After');
    const url = new URL(post.link).pathname;
    expect((await render(ctx, url)).html).toContain('wp-block-notes-notice');

    ctx.purges.length = 0;
    await ctx.kernel.plugins.deactivate('notes');
    await Promise.resolve();
    expect(ctx.purges.some((p) => p.reason === 'plugin:notes' && p.tags.includes('site'))).toBe(
      true,
    );
    expect(ctx.kernel.blocks.registry.isRegistered('notes/notice')).toBe(false);
    const after = (await render(ctx, url)).html;
    expect(after).not.toContain('wp-block-notes-notice');
    expect(after).toContain('Before');
    expect(after).not.toContain('notice.css');
    // The saved markup is untouched.
    const raw = await ctx.request('GET', `/wp/v2/posts/${post.id}?context=edit`);
    expect((raw.body as { content: { raw: string } }).content.raw).toContain(
      '<!-- wp:notes/notice /-->',
    );
  });
});

describe('plugin blocks in REST and on the page', () => {
  it('lists plugin blocks in /wp/v2/block-types with their handles, and renders them in block-renderer', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', NOTICE_FILES);
    await ctx.kernel.plugins.activate('notes');

    const res = await ctx.request('GET', '/wp/v2/block-types/notes/notice');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'notes/notice',
      title: 'Notice',
      category: 'widgets',
      is_dynamic: true,
      uses_context: ['postId'],
      editor_script_handles: ['notes-notice-editor-script'],
      style_handles: ['notes-notice-style'],
      editor_style_handles: ['notes-notice-editor-style'],
      style: 'notes-notice-style',
    });
    expect((res.body as { attributes: Record<string, unknown> }).attributes.tone).toEqual({
      type: 'string',
      enum: ['info', 'warning'],
      default: 'info',
    });
    const list = await ctx.request('GET', '/wp/v2/block-types/notes');
    expect((list.body as { name: string }[]).map((t) => t.name)).toEqual([
      'notes/notice',
      'notes/broken',
    ]);

    const preview = await ctx.request('POST', '/wp/v2/block-renderer/notes/notice', {
      attributes: { tone: 'info', count: 3 },
    });
    expect(preview.body).toEqual({
      rendered: '<aside class="is-info wp-block-notes-notice">3 on undefined &lt;b&gt;</aside>',
    });
    const invalid = await ctx.request('POST', '/wp/v2/block-renderer/notes/notice', {
      attributes: { tone: 'loud' },
    });
    expect(invalid.status).toBe(400);

    // The admin learns the editor module and canvas styles, and core serves the module.
    const ext = await ctx.request('GET', '/pressbase/v1/admin-extensions');
    expect((ext.body as { blocks: unknown[] }).blocks).toEqual([
      {
        plugin: 'notes',
        title: 'notes',
        name: 'notes/notice',
        editor_script: '/wp-content/plugins/notes/admin/notice.js?ver=1.0.0',
        styles: [
          '/wp-content/plugins/notes/notice.css?ver=1.0.0',
          '/wp-content/plugins/notes/notice-editor.css?ver=1.0.0',
        ],
      },
      expect.objectContaining({ name: 'notes/broken', editor_script: null, styles: [] }),
    ]);
    expect((await ctx.app.request('/wp-content/plugins/notes/admin/notice.js')).status).toBe(200);
    expect((await ctx.app.request('/wp-content/plugins/notes/notice.css')).status).toBe(200);
    expect((await ctx.app.request('/wp-content/plugins/notes/index.js')).status).toBe(404);
  });

  it('enqueues the block’s style only on pages that show it, and never from a REST render', async () => {
    const ctx = await site();
    await plugin(ctx, 'notes', NOTICE_FILES);
    await ctx.kernel.plugins.activate('notes');
    const withBlock = await publish(ctx, 'With', '<!-- wp:notes/notice /-->');
    const without = await publish(ctx, 'Without', '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->');

    const shown = (await render(ctx, new URL(withBlock.link).pathname)).html;
    expect(shown).toMatch(
      /<link rel='stylesheet' id='notes-notice-style-css' href='\/wp-content\/plugins\/notes\/notice\.css\?ver=1\.0\.0'/,
    );
    expect(shown).not.toContain('notice-editor.css');
    const plain = (await render(ctx, new URL(without.link).pathname)).html;
    expect(plain).not.toContain('notice.css');

    // A REST render doesn't enqueue the style site-wide.
    await ctx.request('GET', `/wp/v2/posts/${withBlock.id}`);
    expect((await render(ctx, new URL(without.link).pathname)).html).not.toContain('notice.css');
  });
});

describe('api.blocks.registerFromMetadata()', () => {
  it('reads block.json as register_block_type() does, with file: paths and a render module', async () => {
    const ctx = await site();
    await plugin(ctx, 'faq', {
      'index.js': `export default async (api) => { await api.blocks.registerFromMetadata('blocks/item'); }`,
      'blocks/item/block.json': JSON.stringify({
        $schema: 'https://schemas.wp.org/trunk/block.json',
        apiVersion: 3,
        name: 'faq/item',
        title: 'FAQ item',
        category: 'text',
        attributes: { question: { type: 'string', default: 'Why?' } },
        editorScript: 'file:../../admin/item.js',
        style: 'file:../../public/item.css',
        render: 'file:./render.js',
      }),
      'blocks/item/render.js':
        'export default (attributes) => `<details><summary>${attributes.question}</summary></details>`;',
      'admin/item.js': 'export {};',
      'public/item.css': 'details{}',
    });
    await ctx.kernel.plugins.activate('faq');
    const type = ctx.kernel.blocks.registry.get('faq/item');
    expect(type?.title).toBe('FAQ item');
    expect(type?.apiVersion).toBe(3);
    expect(type?.styleHandles).toEqual(['faq-item-style']);
    expect(await ctx.kernel.blocks.render('<!-- wp:faq/item /-->')).toBe(
      '<details><summary>Why?</summary></details>',
    );
    const ext = await ctx.request('GET', '/pressbase/v1/admin-extensions');
    expect((ext.body as { blocks: unknown[] }).blocks).toEqual([
      expect.objectContaining({
        editor_script: '/wp-content/plugins/faq/admin/item.js?ver=1.0.0',
        styles: ['/wp-content/plugins/faq/item.css?ver=1.0.0'],
      }),
    ]);
  });

  it('refuses metadata outside the plugin, and styles outside public/', async () => {
    const ctx = await site();
    await plugin(ctx, 'faq', {
      'index.js': `export default async (api) => { await api.blocks.registerFromMetadata('../other'); }`,
    });
    await expect(ctx.kernel.plugins.activate('faq')).rejects.toThrow(/doesn't exist|outside/);
    await plugin(ctx, 'faq2', {
      'index.js': `export default async (api) => { await api.blocks.registerFromMetadata('b'); }`,
      'b/block.json': JSON.stringify({ name: 'faq2/b', style: 'file:./b.css' }),
      'b/b.css': '',
    });
    await expect(ctx.kernel.plugins.activate('faq2')).rejects.toThrow(/public\/ folder/);
  });
});
