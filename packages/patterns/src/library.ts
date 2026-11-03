import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSlotDeclarations, type SlotDeclarations } from '@pressbase/slots';

/**
 * The Pressbase pattern library: section patterns that ship with Pressbase
 * and work in any block theme. Each is two files in `src/patterns/`:
 *
 * - `<name>.html`: block markup, exactly as the block editor's Code editor
 *   shows it;
 * - `<name>.json`: its metadata (title, description, categories, keywords,
 *   viewportWidth, slots).
 *
 * Core registers them as `pressbase/<name>` beside the theme's patterns
 * (register_block_pattern() in class-wp-block-patterns-registry.php). The
 * rules every pattern follows are in the package README and checked by
 * checkPattern().
 */

export interface LibraryPattern {
  /** `pressbase/<file name>`. */
  name: string;
  title: string;
  description?: string;
  /** WordPress's category names where they exist; the first is the section's category. */
  categories: string[];
  keywords: string[];
  viewportWidth: number;
  /** Declared slots, overriding the inferred ones. */
  slots?: SlotDeclarations;
  content: string;
}

export interface LibraryCategory {
  /** The registered category name: WordPress's where one exists. */
  name: string;
  /** Studio's name for the kind of section, as the site-building pipeline uses it. */
  section: string;
  label: string;
  description: string;
  /** Whether WordPress registers this category itself (core registers it already). */
  wordpress: boolean;
}

/**
 * The library's section categories. Where WordPress has a category for the
 * same thing (_register_core_block_patterns_and_categories() in
 * block-patterns.php), its name is used, so the patterns sit with the
 * theme's and plugins' in every inserter.
 */
export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  {
    name: 'banner',
    section: 'hero',
    label: 'Banners',
    description: 'Bold sections designed to showcase key content.',
    wordpress: true,
  },
  { name: 'about', section: 'about', label: 'About', description: 'Introduce yourself.', wordpress: true },
  {
    name: 'features',
    section: 'features',
    label: 'Features',
    description: 'What you offer and why it matters, in short blocks.',
    wordpress: false,
  },
  {
    name: 'services',
    section: 'services',
    label: 'Services',
    description: 'Briefly describe what your business does and how you can help.',
    wordpress: true,
  },
  {
    name: 'pricing',
    section: 'pricing',
    label: 'Pricing',
    description: 'Plans, packages and price lists.',
    wordpress: false,
  },
  {
    name: 'testimonials',
    section: 'testimonials',
    label: 'Testimonials',
    description: 'Share reviews and feedback about your brand/business.',
    wordpress: true,
  },
  {
    name: 'team',
    section: 'team',
    label: 'Team',
    description: 'A variety of designs to display your team members.',
    wordpress: true,
  },
  {
    name: 'faq',
    section: 'faq',
    label: 'Questions and answers',
    description: 'Frequently asked questions, each opening to its answer.',
    wordpress: false,
  },
  {
    name: 'gallery',
    section: 'gallery',
    label: 'Gallery',
    description: 'Different layouts for displaying images.',
    wordpress: true,
  },
  {
    name: 'contact',
    section: 'contact',
    label: 'Contact',
    description: 'Display your contact information.',
    wordpress: true,
  },
  {
    name: 'opening-hours',
    section: 'opening-hours',
    label: 'Opening hours',
    description: 'When you are open, by day.',
    wordpress: false,
  },
  {
    name: 'call-to-action',
    section: 'call-to-action',
    label: 'Call to action',
    description: 'Sections whose purpose is to trigger a specific action.',
    wordpress: true,
  },
  {
    name: 'header',
    section: 'header',
    label: 'Headers',
    description: 'A variety of header designs displaying your site title and navigation.',
    wordpress: true,
  },
  {
    name: 'footer',
    section: 'footer',
    label: 'Footers',
    description: 'A variety of footer designs displaying information and site navigation.',
    wordpress: true,
  },
];

export const PATTERNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'patterns');

export class PatternFileError extends Error {}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Reads one pattern from its two files. Throws PatternFileError with the file and the problem. */
export function readPattern(dir: string, file: string): LibraryPattern {
  const where = `${path.basename(dir)}/${file}`;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(path.join(dir, `${file}.json`), 'utf8'));
  } catch (error) {
    throw new PatternFileError(`${where}.json: ${(error as Error).message}`);
  }
  const content = readFileSync(path.join(dir, `${file}.html`), 'utf8').trim();
  const fail = (message: string) => new PatternFileError(`${where}.json: ${message}`);
  if (typeof meta.title !== 'string' || !meta.title) throw fail('"title" is missing');
  if (!isStringList(meta.categories) || meta.categories.length === 0) {
    throw fail('"categories" must list at least one category');
  }
  if (!isStringList(meta.keywords)) throw fail('"keywords" must be a list of strings');
  if (typeof meta.viewportWidth !== 'number') throw fail('"viewportWidth" must be a number');
  if (meta.description !== undefined && typeof meta.description !== 'string') {
    throw fail('"description" must be a string');
  }
  const known = new Set(['title', 'description', 'categories', 'keywords', 'viewportWidth', 'slots']);
  for (const key of Object.keys(meta)) if (!known.has(key)) throw fail(`"${key}" is not known`);
  const pattern: LibraryPattern = {
    name: `pressbase/${file}`,
    title: meta.title,
    categories: meta.categories,
    keywords: meta.keywords,
    viewportWidth: meta.viewportWidth,
    content,
  };
  if (meta.description) pattern.description = meta.description;
  if (meta.slots !== undefined) {
    try {
      pattern.slots = parseSlotDeclarations(meta.slots);
    } catch (error) {
      throw fail((error as Error).message);
    }
  }
  return pattern;
}

/** Every pattern in a directory of `.html` + `.json` pairs, sorted by name. */
export function readPatterns(dir: string = PATTERNS_DIR): LibraryPattern[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -5))
    .sort();
  return files.map((file) => readPattern(dir, file));
}

let cached: LibraryPattern[] | undefined;

/**
 * The library, read once (a few dozen small files) and kept: patterns
 * don't change while the server runs.
 */
export function libraryPatterns(): LibraryPattern[] {
  cached ??= readPatterns();
  return cached;
}
