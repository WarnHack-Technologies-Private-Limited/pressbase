import { describe, expect, it } from 'vitest';
import {
  addPage,
  addSection,
  addUsage,
  answersPayload,
  applyEvent,
  cleanBrief,
  EMPTY_FORM,
  formPayload,
  MAX_PAGES,
  MAX_SECTIONS,
  move,
  NO_USAGE,
  placeholderCount,
  previewStyle,
  previousStep,
  type Run,
  removePage,
  removeSection,
  roughWords,
  type SitemapPage,
  STEPS,
  sitemapPayload,
  studioLink,
} from './site-builder';

describe('steps', () => {
  it('has the seven steps of the plan, in order', () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      'describe',
      'clarify',
      'brief',
      'design',
      'sitemap',
      'generate',
      'review',
    ]);
  });

  it('always has somewhere to go back to', () => {
    expect(previousStep('describe', false)).toBeNull();
    expect(previousStep('clarify', false)).toBe('describe');
    expect(previousStep('sitemap', false)).toBe('design');
    expect(previousStep('generate', false)).toBe('sitemap');
    expect(previousStep('generate', true)).toBe('review');
    expect(previousStep('review', true)).toBe('sitemap');
  });
});

describe('what the flow sends', () => {
  it('trims the form and leaves out empty fields; facts are one per line', () => {
    expect(
      formPayload({
        ...EMPTY_FORM,
        description: '  A bakery.  ',
        name: ' Crumb & Co ',
        phone: '   ',
        facts: 'Open Tuesday to Saturday\n\n  Sourdough daily  \n',
      }),
    ).toEqual({
      description: 'A bakery.',
      name: 'Crumb & Co',
      facts: ['Open Tuesday to Saturday', 'Sourdough daily'],
    });
  });

  it('sends only the questions that were answered', () => {
    expect(
      answersPayload(
        [{ question: 'Online orders?' }, { question: 'Known for?' }, { question: 'Who?' }],
        ['', ' Our rye ', undefined as unknown as string],
      ),
    ).toEqual([{ question: 'Known for?', answer: 'Our rye' }]);
  });

  it('cleans the edited brief', () => {
    const brief = cleanBrief({
      name: ' Crumb ',
      kind: 'bakery',
      audience: '',
      tone: '',
      facts: ['Name: Crumb', '', '  Open daily '],
      pages: ['Home', ' '],
      language: 'en-GB',
    });
    expect(brief.name).toBe('Crumb');
    expect(brief.facts).toEqual(['Name: Crumb', 'Open daily']);
    expect(brief.pages).toEqual(['Home']);
  });
});

describe('design previews', () => {
  it('styles a preview from the generated palette, fonts, corners and spacing', () => {
    const style = previewStyle({
      mood: 'warm',
      hue: 30,
      contrast: 'standard',
      scheme: 'light',
      fontPair: 'platypi-manrope',
      radius: 'square',
      density: 'compact',
    });
    expect(style['--pv-accent']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style['--pv-base']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style['--pv-heading-font']).toContain('Platypi');
    expect(style['--pv-radius']).toBe('0');
    const dark = previewStyle({
      mood: 'calm',
      hue: 200,
      contrast: 'standard',
      scheme: 'dark',
      fontPair: 'manrope',
      radius: 'soft',
      density: 'spacious',
    });
    expect(dark['--pv-base']).not.toBe(style['--pv-base']);
    expect(dark['--pv-button-radius']).toBe('999px');
  });
});

const page = (title: string, sections = ['about']): SitemapPage => ({
  title,
  slug: '',
  sections: sections.map((category) => ({ category, intent: '' })),
});

