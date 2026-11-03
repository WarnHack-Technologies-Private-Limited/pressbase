import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blockVisibility, imagesFetchPriorityAuto } from './themes/block-visibility';
import { blockStateStyles, buildStateSelector } from './themes/states';
import { setup } from './test-utils';

/**
 * WordPress 7.1's responsive block styles: per-instance `@mobile` / `@tablet`
 * and pseudo-state styles (block-supports/states.php), block visibility per
 * device (block-supports/block-visibility.php) and theme breakpoints
 * (settings.viewport). The expected CSS and class hashes were worked out by
 * hand from the PHP for the same attributes. See ADR 0023.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

/** md5 of wp_json_encode( array( 'blockName' => …, 'rules' => … ) ), as states.php hashes it. */
const stateClass = (phpJson: string) =>
  `wp-states-${createHash('md5').update(phpJson).digest('hex').slice(0, 8)}`;

const BUTTON_SELECTORS = {
  root: '.wp-block-button .wp-block-button__link',
  typography: { writingMode: '.wp-block-button' },
  dimensions: { root: '.wp-block-button', width: '.wp-block-button' },
};

describe('per-instance state styles (states.php)', () => {
  it('puts a heading’s @mobile font size in a media query, under a hashed class', () => {
    const result = blockStateStyles({
      blockName: 'core/heading',
      style: { typography: { fontSize: '3rem' }, '@mobile': { typography: { fontSize: '2rem' } } },
      selectors: {},
      rootSelector: '.wp-block-heading',
      viewport: undefined,
    });
    const className = stateClass(
      '{"blockName":"core\\/heading","rules":[{"state":"","selector":null,"declarations":{"font-size":"2rem"},"rules_group":"@media (width <= 480px)"}]}',
    );
    expect(result).toEqual({
      className,
      css: `@media (width <= 480px){.${className}{font-size:2rem !important;}}`,
    });
  });

  it('handles pseudo states, presets, feature selectors, elements, borders and theme breakpoints', () => {
    const result = blockStateStyles({
      blockName: 'core/button',
      style: {
        ':hover': { color: { background: 'var:preset|color|contrast' } },
        '@tablet': {
          typography: { writingMode: 'vertical-rl', textAlign: 'center' },
          border: { color: '#000' },
          elements: { link: { color: { text: 'red' }, ':hover': { color: { text: 'blue' } } } },
          ':hover': { color: { text: '#fff' } },
          layout: { selfStretch: 'fill' },
        },
      },
      selectors: BUTTON_SELECTORS,
      rootSelector: '.wp-block-button .wp-block-button__link',
      viewport: { mobile: '30em', tablet: '60em' },
    });
    const tablet = '@media (30em < width <= 60em)';
    const className = stateClass(
      '{"blockName":"core\\/button","rules":[' +
        '{"state":":hover","selector":".wp-block-button .wp-block-button__link","declarations":{"background-color":"var(--wp--preset--color--contrast)"}},' +
        `{"state":"","selector":".wp-block-button","declarations":{"writing-mode":"vertical-rl"},"rules_group":"${tablet}"},` +
        // textAlign and border share the root selector, so they are one group.
        `{"state":"","selector":".wp-block-button .wp-block-button__link","declarations":{"border-color":"#000","text-align":"center"},"rules_group":"${tablet}"},` +
        `{"state":"","selector":".wp-block-button .wp-block-button__link a:where(:not(.wp-element-button))","declarations":{"color":"red"},"rules_group":"${tablet}"},` +
        `{"state":":hover","selector":".wp-block-button .wp-block-button__link a:where(:not(.wp-element-button))","declarations":{"color":"blue"},"rules_group":"${tablet}"},` +
        `{"state":":hover","selector":".wp-block-button .wp-block-button__link","declarations":{"color":"#fff"},"rules_group":"${tablet}"}]}`,
    );
    const c = `.${className}`;
    expect(result?.className).toBe(className);
    expect(result?.css).toBe(
      `${c} .wp-block-button__link:hover{background-color:var(--wp--preset--color--contrast) !important;background-image:unset !important;}` +
        `${tablet}{${c}{writing-mode:vertical-rl !important;}}` +
        `${tablet}{${c} .wp-block-button__link{border-color:#000 !important;text-align:center !important;border-style:solid;}}` +
        `${tablet}{${c} .wp-block-button__link a:where(:not(.wp-element-button)){color:red !important;}}` +
        `${tablet}{${c} .wp-block-button__link a:where(:not(.wp-element-button)):hover{color:blue !important;}}` +
        `${tablet}{${c} .wp-block-button__link:hover{color:#fff !important;}}`,
    );
  });

  it('ignores pseudo states on blocks without them, and blocks without states', () => {
    expect(
      blockStateStyles({
        blockName: 'core/heading',
        style: { ':hover': { color: { text: 'red' } }, color: { text: 'blue' } },
        selectors: {},
        rootSelector: '.wp-block-heading',
        viewport: undefined,
      }),
    ).toBeNull();
  });

  it('builds selectors as wp_build_state_selector() does', () => {
    expect(buildStateSelector('.x', null, ':hover')).toBe('.x:hover');
    expect(buildStateSelector('.x', '.wp-block-image img, .wp-block-image .c', '')).toBe(
      '.x img, .x .c',
    );
    expect(buildStateSelector('.x', '.wp-block-heading  h2', '')).toBe('.x  h2');
  });
});

