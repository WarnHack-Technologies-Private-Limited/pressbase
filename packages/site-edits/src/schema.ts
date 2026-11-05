import { DESIGN_CHOICE_SCHEMA } from '@pressbase/design';

/**
 * The operations as JSON Schema: what `core/update-page-sections` takes
 * (the section operations) and what a model proposes in Studio's AI panel
 * (all of them, through `core/propose-site-edits`). Only keywords core's
 * validator and the providers' tool schemas share.
 */

type Schema = Record<string, unknown>;

/** How many operations one set may hold. */
export const MAX_OPERATIONS = 30;
/** How many links a menu may have. */
export const MAX_MENU_ITEMS = 12;

export const PATTERN_INPUT = {
  type: 'string',
  maxLength: 200,
  description: 'A pattern’s name, from core/list-patterns.',
} as const;

export const SLOTS_INPUT = {
  type: 'object',
  description:
    'Slot values by slot ID, in plain text (see the pattern’s slots in core/list-patterns). Slots left out keep the pattern’s text. Use a placeholder in square brackets, such as [Add your opening hours], for any fact you weren’t given.',
} as const;

export const INDEX_INPUT = {
  type: 'integer',
  minimum: 0,
  description: 'A section’s position, from 0.',
} as const;

const PAGE_INPUT = {
  type: ['integer', 'string'],
  description:
    'The page, by ID or slug (from core/get-page-structure). Leave it out for the page open in Studio.',
} as const;

const op = (type: string, properties: Schema, required: string[]): Schema => ({
  type: 'object',
  properties: { type: { type: 'string', enum: [type] }, ...properties },
  required: ['type', ...required],
  additionalProperties: false,
});

/** The five section operations, without `page` (the ability names its page once). */
function sectionOperations(withPage: boolean): Schema[] {
  const page = withPage ? { page: PAGE_INPUT } : {};
  return [
    op(
      'insertSection',
      {
        ...page,
        pattern: PATTERN_INPUT,
        slots: SLOTS_INPUT,
        index: { ...INDEX_INPUT, description: 'Where to insert it; at the end by default.' },
      },
      ['pattern'],
    ),
    op(
      'replaceSection',
      {
        ...page,
        index: INDEX_INPUT,
        pattern: PATTERN_INPUT,
        slots: SLOTS_INPUT,
        keep_content: {
          type: 'boolean',
          description:
            'Move the section’s text, links and images into the new pattern (Swap layout). True by default.',
        },
      },
      ['index', 'pattern'],
    ),
    op('moveSection', { ...page, index: INDEX_INPUT, to: INDEX_INPUT }, ['index', 'to']),
    op('removeSection', { ...page, index: INDEX_INPUT }, ['index']),
    op('updateSlots', { ...page, index: INDEX_INPUT, slots: SLOTS_INPUT }, ['index', 'slots']),
  ];
}

/** One of `core/update-page-sections`' operations. */
export const SECTION_OPERATION_SCHEMA: Schema = { oneOf: sectionOperations(false) };

const SLUG_ATTRIBUTE = {
  type: ['string', 'null'],
  pattern: '^[a-z0-9-]{1,100}$',
} as const;

export const PRESET_ATTRIBUTES_SCHEMA: Schema = {
  type: 'object',
  description:
    'Preset attributes only: colours, gradients, font sizes and families by preset slug (from core/get-design-system), alignment, and style values that are preset references (var:preset|spacing|50). null removes one.',
  properties: {
    backgroundColor: SLUG_ATTRIBUTE,
    textColor: SLUG_ATTRIBUTE,
    gradient: SLUG_ATTRIBUTE,
    borderColor: SLUG_ATTRIBUTE,
    fontSize: SLUG_ATTRIBUTE,
    fontFamily: SLUG_ATTRIBUTE,
    align: {
      type: ['string', 'null'],
      enum: ['wide', 'full', 'left', 'center', 'right', '', null],
    },
    textAlign: { type: ['string', 'null'], enum: ['left', 'center', 'right', '', null] },
    style: { type: ['object', 'null'] },
  },
  additionalProperties: false,
  minProperties: 1,
};

/** Every operation Studio applies: what a model proposes in the AI panel. */
export const EDIT_OPERATION_SCHEMA: Schema = {
  oneOf: [
    ...sectionOperations(true),
    op(
      'updateBlockAttributes',
      {
        page: PAGE_INPUT,
        index: INDEX_INPUT,
        block: {
          type: 'array',
          items: { type: 'integer', minimum: 0 },
          maxItems: 10,
          description:
            'The block inside the section, by inner-block index at each level; leave it out for the section itself.',
        },
        attributes: PRESET_ATTRIBUTES_SCHEMA,
      },
      ['index', 'attributes'],
    ),
    op(
      'setGlobalStyles',
      {
        design: DESIGN_CHOICE_SCHEMA,
        styles: {
          type: 'object',
          description:
            'theme.json styles to merge in (color, typography, spacing, border, elements such as button and link, blocks), with preset references, sizes and keywords only: never raw colours or CSS. null removes a value.',
        },
      },
      [],
    ),
    op(
      'updateTemplatePart',
      {
        slug: {
          type: 'string',
          pattern: '^[a-z0-9_-]{1,190}$',
          description: 'The part’s slug: header or footer.',
        },
        pattern: {
          ...PATTERN_INPUT,
          description: 'A header or footer pattern to rebuild it from.',
        },
        slots: SLOTS_INPUT,
      },
      ['slug'],
    ),
    op(
      'createPage',
      {
        title: { type: 'string', minLength: 1, maxLength: 100 },
        slug: { type: 'string', pattern: '^[a-z0-9-]{1,60}$' },
        sections: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: { pattern: PATTERN_INPUT, slots: SLOTS_INPUT },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
        status: { type: 'string', enum: ['publish', 'draft'] },
      },
      ['title', 'sections'],
    ),
    op(
      'updateMenu',
      {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_MENU_ITEMS,
          description: 'The header menu’s links, in order. They replace the links it has.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 60 },
              page: {
                type: 'string',
                pattern: '^[a-z0-9-]{1,200}$',
                description: 'A page’s slug.',
              },
              url: {
                type: 'string',
                maxLength: 500,
                description: 'Or an address: a path on this site (/visit/) or an https link.',
              },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      ['items'],
    ),
  ],
};

/** A set of operations, applied in order. */
export const EDIT_SET_SCHEMA: Schema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_OPERATIONS,
  items: EDIT_OPERATION_SCHEMA,
};

export const EDIT_OPERATION_TYPES = [
  'insertSection',
  'replaceSection',
  'moveSection',
  'removeSection',
  'updateSlots',
  'updateBlockAttributes',
  'setGlobalStyles',
  'updateTemplatePart',
  'createPage',
  'updateMenu',
] as const;
