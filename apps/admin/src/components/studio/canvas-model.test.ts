import { describe, expect, it } from 'vitest';
import {
  breadcrumbTrail,
  type CanvasBlock,
  composeCanvas,
  editingModes,
  findRegions,
  pageBlocks,
  partOf,
  regionBlocks,
  withoutNavigationRef,
} from './canvas-model';

let next = 0;
const block = (
  name: string,
  attributes: Record<string, unknown> = {},
  innerBlocks: CanvasBlock[] = [],
): CanvasBlock => ({ name, clientId: `${name.split('/')[1]}-${++next}`, attributes, innerBlocks });

const part = (slug: string) => block('core/template-part', { slug });
const content = () => block('core/post-content', { layout: { type: 'constrained' } });

function pageTemplate() {
  return [
    part('header'),
    block('core/group', { tagName: 'main' }, [block('core/post-title'), content()]),
    part('footer'),
  ];
}

const parts = (map: Record<string, CanvasBlock[]>) => ({ blocks: (slug: string) => map[slug] });

describe('composeCanvas', () => {
  it('fills template parts and the post content, keeping the template', () => {
    const header = [block('core/site-title')];
    const footer = [block('core/paragraph', { content: 'Made in Pune' })];
    const page = [block('core/heading', { content: 'Fresh bread' })];
    const canvas = composeCanvas(pageTemplate(), parts({ header, footer }), page);
    expect(canvas.map((b) => b.name)).toEqual([
      'core/template-part',
      'core/group',
      'core/template-part',
    ]);
    expect(canvas[0]?.innerBlocks).toEqual(header);
    expect(canvas[2]?.innerBlocks).toEqual(footer);
    expect(pageBlocks(canvas)).toEqual(page);
  });

  it('leaves a missing part empty and refuses a part that includes itself', () => {
    const loop = [block('core/paragraph'), part('header')];
    const canvas = composeCanvas([part('header'), part('sidebar')], parts({ header: loop }), []);
    expect(canvas[0]?.innerBlocks[0]?.name).toBe('core/paragraph');
    expect(canvas[0]?.innerBlocks[1]?.innerBlocks).toEqual([]);
    expect(canvas[1]?.innerBlocks).toEqual([]);
  });

  it('shows the page once, and nothing for the latest posts', () => {
    const template = [content(), content()];
    const page = [block('core/paragraph')];
    const canvas = composeCanvas(template, parts({}), page);
    expect(canvas[0]?.innerBlocks).toEqual(page);
    expect(canvas[1]?.innerBlocks).toEqual([]);
    expect(pageBlocks(composeCanvas(pageTemplate(), parts({}), null))).toEqual([]);
    expect(pageBlocks([block('core/query')])).toBeNull();
  });
});

describe('findRegions and editingModes', () => {
  it('lists parts and the content, and doesn’t look inside the page', () => {
    const page = [block('core/group', {}, [part('nested-in-page')])];
    const canvas = composeCanvas(
      pageTemplate(),
      parts({ header: [block('core/site-title')] }),
      page,
    );
    expect(findRegions(canvas).map((r) => [r.kind, r.slug])).toEqual([
      ['part', 'header'],
      ['content', undefined],
      ['part', 'footer'],
    ]);
  });

  it('locks the template, and the parts’ blocks for people who can’t change the design', () => {
    const title = block('core/site-title');
    const nav = block('core/navigation');
    const canvas = composeCanvas(pageTemplate(), parts({ header: [title, nav] }), []);
    const [header, main] = canvas as [CanvasBlock, CanvasBlock];
    const postContent = main.innerBlocks[1] as CanvasBlock;
    const modes = new Map(editingModes(canvas, { partsEditable: false }));
    expect(modes.get('')).toBe('disabled');
    expect(modes.get(header.clientId)).toBe('default');
    expect(modes.get(title.clientId)).toBe('disabled');
    expect(modes.get(nav.clientId)).toBe('disabled');
    expect(modes.get(postContent.clientId)).toBe('default');
    // The template's own blocks inherit the root's mode.
    expect(modes.has(main.clientId)).toBe(false);
  });

  it('leaves the parts’ blocks to inherit when parts are editable, the default (#30)', () => {
    const title = block('core/site-title');
    const canvas = composeCanvas(pageTemplate(), parts({ header: [title] }), []);
    const modes = new Map(editingModes(canvas));
    expect(modes).toEqual(new Map(editingModes(canvas, { partsEditable: true })));
    expect(modes.has(title.clientId)).toBe(false);
    expect(modes.get(canvas[0]?.clientId as string)).toBe('default');
  });

  it('makes a part inside a part selectable on its own', () => {
    const inner = block('core/paragraph');
    const canvas = composeCanvas(
      [part('footer')],
      parts({ footer: [block('core/group', {}, [part('credits')])], credits: [inner] }),
      null,
    );
    const credits = canvas[0]?.innerBlocks[0]?.innerBlocks[0] as CanvasBlock;
    const modes = new Map(editingModes(canvas, { partsEditable: false }));
    expect(modes.get(credits.clientId)).toBe('default');
    expect(modes.get(inner.clientId)).toBe('disabled');
  });
});

