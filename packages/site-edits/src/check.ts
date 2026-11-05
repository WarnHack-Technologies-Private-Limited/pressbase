import { DENSITIES, FONT_PAIR_IDS, MOODS, RADII } from '@pressbase/design';
import { EDIT_OPERATION_TYPES, MAX_MENU_ITEMS, MAX_OPERATIONS } from './schema';
import type { EditOperation, PageOperation } from './types';

/**
 * Checks for an operation set that need nothing but the set: the shapes
 * (as the schema says, with readable messages), presets only in styles and
 * attributes, safe menu links. Core checks the rest against the site
 * (patterns, slots, indexes, permissions); the admin checks again before
 * applying. Pure, so both share it.
 */

export interface EditProblem {
  /** Where: `operations[2].slots`. */
  path: string;
  /** What's wrong, in plain English. */
  message: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Colours, CSS and URLs a model must not write: only preset references, sizes and keywords. */
const RAW_VALUE =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|url|expression)\s*\(|[{};<>]/i;

/**
 * The first value in theme.json styles (or a block's `style`) that isn't a
 * preset reference, a size or a keyword: a raw colour, `url()`, CSS, or a
 * `css` key (Additional CSS is never written by AI in v1). Null when all is well.
 */
export function presetProblem(value: unknown, path = 'styles'): EditProblem | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const problem = presetProblem(item, `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'css') {
        return { path: `${path}.css`, message: 'Custom CSS can’t be written here. Use presets.' };
      }
      const problem = presetProblem(inner, `${path}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === 'string' && RAW_VALUE.test(value)) {
    return {
      path,
      message: `“${value}” isn’t a preset. Use a preset reference such as var:preset|color|accent.`,
    };
  }
  return null;
}

/** A menu link a model may write: a path on the site, or an http(s) address. */
export function isSafeLink(url: string): boolean {
  if (/^\/(?!\/)/.test(url) || url === '#') return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const SLUG = /^[a-z0-9-]{1,100}$/;
const PAGE_SLUG = /^[a-z0-9-]{1,200}$/;
const PART_SLUG = /^[a-z0-9_-]{1,190}$/;
const ATTRIBUTE_SLUGS = [
  'backgroundColor',
  'textColor',
  'gradient',
  'borderColor',
  'fontSize',
  'fontFamily',
] as const;
const ALIGN = ['wide', 'full', 'left', 'center', 'right', ''];
const TEXT_ALIGN = ['left', 'center', 'right', ''];

const DESIGN_ENUMS: Record<string, readonly unknown[]> = {
  mood: MOODS,
  contrast: ['standard', 'high'],
  scheme: ['light', 'dark'],
  fontPair: FONT_PAIR_IDS,
  radius: RADII,
  density: DENSITIES,
};

class Checker {
  readonly problems: EditProblem[] = [];
  constructor(readonly path: string) {}

  fail(at: string, message: string): false {
    this.problems.push({ path: at ? `${this.path}.${at}` : this.path, message });
    return false;
  }

  only(value: Json, allowed: string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.fail(key, `“${key}” isn’t part of this operation.`);
    }
  }

  index(value: Json, key: string, required = true): void {
    const v = value[key];
    if (v === undefined) {
      if (required) this.fail(key, 'A section’s position is needed.');
      return;
    }
    if (!Number.isInteger(v) || (v as number) < 0) {
      this.fail(key, 'A section’s position is a whole number from 0.');
    }
  }

  text(value: Json, key: string, max: number, required = true, pattern?: RegExp): void {
    const v = value[key];
    if (v === undefined) {
      if (required) this.fail(key, 'This is needed.');
      return;
    }
    if (typeof v !== 'string' || v.trim() === '') this.fail(key, 'This must be some text.');
    else if (v.length > max) this.fail(key, `This is longer than ${max} characters.`);
    else if (pattern && !pattern.test(v)) this.fail(key, `“${v}” isn’t a valid name here.`);
  }

  page(value: Json): void {
    const v = value.page;
    if (v === undefined) return;
    if (typeof v === 'number' ? !Number.isInteger(v) || v < 1 : !PAGE_SLUG.test(String(v))) {
      this.fail('page', 'Name the page by its ID or slug.');
    }
  }

  slots(value: Json, key: string, required: boolean): void {
    const v = value[key];
    if (v === undefined) {
      if (required) this.fail(key, 'Give the slot values to change.');
      return;
    }
    if (!isObject(v)) this.fail(key, 'Slot values are an object, by slot ID.');
  }

  presets(value: unknown, at: string): void {
    const problem = presetProblem(value, at);
    if (problem)
      this.problems.push({ path: `${this.path}.${problem.path}`, message: problem.message });
  }
}

