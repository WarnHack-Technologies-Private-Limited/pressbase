import { describe, expect, it } from 'vitest';
import { escAttr, escHtml, escUrl, stripAllTags } from './escape';
import { BlockTypeRegistry, blockHasSupport } from './registry';
import { sanitizeValueFromSchema, validateValueFromSchema } from './schema';

describe('BlockTypeRegistry', () => {
  it('registers, finds and unregisters block types', () => {
    const registry = new BlockTypeRegistry();
    const type = registry.register('my-plugin/card', { title: 'Card', render: () => '' });
    expect(registry.get('my-plugin/card')).toBe(type);
    expect(registry.isRegistered('my-plugin/card')).toBe(true);
    expect(type.isDynamic()).toBe(true);
    expect(registry.all()).toHaveLength(1);
    registry.unregister('my-plugin/card');
    expect(registry.get('my-plugin/card')).toBeUndefined();
    expect(registry.get(null)).toBeUndefined();
  });

  it('refuses invalid and duplicate names', () => {
    const registry = new BlockTypeRegistry();
    expect(() => registry.register('card')).toThrow(/namespace/);
    expect(() => registry.register('My/Card')).toThrow(/namespace/);
    registry.register('a/b');
    expect(() => registry.register('a/b')).toThrow(/already registered/);
  });

  it('adds global and block-support attributes', () => {
    const registry = new BlockTypeRegistry();
    const type = registry.register('a/b', {
      attributes: { level: { type: 'number', default: 2 } },
      supports: {
        align: ['wide'],
        anchor: true,
        color: { gradients: true },
        typography: { fontSize: true },
        __experimentalBorder: { color: true },
      },
    });
    expect(Object.keys(type.attributes).sort()).toEqual(
      [
        'align',
        'anchor',
        'backgroundColor',
        'borderColor',
        'className',
        'fontSize',
        'gradient',
        'level',
        'lock',
        'metadata',
        'style',
        'textColor',
      ].sort(),
    );
    const plain = registry.register('a/plain', { supports: { customClassName: false } });
    expect(Object.keys(plain.attributes)).toEqual(['lock', 'metadata']);
    expect(type.isDynamic()).toBe(false);
  });

  it('prepares attributes for render like WP_Block_Type', () => {
    const registry = new BlockTypeRegistry();
    const type = registry.register('a/b', {
      attributes: {
        count: { type: 'number', default: 5 },
        order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        maybe: { type: 'number', default: null },
        list: { type: 'array', default: [] },
        free: { type: 'string' },
      },
    });
    const prepared = type.prepareAttributesForRender({
      count: 'ten',
      order: 'sideways',
      free: 'kept',
      unknown: { any: 1 },
    });
    expect(prepared).toEqual({
      count: 5,
      order: 'desc',
      list: [],
      free: 'kept',
      unknown: { any: 1 },
    });
    // Defaults are copies, never shared between renders.
    (prepared.list as unknown[]).push(1);
    expect(type.prepareAttributesForRender({}).list).toEqual([]);
  });

  it('reads nested supports', () => {
    expect(blockHasSupport({ color: { link: true } }, ['color', 'link'])).toBe(true);
    expect(blockHasSupport({ color: { link: false } }, ['color', 'link'])).toBe(false);
    expect(blockHasSupport({}, 'customClassName', true)).toBe(true);
  });
});

describe('schema', () => {
  it('validates types, enums, ranges, items and properties', () => {
    expect(validateValueFromSchema(3, { type: 'integer', minimum: 1, maximum: 5 })).toBeNull();
    expect(validateValueFromSchema(3.5, { type: 'integer' })).toMatch(/integer/);
    expect(validateValueFromSchema(9, { type: 'number', maximum: 5 })).toMatch(/less than/);
    expect(validateValueFromSchema('x', { type: 'string', enum: ['a'] })).toMatch(/one of/);
    expect(validateValueFromSchema(null, { type: ['string', 'null'] })).toBeNull();
    expect(validateValueFromSchema([1, 'a'], { type: 'array', items: { type: 'number' } })).toMatch(
      /\[1\]/,
    );
    expect(
      validateValueFromSchema(
        { a: 1, b: 2 },
        { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false },
      ),
    ).toMatch(/b is not a valid property/);
  });

  it('coerces query-string values', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        n: { type: 'number' as const },
        i: { type: 'integer' as const },
        b: { type: 'boolean' as const },
        ids: { type: 'array' as const, items: { type: 'integer' as const } },
        s: { type: 'string' as const },
      },
    };
    expect(
      sanitizeValueFromSchema(
        { n: '2.5', i: '7', b: 'true', ids: { 0: '1', 1: '2' }, s: 3 },
        schema,
      ),
    ).toEqual({ n: 2.5, i: 7, b: true, ids: [1, 2], s: '3' });
    expect(sanitizeValueFromSchema('nope', { type: 'number' })).toBe('nope');
  });
});

describe('escaping', () => {
  it('escHtml and escAttr encode markup without double-encoding entities', () => {
    expect(escHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escHtml("Tom & Jerry's &amp; &#8217; &hellip; &bogus")).toBe(
      'Tom &amp; Jerry&#039;s &amp; &#8217; &hellip; &amp;bogus',
    );
    expect(escAttr('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x');
    expect(escHtml(42)).toBe('42');
    expect(escHtml(null)).toBe('');
  });

  it('escUrl keeps good URLs and encodes them for HTML', () => {
    expect(escUrl('https://example.com/a?b=1&c=2')).toBe('https://example.com/a?b=1&#038;c=2');
    expect(escUrl('/relative/path')).toBe('/relative/path');
    expect(escUrl('example.com/x y')).toBe('http://example.com/x%20y');
    expect(escUrl("https://ex.com/it's")).toBe('https://ex.com/it&#039;s');
    expect(escUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(escUrl('https://ex.com/"><script>')).toBe('https://ex.com/script');
    expect(escUrl('https://ex.com/%0d%0aSet-Cookie')).toBe('https://ex.com/Set-Cookie');
    expect(escUrl('https://ex.com/café')).toBe('https://ex.com/café');
  });

  it('escUrl rejects dangerous schemes', () => {
    expect(escUrl('javascript:alert(1)')).toBe('');
    expect(escUrl('JaVaScRiPt:alert(1)')).toBe('');
    expect(escUrl('data:text/html,<b>')).toBe('');
    expect(escUrl('vbscript:x')).toBe('');
    expect(escUrl('')).toBe('');
    expect(escUrl('https://x.com', ['https'])).toBe('https://x.com');
    expect(escUrl('http://x.com', ['https'])).toBe('');
  });

  it('stripAllTags removes tags and script contents', () => {
    expect(stripAllTags('<p>Hi <b>there</b></p><script>bad()</script>')).toBe('Hi there');
    expect(stripAllTags('a\n\tb', true)).toBe('a b');
  });
});