describe('the sitemap', () => {
  it('moves pages, and ignores moves out of range', () => {
    const pages = [page('Home'), page('About'), page('Visit')];
    expect(move(pages, 2, 0).map((p) => p.title)).toEqual(['Visit', 'Home', 'About']);
    expect(move(pages, 0, 1).map((p) => p.title)).toEqual(['About', 'Home', 'Visit']);
    expect(move(pages, 0, 5).map((p) => p.title)).toEqual(['Home', 'About', 'Visit']);
  });

  it('adds pages up to the limit, and keeps the last page', () => {
    let pages = [page('Home')];
    expect(addPage(pages, '  ', 'text')).toHaveLength(1);
    for (let i = 0; i < 10; i++) pages = addPage(pages, `Page ${i}`, 'text');
    expect(pages).toHaveLength(MAX_PAGES);
    expect(pages[1]).toEqual({
      title: 'Page 0',
      slug: '',
      sections: [{ category: 'text', intent: '' }],
    });
    expect(removePage([page('Home')], 0)).toHaveLength(1);
    expect(removePage([page('Home'), page('About')], 0).map((p) => p.title)).toEqual(['About']);
  });

  it('adds sections up to the limit, and keeps the last section', () => {
    let home = page('Home');
    for (let i = 0; i < 10; i++) home = addSection(home, 'faq');
    expect(home.sections).toHaveLength(MAX_SECTIONS);
    expect(removeSection(page('Home'), 0).sections).toHaveLength(1);
    expect(removeSection(page('Home', ['banner', 'about']), 0).sections).toEqual([
      { category: 'about', intent: '' },
    ]);
  });

  it('sends pages with a title', () => {
    expect(sitemapPayload({ pages: [page(' Home '), page('  ')] })).toEqual({
      pages: [page('Home')],
    });
  });
});

describe('a run’s progress', () => {
  const start: Run = {
    id: 7,
    status: 'queued',
    stage: null,
    pages: [],
    changeset_uuid: null,
    preview_link: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    requests: 0,
    warnings: [],
    error: null,
  };

  it('follows the events to the end', () => {
    let run = applyEvent(start, 'run', {
      status: 'running',
      changeset_uuid: 'abc',
      preview_link: 'http://site/?changeset_uuid=abc',
    });
    run = applyEvent(run, 'stage', { stage: 'sitemap', status: 'started' });
    expect(run.stage).toBe('sitemap');
    run = applyEvent(run, 'sitemap', {
      sitemap: { pages: [page('Home'), page('Visit')].map((p, i) => ({ ...p, slug: `p${i}` })) },
    });
    expect(run.pages.map((p) => [p.title, p.status, p.home])).toEqual([
      ['Home', 'pending', true],
      ['Visit', 'pending', false],
    ]);
    run = applyEvent(run, 'page', { slug: 'p1', title: 'Visit', status: 'generating' });
    run = applyEvent(run, 'page', {
      slug: 'visit',
      title: 'Visit',
      status: 'done',
      preview_link: 'http://site/visit/?changeset_uuid=abc',
      placeholders: ['[Add your opening hours]', '[Add a phone number]'],
    });
    run = applyEvent(run, 'page', {
      slug: 'p0',
      title: 'Home',
      status: 'failed',
      error: { code: 'x', message: 'No.' },
    });
    expect(run.pages[1]).toMatchObject({ slug: 'visit', status: 'done' });
    expect(run.pages[0]?.error?.message).toBe('No.');
    expect(placeholderCount(run)).toBe(2);
    run = applyEvent(run, 'checks', { slug: 'visit', errors: 0, warnings: 1, passed: 9 });
    expect(run.pages[1]?.checks).toEqual({ errors: 0, warnings: 1, passed: 9 });
    run = applyEvent(run, 'done', {
      status: 'completed',
      tokens: { prompt: 900, completion: 300, total: 1200 },
      requests: 3,
      changeset_uuid: 'abc',
      preview_link: 'http://site/?changeset_uuid=abc',
      error: null,
    });
    expect(run).toMatchObject({ status: 'completed', stage: null, requests: 3 });
    expect(studioLink(run)).toBe('/admin/studio?changeset_uuid=abc&run=7');
  });

  it('starts again from a snapshot', () => {
    const snapshot = { ...start, status: 'running', pages: [] } as Run;
    expect(applyEvent(start, 'snapshot', snapshot as never)).toEqual(snapshot);
  });

  it('adds up what each step used, in words a person can picture', () => {
    const usage = addUsage(
      addUsage(NO_USAGE, { tokens: { prompt: 10, completion: 5, total: 15 }, requests: 1 }),
      {
        tokens: { prompt: 1000, completion: 400, total: 1400 },
        requests: 2,
      },
    );
    expect(usage).toEqual({ tokens: { prompt: 1010, completion: 405, total: 1415 }, requests: 3 });
    expect(roughWords(14_000)).toBe(10_500);
  });
});
