import { describe, expect, it } from 'vitest';
import {
  checkOperations,
  EDIT_OPERATION_SCHEMA,
  EDIT_OPERATION_TYPES,
  isSafeLink,
  presetProblem,
  SECTION_OPERATION_SCHEMA,
} from './index';

const design = {
  mood: 'warm',
  hue: 140,
  contrast: 'standard',
  scheme: 'light',
  fontPair: 'geometric',
  radius: 'soft',
  density: 'comfortable',
};

const valid = [
  { type: 'insertSection', pattern: 'pressbase/faq', slots: { title: 'Questions' }, index: 2 },
  { type: 'replaceSection', page: 'about-us', index: 0, pattern: 'pressbase/hero-centered' },
  { type: 'moveSection', page: 12, index: 3, to: 0 },
  { type: 'removeSection', index: 1 },
  { type: 'updateSlots', index: 0, slots: { title: 'Fresh bread' } },
  {
    type: 'updateBlockAttributes',
    index: 1,
    block: [0, 2],
    attributes: {
      backgroundColor: 'accent',
      textColor: null,
      style: { spacing: { padding: { top: 'var:preset|spacing|50' } } },
    },
  },
  { type: 'setGlobalStyles', design },
  {
    type: 'setGlobalStyles',
    styles: { elements: { button: { border: { radius: 'var:preset|border-radius|full' } } } },
  },
  { type: 'updateTemplatePart', slug: 'footer', slots: { title: 'Say hello' } },
  { type: 'createPage', title: 'FAQ', sections: [{ pattern: 'pressbase/faq' }] },
  {
    type: 'updateMenu',
    items: [
      { label: 'Home', url: '/' },
      { label: 'FAQ', page: 'faq' },
      { label: 'Map', url: 'https://example.org/map' },
    ],
  },
];

describe('checkOperations()', () => {
  it('takes one of each operation', () => {
    const { operations, problems } = checkOperations(valid);
    expect(problems).toEqual([]);
    expect(operations).toHaveLength(valid.length);
    expect(new Set(operations.map((o) => o.type))).toEqual(new Set(EDIT_OPERATION_TYPES));
  });

  it('refuses an empty set, or one too long', () => {
    expect(checkOperations([]).problems[0]?.message).toMatch(/no changes/);
    expect(checkOperations(Array(31).fill(valid[3])).problems[0]?.message).toMatch(/At most 30/);
  });

  it('says where and what for each problem, and accepts nothing then', () => {
    const { operations, problems } = checkOperations([
      valid[0],
      { type: 'deleteSite' },
      { type: 'removeSection', index: -1 },
      { type: 'insertSection' },
      { type: 'moveSection', index: 0, to: 1, extra: true },
    ]);
    expect(operations).toEqual([]);
    expect(problems).toEqual([
      { path: 'operations[1].type', message: '“deleteSite” isn’t an operation Studio knows.' },
      {
        path: 'operations[2].index',
        message: 'A section’s position is a whole number from 0.',
      },
      { path: 'operations[3].pattern', message: 'This is needed.' },
      { path: 'operations[4].extra', message: '“extra” isn’t part of this operation.' },
    ]);
  });

  it('allows presets only in block attributes', () => {
    const attributes = (attributes: object) => [
      { type: 'updateBlockAttributes', index: 0, attributes },
    ];
    expect(checkOperations(attributes({ backgroundColor: '#ff0000' })).problems[0]?.message).toBe(
      'Use a preset’s slug, such as accent.',
    );
    expect(
      checkOperations(attributes({ style: { color: { background: 'rgb(0, 0, 0)' } } })).problems[0],
    ).toEqual({
      path: 'operations[0].attributes.style.color.background',
      message: '“rgb(0, 0, 0)” isn’t a preset. Use a preset reference such as var:preset|color|accent.',
    });
    expect(checkOperations(attributes({ className: 'x' })).problems[0]?.message).toMatch(
      /can’t be changed here/,
    );
    expect(checkOperations(attributes({})).problems[0]?.message).toMatch(/at least one/);
  });

  it('allows presets only in global styles, and no CSS', () => {
    const styles = (styles: object) => [{ type: 'setGlobalStyles', styles }];
    expect(checkOperations(styles({ color: { text: '#000' } })).problems).toHaveLength(1);
    expect(checkOperations(styles({ css: 'body{}' })).problems[0]?.message).toMatch(/CSS/);
    expect(
      checkOperations(styles({ blocks: { 'core/cover': { background: 'url(x.png)' } } })).problems,
    ).toHaveLength(1);
    expect(checkOperations([{ type: 'setGlobalStyles' }]).problems[0]?.message).toMatch(/design/);
    expect(
      checkOperations([{ type: 'setGlobalStyles', design: { ...design, hue: 400 } }]).problems[0]
        ?.path,
    ).toBe('operations[0].design.hue');
  });

  it('checks new pages, parts and menus', () => {
    expect(
      checkOperations([{ type: 'createPage', title: 'X', sections: [] }]).problems[0]?.message,
    ).toMatch(/one to ten/);
    expect(
      checkOperations([{ type: 'createPage', title: 'X', sections: [{ slots: {} }] }]).problems[0]
        ?.path,
    ).toBe('operations[0].sections[0].pattern');
    expect(checkOperations([{ type: 'updateTemplatePart', slug: 'header' }]).problems).toHaveLength(
      1,
    );
    expect(
      checkOperations([{ type: 'updateMenu', items: [{ label: 'Bad', url: 'javascript:alert(1)' }] }])
        .problems[0]?.path,
    ).toBe('operations[0].items[0].url');
    expect(
      checkOperations([{ type: 'updateMenu', items: [{ label: 'Both', url: '/', page: 'home' }] }])
        .problems,
    ).toHaveLength(1);
  });
});

describe('presetProblem() and isSafeLink()', () => {
  it('takes references, sizes and keywords', () => {
    expect(presetProblem({ spacing: { blockGap: '1.5rem' }, typography: { fontWeight: '700' } })).toBe(
      null,
    );
    expect(presetProblem(['var:preset|color|base', 'solid'])).toBe(null);
    expect(presetProblem({ a: 'hsl(1 2% 3%)' })?.path).toBe('styles.a');
  });

  it('allows site paths and web links only', () => {
    expect(isSafeLink('/visit/')).toBe(true);
    expect(isSafeLink('https://example.org')).toBe(true);
    expect(isSafeLink('//evil.example')).toBe(false);
    expect(isSafeLink('javascript:alert(1)')).toBe(false);
    expect(isSafeLink('data:text/html,hi')).toBe(false);
  });
});

describe('the schemas', () => {
  it('has one choice per operation', () => {
    const types = (schema: Record<string, unknown>) =>
      (schema.oneOf as { properties: { type: { enum: string[] } } }[]).map(
        (s) => s.properties.type.enum[0],
      );
    expect(types(EDIT_OPERATION_SCHEMA)).toEqual([...EDIT_OPERATION_TYPES]);
    expect(types(SECTION_OPERATION_SCHEMA)).toEqual(EDIT_OPERATION_TYPES.slice(0, 5));
  });
});
