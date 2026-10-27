import { HookBus } from '@pressbase/hooks';
import { describe, expect, it } from 'vitest';
import { renderBlock, renderBlocks, type WPBlock } from './block';
import { escHtml } from './escape';
import { parseBlocks } from './parser';
import { BlockTypeRegistry } from './registry';
import { getBlockWrapperAttributes } from './supports';

interface Services {
  posts: Record<number, { title: string; content: string }>;
}

function setup() {
  const registry = new BlockTypeRegistry<Services>();
  const hooks = new HookBus();
  const services: Services = {
    posts: {
      1: {
        title: 'First <b>post</b>',
        content: '<!-- wp:paragraph --><p>One</p><!-- /wp:paragraph -->',
      },
      2: { title: 'Second', content: '' },
    },
  };
  const render = (content: string, context = {}) =>
    renderBlocks(content, { registry, hooks, services, context });
  return { registry, hooks, services, render };
}

describe('renderBlocks', () => {
  it('outputs static blocks as saved, delimiters removed', async () => {
    const { render } = setup();
    const html = await render(
      'Intro <!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>A</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>B</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
    );
    expect(html).toBe('Intro <div class="wp-block-group"><p>A</p><p>B</p></div>');
  });

  it('calls render callbacks with prepared attributes for dynamic blocks', async () => {
    const { registry, render } = setup();
    const seen: unknown[] = [];
    registry.register('test/greeting', {
      attributes: {
        name: { type: 'string', default: 'world' },
        times: { type: 'integer', default: 1 },
      },
      render: (attributes) => {
        seen.push(attributes);
        return `<p>${escHtml(`Hello ${attributes.name}`).repeat(Number(attributes.times))}</p>`;
      },
    });
    expect(await render('<!-- wp:test/greeting /-->')).toBe('<p>Hello world</p>');
    // Values that don't match the schema fall back to the default.
    expect(await render('<!-- wp:test/greeting {"name":"<you>","times":"lots"} /-->')).toBe(
      '<p>Hello &lt;you&gt;</p>',
    );
    expect(seen[1]).toEqual({ name: '<you>', times: 1 });
  });

  it('awaits async render callbacks and passes rendered inner content', async () => {
    const { registry, render } = setup();
    registry.register('test/box', {
      render: async (_attributes, content, block) => {
        await Promise.resolve();
        return `<section ${getBlockWrapperAttributes(block, { class: 'box' })}>${content}</section>`;
      },
    });
    registry.register('test/now', { render: () => '<time>now</time>' });
    const html = await render(
      '<!-- wp:test/box {"className":"tall"} --><div><!-- wp:test/now /--><!-- wp:paragraph --><p>p</p><!-- /wp:paragraph --></div><!-- /wp:test/box -->',
    );
    expect(html).toBe(
      '<section class="box tall wp-block-test-box"><div><time>now</time><p>p</p></div></section>',
    );
  });

  it('passes context from providers to consumers that ask for it', async () => {
    const { registry, render } = setup();
    registry.register('test/post', {
      attributes: { id: { type: 'number' } },
      providesContext: { postId: 'id' },
      render: (_a, content) => `<article>${content}</article>`,
    });
    registry.register('test/title', {
      usesContext: ['postId'],
      render: (_a, _c, block) => {
        const post = block.services.posts[block.context.postId as number];
        return post ? `<h2>${escHtml(post.title)}</h2>` : '';
      },
    });
    registry.register('test/nosy', {
      render: (_a, _c, block) => `<i>${JSON.stringify(block.context)}</i>`,
    });
    const html = await render(
      '<!-- wp:test/post {"id":1} --><div><!-- wp:test/title /--><!-- wp:test/nosy /--></div><!-- /wp:test/post -->',
    );
    expect(html).toBe(
      '<article><div><h2>First &lt;b&gt;post&lt;/b&gt;</h2><i>{}</i></div></article>',
    );
  });

  it('starts top-level blocks with the given context', async () => {
    const { registry, render } = setup();
    registry.register('test/title', {
      usesContext: ['postId', 'postType'],
      render: (_a, _c, block) => `${block.context.postType}:${block.context.postId}`,
    });
    expect(await render('<!-- wp:test/title /-->', { postId: 2, postType: 'post' })).toBe('post:2');
  });

  it('renders unknown blocks as static content', async () => {
    const { render } = setup();
    expect(await render('<!-- wp:nope/missing --><p>still here</p><!-- /wp:nope/missing -->')).toBe(
      '<p>still here</p>',
    );
  });
});

