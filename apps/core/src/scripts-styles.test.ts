import { HookBus } from '@pressbase/hooks';
import { describe, expect, it } from 'vitest';
import { assetUrl, Scripts, Styles } from './frontend/dependencies';
import { setup } from './test-utils';

/**
 * Public page hooks and kernel.scripts / kernel.styles
 * (docs/architecture/scripts-and-styles.md): WP_Scripts / WP_Styles
 * ordering, wp_head / wp_body_open / wp_footer output and the page filters.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const headOf = (html: string) => /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? '';
const bodyOf = (html: string) => /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
const ids = (html: string) => [...html.matchAll(/ id=["']([^"']+)["']/g)].map((m) => m[1]);

describe('WP_Scripts', () => {
  it('prints dependencies first, each once, with ?ver=', async () => {
    const scripts = new Scripts('1.0');
    scripts.add('a', '/a.js', ['b', 'c']);
    scripts.add('b', '/b.js', ['c'], '2.0');
    scripts.add('c', '/c.js', [], null);
    scripts.enqueue(['a', 'b', 'a']);
    const html = await scripts.doHeadItems();
    expect(html).toBe(
      [
        '<script src="/c.js" id="c-js"></script>',
        '<script src="/b.js?ver=2.0" id="b-js"></script>',
        '<script src="/a.js?ver=1.0" id="a-js"></script>',
      ].join('\n'),
    );
    // Already printed: nothing again.
    expect(await scripts.doFooterItems()).toBe('');
    expect(scripts.query('a', 'done')).toBe(true);
  });

  it('drops a script whose dependency is missing', async () => {
    const scripts = new Scripts('1.0');
    scripts.add('needy', '/needy.js', ['ghost']);
    scripts.add('fine', '/fine.js');
    scripts.enqueue(['needy', 'fine']);
    expect(await scripts.doHeadItems()).toBe(
      '<script src="/fine.js?ver=1.0" id="fine-js"></script>',
    );
  });

  it('keeps footer scripts for the footer, unless a head script needs them', async () => {
    const scripts = new Scripts('1.0');
    scripts.add('late', '/late.js', [], null);
    scripts.addData('late', 'group', 1);
    scripts.add('lib', '/lib.js', [], null);
    scripts.addData('lib', 'group', 1);
    scripts.add('head', '/head.js', ['lib'], null);
    scripts.enqueue(['late', 'head']);
    expect(await scripts.doHeadItems()).toBe(
      '<script src="/lib.js" id="lib-js"></script>\n<script src="/head.js" id="head-js"></script>',
    );
    expect(await scripts.doFooterItems()).toBe('<script src="/late.js" id="late-js"></script>');
  });

  it('enqueues a handle registered later', async () => {
    const scripts = new Scripts('1.0');
    scripts.enqueue('later');
    scripts.add('later', '/later.js', [], null);
    expect(scripts.query('later', 'enqueued')).toBe(true);
  });

  it('prints inline and localized code around the tag, escaped', async () => {
    const scripts = new Scripts('1.0');
    scripts.add('app', '/app.js', [], null);
    scripts.addInlineScript('app', 'window.before = 1;', 'before');
    scripts.addInlineScript('app', 'console.log("</script><b>")');
    scripts.localize('app', 'appData', { url: '/x?a=1&b=2', html: '</script>' });
    scripts.enqueue('app');
    expect(await scripts.doHeadItems()).toBe(
      [
        '<script id="app-js-extra">',
        'var appData = {"url":"/x?a=1\\u0026b=2","html":"\\u003C/script\\u003E"};',
        '</script>',
        '<script id="app-js-before">',
        'window.before = 1;',
        '</script>',
        '<script src="/app.js" id="app-js"></script>',
        '<script id="app-js-after">',
        'console.log("<\\/script><b>")',
        '</script>',
      ].join('\n'),
    );
    expect(() => scripts.localize('app', 'not valid', {})).toThrow();
  });

  it('uses defer and async unless a dependent needs the script to block', async () => {
    const scripts = new Scripts('1.0');
    scripts.add('lazy', '/lazy.js', [], null);
    scripts.setStrategy('lazy', 'async');
    scripts.add('deferred', '/deferred.js', [], null);
    scripts.setStrategy('deferred', 'async');
    scripts.add('waits', '/waits.js', ['deferred'], null);
    scripts.setStrategy('waits', 'defer');
    scripts.add('base', '/base.js', [], null);
    scripts.setStrategy('base', 'defer');
    scripts.add('blocking', '/blocking.js', ['base'], null);
    scripts.enqueue(['lazy', 'waits', 'blocking']);
    expect(scripts.eligibleStrategy('lazy')).toBe('async');
    // A deferred dependent limits it to defer.
    expect(scripts.eligibleStrategy('deferred')).toBe('defer');
    // A blocking dependent makes it block.
    expect(scripts.eligibleStrategy('base')).toBe('');
    const html = await scripts.doHeadItems();
    expect(html).toContain(
      '<script src="/lazy.js" id="lazy-js" async data-wp-strategy="async"></script>',
    );
    expect(html).toContain(
      '<script src="/deferred.js" id="deferred-js" defer data-wp-strategy="async"></script>',
    );
    expect(html).toContain(
      '<script src="/base.js" id="base-js" data-wp-strategy="defer"></script>',
    );
  });

  it('runs script_loader_tag and refuses unsafe sources', async () => {
    const hooks = new HookBus();
    hooks.addFilter('script_loader_tag', (tag, handle) =>
      handle === 'mod' ? tag.replace('<script ', '<script type="module" ') : tag,
    );
    const scripts = new Scripts('1.0', hooks);
    scripts.add('mod', '/mod.js?x=1&y=2', [], '3');
    scripts.add('evil', 'javascript:alert(1)', [], null);
    scripts.add('quote', '/q.js"onload="alert(1)', [], null);
    scripts.enqueue(['mod', 'evil', 'quote']);
    const html = await scripts.doHeadItems();
    expect(html).toContain(
      '<script type="module" src="/mod.js?x=1&#038;y=2&#038;ver=3" id="mod-js"></script>',
    );
    // Not a javascript: URL: a path on this site.
    expect(html).toContain('<script src="/javascript:alert(1)" id="evil-js"></script>');
    expect(html).not.toContain('"onload');
  });
});

describe('WP_Styles', () => {
  it('prints stylesheets in dependency order with inline CSS and the media attribute', async () => {
    const styles = new Styles('1.0');
    styles.add('theme', '/theme.css', ['reset'], '2', 'screen');
    styles.add('reset', 'https://cdn.example.com/reset.css', [], null);
    styles.addInlineStyle('theme', 'body{color:red}</style><script>');
    styles.enqueue('theme');
    expect(await styles.doItems()).toBe(
      [
        "<link rel='stylesheet' id='reset-css' href='https://cdn.example.com/reset.css' media='all' />",
        "<link rel='stylesheet' id='theme-css' href='/theme.css?ver=2' media='screen' />",
        "<style id='theme-inline-css'>",
        'body{color:red}<\\/style><script>',
        '</style>',
      ].join('\n'),
    );
  });

  it('builds asset URLs with the version before the fragment', () => {
    expect(assetUrl('a.css', '1')).toBe('/a.css?ver=1');
    expect(assetUrl('/a.css#x', '1')).toBe('/a.css?ver=1#x');
    expect(assetUrl('//cdn.test/a.css', '')).toBe('//cdn.test/a.css');
  });
});

describe('public page hooks', () => {
  it('prints wp_head, wp_body_open and wp_footer output in priority order', async () => {
    const ctx = await site();
    const { hooks, scripts, styles } = ctx.kernel;
    hooks.addAction('wp_enqueue_scripts', () => {
      styles.enqueue('plugin-style', '/wp-content/plugins/demo/style.css', ['wp-block-library']);
      scripts.enqueue('plugin-head', '/wp-content/plugins/demo/head.js');
      scripts.enqueue('plugin-foot', '/wp-content/plugins/demo/foot.js', [], '1.2', {
        inFooter: true,
        strategy: 'defer',
      });
    });
    hooks.addAction('wp_head', (out) => out.print('<meta name="demo" content="early" />'), 0);
    hooks.addAction('wp_head', (out) => out.print('<meta name="demo" content="default" />'));
    hooks.addAction('wp_body_open', (out) => out.print('<div id="opened"></div>'));
    hooks.addAction('wp_footer', async (out) => out.print('<div id="footer-marker"></div>'));

    const { html } = await render(ctx, '/');
    const head = headOf(html);
    expect(ids(head)).toEqual(
      expect.arrayContaining(['wp-block-library-css', 'plugin-style-css', 'plugin-head-js']),
    );
    const order = (needle: string) => head.indexOf(needle);
    expect(order('name="viewport"')).toBeLessThan(order('content="early"'));
    expect(order('content="early"')).toBeLessThan(order("name='robots'"));
    expect(order('wp-block-library-css')).toBeLessThan(order('plugin-style-css'));
    expect(order('plugin-style-css')).toBeLessThan(order('plugin-head-js'));
    expect(order('plugin-head-js')).toBeLessThan(order('content="default"'));
    expect(order('content="default"')).toBeLessThan(order("class='wp-fonts-local'"));
    expect(head).toContain(
      '<script src="/wp-content/plugins/demo/head.js?ver=0.1.0" id="plugin-head-js"></script>',
    );
    expect(head).not.toContain('foot.js');

    const body = bodyOf(html);
    expect(body.trimStart().startsWith('<div id="opened"></div>')).toBe(true);
    expect(body).toContain(
      '<script src="/wp-content/plugins/demo/foot.js?ver=1.2" id="plugin-foot-js" defer data-wp-strategy="defer"></script>',
    );
    expect(body.indexOf('footer-marker')).toBeLessThan(body.indexOf('plugin-foot-js'));
  });

  it('keeps a page’s enqueues to that page', async () => {
    const ctx = await site();
    const { hooks, scripts } = ctx.kernel;
    // Registered site-wide (outside a render): on every page.
    scripts.register('shared', '/shared.js', [], null);
    hooks.addAction('wp_enqueue_scripts', (page) => {
      scripts.enqueue('shared');
      if (page.main.isSingular) scripts.enqueue('single-only', '/single.js', [], null);
    });
    const post = await render(ctx, '/?p=1');
    expect(post.status).toBe(301);
    const single = await render(ctx, new URL(post.headers.location ?? '').pathname);
    expect(single.html).toContain('/single.js');
    expect(single.html).toContain('/shared.js');
    const home = await render(ctx, '/');
    expect(home.html).not.toContain('/single.js');
    expect(home.html).toContain('/shared.js');
    expect(scripts.is('single-only', 'registered')).toBe(false);
  });

  it('runs wp_robots, body_class, language_attributes and the document title filters', async () => {
    const ctx = await site();
    const { hooks } = ctx.kernel;
    hooks.addFilter('wp_robots', (robots) => ({ ...robots, noarchive: true, 'max-snippet': '50' }));
    hooks.addFilter('body_class', (classes) => [...classes, 'has-demo', 'bad"class']);
    hooks.addFilter('language_attributes', (attrs) => `${attrs} dir="ltr"`);
    hooks.addFilter('document_title_parts', (parts) => ({ ...parts, tagline: 'A <b>tagline</b>' }));
    hooks.addFilter('document_title_separator', () => '|');
    const { html } = await render(ctx, '/');
    expect(html).toContain('<html lang="en-US" dir="ltr">');
    expect(html).toContain(
      "<meta name='robots' content='max-image-preview:large, noarchive, max-snippet:50' />",
    );
    expect(html).toMatch(/<body class="[^"]* has-demo badclass">/);
    expect(html).toContain('<title>Test Site | A &lt;b&gt;tagline&lt;/b&gt;</title>');

    hooks.addFilter('pre_get_document_title', () => 'Custom & short');
    expect((await render(ctx, '/')).html).toContain('<title>Custom &amp; short</title>');
  });

  it('passes the main query to wp_robots and the title filters', async () => {
    const ctx = await site();
    const { hooks } = ctx.kernel;
    const seen: string[] = [];
    hooks.addFilter('wp_robots', (robots, main) => {
      seen.push(`robots:${main.isFrontPage}`);
      return main.is404 ? { ...robots, noindex: true } : robots;
    });
    hooks.addFilter('pre_get_document_title', (title, main) => {
      seen.push(`title:${main.is404}`);
      return main.is404 ? 'Lost' : title;
    });
    const missing = await render(ctx, '/no-such-page/');
    expect(missing.html).toContain('<title>Lost</title>');
    expect(missing.html).toContain('noindex');
    expect(seen).toEqual(['robots:false', 'title:true']);
  });
});
