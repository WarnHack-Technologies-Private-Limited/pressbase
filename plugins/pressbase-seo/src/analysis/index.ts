/**
 * Pressbase SEO content analysis.
 *
 * Calm, honest guidance: each check says what to do about THIS post and why it matters. There is
 * deliberately no overall score and no keyword density. English only. Pure TypeScript with no
 * dependencies, so it runs both in the editor (live) and on the server (CLI audit).
 *
 * Every user-visible string goes through `__('…')` with a single-quoted literal so the build can
 * extract it for translation.
 */

import { SERP, textWidth } from './pixels';
import { firstParagraph, fold, headings, images, links, slugify, stripTags, words } from './text';

export type Translate = (text: string) => string;

export interface AnalysisInput {
  /** The post's own title (plain text). */
  title: string;
  /** The SEO title as it will show in search, variables already replaced. */
  seoTitle: string;
  /** Block markup / HTML. */
  content: string;
  slug: string;
  /** The meta description as it will show ('' when none is set). */
  description: string;
  /** Focus keyphrase, may be ''. */
  keyphrase: string;
  /** e.g. 'https://example.com', for telling internal links from external ones. */
  homeUrl: string;
  /** Other published posts with the same SEO title; undefined = unknown (check skipped). */
  duplicateTitles?: { id: number; title: string }[];
}

export type CheckStatus = 'good' | 'improve' | 'na';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  label: string;
  message: string;
  why: string;
  target: 'title' | 'description' | 'slug' | 'content' | 'keyphrase';
}

export const CHECK_IDS = [
  'keyphrase-title',
  'keyphrase-intro',
  'keyphrase-slug',
  'description-length',
  'description-keyphrase',
  'single-h1',
  'heading-levels',
  'image-alt',
  'internal-link',
  'title-unique',
] as const satisfies readonly string[];

/** Description length range that usually shows in full without looking thin. */
export const DESCRIPTION_MIN = 120;
export const DESCRIPTION_MAX = 156;

const identity: Translate = (text) => text;

/** Minimal sprintf: `%s` and `%d` filled in order, `%%` is a literal percent sign. */
export function sprintf(format: string, ...args: (string | number)[]): string {
  let i = 0;
  return format.replace(/%([sd%])/g, (_m, type: string) => {
    if (type === '%') return '%';
    const value = args[i++];
    if (value === undefined) return '';
    return type === 'd' ? String(Math.trunc(Number(value))) : String(value);
  });
}

// ---------------------------------------------------------------------------------------------
// Keyphrase matching
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
  'to',
  'vs',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

/** A word plus its simple singular forms (s, es, ies → y). Never shorter than 3 letters. */
function forms(word: string): string[] {
  const out = [word];
  const add = (w: string) => {
    if (w.length >= 3) out.push(w);
  };
  if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  return out;
}

/** The keyphrase words that must all appear (stopwords dropped unless that leaves nothing). */
export function keyphraseWords(keyphrase: string): string[] {
  const all = words(fold(keyphrase));
  const content = all.filter((w) => !STOPWORDS.has(w));
  return [...new Set(content.length ? content : all)];
}

/**
 * True when every non-stopword word of the keyphrase appears in `text`, in any order, as a whole
 * word, ignoring case and accents and allowing simple plural/singular variants.
 */