describe('block visibility (block-visibility.php)', () => {
  it('hides a block everywhere with false, whatever its support', () => {
    expect(blockVisibility({ metadata: { blockVisibility: false } }, false, undefined)).toEqual({
      hidden: true,
    });
  });

  it('hides a block per device with classes and media queries, sorted', () => {
    expect(
      blockVisibility(
        { metadata: { blockVisibility: { viewport: { tablet: false, mobile: false, desktop: true } } } },
        true,
        undefined,
      ),
    ).toEqual({
      hidden: false,
      classes: ['wp-block-hidden-mobile', 'wp-block-hidden-tablet'],
      css:
        '@media (width <= 480px){.wp-block-hidden-mobile{display:none !important;}}' +
        '@media (480px < width <= 782px){.wp-block-hidden-tablet{display:none !important;}}',
    });
    expect(
      blockVisibility(
        { metadata: { blockVisibility: { viewport: { desktop: false, watch: false } } } },
        true,
        { mobile: '600px', tablet: '1000px' },
      ),
    ).toEqual({
      hidden: false,
      classes: ['wp-block-hidden-desktop'],
      css: '@media (width > 1000px){.wp-block-hidden-desktop{display:none !important;}}',
    });
  });

  it('leaves blocks alone without the support or without hidden devices', () => {
    const attrs = { metadata: { blockVisibility: { viewport: { mobile: false } } } };
    expect(blockVisibility(attrs, false, undefined)).toBeNull();
    expect(blockVisibility({ metadata: { blockVisibility: { viewport: { mobile: true } } } }, true, undefined)).toBeNull();
    expect(blockVisibility({}, true, undefined)).toBeNull();
  });

  it('gives images of a block hidden on some devices fetchpriority=auto', () => {
    expect(
      imagesFetchPriorityAuto(
        '<figure><img src="a.jpg" fetchpriority="high" alt=""><img src="b.jpg"/></figure>',
      ),
    ).toBe(
      '<figure><img src="a.jpg" fetchpriority="auto" alt=""><img fetchpriority="auto" src="b.jpg"/></figure>',
    );
  });
});

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

async function renderedPost(ctx: Ctx, content: string) {
  const res = await ctx.request('POST', '/wp/v2/posts', {
    status: 'publish',
    title: 'Responsive',
    content,
  });
  expect(res.status).toBe(201);
  const link = new URL(res.body.link as string);
  const page = await ctx.app.request(
    `/wp-json/pressbase/v1/render?url=${encodeURIComponent(link.pathname)}`,
  );
  return ((await page.json()) as { html: string }).html;
}

const supportCss = (html: string) =>
  /<style id='core-block-supports-inline-css'>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

describe('responsive styles on the public site', () => {
  it('prints state and visibility CSS in the block supports stylesheet, not inline', async () => {
    const ctx = await site();
    const html = await renderedPost(
      ctx,
      '<!-- wp:heading {"style":{"typography":{"fontSize":"3rem"},"@mobile":{"typography":{"fontSize":"2rem"}}}} -->' +
        '<h2 class="wp-block-heading" style="font-size:3rem">Small on phones</h2><!-- /wp:heading -->' +
        '<!-- wp:heading {"style":{"typography":{"fontSize":"3rem"},"@mobile":{"typography":{"fontSize":"2rem"}}}} -->' +
        '<h2 class="wp-block-heading" style="font-size:3rem">Same styles, same class</h2><!-- /wp:heading -->' +
        '<!-- wp:paragraph {"metadata":{"blockVisibility":{"viewport":{"mobile":false}}}} -->' +
        '<p>Not on phones</p><!-- /wp:paragraph -->' +
        '<!-- wp:paragraph {"metadata":{"blockVisibility":false}} --><p>Never shown</p><!-- /wp:paragraph -->',
    );
    const className = stateClass(
      '{"blockName":"core\\/heading","rules":[{"state":"","selector":null,"declarations":{"font-size":"2rem"},"rules_group":"@media (width <= 480px)"}]}',
    );
    // The base size stays inline (and fluid); the state only adds a class.
    expect(html).toMatch(
      new RegExp(`<h2 class="wp-block-heading ${className}" style="font-size:clamp\\([^"]+\\);">Small on phones</h2>`),
    );
    expect(html).toContain(`<h2 class="wp-block-heading ${className}" style="font-size:clamp(`);
    expect(html).toMatch(new RegExp(`${className}" style="[^"]+">Same styles, same class</h2>`));
    expect(html).toContain('<p class="wp-block-hidden-mobile">Not on phones</p>');
    expect(/<div class="entry-content[\s\S]*?<\/div>/.exec(html)?.[0]).not.toContain('Never shown');
    const css = supportCss(html);
    const rule = `@media (width <= 480px){.${className}{font-size:2rem !important;}}`;
    expect(css.split(rule).length).toBe(2); // once, for both headings
    expect(css).toContain('@media (width <= 480px){.wp-block-hidden-mobile{display:none !important;}}');
  });

  it('uses the breakpoints saved in global styles, for blocks and theme.json states', async () => {
    const ctx = await site();
    const themes = await ctx.request('GET', '/wp/v2/themes?status=active');
    const href: string = themes.body[0]._links['wp:user-global-styles'][0].href;
    const id = Number(href.split('/').pop());
    const saved = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: { viewport: { mobile: '600px', tablet: '1024px' } },
      styles: { blocks: { 'core/heading': { '@tablet': { typography: { letterSpacing: '0' } } } } },
    });
    expect(saved.status).toBe(200);
    const html = await renderedPost(
      ctx,
      '<!-- wp:paragraph {"metadata":{"blockVisibility":{"viewport":{"tablet":false}}}} -->' +
        '<p>Not on tablets</p><!-- /wp:paragraph -->',
    );
    expect(supportCss(html)).toContain(
      '@media (600px < width <= 1024px){.wp-block-hidden-tablet{display:none !important;}}',
    );
    expect(html).toContain(
      '@media (600px < width <= 1024px){:root :where(.wp-block-heading){letter-spacing: 0;}}',
    );
  });
});
