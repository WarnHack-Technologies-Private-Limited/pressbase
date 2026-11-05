import type { ParsedBlock } from '@pressbase/blocks';
import {
  checkOperations,
  EDIT_SET_SCHEMA,
  type EditOperation,
  isPageOperation,
  type PageOperation,
  type PageRef,
  type UpdateBlockAttributes,
} from '@pressbase/site-edits';
import { extractSlots } from '@pressbase/slots';
import { type AbilityContext, AbilityError } from '../abilities/registry';
import { sanitizeSlug } from '../content/sanitize';
import type { Kernel } from '../kernel';
import {
  applyOperations,
  canEditPage,
  pageBySlug,
  pageView,
  templatePartView,
} from './abilities';
import { CHANGESET_UUID_INPUT, changesetFor, entriesOf } from './changeset';
import {
  findPattern,
  pageSections,
  patternIndex,
  renderPattern,
  sectionPattern,
  validateSlotValues,
} from './sections';
import { applyDesign, assertPresetStyles, currentUserStyles, designSystem } from './styles';

/**
 * `core/propose-site-edits` (v0.8, #62): how a model in Studio's AI panel
 * hands over the changes it suggests. It checks a set of edit operations
 * (@pressbase/site-edits) against the site as the person's changeset has
 * it — patterns, slot values, section positions, presets, pages, the
 * person's permissions — and returns them, each page operation naming its
 * page. It changes nothing: Studio applies the set in the editor, where
 * the person keeps or undoes it. See docs/architecture/ai-edits.md.
 */

export const PROPOSE_SITE_EDITS = 'core/propose-site-edits';

interface ProposeInput {
  operations: EditOperation[];
  summary: string;
  page?: PageRef;
  changeset_uuid?: string;
}

const invalid = (message: string) => new AbilityError('ability_invalid_input', message, 400);

const THEME_OPERATIONS = new Set(['setGlobalStyles', 'updateTemplatePart', 'updateMenu']);

/** The person may make every change in the set (as the write abilities would check). */
async function canPropose(
  kernel: Kernel,
  input: ProposeInput | null,
  context: AbilityContext,
): Promise<boolean> {
  if (!(await context.can('edit_pages'))) return false;
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  const types = new Set(operations.map((o) => o?.type));
  if ([...types].some((t) => THEME_OPERATIONS.has(t)) && !(await context.can('edit_theme_options')))
    return false;
  if (types.has('createPage') && !(await context.can('publish_pages'))) return false;
  const refs = new Set<PageRef>();
  for (const operation of operations) {
    if (!operation || !isPageOperation(operation)) continue;
    const ref = operation.page ?? input?.page;
    if (ref !== undefined) refs.add(ref);
  }
  for (const ref of refs) {
    const page = typeof ref === 'number' ? { id: ref } : { slug: String(ref) };
    if (!(await canEditPage(kernel, context, page))) return false;
  }
  return true;
}

/** The block a path of inner-block positions leads to, below a section. */
function blockAt(section: ParsedBlock, path: number[]): ParsedBlock | undefined {
  let block: ParsedBlock | undefined = section;
  for (const index of path) {
    block = block?.innerBlocks.filter((b) => b.blockName !== null)[index];
  }
  return block;
}

const ATTRIBUTE_PRESETS: Record<string, keyof ReturnType<typeof designSystem>> = {
  backgroundColor: 'palette',
  textColor: 'palette',
  borderColor: 'palette',
  gradient: 'gradients',
  fontSize: 'font_sizes',
  fontFamily: 'font_families',
};