export function containsKeyphrase(text: string, keyphrase: string): boolean {
  const needed = keyphraseWords(keyphrase);
  if (!needed.length) return false;
  const available = new Set<string>();
  for (const w of words(fold(text))) for (const f of forms(w)) available.add(f);
  return needed.every((w) => forms(w).some((f) => available.has(f)));
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

function hostOf(url: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i.exec(url.trim());
  if (!m?.[1]) return null;
  return m[1]
    .toLowerCase()
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** Whether `href` points at the same site as `homeUrl`. Anchors, mailto: and tel: are not links to pages. */
export function isInternalLink(href: string, homeUrl: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith('#')) return false;
  if (/^(mailto|tel|sms|javascript|data):/i.test(h)) return false;
  const host = hostOf(h);
  if (host !== null) return host === hostOf(homeUrl);
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return false; // some other scheme
  return true; // '/path', 'path', '?query'
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

type Check = (input: AnalysisInput, __: Translate, ctx: Context) => CheckResult;

interface Context {
  text: string;
  hasKeyphrase: boolean;
  hasContent: boolean;
}

const keyphraseTitle: Check = (input, __, ctx) => {
  const base = {
    id: 'keyphrase-title',
    label: __('Keyphrase in title'),
    why: __(
      'The title is the clearest signal of what a page is about, and it’s what people scan in search results.',
    ),
    target: 'title' as const,
  };
  if (!ctx.hasKeyphrase) {
    return { ...base, status: 'na', message: __('Set a focus keyphrase to check this.') };
  }
  return containsKeyphrase(input.seoTitle, input.keyphrase)
    ? { ...base, status: 'good', message: __('The SEO title contains the keyphrase.') }
    : {
        ...base,
        status: 'improve',
        message: __('Add the keyphrase to the title, near the start if it reads naturally.'),
      };
};

const keyphraseIntro: Check = (input, __, ctx) => {
  const base = {
    id: 'keyphrase-intro',
    label: __('Keyphrase in introduction'),
    why: __(
      'Saying early what the page is about tells readers they’re in the right place; for search engines it’s a minor signal.',
    ),
    target: 'content' as const,
  };
  if (!ctx.hasKeyphrase) {
    return { ...base, status: 'na', message: __('Set a focus keyphrase to check this.') };
  }
  if (!ctx.hasContent) {
    return { ...base, status: 'na', message: __('Add some content to check this.') };
  }
  return containsKeyphrase(firstParagraph(input.content), input.keyphrase)
    ? { ...base, status: 'good', message: __('The first paragraph mentions the keyphrase.') }
    : {
        ...base,
        status: 'improve',
        message: __('Mention the keyphrase in the first paragraph, if it fits the way you open.'),
      };
};

const keyphraseSlug: Check = (input, __, ctx) => {
  const base = {
    id: 'keyphrase-slug',
    label: __('Keyphrase in slug'),
    why: __(
      'A slug that matches the topic is a small signal and makes the link easier to trust. Changing it on a published post changes the address, so add a redirect if you do.',
    ),
    target: 'slug' as const,
  };
  if (!ctx.hasKeyphrase) {
    return { ...base, status: 'na', message: __('Set a focus keyphrase to check this.') };
  }
  return containsKeyphrase(input.slug.replace(/[-_]+/g, ' '), input.keyphrase)
    ? { ...base, status: 'good', message: __('The slug contains the keyphrase.') }
    : {
        ...base,
        status: 'improve',
        message: sprintf(
          __('Consider using the keyphrase in the slug, for example “%s”.'),
          slugify(input.keyphrase),
        ),
      };
};

const descriptionLength: Check = (input, __) => {
  const base = {
    id: 'description-length',
    label: __('Meta description length'),
    why: __(
      'Search results often show the description under the title, and a clear one helps people decide to visit. It isn’t a ranking factor in itself.',
    ),
    target: 'description' as const,
  };
  const description = input.description.replace(/\s+/g, ' ').trim();
  if (!description) {
    return {
      ...base,
      status: 'improve',
      message: __(
        'No meta description is set. Search engines will pick text from the page, which may not be the part you’d choose.',
      ),
    };
  }
  const length = [...description].length;
  const cutOnDesktop = textWidth(description, SERP.descFontPx) > SERP.descMaxDesktopPx;
  if (length < DESCRIPTION_MIN) {
    return {
      ...base,
      status: 'improve',
      message: sprintf(
        __('The description is %d characters. Around %d to %d gives room to describe the page.'),
        length,
        DESCRIPTION_MIN,
        DESCRIPTION_MAX,
      ),
    };
  }
  if (length > DESCRIPTION_MAX) {
    return {
      ...base,
      status: 'improve',
      message: cutOnDesktop
        ? sprintf(
            __(
              'The description is %d characters and would likely be cut off on desktop. Shorten it to around %d, or keep the key point near the start.',
            ),
            length,
            DESCRIPTION_MAX,
          )
        : sprintf(
            __(
              'The description is %d characters, so it may be cut off, especially on mobile. Around %d usually shows in full.',
            ),
            length,
            DESCRIPTION_MAX,
          ),
    };
  }
  if (cutOnDesktop) {
    return {
      ...base,
      status: 'improve',
      message: sprintf(
        __(
          'The description is %d characters, but it uses wide letters and would likely be cut off on desktop. Try shortening it a little.',
        ),
        length,
      ),
    };
  }
  return {
    ...base,
    status: 'good',
    message: sprintf(
      __('The description is %d characters, a length that usually shows in full.'),
      length,
    ),
  };
};

const descriptionKeyphrase: Check = (input, __, ctx) => {
  const base = {
    id: 'description-keyphrase',
    label: __('Keyphrase in meta description'),
    why: __(
      'Search engines often highlight the words that match a search, which helps people see the page is relevant. It isn’t a ranking factor.',
    ),
    target: 'description' as const,
  };
  if (!ctx.hasKeyphrase) {
    return { ...base, status: 'na', message: __('Set a focus keyphrase to check this.') };
  }
  if (!input.description.trim()) {
    return { ...base, status: 'na', message: __('Write a meta description to check this.') };
  }
  return containsKeyphrase(input.description, input.keyphrase)
    ? { ...base, status: 'good', message: __('The meta description contains the keyphrase.') }
    : {
        ...base,
        status: 'improve',
        message: __('Use the keyphrase in the meta description, if it reads naturally.'),
      };
};

const singleH1: Check = (input, __) => {
  const base = {
    id: 'single-h1',
    label: __('Single main heading'),
    why: __(
      'One main heading keeps the page outline clear for screen reader users and search engines. Extra H1s are a minor issue, not a penalty.',
    ),
    target: 'content' as const,
  };
  const count = headings(input.content).filter((h) => h.level === 1).length;
  if (count === 0) {
    return {
      ...base,
      status: 'good',
      message: __('The post title is the page’s only H1 heading.'),
    };
  }
  return {
    ...base,
    status: 'improve',
    message:
      count === 1
        ? __('The content has an H1 heading. The post title is already the H1, so use H2 here.')
        : sprintf(
            __(
              'The content has %d H1 headings. The post title is already the H1, so use H2 for sections.',
            ),
            count,
          ),
  };
};

const headingLevels: Check = (input, __) => {
  const base = {
    id: 'heading-levels',
    label: __('Heading levels'),
    why: __(
      'Screen reader users often move through a page by headings, and skipped levels make the outline harder to follow.',
    ),
    target: 'content' as const,
  };
  const list = headings(input.content);
  if (!list.length) {
    return { ...base, status: 'na', message: __('There are no headings in the content.') };
  }
  let previous = 1; // the post title is the H1
  for (const h of list) {
    if (h.level > previous + 1) {
      return {
        ...base,
        status: 'improve',
        message:
          previous === 1
            ? sprintf(
                __('The first heading, “%s”, is an H%d. Start sections at H2.'),
                h.text,
                h.level,
              )
            : sprintf(
                __('The heading “%s” jumps from H%d to H%d. Use H%d there instead.'),
                h.text,
                previous,
                h.level,
                previous + 1,
              ),
      };
    }
    previous = h.level;
  }
  return { ...base, status: 'good', message: __('Heading levels follow in order.') };
};

const imageAlt: Check = (input, __) => {
  const base = {
    id: 'image-alt',
    label: __('Image alt text'),
    why: __(
      'Alt text is how people using screen readers know what an image shows; search engines use it to understand images too.',
    ),
    target: 'content' as const,
  };
  const list = images(input.content);
  if (!list.length) {
    return { ...base, status: 'na', message: __('There are no images in the content.') };
  }
  const missing = list.filter((img) => img.alt === null || !img.alt.trim()).length;
  if (missing === 0) {
    return {
      ...base,
      status: 'good',
      message: list.length === 1 ? __('The image has alt text.') : __('Every image has alt text.'),
    };
  }
  return {
    ...base,
    status: 'improve',
    message:
      list.length === 1
        ? __('The image has no alt text. Describe what it shows, or what it’s for.')
        : sprintf(
            __('%d of %d images have no alt text. Describe what each one shows, or what it’s for.'),
            missing,
            list.length,
          ),
  };
};

const internalLink: Check = (input, __, ctx) => {
  const base = {
    id: 'internal-link',
    label: __('Internal links'),
    why: __(
      'Links to your other pages help readers keep going and help search engines find and understand those pages.',
    ),
    target: 'content' as const,
  };
  if (!ctx.hasContent) {
    return { ...base, status: 'na', message: __('Add some content to check this.') };
  }
  const count = links(input.content).filter((l) => isInternalLink(l.href, input.homeUrl)).length;
  if (count === 0) {
    return {
      ...base,
      status: 'improve',
      message: __('Link to at least one related page on your site, where it helps the reader.'),
    };
  }
  return {
    ...base,
    status: 'good',
    message:
      count === 1
        ? __('The content links to another page on your site.')
        : sprintf(__('The content has %d links to other pages on your site.'), count),
  };
};

const titleUnique: Check = (input, __) => {
  const base = {
    id: 'title-unique',
    label: __('Unique title'),
    why: __(
      'When pages share a title, people can’t tell them apart in search results, and search engines may show one in place of the other.',
    ),
    target: 'title' as const,
  };
  const duplicates = input.duplicateTitles;
  if (duplicates === undefined) {
    return { ...base, status: 'na', message: __('Other titles weren’t checked.') };
  }
  const first = duplicates[0];
  if (!first) {
    return { ...base, status: 'good', message: __('No other published post uses this title.') };
  }
  return {
    ...base,
    status: 'improve',
    message:
      duplicates.length === 1
        ? sprintf(
            __('“%s” has the same SEO title. Give each page its own title.'),
            first.title || input.seoTitle,
          )
        : sprintf(
            __(
              '%d other posts, including “%s”, have the same SEO title. Give each page its own title.',
            ),
            duplicates.length,
            first.title || input.seoTitle,
          ),
  };
};

const CHECKS: readonly Check[] = [
  keyphraseTitle,
  keyphraseIntro,
  keyphraseSlug,
  descriptionLength,
  descriptionKeyphrase,
  singleH1,
  headingLevels,
  imageAlt,
  internalLink,
  titleUnique,
];

/** Runs every check, in the order of `CHECK_IDS`. */
export function analyze(input: AnalysisInput, __: Translate = identity): CheckResult[] {
  const text = stripTags(input.content);
  const ctx: Context = {
    text,
    hasKeyphrase: keyphraseWords(input.keyphrase).length > 0,
    hasContent: text.length > 0 || images(input.content).length > 0,
  };
  return CHECKS.map((check) => check(input, __, ctx));
}

/** A count of suggestions ('improve' results). Deliberately not a score. */
export function summarize(results: CheckResult[], __: Translate = identity): string {
  const count = results.filter((r) => r.status === 'improve').length;
  if (count === 0) return __('No suggestions');
  if (count === 1) return __('1 suggestion');
  return sprintf(__('%d suggestions'), count);
}

export { SERP, textWidth, truncateToWidth } from './pixels';
export {
  firstParagraph,
  fold,
  headings,
  images,
  links,
  slugify,
  stripTags,
  words,
} from './text';
