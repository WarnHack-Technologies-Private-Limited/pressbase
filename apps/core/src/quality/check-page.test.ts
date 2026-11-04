import { describe, expect, it } from 'vitest';
import {
  type CheckedBlockType,
  type CheckRule,
  checkPage,
  type PageStyles,
  pageStylesFromThemeJson,
} from './check-page';

/** Unit tests for each quality check (pure; the API test is quality.test.ts). */

const type = (args: Partial<CheckedBlockType> = {}): CheckedBlockType => ({
  parent: null,
  ancestor: null,
  allowedBlocks: null,
  attributes: {},
  ...args,
});

const TYPES: Record<string, CheckedBlockType> = {
  'core/paragraph': type({ attributes: { dropCap: { type: 'boolean' } } }),
  'core/heading': type({ attributes: { level: { type: 'integer' } } }),
  'core/group': type(),
  'core/image': type(),
  'core/cover': type(),
  'core/buttons': type({ allowedBlocks: ['core/button'] }),
  'core/button': type({ parent: ['core/buttons'] }),
  'core/columns': type({ allowedBlocks: ['core/column'] }),
  'core/column': type({ parent: ['core/columns'] }),
  'core/list': type({ allowedBlocks: ['core/list-item'] }),
  'core/list-item': type(),
  'core/comment-content': type({ ancestor: ['core/comment-template'] }),
};
const blockTypes = { get: (name: string) => TYPES[name] };

const STYLES: PageStyles = {
  palette: {
    base: '#f6f6f3',
    surface: '#ffffff',
    contrast: '#1b1b19',
    muted: '#5c5c57',
    accent: '#3b4cca',
    'accent-text': '#3343c0',
    'on-accent': '#ffffff',
    pale: '#e2e2dc',
  },
  text: 'var:preset|color|contrast',
  background: 'var:preset|color|base',
  link: 'var:preset|color|accent-text',
  button: { text: 'var:preset|color|on-accent', background: 'var:preset|color|accent' },
  variations: {
    'section-ink': { text: '#f6f6f3', background: '#1b1b19', link: '#f6f6f3' },
  },
};

const only = (rule: CheckRule, markup: string, styles: PageStyles | null = STYLES, extra = {}) =>
  checkPage(markup, styles, { blockTypes, rules: [rule], ...extra });

const p = (text: string, attrs = '') =>
  `<!-- wp:paragraph${attrs ? ` ${attrs}` : ''} --><p>${text}</p><!-- /wp:paragraph -->`;
const h = (level: number, text = 'Heading') =>
  `<!-- wp:heading {"level":${level}} --><h${level} class="wp-block-heading">${text}</h${level}><!-- /wp:heading -->`;

describe('blocks', () => {
  it('passes valid markup', () => {
    const markup = `<!-- wp:group --><div class="wp-block-group">${p('Hello')}<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="/contact">Contact us</a></div><!-- /wp:button --></div><!-- /wp:buttons --></div><!-- /wp:group -->`;
    expect(checkPage(markup, STYLES, { blockTypes })).toEqual([]);
  });

  it('reports unknown blocks with their path', () => {
    const findings = only(
      'block_unknown',
      `<!-- wp:group --><div>${p('a')}<!-- wp:acme/slider /--></div><!-- /wp:group -->`,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'block_unknown',
        severity: 'error',
        block: { path: [0, 1], name: 'acme/slider' },
      }),
    ]);
    // Without block types, unknown blocks aren't known to be unknown.
    expect(checkPage('<!-- wp:acme/slider /-->', null, { rules: ['block_unknown'] })).toEqual([]);
  });

  it('reports broken delimiters, content outside blocks, bad attributes and misplaced blocks', () => {
    const unclosed = only('block_invalid', '<!-- wp:group --><div>');
    expect(unclosed[0]?.message).toBe('The core/group block is never closed.');
    const stray = only('block_invalid', `${p('a')}<!-- /wp:heading -->`);
    expect(stray[0]?.message).toBe('A closing core/heading delimiter has no matching opening one.');
    expect(only('block_invalid', `${p('a')}<p>Loose HTML</p>`)[0]).toMatchObject({
      message: 'Some content is outside any block.',
      block: { path: [1], name: null },
    });
    expect(only('block_invalid', p('a', '{"dropCap":"yes"}'))[0]).toMatchObject({
      block: { path: [0], name: 'core/paragraph' },
      data: { attribute: 'dropCap' },
    });
    // A button outside Buttons, a paragraph inside a list, a comment block outside its template.
    const misplaced = only(
      'block_invalid',
      `<!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="/x">Go to x</a></div><!-- /wp:button --><!-- wp:list --><ul>${p('x')}</ul><!-- /wp:list --><!-- wp:comment-content /-->`,
    );
    expect(misplaced.map((f) => f.message)).toEqual([
      'The core/button block must be inside core/buttons.',
      'The core/list block can’t contain core/paragraph.',
      'The core/comment-content block must be inside core/comment-template.',
    ]);
  });
});