describe('render filters', () => {
  it('short-circuits with pre_render_block, at the top level and inside blocks', async () => {
    const { hooks, render } = setup();
    const parents: (string | null)[] = [];
    hooks.addFilter('pre_render_block', (pre, parsed, parent) => {
      parents.push(parent?.name ?? null);
      return parsed.blockName === 'core/separator' ? '<hr class="custom"/>' : pre;
    });
    const html = await render(
      '<!-- wp:separator /--><!-- wp:group --><div><!-- wp:separator /--></div><!-- /wp:group -->',
    );
    expect(html).toBe('<hr class="custom"/><div><hr class="custom"/></div>');
    expect(parents).toEqual([null, null, 'core/group']);
  });

  it('lets render_block_data change attributes before rendering', async () => {
    const { registry, hooks, render } = setup();
    registry.register('test/echo', {
      attributes: { word: { type: 'string', default: 'a' } },
      render: (attributes) => String(attributes.word),
    });
    hooks.addFilter('render_block_data', (parsed, source) => {
      expect(source.blockName).toBe(parsed.blockName);
      return parsed.blockName === 'test/echo'
        ? { ...parsed, attrs: { ...parsed.attrs, word: 'changed' } }
        : parsed;
    });
    expect(
      await render(
        '<!-- wp:group --><div><!-- wp:test/echo /--></div><!-- /wp:group --><!-- wp:test/echo /-->',
      ),
    ).toBe('<div>changed</div>changed');
  });

  it('lets render_block_context add context', async () => {
    const { registry, hooks, render } = setup();
    registry.register('test/ctx', {
      usesContext: ['flavour'],
      render: (_a, _c, block) => String(block.context.flavour ?? 'none'),
    });
    hooks.addFilter('render_block_context', (context) => ({ ...context, flavour: 'mint' }));
    expect(
      await render(
        '<!-- wp:test/ctx /--><!-- wp:group --><div><!-- wp:test/ctx /--></div><!-- /wp:group -->',
      ),
    ).toBe('mint<div>mint</div>');
  });

  it('applies render_block, then render_block_{name}', async () => {
    const { hooks, render } = setup();
    const order: string[] = [];
    hooks.addFilter('render_block', (content, parsed, block) => {
      order.push(`render_block:${parsed.blockName}`);
      expect(block.name).toBe(parsed.blockName);
      return content;
    });
    hooks.addFilter('render_block_core/paragraph', (content: unknown) => {
      order.push('render_block_core/paragraph');
      return String(content).replace('<p>', '<p class="filtered">');
    });
    expect(await render('<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->')).toBe(
      '<p class="filtered">x</p>',
    );
    expect(order).toEqual(['render_block:core/paragraph', 'render_block_core/paragraph']);
  });
});

