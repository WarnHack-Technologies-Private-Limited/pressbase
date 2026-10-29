import { describe, expect, it } from 'vitest';
import {
  type AnalysisInput,
  analyze,
  CHECK_IDS,
  type CheckResult,
  containsKeyphrase,
  isInternalLink,
  sprintf,
  summarize,
} from './index';
import { SERP, textWidth, truncateToWidth } from './pixels';
import {
  decodeEntities,
  firstParagraph,
  headings,
  images,
  links,
  slugify,
  stripTags,
  words,
} from './text';

const para = (html: string) => `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
const heading = (level: number, text: string) =>
  `<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${text}</h${level}>\n<!-- /wp:heading -->`;
const image = (attrs: string) =>
  `<!-- wp:image {"id":12} -->\n<figure class="wp-block-image"><img ${attrs}/></figure>\n<!-- /wp:image -->`;

const DESCRIPTION_GOOD =
  'Learn how to make sourdough bread at home with a simple starter, a forgiving schedule and a few tips for a crisp, open crumb.';

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    title: 'Sourdough bread at home',
    seoTitle: 'Sourdough bread at home - Example Bakery',
    content: [
      para('Baking <strong>sourdough bread</strong> at home is easier than it looks.'),
      heading(2, 'Making a starter'),
      para('Read our <a href="/starter-guide">starter guide</a> first.'),
      heading(3, 'Feeding'),
      image('src="loaf.jpg" alt="A finished loaf on a board"'),
    ].join('\n\n'),
    slug: 'sourdough-bread-at-home',
    description: DESCRIPTION_GOOD,
    keyphrase: 'sourdough bread',
    homeUrl: 'https://example.com',
    duplicateTitles: [],
    ...overrides,
  };
}

function check(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const run = (overrides: Partial<AnalysisInput> = {}, id = '') =>
  check(analyze(input(overrides)), id);

describe('text parsers', () => {
  it('decodes entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; it&#039;s it&#8217;s &#x41;')).toBe(
      'a & b <c> "d" it\'s it’s A',
    );
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });

  it('strips tags and block comments, keeping words apart across blocks', () => {
    const html = `${para('Hello <a href="/x">wor<em>ld</em></a>&nbsp;again')}${heading(3, 'T')}`;
    expect(stripTags(html)).toBe('Hello world again T');
    expect(stripTags('<p data-x="a>b">One</p><script>var x = 1;</script>')).toBe('One');
    expect(stripTags('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
  });

  it('finds headings with levels', () => {
    const html = `${heading(2, 'First &amp; best')}${heading(4, 'Deep <em>one</em>')}<H1>Upper</H1>`;
    expect(headings(html)).toEqual([
      { level: 2, text: 'First & best' },
      { level: 4, text: 'Deep one' },
      { level: 1, text: 'Upper' },
    ]);
  });

  it('finds images with missing, empty and present alt, in any attribute order and quoting', () => {
    const html = [
      image('src="a.jpg" alt=""'),
      image("alt='A cat' src='b.jpg' class=\"wp-image-12\""),
      image('src=c.jpg'),
      image('data-caption="x > y" src="d.jpg" ALT="Dog &amp; ball"'),
    ].join('');
    expect(images(html)).toEqual([
      { src: 'a.jpg', alt: '' },
      { src: 'b.jpg', alt: 'A cat' },
      { src: 'c.jpg', alt: null },
      { src: 'd.jpg', alt: 'Dog & ball' },
    ]);
  });

  it('finds links with text', () => {
    const html = para(
      'See <a class="x" href="/about">about <b>us</b></a> and <a href=\'https://other.org\'>other</a> <a name="top">no href</a>',
    );
    expect(links(html)).toEqual([
      { href: '/about', text: 'about us' },
      { href: 'https://other.org', text: 'other' },
    ]);
  });

  it('returns the first paragraph with text, with a fallback', () => {
    const html = `${para('')}${para('   ')}${heading(2, 'H')}${para('The <em>real</em> intro.')}`;
    expect(firstParagraph(html)).toBe('The real intro.');
    expect(firstParagraph('<div>No paragraphs here</div>')).toBe('No paragraphs here');
    const long = `<div>${'word '.repeat(100)}</div>`;
    expect(firstParagraph(long).length).toBeLessThanOrEqual(300);
  });

  it('splits words and slugifies', () => {
    expect(words('Don’t stop—the café, 2026!')).toEqual(['Don’t', 'stop', 'the', 'café', '2026']);
    expect(slugify('Crème Brûlée: it’s easy!')).toBe('creme-brulee-its-easy');
  });
});

describe('keyphrase matching', () => {
  it('is case- and accent-insensitive', () => {
    expect(containsKeyphrase('The best CRÈME brûlée', 'creme brulee')).toBe(true);
    expect(containsKeyphrase('creme brulee', 'Crème Brûlée')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(containsKeyphrase('Breadth of choice', 'bread')).toBe(false);
    expect(containsKeyphrase('Fresh bread daily', 'bread')).toBe(true);
  });

  it('allows any order and ignores stopwords', () => {
    expect(containsKeyphrase('Bread made with sourdough', 'sourdough bread')).toBe(true);
    expect(containsKeyphrase('Tips: baking bread', 'how to bake the bread')).toBe(false);
    expect(containsKeyphrase('Bake bread: a guide', 'how to bake the bread')).toBe(true);
    expect(containsKeyphrase('Only sourdough here', 'sourdough bread')).toBe(false);
  });

  it('accepts simple plural and singular variants', () => {
    expect(containsKeyphrase('Five easy recipes', 'easy recipe')).toBe(true);
    expect(containsKeyphrase('One easy recipe', 'easy recipes')).toBe(true);
    expect(containsKeyphrase('Storage boxes', 'storage box')).toBe(true);
    expect(containsKeyphrase('Fresh cherries', 'fresh cherry')).toBe(true);
    expect(containsKeyphrase('A fresh cherry', 'fresh cherries')).toBe(true);
    expect(containsKeyphrase('Roast potatoes', 'roast potato')).toBe(true);
    expect(containsKeyphrase('Reading glasses', 'reading glass')).toBe(true);
  });

  it('falls back to all words when the keyphrase is only stopwords', () => {
    expect(containsKeyphrase('Who we are', 'who we are')).toBe(true);
    expect(containsKeyphrase('About us', 'who we are')).toBe(false);
  });
});

describe('internal links', () => {
  const home = 'https://example.com';
  it('tells internal from external', () => {
    expect(isInternalLink('/about', home)).toBe(true);
    expect(isInternalLink('about', home)).toBe(true);
    expect(isInternalLink('https://example.com/x', home)).toBe(true);
    expect(isInternalLink('http://www.example.com/x', home)).toBe(true);
    expect(isInternalLink('//example.com/x', home)).toBe(true);
    expect(isInternalLink('https://example.com.evil.org/', home)).toBe(false);
    expect(isInternalLink('https://other.org/', home)).toBe(false);
    expect(isInternalLink('#top', home)).toBe(false);
    expect(isInternalLink('mailto:a@example.com', home)).toBe(false);
    expect(isInternalLink('tel:+123', home)).toBe(false);
  });
});

describe('analyze', () => {
  it('returns every check in order with the expected shape', () => {
    const results = analyze(input());
    expect(results.map((r) => r.id)).toEqual([...CHECK_IDS]);
    for (const r of results) {
      expect(r.label).not.toBe('');
      expect(r.message).not.toBe('');
      expect(r.why).not.toBe('');
    }
    expect(results.every((r) => r.status === 'good')).toBe(true);
  });

  it('keyphrase-title', () => {
    expect(run({}, 'keyphrase-title').status).toBe('good');
    const bad = run({ seoTitle: 'Baking at home' }, 'keyphrase-title');
    expect(bad.status).toBe('improve');
    expect(bad.target).toBe('title');
    expect(run({ keyphrase: '' }, 'keyphrase-title').status).toBe('na');
  });

  it('keyphrase-intro', () => {
    expect(run({}, 'keyphrase-intro').status).toBe('good');
    expect(
      run({ content: `${para('Welcome.')}${para('Sourdough bread.')}` }, 'keyphrase-intro').status,
    ).toBe('improve');
    expect(run({ keyphrase: '' }, 'keyphrase-intro').status).toBe('na');
    expect(run({ content: '' }, 'keyphrase-intro').status).toBe('na');
  });

  it('keyphrase-slug', () => {
    expect(run({}, 'keyphrase-slug').status).toBe('good');
    const bad = run({ slug: 'baking-guide' }, 'keyphrase-slug');
    expect(bad.status).toBe('improve');
    expect(bad.message).toContain('sourdough-bread');
    expect(run({ keyphrase: '' }, 'keyphrase-slug').status).toBe('na');
  });

  it('description-length', () => {
    const good = run({}, 'description-length');
    expect(good.status).toBe('good');
    expect(good.message).toContain(String([...DESCRIPTION_GOOD].length));

    const missing = run({ description: '' }, 'description-length');
    expect(missing.status).toBe('improve');
    expect(missing.message).toContain('Search engines will pick text from the page');

    expect(run({ description: 'Too short.' }, 'description-length').status).toBe('improve');

    const long = run(
      { description: `${DESCRIPTION_GOOD} ${DESCRIPTION_GOOD}` },
      'description-length',
    );
    expect(long.status).toBe('improve');
    expect(long.message).toContain('cut off on desktop');

    const wide = run({ description: 'W'.repeat(140) }, 'description-length');
    expect(wide.status).toBe('improve');
    expect(wide.message).toContain('wide letters');
  });

  it('description-keyphrase', () => {
    expect(run({}, 'description-keyphrase').status).toBe('good');
    expect(run({ description: 'A guide to baking at home.' }, 'description-keyphrase').status).toBe(
      'improve',
    );
    expect(run({ description: '' }, 'description-keyphrase').status).toBe('na');
    expect(run({ keyphrase: '' }, 'description-keyphrase').status).toBe('na');
  });

  it('single-h1', () => {
    expect(run({}, 'single-h1').status).toBe('good');
    const one = run({ content: `${heading(1, 'Again')}${para('x')}` }, 'single-h1');
    expect(one.status).toBe('improve');
    const two = run({ content: `${heading(1, 'A')}${heading(1, 'B')}` }, 'single-h1');
    expect(two.message).toContain('2 H1 headings');
  });

  it('heading-levels', () => {
    expect(run({}, 'heading-levels').status).toBe('good');
    const skip = run({ content: `${heading(2, 'A')}${heading(4, 'Deep')}` }, 'heading-levels');
    expect(skip.status).toBe('improve');
    expect(skip.message).toContain('jumps from H2 to H4');
    const start = run({ content: heading(3, 'Starts low') }, 'heading-levels');
    expect(start.status).toBe('improve');
    expect(start.message).toContain('H3');
    expect(
      run(
        { content: `${heading(2, 'A')}${heading(3, 'B')}${heading(2, 'C')}${heading(3, 'D')}` },
        'heading-levels',
      ).status,
    ).toBe('good');
    expect(run({ content: para('No headings') }, 'heading-levels').status).toBe('na');
  });

  it('image-alt', () => {
    expect(run({}, 'image-alt').status).toBe('good');
    const content = [
      image('src="a.jpg" alt="Fine"'),
      image('src="b.jpg" alt=""'),
      image('src="c.jpg"'),
    ].join('');
    const bad = run({ content }, 'image-alt');
    expect(bad.status).toBe('improve');
    expect(bad.message).toContain('2 of 3 images');
    expect(run({ content: image('src="a.jpg"') }, 'image-alt').status).toBe('improve');
    expect(run({ content: para('No images') }, 'image-alt').status).toBe('na');
  });

  it('internal-link', () => {
    expect(run({}, 'internal-link').status).toBe('good');
    const external = para(
      '<a href="https://other.org">x</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a>',
    );
    expect(run({ content: external }, 'internal-link').status).toBe('improve');
    expect(
      run({ content: para('<a href="https://example.com/x">x</a>') }, 'internal-link').status,
    ).toBe('good');
    expect(run({ content: '' }, 'internal-link').status).toBe('na');
  });

  it('title-unique', () => {
    expect(run({}, 'title-unique').status).toBe('good');
    const dup = run({ duplicateTitles: [{ id: 3, title: 'Older post' }] }, 'title-unique');
    expect(dup.status).toBe('improve');
    expect(dup.message).toContain('Older post');
    const many = run(
      {
        duplicateTitles: [
          { id: 3, title: 'Older post' },
          { id: 4, title: 'Another' },
        ],
      },
      'title-unique',
    );
    expect(many.message).toContain('2 other posts');
    expect(run({ duplicateTitles: undefined }, 'title-unique').status).toBe('na');
  });

  it('passes every string through the translator', () => {
    const results = analyze(input({ description: '' }), (s) => `[${s}]`);
    for (const r of results) {
      expect(r.label.startsWith('[')).toBe(true);
      expect(r.why.startsWith('[')).toBe(true);
    }
    expect(check(results, 'description-length').message.startsWith('[')).toBe(true);
  });
});

describe('summarize', () => {
  const r = (status: CheckResult['status']): CheckResult => ({
    id: 'x',
    status,
    label: '',
    message: '',
    why: '',
    target: 'content',
  });
  it('counts suggestions without a score', () => {
    expect(summarize([r('good'), r('na')])).toBe('No suggestions');
    expect(summarize([r('improve'), r('good')])).toBe('1 suggestion');
    expect(summarize([r('improve'), r('improve'), r('improve')])).toBe('3 suggestions');
    expect(summarize(analyze(input({ keyphrase: '', description: '' })))).toBe('1 suggestion');
  });
});

describe('sprintf', () => {
  it('fills placeholders in order', () => {
    expect(sprintf('%d of %d: %s 100%%', 2, 3.7, 'ok')).toBe('2 of 3: ok 100%');
  });
});

describe('pixel widths', () => {
  it('measures narrow letters as narrower than wide ones', () => {
    expect(textWidth('iiii', 20)).toBeLessThan(textWidth('WWWW', 20));
    expect(textWidth('abc', 20)).toBeCloseTo(textWidth('abc', 10) * 2);
    expect(textWidth('', 20)).toBe(0);
    expect(textWidth('é', 20)).toBe(textWidth('e', 20));
    expect(textWidth('日本', 20)).toBe(40);
  });

  it('leaves text that fits alone', () => {
    expect(truncateToWidth('Short title', SERP.titleFontPx, SERP.titleMaxPx)).toEqual({
      text: 'Short title',
      truncated: false,
    });
  });

  it('truncates at a word boundary with an ellipsis', () => {
    const text = 'Sourdough bread at home, a complete guide for beginners and anyone curious';
    const result = truncateToWidth(text, 20, 300);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(' …')).toBe(true);
    expect(textWidth(result.text, 20)).toBeLessThanOrEqual(300);
    const kept = result.text.slice(0, -2);
    expect(text.startsWith(kept)).toBe(true);
    expect(text[kept.length] === ' ' || text[kept.length] === ',').toBe(true);
  });

  it('cuts a single very long word by characters', () => {
    const result = truncateToWidth('W'.repeat(100), 20, 200);
    expect(result.truncated).toBe(true);
    expect(textWidth(result.text, 20)).toBeLessThanOrEqual(200);
  });
});