function checkAttributes(c: Checker, attributes: unknown): void {
  if (!isObject(attributes) || !Object.keys(attributes).length) {
    c.fail('attributes', 'Give at least one attribute to change.');
    return;
  }
  for (const [key, value] of Object.entries(attributes)) {
    const at = `attributes.${key}`;
    if ((ATTRIBUTE_SLUGS as readonly string[]).includes(key)) {
      if (value !== null && (typeof value !== 'string' || !SLUG.test(value))) {
        c.fail(at, 'Use a preset’s slug, such as accent.');
      }
    } else if (key === 'align' || key === 'textAlign') {
      const allowed = key === 'align' ? ALIGN : TEXT_ALIGN;
      if (value !== null && !allowed.includes(value as string)) {
        c.fail(at, `Use one of ${allowed.filter(Boolean).join(', ')}.`);
      }
    } else if (key === 'style') {
      if (value !== null && !isObject(value)) c.fail(at, 'Styles are an object.');
      else c.presets(value, at);
    } else {
      c.fail(at, `“${key}” can’t be changed here: only colours, sizes, fonts and alignment.`);
    }
  }
}

function checkDesign(c: Checker, design: unknown): void {
  if (!isObject(design)) {
    c.fail('design', 'A design direction is an object.');
    return;
  }
  for (const [key, allowed] of Object.entries(DESIGN_ENUMS)) {
    if (!allowed.includes(design[key])) {
      c.fail(`design.${key}`, `Use one of ${allowed.join(', ')}.`);
    }
  }
  const hue = design.hue;
  if (!Number.isInteger(hue) || (hue as number) < 0 || (hue as number) > 359) {
    c.fail('design.hue', 'The hue is a whole number from 0 to 359.');
  }
  c.only(design, ['hue', ...Object.keys(DESIGN_ENUMS)]);
}