describe('headings', () => {
  it('reports a second h1', () => {
    const findings = only('heading_multiple_h1', h(1) + h(2) + h(1));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.block).toEqual({ path: [2], name: 'core/heading' });
    // When the template's title is the h1, any h1 in the content is a second one.
    expect(only('heading_multiple_h1', h(1), STYLES, { titleIsH1: true })).toHaveLength(1);
  });

  it('reports skipped levels, counting the title when it is the h1', () => {
    const findings = only('heading_skipped', h(1) + h(2) + h(4) + h(2) + h(3));
    expect(findings).toEqual([
      expect.objectContaining({
        block: { path: [2], name: 'core/heading' },
        data: { from: 2, to: 4 },
      }),
    ]);
    expect(only('heading_skipped', h(3), STYLES, { titleIsH1: true })).toHaveLength(1);
    // A heading defaults to h2.
    expect(
      only(
        'heading_skipped',
        `${h(1)}<!-- wp:heading --><h2 class="wp-block-heading">Two</h2><!-- /wp:heading -->${h(3)}`,
      ),
    ).toEqual([]);
  });

  it('reports a missing h1 only when the template has no title heading', () => {
    expect(only('heading_no_h1', h(2), STYLES, { titleIsH1: false })).toHaveLength(1);
    expect(only('heading_no_h1', h(2))).toEqual([]);
    expect(only('heading_no_h1', h(2), STYLES, { titleIsH1: true })).toEqual([]);
  });
});

describe('images', () => {
  const image = (img: string, attrs = '') =>
    `<!-- wp:image${attrs ? ` ${attrs}` : ''} --><figure class="wp-block-image">${img}</figure><!-- /wp:image -->`;

  it('reports images without alt text', () => {
    expect(only('image_alt', image('<img src="/a.jpg" alt=""/>'))).toEqual([
      expect.objectContaining({ rule: 'image_alt', block: { path: [0], name: 'core/image' } }),
    ]);
    expect(only('image_alt', image('<img src="/a.jpg"/>'))).toHaveLength(1);
    expect(only('image_alt', image('<img src="/a.jpg" alt="A loaf on a board"/>'))).toEqual([]);
  });

  it('accepts images marked decorative, and leaves backgrounds and empty images alone', () => {
    expect(
      only('image_alt', image('<img src="/a.jpg" alt=""/>', '{"metadata":{"decorative":true}}')),
    ).toEqual([]);
    expect(only('image_alt', image('<img src="/a.jpg" alt="" role="presentation"/>'))).toEqual([]);
    expect(only('image_alt', image('<img src="/a.jpg" alt="" aria-hidden="true"/>'))).toEqual([]);
    expect(only('image_alt', image('<img src="" alt=""/>'))).toEqual([]);
    expect(
      only(
        'image_alt',
        '<!-- wp:cover {"url":"/bg.jpg"} --><div class="wp-block-cover"><img class="wp-block-cover__image-background" src="/bg.jpg" alt=""/></div><!-- /wp:cover -->',
      ),
    ).toEqual([]);
  });
});

describe('placeholders', () => {
  it('lists bracketed text, # links and missing images, with their blocks', () => {
    const markup = `${h(1, 'Fresh bread')}${p('[Add your opening hours]')}<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="#">Order now</a></div><!-- /wp:button --></div><!-- /wp:buttons --><!-- wp:image --><figure class="wp-block-image"><img src="" alt=""/></figure><!-- /wp:image -->`;
    const findings = only('placeholder', markup);
    expect(findings.map((f) => [f.data?.reason, f.block?.path, f.severity])).toEqual([
      ['text', [1], 'warning'],
      ['link', [2, 0], 'warning'],
      ['image', [3], 'warning'],
    ]);
  });
});

describe('links', () => {
  it('reports empty and vague link text', () => {
    const findings = only(
      'link_text',
      p(
        '<a href="/menu">Click here</a> for the menu, or <a href="/x"></a>. <a href="/about">Read more…</a>',
      ),
    );
    expect(findings.map((f) => [f.severity, f.data?.text])).toEqual([
      ['warning', 'Click here'],
      ['error', undefined],
      ['warning', 'Read more…'],
    ]);
  });

  it('accepts descriptive text, an aria-label or an image’s alt', () => {
    expect(
      only(
        'link_text',
        p(
          '<a href="/menu">See the menu</a> <a href="/x" aria-label="Our bakery on the map">here</a> <a href="/"><img src="/logo.png" alt="Home"/></a>',
        ),
      ),
    ).toEqual([]);
  });
});

describe('raw colours', () => {
  it('reports colour values outside the presets, naming a preset with the same value', () => {
    const findings = only(
      'color_raw',
      p(
        'Hi',
        '{"style":{"color":{"text":"#3b4cca","background":"#123456"},"elements":{"link":{"color":{"text":"rgb(1, 2, 3)"}}}}}',
      ),
    );
    expect(findings.map((f) => f.data)).toEqual([
      { property: 'style.color.text', value: '#3b4cca', preset: 'accent' },
      { property: 'style.color.background', value: '#123456' },
      { property: 'style.elements.link.color.text', value: 'rgb(1, 2, 3)' },
    ]);
  });

  it('accepts presets, keywords and gradients made of presets', () => {
    expect(
      only(
        'color_raw',
        p(
          'Hi',
          '{"textColor":"contrast","style":{"color":{"background":"var:preset|color|base","gradient":"linear-gradient(135deg, var(--wp--preset--color--accent) 0%, var(--wp--preset--color--violet) 100%)"},"border":{"color":"transparent"}}}',
        ),
      ),
    ).toEqual([]);
  });
});