describe('regionBlocks, partOf and withoutNavigationRef', () => {
  it('maps each region to what it saves to, the first copy of a part only', () => {
    const header = [block('core/site-title')];
    const page = [block('core/paragraph', { content: 'Hello' })];
    const canvas = composeCanvas(
      [...pageTemplate(), part('header')],
      parts({ header, footer: [block('core/group', {}, [part('credits')])], credits: [] }),
      page,
    );
    const regions = regionBlocks(canvas);
    expect(regions.content).toEqual(page);
    expect([...regions.parts.keys()]).toEqual(['header', 'footer', 'credits']);
    expect(regions.parts.get('header')).toEqual({ clientId: canvas[0]?.clientId, blocks: header });
  });

  it('finds the part a block sits in, but not through the page', () => {
    const header = part('header');
    const group = block('core/group');
    const paragraph = block('core/paragraph');
    expect(partOf([header, group, paragraph])).toEqual({
      clientId: header.clientId,
      slug: 'header',
    });
    expect(partOf([header])).toEqual({ clientId: header.clientId, slug: 'header' });
    expect(partOf([block('core/group'), content(), paragraph])).toBeNull();
    expect(partOf([])).toBeNull();
  });

  it('drops only the fallback menu’s ref', () => {
    const fallback = block('core/navigation', { ref: 7, overlayMenu: 'mobile' });
    const chosen = block('core/navigation', { ref: 9 });
    const tree = [block('core/group', {}, [fallback, chosen])];
    const out = withoutNavigationRef(tree, 7);
    expect(out[0]?.innerBlocks[0]?.attributes).toEqual({ overlayMenu: 'mobile' });
    expect(out[0]?.innerBlocks[1]).toBe(chosen);
    // Nothing to drop: the same objects come back.
    expect(withoutNavigationRef([chosen], 7)[0]).toBe(chosen);
  });
});

describe('breadcrumbTrail', () => {
  const link = (clientId: string, name: string, label: string) => ({ clientId, name, label });
  const base = { site: 'Site', page: 'Home' };

  it('is Site › Page with nothing selected', () => {
    expect(breadcrumbTrail({ ...base, chain: [] })).toEqual([
      { level: 'site', label: 'Site' },
      { level: 'page', label: 'Home' },
    ]);
  });

  it('names the section and the block, skipping what lies between', () => {
    const chain = [
      link('main', 'core/group', 'Group'),
      link('pc', 'core/post-content', 'Content'),
      link('hero', 'core/cover', 'Hero'),
      link('inner', 'core/group', 'Group'),
      link('h', 'core/heading', 'Heading'),
    ];
    expect(breadcrumbTrail({ ...base, chain }).slice(2)).toEqual([
      { level: 'section', label: 'Hero', clientId: 'hero' },
      { level: 'block', label: 'Heading', clientId: 'h' },
    ]);
    // Selecting the section itself ends the trail there.
    expect(breadcrumbTrail({ ...base, chain: chain.slice(0, 3) }).slice(2)).toEqual([
      { level: 'section', label: 'Hero', clientId: 'hero' },
    ]);
    // The content area itself is the page.
    expect(breadcrumbTrail({ ...base, chain: chain.slice(0, 2) })).toHaveLength(2);
  });

  it('treats a template part as a section', () => {
    const chain = [link('hd', 'core/template-part', 'Header')];
    expect(breadcrumbTrail({ ...base, chain }).slice(2)).toEqual([
      { level: 'section', label: 'Header', clientId: 'hd' },
    ]);
    const deeper = [...chain, link('t', 'core/site-title', 'Site Title')];
    expect(breadcrumbTrail({ ...base, chain: deeper }).at(-1)).toEqual({
      level: 'block',
      label: 'Site Title',
      clientId: 't',
    });
  });

  it('shows a block outside the regions on its own', () => {
    const chain = [link('q', 'core/query', 'Query Loop')];
    expect(breadcrumbTrail({ ...base, chain }).at(-1)).toEqual({
      level: 'block',
      label: 'Query Loop',
      clientId: 'q',
    });
  });
});
