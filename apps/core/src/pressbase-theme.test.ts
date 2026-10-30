import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParsedBlock, parseBlocks } from '@pressbase/blocks';
import { applyStyleVariation, type StyleVariation } from '@pressbase/theme-json';
import { describe, expect, it } from 'vitest';
import { CORE_PATTERNS } from './blocks/patterns';
import { setMeta } from './media/service';
import { setup } from './test-utils';
import { THEME_COMPAT } from './themes/compat';
import { loadPhpPattern } from './themes/php-patterns';

/**
 * The bundled Pressbase theme (themes/pressbase): discovered as a block
 * theme, every pattern converts, templates and parts parse into blocks
 * Pressbase knows, style variations load and meet WCAG AA contrast, the front
 * page renders, and the motion CSS is guarded by @supports and
 * prefers-reduced-motion.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

const THEME_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../themes/pressbase',
);

async function site() {
  const ctx = await setup();
  await ctx.install();
  await ctx.kernel.themes.activate('pressbase');
  return ctx;
}

async function page(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

async function filesIn(dir: string, ext: string): Promise<string[]> {
  return (await readdir(path.join(THEME_DIR, dir))).filter((n) => n.endsWith(ext)).sort();
}

const PATTERN_CONTEXT = {
  templateUri: '/wp-content/themes/pressbase',
  stylesheetUri: '/wp-content/themes/pressbase',
};

/** Every block in a tree, depth first. */
function* walk(blocks: ParsedBlock[]): Generator<ParsedBlock> {
  for (const block of blocks) {
    yield block;
    yield* walk(block.innerBlocks ?? []);
  }
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('the Pressbase theme', () => {
  it('is discovered as a block theme, with its compat entry', async () => {
    const ctx = await setup();
    await ctx.install();
    const info = await ctx.kernel.themes.get('pressbase');
    expect(info).toMatchObject({
      stylesheet: 'pressbase',
      template: 'pressbase',
      name: 'Pressbase',
      author: 'Pressbase contributors',
      requiresWp: '6.7',
      testedUpTo: '7.1',
      license: 'GPLv2 or later',
      textDomain: 'pressbase',
      screenshot: 'screenshot.png',
      isBlockTheme: true,
    });
    const listed = (await ctx.request('GET', '/wp/v2/themes')).body as {
      stylesheet: string;
      is_block_theme: boolean;
    }[];
    expect(listed.find((t) => t.stylesheet === 'pressbase')?.is_block_theme).toBe(true);

    // functions.php registers the same block styles and pattern categories as compat.ts.
    const functions = await readFile(path.join(THEME_DIR, 'functions.php'), 'utf8');
    const compat = THEME_COMPAT.pressbase;
    expect(compat?.stylesheets).toEqual(['style.css']);
    for (const style of compat?.blockStyles ?? []) {
      expect(functions).toContain(`'${style.block}'`);
      expect(functions).toContain(`'${style.name}'`);
    }
    for (const category of compat?.patternCategories ?? []) {
      expect(functions).toContain(`'${category.name}'`);
    }
  });

  it('activates, enqueues its stylesheet and registers its patterns and categories', async () => {
    const ctx = await site();
    const active = await ctx.kernel.themes.active();
    expect(active.info.stylesheet).toBe('pressbase');
    expect(active.stylesheets).toEqual(['/wp-content/themes/pressbase/style.css']);
    const patterns = ctx.kernel.blocks.patterns().filter((p) => p.source === 'theme');
    expect(patterns.length).toBe((await filesIn('patterns', '.php')).length);
    // Core's own patterns share the pressbase/ namespace: none is replaced.
    const core = new Set(CORE_PATTERNS.map((p) => p.name));
    expect(patterns.filter((p) => core.has(p.name))).toEqual([]);
    const visible = patterns.filter((p) => p.inserter !== false);
    expect(visible.length).toBeGreaterThanOrEqual(18);
    for (const pattern of visible) {
      if (pattern.categories?.includes('header') || pattern.categories?.includes('footer')) {
        continue;
      }
      expect(pattern.categories, pattern.name).toContain(
        pattern.name === 'pressbase/page-landing' ? 'pressbase_page' : 'pressbase',
      );
    }
    const categories = (await ctx.request('GET', '/wp/v2/block-patterns/categories')).body as {
      name: string;
    }[];
    expect(categories.map((c) => c.name)).toEqual(
      expect.arrayContaining(['pressbase', 'pressbase_page']),
    );
    // Theme files are served.
    const font = await ctx.app.request(
      '/wp-content/themes/pressbase/assets/fonts/platypi/Platypi-Italic-VariableFont_wght.woff2',
    );
    expect(font.status).toBe(200);
    expect((await ctx.app.request('/wp-content/themes/pressbase/style.css')).status).toBe(200);
  });

  it('converts every pattern with no skips, using only presets and translated text', async () => {
    for (const name of await filesIn('patterns', '.php')) {
      const source = await readFile(path.join(THEME_DIR, 'patterns', name), 'utf8');
      const result = loadPhpPattern(source, PATTERN_CONTEXT);
      expect(result, name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.pattern.slug).toBe(`pressbase/${name.slice(0, -4)}`);
      const { content } = result.pattern;
      expect(content, name).not.toContain('<?');
      // No hard-coded colours: presets only.
      expect(content.match(/#[0-9a-f]{3,8}\b/gi) ?? [], name).toEqual([]);
      expect(content.match(/(?:rgb|hsl)a?\(/gi) ?? [], name).toEqual([]);
      // No hard-coded font sizes or spacing outside presets.
      expect(content, name).not.toMatch(/font-size:\s*\d/);
      expect(content, name).not.toMatch(/(?:padding|margin)[a-z-]*:\s*\d*[1-9]/);
      // Every visible text node in the source comes from a translation call.
      const markup = source.slice(source.indexOf('?>') + 2);
      const text = markup
        .replace(/<\?php[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[\s/·]+/g, '');
      expect(text, name).toBe('');
      // Parses into blocks with nothing outside them but whitespace.
      for (const block of walk(parseBlocks(content))) {
        if (block.blockName === null) expect(block.innerHTML.trim(), name).toBe('');
      }
    }
  });

  it('parses every template and part into blocks Pressbase renders', async () => {
    const ctx = await site();
    const registry = ctx.kernel.blocks.registry;
    const known = new Set(ctx.kernel.blocks.patterns().map((p) => p.name));
    const sources: [string, string][] = [];
    for (const dir of ['templates', 'parts']) {
      for (const name of await filesIn(dir, '.html')) {
        sources.push([`${dir}/${name}`, await readFile(path.join(THEME_DIR, dir, name), 'utf8')]);
      }
    }
    for (const pattern of ctx.kernel.blocks.patterns()) {
      if (pattern.source === 'theme') sources.push([pattern.name, pattern.content]);
    }
    const active = await ctx.kernel.themes.active();
    expect([...active.templates.keys()].sort()).toEqual([
      '404',
      'archive',
      'home',
      'index',
      'page',
      'page-no-title',
      'search',
      'single',
    ]);
    expect([...active.parts.values()].map((p) => [p.slug, p.area])).toEqual([
      ['footer', 'footer'],
      ['header', 'header'],
    ]);
    for (const [name, source] of sources) {
      const blocks = parseBlocks(source);
      expect(blocks.length, name).toBeGreaterThan(0);
      for (const block of walk(blocks)) {
        if (block.blockName === null) {
          expect(block.innerHTML.trim(), name).toBe('');
          continue;
        }
        expect(registry.get(block.blockName), `${name}: ${block.blockName}`).toBeDefined();
        if (block.blockName === 'core/pattern') {
          expect(known.has(String(block.attrs.slug)), `${name}: ${block.attrs.slug}`).toBe(true);
        }
        if (block.blockName === 'core/template-part') {
          expect(active.parts.has(String(block.attrs.slug)), name).toBe(true);
        }
      }
    }
  });

  it('loads its style variations, and every text colour pair meets WCAG AA', async () => {
    const ctx = await site();
    const active = await ctx.kernel.themes.active();
    expect(active.variations.map((v) => v.title)).toEqual(['Midnight', 'Violet', 'Grotesk']);

    const themeJson = JSON.parse(await readFile(path.join(THEME_DIR, 'theme.json'), 'utf8'));
    const palettes: [string, { slug: string; color: string }[]][] = [
      ['Paper', themeJson.settings.color.palette],
    ];
    for (const variation of active.variations) {
      const config = applyStyleVariation({ version: 3 }, variation as StyleVariation);
      const styled = await ctx.kernel.themes.withUserStyles(config);
      expect(styled.css.global, variation.title).toContain('--wp--preset--color--base');
      const palette = (variation.settings as { color?: { palette?: { theme?: [] } } } | undefined)
        ?.color?.palette?.theme;
      if (palette) palettes.push([String(variation.title), palette]);
    }
    const midnight = active.variations.find((v) => v.title === 'Midnight');
    const dark = await ctx.kernel.themes.withUserStyles(
      applyStyleVariation({ version: 3 }, midnight as StyleVariation),
    );
    expect(dark.css.global).toContain('--wp--preset--color--base: #1b1b19;');
    expect(dark.css.global).toContain('--wp--preset--color--accent: #5b6cf0;');

    // Text on its backgrounds (4.5:1); the accent as a UI colour, e.g. focus rings (3:1).
    const pairs: [string, string, number][] = [
      ['contrast', 'base', 4.5],
      ['contrast', 'surface', 4.5],
      ['contrast', 'accent-soft', 4.5],
      ['base', 'contrast', 4.5],
      ['muted', 'base', 4.5],
      ['muted', 'surface', 4.5],
      ['muted', 'accent-soft', 4.5],
      ['accent-text', 'base', 4.5],
      ['accent-text', 'surface', 4.5],
      ['accent-text', 'accent-soft', 4.5],
      ['on-accent', 'accent', 4.5],
      ['accent', 'base', 3],
      ['accent', 'surface', 3],
    ];
    expect(palettes.map(([name]) => name)).toEqual(['Paper', 'Midnight', 'Violet']);
    for (const [name, palette] of palettes) {
      const color = (slug: string) => palette.find((c) => c.slug === slug)?.color ?? '';
      for (const [fg, bg, min] of pairs) {
        const ratio = contrast(color(fg), color(bg));
        expect(ratio, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          min,
        );
      }
    }
  });

  it('shows the latest posts on the home page, as Settings → Reading says', async () => {
    const ctx = await site();
    const { status, html } = await page(ctx, '/');
    expect(status).toBe(200);
    // No front-page template: the home page follows show_on_front.
    expect(html).toContain('Hello world!');
    expect(html).not.toContain('Publish ideas that <em>move</em> people.');
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
  });

  it('renders a static front page built from its patterns, with no unknown blocks', async () => {
    const ctx = await site();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      await ctx.kernel.themes.reload();
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes('pressbase'))).toEqual([]);

    // A landing page as the static front page, as an owner would set it up.
    const content = ['page-landing', 'bento-grid', 'stats', 'code-showcase', 'posts-grid']
      .map((slug) => `<!-- wp:pattern {"slug":"pressbase/${slug}"} /-->`)
      .join('\n');
    const created = await ctx.request('POST', '/wp/v2/pages', {
      title: 'Home',
      status: 'publish',
      content,
    });
    expect(created.status).toBe(201);
    // REST doesn't take `template` yet (Studio's page panel, #29), so set the meta as an import would.
    await setMeta(ctx.kernel, created.body.id, '_wp_page_template', 'page-no-title');
    await ctx.kernel.options.set('show_on_front', 'page');
    await ctx.kernel.options.set('page_on_front', created.body.id);

    const { status, html } = await page(ctx, '/');
    expect(status).toBe(200);
    expect(html).toContain('wp-theme-pressbase');
    expect(html).toContain('/wp-content/themes/pressbase/style.css?ver=1.0.0');
    expect(html).toContain('Platypi-VariableFont_wght.woff2');
    expect(html).toContain('<header class="wp-block-template-part">');
    expect(html).toContain('<footer class="wp-block-template-part">');
    expect(html).toMatch(
      /<h1 class="wp-block-heading has-text-align-center has-display-font-size"/,
    );
    expect(html).toContain('Publish ideas that <em>move</em> people.');
    for (const style of [
      'is-style-gradient',
      'is-style-marquee',
      'is-style-reveal',
      'is-style-lift',
      'is-style-glass',
      'is-style-pill',
    ]) {
      expect(html, style).toContain(style);
    }
    // Section styles are generated per instance.
    expect(html).toMatch(/is-style-section-ink--[0-9a-z-]+/);
    // The latest posts query and the grid span container queries.
    expect(html).toContain('Hello world!');
    expect(html).toMatch(/@container \(max-width: [\d.]+rem \)\{\.wp-container-content-/);
    expect(html).toContain(
      'Powered by <a href="https://github.com/WarnHack-Technologies-Private-Limited/pressbase" rel="nofollow">Pressbase</a>',
    );
    // Exactly one h1, nothing left unrendered.
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).not.toContain('<?php');
    expect(html).not.toContain('<!-- wp:');
  });

  it('renders a post, a page, an archive, search and a 404', async () => {
    const ctx = await site();
    const created = (
      await ctx.request('POST', '/wp/v2/pages', {
        title: 'About us',
        status: 'publish',
        content: '<!-- wp:paragraph --><p>Page body.</p><!-- /wp:paragraph -->',
      })
    ).body as { link: string };
    const views: [string, number, string][] = [
      ['/2026/', 200, 'Hello world!'],
      [new URL(created.link).pathname, 200, 'Page body.'],
      ['/category/uncategorized/', 200, 'Category: <span>Uncategorized</span>'],
      ['/?s=hello', 200, 'Hello world!'],
      ['/?s=zzzz', 200, 'Nothing here yet'],
      ['/no-such-page/', 404, 'This page took <em>another</em> road.'],
    ];
    const hello = (await ctx.request('GET', '/wp/v2/posts?slug=hello-world')).body[0] as {
      link: string;
    };
    views.push([new URL(hello.link).pathname, 200, 'wp-block-post-comments-form']);
    for (const [url, expected, text] of views) {
      const { status, html } = await page(ctx, url);
      expect(status, url).toBe(expected);
      expect(html, url).toContain(text);
      expect(html.match(/<h1[\s>]/g)?.length, url).toBe(1);
      expect(html, url).not.toContain('<!-- wp:');
    }
  });

  it("writes block custom CSS that WordPress's `&` splitting keeps whole", async () => {
    // process_blocks_custom_css() splits on every `&`, so `& a, & b{…}` would leave a stray
    // `a,` behind: each nested selector needs its own rule.
    const theme = JSON.parse(await readFile(path.join(THEME_DIR, 'theme.json'), 'utf8'));
    const blocks = Object.entries(theme.styles.blocks as Record<string, { css?: string }>);
    for (const [name, { css }] of blocks) {
      if (!css) continue;
      for (const part of css.split('&').filter((p) => p.trim())) {
        expect(part, name).toMatch(/^[^{},]+\{[^{}]*\}\s*$/);
      }
    }
  });

  it('guards its motion CSS with @supports and prefers-reduced-motion', async () => {
    const source = await readFile(path.join(THEME_DIR, 'style.css'), 'utf8');
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    // Small: under 15 KB, header comment included.
    expect(Buffer.byteLength(source)).toBeLessThan(15 * 1024);
    for (const header of [
      'Theme Name: Pressbase',
      'Author: Pressbase contributors',
      'Requires at least: 6.7',
      'Tested up to: 7.1',
      'License: GPLv2 or later',
      'Text Domain: pressbase',
    ]) {
      expect(source).toContain(header);
    }

    /** The top-level at-rule blocks: [prelude, body]. */
    const blocks: [string, string][] = [];
    let outside = '';
    for (let i = 0; i < css.length; ) {
      const at = css.indexOf('@', i);
      if (at === -1) {
        outside += css.slice(i);
        break;
      }
      const open = css.indexOf('{', at);
      let depth = 1;
      let end = open + 1;
      while (depth > 0 && end < css.length) {
        if (css[end] === '{') depth++;
        else if (css[end] === '}') depth--;
        end++;
      }
      outside += css.slice(i, at);
      blocks.push([css.slice(at, open).trim(), css.slice(open + 1, end - 1)]);
      i = end;
    }
    const supports = blocks.filter(([prelude]) =>
      prelude.startsWith('@supports (animation-timeline'),
    );
    expect(supports.length).toBe(2);

    // Nothing starts hidden, and no scroll timeline is used, outside the @supports blocks.
    const unguarded =
      outside +
      blocks
        .filter((b) => !supports.includes(b))
        .map(([, body]) => body)
        .join('');
    expect(unguarded).not.toMatch(/opacity:\s*0(?:[;\s}]|\.0*[;\s}])/);
    expect(unguarded).not.toContain('animation-timeline');
    const guarded = supports.map(([, body]) => body).join('');
    expect(guarded).toMatch(/opacity:\s*0;/);
    expect(guarded).toContain('animation-timeline: view()');
    expect(guarded).toContain('animation-timeline: scroll(root)');

    // Keyframes animate only transform and opacity.
    for (const [, body] of css.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
      for (const [, declarations] of (body ?? '').matchAll(/\{([^{}]*)\}/g)) {
        for (const property of (declarations ?? '').matchAll(/([a-z-]+)\s*:/g)) {
          expect(['transform', 'opacity']).toContain(property[1]);
        }
      }
    }
    // Transitions too.
    for (const [, value] of css.matchAll(/transition:\s*([^;]+);/g)) {
      for (const part of (value ?? '').split(',')) {
        expect(['transform', 'translate', 'scale', 'opacity', 'none']).toContain(
          part.trim().split(/\s+/)[0],
        );
      }
    }

    // Reduced motion stops every animation and transition.
    const reduced = blocks.find(
      ([prelude]) => prelude === '@media (prefers-reduced-motion: reduce)',
    );
    expect(reduced?.[1]).toMatch(/animation:\s*none\s*!important/);
    expect(reduced?.[1]).toMatch(/transition:\s*none\s*!important/);
  });
});