describe('contrast', () => {
  it('passes the theme’s own pairs', () => {
    const markup = `${p('Body text with <a href="/x">a link to x</a>')}<!-- wp:group {"className":"is-style-section-ink"} --><div class="wp-block-group is-style-section-ink">${p('Light on ink with <a href="/y">a link to y</a>')}</div><!-- /wp:group -->`;
    expect(only('contrast', markup)).toEqual([]);
  });

  it('reports a pair below AA once, on the block that set it', () => {
    const markup = `<!-- wp:group {"backgroundColor":"contrast"} --><div class="wp-block-group has-contrast-background-color">${p('One')}${p('Two')}</div><!-- /wp:group -->`;
    const findings = only('contrast', markup);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'contrast',
        severity: 'error',
        block: { path: [0], name: 'core/group' },
        data: expect.objectContaining({
          kind: 'text',
          text: '#1b1b19',
          background: '#1b1b19',
          min: 4.5,
          example: [0, 0],
        }),
      }),
    ]);
  });

  it('lets large text pass at 3:1 and holds body text to 4.5:1', () => {
    // #767676 on white is 4.54:1; #949494 is 3.03:1.
    const styles = {
      ...STYLES,
      palette: { ...STYLES.palette, mid: '#949494' },
      background: '#ffffff',
    };
    const heading = `<!-- wp:heading {"level":2,"textColor":"mid"} --><h2 class="wp-block-heading has-mid-color">Big</h2><!-- /wp:heading -->`;
    expect(only('contrast', heading, styles)).toEqual([]);
    expect(only('contrast', p('Small', '{"textColor":"mid"}'), styles)).toHaveLength(1);
  });

  it('checks buttons against the theme’s button colours or their own', () => {
    const button = (attrs: string) =>
      `<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button ${attrs} --><div class="wp-block-button"><a class="wp-block-button__link" href="/x">Book a table</a></div><!-- /wp:button --></div><!-- /wp:buttons -->`;
    expect(only('contrast', button('{}'))).toEqual([]);
    expect(only('contrast', button('{"backgroundColor":"pale"}'))[0]).toMatchObject({
      block: { path: [0, 0], name: 'core/button' },
      data: { kind: 'button', text: '#ffffff', background: '#e2e2dc' },
    });
    // An outline button is drawn on the background it sits on.
    expect(only('contrast', button('{"className":"is-style-outline"}'))).toEqual([]);
  });

  it('reports the site’s own body colours, and skips unknown backgrounds', () => {
    const bad = { ...STYLES, text: 'var:preset|color|pale' };
    expect(only('contrast', p('Hi'), bad)[0]).toMatchObject({ block: null });
    const cover = `<!-- wp:cover {"url":"/photo.jpg","dimRatio":30} --><div class="wp-block-cover"><div class="wp-block-cover__inner-container">${p('Over a photo', '{"textColor":"pale"}')}</div></div><!-- /wp:cover -->`;
    expect(only('contrast', cover)).toEqual([]);
    const gradient = `<!-- wp:group {"gradient":"accent"} --><div class="wp-block-group">${p('On a gradient', '{"textColor":"pale"}')}</div><!-- /wp:group -->`;
    expect(only('contrast', gradient)).toEqual([]);
    // Without styles there's nothing to check against.
    expect(only('contrast', p('Hi', '{"textColor":"pale"}'), null)).toEqual([]);
  });
});

describe('pageStylesFromThemeJson()', () => {
  it('reads the palette by origin, the element colours and the variations', () => {
    const styles = pageStylesFromThemeJson({
      settings: {
        color: {
          palette: {
            default: [{ slug: 'black', color: '#000000' }],
            theme: [
              { slug: 'base', color: '#ffffff' },
              { slug: 'ink', color: '#111111' },
            ],
            custom: [{ slug: 'base', color: '#fafafa' }],
          },
        },
      },
      styles: {
        color: { text: 'var:preset|color|ink', background: 'var(--wp--preset--color--base)' },
        elements: {
          link: { color: { text: '#0000ee' } },
          button: { color: { text: '#ffffff', background: 'var:preset|color|ink' } },
        },
        blocks: {
          'core/group': {
            variations: {
              dark: { color: { background: 'var:preset|color|ink', text: '#ffffff' } },
            },
          },
        },
      },
    });
    expect(styles).toEqual({
      palette: { black: '#000000', base: '#fafafa', ink: '#111111' },
      text: '#111111',
      background: '#fafafa',
      link: '#0000ee',
      button: { text: '#ffffff', background: '#111111' },
      variations: { dark: { text: '#ffffff', background: '#111111' } },
    });
  });
});