export function registerSiteEditsAbility(kernel: Kernel): void {
  kernel.abilities.register(PROPOSE_SITE_EDITS, {
    label: 'Propose changes in Studio',
    description:
      'Hands Studio a set of changes for the person to see on the page and keep or undo: insertSection, replaceSection, moveSection, removeSection, updateSlots, updateBlockAttributes (presets only), setGlobalStyles (a design direction or preset references), updateTemplatePart, createPage and updateMenu. Sections are named by pattern (core/list-patterns) and filled with slot values in plain text; indexes come from core/get-page-structure and count after the operations before them. Page operations without `page` change the page given in `page`. The set is checked against the site and returned; nothing changes until the person keeps it, and nothing is published. Call it once, with every change.',
    category: 'site',
    inputSchema: {
      type: 'object',
      properties: {
        operations: EDIT_SET_SCHEMA,
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
          description: 'What the changes do, in one plain sentence for the person.',
        },
        page: {
          type: ['integer', 'string'],
          description: 'The page that page operations without their own `page` change: the open one.',
        },
        changeset_uuid: CHANGESET_UUID_INPUT,
      },
      required: ['operations', 'summary'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        operations: { type: 'array', items: { type: 'object' } },
        summary: { type: 'string' },
        unused: {
          type: 'array',
          items: { type: 'string' },
          description: 'Content a replaced section has no place for in its new pattern.',
        },
      },
      required: ['operations', 'summary', 'unused'],
    },
    permissionCallback: (input: ProposeInput | null, context) => canPropose(kernel, input, context),
    async executeCallback(input: ProposeInput, context) {
      const checked = checkOperations(input.operations, 'input[operations]');
      const problem = checked.problems[0];
      if (problem) throw invalid(`${problem.path}: ${problem.message}`);
      const patterns = patternIndex(kernel);
      const changeset = await changesetFor(kernel, context.user, input.changeset_uuid, false);
      const data = entriesOf(kernel, changeset);
      const theme = await kernel.themes.active();
      const stylesheet = theme.info.stylesheet;
      const system = designSystem(theme, false);

      /** Pages as the set leaves them so far, by the ref the result names them with. */
      const pages = new Map<PageRef, ParsedBlock[]>();
      /** Pages the set creates, by slug. */
      const created = new Set<string>();
      const unused: string[] = [];
      const out: EditOperation[] = [];

      const pageOf = async (ref: PageRef, path: string) => {
        if (typeof ref === 'string' && created.has(ref)) return ref;
        const view = await pageView(
          kernel,
          data,
          typeof ref === 'number' ? { id: ref } : { slug: ref },
        ).catch(() => {
          throw invalid(`${path}[page]: there’s no page “${ref}”.`);
        });
        const key = view.id ?? view.slug;
        if (!pages.has(key)) pages.set(key, pageSections(view.content, patterns));
        return key;
      };

      for (const [i, operation] of input.operations.entries()) {
        const path = `input[operations][${i}]`;
        if (isPageOperation(operation)) {
          const ref = operation.page ?? input.page;
          if (ref === undefined) {
            throw invalid(`${path}[page]: name the page, or give \`page\` for the open one.`);
          }
          const key = await pageOf(ref, path);
          const sections = pages.get(key) ?? [];
          if (operation.type === 'updateBlockAttributes') {
            checkAttributes(operation, sections, system, path);
          } else {
            const result = applyOperations(sections, [operation], patterns, i);
            pages.set(key, result.sections);
            unused.push(...result.unused);
          }
          out.push({ ...operation, page: key } as PageOperation);
          continue;
        }
        switch (operation.type) {
          case 'setGlobalStyles': {
            if (operation.styles) assertPresetStyles(operation.styles, `${path}[styles]`);
            if (operation.design) {
              const { config } = await currentUserStyles(kernel, stylesheet, data);
              try {
                applyDesign(theme, config, operation.design);
              } catch (error) {
                if (error instanceof AbilityError) {
                  throw invalid(error.message.replace('input[design]', `${path}[design]`));
                }
                throw error;
              }
            }
            break;
          }
          case 'updateTemplatePart': {
            const part = await templatePartView(kernel, data, operation.slug).catch(() => {
              throw invalid(`${path}[slug]: there’s no template part “${operation.slug}”.`);
            });
            if (operation.pattern !== undefined) {
              const pattern = findPattern(patterns, operation.pattern, `${path}[pattern]`);
              renderPattern(pattern, patterns, operation.slots, path);
            } else {
              const blocks = pageSections(part.content, patterns);
              const declarations =
                blocks.length === 1
                  ? sectionPattern(blocks[0] as ParsedBlock, patterns)?.slots
                  : undefined;
              validateSlotValues(
                extractSlots(blocks, { declarations }),
                operation.slots,
                `${path}[slots]`,
              );
            }
            break;
          }
          case 'createPage': {
            const sections = operation.sections.flatMap((section, s) =>
              renderPattern(
                findPattern(patterns, section.pattern, `${path}[sections][${s}][pattern]`),
                patterns,
                section.slots,
                `${path}[sections][${s}]`,
              ),
            );
            const base = sanitizeSlug(operation.slug ?? operation.title) || 'page';
            let slug = base;
            for (
              let n = 2;
              created.has(slug) || data[`page:${slug}`] || (await pageBySlug(kernel, slug));
              n++
            ) {
              slug = `${base}-${n}`;
            }
            created.add(slug);
            pages.set(slug, sections);
            out.push({ ...operation, slug });
            continue;
          }
          case 'updateMenu':
            for (const [n, item] of operation.items.entries()) {
              if (item.page === undefined || created.has(item.page)) continue;
              if (!data[`page:${item.page}`] && !(await pageBySlug(kernel, item.page))) {
                throw invalid(`${path}[items][${n}][page]: there’s no page “${item.page}”.`);
              }
            }
            break;
        }
        out.push(operation);
      }
      return { operations: out, summary: input.summary, unused };
    },
    meta: {
      annotations: { readonly: true, destructive: false, idempotent: true },
      showInRest: true,
    },
  });
}

function checkAttributes(
  operation: UpdateBlockAttributes,
  sections: ParsedBlock[],
  system: ReturnType<typeof designSystem>,
  path: string,
): void {
  const section = sections[operation.index];
  if (!section) {
    throw invalid(
      `${path}[index]: there’s no section ${operation.index}; the page has ${sections.length}.`,
    );
  }
  if (!blockAt(section, operation.block ?? [])) {
    throw invalid(`${path}[block]: the section has no block at ${JSON.stringify(operation.block)}.`);
  }
  for (const [key, list] of Object.entries(ATTRIBUTE_PRESETS)) {
    const value = operation.attributes[key as keyof typeof operation.attributes];
    if (typeof value !== 'string') continue;
    const presets = system[list] as { slug: string }[];
    if (!presets.some((p) => p.slug === value)) {
      throw invalid(
        `${path}[attributes][${key}]: the theme has no preset “${value}”. Use one of ${presets
          .map((p) => p.slug)
          .join(', ')}.`,
      );
    }
  }
}