describe('recursion', () => {
  it('stops a pattern that renders itself', async () => {
    const { registry, render } = setup();
    const patterns: Record<number, string> = {
      1: '<!-- wp:paragraph --><p>one</p><!-- /wp:paragraph --><!-- wp:test/ref {"ref":2} /-->',
      2: '<!-- wp:paragraph --><p>two</p><!-- /wp:paragraph --><!-- wp:test/ref {"ref":1} /-->',
    };
    registry.register('test/ref', {
      attributes: { ref: { type: 'number' } },
      render: (attributes, _content, block) => {
        const ref = attributes.ref as number;
        return block.withRecursionGuard(
          `ref:${ref}`,
          () => block.renderInnerBlocks(parseBlocks(patterns[ref] ?? '')),
          '',
        );
      },
    });
    expect(await render('<!-- wp:test/ref {"ref":1} /-->')).toBe('<p>one</p><p>two</p>');
    // Siblings may use the same pattern twice; only nesting is refused.
    expect(await render('<!-- wp:test/ref {"ref":2} /--><!-- wp:test/ref {"ref":2} /-->')).toBe(
      '<p>two</p><p>one</p><p>two</p><p>one</p>',
    );
  });

  it('caps nesting depth even without a guard', async () => {
    const { registry, render } = setup();
    let calls = 0;
    registry.register('test/forever', {
      render: (_a, _c, block) => {
        calls++;
        return block.renderContent('<!-- wp:test/forever /-->');
      },
    });
    expect(await render('<!-- wp:test/forever /-->')).toBe('');
    expect(calls).toBe(100);
  });

  it('renders other content with its own context through renderContent', async () => {
    const { registry, render } = setup();
    registry.register('test/title', {
      usesContext: ['postId'],
      render: (_a, _c, block) => `[${block.context.postId}]`,
    });
    registry.register('test/embed', {
      render: (_a, _c, block) => block.renderContent('<!-- wp:test/title /-->', { postId: 9 }),
    });
    expect(await render('<!-- wp:test/title /--><!-- wp:test/embed /-->', { postId: 1 })).toBe(
      '[1][9]',
    );
  });
});

describe('WPBlock helpers', () => {
  it('generates unique ids per render', async () => {
    const { registry, render } = setup();
    registry.register('test/id', { render: (_a, _c, block) => block.uniqueId('field-') });
    expect(await render('<!-- wp:test/id /--><!-- wp:test/id /-->')).toBe('field-1field-2');
    expect(await render('<!-- wp:test/id /-->')).toBe('field-1');
  });

  it('renders a single parsed block with renderBlock', async () => {
    const { registry, services } = setup();
    registry.register('test/x', {
      attributes: { n: { type: 'number', default: 4 } },
      render: (a) => `n=${a.n}`,
    });
    const html = await renderBlock(
      { blockName: 'test/x', attrs: {}, innerBlocks: [], innerHTML: '', innerContent: [] },
      { registry, services },
    );
    expect(html).toBe('n=4');
  });

  it('builds wrapper attributes from block supports', async () => {
    const { registry, render } = setup();
    let block: WPBlock<Services> | undefined;
    registry.register('core/thing', {
      supports: {
        align: true,
        anchor: true,
        color: { text: true, background: true },
        typography: { fontSize: true },
      },
      render: (_a, _c, b) => {
        block = b;
        return `<div ${getBlockWrapperAttributes(b, { class: 'thing__inner', 'data-x': '"1"' })}></div>`;
      },
    });
    const html = await render(
      '<!-- wp:thing {"align":"wide","anchor":"top","textColor":"vividRed","style":{"color":{"background":"#fff"}},"fontSize":"large","className":"extra"} /-->',
    );
    expect(html).toBe(
      '<div class="thing__inner alignwide has-text-color has-vivid-red-color has-background extra wp-block-thing has-large-font-size" style="background-color:#fff;" id="top" data-x="&quot;1&quot;"></div>',
    );
    expect(block?.attributes.align).toBe('wide');
  });

  it('refuses unsafe CSS in custom style values', async () => {
    const { registry, render } = setup();
    registry.register('core/thing', {
      supports: { color: { text: true } },
      render: (_a, _c, b) => `<div ${getBlockWrapperAttributes(b)}></div>`,
    });
    const html = await render(
      '<!-- wp:thing {"style":{"color":{"text":"red;background:url(javascript:alert(1))"}}} /-->',
    );
    expect(html).toBe('<div class="wp-block-thing"></div>');
  });
});