function checkOne(value: unknown, path: string): EditProblem[] {
  const c = new Checker(path);
  if (!isObject(value)) return [{ path, message: 'An operation is an object with a type.' }];
  const type = value.type;
  if (typeof type !== 'string' || !(EDIT_OPERATION_TYPES as readonly string[]).includes(type)) {
    c.fail('type', `“${String(type)}” isn’t an operation Studio knows.`);
    return c.problems;
  }
  switch (type) {
    case 'insertSection':
      c.only(value, ['type', 'page', 'pattern', 'slots', 'index']);
      c.page(value);
      c.text(value, 'pattern', 200);
      c.slots(value, 'slots', false);
      c.index(value, 'index', false);
      break;
    case 'replaceSection':
      c.only(value, ['type', 'page', 'index', 'pattern', 'slots', 'keep_content']);
      c.page(value);
      c.index(value, 'index');
      c.text(value, 'pattern', 200);
      c.slots(value, 'slots', false);
      if (value.keep_content !== undefined && typeof value.keep_content !== 'boolean') {
        c.fail('keep_content', 'This is true or false.');
      }
      break;
    case 'moveSection':
      c.only(value, ['type', 'page', 'index', 'to']);
      c.page(value);
      c.index(value, 'index');
      c.index(value, 'to');
      break;
    case 'removeSection':
      c.only(value, ['type', 'page', 'index']);
      c.page(value);
      c.index(value, 'index');
      break;
    case 'updateSlots':
      c.only(value, ['type', 'page', 'index', 'slots']);
      c.page(value);
      c.index(value, 'index');
      c.slots(value, 'slots', true);
      break;
    case 'updateBlockAttributes': {
      c.only(value, ['type', 'page', 'index', 'block', 'attributes']);
      c.page(value);
      c.index(value, 'index');
      const block = value.block;
      if (
        block !== undefined &&
        (!Array.isArray(block) ||
          block.length > 10 ||
          !block.every((i) => Number.isInteger(i) && (i as number) >= 0))
      ) {
        c.fail('block', 'The block is a list of positions, from 0.');
      }
      checkAttributes(c, value.attributes);
      break;
    }
    case 'setGlobalStyles':
      c.only(value, ['type', 'design', 'styles']);
      if (value.design === undefined && value.styles === undefined) {
        c.fail('', 'Give a design direction, styles or both.');
      }
      if (value.design !== undefined) checkDesign(c, value.design);
      if (value.styles !== undefined) {
        if (!isObject(value.styles)) c.fail('styles', 'Styles are an object, as in theme.json.');
        else c.presets(value.styles, 'styles');
      }
      break;
    case 'updateTemplatePart':
      c.only(value, ['type', 'slug', 'pattern', 'slots']);
      c.text(value, 'slug', 190, true, PART_SLUG);
      c.text(value, 'pattern', 200, false);
      c.slots(value, 'slots', false);
      if (value.pattern === undefined && value.slots === undefined) {
        c.fail('', 'Give a pattern, slots or both.');
      }
      break;
    case 'createPage': {
      c.only(value, ['type', 'title', 'slug', 'sections', 'status']);
      c.text(value, 'title', 100);
      c.text(value, 'slug', 60, false, PAGE_SLUG);
      if (value.status !== undefined && value.status !== 'publish' && value.status !== 'draft') {
        c.fail('status', 'Use publish or draft.');
      }
      const sections = value.sections;
      if (!Array.isArray(sections) || sections.length < 1 || sections.length > 10) {
        c.fail('sections', 'A new page has one to ten sections.');
        break;
      }
      sections.forEach((section, i) => {
        if (!isObject(section)) {
          c.fail(`sections[${i}]`, 'A section names a pattern.');
          return;
        }
        const inner = new Checker(`${path}.sections[${i}]`);
        inner.only(section, ['pattern', 'slots']);
        inner.text(section, 'pattern', 200);
        inner.slots(section, 'slots', false);
        c.problems.push(...inner.problems);
      });
      break;
    }
    case 'updateMenu': {
      c.only(value, ['type', 'items']);
      const items = value.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MENU_ITEMS) {
        c.fail('items', `A menu has one to ${MAX_MENU_ITEMS} links.`);
        break;
      }
      items.forEach((item, i) => {
        const inner = new Checker(`${path}.items[${i}]`);
        if (!isObject(item)) {
          inner.fail('', 'A link has a label and a page or an address.');
        } else {
          inner.only(item, ['label', 'page', 'url']);
          inner.text(item, 'label', 60);
          inner.text(item, 'page', 200, false, PAGE_SLUG);
          if (item.url !== undefined) {
            if (typeof item.url !== 'string' || !isSafeLink(item.url)) {
              inner.fail('url', 'Use a path on this site (/visit/) or an http(s) address.');
            }
          }
          if ((item.page === undefined) === (item.url === undefined)) {
            inner.fail('', 'A link goes to a page or an address: give one of them.');
          }
        }
        c.problems.push(...inner.problems);
      });
      break;
    }
  }
  return c.problems;
}

/**
 * Checks a set of operations: every problem with its path, or none. The
 * set is applied whole or not at all, so one problem stops it.
 */
export function checkOperations(
  value: unknown,
  path = 'operations',
): { operations: EditOperation[]; problems: EditProblem[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { operations: [], problems: [{ path, message: 'There are no changes to make.' }] };
  }
  if (value.length > MAX_OPERATIONS) {
    return {
      operations: [],
      problems: [{ path, message: `At most ${MAX_OPERATIONS} changes can be made at once.` }],
    };
  }
  const problems = value.flatMap((item, i) => checkOne(item, `${path}[${i}]`));
  return { operations: problems.length ? [] : (value as EditOperation[]), problems };
}

/** The operations that change a page's sections, which name a page (or mean the open one). */
export function isPageOperation(operation: EditOperation): operation is PageOperation {
  return (
    operation.type === 'insertSection' ||
    operation.type === 'replaceSection' ||
    operation.type === 'moveSection' ||
    operation.type === 'removeSection' ||
    operation.type === 'updateSlots' ||
    operation.type === 'updateBlockAttributes'
  );
}
